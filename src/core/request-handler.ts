/**
 * Unified HTTP request handler for both plain-HTTP proxy requests (absolute-URI) and
 * decrypted HTTPS requests coming off the internal MITM TLS server.
 *
 * Pipeline:
 *   build flow → collect body → requestheaders → request → rules(request) →
 *   [intercept pause] → [mock | block | upstream] → responseheaders → rules(response) →
 *   response → relay to client.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import type { ProxyContext } from "./context.ts";
import { Flow, CnResponse, FlowError, type ClientInfo } from "../flow/flow.ts";
import { Headers } from "../flow/headers.ts";
import { collectBody, boundForStorage } from "./stream-util.ts";
import { sendUpstream, type Timings } from "./upstream.ts";
import { decodeBody, isDecodable } from "./encoding.ts";
import { log } from "../logger.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function handleRequest(
  ctx: ProxyContext,
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  scheme: "http" | "https",
  mitmTarget?: { host: string; port: number },
): Promise<void> {
  const now = ctx.now();
  const sock = clientReq.socket as net.Socket;
  const client: ClientInfo = {
    address: sock.remoteAddress ?? "",
    port: sock.remotePort ?? 0,
    tls: scheme === "https",
  };
  const flow = new Flow(client, now);
  const max = ctx.options.get("maxBodySize");

  // ---- resolve target ----
  try {
    if (mitmTarget) {
      flow.request.scheme = "https";
      const hostHeader = clientReq.headers.host ?? `${mitmTarget.host}:${mitmTarget.port}`;
      const { host, port } = splitHostPort(hostHeader, mitmTarget.port);
      flow.request.host = host || mitmTarget.host;
      flow.request.port = port || mitmTarget.port;
      flow.request.path = clientReq.url ?? "/";
    } else {
      // plain proxy request: absolute URI in req.url
      const raw = clientReq.url ?? "/";
      if (/^https?:\/\//i.test(raw)) {
        const u = new URL(raw);
        flow.request.scheme = u.protocol === "https:" ? "https" : "http";
        flow.request.host = u.hostname;
        flow.request.port = u.port ? parseInt(u.port, 10) : flow.request.scheme === "https" ? 443 : 80;
        flow.request.path = u.pathname + u.search;
      } else {
        // origin-form on the proxy port — fall back to Host header.
        const { host, port } = splitHostPort(clientReq.headers.host ?? "", 80);
        flow.request.scheme = scheme;
        flow.request.host = host;
        flow.request.port = port;
        flow.request.path = raw;
      }
    }
  } catch (e) {
    clientRes.writeHead(400).end("cnproxy: bad request target");
    return;
  }

  flow.request.method = clientReq.method ?? "GET";
  flow.request.httpVersion = clientReq.httpVersion;
  flow.request.headers = Headers.fromRaw(clientReq.rawHeaders);
  flow.request.timestampStart = now;
  ctx.store.add(flow);

  try {
    await ctx.addons.trigger("requestheaders", flow);

    // Keep the FULL request body on the flow through hooks/rules/upstream (so reqReplace
    // and addons operate on real bytes); bound the stored copy for display only at the end.
    flow.request.body = await collectBody(clientReq);
    flow.request.timestampEnd = ctx.now();

    await ctx.addons.trigger("request", flow);
    const directive = ctx.rules.applyRequest(flow);

    // ---- interception breakpoint ----
    if (ctx.interceptMatch()(flow)) {
      ctx.store.update(flow, "intercept");
      const action = await flow.intercept();
      ctx.store.update(flow);
      if (action === "kill") {
        sock.destroy();
        return;
      }
    }

    if (directive.delayMs) await sleep(directive.delayMs);

    if (directive.block) {
      log.debug("blocked", flow.request.url);
      sock.destroy();
      return;
    }

    // ---- mock / short-circuit ----
    if (directive.mock) {
      const res = new CnResponse();
      res.statusCode = directive.mock.status;
      res.reason = "";
      res.headers = directive.mock.headers.clone();
      res.body = directive.mock.body;
      res.timestampStart = ctx.now();
      res.timestampEnd = res.timestampStart;
      flow.response = res;
      await ctx.addons.trigger("responseheaders", flow);
      ctx.rules.applyResponse(flow);
      await ctx.addons.trigger("response", flow);
      writeResponse(clientRes, res);
      boundStored(flow, max);
      ctx.store.update(flow);
      return;
    }

    // ---- upstream ----
    const timings: Timings = {};
    const upstreamRes = await sendUpstream(
      flow.request,
      { upstream: ctx.options.get("upstream"), timeout: ctx.options.get("timeout") },
      timings,
    );
    flow.timings = timings;

    const res = new CnResponse();
    res.statusCode = upstreamRes.statusCode ?? 0;
    res.reason = upstreamRes.statusMessage ?? "";
    res.httpVersion = upstreamRes.httpVersion;
    res.headers = Headers.fromRaw(upstreamRes.rawHeaders);
    res.timestampStart = ctx.now();
    flow.response = res;

    await ctx.addons.trigger("responseheaders", flow);

    // ---- streaming path (SSE / large downloads) ----
    // Stream incrementally instead of buffering when nothing needs the full body: no body-rewrite
    // rule matches and no addon wants the response. Event-streams, unknown-length, or large
    // responses are streamed; everything else is buffered so rules/rewrite keep working.
    const ctype = res.headers.get("content-type") ?? "";
    const clenRaw = res.headers.get("content-length");
    const clen = clenRaw ? parseInt(clenRaw, 10) : NaN;
    const isEventStream = /text\/event-stream/i.test(ctype);
    const encoding = res.headers.get("content-encoding") ?? "";
    const STREAM_THRESHOLD = 1024 * 1024; // 1 MB
    // A compressed body must be buffered so we can decode it for capture (real servers send
    // chunked gzip with no content-length); a response-phase breakpoint also needs the full body.
    const canStream =
      !ctx.rules.hasResponseBodyRule(flow) &&
      !ctx.addons.has("response") &&
      !isDecodable(encoding) &&
      !ctx.interceptResponseMatch()(flow) &&
      (isEventStream || !Number.isFinite(clen) || clen > STREAM_THRESHOLD);

    if (canStream) {
      ctx.rules.applyResponse(flow); // header/status rules still apply (body untouched)
      await streamResponse(clientRes, upstreamRes, res, flow, ctx, max);
      return;
    }

    // Collect the raw (possibly compressed) body, then decode for capture + rule/hook operation.
    const rawBody = await collectBody(upstreamRes);
    res.timestampEnd = ctx.now();
    const decoded = isDecodable(encoding) ? decodeBody(rawBody, encoding) : rawBody;
    res.body = decoded;

    ctx.rules.applyResponse(flow);
    await ctx.addons.trigger("response", flow);

    // ---- response-phase breakpoint ----
    if (ctx.interceptResponseMatch()(flow)) {
      ctx.store.update(flow, "intercept");
      const action = await flow.intercept();
      ctx.store.update(flow);
      if (action === "kill") {
        sock.destroy();
        return;
      }
    }

    // If a rule/addon (or a breakpoint edit) changed the (decoded) body, send the modified bytes
    // with the encoding header stripped so the client reads them straight. Else relay the original.
    const modified = !!res.body && !decoded.equals(res.body);
    if (modified) {
      res.headers.delete("content-encoding");
      writeResponse(clientRes, res, res.body ?? Buffer.alloc(0));
    } else {
      writeResponse(clientRes, res, rawBody);
    }
    boundStored(flow, max);
    ctx.store.update(flow);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    flow.error = new FlowError(message, ctx.now());
    await ctx.addons.trigger("error", flow);
    log.debug("request error", flow.request.url, message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "content-type": "text/plain" }).end(`cnproxy upstream error: ${message}`);
    } else {
      clientRes.end();
    }
    ctx.store.update(flow);
  }
}

/** Replace the flow's in-memory bodies with size-bounded copies for display/storage. */
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

