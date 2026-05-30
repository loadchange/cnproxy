# cnproxy Roadmap

Feature status and known gaps.

Legend: ✅ done · ⚠️ partial · ❌ missing / out of scope

## Part 1 — API Debugging (capture / MITM proxy)

| Capability | Status | Notes |
| --- | --- | --- |
| HTTP/1.x | ✅ | |
| HTTP/2 (ALPN, framing, multiplexing) | ✅ | Client-side h2 MITM; upstream to origin currently h1. |
| HTTP/3 (QUIC) | ❌ | Out of scope. |
| HTTP/HTTPS proxy mode (CONNECT) | ✅ | |
| SOCKS4/4a/5 inbound | ✅ | First-byte detection → NO-AUTH negotiation → same pipeline. |
| TLS 1.1/1.2/1.3 | ✅ | Node.js defaults. |
| IPv4 + IPv6 | ✅ | literal parsing in CONNECT/SOCKS/authority. |
| WebSocket capture | ✅ | |
| WebSocket message inject/edit | ✅ | injectWs / POST /api/flows/:id/ws-send. |
| Upstream / secondary proxy | ✅ | |
| Composing API (build & send) | ✅ | See Part 2. |
| Search & filter | ✅ | flow filter language + client text filter. |
| Rewrite: redirect / map-local / map-remote / modify | ✅ | host/rewrite/redirect/mock/file/dir/req+resHeaders/req+resReplace/status/type/ua/referer. |
| Breakpoint (request) | ✅ | resume / kill / edit. |
| Breakpoint (response) | ✅ | interceptResponse — edit before relay (h1 + h2). |
| Scripting | ⚠️ | JS addon/hook API (code-level), not an in-app Python sandbox. |
| Gateway (shield / suspend) | ✅ | block:// + delay://. |
| Mirroring | ⚠️ | covered functionally by host:// to a mirror; no dedicated config. |
| Reverse-proxy mode | ❌ | not implemented. |
| Highlighting | ✅ | highlight://<color> → Flow.color. |
| Replay — single / batch | ✅ | replay + /api/flows/replay-batch. |
| Diff tool | ✅ | diffFlows + GET /api/diff. |
| History / persistence | ✅ | session save/load/list (.cnp JSONL), survives restart. |
| Traffic source (origin app) | ❌ | needs OS pid↔socket mapping (platform-specific). |
| HAR export / import | ✅ | flowsToHar / harToFlows + endpoints. |
| Custom SSL cert import / pinning / mTLS | ❌ | only self-minted CA. |

## Part 2 — API Testing

| Capability | Status | Notes |
| --- | --- | --- |
| Request composer | ✅ | composeRequest + POST /api/compose. |
| API collections | ✅ | workspace.json (collections). |
| Import from external tools | ❌ | format-specific importers not written (HAR import covers interchange). |
| Environments (global + user vars) | ✅ | {{var}} substitution from active env. |
| Batch editing | ⚠️ | spec-level editing; no dedicated bulk UI. |
| Pre/post-request scripting | ⚠️ | addon hooks; no per-request script slot. |
| Code-snippet generation | ✅ | curl / fetch / python. |
| Authorization (API key / Basic / Bearer) | ⚠️ | set via headers in the composer; no helper UI. |
| Per-stage timing (DNS/connect/TLS/TTFB) | ✅ | flow.timings. |
| Cookie jar | ✅ | CookieJar — Set-Cookie captured + replayed. |
| Request history | ✅ | composed requests are recorded flows + sessions. |
| cURL import / export | ✅ | parseCurl + generateCode("curl"). |

## Known engine gaps

Correctness / perf gaps surfaced by critical re-review, distinct from the "out of scope" list below:

- **HTTP/2 to origin** — client-side h2 works, but upstream is always HTTP/1.1. h2-only origins,
  gRPC, and server-push aren't proxied end-to-end.
- **Streaming on the h2 path** — SSE/large responses stream on HTTP/1 but are buffered on h2.
- **Request bodies are fully buffered** (h1 + h2) — no streaming uploads; large uploads sit in memory.
- **No upstream connection reuse / keep-alive** — a new socket per request.
- **WebSocket**: no `permessage-deflate` decode (compressed frames show as garbage), control
  frames (ping/pong/close) aren't surfaced, and RFC 8441 (WS over h2) is unhandled.
- **Request-body content-encoding** isn't decoded for capture/filter (only responses are).
- **Certificates**: upstream is always accepted (`rejectUnauthorized:false`) — no cert problem
  reporting, pinning detection, or mutual-TLS analysis.
- **Persistence is manual** (save/load); no auto-save / load-on-start "recording history".
- **map-local** prefix-strip only applies to `/`-leading path patterns, not `domain/path`.
- **SOCKS5 is NO-AUTH only**; IPv6 literals are parsed but untested against a real v6 origin.
- **Test realism**: HTTP/2 is tested against an HTTP/1 origin (never h2→h2); suites are mostly
  local happy-paths with no concurrency / malformed-input / load coverage.

## UI / productization

The web inspector wires the composer, sessions (save/load), HAR import, "Copy as"
code-gen, "Edit & resend", per-stage timing, highlight colors, response-phase breakpoint, an
inline paused-flow editor, and WebSocket injection. Verified in a real browser. Still missing:
a visual diff view, collections/environments management UI, auth helper forms, batch-edit,
and the overall polish of a native multi-platform app.

## Multi-platform delivery

- **Desktop / server (Win/Mac/Linux, x64+arm64)** ✅ — esbuild + @yao-pkg/pkg produces a single
  self-contained executable per platform with the web UI embedded (no Node.js needed at runtime).
  `npm run build`. Verified: the macOS binary runs from any directory, serves the embedded
  UI, and proxies.
- **Any device with a browser (incl. mobile)** ✅ via proxy-config — point the device's
  Wi-Fi/SOCKS proxy at the host and open the responsive inspector in the device browser.
- **Native desktop *window*** ⚠️ — currently a browser tab, not a Tauri/Electron-wrapped window.
  A thin webview wrapper is a feasible follow-up.
- **Native mobile apps (on-device VPN capture)** ❌ — a separate Swift/Kotlin codebase; not
  achievable inside a Node.js/TS project. Out of scope here.

## Structurally out of scope

A Flutter/C++ native multi-platform client and on-device mobile VPN-capture apps; an embedded
Python scripting runtime (cnproxy exposes a TypeScript addon API instead); HTTP/3 (QUIC);
OS-level traffic-source attribution; deep pinned-cert / mutual-TLS analysis.

## Test coverage

110 functional tests across 18 files: e2e, http2, socks, websocket, encoding, streaming, rules,
filter, map-local, intercept, intercept-response, persistence, import-timing, composer, diff,
har, web-api, passthrough. `tsc --noEmit` clean.