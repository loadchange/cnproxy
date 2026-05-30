/**
 * Reactive options manager.
 * Typed options with defaults, change subscriptions, and JSON load/dump.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface CnProxyOptions {
  /** Proxy listen host. */
  host: string;
  /** Proxy listen port. */
  port: number;
  /** Web inspector UI host. */
  webHost: string;
  /** Web inspector UI port. */
  webPort: number;
  /** Enable HTTPS MITM (decrypt TLS). When false, HTTPS is tunneled blindly. */
  decryptHttps: boolean;
  /** Hostnames to never decrypt (pass-through CONNECT). Supports `*.` wildcards. */
  ignoreHosts: string[];
  /** Only decrypt these hosts (allow-list). Empty = decrypt all (subject to ignoreHosts). */
  allowHosts: string[];
  /** Max captured request/response body bytes kept in memory per message. */
  maxBodySize: number;
  /** Max number of flows retained in the in-memory ring buffer. */
  maxFlows: number;
  /** Upstream proxy URL (http://host:port) for chaining, or null. */
  upstream: string | null;
  /** Data directory (CA, config). */
  dataDir: string;
  /** Request-phase intercept filter — matching flows pause before going upstream. Empty = off. */
  intercept: string;
  /** Response-phase intercept filter — matching flows pause before relaying to the client. */
  interceptResponse: string;
  /** Rule source text, applied to every flow. */
  rules: string;
  /** Connection timeout (ms) for upstream requests. */
  timeout: number;
  /** Open the web UI in the browser on start. */
  openBrowser: boolean;
}

export const DEFAULT_OPTIONS: CnProxyOptions = {
  host: "127.0.0.1",
  port: 8888,
  webHost: "127.0.0.1",
  webPort: 8889,
  decryptHttps: true,
  ignoreHosts: [],
  allowHosts: [],
  maxBodySize: 5 * 1024 * 1024,
  maxFlows: 5000,
  upstream: null,
  dataDir: join(homedir(), ".cnproxy"),
  intercept: "",
  interceptResponse: "",
  rules: "",
  timeout: 60_000,
  openBrowser: false,
};

type Listener = (changed: Set<keyof CnProxyOptions>) => void;

export class Options {
  private values: CnProxyOptions;
  private listeners = new Set<Listener>();

  constructor(overrides: Partial<CnProxyOptions> = {}) {
    this.values = { ...DEFAULT_OPTIONS, ...overrides };
  }

  get<K extends keyof CnProxyOptions>(key: K): CnProxyOptions[K] {
    return this.values[key];
  }

  all(): Readonly<CnProxyOptions> {
    return this.values;
  }

  /** Update one or more options; notifies subscribers with the set of changed keys. */
  update(patch: Partial<CnProxyOptions>): void {
    const changed = new Set<keyof CnProxyOptions>();
    for (const k of Object.keys(patch) as (keyof CnProxyOptions)[]) {
      const v = patch[k];
      if (v !== undefined && v !== this.values[k]) {
        // @ts-expect-error indexed assignment across the union is safe here
        this.values[k] = v;
        changed.add(k);
      }
    }
    if (changed.size) for (const l of this.listeners) l(changed);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  toJSON(): CnProxyOptions {
    return { ...this.values };
  }
}
