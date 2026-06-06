/**
 * ProxyServer — the orchestrator.
 *
 * Front line is a raw `net.Server`: every connection is peeked (request head parsed without
 * consuming it) and routed:
 *   • CONNECT            → blind tunnel, or, when decrypting, bridged into a `tls.Server`
 *                          that terminates TLS with an on-the-fly host cert (SNICallback→CA);
 *                          the decrypted socket is re-routed through the same logic.
 *   • Upgrade: websocket → raw bidirectional relay with frame capture.
 *   • everything else    → bridged to an internal `http.Server` that runs the request handler.
 *
 * We deliberately avoid node:http's `connect`/`upgrade` events by doing the routing
 * ourselves at the socket level.
 */

import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

import { Options, type CnProxyOptions } from "../options.ts";
import { FlowStore } from "../flow/store.ts";
import { AddonManager } from "../addons/manager.ts";
import type { Addon } from "../addons/types.ts";
import { RuleEngine } from "../rules/engine.ts";
import { CertificateAuthority } from "../cert/ca.ts";
import { createContext, type ProxyContext } from "./context.ts";
import { handleRequest, replayFlow } from "./request-handler.ts";
import { handleH2Stream } from "./h2-handler.ts";
import { relayWebSocket, injectWsMessage } from "./websocket.ts";
import { peekRequestHead, type PeekedRequest } from "./head-parser.ts";
import { negotiateSocks } from "./socks.ts";
import { saveSession, loadSession, listSessions, sessionsDir } from "../flow/session.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { harToFlows } from "../flow/har.ts";
import { composeRequest, CookieJar, type RequestSpec } from "../api/composer.ts";
import { loadWorkspace, saveWorkspace, activeEnvVars, type Workspace } from "../api/workspace.ts";
import { log } from "../logger.ts";

interface ConnMeta {
  scheme: "http" | "https";
  target?: { host: string; port: number };
}

interface TaggedSocket extends Socket {
  _scheme?: "http" | "https";
  _cnTarget?: { host: string; port: number };
}

export class ProxyServer {
  readonly options: Options;
  readonly store: FlowStore;
  readonly addons: AddonManager;
  readonly rules: RuleEngine;
  readonly ca: CertificateAuthority;
  /** Product version, surfaced to exporters (HAR creator) and the UI. */
  readonly version: string = "5.0.0";
  /** Cookie jar shared by the API-testing composer. */
  readonly jar = new CookieJar();

  private ctx!: ProxyContext;
  private frontServer!: net.Server;
  private httpServer!: http.Server;
  private h2Server!: http2.Http2Server;
  private tlsServer!: tls.Server;
  private httpPort = 0;
  private tlsPort = 0;
  /** Bridge-connection source port → connection metadata (scheme + CONNECT target). */
  private connMeta = new Map<number, ConnMeta>();

  constructor(opts: Partial<CnProxyOptions> = {}) {
    this.options = new Options(opts);
    this.store = new FlowStore(this.options.get("maxFlows"));
    this.addons = new AddonManager();
    this.rules = new RuleEngine(this.options.get("rules"));
    this.ca = new CertificateAuthority(this.options.get("dataDir"));
  }

  /** Register an addon (lifecycle hooks). Returns `this` for chaining. */
  use(addon: Addon): this {
    this.addons.add(addon);
    return this;
  }

  /** Shared runtime context (available after start()). */
  get context(): ProxyContext {
    return this.ctx;
  }

  /** Actual port the proxy front is bound to (resolved after start). */
  get port(): number {
    return portOf(this.frontServer);
  }

