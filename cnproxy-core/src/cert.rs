//! Certificate authority for on-the-fly TLS certificate generation.
//!
//! Provides:
//! - Root CA keypair (ECDSA P-256) generation and PEM persistence
//! - Per-host leaf certificates with proper SAN entries
//! - LRU cache keyed by wildcarded hostname (foo.example.com -> *.example.com)
//! - Shared leaf key pair across all hosts for fast minting

use std::net::IpAddr;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use lru::LruCache;
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, Ia5String, IsCa,
    KeyPair, KeyUsagePurpose, SanType,
};
use time::OffsetDateTime;

/// Root CA validity: 10 years.
const CA_VALIDITY_DAYS: i64 = 3650;
/// Leaf cert validity: 397 days (under the 398-day browser cap).
const LEAF_VALIDITY_DAYS: i64 = 397;
/// LRU cache capacity.
const CACHE_CAPACITY: usize = 1024;

/// Manages the root CA and generates per-host leaf certificates.
///
/// The CA uses ECDSA P-256 (fast key generation, compact signatures).
/// A single leaf key pair is generated once and reused across all hosts;
/// per-host certificates are signed on demand and cached by wildcard key.
pub struct CertificateAuthority {
    /// Reconstructed CA certificate (only used as issuer reference for `signed_by`).
    ca_cert: rcgen::Certificate,
    /// CA private key.
    ca_key: KeyPair,
    /// Original CA cert PEM (for trust store and cert chaining).
    ca_cert_pem: String,
    /// Shared leaf key pair.
    leaf_key: KeyPair,
    /// Leaf key PEM (returned to callers for TLS configuration).
    leaf_key_pem: String,
    /// LRU cache: wildcard hostname -> leaf cert chain PEM (leaf + CA).
    cache: Mutex<LruCache<String, String>>,
    /// Path to root CA certificate file.
    root_cert_path: PathBuf,
}

