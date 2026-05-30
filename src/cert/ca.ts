/**
 * Certificate Authority for HTTPS MITM.
 *
 * A self-signed root CA is generated once and persisted to disk; users trust it.
 *  - One RSA "leaf" key pair is reused for every host (key generation is the expensive
 *    part; reusing it makes per-host cert minting near-instant).
 *  - Per-host leaf certificates are signed on demand with the correct SAN entries and
 *    cached as `tls.SecureContext` in an LRU keyed by the (wildcarded) host.
 *  - Leaf validity is kept under the 398-day browser cap.
 */

import forge from "node-forge";
import tls from "node:tls";
import net from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LRU } from "../util/lru.ts";
import { log } from "../logger.ts";

const pki = forge.pki;

export interface CAFiles {
  certPem: string;
  keyPem: string;
}

const ATTRS = (cn: string): forge.pki.CertificateField[] => [
  { name: "commonName", value: cn },
  { name: "countryName", value: "CN" },
  { shortName: "ST", value: "Zhejiang" },
  { name: "localityName", value: "Hangzhou" },
  { name: "organizationName", value: "CNProxy" },
  { shortName: "OU", value: "CNProxy Root CA" },
];

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

export class CertificateAuthority {
  private caCert!: forge.pki.Certificate;
  private caKey!: forge.pki.rsa.PrivateKey;
  private leafKeys!: forge.pki.rsa.KeyPair;
  private leafKeyPem!: string;
  private contexts = new LRU<string, tls.SecureContext>(1024);
  private certPemCache = new LRU<string, string>(1024);
  private readonly certDir: string;

  constructor(dataDir: string) {
    this.certDir = join(dataDir, "certs");
  }

  /** Path to the public root certificate (the file users install/trust). */
  get rootCertPath(): string {
    return join(this.certDir, "ca.crt");
  }

  get rootCertPem(): string {
    return pki.certificateToPem(this.caCert);
  }

  /** Load the CA from disk, generating + persisting it on first run. */
  async init(): Promise<void> {
    if (!existsSync(this.certDir)) mkdirSync(this.certDir, { recursive: true });

    const caCrt = join(this.certDir, "ca.crt");
    const caKey = join(this.certDir, "ca.key");
    const leafKey = join(this.certDir, "leaf.key");

    if (existsSync(caCrt) && existsSync(caKey)) {
      this.caCert = pki.certificateFromPem(readFileSync(caCrt, "utf8"));
      this.caKey = pki.privateKeyFromPem(readFileSync(caKey, "utf8")) as forge.pki.rsa.PrivateKey;
      log.debug("Loaded root CA from", caCrt);
    } else {
      this.generateRootCA();
      writeFileSync(caCrt, pki.certificateToPem(this.caCert));
      writeFileSync(caKey, pki.privateKeyToPem(this.caKey), { mode: 0o600 });
      log.banner(`Generated new root CA → ${caCrt}`);
    }

    if (existsSync(leafKey)) {
      this.leafKeyPem = readFileSync(leafKey, "utf8");
      const priv = pki.privateKeyFromPem(this.leafKeyPem) as forge.pki.rsa.PrivateKey;
      this.leafKeys = { privateKey: priv, publicKey: pki.setRsaPublicKey(priv.n, priv.e) };
    } else {
      this.leafKeys = pki.rsa.generateKeyPair(2048);
      this.leafKeyPem = pki.privateKeyToPem(this.leafKeys.privateKey);
      writeFileSync(leafKey, this.leafKeyPem, { mode: 0o600 });
    }
  }

  private generateRootCA(): void {
    const keys = pki.rsa.generateKeyPair(2048);
    const cert = pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = makeSerial();
    cert.validity.notBefore = daysFromNow(-1);
    cert.validity.notAfter = daysFromNow(3650); // 10 years
    const attrs = ATTRS(`CNProxy Root CA ${new Date().getFullYear()}`);
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
      { name: "subjectKeyIdentifier" },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    this.caCert = cert;
    this.caKey = keys.privateKey;
  }

  /**
   * Get (or mint + cache) a TLS SecureContext for a hostname. The cache key collapses
   * specific hosts onto a wildcard cert (foo.example.com → *.example.com) to bound cache size.
   */
  getSecureContext(servername: string): tls.SecureContext {
    const key = wildcardKey(servername);
    let ctx = this.contexts.get(key);
    if (ctx) return ctx;

    const certPem = this.mintLeaf(servername, key);
    ctx = tls.createSecureContext({ key: this.leafKeyPem, cert: certPem + "\n" + pki.certificateToPem(this.caCert) });
    this.contexts.set(key, ctx);
    return ctx;
  }

  /** Return raw PEM key+cert for a given hostname (cached via wildcard key). */
  getCredentialsFor(servername: string): { key: string; cert: string } {
    const wk = wildcardKey(servername);
    let certPem = this.certPemCache.get(wk);
    if (!certPem) {
      certPem = this.mintLeaf(servername, wk);
      this.certPemCache.set(wk, certPem);
    }
    return { key: this.leafKeyPem, cert: certPem + "\n" + pki.certificateToPem(this.caCert) };
  }

  /** Default key/cert PEM pair for TLS connections that arrive without an SNI name. */
  getDefaultCredentials(): { key: string; cert: string } {
    return this.getCredentialsFor("cnproxy.local");
  }

  private mintLeaf(servername: string, wildcard: string): string {
    const cert = pki.createCertificate();
    cert.publicKey = this.leafKeys.publicKey;
    cert.serialNumber = makeSerial();
    cert.validity.notBefore = daysFromNow(-1);
    cert.validity.notAfter = daysFromNow(397); // under the 398-day browser cap

    const cn = wildcard;
    cert.setSubject([{ name: "commonName", value: cn }]);
    cert.setIssuer(this.caCert.subject.attributes);

    const altNames: { type: number; value?: string; ip?: string }[] = [];
    const isIp = net.isIP(servername) !== 0;
    if (isIp) {
      altNames.push({ type: 7, ip: servername });
    } else {
      altNames.push({ type: 2, value: cn });
      if (cn.startsWith("*.")) altNames.push({ type: 2, value: cn.slice(2) });
      if (cn !== servername) altNames.push({ type: 2, value: servername });
    }

    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true, clientAuth: true },
      { name: "subjectAltName", altNames },
      { name: "authorityKeyIdentifier", keyIdentifier: getSki(this.caCert) },
    ]);

    cert.sign(this.caKey, forge.md.sha256.create());
    return pki.certificateToPem(cert);
  }
}

/** Collapse a hostname to its wildcard form for cache sharing (a.b.com → *.b.com). */
export function wildcardKey(host: string): string {
  if (net.isIP(host) !== 0) return host;
  const parts = host.split(".");
  // Keep apex + one label specific; wildcard the leftmost label for 3+ label hosts.
  if (parts.length >= 3) return "*." + parts.slice(1).join(".");
  return host;
}

function makeSerial(): string {
  // 16 random hex bytes, leading bit cleared (positive integer per RFC 5280).
  const bytes = forge.random.getBytesSync(16);
  let hex = forge.util.bytesToHex(bytes);
  hex = (parseInt(hex[0]!, 16) & 0x7).toString(16) + hex.slice(1);
  return hex;
}

function getSki(cert: forge.pki.Certificate): string {
  const ext = cert.getExtension("subjectKeyIdentifier") as { subjectKeyIdentifier?: string } | undefined;
  return ext?.subjectKeyIdentifier ?? "";
}
