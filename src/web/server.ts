/**
 * Web inspector — a Bun.serve app that exposes the live flow stream over a WebSocket and
 * a small REST API for detail/control (intercept resume/kill, replay, mark, options, rules).
 * Serves a single-page UI for browsing captured traffic, à la whistle/Reqable.
 */

import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { ProxyServer } from "../core/proxy.ts";
import type { Flow } from "../flow/flow.ts";
import { Headers } from "../flow/headers.ts";
import { flowsToHar } from "../flow/har.ts";
import { log } from "../logger.ts";

const UI_DIR = join(import.meta.dir, "ui");

interface WsData {
  id: number;
}

export class WebInspector {
  private server?: Server<WsData>;
  private sockets = new Set<ServerWebSocket<WsData>>();
  private nextId = 1;

  constructor(private proxy: ProxyServer) {}

  start(): void {
    const host = this.proxy.options.get("webHost");
    const port = this.proxy.options.get("webPort");
    const self = this;

    this.wireStore();

    this.server = Bun.serve<WsData>({
      hostname: host,
      port,
      idleTimeout: 0,
      async fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          if (server.upgrade(req, { data: { id: self.nextId++ } })) return undefined;
          return new Response("upgrade failed", { status: 400 });
        }
        return self.handleHttp(req, url);
      },
      websocket: {
        open(ws) {
          self.sockets.add(ws);
          // Send the current snapshot so a fresh tab is immediately populated.
          ws.send(JSON.stringify({ type: "snapshot", flows: self.proxy.store.list().map((f) => f.toSummary()) }));
        },
        close(ws) {
          self.sockets.delete(ws);
        },
        message() {
          /* client→server messages currently go through REST; ignore */
        },
      },
    });

    log.banner(`Web inspector → http://${host}:${port}`);
  }

  stop(): void {
    this.server?.stop(true);
  }

  private wireStore(): void {
    const broadcast = (type: string, flow?: Flow) => {
      const msg = JSON.stringify(flow ? { type, flow: flow.toSummary() } : { type });
      for (const ws of this.sockets) {
        try {
          ws.send(msg);
        } catch {
          /* dropped client */
        }
      }
    };
    this.proxy.store.on("add", (f: Flow) => broadcast("add", f));
    this.proxy.store.on("update", (f: Flow) => broadcast("update", f));
    this.proxy.store.on("intercept", (f: Flow) => broadcast("intercept", f));
    this.proxy.store.on("clear", () => broadcast("clear"));
  }

  private async handleHttp(req: Request, url: URL): Promise<Response> {
    const { pathname } = url;

    // ---- static assets ----
    if (pathname === "/" || pathname === "/index.html") return file("index.html", "text/html; charset=utf-8");
    if (pathname === "/app.js") return file("app.js", "application/javascript; charset=utf-8");
    if (pathname === "/style.css") return file("style.css", "text/css; charset=utf-8");

    // ---- root CA download (one-click trust install) ----
    if (pathname === "/ca.crt" || pathname === "/cnproxy-ca.crt") {
      return new Response(Bun.file(this.proxy.ca.rootCertPath), {
        headers: {
          "content-type": "application/x-x509-ca-cert",
          "content-disposition": 'attachment; filename="cnproxy-ca.crt"',
        },
      });
    }

    // ---- REST API ----
    if (pathname.startsWith("/api/")) return this.handleApi(req, url);

    return new Response("Not found", { status: 404 });
  }

  private async handleApi(req: Request, url: URL): Promise<Response> {
    const { pathname } = url;
    const store = this.proxy.store;

    if (pathname === "/api/flows" && req.method === "GET") {
      return json(store.list().map((f) => f.toSummary()));
    }

    if (pathname === "/api/export/har" && req.method === "GET") {
      const har = flowsToHar(store.list(), this.proxy.version);
      return new Response(JSON.stringify(har, null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": 'attachment; filename="cnproxy.har"',
        },
      });
    }

    if (pathname === "/api/import/har" && req.method === "POST") {
      const har = await req.json().catch(() => null);
      const count = this.proxy.importHar(har);
      return json({ ok: true, flows: count });
    }

    if (pathname === "/api/flows/replay-batch" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const replayed = await Promise.all(ids.map((id) => this.proxy.replay(id)));
      return json({ ok: true, replayed: replayed.filter(Boolean).length });
    }

    if (pathname === "/api/clear" && req.method === "POST") {
      store.clear();
      return json({ ok: true });
    }

    // ---- session persistence / history ----
    if (pathname === "/api/sessions" && req.method === "GET") {
      return json(this.proxy.listSessions());
    }
    if (pathname === "/api/sessions/save" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { name?: string };
      const name = body.name || `session-${store.list().length}`;
      const path = this.proxy.saveSession(name);
      return json({ ok: true, path });
    }
    if (pathname === "/api/sessions/load" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { name?: string };
      if (!body.name) return json({ error: "name required" }, 400);
      const count = this.proxy.loadSession(body.name);
      return json({ ok: true, flows: count });
    }

    if (pathname === "/api/options") {
      if (req.method === "GET") return json(this.proxy.options.toJSON());
      if (req.method === "POST") {
        const patch = (await req.json()) as Record<string, unknown>;
        this.proxy.options.update(patch as never);
        return json(this.proxy.options.toJSON());
      }
    }

    if (pathname === "/api/stats" && req.method === "GET") {
      const flows = store.list();
      return json({
        total: flows.length,
        rules: this.proxy.rules.count,
        intercept: this.proxy.options.get("intercept"),
        decryptHttps: this.proxy.options.get("decryptHttps"),
      });
    }

    // /api/flows/:id  and  /api/flows/:id/:action
    const m = pathname.match(/^\/api\/flows\/([^/]+)(?:\/([a-z]+))?$/);
    if (m) {
      const id = m[1]!;
      const action = m[2];
      const flow = store.get(id);
      if (!flow) return json({ error: "not found" }, 404);

      if (!action && req.method === "GET") return json(flow.toDetail());

      if (req.method === "POST") {
        switch (action) {
          case "edit": {
            // Mutate a (typically paused) flow's request/response before it is resumed/relayed.
            const patch = (await req.json().catch(() => ({}))) as FlowEditPatch;
            applyFlowEdit(flow, patch);
            store.update(flow);
            return json({ ok: true });
          }
          case "resume":
            flow.resume();
            store.update(flow);
            return json({ ok: true });
          case "kill":
            flow.kill();
            store.update(flow);
            return json({ ok: true });
          case "mark":
            flow.marked = !flow.marked;
            store.update(flow);
            return json({ ok: true, marked: flow.marked });
          case "replay": {
            const replayed = await this.proxy.replay(id);
            return json({ ok: !!replayed, id: replayed?.id ?? null });
          }
          case "ws-send": {
            const body = (await req.json().catch(() => ({}))) as { text?: string; toServer?: boolean };
            const ok = this.proxy.injectWs(id, Buffer.from(body.text ?? "", "utf8"), !!body.toServer);
            return json({ ok });
          }
        }
      }
    }

    return json({ error: "unknown endpoint" }, 404);
  }
}