  /** Get the first non-loopback IPv4 address of this machine (for mobile setup). */
  getLocalIp(): string {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === "IPv4" && !net.internal && net.address !== "0.0.0.0") {
          return net.address;
        }
      }
    }
    return "127.0.0.1";
  }

  /** Re-issue a captured request as a new flow. */
  async replay(flowId: string) {
    const source = this.store.get(flowId);
    if (!source) return null;
    return replayFlow(this.ctx, source);
  }

  /** Inject a message into a live WebSocket flow (toServer=true → toward origin, masked). */
  injectWs(flowId: string, data: Buffer, toServer: boolean): boolean {
    return injectWsMessage(this.ctx, flowId, data, toServer);
  }

  /** Persist the current capture to a named session file; returns the path. */
  saveSession(name: string): string {
    return saveSession(this.options.get("dataDir"), name, this.store.list());
  }

  /** List saved sessions (newest first). */
  listSessions() {
    return listSessions(this.options.get("dataDir"));
  }

  /** Import a HAR log into the store (appends). Returns the number of flows added. */
  importHar(har: unknown): number {
    const flows = harToFlows(har);
    for (const f of flows) this.store.add(f);
    return flows.length;
  }

  /** Compose and send an arbitrary request (API-testing). Applies the active env + cookie jar. */
  async compose(spec: RequestSpec, opts: { useEnv?: boolean; useJar?: boolean } = {}) {
    const ws = this.loadWorkspace();
    return composeRequest(this.ctx, spec, {
      env: opts.useEnv === false ? {} : activeEnvVars(ws),
      jar: opts.useJar === false ? undefined : this.jar,
    });
  }

  /** Load the persisted workspace (collections + environments). */
  loadWorkspace(): Workspace {
    return loadWorkspace(this.options.get("dataDir"));
  }

  /** Persist the workspace. */
  saveWorkspace(ws: Workspace): void {
    saveWorkspace(this.options.get("dataDir"), ws);
  }

  /** Replace the in-memory capture with a saved session; returns the number of flows loaded. */
  loadSession(nameOrPath: string): number {
    const flows = loadSession(this.options.get("dataDir"), nameOrPath);
    this.store.clear();
    for (const f of flows) this.store.add(f);
    return flows.length;
  }

  async start(): Promise<void> {
    await this.ca.init();
    this.ctx = createContext({
      options: this.options,
      store: this.store,
      addons: this.addons,
      rules: this.rules,
      ca: this.ca,
    });

    // Internal HTTP server — only ever sees normal requests (no connect/upgrade).
    this.httpServer = http.createServer();
    this.httpServer.on("connection", (sock) => {
      const meta = this.connMeta.get((sock as Socket).remotePort ?? 0);
      if (meta) {
        (sock as TaggedSocket)._scheme = meta.scheme;
        (sock as TaggedSocket)._cnTarget = meta.target;
      }
    });
    this.httpServer.on("request", (req, res) => {
      const s = req.socket as TaggedSocket;
      // Resolve the bridge metadata from connMeta here, not in the "connection" handler:
      // on some platforms (Linux loopback) the server accepts the bridge connection before
      // the client-side connect callback that records the meta has run, so reading it at
      // "connection" time races and loses the scheme/target — making a decrypted HTTPS
      // request look like plain http and get sent in cleartext to a TLS origin. The "request"
      // event only fires after the bridge has written the head (which happens right after
      // connMeta.set), so by here the entry is always present.
      const meta = this.connMeta.get(s.remotePort ?? 0);
      const scheme = meta?.scheme ?? s._scheme ?? "http";
      const target = meta?.target ?? s._cnTarget;
      void handleRequest(this.ctx, req, res, scheme, target);
    });
    this.httpServer.on("clientError", (_e, sock) => (sock as Socket).destroy());
    await listen(this.httpServer, 0, "127.0.0.1");
    this.httpPort = portOf(this.httpServer);

    // Internal cleartext HTTP/2 server — decrypted h2 sockets are emitted into it (ALPN branch).
    this.h2Server = http2.createServer();
    this.h2Server.on("stream", (stream, headers) => {
      const sock = stream.session?.socket as Socket | undefined;
      const meta = sock ? this.connMeta.get(sock.remotePort ?? 0) : undefined;
      const target = meta?.target ?? (sock as any)?._cnTarget;
      void handleH2Stream(this.ctx, stream, headers, target);
    });
    this.h2Server.on("sessionError", (e) => log.debug("h2 session error:", e.message));
    this.h2Server.on("clientError", () => {});

    // TLS terminator — decrypts CONNECT traffic. ALPN selects h2 (→ h2 server) or http/1.1
    // (→ raw route for h1 + wss). Re-routes the cleartext socket accordingly.
    const def = this.ca.getDefaultCredentials();
    this.tlsServer = tls.createServer({
      key: def.key,
      cert: def.cert,
      ALPNProtocols: ["h2", "http/1.1"],
      SNICallback: (servername, cb) => {
        try {
          cb(null, this.ca.getSecureContext(servername));
        } catch (e) {
          cb(e as Error);
        }
      },
    });
    this.tlsServer.on("secureConnection", (tlsSock) => {
      if (tlsSock.alpnProtocol === "h2") {
        this.h2Server.emit("connection", tlsSock);
        return;
      }
      const meta = this.connMeta.get(tlsSock.remotePort ?? 0);
      const target = meta?.target ?? { host: tlsSock.servername || "", port: 443 };
      void this.route(tlsSock as unknown as Duplex, "https", target, {
        address: tlsSock.remoteAddress ?? "",
        port: tlsSock.remotePort ?? 0,
      });
    });
    this.tlsServer.on("tlsClientError", (_e, sock) => (sock as Socket).destroy());
    await listen(this.tlsServer as unknown as http.Server, 0, "127.0.0.1");
    this.tlsPort = (this.tlsServer.address() as { port: number }).port;

    // Public raw front — peek the first byte to tell SOCKS (0x05/0x04) from HTTP.
    this.frontServer = net.createServer((sock) => {
      sock.on("error", () => sock.destroy());
      void this.handleFront(sock);
    });
    await listen(this.frontServer as unknown as http.Server, this.options.get("port"), this.options.get("host"));

    // Auto-load session if exists
    try {
      const path = join(sessionsDir(this.options.get("dataDir")), "auto.cnp");
      if (existsSync(path)) {
        const flows = loadSession(this.options.get("dataDir"), "auto");
        for (const f of flows) this.store.add(f);
        log.debug(`Auto-loaded ${flows.length} flows from previous session.`);
      }
    } catch (e: any) {
      log.debug("Failed to auto-load session:", e.message);
    }

    // Register auto-save listeners
    this.store.on("add", () => this.triggerAutoSave());
    this.store.on("update", () => this.triggerAutoSave());
    this.store.on("clear", () => this.triggerAutoSave());

    await this.addons.triggerLifecycle("running");
    log.banner(
      `cnproxy listening on ${this.options.get("host")}:${this.options.get("port")} ` +
        `(HTTPS decrypt: ${this.options.get("decryptHttps") ? "on" : "off"})`,
    );
  }

  async stop(): Promise<void> {
    await this.addons.triggerLifecycle("done");
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.autoSaveDirty) {
      this.autoSaveDirty = false;
      try {
        saveSession(this.options.get("dataDir"), "auto", this.store.list());
      } catch (e: any) {
        log.debug("Final auto-save failed:", e.message);
      }
    }
    try {
      this.h2Server.close();
    } catch {
      /* not listening; emitted-connection only */
    }
    await Promise.all([
      closeServer(this.frontServer as unknown as http.Server),
      closeServer(this.httpServer),
      closeServer(this.tlsServer as unknown as http.Server),
    ]);
  }

  // ---- routing ----

  /** Front-line dispatch: SOCKS clients (first byte 0x05/0x04) are negotiated, else HTTP. */
  private async handleFront(socket: Socket): Promise<void> {
    const remote = { address: socket.remoteAddress ?? "", port: socket.remotePort ?? 0 };
    const first = await readChunk(socket);
    if (!first) {
      socket.destroy();
      return;
    }
    if (first[0] === 0x05 || first[0] === 0x04) {
      const result = await negotiateSocks(socket, first, this.options.get("socksAuth"));
      if (!result) {
        socket.destroy();
        return;
      }
      await this.afterSocks(socket, result.target, remote, result.leftover);
      return;
    }
    void this.route(socket as unknown as Duplex, "http", undefined, remote, first);
  }

  /** After a SOCKS tunnel is established, detect TLS vs plaintext and route accordingly. */
  private async afterSocks(
    socket: Socket,
    target: { host: string; port: number },
    remote: { address: string; port: number },
    leftover: Buffer,
  ): Promise<void> {
    let lead = leftover;
    if (!lead.length) {
      const c = await readChunk(socket);
      if (!c) {
        socket.destroy();
        return;
      }
      lead = c;
    }
    if (lead[0] === 0x16) {
      // TLS ClientHello — MITM-decrypt or blind-tunnel like a CONNECT.
      if (this.shouldDecrypt(target.host)) this.bridgeToTls(socket, target, lead);
      else this.blindTunnel(socket, lead, target.host, target.port);
    } else {
      // Plaintext (HTTP) over the tunnel — the request's Host header carries the target.
      void this.route(socket as unknown as Duplex, "http", undefined, remote, lead);
    }
  }

  private async route(
    socket: Duplex,
    scheme: "http" | "https",
    mitmTarget: { host: string; port: number } | undefined,
    remote: { address: string; port: number },
    initial: Buffer = Buffer.alloc(0),
  ): Promise<void> {
    const head = await peekRequestHead(socket, initial);
    if (!head) {
      socket.destroy();
      return;
    }

    if (head.method === "CONNECT") {
      this.handleConnect(socket as Socket, head.target, head.rest);
      return;
    }

    // Bypass own web inspector to avoid feedback loop when browser proxies everything
    const resolvedTarget = mitmTarget ?? targetFromHead(head, scheme === "https" ? 443 : 80);
    if (this.isOwnWebInspector(resolvedTarget)) {
      this.passthroughToSelf(socket, head);
      return;
    }

    if ((head.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      relayWebSocket(this.ctx, head, socket, remote, scheme, resolvedTarget);
      return;
    }

    // Normal request: bridge into the internal HTTP server, replaying the peeked head.
    const bridge = net.connect(this.httpPort, "127.0.0.1", () => {
      this.connMeta.set(bridge.localPort ?? 0, { scheme, target: mitmTarget });
      bridge.write(head.headBuf);
      if (head.rest.length) bridge.write(head.rest);
      socket.pipe(bridge);
      bridge.pipe(socket as unknown as NodeJS.WritableStream);
    });
    const cleanup = () => {
      const p = bridge.localPort ?? 0;
      if (p) this.connMeta.delete(p);
      bridge.destroy();
      socket.destroy();
    };
    bridge.on("error", cleanup);
    bridge.on("close", cleanup);
    socket.on("close", cleanup);
  }

  private handleConnect(clientSocket: Socket, hostport: string, rest: Buffer): void {
    const { host, port } = splitHostPort(hostport, 443);
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    if (this.isOwnWebInspector({ host, port })) {
      this.blindTunnel(clientSocket, rest, host, port);
      return;
    }

    if (!this.shouldDecrypt(host)) {
      this.blindTunnel(clientSocket, rest, host, port);
      return;
    }
    this.bridgeToTls(clientSocket, { host, port }, rest);
  }

  /** Pipe a client socket into the internal TLS terminator (MITM), recording its origin target. */
  private bridgeToTls(clientSocket: Socket, target: { host: string; port: number }, rest: Buffer): void {
    const bridge = net.connect(this.tlsPort, "127.0.0.1", () => {
      this.connMeta.set(bridge.localPort ?? 0, { scheme: "https", target });
      if (rest.length) bridge.write(rest);
      clientSocket.pipe(bridge);
      bridge.pipe(clientSocket);
    });
    const cleanup = () => {
      const p = bridge.localPort ?? 0;
      if (p) this.connMeta.delete(p);
      bridge.destroy();
      clientSocket.destroy();
    };
    bridge.on("error", cleanup);
    bridge.on("close", cleanup);
    clientSocket.on("close", cleanup);
  }

  private blindTunnel(clientSocket: Socket, rest: Buffer, host: string, port: number): void {
    const upstream = net.connect(port, host, () => {
      if (rest && rest.length) upstream.write(rest);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
    log.debug("blind tunnel", `${host}:${port}`);
  }

  private shouldDecrypt(host: string): boolean {
    if (!this.options.get("decryptHttps")) return false;
    const ignore = this.options.get("ignoreHosts");
    if (ignore.some((p) => matchHost(p, host))) return false;
    const allow = this.options.get("allowHosts");
    if (allow.length && !allow.some((p) => matchHost(p, host))) return false;
    return true;
  }

  /** Check if the target points to our own web inspector (avoid feedback loop when proxied). */
  private isOwnWebInspector(target: { host: string; port: number }): boolean {
    if (target.port !== this.options.get("webPort")) return false;
    const h = target.host.toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0.0.0.0";
  }

  /** Pipe directly to the web inspector without capture (bypass for self-traffic). */
  private passthroughToSelf(socket: Duplex, head: PeekedRequest): void {
    const webPort = this.options.get("webPort");
    const bridge = net.connect(webPort, "127.0.0.1", () => {
      bridge.write(head.headBuf);
      if (head.rest.length) bridge.write(head.rest);
      socket.pipe(bridge);
      bridge.pipe(socket as unknown as NodeJS.WritableStream);
    });
    bridge.on("error", () => socket.destroy());
    socket.on("close", () => bridge.destroy());
  }

  private autoSaveTimer: any = null;
  private autoSaveDirty = false;

  private triggerAutoSave(): void {
    this.autoSaveDirty = true;
    if (this.autoSaveTimer) return;
    this.autoSaveTimer = setTimeout(() => {
      this.autoSaveTimer = null;
      if (this.autoSaveDirty) {
        this.autoSaveDirty = false;
        try {
          saveSession(this.options.get("dataDir"), "auto", this.store.list());
        } catch (e: any) {
          log.debug("Auto-save failed:", e.message);
        }
      }
    }, 2000);
  }
}

/** Read the next data chunk from a socket (the bytes are consumed, to be threaded forward). */
function readChunk(socket: Socket): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const onData = (d: Buffer) => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      resolve(d);
    };
    const onEnd = () => {
      socket.off("data", onData);
      resolve(null);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
  });
}

