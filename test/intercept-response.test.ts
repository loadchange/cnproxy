/**
 * Response-phase breakpoint (edit a response before it reaches the client) and live WebSocket
 * message injection — both Reqable breakpoint capabilities beyond request-only interception.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
import { WebSocketServer } from "ws";
import { ProxyServer, WebInspector } from "../src/index.ts";
import { WsFrameParser } from "../src/core/ws-frame.ts";
import { setLogLevel } from "../src/logger.ts";

setLogLevel("error");

let origin: http.Server;
let wsHttpServer: http.Server;
let wsServer: WebSocketServer;
let originPort = 0;
let wsPort = 0;
let proxy: ProxyServer;
let web: WebInspector;
const PROXY_PORT = 19100;
const WEB_PORT = 19101;
const API = `http://127.0.0.1:${WEB_PORT}`;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ original: true }));
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as any).port;

  wsHttpServer = http.createServer((_req, res) => res.end("ok"));
  wsServer = new WebSocketServer({ server: wsHttpServer });
  wsServer.on("connection", (ws) => {
    ws.on("message", (msg) => ws.send("echo:" + msg.toString()));
  });
  await new Promise<void>((r) => wsHttpServer.listen(0, "127.0.0.1", () => r()));
  wsPort = (wsHttpServer.address() as { port: number }).port;

  proxy = new ProxyServer({ port: PROXY_PORT, webPort: WEB_PORT, interceptResponse: "~u /edit-resp" });
  await proxy.start();
  web = new WebInspector(proxy);
  web.start();
});

afterAll(async () => {
  web.stop();
  await proxy.stop();
  origin.close();
  wsServer.close();
  wsHttpServer.close();
});

async function waitIntercepted(path: string, ms = 3000) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const f = proxy.store.list().find((x) => x.request.path === path && x.intercepted);
    if (f) return f;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

test("response breakpoint lets you edit the body before the client sees it", async () => {
  const p = fetch(`http://127.0.0.1:${originPort}/edit-resp`, { proxy: PROXY });
  const f = await waitIntercepted("/edit-resp");
  expect(f).toBeDefined();
  // Edit the paused response, then resume.
  await fetch(`${API}/api/flows/${f!.id}/edit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response: { body: Buffer.from(JSON.stringify({ edited: true })).toString("base64") } }),
  });
  await fetch(`${API}/api/flows/${f!.id}/resume`, { method: "POST" });
  const body = await (await p).json();
  expect(body).toEqual({ edited: true });
});

test("injects a WebSocket message into a live flow", async () => {
  // Establish a ws through the proxy via a raw absolute-URI upgrade.
  const received: string[] = [];
  const sock = net.connect(PROXY_PORT, "127.0.0.1");
  const parser = new WsFrameParser();
  let upgraded = false;
  let buf = Buffer.alloc(0);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws setup timeout")), 4000);
    sock.on("connect", () => {
      sock.write(
        `GET http://127.0.0.1:${wsPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${wsPort}\r\n` +
          `Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    sock.on("data", (chunk: Buffer) => {
      if (!upgraded) {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        upgraded = true;
        clearTimeout(timer);
        resolve();
        const rest = buf.subarray(idx + 4);
        if (rest.length) for (const m of parser.push(rest)) received.push(m.data.toString());
      } else {
        for (const m of parser.push(chunk)) received.push(m.data.toString());
      }
    });
    sock.on("error", reject);
  });

  // Find the live ws flow and inject a message toward the origin; expect an echo back.
  await new Promise((r) => setTimeout(r, 100));
  const flow = proxy.store.list().find((f) => f.type === "websocket");
  expect(flow).toBeDefined();
  const ok = proxy.injectWs(flow!.id, Buffer.from("injected"), true);
  expect(ok).toBe(true);

  await new Promise((r) => setTimeout(r, 300));
  sock.destroy();
  expect(received.some((m) => m === "echo:injected")).toBe(true);
  // The injected (client→server) message is recorded on the flow.
  expect(flow!.websocketMessages.some((m) => m.fromClient && m.content.toString() === "injected")).toBe(true);
});