impl CertificateAuthority {
    /// Initialize or load an existing CA from the data directory.
    ///
    /// Creates the cert directory if it doesn't exist. Loads existing CA and
    /// leaf key from disk, or generates new ones on first run.
    pub fn init(data_dir: &str) -> Result<Self, String> {
        let cert_dir = Path::new(data_dir).join("certs");
        std::fs::create_dir_all(&cert_dir).map_err(|e| e.to_string())?;

        let cert_path = cert_dir.join("ca.crt");
        let key_path = cert_dir.join("ca.key");
        let leaf_key_path = cert_dir.join("leaf.key");

        // Load or generate CA key pair and cert PEM.
        let (ca_cert_pem, ca_key) = if cert_path.exists() && key_path.exists() {
            let pem = std::fs::read_to_string(&cert_path).map_err(|e| e.to_string())?;
            let key_pem = std::fs::read_to_string(&key_path).map_err(|e| e.to_string())?;
            let key = KeyPair::from_pem(&key_pem).map_err(|e| e.to_string())?;
            (pem, key)
        } else {
            let key = KeyPair::generate().map_err(|e| e.to_string())?;
            let params = Self::build_ca_params();
            let cert = params.self_signed(&key).map_err(|e| e.to_string())?;
            let pem = cert.pem();
            let key_pem = key.serialize_pem();
            std::fs::write(&cert_path, &pem).map_err(|e| e.to_string())?;
            std::fs::write(&key_path, &key_pem).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))
                    .map_err(|e| e.to_string())?;
            }
            (pem, key)
        };

        // Reconstruct CA certificate object (for use as issuer in signed_by).
        // Only the DN, key_identifier_method, and key_usages matter for leaf signing.
        // The reconstructed cert's DER differs from the on-disk PEM (different serial/dates),
        // but signed_by never uses the issuer's DER — only the extracted params + key.
        let ca_cert = Self::build_ca_params()
            .self_signed(&ca_key)
            .map_err(|e| e.to_string())?;

        // Load or generate leaf key (shared across all hosts for performance).
        let (leaf_key, leaf_key_pem) = if leaf_key_path.exists() {
            let pem = std::fs::read_to_string(&leaf_key_path).map_err(|e| e.to_string())?;
            let key = KeyPair::from_pem(&pem).map_err(|e| e.to_string())?;
            (key, pem)
        } else {
            let key = KeyPair::generate().map_err(|e| e.to_string())?;
            let pem = key.serialize_pem();
            std::fs::write(&leaf_key_path, &pem).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(
                    &leaf_key_path,
                    std::fs::Permissions::from_mode(0o600),
                )
                .map_err(|e| e.to_string())?;
            }
            (key, pem)
        };

        Ok(Self {
            ca_cert,
            ca_key,
            ca_cert_pem,
            leaf_key,
            leaf_key_pem,
            cache: Mutex::new(LruCache::new(
                NonZeroUsize::new(CACHE_CAPACITY).unwrap(),
            )),
            root_cert_path: cert_path,
        })
    }

    /// Build the CA certificate parameters.
    ///
    /// Must produce identical DN/key-usages every time so that a reloaded CA
    /// can serve as issuer for leaf certs that chain back to the on-disk PEM.
    fn build_ca_params() -> CertificateParams {
        let now = OffsetDateTime::now_utc();
        let mut params = CertificateParams::default();

        // Use a fixed CN (no year) so reloads always match the on-disk cert's subject DN.
        params.distinguished_name = rcgen::DistinguishedName::new();
        params
            .distinguished_name
            .push(DnType::CommonName, "CNProxy Root CA");
        params
            .distinguished_name
            .push(DnType::OrganizationName, "CNProxy");
        params
            .distinguished_name
            .push(DnType::CountryName, "CN");

        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![
            KeyUsagePurpose::KeyCertSign,
            KeyUsagePurpose::CrlSign,
            KeyUsagePurpose::DigitalSignature,
        ];

        params.not_before = now - time::Duration::days(1);
        params.not_after = now + time::Duration::days(CA_VALIDITY_DAYS);

        params
    }

    /// Get the path to the root CA certificate file.
    pub fn root_cert_path(&self) -> &Path {
        &self.root_cert_path
    }

    /// Get the root CA certificate as PEM.
    pub fn root_cert_pem(&self) -> &str {
        &self.ca_cert_pem
    }

    /// Get the leaf key PEM (shared across all hosts).
    pub fn leaf_key_pem(&self) -> &str {
        &self.leaf_key_pem
    }

    /// Generate (or retrieve from cache) a leaf certificate for a hostname.
    ///
    /// Returns `(cert_chain_pem, key_pem)` where cert_chain_pem contains the
    /// leaf certificate followed by the CA certificate (for proper chaining).
    pub fn cert_for_host(&self, hostname: &str) -> Result<(String, String), String> {
        let wk = wildcard_key(hostname);

        // Check cache.
        {
            let mut cache = self.cache.lock().map_err(|e| e.to_string())?;
            if let Some(chain_pem) = cache.get(&wk) {
                return Ok((chain_pem.clone(), self.leaf_key_pem.clone()));
            }
        }

        // Mint a fresh leaf certificate.
        let leaf_pem = self.mint_leaf(hostname, &wk)?;
        let chain_pem = format!("{}{}", leaf_pem, self.ca_cert_pem);

        // Insert into cache.
        {
            let mut cache = self.cache.lock().map_err(|e| e.to_string())?;
            cache.put(wk, chain_pem.clone());
        }

        Ok((chain_pem, self.leaf_key_pem.clone()))
    }

    /// Mint a leaf certificate for a specific host, signed by the CA.
    fn mint_leaf(&self, hostname: &str, wildcard: &str) -> Result<String, String> {
        let now = OffsetDateTime::now_utc();

        let mut params = CertificateParams::default();

        // Subject
        params.distinguished_name = rcgen::DistinguishedName::new();
        params
            .distinguished_name
            .push(DnType::CommonName, wildcard);

        // Validity (1 day back-dated to avoid clock-skew rejections)
        params.not_before = now - time::Duration::days(1);
        params.not_after = now + time::Duration::days(LEAF_VALIDITY_DAYS);

        // Key usage
        params.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyEncipherment,
        ];
        params.extended_key_usages = vec![
            ExtendedKeyUsagePurpose::ServerAuth,
            ExtendedKeyUsagePurpose::ClientAuth,
        ];

        // Authority Key Identifier (links leaf to CA)
        params.use_authority_key_identifier_extension = true;

        // Subject Alternative Names
        if let Ok(ip) = hostname.parse::<IpAddr>() {
            params.subject_alt_names.push(SanType::IpAddress(ip));
        } else {
            // Primary SAN: the wildcard (or apex) name
            params.subject_alt_names.push(SanType::DnsName(
                Ia5String::try_from(wildcard.to_string()).map_err(|e| e.to_string())?,
            ));
            // If wildcard, also add the bare domain (*.example.com + example.com)
            if wildcard.starts_with("*.") {
                let bare = &wildcard[2..];
                params.subject_alt_names.push(SanType::DnsName(
                    Ia5String::try_from(bare.to_string()).map_err(|e| e.to_string())?,
                ));
            }
            // If the original hostname differs from the wildcard, add it too
            if wildcard != hostname {
                params.subject_alt_names.push(SanType::DnsName(
                    Ia5String::try_from(hostname.to_string()).map_err(|e| e.to_string())?,
                ));
            }
        }

        // Sign with CA
        let cert = params
            .signed_by(&self.leaf_key, &self.ca_cert, &self.ca_key)
            .map_err(|e| e.to_string())?;

        Ok(cert.pem())
    }
}

