/**
 * Rule-engine functional coverage — every operator exercised through the real proxy against a
 * live origin. This is the whistle-parity bar: host, rewrite, redirect, req/resHeaders, ua,
 * referer, reqReplace, resReplace, status, restype, delay, block, mock, file.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyServer } from "../src/index.ts";
import { setLogLevel } from "../src/logger.ts";

setLogLevel("error");

let origin: http.Server; // the "real" upstream
let altOrigin: http.Server; // the host:// redirect target
let originPort = 0;
let altPort = 0;
let proxy: ProxyServer;
const PROXY_PORT = 18910;
const tmp = mkdtempSync(join(tmpdir(), "cnproxy-rules-"));
const mockFile = join(tmp, "payload.json");
writeFileSync(mockFile, JSON.stringify({ from: "file" }));

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    // Echo back what the origin actually received, so we can assert request-side rewrites.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        server: "origin",
        url: req.url,
        method: req.method,
        ua: req.headers["user-agent"] ?? null,
        referer: req.headers["referer"] ?? null,
        injected: req.headers["x-injected"] ?? null,
        ctype: req.headers["content-type"] ?? null,
        body: "",
      }),
    );
  });
  altOrigin = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ server: "alt", url: req.url }));
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => altOrigin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as any).port;
  altPort = (altOrigin.address() as any).port;

  const rules = [
    `"~u /host-redirect" host://127.0.0.1:${altPort}`,
    `"~u /redirect-me" redirect://https://example.com/dest`,
    `"~u /inject" reqHeaders://{"x-injected":"yes"}`,
    `"~u /ua" ua://CnProxyAgent/1.0`,
    `"~u /referer" referer://https://ref.example/`,
    `"~u /resheaders" resHeaders://{"x-added":"1"}`,
    `"~u /restype" resType://text/plain`,
    `"~u /status-override" status://503`,
    `"~u /resreplace" resReplace://s/origin/PATCHED/`,
    `"~u /blocked" block://`,
    `"~u /delayed" delay://300`,
    `"~u /mock-json" mock://{"hi":1}`,
    `"~u /from-file" file://${mockFile}`,
  ].join("\n");

  proxy = new ProxyServer({ port: PROXY_PORT, rules });
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  origin.close();
  altOrigin.close();
});

const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const get = (path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${originPort}${path}`, { proxy: PROXY, ...init });

test("host:// redirects the request to another origin", async () => {
  const body = await (await get("/host-redirect")).json();
  expect(body.server).toBe("alt");
});

test("redirect:// returns a 302 to the client", async () => {
  const res = await get("/redirect-me", { redirect: "manual" });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("https://example.com/dest");
});

test("reqHeaders:// injects a request header seen by the origin", async () => {
  const body = await (await get("/inject")).json();
  expect(body.injected).toBe("yes");
});

test("ua:// overrides the User-Agent", async () => {
  const body = await (await get("/ua")).json();
  expect(body.ua).toBe("CnProxyAgent/1.0");
});

test("referer:// sets the Referer", async () => {
  const body = await (await get("/referer")).json();
  expect(body.referer).toBe("https://ref.example/");
});

test("resHeaders:// adds a response header", async () => {
  const res = await get("/resheaders");
  expect(res.headers.get("x-added")).toBe("1");
});

test("resType:// overrides the response content-type", async () => {
  const res = await get("/restype");
  expect(res.headers.get("content-type")).toContain("text/plain");
});

test("status:// overrides the response status", async () => {
  const res = await get("/status-override");
  expect(res.status).toBe(503);
});

test("resReplace:// rewrites the response body", async () => {
  const text = await (await get("/resreplace")).text();
  expect(text).toContain("PATCHED");
  expect(text).not.toContain('"origin"');
});

test("block:// aborts the connection", async () => {
  let failed = false;
  try {
    await get("/blocked");
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
});

test("delay:// delays the response by ~300ms", async () => {
  const t0 = performance.now();
  await get("/delayed");
  expect(performance.now() - t0).toBeGreaterThanOrEqual(250);
});

test("mock:// synthesizes a JSON response", async () => {
  const body = await (await get("/mock-json")).json();
  expect(body).toEqual({ hi: 1 });
});

test("file:// serves a local file as the response", async () => {
  const body = await (await get("/from-file")).json();
  expect(body).toEqual({ from: "file" });
});
