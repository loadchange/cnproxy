# cnproxy

**Chipper Nut Proxy** · 奇克

> A modern HTTP / HTTPS / WebSocket debugging & MITM proxy — built on Node.js + TypeScript.

Capture, inspect, rewrite and mock network traffic with a live web inspector.

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
- **HTTP proxy *and* SOCKS5/SOCKS4** on the same port (auto-detected), both feeding the same
  capture/decrypt/rules pipeline.
- **API testing** — request **composer**, environment variables, **cookie jar**, **cURL
  import/export**, **code generation** (curl/fetch/python), and a persisted workspace of
  collections + environments.
- **Sessions / history** — save, list and reload captures to disk (survives restart);
  **HAR import/export**; a request/response **diff** tool; per-stage **timing**
  (DNS / connect / TLS / TTFB).
- **Breakpoints** on requests *and* responses (resume / kill / edit), plus live **WebSocket
  message injection**.
- **Live web inspector** — real-time flow list, request/response headers & bodies, JSON
  pretty-printing, image preview, WebSocket message timeline (streamed over a WebSocket).
- **Transparent decompression** — `gzip`, `br` and `deflate` responses are captured
  **decoded**, so the inspector, body filters (`~b`/`~bs`) and `resReplace` all operate on
  real text. Untouched flows are relayed byte-for-byte; rewritten ones are re-sent decoded.
- **Streaming relay** — Server-Sent Events, chunked and large (> 1 MB) responses are forwarded
  incrementally (not buffered), with a bounded copy teed into the inspector.
- **Rule engine** — redirect hosts, rewrite URLs, mock responses, inject headers, replace body
  text, map local files, block, delay, and more.
- **Filter language** — `~u`, `~m`, `~h`, `~c`, `&`, `|`, `!`, grouping.
- **Replay** any captured request with one click.
- **HAR 1.2 export** — download a captured session, openable in any HAR-compatible viewer
  (toolbar **Export HAR** or `GET /api/export/har`).
- **Addon/hook API** — extend the proxy programmatically (`requestheaders`, `request`,
  `response`, `websocketMessage`, …).
- **Upstream proxy chaining**, allow/ignore host lists, body-size caps.
- **Zero build step** — runs straight from TypeScript via `tsx`.

## Install

Requires [Node.js](https://nodejs.org) ≥ 20.

```bash
# global
npm install -g cnproxy
cnproxy --help

# or run from a clone
npm install
npm start
```

## Quick start

```bash
cnproxy                       # proxy on :8888, inspector on http://127.0.0.1:8889
```

1. Point your client at the proxy:
   `export HTTP_PROXY=http://127.0.0.1:8888 HTTPS_PROXY=http://127.0.0.1:8888`
   (or set it in your OS / browser network settings).
2. To decrypt HTTPS, trust the root CA once:
   - open <http://127.0.0.1:8889/ca.crt> while running, or
     `cnproxy ca --export ~/cnproxy-ca.crt`
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

## Cross-platform builds

cnproxy compiles to a **single self-contained executable** (via esbuild + @yao-pkg/pkg, with
the web UI embedded) that runs without Node.js installed:

```bash
npm run build              # bundle + native binary for the current platform → dist/
```

The build pipeline bundles all source into a single CJS file with esbuild, then compiles it
with `@yao-pkg/pkg` for targets: macOS (arm64/x64), Linux (x64/arm64), Windows (x64). The
web inspector assets are embedded in the bundle, so the same executable is the whole product
on each desktop/server platform.

**Mobile / other devices:** point the device's Wi-Fi / system proxy (or SOCKS5) at the machine
running cnproxy, trust the CA once, and open the (responsive) inspector at
`http://<host>:8889` from the device's browser. A dedicated native mobile app (on-device
VPN capture) is a separate effort — see `docs/ROADMAP.md`.

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
| `dir://<localdir>`  | request | map a path prefix to a local directory (map-local)      |
| `highlight://<color>` | request | tag matching flows with a color in the inspector      |

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
  web/                  node:http + ws inspector (server.ts) + single-page UI (ui/)
  options.ts            reactive, typed options
bin/cnproxy.ts          CLI
```

The proxy front is a raw `net.Server`: every connection is *peeked* (its request head is
parsed without being consumed) and then routed — `CONNECT` to a TLS terminator that mints a
host cert via SNI, `Upgrade: websocket` to a raw relay, and everything else bridged into an
internal `http.Server` that runs the flow pipeline. This low-level approach (rather than
node:http's `connect`/`upgrade` events) is what lets the same code intercept HTTP, HTTPS,
ws and wss uniformly and reliably.

## Development

```bash
npm install
npm run dev          # watch mode
npm run typecheck    # tsc --noEmit
npm test             # full functional suite (rules, filter, encoding, streaming,
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
| `POST /api/flows/:id/ws-send`  | inject a WebSocket message into a live flow          |
| `GET  /api/flows/:id/code?lang=`| generate a code snippet (curl / fetch / python)     |
| `POST /api/flows/replay-batch` | replay many flows at once                            |
| `GET  /api/diff?a=&b=`         | line diff of two flows' request/response             |
| `GET/POST /api/options`        | read / patch runtime options (rules, intercept, …)   |
| `GET  /api/stats`              | totals (flows, rules, intercept state)               |
| `GET  /api/export/har`         | download the session as HAR 1.2                      |
| `POST /api/import/har`         | import a HAR log into the store                      |
| `GET  /api/sessions` · `POST /api/sessions/save` · `POST /api/sessions/load` | session history |
| `POST /api/compose`            | compose & send an arbitrary request (API testing)    |
| `POST /api/curl/parse`         | parse a cURL command into a request spec             |
| `GET/PUT /api/workspace`       | collections + environments                           |
| `POST /api/clear`              | empty the flow store                                 |
| `GET  /ca.crt`                 | download the root CA certificate                     |

## License

MIT © LoadChange