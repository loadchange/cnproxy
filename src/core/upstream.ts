/**
 * Outbound request execution. Sends a flow's (possibly rewritten) request to the origin
 * server — directly or through an upstream proxy — and returns the Node response stream
 * so the caller can both relay it to the client and tee a bounded copy into the flow.
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { IncomingMessage } from "node:http";
import type { CnRequest } from "../flow/flow.ts";

export interface UpstreamConfig {
  upstream: string | null;
  timeout: number;
}

/** Per-stage timing offsets (ms from request start). Populated when a collector is passed. */
export interface Timings {
  dns?: number;
  connect?: number;
  tls?: number;
  ttfb?: number;
}

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

function sendDirect(req: CnRequest, cfg: UpstreamConfig, timings?: Timings): Promise<IncomingMessage> {
  const isHttps = req.scheme === "https";
  const mod = isHttps ? https : http;
  const options: https.RequestOptions = {
    host: req.host,
    port: req.port,
    method: req.method,
    path: req.path,
    headers: buildHeaders(req),
    timeout: cfg.timeout,
    // We are the MITM; we present the origin's real cert chain to ourselves. Accept it.
    rejectUnauthorized: false,
    servername: isHttps && net.isIP(req.host) === 0 ? req.host : undefined,
  };
  return dispatch(mod, options, req, timings);
}

function dispatch(
  mod: typeof http | typeof https,
  options: https.RequestOptions,
  req: CnRequest,
  timings?: Timings,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
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
    });
    conn.on("connect", (_res, socket) => {
      const tlsSock = tls.connect(
        {
          socket,
          servername: net.isIP(req.host) === 0 ? req.host : undefined,
          rejectUnauthorized: false,
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
