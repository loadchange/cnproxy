# cnproxy Roadmap — gap analysis vs Reqable

Reqable = **Fiddler + Charles + Postman**: an API-debugging proxy *and* an API-testing client,
deeply integrated. This doc tracks where cnproxy stands against that bar.

Legend: ✅ done · ⚠️ partial · ❌ missing

## Part 1 — API Debugging (capture / MITM proxy)

| Capability | Status | Notes / what's missing |
| --- | --- | --- |
| HTTP/1.x | ✅ | |
| HTTP/2 (ALPN, framing, multiplexing) | ✅ | Client-side h2 MITM: TLS ALPN selects `h2`→cleartext http2 server→flow pipeline. Upstream to origin is h1 for now (h2-upstream = future). Verified against real h2 sites. |
| HTTP/3 (QUIC) | ❌ | Low priority (Reqable lacks it too). |
| HTTP/HTTPS proxy mode (CONNECT) | ✅ | |
| SOCKS4/4a/5 inbound | ❌ | **Tier 1.** Only HTTP-proxy clients accepted. |
| TLS 1.1/1.2/1.3 | ✅ | node/Bun defaults. |
| IPv4 + IPv6 | ⚠️ | IPv6 literal parsing present; untested. |
| WebSocket capture | ✅ | Capture only — no message edit/breakpoint. |
| Upstream / secondary proxy | ✅ | |
| Composing API (build & send requests) | ❌ | See Part 2 (request composer). |
| Search & filter | ⚠️ | Filter language ✅; no app/protocol/data-type facets. |
| Rewrite: redirect / map-local / map-remote / modify | ⚠️ | map-local = single file (no dir); no GUI builder. |
| Breakpoint (request) | ✅ | resume / kill / edit. |
| Breakpoint (response) | ❌ | Only one pause point (pre-upstream); no response edit. |
| Scripting (Python) | ❌ | Have a JS addon API at code level, not in-app scripts. |
| Gateway (shield / suspend) | ⚠️ | block≈shield, delay≈partial. |
| Mirroring | ❌ | |
| Reverse-proxy mode (no CA trust) | ❌ | |
| Highlighting (color rules) | ❌ | |
| Replay — single | ✅ | |
| Replay — batch | ❌ | |
| Diff tool | ❌ | |
| History / persistence | ❌ | **Tier 1.** In-memory ring buffer only. |
| Traffic source (origin app) | ❌ | Needs OS pid↔socket mapping. |
| HAR export | ✅ | |
| HAR import / open | ❌ | |
| Custom SSL cert import / pinning / mTLS | ❌ | Only self-minted CA. |

## Part 2 — API Testing (Postman-like) — currently ~0%

| Capability | Status |
| --- | --- |
| Request composer (send arbitrary requests) | ❌ |
| API collections | ❌ |
| Import from Postman / Hoppscotch | ❌ |
| Environments (global + user variables) | ❌ |
| Batch editing (query / headers / forms) | ❌ |
| Pre/post-request scripting | ❌ |
| Code-snippet generation (cURL/Python/Java/Node) | ❌ |
| Authorization (API key / Basic / Bearer) | ❌ |
| Per-stage timing (DNS / connect / TLS / TTFB) | ❌ |
| Cookie jar management | ❌ |
| Request history | ❌ |
| cURL import / export | ❌ |

## Prioritized plan

**Tier 1 — transport correctness (real traffic breaks without these)**
1. ~~HTTP/2 termination (ALPN, stream→flow mapping)~~ ✅ done — origin h2 (upstream) still TODO
2. SOCKS5 inbound listener (alongside the HTTP front)
3. Disk persistence / session history

**Tier 2 — debugging depth**
4. Response-phase breakpoint + WebSocket message edit
5. Map-local (directory) + map-remote + rule-builder UI
6. HAR import, diff tool, highlighting rules, batch replay, per-stage timing, traffic source

**Tier 3 — the API-testing product**
7. Request composer → collections → environments → auth → code-gen → cURL import/export → cookie jar → timing

## What cnproxy already does well (baseline, tested)

MITM (auto CA + per-host certs, SNI), HTTP/1.1 + HTTPS + ws/wss capture, whistle-style rule
engine, mitmproxy-style filter language, request breakpoint (resume/kill/edit), gzip/br/deflate
decode, streaming relay (SSE/large), single replay, HAR export, addon/hook API, live web
inspector + REST control plane. 76 functional tests, `tsc` clean.
