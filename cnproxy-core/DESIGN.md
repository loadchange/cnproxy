# cnproxy-core — Rust MITM Engine

## Purpose

Cross-platform MITM proxy engine that serves as the core for:
- **Desktop** (via sidecar stdin/stdout protocol or FFI)
- **iOS/iPadOS** (static library linked into NEPacketTunnelProvider)
- **Android** (cdylib loaded via JNI from VpnService)

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    MitmProxy                         │
│  ┌─────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │  TCP    │  │  TLS     │  │  HTTP/1.x + H2     │  │
│  │ Listener│→ │ Intercept│→ │  Decode + Route    │  │
│  └─────────┘  └──────────┘  └────────────────────┘  │
│         │           │              │                 │
│         ▼           ▼              ▼                 │
│  ┌──────────────────────────────────────────────┐   │
│  │              Addon / Hook Chain              │   │
│  │  request → requestheaders → response → ...   │   │
│  └──────────────────────────────────────────────┘   │
│         │                                            │
│         ▼                                            │
│  ┌──────────────────────────────────────────────┐   │
│  │             FlowStore (shared)               │   │
│  │  HashMap<FlowId, Flow> + order preservation  │   │
│  └──────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

## Key Dependencies

| Crate | Purpose |
|-------|---------|
| tokio | Async runtime |
| hyper 1.x | HTTP/1.x and HTTP/2 client+server |
| hyper-util | Client legacy compat + server auto |
| tokio-rustls | TLS with rustls |
| rcgen | Certificate generation |
| h2 | HTTP/2 framing |
| tokio-tungstenite | WebSocket |

## Porting from TypeScript

The current TypeScript engine (`src/core/proxy.ts`) will be ported module by module:

1. **CertificateAuthority** — `src/cert/ca.ts` → `cert.rs` ✅ (skeleton done)
2. **ProxyServer** — `src/core/proxy.ts` → `proxy.rs` (pending)
3. **FlowStore** — `src/flow/store.ts` → `store.rs` ✅ (skeleton done)
4. **HTTP handler** — `src/core/http-handler.ts` → new `handler.rs`
5. **HTTP/2** — `src/core/h2-handler.ts` → new `h2.rs`
6. **WebSocket** — `src/core/ws-handler.ts` → new `ws.rs`
7. **Rules engine** — `src/rules/` → new `rules.rs`
8. **Web inspector API** — `src/web/server.ts` → new `inspector.rs`

## iOS Integration

Build as `staticlib` for arm64:
```bash
cargo build --target aarch64-apple-ios --lib
```

The Xcode project links the resulting `.a` into a Network Extension target
(NEPacketTunnelProvider). The Swift side calls into the Rust API via C FFI:

```rust
#[no_mangle]
pub extern "C" fn cnproxy_start(config_json: *const c_char) -> i32 { ... }
```

## Android Integration

Build as `cdylib` for arm64:
```bash
cargo build --target aarch64-linux-android --lib
```

JNI bindings via `jni` crate or manual C FFI from Kotlin.

## Milestones

- [x] Crate skeleton with types (Flow, Config, Store, Cert)
- [ ] HTTP/1.x MITM proxy (connect, intercept, relay)
- [ ] TLS interception with per-host cert generation
- [ ] HTTP/2 client-facing (ALPN h2 negotiation)
- [ ] HTTP/2 upstream (h2-to-origin)
- [ ] WebSocket capture + inject
- [ ] Rules engine (redirect, mock, rewrite, block)
- [ ] Web inspector REST + WebSocket API
- [ ] iOS Network Extension integration
- [ ] Android VpnService integration