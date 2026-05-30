/**
 * Transport-fidelity edge cases: blind tunnel for ignored hosts, duplicate response headers
 * (Set-Cookie) preserved to the client, large-body truncation for storage (but full relay),
 * and addon hook ordering + mutation.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import https from "node:https";
import forge from "node-forge";
import { ProxyServer } from "../src/index.ts";
import type { Addon } from "../src/addons/types.ts";
import { setLogLevel } from "../src/logger.ts";

setLogLevel("error");

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
let originPort = 0;
let httpsPort = 0;
let proxy: ProxyServer;
const PROXY_PORT = 18930;

const hookOrder: string[] = [];
const tracer: Addon = {
  name: "tracer",
  requestheaders(f) {
    hookOrder.push("requestheaders");
  },
  request(f) {
    hookOrder.push("request");
    if (f.request.path === "/addon-mutate") f.request.headers.set("x-addon", "touched");
  },
  responseheaders() {
    hookOrder.push("responseheaders");
  },
  response() {
    hookOrder.push("response");
  },
};

beforeAll(async () => {
  httpOrigin = http.createServer((req, res) => {
    if (req.url === "/cookies") {
      res.setHeader("Set-Cookie", ["a=1", "b=2"]);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(200 * 1024, 0x41)); // 200KB of 'A'
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, url: req.url, addon: req.headers["x-addon"] ?? null }));
  });
  httpsOrigin = https.createServer(selfSigned(), (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tunneled: true }));
  });
  await new Promise<void>((r) => httpOrigin.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => httpsOrigin.listen(0, "127.0.0.1", r));
  originPort = (httpOrigin.address() as any).port;
  httpsPort = (httpsOrigin.address() as any).port;

  proxy = new ProxyServer({
    port: PROXY_PORT,
    maxBodySize: 64 * 1024, // 64KB cap → /big (200KB) must truncate in storage
    ignoreHosts: ["127.0.0.1"], // never decrypt → blind tunnel for HTTPS
  });
  proxy.use(tracer);
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  httpOrigin.close();
  httpsOrigin.close();
});

const PROXY = `http://127.0.0.1:${PROXY_PORT}`;

test("duplicate Set-Cookie headers are preserved to the client", async () => {
  const res = await fetch(`http://127.0.0.1:${originPort}/cookies`, { proxy: PROXY });
  await res.text();
  // Bun's Headers.getSetCookie returns the array; fall back to raw if needed.
  const cookies = (res.headers as any).getSetCookie?.() ?? [];
  expect(cookies).toContain("a=1");
  expect(cookies).toContain("b=2");
});

test("large body is relayed in full but truncated in storage", async () => {
  const res = await fetch(`http://127.0.0.1:${originPort}/big`, { proxy: PROXY });
  const buf = Buffer.from(await res.arrayBuffer());
  expect(buf.length).toBe(200 * 1024); // client gets every byte

  const flow = proxy.store.list().find((f) => f.request.path === "/big");
  expect(flow).toBeDefined();
  expect(flow!.response!.bodyTruncated).toBe(true);
  expect(flow!.response!.body!.length).toBeLessThanOrEqual(64 * 1024);
});

test("addon hooks fire in order and can mutate the request", async () => {
  hookOrder.length = 0;
  const body = await (await fetch(`http://127.0.0.1:${originPort}/addon-mutate`, { proxy: PROXY })).json();
  expect(body.addon).toBe("touched");
  expect(hookOrder).toEqual(["requestheaders", "request", "responseheaders", "response"]);
});

test("ignored host is blind-tunneled (HTTPS works, but not decrypted/captured)", async () => {
  const res = await fetch(`https://127.0.0.1:${httpsPort}/secret`, {
    proxy: PROXY,
    tls: { rejectUnauthorized: false },
  });
  const body = await res.json();
  expect(body.tunneled).toBe(true);
  // Because it was tunneled (not MITM'd), there should be no decrypted https flow for this path.
  const decrypted = proxy.store.list().find((f) => f.request.path === "/secret" && f.request.scheme === "https");
  expect(decrypted).toBeUndefined();
});