/**
 * Re-issue a previously captured request as a brand-new flow ("replay").
 * Runs request rules, sends upstream, applies response rules, records, and returns the new flow.
 */
export async function replayFlow(ctx: ProxyContext, source: Flow): Promise<Flow> {
  const now = ctx.now();
  const flow = new Flow({ ...source.client, address: "replay" }, now);
  flow.request.scheme = source.request.scheme;
  flow.request.host = source.request.host;
  flow.request.port = source.request.port;
  flow.request.method = source.request.method;
  flow.request.path = source.request.path;
  flow.request.httpVersion = source.request.httpVersion;
  flow.request.headers = source.request.headers.clone();
  flow.request.body = source.request.body ? Buffer.from(source.request.body) : null;
  flow.request.timestampStart = now;
  flow.request.timestampEnd = now;
  flow.comment = "replay of " + source.id;
  ctx.store.add(flow);

  const max = ctx.options.get("maxBodySize");
  try {
    await ctx.addons.trigger("request", flow);
    const directive = ctx.rules.applyRequest(flow);
    if (!directive.block && !directive.mock) {
      const upstreamRes = await sendUpstream(flow.request, {
        upstream: ctx.options.get("upstream"),
        timeout: ctx.options.get("timeout"),
      });
      const res = new CnResponse();
      res.statusCode = upstreamRes.statusCode ?? 0;
      res.reason = upstreamRes.statusMessage ?? "";
      res.httpVersion = upstreamRes.httpVersion;
      res.headers = Headers.fromRaw(upstreamRes.rawHeaders);
      res.timestampStart = ctx.now();
      flow.response = res;
      const rawBody = await collectBody(upstreamRes);
      const encoding = res.headers.get("content-encoding") ?? "";
      res.body = isDecodable(encoding) ? decodeBody(rawBody, encoding) : rawBody;
      if (res.body !== rawBody) res.headers.delete("content-encoding");
      res.timestampEnd = ctx.now();
      ctx.rules.applyResponse(flow);
      await ctx.addons.trigger("response", flow);
    } else if (directive.mock) {
      const res = new CnResponse();
      res.statusCode = directive.mock.status;
      res.headers = directive.mock.headers.clone();
      res.body = directive.mock.body;
      res.timestampStart = res.timestampEnd = ctx.now();
      flow.response = res;
    }
    boundStored(flow, max);
    ctx.store.update(flow);
  } catch (err) {
    flow.error = new FlowError(err instanceof Error ? err.message : String(err), ctx.now());
    ctx.store.update(flow);
  }
  return flow;
}

