/**
 * Content-encoding fidelity — the bar every serious proxy (mitmproxy/whistle/Reqable) must meet:
 * compressed origin responses must be captured DECODED (so the inspector + body filters see real
 * text), and a resReplace/resBody rewrite of a compressed response must reach the client as a
 * valid, readable body.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import http from "node:http";
import zlib from "node:zlib";
import { ProxyServer } from "../src/index.ts";
import { compileFilter } from "../src/rules/filter.ts";
import { setLogLevel } from "../src/logger.ts";

setLogLevel("error");

const BIG = "console.log('hello world');".repeat(200); // compressible, > a few KB

let origin: http.Server;
let originPort = 0;
let proxy: ProxyServer;
const PROXY_PORT = 18900;

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    // Path's first segment selects the encoding; everything compresses the same payload.
    const enc = (req.url || "/").split("/")[1]?.split("-")[0] ?? "";
    const payload = Buffer.from(BIG, "utf8");
    if (enc === "gzip") {
      res.writeHead(200, { "content-type": "text/javascript", "content-encoding": "gzip" });
      res.end(zlib.gzipSync(payload));
    } else if (enc === "br") {
      res.writeHead(200, { "content-type": "text/javascript", "content-encoding": "br" });
      res.end(zlib.brotliCompressSync(payload));
    } else if (enc === "deflate") {
      res.writeHead(200, { "content-type": "text/javascript", "content-encoding": "deflate" });
      res.end(zlib.deflateSync(payload));
    } else {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(payload);
    }
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as any).port;

  proxy = new ProxyServer({
    port: PROXY_PORT,
    // Rewrite inside the (decoded) gzip JS body — only works if we decode before replace.
    rules: `"~u /gzip-rewrite" resReplace://s/hello world/REWRITTEN/`,
  });
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  origin.close();
});

const PROXY = `http://127.0.0.1:${PROXY_PORT}`;

for (const enc of ["gzip", "br", "deflate"]) {
  test(`captures ${enc} response body DECODED (not compressed bytes)`, async () => {
    const res = await fetch(`http://127.0.0.1:${originPort}/${enc}`, { proxy: PROXY });
    const text = await res.text();
    // Client still gets the real content.
    expect(text).toContain("hello world");

    const flow = proxy.store.list().find((f) => f.request.path === `/${enc}` && f.response);
    expect(flow).toBeDefined();
    // The STORED body must be the decoded text, so the inspector and ~bs filters work.
    const stored = flow!.response!.body!.toString("utf8");
    expect(stored).toContain("console.log('hello world');");
    expect(stored.length).toBe(BIG.length);
  });
}

test("a body filter (~bs) matches the decoded content of a compressed response", async () => {
  await fetch(`http://127.0.0.1:${originPort}/br`, { proxy: PROXY });
  const flow = proxy.store.list().find((f) => f.request.path === "/br" && f.response);
  expect(compileFilter('~bs "hello world"')(flow!)).toBe(true);
});

test("resReplace rewrites a gzip response and the client receives valid, readable bytes", async () => {
  const res = await fetch(`http://127.0.0.1:${originPort}/gzip-rewrite`, { proxy: PROXY });
  const text = await res.text(); // fetch auto-decodes per content-encoding header (now stripped)
  expect(text).toContain("REWRITTEN");
  expect(text).not.toContain("hello world");
});
