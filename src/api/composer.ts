/**
 * API-testing engine — the "Postman half": compose and send arbitrary requests, import/export
 * cURL, generate code snippets, substitute environment variables, and manage a cookie jar.
 * Composed requests run the same rule/addon pipeline and are recorded as flows.
 */
import { Flow, CnResponse, FlowError } from "../flow/flow.ts";
import { Headers } from "../flow/headers.ts";
import { collectBody } from "../core/stream-util.ts";
import { sendUpstream, type Timings } from "../core/upstream.ts";
import { decodeBody, isDecodable } from "../core/encoding.ts";
import type { ProxyContext } from "../core/context.ts";

export interface RequestSpec {
  method?: string;
  url: string;
  headers?: [string, string][];
  /** Raw body text (utf8). */
  body?: string;
}

/** Substitute `{{var}}` placeholders from an environment map. */
export function applyEnv(text: string, env: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k) => (k in env ? env[k]! : `{{${k}}}`));
}

/** Minimal cookie jar: host → name → value. */
export class CookieJar {
  private jar = new Map<string, Map<string, string>>();

  headerFor(host: string): string {
    const m = this.jar.get(host);
    if (!m || !m.size) return "";
    return [...m.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  storeFrom(host: string, headers: Headers): void {
    for (const [k, v] of headers.entries()) {
      if (k.toLowerCase() !== "set-cookie") continue;
      const pair = v.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      if (!this.jar.has(host)) this.jar.set(host, new Map());
      this.jar.get(host)!.set(name, val);
    }
  }

  clear(): void {
    this.jar.clear();
  }
}

export interface ComposeOptions {
  env?: Record<string, string>;
  jar?: CookieJar;
  /** Apply rules + addon hooks like proxied traffic (default true). */
  pipeline?: boolean;
}

/** Compose and send a request, recording it as a flow. */
export async function composeRequest(ctx: ProxyContext, spec: RequestSpec, opts: ComposeOptions = {}): Promise<Flow> {
  const env = opts.env ?? {};
  const now = ctx.now();
  const urlStr = applyEnv(spec.url, env);
  const u = new URL(urlStr);

  const flow = new Flow({ address: "composer", port: 0, tls: u.protocol === "https:" }, now);
  flow.request.scheme = u.protocol === "https:" ? "https" : "http";
  flow.request.host = u.hostname;
  flow.request.port = u.port ? parseInt(u.port, 10) : flow.request.scheme === "https" ? 443 : 80;
  flow.request.method = (spec.method ?? "GET").toUpperCase();
  flow.request.path = u.pathname + u.search;
  flow.request.httpVersion = "1.1";

  const headers = new Headers((spec.headers ?? []).map(([k, v]) => [k, applyEnv(v, env)] as [string, string]));
  if (!headers.has("host")) headers.set("host", u.host);
  // Cookie jar
  if (opts.jar) {
    const cookie = opts.jar.headerFor(u.hostname);
    if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
  }
  flow.request.headers = headers;
  if (spec.body != null && spec.body !== "") {
    flow.request.body = Buffer.from(applyEnv(spec.body, env), "utf8");
    if (!headers.has("content-length")) headers.set("content-length", String(flow.request.body.length));
  }
  flow.request.timestampStart = now;
  flow.request.timestampEnd = now;
  flow.comment = "composed";
  ctx.store.add(flow);

  try {
    if (opts.pipeline !== false) await ctx.addons.trigger("request", flow);
    const directive = opts.pipeline !== false ? ctx.rules.applyRequest(flow) : { block: false, delayMs: 0, mock: null };

    if (directive.mock) {
      const res = new CnResponse();
      res.statusCode = directive.mock.status;
      res.headers = directive.mock.headers.clone();
      res.body = directive.mock.body;
      res.timestampStart = res.timestampEnd = ctx.now();
      flow.response = res;
    } else if (!directive.block) {
      const timings: Timings = {};
      const upstreamRes = await sendUpstream(
        flow.request,
        { upstream: ctx.options.get("upstream"), timeout: ctx.options.get("timeout") },
        timings,
      );
      flow.timings = timings;
      const res = new CnResponse();
      res.statusCode = upstreamRes.statusCode ?? 0;
      res.reason = upstreamRes.statusMessage ?? "";
      res.httpVersion = upstreamRes.httpVersion;
      res.headers = Headers.fromRaw(upstreamRes.rawHeaders);
      res.timestampStart = ctx.now();
      flow.response = res;
      const raw = await collectBody(upstreamRes);
      const enc = res.headers.get("content-encoding") ?? "";
      res.body = isDecodable(enc) ? decodeBody(raw, enc) : raw;
      if (res.body !== raw) res.headers.delete("content-encoding");
      res.timestampEnd = ctx.now();
      if (opts.pipeline !== false) {
        ctx.rules.applyResponse(flow);
        await ctx.addons.trigger("response", flow);
      }
      if (opts.jar) opts.jar.storeFrom(u.hostname, res.headers);
    }
    ctx.store.update(flow);
  } catch (err) {
    flow.error = new FlowError(err instanceof Error ? err.message : String(err), ctx.now());
    ctx.store.update(flow);
  }
  return flow;
}

// ---- cURL import ----

/** Parse a `curl` command line into a RequestSpec. */
export function parseCurl(command: string): RequestSpec {
  const tokens = tokenizeShell(command);
  if (tokens[0] === "curl") tokens.shift();
  let method: string | undefined;
  let url = "";
  const headers: [string, string][] = [];
  let body: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "-X" || t === "--request") {
      method = tokens[++i];
    } else if (t === "-H" || t === "--header") {
      const h = tokens[++i] ?? "";
      const idx = h.indexOf(":");
      if (idx !== -1) headers.push([h.slice(0, idx).trim(), h.slice(idx + 1).trim()]);
    } else if (t === "-d" || t === "--data" || t === "--data-raw" || t === "--data-binary") {
      body = tokens[++i];
    } else if (t === "-A" || t === "--user-agent") {
      headers.push(["user-agent", tokens[++i] ?? ""]);
    } else if (t === "-b" || t === "--cookie") {
      headers.push(["cookie", tokens[++i] ?? ""]);
    } else if (t === "--url") {
      url = tokens[++i] ?? "";
    } else if (!t.startsWith("-") && !url) {
      url = t;
    }
    // unknown flags (e.g. -k, --compressed, -L) are ignored
  }
  if (!method) method = body != null ? "POST" : "GET";
  return { method, url, headers, body };
}

