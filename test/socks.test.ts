/**
 * SOCKS5 inbound — a SOCKS5 client must be able to tunnel HTTP and HTTPS (MITM-decrypted) through
 * the same front port as the HTTP proxy. We hand-roll the SOCKS5 handshake over a raw socket.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import forge from "node-forge";
import { ProxyServer } from "../src/index.ts";
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
let httpPort = 0;
let httpsPort = 0;
let proxy: ProxyServer;
const PROXY_PORT = 18980;

beforeAll(async () => {
  httpOrigin = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, scheme: "http", url: req.url }));
  });
  httpsOrigin = https.createServer(selfSigned(), (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, scheme: "https", url: req.url }));
  });
  await new Promise<void>((r) => httpOrigin.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => httpsOrigin.listen(0, "127.0.0.1", r));
  httpPort = (httpOrigin.address() as any).port;
  httpsPort = (httpsOrigin.address() as any).port;
  proxy = new ProxyServer({ port: PROXY_PORT });
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  httpOrigin.close();
  httpsOrigin.close();
});

/** Perform a SOCKS5 NO-AUTH CONNECT to host:port through the proxy; resolves the tunneled socket. */
function socks5Connect(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PROXY_PORT, "127.0.0.1", () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00])); // ver, 1 method, NO-AUTH
    });
    let stage = 0;
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return reject(new Error("method-select failed"));
        buf = buf.subarray(2);
        stage = 1;
        // send CONNECT request (atyp=3 domain)
        const name = Buffer.from(host, "utf8");
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
          name,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]);
        sock.write(req);
        return;
      }
      if (stage === 1) {
        if (buf.length < 10) return;
        if (buf[1] !== 0x00) return reject(new Error("connect reply failed: " + buf[1]));
        sock.off("data", onData);
        resolve(sock);
      }
    };
    sock.on("data", onData);
    sock.on("error", reject);
    setTimeout(() => reject(new Error("socks timeout")), 4000);
  });
}

function readHttpResponse(sock: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    sock.on("data", (d) => (buf += d.toString()));
    sock.on("close", () => resolve(buf));
    sock.on("error", reject);
    setTimeout(() => resolve(buf), 1500);
  });
}

test("SOCKS5 tunnels a plain HTTP request (captured)", async () => {
  const sock = await socks5Connect("127.0.0.1", httpPort);
  sock.write(`GET /socks-http HTTP/1.1\r\nHost: 127.0.0.1:${httpPort}\r\nConnection: close\r\n\r\n`);
  const res = await readHttpResponse(sock);
  expect(res).toContain("200");
  expect(res).toContain('"scheme":"http"');

  const flow = proxy.store.list().find((f) => f.request.path === "/socks-http");
  expect(flow).toBeDefined();
  expect(flow!.response?.statusCode).toBe(200);
});

test("SOCKS5 tunnels and MITM-decrypts an HTTPS request (captured)", async () => {
  const sock = await socks5Connect("localhost", httpsPort);
  const tlsSock = tls.connect({ socket: sock, servername: "localhost", rejectUnauthorized: false }, () => {
    tlsSock.write(`GET /socks-https HTTP/1.1\r\nHost: localhost:${httpsPort}\r\nConnection: close\r\n\r\n`);
  });
  const res = await new Promise<string>((resolve, reject) => {
    let buf = "";
    tlsSock.on("data", (d) => (buf += d.toString()));
    tlsSock.on("close", () => resolve(buf));
    tlsSock.on("error", reject);
    setTimeout(() => resolve(buf), 2000);
  });
  expect(res).toContain('"scheme":"https"');

  const flow = proxy.store.list().find((f) => f.request.path === "/socks-https");
  expect(flow).toBeDefined();
  expect(flow!.request.scheme).toBe("https");
});