interface FlowEditPatch {
  request?: {
    method?: string;
    path?: string;
    headers?: [string, string][];
    /** base64-encoded body */
    body?: string;
  };
  response?: {
    statusCode?: number;
    headers?: [string, string][];
    body?: string;
  };
  comment?: string;
}

/** Apply an editor patch to a flow (used for intercept editing + manual tweaks). */
function applyFlowEdit(flow: Flow, patch: FlowEditPatch): void {
  if (patch.request) {
    const r = patch.request;
    if (typeof r.method === "string") flow.request.method = r.method;
    if (typeof r.path === "string") flow.request.path = r.path;
    if (Array.isArray(r.headers)) flow.request.headers = new Headers(r.headers);
    if (typeof r.body === "string") flow.request.body = Buffer.from(r.body, "base64");
  }
  if (patch.response && flow.response) {
    const r = patch.response;
    if (typeof r.statusCode === "number") flow.response.statusCode = r.statusCode;
    if (Array.isArray(r.headers)) flow.response.headers = new Headers(r.headers);
    if (typeof r.body === "string") flow.response.body = Buffer.from(r.body, "base64");
  }
  if (typeof patch.comment === "string") flow.comment = patch.comment;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function file(name: string, type: string): Response {
  return new Response(Bun.file(join(UI_DIR, name)), { headers: { "content-type": type } });
}
