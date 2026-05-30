/**
 * API-testing engine — compose/send requests, environment variable substitution, cookie jar,
 * cURL import, and code-snippet generation (curl/fetch/python).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyServer } from "../src/index.ts";
import { parseCurl, generateCode } from "../src/api/composer.ts";
import { Flow } from "../src/flow/flow.ts";
import { setLogLevel } from "../src/logger.ts";

setLogLevel("error");

let origin: http.Server;
let originPort = 0;
let proxy: ProxyServer;
const PROXY_PORT = 19130;
const dataDir = mkdtempSync(join(tmpdir(), "cnproxy-ws-"));

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      if (req.url === "/set-cookie") headers["set-cookie"] = "sid=abc123";
      res.writeHead(200, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify({ method: req.method, url: req.url, body, cookie: req.headers["cookie"] ?? null, auth: req.headers["authorization"] ?? null }));
    });
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as any).port;
  proxy = new ProxyServer({ port: PROXY_PORT, dataDir });
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  origin.close();
});

const base = () => `http://127.0.0.1:${originPort}`;

test("compose sends a GET and records a flow", async () => {
  const flow = await proxy.compose({ method: "GET", url: `${base()}/composed` });
  expect(flow.response?.statusCode).toBe(200);
  expect(flow.response?.body?.toString()).toContain("/composed");
  expect(proxy.store.list().some((f) => f.id === flow.id)).toBe(true);
});

test("compose sends a POST body", async () => {
  const flow = await proxy.compose({ method: "POST", url: `${base()}/p`, body: "payload-1" });
  const data = JSON.parse(flow.response!.body!.toString());
  expect(data.method).toBe("POST");
  expect(data.body).toBe("payload-1");
});

test("environment variables are substituted into url/headers/body", async () => {
  proxy.saveWorkspace({
    activeEnv: "dev",
    environments: { dev: { HOST: `127.0.0.1:${originPort}`, TOKEN: "secret-token" } },
    collections: [],
  });
  const flow = await proxy.compose({
    method: "POST",
    url: "http://{{HOST}}/env",
    headers: [["authorization", "Bearer {{TOKEN}}"]],
    body: "{{TOKEN}}",
  });
  const data = JSON.parse(flow.response!.body!.toString());
  expect(data.auth).toBe("Bearer secret-token");
  expect(data.body).toBe("secret-token");
});

test("cookie jar carries Set-Cookie into subsequent composed requests", async () => {
  proxy.jar.clear();
  await proxy.compose({ url: `${base()}/set-cookie` }, { useEnv: false });
  const flow = await proxy.compose({ url: `${base()}/needs-cookie` }, { useEnv: false });
  const data = JSON.parse(flow.response!.body!.toString());
  expect(data.cookie).toContain("sid=abc123");
});

test("parseCurl handles method, headers, and data", () => {
  const spec = parseCurl(`curl -X POST 'https://api.example.com/v1/items' -H 'Authorization: Bearer xyz' -H 'Content-Type: application/json' --data '{"a":1}'`);
  expect(spec.method).toBe("POST");
  expect(spec.url).toBe("https://api.example.com/v1/items");
  expect(spec.headers).toContainEqual(["Authorization", "Bearer xyz"]);
  expect(spec.body).toBe('{"a":1}');
});

test("parseCurl infers POST when data is present", () => {
  const spec = parseCurl(`curl https://x.test/y -d hello`);
  expect(spec.method).toBe("POST");
  expect(spec.body).toBe("hello");
});

test("generateCode emits curl, fetch, and python", () => {
  const f = new Flow({ address: "x", port: 0, tls: true }, 0);
  f.request.scheme = "https";
  f.request.host = "api.example.com";
  f.request.port = 443;
  f.request.method = "POST";
  f.request.path = "/v1/items";
  f.request.headers.set("content-type", "application/json");
  f.request.body = Buffer.from('{"a":1}');

  const curl = generateCode(f, "curl");
  expect(curl).toContain("curl -X POST");
  expect(curl).toContain("https://api.example.com/v1/items");
  expect(curl).toContain("content-type: application/json");

  const fetchCode = generateCode(f, "fetch");
  expect(fetchCode).toContain("await fetch(");
  expect(fetchCode).toContain('"method": "POST"');

  const py = generateCode(f, "python");
  expect(py).toContain("import requests");
  expect(py).toContain("requests.request");
});

test("compose round-trips through the cURL import → compose path", async () => {
  const spec = parseCurl(`curl -X POST ${base()}/from-curl --data 'curlbody'`);
  const flow = await proxy.compose(spec, { useEnv: false });
  const data = JSON.parse(flow.response!.body!.toString());
  expect(data.method).toBe("POST");
  expect(data.body).toBe("curlbody");
});