function targetFromHead(head: { target: string; headers: Map<string, string> }, fallbackPort: number): { host: string; port: number } {
  if (/^https?:\/\//i.test(head.target)) {
    const u = new URL(head.target);
    return { host: u.hostname, port: u.port ? parseInt(u.port, 10) : fallbackPort };
  }
  return splitHostPort(head.headers.get("host") ?? "", fallbackPort);
}

function splitHostPort(value: string, fallbackPort: number): { host: string; port: number } {
  if (!value) return { host: "", port: fallbackPort };
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    const host = value.slice(1, end);
    const portPart = value.slice(end + 2);
    return { host, port: portPart ? parseInt(portPart, 10) : fallbackPort };
  }
  const idx = value.lastIndexOf(":");
  if (idx === -1) return { host: value, port: fallbackPort };
  return { host: value.slice(0, idx), port: parseInt(value.slice(idx + 1), 10) || fallbackPort };
}

function matchHost(pattern: string, host: string): boolean {
  if (pattern.startsWith("*.")) return host === pattern.slice(2) || host.endsWith(pattern.slice(1));
  if (pattern.includes("*")) {
    const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
    return re.test(host);
  }
  return host === pattern;
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function portOf(server: http.Server | net.Server): number {
  return (server.address() as { port: number }).port;
}

function closeServer(server?: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    setTimeout(() => resolve(), 300);
  });
}
