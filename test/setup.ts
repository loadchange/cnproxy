/**
 * Vitest global setup: polyfill Bun's non-standard `fetch(url, { proxy })` option.
 *
 * Bun's fetch accepts a `proxy` URL. Node's undici-based fetch has no such option, so we shim it:
 *   - http://  origins → forward-proxy the request ourselves via node:http (absolute-URI request
 *                        line), exactly the way cnproxy expects. We also auto-decompress the
 *                        response per content-encoding, matching real fetch semantics.
 *   - https:// origins → tunnel through the proxy via a hand-rolled HTTP CONNECT + TLS upgrade
 *                        (node:http + node:tls), with TLS verification disabled (tests use
 *                        self-signed / MITM certs). Implemented with built-ins so the test
 *                        harness has no third-party dependency that can break across Node versions.
 *
 * This keeps every existing `fetch(origin, { proxy: PROXY })` test call site working unchanged.
 */
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { resetUpstreamPool } from "../src/core/upstream.ts";

// The upstream module keeps process-global connection state (ALPN cache, H2 sessions, keep-alive
// agents). Test files run in one process and reuse ephemeral ports, so a later file can inherit a
// stale entry pointing at a since-closed origin and hang up. Reset between tests for isolation.
afterEach(() => resetUpstreamPool());

// Isolate every test run from the developer's real ~/.cnproxy: a fresh temp dataDir
// means no auto-load of a previous session's flows (which would pollute store.find())
// and no auto-save writing back to the shared global directory.
if (!process.env.CNPROXY_DATA_DIR) {
  process.env.CNPROXY_DATA_DIR = mkdtempSync(join(tmpdir(), "cnproxy-test-"));
}

const realFetch = globalThis.fetch;

function toBodyBuffer(body: unknown): Buffer | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(String(body));
}

function decompress(buf: Buffer, encoding?: string): Buffer {
  if (!buf.length || !encoding) return buf;
  try {
    switch (encoding.trim().toLowerCase()) {
      case "gzip":
      case "x-gzip":
        return zlib.gunzipSync(buf);
      case "br":
        return zlib.brotliDecompressSync(buf);
      case "deflate":
        try {
          return zlib.inflateSync(buf);
        } catch {
          return zlib.inflateRawSync(buf);
        }
      default:
        return buf;
    }
  } catch {
    return buf;
  }
}

function buildHeaders(targetUrl: string, init: RequestInit): { headers: Record<string, string>; body?: Buffer } {
  const headers: Record<string, string> = {};
  if (init.headers) {
    new Headers(init.headers as HeadersInit).forEach((v, k) => {
      headers[k] = v;
    });
  }
  headers["host"] = new URL(targetUrl).host;
  const body = toBodyBuffer(init.body);
  if (body) headers["content-length"] = String(body.length);
  return { headers, body };
}

/** Collect an http.IncomingMessage and turn it into a fetch Response (auto-decompressed). */
function responseFrom(res: http.IncomingMessage, resolve: (r: Response) => void): void {
  const chunks: Buffer[] = [];
  res.on("data", (c) => chunks.push(c as Buffer));
  res.on("end", () => {
    const raw = Buffer.concat(chunks);
    const enc = res.headers["content-encoding"];
    const buf = decompress(raw, Array.isArray(enc) ? enc[0] : enc);

    const respHeaders = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      const lk = k.toLowerCase();
      // We've already decoded the body — drop encoding/length so the Response body
      // isn't misinterpreted as still-compressed.
      if (lk === "content-encoding" || lk === "content-length") continue;
      if (Array.isArray(v)) for (const vv of v) respHeaders.append(k, vv);
      else if (v != null) respHeaders.set(k, String(v));
    }

    const status = res.statusCode ?? 200;
    const noBody = status === 204 || status === 304 || buf.length === 0;
    resolve(
      new Response(noBody ? null : buf, {
        status,
        statusText: res.statusMessage ?? "",
        headers: respHeaders,
      }),
    );
  });
}

/** http:// target → forward-proxy with an absolute-form request line. */
function forwardProxyFetch(targetUrl: string, proxyUrl: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const { headers, body } = buildHeaders(targetUrl, init);
    const req = http.request(
      {
        host: p.hostname,
        port: p.port || 80,
        method: (init.method ?? "GET").toUpperCase(),
        path: targetUrl, // absolute-form request target → forward proxy
        headers,
      },
      (res) => responseFrom(res, resolve),
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** https:// target → HTTP CONNECT tunnel through the proxy, then a TLS request over it. */
function connectProxyFetch(targetUrl: string, proxyUrl: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const p = new URL(proxyUrl);
    const port = u.port || "443";
    const { headers, body } = buildHeaders(targetUrl, init);

    const conn = http.request({
      host: p.hostname,
      port: p.port || 80,
      method: "CONNECT",
      path: `${u.hostname}:${port}`,
      agent: false, // don't pool the CONNECT socket
    });
    conn.on("connect", (_res, socket) => {
      const tlsSock = tls.connect(
        // SNI must be a hostname, never an IP literal.
        { socket, servername: net.isIP(u.hostname) === 0 ? u.hostname : undefined, rejectUnauthorized: false },
        () => {
          // The tlsSock already encrypts, so issue a plain HTTP/1.1 request over it.
          const req = http.request(
            {
              method: (init.method ?? "GET").toUpperCase(),
              path: u.pathname + u.search,
              headers,
              createConnection: () => tlsSock,
            },
            (res) => responseFrom(res, resolve),
          );
          req.on("error", reject);
          if (body) req.write(body);
          req.end();
        },
      );
      tlsSock.on("error", reject);
    });
    conn.on("error", reject);
    conn.end();
  });
}

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit & { proxy?: string }) => {
  if (init && init.proxy) {
    const { proxy, ...rest } = init;
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (urlStr.startsWith("http://")) {
      return forwardProxyFetch(urlStr, proxy, rest);
    }
    // https:// (and anything else) → CONNECT tunnel through the proxy.
    return connectProxyFetch(urlStr, proxy, rest);
  }
  return realFetch(input, init);
}) as typeof fetch;
