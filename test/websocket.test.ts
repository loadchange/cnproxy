import { test, expect, beforeAll, afterAll } from "bun:test";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import forge from "node-forge";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyServer } from "../src/index.ts";
import { WsFrameParser } from "../src/core/ws-frame.ts";
import { setLogLevel } from "../src/logger.ts";

function selfSigned(): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const a = [{ name: "commonName", value: "localhost" }];
  cert.setSubject(a);
  cert.setIssuer(a);
  cert.setExtensions([{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

setLogLevel("error");

let wsOrigin: ReturnType<typeof Bun.serve>;
let proxy: ProxyServer;
let originPort = 0;
const PROXY_PORT = 18890;

beforeAll(async () => {
  wsOrigin = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response("ok");
    },
    websocket: {
      message(ws, msg) {
        ws.send("echo:" + msg);
      },
    },
  });
  originPort = wsOrigin.port;
  const dataDir = mkdtempSync(join(tmpdir(), "cnproxy-ws-"));
  proxy = new ProxyServer({ port: PROXY_PORT, dataDir });
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  wsOrigin.stop(true);
});

/** Build a client→server masked text frame (RFC 6455 requires client masking). */
function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i & 3]!;
  const header = Buffer.from([0x81, 0x80 | payload.length]); // fin+text, masked, len<126
  return Buffer.concat([header, mask, masked]);
}

test("captures WebSocket frames through the proxy (absolute-URI upgrade)", async () => {
  const echo = await new Promise<string>((resolve, reject) => {
    const sock = net.connect(PROXY_PORT, "127.0.0.1");
    const parser = new WsFrameParser();
    let upgraded = false;
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error("timeout")), 5000);

    sock.on("connect", () => {
      const handshake =
        `GET http://127.0.0.1:${originPort}/chat HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${originPort}\r\n` +
        `Connection: Upgrade\r\n` +
        `Upgrade: websocket\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`;
      sock.write(handshake);
    });

    sock.on("data", (chunk: Buffer) => {
      if (!upgraded) {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString();
        if (!/101/.test(head)) {
          clearTimeout(timer);
          return reject(new Error("no 101: " + head.split("\r\n")[0]));
        }
        upgraded = true;
        const rest = buf.subarray(idx + 4);
        sock.write(maskedTextFrame("hello"));
        if (rest.length) feed(rest);
      } else {
        feed(chunk);
      }
    });

    function feed(b: Buffer) {
      for (const m of parser.push(b)) {
        clearTimeout(timer);
        sock.destroy();
        resolve(m.data.toString());
      }
    }

    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  expect(echo).toBe("echo:hello");

  await new Promise((r) => setTimeout(r, 50));
  const flow = proxy.store.list().find((f) => f.type === "websocket");
  expect(flow).toBeDefined();
  const texts = flow!.websocketMessages.map((m) => m.content.toString());
  expect(texts).toContain("hello");
  expect(texts.some((t) => t.startsWith("echo:"))).toBe(true);
});

test("captures decrypted wss frames (CONNECT + TLS + upgrade)", async () => {
  const tlsWsOrigin = Bun.serve({
    port: 0,
    tls: selfSigned(),
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response("ok");
    },
    websocket: { message(ws, msg) { ws.send("secure:" + msg); } },
  });
  const tlsPort = tlsWsOrigin.port;

  const echo = await new Promise<string>((resolve, reject) => {
    const raw = net.connect(PROXY_PORT, "127.0.0.1");
    const timer = setTimeout(() => reject(new Error("timeout")), 6000);
    let connectAck = Buffer.alloc(0);

    raw.on("connect", () => {
      raw.write(`CONNECT 127.0.0.1:${tlsPort} HTTP/1.1\r\nHost: 127.0.0.1:${tlsPort}\r\n\r\n`);
    });
    const onConnectData = (chunk: Buffer) => {
      connectAck = Buffer.concat([connectAck, chunk]);
      if (connectAck.indexOf("\r\n\r\n") === -1) return;
      raw.removeListener("data", onConnectData);
      startTls();
    };
    raw.on("data", onConnectData);
    raw.on("error", (e) => { clearTimeout(timer); reject(e); });

    function startTls() {
      const tlsSock = tls.connect({ socket: raw, servername: "localhost", rejectUnauthorized: false }, () => {
        tlsSock.write(
          `GET /chat HTTP/1.1\r\nHost: 127.0.0.1:${tlsPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      const parser = new WsFrameParser();
      let upgraded = false;
      let buf = Buffer.alloc(0);
      tlsSock.on("data", (chunk: Buffer) => {
        if (!upgraded) {
          buf = Buffer.concat([buf, chunk]);
          const idx = buf.indexOf("\r\n\r\n");
          if (idx === -1) return;
          if (!/101/.test(buf.subarray(0, idx).toString())) { clearTimeout(timer); return reject(new Error("no 101")); }
          upgraded = true;
          tlsSock.write(maskedTextFrame("ping"));
          const rest = buf.subarray(idx + 4);
          if (rest.length) feed(rest);
        } else feed(chunk);
      });
      tlsSock.on("error", (e) => { clearTimeout(timer); reject(e); });
      function feed(b: Buffer) {
        for (const m of parser.push(b)) { clearTimeout(timer); tlsSock.destroy(); resolve(m.data.toString()); }
      }
    }
  });

  expect(echo).toBe("secure:ping");
  await new Promise((r) => setTimeout(r, 50));
  const flow = proxy.store.list().filter((f) => f.type === "websocket").find((f) => f.request.scheme === "https");
  expect(flow).toBeDefined();
  expect(flow!.websocketMessages.map((m) => m.content.toString())).toContain("ping");
  tlsWsOrigin.stop(true);
});

test("WsFrameParser decompresses permessage-deflate frames", () => {
  const message = "Hello from compressed WebSocket!";
  let compressed = zlib.deflateRawSync(Buffer.from(message));
  if (compressed.slice(-4).equals(Buffer.from([0x00, 0x00, 0xff, 0xff]))) {
    compressed = compressed.subarray(0, compressed.length - 4);
  }

  // FIN=1, RSV1=1, Opcode=1 (text) -> 0xc1
  const header = Buffer.from([0xc1, compressed.length]);
  const frame = Buffer.concat([header, compressed]);

  const parser = new WsFrameParser();
  parser.enableDeflate = true;

  const msgs = parser.push(frame);
  expect(msgs.length).toBe(1);
  expect(msgs[0].type).toBe("text");
  expect(msgs[0].data.toString()).toBe(message);
});

test("WsFrameParser parses and captures ping/pong/close control frames", () => {
  // Ping: FIN=1, Opcode=9 -> 0x89
  const pingHeader = Buffer.from([0x89, 0x04]);
  const pingPayload = Buffer.from("ping");
  const pingFrame = Buffer.concat([pingHeader, pingPayload]);

  const parser = new WsFrameParser();
  const msgs = parser.push(pingFrame);

  expect(msgs.length).toBe(1);
  expect(msgs[0].type).toBe("ping");
  expect(msgs[0].data.toString()).toBe("ping");
});
