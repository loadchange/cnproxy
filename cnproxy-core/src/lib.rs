//! # cnproxy-core
//!
//! MITM proxy engine core, designed to be shared across platforms:
//! - **Desktop**: Tauri app (via FFI or sidecar stdin/stdout protocol)
//! - **iOS/iPadOS**: Static library linked into a `NEPacketTunnelProvider` Network Extension
//! - **Android**: Dynamic library loaded via JNI from a `VpnService`
//!
//! ## Architecture
//!
//! The engine is structured as a pipeline:
//!
//! ```text
//! Inbound socket → TLS unwrap → MITM handler → Upstream connection → Response relay
//! ```
//!
//! Each connection is handled by a tokio task. The `MitmProxy` struct owns a
//! certificate authority (CA) for on-the-fly TLS certificate generation and a
//! `FlowStore` for traffic capture and inspection.
//!
//! ## Current status
//!
//! This is the crate skeleton. The actual MITM implementation will be ported
//! from the TypeScript engine in `src/core/proxy.ts`. See the design doc at
//! `cnproxy-core/DESIGN.md` (to be written).

mod cert;
mod config;
mod flow;
mod proxy;
mod store;

pub use cert::{wildcard_key, CertificateAuthority};
pub use config::ProxyConfig;
pub use flow::{Flow, FlowId, FlowSummary};
pub use proxy::MitmProxy;
pub use store::FlowStore;

/// Version of the engine, matching the crate version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");