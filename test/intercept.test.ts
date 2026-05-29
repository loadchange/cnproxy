/**
 * Interception (breakpoints) — mitmproxy/Reqable parity: flows matching the intercept filter
 * pause; the operator can resume, kill, or EDIT the paused request before it goes upstream.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import http from "node:http";
import net from "node:net";
import { ProxyServer, WebInspector } from "../src/index.ts";
import { setLogLevel } from "../src/logger.ts";

setLogLevel("error");

let origin: http.Server;
let originPort = 0;
let proxy: ProxyServer;
let web: WebInspector;
const PROXY_PORT = 18940;
const WEB_PORT = 18941;
const API = `http://127.0.0.1:${WEB_PORT}`;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: req.url, edited: req.headers["x-edited"] ?? null }));
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as any).port;

  proxy = new ProxyServer({ port: PROXY_PORT, webPort: WEB_PORT, intercept: "~u /pause" });
  await proxy.start();
  web = new WebInspector(proxy);
  web.start();
});

afterAll(async () => {
  web.stop();
  await proxy.stop();
  origin.close();
});

/** Poll the store for an intercepted flow matching `path`. */
async function waitIntercepted(path: string, ms = 3000) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const f = proxy.store.list().find((x) => x.request.path === path && x.intercepted);
    if (f) return f;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

test("a matching flow pauses, and resume lets it complete", async () => {
  const p = fetch(`http://127.0.0.1:${originPort}/pause`, { proxy: PROXY });
  const f = await waitIntercepted("/pause");
  expect(f).toBeDefined();
  await fetch(`${API}/api/flows/${f!.id}/resume`, { method: "POST" });
  const res = await p;
  expect(res.status).toBe(200);
});

test("kill aborts a paused flow — client connection is dropped with no response", async () => {
  // Use a raw socket: a killed flow must close the client connection without sending any
  // HTTP response bytes. (Bun's fetch() hangs on a no-response close, so we assert at the
  // socket level — the proxy-observable contract.)
  const outcome = await new Promise<{ closed: boolean; bytes: number }>((resolve, reject) => {
    const sock = net.connect(PROXY_PORT, "127.0.0.1", () => {
      sock.write(`GET http://127.0.0.1:${originPort}/pause?kill=1 HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`);
    });
    let bytes = 0;
    const timer = setTimeout(() => reject(new Error("kill did not drop the connection")), 4000);
    sock.on("data", (d) => (bytes += d.length));
    sock.on("close", () => {
      clearTimeout(timer);
      resolve({ closed: true, bytes });
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve({ closed: true, bytes });
    });
    // Once paused, kill it via the API.
    (async () => {
      const f = await waitIntercepted("/pause?kill=1");
      if (f) await fetch(`${API}/api/flows/${f.id}/kill`, { method: "POST" });
    })();
  });
  expect(outcome.closed).toBe(true);
  expect(outcome.bytes).toBe(0); // no HTTP response was sent
});

test("a paused request can be EDITED before it is sent upstream", async () => {
  const p = fetch(`http://127.0.0.1:${originPort}/pause?edit=1`, { proxy: PROXY });
  const f = await waitIntercepted("/pause?edit=1");
  expect(f).toBeDefined();
  // Edit the paused request via the API, then resume.
  const editRes = await fetch(`${API}/api/flows/${f!.id}/edit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request: { headers: [["x-edited", "yes"]] } }),
  });
  expect(editRes.status).toBe(200);
  await fetch(`${API}/api/flows/${f!.id}/resume`, { method: "POST" });
  const body = await (await p).json();
  expect(body.edited).toBe("yes");
});
