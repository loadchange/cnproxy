/**
 * WebSocket interception over raw sockets. We use raw sockets (not node:http's `upgrade`
 * event); the router hands us the raw client socket plus the already-peeked handshake.
 * We open a raw connection to the origin, replay the handshake (origin-form), and relay
 * bytes verbatim in both directions — teeing a copy through a frame parser so messages
 * appear in the inspector.
 */

import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { ProxyContext } from "./context.ts";
import type { PeekedRequest } from "./head-parser.ts";
import { Flow, type ClientInfo } from "../flow/flow.ts";
import { Headers } from "../flow/headers.ts";
import { WsFrameParser, encodeFrame, type ParsedMessage } from "./ws-frame.ts";
import { log } from "../logger.ts";

/** Live WebSocket relays, keyed by flow id, so the API can inject messages into them. */
const liveSockets = new Map<string, { client: Duplex; upstream: Duplex }>();

/**
 * Inject a message into a live WebSocket flow. `toServer` sends toward the origin (masked, as a
 * client must), otherwise toward the browser (unmasked). Records it in the flow. Returns false if
 * the flow isn't an active websocket.
 */
export function injectWsMessage(ctx: ProxyContext, flowId: string, data: Buffer, toServer: boolean): boolean {
  const live = liveSockets.get(flowId);
  if (!live) return false;
  const frame = encodeFrame(data, { masked: toServer });
  (toServer ? live.upstream : live.client).write(frame);
  const flow = ctx.store.get(flowId);
  if (flow) {
    flow.websocketMessages.push({ fromClient: toServer, type: "text", content: data, timestamp: ctx.now() });
    ctx.store.update(flow);
  }
  return true;
}

export function relayWebSocket(
  ctx: ProxyContext,
  head: PeekedRequest,
  clientSocket: Duplex,
  remote: { address: string; port: number },
  scheme: "http" | "https",
  target: { host: string; port: number },
): void {
  const now = ctx.now();
  const client: ClientInfo = { address: remote.address, port: remote.port, tls: scheme === "https" };

  // Proxied plain-ws handshakes use an absolute-URI target; the origin needs origin-form.
  const originPath = /^https?:\/\//i.test(head.target)
    ? (() => {
        const u = new URL(head.target);
        return u.pathname + u.search;
      })()
    : head.target;

  const flow = new Flow(client, now);
  flow.type = "websocket";
  flow.request.scheme = scheme;
  flow.request.host = target.host;
  flow.request.port = target.port;
  flow.request.method = head.method;
  flow.request.path = originPath;
  flow.request.headers = new Headers(pairsToTuples(head.rawHeaders));
  flow.request.timestampStart = now;
  ctx.store.add(flow);

  const upstream =
    scheme === "https"
      ? tls.connect({
          host: target.host,
          port: target.port,
          servername: net.isIP(target.host) === 0 ? target.host : undefined,
          rejectUnauthorized: false,
        })
      : net.connect({ host: target.host, port: target.port });

  const teardown = () => {
    liveSockets.delete(flow.id);
    clientSocket.destroy();
    upstream.destroy();
    ctx.store.update(flow);
  };
  upstream.on("error", (e: Error) => {
    log.debug("ws upstream error:", e.message);
    teardown();
  });
  clientSocket.on("error", () => teardown());

  const ready = scheme === "https" ? "secureConnect" : "connect";
  upstream.once(ready as "connect", () => {
    // Replay the handshake to the origin in origin-form, negotiating permessage-deflate safely.
    const lines = [`${head.method} ${originPath} HTTP/${head.httpVersion}`];
    for (let i = 0; i + 1 < head.rawHeaders.length; i += 2) {
      const name = head.rawHeaders[i]!;
      let val = head.rawHeaders[i + 1]!;
      if (name.toLowerCase() === "sec-websocket-extensions") {
        if (val.includes("permessage-deflate")) {
          val = "permessage-deflate; client_no_context_takeover; server_no_context_takeover";
        }
      }
      lines.push(`${name}: ${val}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.rest && head.rest.length) {
      upstream.write(head.rest);
      capture(ctx, flow, new WsFrameParser().push(head.rest), true);
    }

    ctx.addons.trigger("websocketStart", flow).catch(() => {});
    liveSockets.set(flow.id, { client: clientSocket, upstream });

    const clientParser = new WsFrameParser();
    const serverParser = new WsFrameParser();
    // The origin's first bytes are the 101 handshake response — relay them raw but keep them
    // out of the frame parser; only feed it the bytes that follow CRLFCRLF.
    let handshakeDone = false;
    let handshakeBuf = Buffer.alloc(0);

    clientSocket.on("data", (chunk: Buffer) => {
      upstream.write(chunk);
      capture(ctx, flow, clientParser.push(chunk), true);
    });
    upstream.on("data", (chunk: Buffer) => {
      clientSocket.write(chunk);
      if (!handshakeDone) {
        handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
        const idx = handshakeBuf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        handshakeDone = true;

        // Parse handshake headers to check if server agreed to permessage-deflate
        const respText = handshakeBuf.subarray(0, idx).toString("utf-8");
        const respLines = respText.split("\r\n");
        let hasDeflate = false;
        for (const line of respLines) {
          const colon = line.indexOf(":");
          if (colon !== -1) {
            const name = line.slice(0, colon).trim().toLowerCase();
            const val = line.slice(colon + 1).trim();
            if (name === "sec-websocket-extensions" && val.includes("permessage-deflate")) {
              hasDeflate = true;
            }
          }
        }

        if (hasDeflate) {
          clientParser.enableDeflate = true;
          serverParser.enableDeflate = true;
        }

        const after = handshakeBuf.subarray(idx + 4);
        if (after.length) capture(ctx, flow, serverParser.push(after), false);
        return;
      }
      capture(ctx, flow, serverParser.push(chunk), false);
    });
    clientSocket.on("close", teardown);
    upstream.on("close", teardown);
  });
}

function pairsToTuples(raw: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i]!, raw[i + 1]!]);
  return out;
}

function capture(
  ctx: ProxyContext,
  flow: Flow,
  messages: ParsedMessage[],
  fromClient: boolean,
): void {
  if (!messages.length) return;
  for (const m of messages) {
    const msg = { fromClient, type: m.type, content: m.data, timestamp: ctx.now() };
    flow.websocketMessages.push(msg);
    ctx.addons.trigger("websocketMessage", flow, msg).catch(() => {});
  }
  ctx.store.update(flow);
}
