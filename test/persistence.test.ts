/**
 * Session persistence / history — captured flows must survive a save/clear/load round-trip
 * (and a process restart, simulated by a fresh ProxyServer reading the same dataDir), with
 * bodies and metadata intact. This is Reqable's "History".
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyServer } from "../src/index.ts";
import { setLogLevel } from "../src/logger.ts";

setLogLevel("error");

let origin: http.Server;
let originPort = 0;
let proxy: ProxyServer;
const PROXY_PORT = 18990;
const dataDir = mkdtempSync(join(tmpdir(), "cnproxy-data-"));

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ echo: req.url }));
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as any).port;
  proxy = new ProxyServer({ port: PROXY_PORT, dataDir });
  await proxy.start();
  await fetch(`http://127.0.0.1:${originPort}/a`, { proxy: `http://127.0.0.1:${PROXY_PORT}` });
  await fetch(`http://127.0.0.1:${originPort}/b`, { proxy: `http://127.0.0.1:${PROXY_PORT}` });
});

afterAll(async () => {
  await proxy.stop();
  origin.close();
});

test("save → clear → load restores flows with bodies intact", () => {
  const before = proxy.store.list().length;
  expect(before).toBeGreaterThanOrEqual(2);

  proxy.saveSession("test-session");
  proxy.store.clear();
  expect(proxy.store.list().length).toBe(0);

  const loaded = proxy.loadSession("test-session");
  expect(loaded).toBe(before);

  const a = proxy.store.list().find((f) => f.request.path === "/a");
  expect(a).toBeDefined();
  expect(a!.response?.statusCode).toBe(200);
  expect(a!.response?.body?.toString()).toContain("/a");
});

test("listSessions reports the saved session", () => {
  const sessions = proxy.listSessions();
  const s = sessions.find((x) => x.name === "test-session.cnp");
  expect(s).toBeDefined();
  expect(s!.flows).toBeGreaterThanOrEqual(2);
});

test("a fresh ProxyServer (simulated restart) can load a session from the same dataDir", async () => {
  proxy.saveSession("persist-across-restart");
  const fresh = new ProxyServer({ port: PROXY_PORT + 1, dataDir });
  // no start() needed — session IO is independent of the listeners
  const count = fresh.loadSession("persist-across-restart");
  expect(count).toBeGreaterThanOrEqual(2);
  expect(fresh.store.list().some((f) => f.request.path === "/b")).toBe(true);
});
