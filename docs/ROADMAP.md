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
| Reverse-proxy mode | ✅ | `--target` flag forwards all traffic to a fixed origin with MITM. |
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
| Import from external tools | ✅ | Postman v2.1 collection import; HAR import/export. |
| Environments (global + user vars) | ✅ | {{var}} substitution from active env. |
| Batch editing | ✅ | multi-select (shift/cmd-click), select-all, batch delete/replay, context menu batch ops. |
| Pre/post-request scripting | ⚠️ | addon hooks; no per-request script slot. |
| Code-snippet generation | ✅ | curl / fetch / python. |
| Authorization (API key / Basic / Bearer) | ✅ | auth helper UI (Bearer, Basic, API Key) in composer. |
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
- ~~**Request-body content-encoding**~~ — FIXED: request bodies are decoded for capture/filter.
- ~~**Certificates**: upstream is always accepted~~ — FIXED: configurable `--verify-certs` flag.
- ~~**Persistence is manual**~~ — FIXED: auto-save on blur/close, auto-load on connect.
- **map-local** prefix-strip only applies to `/`-leading path patterns, not `domain/path`.
- ~~**SOCKS5 is NO-AUTH only**~~ — FIXED: username/password auth (RFC 1929) supported.
- **Test realism**: HTTP/2 is tested against an HTTP/1 origin (never h2→h2); suites are mostly
  local happy-paths with no concurrency / malformed-input / load coverage.

## UI / productization

The web inspector is feature-complete: composer, sessions (auto-save/auto-load), HAR +
Postman import, "Copy as" code-gen, "Edit & resend", per-stage timing, highlight colors,
response-phase breakpoint, inline paused-flow editor, WebSocket injection, visual diff view,
collections/environments workspace, auth helper (Bearer/Basic/API Key), batch-edit
(multi-select + batch delete/replay), virtual scrolling (1k+ flows), hex view for binary
bodies, context menu, flow counter, mobile setup with QR code, and keyboard shortcuts.
Remaining: overall polish of the native multi-platform app experience.

## Multi-platform delivery

- **Desktop / server (Win/Mac/Linux, x64+arm64)** ✅ — esbuild + @yao-pkg/pkg produces a single
  self-contained executable per platform with the web UI embedded (no Node.js needed at runtime).
  `npm run build`. Verified: the macOS binary runs from any directory, serves the embedded
  UI, and proxies. @yao-pkg/pkg cross-compiles, so one CI runner emits all five CLI targets
  (`scripts/build-sidecar.mjs` maps Rust target-triples → pkg targets for Tauri's externalBin).
- **Any device with a browser (incl. mobile)** ✅ via proxy-config — point the device's
  Wi-Fi/SOCKS proxy at the host and open the responsive inspector in the device browser.
- **Native desktop *window*** ✅ — Tauri v2 desktop app (cnproxy-app) with sidecar integration,
  system tray, native menus, system proxy toggle, CA install/uninstall, autostart, window state
  persistence, and keyboard shortcuts. Phases 1-4 complete. CI builds signed-on-request `.dmg`
  (universal macOS), `.msi`/`.exe` (Windows), and `.AppImage`/`.deb` (Linux) on every `v*` tag
  via `.github/workflows/release.yml`; `ci.yml` runs typecheck + tests (Node 20/22 × 3 OSes),
  a binary smoke test, and a Tauri `cargo check` on every push/PR. Verified locally:
  the macOS `.app`/`.dmg` bundle builds and embeds the cnproxy sidecar.
- **Native mobile apps (on-device VPN capture)** 🏗️ — cnproxy-core Rust crate skeleton created
  (Flow types, Config, FlowStore, CertificateAuthority, MitmProxy API). Full engine port and
  iOS/Android integration pending.

## Desktop app (Tauri) — feature checklist

| Feature | Status |
|---------|--------|
| Sidecar auto-start with dynamic port | ✅ |
| System tray (Show/Proxy/CA/Quit) | ✅ |
| Native menu bar (File/Edit/View/Window/Help) | ✅ |
| Single instance (prevent multi-launch) | ✅ |
| Auto-start on login | ✅ |
| Window state persistence | ✅ |
| Keyboard shortcuts (⌘K/⌘F/⌘⇧P) | ✅ |
| macOS system proxy toggle | ✅ |
| Windows system proxy toggle | ✅ |
| Linux system proxy toggle | ✅ |
| CA certificate install/uninstall | ✅ |
| Auto-save session on close | ✅ |
| Virtual scrolling (1k+ flows) | ✅ |
| Right-click context menu | ✅ |
| Hex view for binary bodies | ✅ |
| Flow counter | ✅ |
| Postman collection import | ✅ |
| macOS code signing + notarization | 🏗️ (entitlements + CI secret hooks wired; needs Apple certs) |
| Tauri Updater | 🏗️ (endpoint configured) |
| Rust MITM engine (cnproxy-core) | 🏗️ (skeleton created) |

## Rust engine (cnproxy-core) — porting progress

The TypeScript engine is being ported to Rust for mobile support:

| Module | TS Source | Rust Target | Status |
|--------|----------|-------------|--------|
| CertificateAuthority | `src/cert/ca.ts` | `cert.rs` | 🏗️ skeleton |
| ProxyConfig | `src/options.ts` | `config.rs` | ✅ |
| Flow types | `src/flow/flow.ts` | `flow.rs` | ✅ |
| FlowStore | `src/flow/store.ts` | `store.rs` | ✅ |
| MitmProxy | `src/core/proxy.ts` | `proxy.rs` | 🏗️ skeleton |
| HTTP handler | `src/core/http-handler.ts` | `handler.rs` | ❌ |
| HTTP/2 | `src/core/h2-handler.ts` | `h2.rs` | ❌ |
| WebSocket | `src/core/ws-handler.ts` | `ws.rs` | ❌ |
| Rules engine | `src/rules/` | `rules.rs` | ❌ |
| Web inspector | `src/web/server.ts` | `inspector.rs` | ❌ |

## Structurally out of scope

A Flutter/C++ native multi-platform client and on-device mobile VPN-capture apps; an embedded
Python scripting runtime (cnproxy exposes a TypeScript addon API instead); HTTP/3 (QUIC);
OS-level traffic-source attribution; deep pinned-cert / mutual-TLS analysis.

## Test coverage

112 functional tests across 18 files: e2e, http2, socks, websocket, encoding, streaming, rules,
filter, map-local, intercept, intercept-response, persistence, import-timing, composer, diff,
har, web-api, passthrough. `tsc --noEmit` clean.