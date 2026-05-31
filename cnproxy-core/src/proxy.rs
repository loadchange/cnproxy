//! MITM proxy engine.
//!
//! This module will contain the core proxy logic: accepting connections, TLS
//! interception, HTTP/1.x and HTTP/2 decoding, request/response modification,
//! and upstream relaying.
//!
//! The API mirrors the TypeScript engine in `src/core/proxy.ts` but is built
//! on tokio + hyper + rustls for native performance and cross-compilation to
//! iOS (staticlib) and Android (cdylib).
//!
//! ## Status
//!
//! Skeleton only — the actual implementation is pending. The design will
//! follow these principles:
//!
//! 1. **Addon-style hooks** — like mitmproxy, every request/response passes
//!    through a callback chain that can inspect, modify, or block it.
//! 2. **Async throughout** — each connection is a tokio task; no blocking I/O.
//! 3. **HTTP/2 full path** — both client-facing (ALPN h2) and upstream (h2 to
//!    origin) will be supported, closing the gap from the TS engine.
//! 4. **WebSocket over HTTP/1 and HTTP/2** — RFC 8441 support for WS over h2.

use crate::cert::CertificateAuthority;
use crate::config::ProxyConfig;
use crate::flow::Flow;
use crate::store::FlowStore;

/// The main MITM proxy engine.
pub struct MitmProxy {
    config: ProxyConfig,
    ca: CertificateAuthority,
    store: FlowStore,
}

impl MitmProxy {
    /// Create a new proxy engine with the given configuration.
    pub fn new(config: ProxyConfig) -> Result<Self, String> {
        let ca = CertificateAuthority::init(&config.data_dir)?;
        Ok(Self {
            config,
            ca,
            store: FlowStore::new(),
        })
    }

    /// Start the proxy and return the actual bound ports.
    /// Returns (proxy_port, web_port).
    pub async fn start(&self) -> Result<(u16, Option<u16>), String> {
        // TODO: bind TCP listener on config.host:config.port
        // TODO: start HTTP/HTTPS MITM handler
        // TODO: start web inspector on config.web_port
        tracing::info!(
            "cnproxy-core: would listen on {}:{}",
            self.config.host,
            self.config.port,
        );
        Err("proxy engine not yet implemented — this is a skeleton crate".into())
    }

    /// Shut down the proxy gracefully.
    pub async fn shutdown(&self) {
        // TODO: close listeners, drain connections
    }

    /// Get a reference to the flow store.
    pub fn store(&self) -> &FlowStore {
        &self.store
    }

    /// Get the active proxy port (after start with port 0).
    pub fn proxy_port(&self) -> u16 {
        self.config.port
    }
}