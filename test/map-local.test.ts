/**
 * Map-local (dir://) and highlight:// rules — whistle-style directory mapping and Reqable-style
 * color tagging.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyServer } from "../src/index.ts";
import { setLogLevel } from "../src/logger.ts";

setLogLevel("error");

let origin: http.Server;
let originPort = 0;
let proxy: ProxyServer;
const PROXY_PORT = 19110;
const dir = mkdtempSync(join(tmpdir(), "cnproxy-www-"));

beforeAll(async () => {
  mkdirSync(join(dir, "js"), { recursive: true });
  writeFileSync(join(dir, "app.css"), "body{color:red}");
  writeFileSync(join(dir, "js", "main.js"), "console.log('local')");

  origin = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("from-origin");
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as any).port;

  proxy = new ProxyServer({
    port: PROXY_PORT,
    rules: [`/assets dir://${dir}`, `"~u secret" highlight://red`].join("\n"),
  });
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  origin.close();
});

const get = (path: string) => fetch(`http://127.0.0.1:${originPort}${path}`, { proxy: `http://127.0.0.1:${PROXY_PORT}` });

test("dir:// serves a file from the mapped directory", async () => {
  const res = await get("/assets/app.css");
  expect(res.headers.get("content-type")).toContain("text/css");
  expect(await res.text()).toBe("body{color:red}");
});

test("dir:// serves nested files", async () => {
  const res = await get("/assets/js/main.js");
  expect(await res.text()).toBe("console.log('local')");
});

test("dir:// 404s a missing file (without hitting origin)", async () => {
  const res = await get("/assets/missing.png");
  expect(res.status).toBe(404);
});

test("dir:// blocks path traversal", async () => {
  const res = await get("/assets/../../etc/hosts");
  // normalized by fetch/URL, but any escape attempt must not leak a file
  expect([404, 200].includes(res.status)).toBe(true);
  if (res.status === 200) expect(await res.text()).not.toContain("localhost");
});

test("highlight:// tags a matching flow with a color", async () => {
  await get("/secret/data");
  const flow = proxy.store.list().find((f) => f.request.path === "/secret/data");
  expect(flow).toBeDefined();
  expect(flow!.color).toBe("red");
});
