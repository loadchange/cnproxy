/**
 * HAR import (round-trip with export), batch replay, and per-stage upstream timing.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { ProxyServer } from "../src/index.ts";
import { flowsToHar, harToFlows } from "../src/flow/har.ts";
import { setLogLevel } from "../src/logger.ts";

setLogLevel("error");

let origin: http.Server;
let originPort = 0;
let proxy: ProxyServer;
const PROXY_PORT = 19120;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ echo: req.url }));
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

const get = (path: string) => fetch(`http://127.0.0.1:${originPort}${path}`, { proxy: PROXY });

test("HAR export → import round-trips flows", async () => {
  await get("/one?a=1");
  await get("/two");
  const har = flowsToHar(proxy.store.list(), "test") as any;
  const flows = harToFlows(har);
  expect(flows.length).toBeGreaterThanOrEqual(2);
  const one = flows.find((f) => f.request.path === "/one?a=1");
  expect(one).toBeDefined();
  expect(one!.request.method).toBe("GET");
  expect(one!.response?.statusCode).toBe(200);
  expect(one!.response?.body?.toString()).toContain("/one");
});

test("importHar adds parsed flows to the store", () => {
  const har = {
    log: {
      version: "1.2",
      creator: { name: "x", version: "1" },
      entries: [
        {
          startedDateTime: new Date().toISOString(),
          time: 5,
          request: { method: "GET", url: "https://imported.example/x", httpVersion: "HTTP/1.1", headers: [{ name: "accept", value: "*/*" }], queryString: [] },
          response: { status: 201, statusText: "Created", httpVersion: "HTTP/1.1", headers: [], content: { size: 2, mimeType: "text/plain", text: "hi" } },
        },
      ],
    },
  };
  const before = proxy.store.list().length;
  const n = proxy.importHar(har);
  expect(n).toBe(1);
  const f = proxy.store.list().find((x) => x.request.host === "imported.example");
  expect(f).toBeDefined();
  expect(f!.response?.statusCode).toBe(201);
  expect(proxy.store.list().length).toBe(before + 1);
});

test("per-stage timing is recorded for an upstream fetch", async () => {
  await get("/timed");
  const flow = proxy.store.list().find((f) => f.request.path === "/timed");
  expect(flow).toBeDefined();
  expect(flow!.timings).toBeTruthy();
  // TTFB is always measured for a real upstream response.
  expect(typeof flow!.timings!.ttfb).toBe("number");
  expect(flow!.timings!.ttfb).toBeGreaterThanOrEqual(0);
});

test("batch replay re-issues multiple captured requests", async () => {
  await get("/r1");
  await get("/r2");
  const ids = proxy.store
    .list()
    .filter((f) => f.request.path === "/r1" || f.request.path === "/r2")
    .map((f) => f.id);
  const results = await Promise.all(ids.map((id) => proxy.replay(id)));
  expect(results.filter(Boolean).length).toBe(ids.length);
  expect(results.every((r) => r!.response?.statusCode === 200)).toBe(true);
});
