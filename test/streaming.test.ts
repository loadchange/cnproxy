/**
 * Streaming fidelity — Server-Sent Events and large downloads must be relayed incrementally,
 * not buffered whole. A buffering proxy makes SSE hang forever and pins big downloads in memory.
 * mitmproxy/Reqable stream by default; we must too (while still teeing a bounded capture copy).
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
import { ProxyServer } from "../src/index.ts";
import { setLogLevel } from "../src/logger.ts";

setLogLevel("error");

let origin: http.Server;
let originPort = 0;
let proxy: ProxyServer;
const PROXY_PORT = 18950;

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    if (req.url === "/sse") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("data: first\n\n"); // immediately
      setTimeout(() => res.write("data: second\n\n"), 300);
      setTimeout(() => res.end("data: third\n\n"), 600);
      return;
    }
    res.writeHead(200).end("ok");
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as any).port;
  proxy = new ProxyServer({ port: PROXY_PORT });
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  origin.close();
});

test("SSE events are relayed incrementally (first event arrives before the stream ends)", async () => {
  const { firstAt, doneAt, events } = await new Promise<{ firstAt: number; doneAt: number; events: string[] }>(
    (resolve, reject) => {
      const t0 = performance.now();
      let firstAt = 0;
      const chunks: string[] = [];
      const sock = net.connect(PROXY_PORT, "127.0.0.1", () => {
        sock.write(`GET http://127.0.0.1:${originPort}/sse HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`);
      });
      const timer = setTimeout(() => reject(new Error("SSE timed out — proxy is buffering")), 4000);
      const done = () => {
        clearTimeout(timer);
        const joined = chunks.join("");
        // Events appear in the chunked payload as `data: <x>`.
        const events = (joined.match(/data: \w+/g) ?? []);
        resolve({ firstAt, doneAt: performance.now() - t0, events });
        sock.destroy();
      };
      sock.on("data", (d) => {
        const s = d.toString();
        if (s.includes("data: first") && !firstAt) firstAt = performance.now() - t0;
        chunks.push(s);
        // The chunked terminator (0\r\n\r\n) marks the end of the streamed response; keep-alive
        // would otherwise hold the socket open forever.
        if (chunks.join("").includes("data: third") && s.includes("0\r\n\r\n")) done();
      });
      sock.on("close", done);
      sock.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    },
  );

  // The first event must arrive well before the origin finishes (~600ms). Buffering would push
  // firstAt close to doneAt.
  expect(firstAt).toBeLessThan(250);
  expect(doneAt).toBeGreaterThan(550);
  expect(events.length).toBe(3);

  // Captured flow still records the (bounded) streamed body.
  const flow = proxy.store.list().find((f) => f.request.path === "/sse");
  expect(flow).toBeDefined();
  expect(flow!.response?.body?.toString()).toContain("first");
});
