/**
 * Programmatic usage example.
 *   bun run examples/programmatic.ts
 * then:
 *   curl -x http://127.0.0.1:8888 http://example.com/   (and -k for https)
 */

import { ProxyServer, WebInspector } from "../src/index.ts";

const proxy = new ProxyServer({
  port: 8888,
  webPort: 8889,
  // A couple of inline rules.
  rules: [
    `/api/ping mock://{"pong":true}`,
    `"~u google-analytics" block://`,
  ].join("\n"),
});

// Addons receive lifecycle hooks; implement any subset.
proxy.use({
  name: "tracer",
  request(flow) {
    flow.request.headers.set("x-traced-by", "cnproxy");
  },
  response(flow) {
    const ms = flow.duration ?? 0;
    console.log(`${flow.request.method} ${flow.request.url} → ${flow.response?.statusCode} (${ms}ms)`);
  },
  websocketMessage(flow, msg) {
    console.log(`ws ${msg.fromClient ? "▲" : "▼"} ${msg.content.toString("utf8").slice(0, 80)}`);
  },
});

await proxy.start();
new WebInspector(proxy).start();

console.log("\ncnproxy running. Proxy: 127.0.0.1:8888 — Inspector: http://127.0.0.1:8889");
console.log("Trust the CA from http://127.0.0.1:8889/ca.crt to decrypt HTTPS.\n");
