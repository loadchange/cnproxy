# cnproxy

> A modern HTTP / HTTPS / WebSocket debugging & MITM proxy for developers — built on [Bun](https://bun.sh) + TypeScript.

Capture, inspect, rewrite and mock network traffic with a live web inspector. cnproxy
takes the proven ideas of [whistle](https://github.com/avwo/whistle) and
[mitmproxy](https://github.com/mitmproxy/mitmproxy) (on-the-fly TLS interception, a flow
model, a rule engine, an addon/hook system, a filter language) and packages them into a
single fast, dependency-light Bun binary with a clean inspector UI inspired by
[Reqable](https://reqable.com).

```
┌──────────┐   HTTP/HTTPS/WS    ┌───────────────────────────┐      ┌──────────┐
│  client  │ ─────────────────▶ │          cnproxy          │ ───▶ │  origin  │
│ (browser,│   set HTTP(S)_PROXY│  • TLS MITM (auto certs)  │      │  server  │
│  app, …) │ ◀───────────────── │  • flow capture + rules   │ ◀─── │          │
└──────────┘                    │  • live web inspector     │      └──────────┘
                                └───────────────────────────┘
                                          ▲ ws stream
                                  ┌───────┴────────┐
                                  │  web inspector │  http://127.0.0.1:8889
                                  └────────────────┘
```

## Features

- **Full MITM** of HTTP/1.1, **HTTP/2**, HTTPS, WebSocket and secure WebSocket (wss), with an
  automatically generated root CA and per-host certificates minted on demand (SNI). HTTP/2 is
  negotiated via ALPN and decoded into the same flow model as HTTP/1.
- **Live web inspector** — real-time flow list, request/response headers & bodies, JSON
  pretty-printing, image preview, WebSocket message timeline (streamed over a WebSocket).
- **Transparent decompression** — `gzip`, `br` and `deflate` responses are captured
  **decoded**, so the inspector, body filters (`~b`/`~bs`) and `resReplace` all operate on
  real text. Untouched flows are relayed byte-for-byte; rewritten ones are re-sent decoded.
- **Streaming relay** — Server-Sent Events, chunked and large (>1 MB) responses are forwarded
  incrementally (not buffered), with a bounded copy teed into the inspector.
- **Rule engine** (whistle-style) — redirect hosts, rewrite URLs, mock responses, inject
  headers, replace body text, map local files, block, delay, and more.
- **Filter language** (mitmproxy-style) — `~u`, `~m`, `~h`, `~c`, `&`, `|`, `!`, grouping.
- **Breakpoints / interception** — pause matching flows and resume, kill, or **edit** the
  request/response before it continues.
- **Replay** any captured request with one click.
- **HAR 1.2 export** — download a captured session and open it in Chrome DevTools, Charles,
  Reqable, … (toolbar **Export HAR** or `GET /api/export/har`).
- **Addon/hook API** — extend the proxy programmatically (`requestheaders`, `request`,
  `response`, `websocketMessage`, …).
- **Upstream proxy chaining**, allow/ignore host lists, body-size caps.
- **Zero build step** — runs straight from TypeScript on Bun.

## Install

Requires [Bun](https://bun.sh) ≥ 1.1.

```bash
# global
bun add -g cnproxy
cnproxy --help

# or run from a clone
bun install
bun run bin/cnproxy.ts
```

## Quick start

```bash
cnproxy                       # proxy on :8888, inspector on http://127.0.0.1:8889
```

1. Point your client at the proxy: `export HTTP_PROXY=http://127.0.0.1:8888 HTTPS_PROXY=http://127.0.0.1:8888`
   (or set it in your OS/browser network settings).
2. To decrypt HTTPS, trust the root CA once:
   - open <http://127.0.0.1:8889/ca.crt> while running, or `cnproxy ca --export ~/cnproxy-ca.crt`
   - add it to your system / browser trust store.
3. Open the inspector at <http://127.0.0.1:8889> and watch traffic flow in.

### CLI

```
cnproxy [start] [options]      Start proxy + web inspector
cnproxy ca [--export <file>]   Show or export the root CA certificate

  -p, --port <n>        Proxy listen port            (default 8888)
  -w, --web-port <n>    Web inspector port           (default 8889)
      --host <addr>     Listen address               (default 127.0.0.1)
      --no-decrypt      Tunnel HTTPS without MITM decryption
  -u, --upstream <url>  Chain through an upstream proxy (http://host:port)
      --rules <file>    Load a rule file
      --ignore <hosts>  Comma-separated hosts to never decrypt
      --allow <hosts>   Comma-separated allow-list of hosts to decrypt
      --no-web          Do not start the web inspector
      --open            Open the inspector in your browser
  -q, --quiet           Errors only
  -v, --verbose         Debug logging
```

## Rules

One rule per line: `pattern operator://value`. Comments start with `#`.

**Patterns** — how a rule matches a flow:

| Pattern              | Matches                                                        |
| -------------------- | ------------------------------------------------------------- |
| `example.com`        | the host `example.com` and any subdomain                      |
| `*.cdn.example.com`  | glob against the host                                         |
| `^https?://.*\.js$`  | regex against the full URL (leading `^`)                      |
| `/api/users`         | substring against the full URL (contains a `/`)               |
| `"~m POST & ~u /pay"`| a full **filter expression** (quote it if it contains spaces) |

**Operators**:

| Operator            | Phase   | Effect                                                  |
| ------------------- | ------- | ------------------------------------------------------- |
| `host://ip[:port]`  | request | redirect the connection to another host/port           |
| `rewrite://<url>`   | request | rewrite scheme/host/path (bare `http(s)://…` works too) |
| `redirect://<url>`  | request | reply 302 to `<url>`                                     |
| `mock://<value>`    | request | synthesize a 200 response (`{json}`, text, or `file://…`)|
| `file://<path>`     | request | serve a local file as the response                      |
| `status://<code>`   | both    | force a status code                                     |
| `reqHeaders://…`    | request | set/delete request headers (`{json}` or `k: v` lines)   |
| `resHeaders://…`    | response| set/delete response headers                             |
| `reqType://<mime>` / `resType://<mime>` | — | set content-type                          |
| `ua://<string>` / `referer://<url>` | request | set User-Agent / Referer                    |
| `reqReplace://s/a/b/` | request | string-replace in the request body                    |
| `resReplace://s/a/b/` | response| string-replace in the response body                   |
| `delay://<ms>`      | request | add latency                                             |
| `block://`          | request | abort the connection                                    |

Example rule file (`examples/rules.cnp`):

```
# redirect a CDN to a local dev server
*.cdn.example.com host://127.0.0.1:3000

# mock an API endpoint
/api/profile mock://{"id":1,"name":"Mock User"}

# inject a debug header on all API calls
api.example.com reqHeaders://{"x-debug":"1"}

# kill tracking
"~u google-analytics" block://

# strip console.log from a vendored script
"~u vendor.js" resReplace://s/console.log/void 0/
```

## Filter language

Used for the inspector filter box, the `intercept` breakpoint, and `~…` rule patterns:

```
~u REGEX   url            ~d REGEX   host/domain     ~m REGEX   method
~c CODE    status (prefix)~t REGEX   content-type    ~a         asset
~h REGEX   any header     ~hq / ~hs  req/res header  ~b REGEX   any body
~bq / ~bs  req/res body   ~s  has response           ~e  has error
~marked    marked         ~websocket / ~http         flow type
!  not     &  and         |  or       ( … )  grouping (whitespace = and)
```

e.g. `~m POST & ~u /checkout & !~c 200`

## Programmatic API

```ts
import { ProxyServer, WebInspector } from "cnproxy";

const proxy = new ProxyServer({ port: 8888, rules: `/api/ping mock://{"pong":true}` });

// an addon: lifecycle hooks (any subset)
proxy.use({
  name: "logger",
  request(flow) {
    flow.request.headers.set("x-traced-by", "cnproxy");
  },
  response(flow) {
    console.log(flow.request.method, flow.request.url, "→", flow.response?.statusCode);
  },
  websocketMessage(flow, msg) {
    console.log("ws", msg.fromClient ? "▲" : "▼", msg.content.toString().slice(0, 80));
  },
});

await proxy.start();
new WebInspector(proxy).start();
```

## Architecture

```
src/
  cert/ca.ts            root CA + per-host leaf certs (node-forge, LRU, SNI)
  core/
    proxy.ts            orchestrator: raw net front, TLS terminator, internal http server
    head-parser.ts      peek/parse the request head off a raw socket
    request-handler.ts  flow pipeline: hooks → rules → intercept → upstream/mock → relay
    websocket.ts        raw ws/wss relay with frame capture
    upstream.ts         outbound request (direct or via upstream proxy)
    ws-frame.ts         incremental RFC 6455 frame parser (capture only)
  flow/                 Flow / Request / Response model + Headers + FlowStore (event bus)
  rules/                rule engine (engine.ts) + filter language (filter.ts)
  addons/               addon manager + hook contract
  web/                  Bun.serve inspector (server.ts) + single-page UI (ui/)
  options.ts            reactive, typed options
bin/cnproxy.ts          CLI
```

The proxy front is a raw `net.Server`: every connection is *peeked* (its request head is
parsed without being consumed) and then routed — `CONNECT` to a TLS terminator that mints a
host cert via SNI, `Upgrade: websocket` to a raw relay, and everything else bridged into an
internal `http.Server` that runs the flow pipeline. This low-level approach (rather than
node:http's `connect`/`upgrade` events) is what lets the same code intercept HTTP, HTTPS,
ws and wss uniformly and reliably on Bun.

## Development

```bash
bun install
bun run dev          # watch mode
bun run typecheck    # tsc --noEmit
bun test             # full functional suite (rules, filter, encoding, streaming,
                     #   web API, HAR, intercept, passthrough, e2e, websocket)
```

## Web API

The inspector also exposes a small REST control plane (served on the web port):

| Method & path                  | Purpose                                              |
| ------------------------------ | ---------------------------------------------------- |
| `GET  /api/flows`              | flow summaries                                       |
| `GET  /api/flows/:id`          | full flow detail (headers + base64 bodies)           |
| `POST /api/flows/:id/resume`   | resume a paused (intercepted) flow                   |
| `POST /api/flows/:id/kill`     | drop a paused flow's connection                      |
| `POST /api/flows/:id/edit`     | edit a paused flow's request/response before resume  |
| `POST /api/flows/:id/replay`   | re-issue the request as a new flow                   |
| `POST /api/flows/:id/mark`     | toggle the mark flag                                 |
| `GET/POST /api/options`        | read / patch runtime options (rules, intercept, …)   |
| `GET  /api/stats`              | totals (flows, rules, intercept state)               |
| `GET  /api/export/har`         | download the session as HAR 1.2                      |
| `POST /api/clear`              | empty the flow store                                 |
| `GET  /ca.crt`                 | download the root CA certificate                     |

## License

MIT © LoadChange
