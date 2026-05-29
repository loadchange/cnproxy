/**
 * Filter expression language — mitmproxy flowfilter parity. Unit-tests each atom and the
 * boolean combinators against synthetic flows.
 */
import { test, expect } from "bun:test";
import { compileFilter } from "../src/rules/filter.ts";
import { Flow, CnResponse } from "../src/flow/flow.ts";

function makeFlow(opts: {
  method?: string;
  scheme?: "http" | "https";
  host?: string;
  path?: string;
  status?: number;
  ctype?: string;
  reqBody?: string;
  resBody?: string;
  reqHeader?: [string, string];
  resHeader?: [string, string];
  type?: "http" | "websocket";
  marked?: boolean;
  error?: boolean;
}): Flow {
  const f = new Flow({ address: "127.0.0.1", port: 1234, tls: opts.scheme === "https" }, 0);
  f.type = opts.type ?? "http";
  f.marked = opts.marked ?? false;
  f.request.method = opts.method ?? "GET";
  f.request.scheme = opts.scheme ?? "http";
  f.request.host = opts.host ?? "example.com";
  f.request.headers.set("host", opts.host ?? "example.com");
  f.request.port = opts.scheme === "https" ? 443 : 80;
  f.request.path = opts.path ?? "/";
  if (opts.reqBody) f.request.body = Buffer.from(opts.reqBody);
  if (opts.reqHeader) f.request.headers.set(opts.reqHeader[0], opts.reqHeader[1]);
  if (opts.status !== undefined || opts.resBody || opts.ctype || opts.resHeader) {
    const r = new CnResponse();
    r.statusCode = opts.status ?? 200;
    if (opts.ctype) r.headers.set("content-type", opts.ctype);
    if (opts.resHeader) r.headers.set(opts.resHeader[0], opts.resHeader[1]);
    if (opts.resBody) r.body = Buffer.from(opts.resBody);
    f.response = r;
  }
  if (opts.error) f.error = { msg: "boom", timestamp: 0 } as any;
  return f;
}

const cases: [string, ReturnType<typeof makeFlow> extends never ? never : any, boolean][] = [
  ["~u /api", makeFlow({ path: "/api/users" }), true],
  ["~u /api", makeFlow({ path: "/home" }), false],
  ["~m POST", makeFlow({ method: "POST" }), true],
  ["~m POST", makeFlow({ method: "GET" }), false],
  ["~d example", makeFlow({ host: "example.com" }), true],
  ["~d google", makeFlow({ host: "example.com" }), false],
  ["~c 200", makeFlow({ status: 200 }), true],
  ["~c 5", makeFlow({ status: 503 }), true], // prefix match
  ["~c 4", makeFlow({ status: 200 }), false],
  ["~t json", makeFlow({ ctype: "application/json" }), true],
  ["~t json", makeFlow({ ctype: "text/html" }), false],
  ["~hq x-token", makeFlow({ reqHeader: ["x-token", "abc"] }), true],
  ["~hs x-served", makeFlow({ resHeader: ["x-served", "cn"] }), true],
  ["~bq secret", makeFlow({ reqBody: "the secret value" }), true],
  ["~bs welcome", makeFlow({ resBody: "welcome home" }), true],
  ["~b welcome", makeFlow({ resBody: "welcome home" }), true],
  ["~s", makeFlow({ status: 200 }), true],
  ["~s", makeFlow({}), false],
  ["~e", makeFlow({ error: true }), true],
  ["~e", makeFlow({}), false],
  ["~a", makeFlow({ path: "/app.js" }), true],
  ["~a", makeFlow({ path: "/api/data" }), false],
  ["~marked", makeFlow({ marked: true }), true],
  ["~websocket", makeFlow({ type: "websocket" }), true],
  ["~http", makeFlow({ type: "http" }), true],
  // combinators
  ["~m GET & ~u /api", makeFlow({ method: "GET", path: "/api" }), true],
  ["~m POST & ~u /api", makeFlow({ method: "GET", path: "/api" }), false],
  ["~m POST | ~u /api", makeFlow({ method: "GET", path: "/api" }), true],
  ["!~c 200", makeFlow({ status: 404 }), true],
  ["!~c 200", makeFlow({ status: 200 }), false],
  ["(~m GET | ~m POST) & ~u /api", makeFlow({ method: "POST", path: "/api" }), true],
  ["~m GET ~u /api", makeFlow({ method: "GET", path: "/api" }), true], // implicit AND
  ["/api", makeFlow({ path: "/api" }), true], // naked regex → ~u
];

for (const [expr, flow, expected] of cases) {
  test(`filter \`${expr}\` → ${expected}`, () => {
    expect(compileFilter(expr)(flow)).toBe(expected);
  });
}