function tokenizeShell(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
    } else if (c === "\\" && i + 1 < input.length && /\s|\n/.test(input[i + 1]!)) {
      i++; // line continuation
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

// ---- export / code generation ----

export type CodeLang = "curl" | "fetch" | "python";

export function generateCode(flow: Flow, lang: CodeLang): string {
  const r = flow.request;
  const url = r.url;
  const headers = r.headers.entries().filter(([k]) => k.toLowerCase() !== "host");
  const body = r.body ? r.body.toString("utf8") : "";

  if (lang === "curl") {
    const parts = [`curl -X ${r.method} ${shellQuote(url)}`];
    for (const [k, v] of headers) parts.push(`  -H ${shellQuote(`${k}: ${v}`)}`);
    if (body) parts.push(`  --data ${shellQuote(body)}`);
    return parts.join(" \\\n");
  }
  if (lang === "fetch") {
    const h = Object.fromEntries(headers);
    const init: Record<string, unknown> = { method: r.method };
    if (Object.keys(h).length) init.headers = h;
    if (body) init.body = body;
    return `await fetch(${JSON.stringify(url)}, ${JSON.stringify(init, null, 2)});`;
  }
  // python (requests)
  const hLines = headers.map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
  const lines = [
    "import requests",
    "",
    `resp = requests.request(${JSON.stringify(r.method)}, ${JSON.stringify(url)},`,
    `    headers={\n${hLines}\n    },`,
  ];
  if (body) lines.push(`    data=${JSON.stringify(body)},`);
  lines.push(")");
  lines.push("print(resp.status_code, resp.text)");
  return lines.join("\n");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
