//! Proxy configuration.

/// Configuration for the MITM proxy engine.
#[derive(Debug, Clone)]
pub struct ProxyConfig {
    /// Listen address (default: 127.0.0.1).
    pub host: String,
    /// Proxy listen port (0 = OS-assigned).
    pub port: u16,
    /// Web inspector port (0 = OS-assigned, None = no inspector).
    pub web_port: Option<u16>,
    /// Whether to decrypt HTTPS traffic (MITM).
    pub decrypt_https: bool,
    /// Optional upstream proxy URL (http://host:port or socks5://host:port).
    pub upstream: Option<String>,
    /// Hosts that should never be decrypted (tunnel mode).
    pub ignore_hosts: Vec<String>,
    /// Hosts that are allowed for decryption (allow-list; empty = all).
    pub allow_hosts: Vec<String>,
    /// Data directory for CA certs and sessions.
    pub data_dir: String,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 8888,
            web_port: Some(8889),
            decrypt_https: true,
            upstream: None,
            ignore_hosts: vec![],
            allow_hosts: vec![],
            data_dir: dirs_data_dir(),
        }
    }
}

fn dirs_data_dir() -> String {
    // Cross-platform data directory: ~/.cnproxy
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    format!("{}/.cnproxy", home)
}