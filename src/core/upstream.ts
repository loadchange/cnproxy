import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import http2 from "node:http2";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { CnRequest } from "../flow/flow.ts";

export interface UpstreamConfig {
  upstream: string | null;
  timeout: number;
  /** When false (default), upstream TLS certificate errors are ignored. */
  rejectUnauthorized?: boolean;
}

/** Per-stage timing offsets (ms from request start). Populated when a collector is passed. */
export interface Timings {
  dns?: number;
  connect?: number;
  tls?: number;
  ttfb?: number;
}

// Keep-alive agents for H1 connection reuse
const httpAgent = new http.Agent({ keepAlive: true });
let httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

export function setRejectUnauthorized(reject: boolean): void {
  httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: reject });
}

// Cache of host:port -> ALPN protocol determined ('h1' or 'h2')
const originAlpnCache = new Map<string, "h1" | "h2">();

// Pool of active HTTP/2 client sessions
const h2SessionPool = new Map<string, http2.ClientHttp2Session>();

// Forbidden headers that cannot be sent to an HTTP/2 upstream
const FORBIDDEN_H2_UPSTREAM = new Set([
  "connection",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-connection",
  "host",
]);

export function sendUpstream(req: CnRequest, cfg: UpstreamConfig, timings?: Timings): Promise<IncomingMessage> {
  if (cfg.upstream) return sendViaProxy(req, cfg);
  return sendDirect(req, cfg, timings);
}

function buildHeaders(req: CnRequest): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of req.headers.entries()) {
    const lower = k.toLowerCase();
    // Drop hop-by-hop / proxy artifacts; let the agent set connection + length.
    if (lower === "proxy-connection" || lower === "connection") continue;
    if (Array.isArray(headers[k])) (headers[k] as string[]).push(v);
    else if (headers[k] !== undefined) headers[k] = [headers[k] as string, v];
    else headers[k] = v;
  }
  return headers;
}

function setupSessionEvents(session: http2.ClientHttp2Session, authority: string) {
  session.on("error", () => h2SessionPool.delete(authority));
  session.on("close", () => h2SessionPool.delete(authority));
  session.on("goaway", () => h2SessionPool.delete(authority));
}

function getH2Session(authority: string, servername?: string, rejectUnauthorized = false): Promise<http2.ClientHttp2Session> {
  const cached = h2SessionPool.get(authority);
  if (cached && !cached.closed && !cached.destroyed) {
    return Promise.resolve(cached);
  }

  return new Promise((resolve, reject) => {
    const url = new URL(authority);
    const host = url.hostname;
    const port = url.port ? parseInt(url.port, 10) : 443;

    const socket = tls.connect({
      host,
      port,
      servername,
      ALPNProtocols: ["h2"],
      rejectUnauthorized,
    });

    socket.on("error", reject);
    socket.on("secureConnect", () => {
      const session = http2.connect(authority, {
        createConnection: () => socket,
      });

      let resolved = false;
      session.on("connect", () => {
        if (!resolved) {
          resolved = true;
          h2SessionPool.set(authority, session);
          resolve(session);
        }
      });
      session.on("error", (err) => {
        h2SessionPool.delete(authority);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
      setupSessionEvents(session, authority);
    });
  });
}

function dispatchH2(
  session: http2.ClientHttp2Session,
  req: CnRequest,
  timings?: Timings,
  startTime?: number,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const start = startTime ?? Date.now();
    const h2Headers: Record<string, string | string[]> = {
      ":method": req.method,
      ":path": req.path,
      ":scheme": req.scheme,
      ":authority": req.host + (req.port === 443 ? "" : `:${req.port}`),
    };
    for (const [k, v] of req.headers.entries()) {
      const lower = k.toLowerCase();
      if (FORBIDDEN_H2_UPSTREAM.has(lower)) continue;
      if (Array.isArray(h2Headers[lower])) {
        (h2Headers[lower] as string[]).push(v);
      } else if (h2Headers[lower] !== undefined) {
        h2Headers[lower] = [h2Headers[lower] as string, v];
      } else {
        h2Headers[lower] = v;
      }
    }

    const h2stream = session.request(h2Headers);

    h2stream.on("response", (headers) => {
      if (timings) timings.ttfb = Date.now() - start;
      const rawHeaders: string[] = [];
      for (const [key, val] of Object.entries(headers)) {
        if (Array.isArray(val)) {
          for (const v of val) {
            rawHeaders.push(key, v);
          }
        } else if (val !== undefined) {
          rawHeaders.push(key, val);
        }
      }
      const statusCode = headers[":status"] ? parseInt(String(headers[":status"]), 10) : 200;
      const wrapper = new PassThrough();
      (wrapper as any).statusCode = statusCode;
      (wrapper as any).statusMessage = "";
      (wrapper as any).httpVersion = "2.0";
      (wrapper as any).rawHeaders = rawHeaders;

      h2stream.pipe(wrapper);
      h2stream.on("error", (err) => wrapper.emit("error", err));
      resolve(wrapper as any);
    });

    h2stream.on("error", reject);

    if (req.body && req.body.length) {
      h2stream.write(req.body);
    }
    h2stream.end();
  });
}

