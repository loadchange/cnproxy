/**
 * HAR 1.2 export — captured sessions must be exportable to the universal interchange format so
 * users can open them in Chrome DevTools / Charles / Reqable.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { ProxyServer, WebInspector } from "../src/index.ts";
import { setLogLevel } from "../src/logger.ts";

setLogLevel("error");

let origin: http.Server;
let originPort = 0;
let proxy: ProxyServer;
let web: WebInspector;
const PROXY_PORT = 18960;
const WEB_PORT = 18961;

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ echo: req.url }));
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as any).port;
  proxy = new ProxyServer({ port: PROXY_PORT, webPort: WEB_PORT });
  await proxy.start();
  web = new WebInspector(proxy);
  await web.start();
  await fetch(`http://127.0.0.1:${originPort}/api/thing?x=1`, { proxy: `http://127.0.0.1:${PROXY_PORT}` });
});

afterAll(async () => {
  web.stop();
  await proxy.stop();
  origin.close();
});

test("GET /api/export/har produces a valid HAR 1.2 log with the captured entry", async () => {
  const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/export/har`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toContain(".har");

  const har = await res.json();
  expect(har.log.version).toBe("1.2");
  expect(har.log.creator.name).toBe("cnproxy");

  const e = har.log.entries.find((x: any) => x.request.url.includes("/api/thing"));
  expect(e).toBeTruthy();
  expect(e.request.method).toBe("GET");
  expect(e.request.queryString).toContainEqual({ name: "x", value: "1" });
  expect(e.response.status).toBe(200);
  expect(e.response.content.text).toContain("/api/thing");
  expect(typeof e.startedDateTime).toBe("string");
});
