/**
 * HTTP/2 request handler. After the MITM TLS terminator negotiates ALPN `h2`, the decrypted
 * socket is fed to a cleartext `http2.createServer()` whose `stream` events land here. Each h2
 * stream is mapped to the same Flow pipeline used for HTTP/1 (hooks → rules → intercept →
 * mock/block/upstream → response), then answered on the stream.
 *
 * Upstream is sent over HTTP/1.1 for now (origin h2 is a future optimization); the client still
 * gets a correct h2 conversation, which is what browsers negotiate.
 */
import http2 from "node:http2";
import type { ServerHttp2Stream, IncomingHttpHeaders } from "node:http2";
import { Flow, CnResponse, FlowError, type ClientInfo } from "../flow/flow.ts";
import { Headers } from "../flow/headers.ts";
import { collectBody, boundForStorage } from "./stream-util.ts";
import { sendUpstream } from "./upstream.ts";
import { decodeBody, isDecodable } from "./encoding.ts";
import type { ProxyContext } from "./context.ts";
import { log } from "../logger.ts";

const { NGHTTP2_CANCEL, NGHTTP2_REFUSED_STREAM } = http2.constants;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Headers that are illegal in HTTP/2 (connection-specific) and must never be re-emitted.
const FORBIDDEN_H2 = new Set([
  "connection",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-connection",
  "host", // h2 uses :authority
]);

export async function handleH2Stream(
  ctx: ProxyContext,
  stream: ServerHttp2Stream,
  headers: IncomingHttpHeaders,
  mitmTarget?: { host: string; port: number },
): Promise<void> {
  const now = ctx.now();
  stream.on("error", (e) => log.debug("h2 stream error:", e.message));

  const socket = stream.session?.socket;
  const client: ClientInfo = {
    address: socket?.remoteAddress ?? "",
    port: socket?.remotePort ?? 0,
    tls: true,
  };
  const flow = new Flow(client, now);
  flow.request.scheme = "https";
  flow.request.httpVersion = "2.0";

  const authority = String(headers[":authority"] ?? "");
  const fromAuthority = parseAuthority(authority);
  // Connect to where the client tunneled (the CONNECT target), honoring its own resolution —
  // this avoids re-resolving the :authority name (and its IPv4/IPv6 ambiguity). The :authority
  // still drives display and the upstream Host header.
  flow.request.host = mitmTarget?.host || fromAuthority?.host || "";
  flow.request.port = mitmTarget?.port || fromAuthority?.port || 443;
  flow.request.method = String(headers[":method"] ?? "GET");
  flow.request.path = String(headers[":path"] ?? "/");

  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(":")) continue; // pseudo-headers
    if (Array.isArray(v)) for (const item of v) h.add(k, item);
    else if (v != null) h.add(k, String(v));
  }
  // Origin (h1) needs a Host header derived from the h2 :authority.
  if (!h.has("host")) h.set("host", authority || flow.request.host);
  flow.request.headers = h;
  flow.request.timestampStart = now;
  ctx.store.add(flow);

  const max = ctx.options.get("maxBodySize");
  try {
    await ctx.addons.trigger("requestheaders", flow);
    flow.request.body = await collectBody(stream);
    flow.request.timestampEnd = ctx.now();

    await ctx.addons.trigger("request", flow);
    const directive = ctx.rules.applyRequest(flow);

    if (ctx.interceptMatch()(flow)) {
      ctx.store.update(flow, "intercept");
      const action = await flow.intercept();
      ctx.store.update(flow);
      if (action === "kill") {
        stream.close(NGHTTP2_CANCEL);
        return;
      }
    }

    if (directive.delayMs) await sleep(directive.delayMs);

    if (directive.block) {
      stream.close(NGHTTP2_REFUSED_STREAM);
      ctx.store.update(flow);
      return;
    }

    if (directive.mock) {
      const res = mockResponse(directive.mock, ctx);
      flow.response = res;
      await ctx.addons.trigger("responseheaders", flow);
      ctx.rules.applyResponse(flow);
      await ctx.addons.trigger("response", flow);
      respond(stream, res, res.body ?? Buffer.alloc(0), true);
      boundStored(flow, max);
      ctx.store.update(flow);
      return;
    }

    const upstreamRes = await sendUpstream(flow.request, {
      upstream: ctx.options.get("upstream"),
      timeout: ctx.options.get("timeout"),
    });

    const res = new CnResponse();
    res.statusCode = upstreamRes.statusCode ?? 0;
    res.reason = upstreamRes.statusMessage ?? "";
    res.httpVersion = "2.0";
    res.headers = Headers.fromRaw(upstreamRes.rawHeaders);
    res.timestampStart = ctx.now();
    flow.response = res;

    await ctx.addons.trigger("responseheaders", flow);

    const rawBody = await collectBody(upstreamRes);
    res.timestampEnd = ctx.now();
    const encoding = res.headers.get("content-encoding") ?? "";
    const decoded = isDecodable(encoding) ? decodeBody(rawBody, encoding) : rawBody;
    res.body = decoded;

    ctx.rules.applyResponse(flow);
    await ctx.addons.trigger("response", flow);

    // Modified (decoded) bodies are sent decoded with the encoding stripped; untouched bodies are
    // sent verbatim with the original encoding header intact.
    const modified = !!res.body && !decoded.equals(res.body);
    respond(stream, res, modified ? res.body! : rawBody, modified);
    boundStored(flow, max);
    ctx.store.update(flow);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    flow.error = new FlowError(message, ctx.now());
    await ctx.addons.trigger("error", flow);
    log.debug("h2 request error", flow.request.url, message);
    if (!stream.headersSent) {
      try {
        stream.respond({ ":status": 502, "content-type": "text/plain" });
        stream.end(`cnproxy upstream error: ${message}`);
      } catch {
        stream.close(NGHTTP2_CANCEL);
      }
    } else {
      stream.close(NGHTTP2_CANCEL);
    }
    ctx.store.update(flow);
  }
}

