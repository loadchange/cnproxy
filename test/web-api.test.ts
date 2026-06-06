/**
 * Web inspector REST API + live stream — the productization surface (Reqable-grade control plane).
 * Covers: flow list, detail (with decoded bodies), mark, replay, clear, options patch, stats,
 * CA download, static UI, and the WebSocket snapshot/add stream.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
// `WebSocket` is only a Node global from v21+; import from `ws` so the test runs on Node 20 too.
import { WebSocket } from "ws";
import { ProxyServer, WebInspector } from "../src/index.ts";
import { setLogLevel } from "../src/logger.ts";

setLogLevel("error");

/** Probe for a free port by briefly binding a throwaway server. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

let origin: http.Server;
let originPort = 0;
let proxy: ProxyServer;
let web: WebInspector;
let PROXY_PORT = 0;
let WEB_PORT = 0;
let PROXY = "";
let API = "";

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as any).port;

  // Probe for free ports so CI runners with quirky http.Server.address() still get a known port.
  PROXY_PORT = await freePort();
  WEB_PORT = await freePort();

  proxy = new ProxyServer({ port: PROXY_PORT, webPort: WEB_PORT });
  await proxy.start();
  web = new WebInspector(proxy);
  await web.start();

  PROXY = `http://127.0.0.1:${PROXY_PORT}`;
  API = `http://127.0.0.1:${WEB_PORT}`;

  // Generate one captured flow.
  await fetch(`http://127.0.0.1:${originPort}/seed`, { proxy: PROXY });
});

afterAll(async () => {
  web.stop();
  await proxy.stop();
  origin.close();
});

test("GET /api/flows lists captured flows", async () => {
  const flows = await (await fetch(`${API}/api/flows`)).json();
  expect(Array.isArray(flows)).toBe(true);
  expect(flows.length).toBeGreaterThanOrEqual(1);
  expect(flows[0]).toHaveProperty("url");
});

test("GET /api/flows/:id returns detail with base64-decoded body", async () => {
  const flows = await (await fetch(`${API}/api/flows`)).json();
  const id = flows.find((f: any) => f.path === "/seed").id;
  const detail = await (await fetch(`${API}/api/flows/${id}`)).json();
  expect(detail.response).toBeTruthy();
  const body = Buffer.from(detail.response.body, "base64").toString();
  expect(body).toContain("/seed");
});

test("POST /api/flows/:id/mark toggles the mark", async () => {
  const flows = await (await fetch(`${API}/api/flows`)).json();
  const id = flows[0].id;
  const r1 = await (await fetch(`${API}/api/flows/${id}/mark`, { method: "POST" })).json();
  expect(r1.marked).toBe(true);
  const r2 = await (await fetch(`${API}/api/flows/${id}/mark`, { method: "POST" })).json();
  expect(r2.marked).toBe(false);
});

test("POST /api/flows/:id/replay re-issues the request", async () => {
  const flows = await (await fetch(`${API}/api/flows`)).json();
  const id = flows.find((f: any) => f.path === "/seed").id;
  const r = await (await fetch(`${API}/api/flows/${id}/replay`, { method: "POST" })).json();
  expect(r.ok).toBe(true);
  expect(r.id).toBeTruthy();
});

test("GET/POST /api/options reads and patches options", async () => {
  const opts = await (await fetch(`${API}/api/options`)).json();
  expect(opts).toHaveProperty("decryptHttps");
  const patched = await (
    await fetch(`${API}/api/options`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intercept: "~m POST" }),
    })
  ).json();
  expect(patched.intercept).toBe("~m POST");
  // reset
  await fetch(`${API}/api/options`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intercept: "" }),
  });
});

test("GET /api/stats reports totals", async () => {
  const stats = await (await fetch(`${API}/api/stats`)).json();
  expect(stats).toHaveProperty("total");
  expect(stats).toHaveProperty("rules");
});

test("GET /ca.crt serves the root CA", async () => {
  const res = await fetch(`${API}/ca.crt`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("x509");
  expect(await res.text()).toContain("BEGIN CERTIFICATE");
});

test("GET / serves the inspector UI", async () => {
  const res = await fetch(`${API}/`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("<html");
});

test("WS /ws pushes a snapshot then live adds", async () => {
  const received: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${WEB_PORT}/ws`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws timeout")), 4000);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      received.push(msg);
      if (msg.type === "snapshot") {
        // trigger a new flow to exercise the live "add" event
        fetch(`http://127.0.0.1:${originPort}/live`, { proxy: PROXY }).catch(() => {});
      }
      if (msg.type === "add") {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ws error"));
    };
  });
  expect(received[0].type).toBe("snapshot");
  expect(received.some((m) => m.type === "add")).toBe(true);
});

test("POST /api/clear empties the store", async () => {
  await fetch(`${API}/api/clear`, { method: "POST" });
  const flows = await (await fetch(`${API}/api/flows`)).json();
  expect(flows.length).toBe(0);
});

test("DELETE /api/flows/:id removes a single flow", async () => {
  // Generate a flow
  await fetch(`http://127.0.0.1:${originPort}/delete-test`, { proxy: PROXY });
  const before = await (await fetch(`${API}/api/flows`)).json();
  expect(before.length).toBeGreaterThanOrEqual(1);
  const flowEntry = before.find((f: any) => f.path === "/delete-test");
  expect(flowEntry, `no /delete-test flow found; store has: ${JSON.stringify(before.map((f: any) => f.path))}`).toBeDefined();
  const id = flowEntry.id;

  // Delete it
  const res = await fetch(`${API}/api/flows/${id}`, { method: "DELETE" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.id).toBe(id);

  // Verify it's gone
  const after = await (await fetch(`${API}/api/flows`)).json();
  expect(after.find((f: any) => f.id === id)).toBeUndefined();

  // Delete non-existent → 404
  const res404 = await fetch(`${API}/api/flows/nonexistent-id`, { method: "DELETE" });
  expect(res404.status).toBe(404);
});

test("POST /api/import/postman imports a Postman collection", async () => {
  const collection = {
    item: [
      {
        request: {
          method: "GET",
          url: `http://127.0.0.1:${originPort}/postman-test`,
          header: [{ key: "X-Postman", value: "yes" }],
        },
      },
    ],
  };
  const res = await fetch(`${API}/api/import/postman`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(collection),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.flows).toBeGreaterThanOrEqual(1);
});