/**
 * Relay a response to the client incrementally (no full-body buffering), teeing a bounded copy
 * into the flow for the inspector. Used for SSE and large downloads.
 */
function streamResponse(
  clientRes: ServerResponse,
  upstreamRes: IncomingMessage,
  model: CnResponse,
  flow: Flow,
  ctx: ProxyContext,
  max: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    writeStreamHead(clientRes, model);
    const captured: Buffer[] = [];
    let storedLen = 0;
    let truncated = false;

    upstreamRes.on("data", (chunk: Buffer) => {
      const ok = clientRes.write(chunk);
      if (!ok) {
        upstreamRes.pause();
        clientRes.once("drain", () => upstreamRes.resume());
      }
      if (storedLen < max) {
        const room = max - storedLen;
        captured.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
        storedLen += Math.min(chunk.length, room);
        if (chunk.length > room) truncated = true;
      } else {
        truncated = true;
      }
    });
    const finish = () => {
      model.body = captured.length ? Buffer.concat(captured) : Buffer.alloc(0);
      model.bodyTruncated = truncated;
      model.timestampEnd = ctx.now();
      ctx.store.update(flow);
      resolve();
    };
    upstreamRes.on("end", () => {
      clientRes.end();
      finish();
    });
    upstreamRes.on("error", () => {
      clientRes.end();
      finish();
    });
  });
}

/** Write status + headers for a streamed response, preserving framing (no content-length rewrite). */
function writeStreamHead(res: ServerResponse, model: CnResponse): void {
  const grouped = new Map<string, string[]>();
  for (const [k, v] of model.headers.entries()) {
    const lower = k.toLowerCase();
    // Let Node manage transfer framing; keep an origin content-length (we relay every byte).
    if (lower === "transfer-encoding" || lower === "connection") continue;
    const arr = grouped.get(k) ?? [];
    arr.push(v);
    grouped.set(k, arr);
  }
  for (const [k, arr] of grouped) res.setHeader(k, arr.length === 1 ? arr[0]! : arr);
  res.writeHead(model.statusCode || 200, model.reason || undefined);
}

function writeResponse(res: ServerResponse, model: CnResponse, body?: Buffer): void {
  const payload = body ?? model.body ?? Buffer.alloc(0);
  const grouped = new Map<string, string[]>();
  for (const [k, v] of model.headers.entries()) {
    const lower = k.toLowerCase();
    if (lower === "transfer-encoding" || lower === "connection") continue;
    if (lower === "content-length") continue; // recomputed
    const arr = grouped.get(k) ?? [];
    arr.push(v);
    grouped.set(k, arr);
  }
  for (const [k, arr] of grouped) res.setHeader(k, arr.length === 1 ? arr[0]! : arr);
  res.setHeader("content-length", String(payload.length));
  res.writeHead(model.statusCode || 200, model.reason || undefined);
  res.end(payload);
}

function splitHostPort(value: string, fallbackPort: number): { host: string; port: number } {
  if (!value) return { host: "", port: fallbackPort };
  // IPv6 literal
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    const host = value.slice(1, end);
    const portPart = value.slice(end + 2);
    return { host, port: portPart ? parseInt(portPart, 10) : fallbackPort };
  }
  const idx = value.lastIndexOf(":");
  if (idx === -1) return { host: value, port: fallbackPort };
  return { host: value.slice(0, idx), port: parseInt(value.slice(idx + 1), 10) || fallbackPort };
}
