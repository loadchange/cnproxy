import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import https from "node:https";
import forge from "node-forge";
import { ProxyServer } from "../src/index.ts";
import { setLogLevel } from "../src/logger.ts";

setLogLevel("error");

// ---- throwaway self-signed cert for the HTTPS origin ----
function selfSigned(): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const attrs = [{ name: "commonName", value: "localhost" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

let httpOrigin: http.Server;
let httpsOrigin: https.Server;
let proxy: ProxyServer;
let httpPort = 0;
let httpsPort = 0;
const PROXY_PORT = 18888;

beforeAll(async () => {
  httpOrigin = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, scheme: "http", url: req.url, method: req.method }));
  });
  httpsOrigin = https.createServer(selfSigned(), (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, scheme: "https", url: req.url }));
  });
  await new Promise<void>((r) => httpOrigin.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => httpsOrigin.listen(0, "127.0.0.1", r));
  httpPort = (httpOrigin.address() as any).port;
  httpsPort = (httpsOrigin.address() as any).port;

  proxy = new ProxyServer({
    port: PROXY_PORT,
    rules: `"~u /mock-me" mock://{"mocked":true}`,
  });
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  httpOrigin.close();
  httpsOrigin.close();
});

const PROXY = `http://127.0.0.1:${PROXY_PORT}`;

test("captures and relays a plain HTTP request", async () => {
  const res = await fetch(`http://127.0.0.1:${httpPort}/hello`, { proxy: PROXY });
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body).toMatchObject({ ok: true, scheme: "http", url: "/hello" });

  const flow = proxy.store.list().find((f) => f.request.path === "/hello");
  expect(flow).toBeDefined();
  expect(flow!.response?.statusCode).toBe(200);
  expect(flow!.request.scheme).toBe("http");
});

test("MITM-decrypts an HTTPS request", async () => {
  const res = await fetch(`https://127.0.0.1:${httpsPort}/secure`, {
    proxy: PROXY,
    tls: { rejectUnauthorized: false },
  });
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body).toMatchObject({ ok: true, scheme: "https", url: "/secure" });

  const flow = proxy.store.list().find((f) => f.request.path === "/secure");
  expect(flow).toBeDefined();
  expect(flow!.request.scheme).toBe("https");
  // decrypted body should be visible
  expect(flow!.response?.body?.toString()).toContain("https");
});

test("a mock rule short-circuits upstream", async () => {
  const res = await fetch(`http://127.0.0.1:${httpPort}/mock-me`, { proxy: PROXY });
  const body = await res.json();
  expect(body).toEqual({ mocked: true });

  const flow = proxy.store.list().find((f) => f.request.path === "/mock-me");
  expect(flow!.mocked).toBe(true);
});

test("replay re-issues a captured request", async () => {
  const flow = proxy.store.list().find((f) => f.request.path === "/hello");
  const replayed = await proxy.replay(flow!.id);
  expect(replayed).not.toBeNull();
  expect(replayed!.response?.statusCode).toBe(200);
  expect(replayed!.comment).toContain("replay of");
});