/// Collapse a hostname to its wildcard form for cache sharing.
///
/// - IP addresses are returned as-is.
/// - Hostnames with 3+ labels collapse: `foo.example.com` -> `*.example.com`
/// - Apex domains (2 labels) are returned as-is: `example.com` -> `example.com`
/// - Single-label names are returned as-is: `localhost` -> `localhost`
pub fn wildcard_key(host: &str) -> String {
    if host.parse::<IpAddr>().is_ok() {
        return host.to_string();
    }
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() >= 3 {
        format!("*.{}", parts[1..].join("."))
    } else {
        host.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a unique temp directory for test isolation.
    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cnproxy-test-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_wildcard_key_subdomain() {
        assert_eq!(wildcard_key("foo.example.com"), "*.example.com");
        assert_eq!(wildcard_key("a.b.example.com"), "*.b.example.com");
    }

    #[test]
    fn test_wildcard_key_apex() {
        assert_eq!(wildcard_key("example.com"), "example.com");
    }

    #[test]
    fn test_wildcard_key_single_label() {
        assert_eq!(wildcard_key("localhost"), "localhost");
    }

    #[test]
    fn test_wildcard_key_ipv4() {
        assert_eq!(wildcard_key("127.0.0.1"), "127.0.0.1");
    }

    #[test]
    fn test_wildcard_key_ipv6() {
        assert_eq!(wildcard_key("::1"), "::1");
    }

    #[test]
    fn test_generate_ca() {
        let dir = tmp_dir("gen-ca");
        let ca = CertificateAuthority::init(dir.to_str().unwrap()).unwrap();

        // PEM outputs exist and look correct.
        assert!(ca.root_cert_pem().starts_with("-----BEGIN CERTIFICATE-----"));
        assert!(ca.leaf_key_pem().starts_with("-----BEGIN PRIVATE KEY-----"));

        // Files were persisted.
        assert!(ca.root_cert_path().exists());
        assert!(dir.join("certs/ca.key").exists());
        assert!(dir.join("certs/leaf.key").exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_load_ca_from_disk() {
        let dir = tmp_dir("load-ca");

        // First init generates.
        let ca1 = CertificateAuthority::init(dir.to_str().unwrap()).unwrap();
        let cert_pem = ca1.root_cert_pem().to_string();
        let leaf_pem = ca1.leaf_key_pem().to_string();
        drop(ca1);

        // Second init loads from disk.
        let ca2 = CertificateAuthority::init(dir.to_str().unwrap()).unwrap();
        assert_eq!(ca2.root_cert_pem(), cert_pem, "CA cert PEM must survive reload");
        assert_eq!(ca2.leaf_key_pem(), leaf_pem, "leaf key PEM must survive reload");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_cert_for_host_basic() {
        let dir = tmp_dir("host-basic");
        let ca = CertificateAuthority::init(dir.to_str().unwrap()).unwrap();

        let (chain_pem, key_pem) = ca.cert_for_host("example.com").unwrap();
        assert!(chain_pem.contains("-----BEGIN CERTIFICATE-----"));
        assert!(key_pem.starts_with("-----BEGIN PRIVATE KEY-----"));

        // Chain should contain two certificates: leaf + CA.
        let cert_count = chain_pem.matches("-----BEGIN CERTIFICATE-----").count();
        assert_eq!(cert_count, 2, "chain must have leaf + CA");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_cert_for_host_wildcard_cache() {
        let dir = tmp_dir("wildcard-cache");
        let ca = CertificateAuthority::init(dir.to_str().unwrap()).unwrap();

        let (chain1, _) = ca.cert_for_host("foo.example.com").unwrap();
        let (chain2, _) = ca.cert_for_host("bar.example.com").unwrap();

        // Both map to *.example.com, so they must return the same cached cert.
        assert_eq!(chain1, chain2);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_cert_for_host_different_domains() {
        let dir = tmp_dir("diff-domains");
        let ca = CertificateAuthority::init(dir.to_str().unwrap()).unwrap();

        let (chain1, _) = ca.cert_for_host("example.com").unwrap();
        let (chain2, _) = ca.cert_for_host("other.org").unwrap();

        // Different domains must produce different certs.
        assert_ne!(chain1, chain2);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_cert_for_ip() {
        let dir = tmp_dir("ip");
        let ca = CertificateAuthority::init(dir.to_str().unwrap()).unwrap();

        let (chain_v4, _) = ca.cert_for_host("127.0.0.1").unwrap();
        assert!(chain_v4.contains("-----BEGIN CERTIFICATE-----"));

        let (chain_v6, _) = ca.cert_for_host("::1").unwrap();
        assert!(chain_v6.contains("-----BEGIN CERTIFICATE-----"));

        // IPv4 and IPv6 certs must differ.
        assert_ne!(chain_v4, chain_v6);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_cache_hit_returns_same_result() {
        let dir = tmp_dir("cache-hit");
        let ca = CertificateAuthority::init(dir.to_str().unwrap()).unwrap();

        let (chain1, key1) = ca.cert_for_host("test.example.com").unwrap();
        let (chain2, key2) = ca.cert_for_host("test.example.com").unwrap();

        assert_eq!(chain1, chain2);
        assert_eq!(key1, key2);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_leaf_cert_after_ca_reload() {
        let dir = tmp_dir("reload-leaf");

        // Generate CA.
        let ca1 = CertificateAuthority::init(dir.to_str().unwrap()).unwrap();
        let (chain1, key1) = ca1.cert_for_host("example.com").unwrap();
        drop(ca1);

        // Reload CA and generate leaf for the same host.
        let ca2 = CertificateAuthority::init(dir.to_str().unwrap()).unwrap();
        let (chain2, key2) = ca2.cert_for_host("example.com").unwrap();

        // Key PEM must be the same (same leaf key loaded from disk).
        assert_eq!(key1, key2);

        // Both chains must contain valid PEM with 2 certs.
        assert_eq!(chain1.matches("-----BEGIN CERTIFICATE-----").count(), 2);
        assert_eq!(chain2.matches("-----BEGIN CERTIFICATE-----").count(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_cert_for_localhost() {
        let dir = tmp_dir("localhost");
        let ca = CertificateAuthority::init(dir.to_str().unwrap()).unwrap();

        let (chain, _) = ca.cert_for_host("localhost").unwrap();
        assert_eq!(chain.matches("-----BEGIN CERTIFICATE-----").count(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }
}