function mockResponse(mock: { status: number; headers: Headers; body: Buffer }, ctx: ProxyContext): CnResponse {
  const res = new CnResponse();
  res.statusCode = mock.status;
  res.headers = mock.headers.clone();
  res.body = mock.body;
  res.httpVersion = "2.0";
  res.timestampStart = res.timestampEnd = ctx.now();
  return res;
}

/** Write an h2 response from the flow's response model, stripping illegal h2 headers. */
function respond(stream: ServerHttp2Stream, model: CnResponse, body: Buffer, stripEncoding: boolean): void {
  if (stream.closed || stream.destroyed) return;
  const out: Record<string, string | string[]> = { ":status": String(model.statusCode || 200) };
  const grouped = new Map<string, string[]>();
  for (const [k, v] of model.headers.entries()) {
    const lower = k.toLowerCase();
    if (FORBIDDEN_H2.has(lower)) continue;
    if (lower === "content-length") continue; // recomputed below
    if (stripEncoding && lower === "content-encoding") continue;
    const arr = grouped.get(lower) ?? [];
    arr.push(v);
    grouped.set(lower, arr);
  }
  for (const [k, arr] of grouped) out[k] = arr.length === 1 ? arr[0]! : arr;
  out["content-length"] = String(body.length);
  stream.respond(out);
  stream.end(body);
}

function boundStored(flow: Flow, max: number): void {
  if (flow.request.body) {
    const b = boundForStorage(flow.request.body, max);
    flow.request.body = b.body;
    flow.request.bodyTruncated = b.truncated;
  }
  if (flow.response?.body) {
    const b = boundForStorage(flow.response.body, max);
    flow.response.body = b.body;
    flow.response.bodyTruncated = b.truncated;
  }
}

function parseAuthority(authority: string): { host: string; port: number } | null {
  if (!authority) return null;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    const host = authority.slice(1, end);
    const portPart = authority.slice(end + 2);
    return { host, port: portPart ? parseInt(portPart, 10) : 443 };
  }
  const idx = authority.lastIndexOf(":");
  if (idx !== -1) return { host: authority.slice(0, idx), port: parseInt(authority.slice(idx + 1), 10) || 443 };
  return { host: authority, port: 443 };
}
