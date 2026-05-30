/**
 * HTTP/2 MITM — a client that negotiates h2 over the CONNECT tunnel must be decrypted, captured,
 * and relayed. This is the headline transport gap vs Reqable. We drive a real h2 client through
 * the proxy (CONNECT → TLS with ALPN h2 → http2.connect) against an h1 origin.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import https from "node:https";
import http2 from "node:http2";
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

let origin: https.Server; // h2 always implies TLS, so the origin is an HTTPS server
let originPort = 0;
let proxy: ProxyServer;
const PROXY_PORT = 18970;

beforeAll(async () => {
  origin = https.createServer(selfSigned(), (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, method: req.method, url: req.url, gotBody: body }));
    });
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

/**
 * Open a CONNECT tunnel to the IP target through the proxy, then an h2 session over TLS using a
 * hostname for SNI/`:authority` (TLS forbids an IP servername). The proxy connects upstream to the
 * CONNECT target (the IP), so this avoids localhost IPv4/IPv6 resolution ambiguity.
 */
function h2ConnectThroughProxy(authorityHost: string, port: number): Promise<http2.ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    const raw = net.connect(PROXY_PORT, "127.0.0.1", () => {
      raw.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.indexOf("\r\n\r\n") === -1) return;
      if (!/200/.test(buf.toString("latin1").split("\r\n")[0]!)) return reject(new Error("CONNECT failed"));
      raw.removeListener("data", onData);
      const session = http2.connect(`https://${authorityHost}:${port}`, {
        createConnection: () =>
          tls.connect({ socket: raw, servername: authorityHost, ALPNProtocols: ["h2"], rejectUnauthorized: false }) as any,
      });
      session.on("error", reject);
      resolve(session);
    };
    raw.on("data", onData);
    raw.on("error", reject);
  });
}

test("decrypts and relays an HTTP/2 GET (client h2 → proxy → h1 origin)", async () => {
  const session = await h2ConnectThroughProxy("localhost", originPort);
  const body = await new Promise<any>((resolve, reject) => {
    const req = session.request({ ":method": "GET", ":path": "/h2-get", ":authority": `localhost:${originPort}` });
    let data = "";
    req.on("response", (h) => {
      expect(h[":status"]).toBe(200);
    });
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      session.close();
      resolve(JSON.parse(data));
    });
    req.on("error", reject);
    req.end();
    setTimeout(() => reject(new Error("h2 GET timeout")), 5000);
  });
  expect(body).toMatchObject({ ok: true, method: "GET", url: "/h2-get" });

  const flow = proxy.store.list().find((f) => f.request.path === "/h2-get");
  expect(flow).toBeDefined();
  expect(flow!.request.httpVersion).toBe("2.0");
  expect(flow!.request.scheme).toBe("https");
  expect(flow!.response?.statusCode).toBe(200);
});

test("relays an HTTP/2 POST body", async () => {
  const session = await h2ConnectThroughProxy("localhost", originPort);
  const body = await new Promise<any>((resolve, reject) => {
    const req = session.request({
      ":method": "POST",
      ":path": "/h2-post",
      ":authority": `localhost:${originPort}`,
      "content-type": "text/plain",
    });
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      session.close();
      resolve(JSON.parse(data));
    });
    req.on("error", reject);
    req.write("hello-h2-body");
    req.end();
    setTimeout(() => reject(new Error("h2 POST timeout")), 5000);
  });
  expect(body.method).toBe("POST");
  expect(body.gotBody).toBe("hello-h2-body");
});

test("applies a mock rule over HTTP/2", async () => {
  proxy.options.update({ rules: `"~u /h2-mock" mock://{"mocked":"h2"}` });
  const session = await h2ConnectThroughProxy("localhost", originPort);
  const body = await new Promise<any>((resolve, reject) => {
    const req = session.request({ ":method": "GET", ":path": "/h2-mock", ":authority": `localhost:${originPort}` });
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      session.close();
      resolve(JSON.parse(data));
    });
    req.on("error", reject);
    req.end();
    setTimeout(() => reject(new Error("h2 mock timeout")), 5000);
  });
  expect(body).toEqual({ mocked: "h2" });
  proxy.options.update({ rules: "" });
});

test("supports end-to-end HTTP/2 upstream and connection reuse", async () => {
  // Spin up a real HTTP/2 secure origin server
  let h2ReceivedCount = 0;
  const h2Origin = http2.createSecureServer(selfSigned(), (req, res) => {
    h2ReceivedCount++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      e2eH2: true,
      httpVersion: req.httpVersion,
      count: h2ReceivedCount
    }));
  });

  await new Promise<void>((resolve) => h2Origin.listen(0, "127.0.0.1", () => resolve()));
  const h2OriginPort = (h2Origin.address() as any).port;

  try {
    // Send first request: will negotiate and establish H2 session
    const session1 = await h2ConnectThroughProxy("localhost", h2OriginPort);
    const body1 = await new Promise<any>((resolve, reject) => {
      const req = session1.request({ ":method": "GET", ":path": "/h2-origin", ":authority": `localhost:${h2OriginPort}` });
      let data = "";
      req.on("data", (d) => (data += d));
      req.on("end", () => {
        session1.close();
        resolve(JSON.parse(data));
      });
      req.on("error", reject);
      req.end();
      setTimeout(() => reject(new Error("H2 first request timeout")), 5000);
    });

    expect(body1).toEqual({ e2eH2: true, httpVersion: "2.0", count: 1 });

    // Send second request: should reuse the H2 session cached in proxy!
    const session2 = await h2ConnectThroughProxy("localhost", h2OriginPort);
    const body2 = await new Promise<any>((resolve, reject) => {
      const req = session2.request({ ":method": "GET", ":path": "/h2-origin", ":authority": `localhost:${h2OriginPort}` });
      let data = "";
      req.on("data", (d) => (data += d));
      req.on("end", () => {
        session2.close();
        resolve(JSON.parse(data));
      });
      req.on("error", reject);
      req.end();
      setTimeout(() => reject(new Error("H2 second request timeout")), 5000);
    });

    expect(body2).toEqual({ e2eH2: true, httpVersion: "2.0", count: 2 });
  } finally {
    h2Origin.close();
  }
});
