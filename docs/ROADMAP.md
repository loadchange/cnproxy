# cnproxy Roadmap — parity vs Reqable

Reqable = **Fiddler + Charles + Postman**: an API-debugging proxy *and* an API-testing client.
This doc tracks cnproxy's coverage of that feature set.

Legend: ✅ done · ⚠️ partial · ❌ missing/out-of-scope

## Part 1 — API Debugging (capture / MITM proxy)

| Capability | Status | Notes |
| --- | --- | --- |
| HTTP/1.x | ✅ | |
| HTTP/2 (ALPN, framing, multiplexing) | ✅ | Client-side h2 MITM; upstream to origin currently h1. |
| HTTP/3 (QUIC) | ❌ | Out of scope (Reqable lacks it for debug too). |
| HTTP/HTTPS proxy mode (CONNECT) | ✅ | |
| SOCKS4/4a/5 inbound | ✅ | First-byte detection → NO-AUTH negotiation → same pipeline. |
| TLS 1.1/1.2/1.3 | ✅ | node/Bun defaults. |
| IPv4 + IPv6 | ✅ | literal parsing in CONNECT/SOCKS/authority. |
| WebSocket capture | ✅ | |
| WebSocket message inject/edit | ✅ | injectWs / POST /api/flows/:id/ws-send. |
| Upstream / secondary proxy | ✅ | |
| Composing API (build & send) | ✅ | See Part 2. |
| Search & filter | ✅ | mitmproxy-style filter language + client text filter. |
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

## Part 2 — API Testing (Postman-like)

| Capability | Status | Notes |
| --- | --- | --- |
| Request composer | ✅ | composeRequest + POST /api/compose. |
| API collections | ✅ | workspace.json (collections). |
| Import from Postman / Hoppscotch | ❌ | format-specific importers not written (HAR import covers interchange). |
| Environments (global + user vars) | ✅ | {{var}} substitution from active env. |
| Batch editing | ⚠️ | spec-level editing; no dedicated bulk UI. |
| Pre/post-request scripting | ⚠️ | addon hooks; no per-request script slot. |
| Code-snippet generation | ✅ | curl / fetch / python. |
| Authorization (API key / Basic / Bearer) | ⚠️ | set via headers in the composer; no helper UI. |
| Per-stage timing (DNS/connect/TLS/TTFB) | ✅ | flow.timings. |
| Cookie jar | ✅ | CookieJar — Set-Cookie captured + replayed. |
| Request history | ✅ | composed requests are recorded flows + sessions. |
| cURL import / export | ✅ | parseCurl + generateCode("curl"). |

## Structurally out of scope (not "features" of this codebase)

Native multi-platform desktop GUI and iOS/Android apps; an embedded Python scripting runtime
(cnproxy exposes a TypeScript addon API instead); HTTP/3 (QUIC); OS-level traffic-source
attribution; deep pinned-cert / mutual-TLS analysis. cnproxy ships a web inspector + REST/WS
control plane rather than a Flutter/C++ native client.

## Test coverage

106 functional tests across 18 files: e2e, http2, socks, websocket, encoding, streaming, rules,
filter, map-local, intercept, intercept-response, persistence, import-timing, composer, diff,
har, web-api, passthrough. `tsc --noEmit` clean.