function negotiateAndSend(
  req: CnRequest,
  cfg: UpstreamConfig,
  timings?: Timings,
): Promise<IncomingMessage> {
  const start = Date.now();
  const servername = net.isIP(req.host) === 0 ? req.host : undefined;

  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: req.host,
      port: req.port,
      servername,
      ALPNProtocols: ["h2", "http/1.1"],
      rejectUnauthorized: cfg?.rejectUnauthorized ?? false,
    });

    if (timings) {
      socket.on("lookup", () => { if (timings) timings.dns = Date.now() - start; });
      socket.on("connect", () => { if (timings) timings.connect = Date.now() - start; });
      socket.on("secureConnect", () => { if (timings) timings.tls = Date.now() - start; });
    }

    socket.on("error", reject);
    socket.on("secureConnect", () => {
      const alpn = socket.alpnProtocol;
      const key = `${req.host}:${req.port}`;

      if (alpn === "h2") {
        originAlpnCache.set(key, "h2");
        const session = http2.connect(`https://${key}`, {
          createConnection: () => socket,
        });

        setupSessionEvents(session, `https://${key}`);

        dispatchH2(session, req, timings, start)
          .then(resolve)
          .catch(reject);
      } else {
        originAlpnCache.set(key, "h1");
        const options: https.RequestOptions = {
          host: req.host,
          port: req.port,
          method: req.method,
          path: req.path,
          headers: buildHeaders(req),
          timeout: cfg.timeout,
          createConnection: () => socket,
          rejectUnauthorized: cfg?.rejectUnauthorized ?? false,
          servername,
        };
        dispatch(https, options, req, timings, start)
          .then(resolve)
          .catch(reject);
      }
    });
  });
}

function sendDirect(req: CnRequest, cfg: UpstreamConfig, timings?: Timings): Promise<IncomingMessage> {
  const isHttps = req.scheme === "https";
  if (!isHttps) {
    const options: http.RequestOptions = {
      host: req.host,
      port: req.port,
      method: req.method,
      path: req.path,
      headers: buildHeaders(req),
      timeout: cfg.timeout,
      agent: httpAgent,
    };
    return dispatch(http, options, req, timings);
  }

  const key = `${req.host}:${req.port}`;
  const alpn = originAlpnCache.get(key);

  if (alpn === "h2") {
    return getH2Session(`https://${key}`, net.isIP(req.host) === 0 ? req.host : undefined, cfg.rejectUnauthorized ?? false)
      .then((session) => dispatchH2(session, req, timings))
      .catch(() => {
        originAlpnCache.delete(key);
        return negotiateAndSend(req, cfg, timings);
      });
  }

  if (alpn === "h1") {
    const options: https.RequestOptions = {
      host: req.host,
      port: req.port,
      method: req.method,
      path: req.path,
      headers: buildHeaders(req),
      timeout: cfg.timeout,
      rejectUnauthorized: cfg.rejectUnauthorized ?? false,
      servername: net.isIP(req.host) === 0 ? req.host : undefined,
      agent: httpsAgent,
    };
    // A pooled keep-alive socket can be stale (origin closed it, or the ephemeral port was
    // reused by a different host); the reused socket then hangs up before any response. Mirror
    // the h2 path: drop the ALPN cache entry and retry once over a fresh negotiated connection.
    return dispatch(https, options, req, timings).catch(() => {
      originAlpnCache.delete(key);
      return negotiateAndSend(req, cfg, timings);
    });
  }

  return negotiateAndSend(req, cfg, timings);
}

function dispatch(
  mod: typeof http | typeof https,
  options: https.RequestOptions,
  req: CnRequest,
  timings?: Timings,
  startTime?: number,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const start = startTime ?? Date.now();
    const outReq = mod.request(options, (res) => {
      if (timings) timings.ttfb = Date.now() - start;
      resolve(res);
    });
    if (timings) {
      outReq.on("socket", (socket) => {
        socket.on("lookup", () => (timings.dns = Date.now() - start));
        socket.on("connect", () => (timings.connect = Date.now() - start));
        socket.on("secureConnect", () => (timings.tls = Date.now() - start));
      });
    }
    outReq.on("error", reject);
    outReq.on("timeout", () => outReq.destroy(new Error("upstream timeout")));
    if (req.body && req.body.length) outReq.write(req.body);
    outReq.end();
  });
}

/** Route through an upstream HTTP proxy. http: absolute-URI request; https: CONNECT then TLS. */
function sendViaProxy(req: CnRequest, cfg: UpstreamConfig): Promise<IncomingMessage> {
  const proxy = new URL(cfg.upstream!);
  const proxyHost = proxy.hostname;
  const proxyPort = proxy.port ? parseInt(proxy.port, 10) : 80;

  if (req.scheme === "http") {
    const options: http.RequestOptions = {
      host: proxyHost,
      port: proxyPort,
      method: req.method,
      path: req.url, // absolute URI for proxy
      headers: buildHeaders(req),
      timeout: cfg.timeout,
      agent: httpAgent,
    };
    return dispatch(http, options, req);
  }

  // https via CONNECT tunnel through the proxy
  return new Promise((resolve, reject) => {
    const conn = http.request({
      host: proxyHost,
      port: proxyPort,
      method: "CONNECT",
      path: `${req.host}:${req.port}`,
      timeout: cfg.timeout,
      agent: httpAgent,
    });
    conn.on("connect", (_res, socket) => {
      const tlsSock = tls.connect(
        {
          socket,
          servername: net.isIP(req.host) === 0 ? req.host : undefined,
          rejectUnauthorized: cfg.rejectUnauthorized ?? false,
        },
        () => {
          const outReq = https.request(
            {
              method: req.method,
              path: req.path,
              headers: buildHeaders(req),
              createConnection: () => tlsSock,
              timeout: cfg.timeout,
            },
            resolve,
          );
          outReq.on("error", reject);
          if (req.body && req.body.length) outReq.write(req.body);
          outReq.end();
        },
      );
      tlsSock.on("error", reject);
    });
    conn.on("error", reject);
    conn.end();
  });
}
