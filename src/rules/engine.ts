/**
 * Rule engine — `pattern operator://value` rules.
 *
 * A rule line is:   <pattern> <operator>://<value>      (e.g. `example.com host://127.0.0.1`)
 * or the shorthand: <pattern> <url>                      (bare URL ⇒ rewrite/redirect target)
 *
 * Patterns (what the rule matches against a flow):
 *   ~<filter expr>      → full filter language (see filter.ts)
 *   ^regex              → regex tested against the full URL
 *   contains `*`        → glob against host (no slash) or URL (with slash)
 *   bare.domain         → host match, leftmost label wildcarded automatically
 *   path/or/url         → substring match against the URL
 *
 * Operators are split by the phase they act in:
 *   request:  host, rewrite, redirect, reqHeaders, reqType, ua, referer, reqReplace,
 *             delay, block, file, mock, status, resHeaders, resType, resBody
 *   response: resHeaders, resType, resBody, status, resReplace, delay
 * (mock/file/status/resBody/resHeaders synthesize a response and short-circuit upstream.)
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { compileFilter, type Predicate } from "./filter.ts";
import type { Flow } from "../flow/flow.ts";
import { Headers } from "../flow/headers.ts";
import { log } from "../logger.ts";

export interface MockResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

export interface RequestDirective {
  block: boolean;
  delayMs: number;
  mock: MockResponse | null;
}

interface Rule {
  raw: string;
  /** The original pattern token (used by dir:// to strip a matched path prefix). */
  pattern: string;
  match: Predicate;
  op: string;
  value: string;
}

const REQUEST_OPS = new Set([
  "host", "rewrite", "redirect", "reqheaders", "reqtype", "ua", "referer",
  "reqreplace", "delay", "block", "abort", "file", "dir", "mock", "status",
  "resheaders", "restype", "resbody", "resreplace", "highlight",
]);

export class RuleEngine {
  private rules: Rule[] = [];

  constructor(text = "") {
    this.load(text);
  }

  /** Parse rule source text (one rule per line; `#` comments and blanks ignored). */
  load(text: string): void {
    const rules: Rule[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const parsed = this.parseLine(line);
      if (parsed) rules.push(parsed);
    }
    this.rules = rules;
    log.debug(`RuleEngine: loaded ${rules.length} rule(s)`);
  }

  get count(): number {
    return this.rules.length;
  }

  private parseLine(line: string): Rule | null {
    // Split pattern (first token, unless it's a quoted ~filter) from the operation.
    // Pattern is everything up to the first whitespace, except a leading ~filter which
    // may contain spaces and is wrapped in quotes: `"~m POST & ~u /api" mock://...`
    let pattern: string;
    let rest: string;
    if (line.startsWith('"')) {
      const end = line.indexOf('"', 1);
      if (end === -1) return null;
      pattern = line.slice(1, end);
      rest = line.slice(end + 1).trim();
    } else {
      const sp = line.search(/\s/);
      if (sp === -1) return null;
      pattern = line.slice(0, sp);
      rest = line.slice(sp + 1).trim();
    }

    let op: string;
    let value: string;
    const proto = rest.match(/^([a-zA-Z]+):\/\/([\s\S]*)$/);
    if (proto) {
      op = proto[1]!.toLowerCase();
      value = proto[2]!;
    } else if (/^https?:\/\//i.test(rest)) {
      // bare URL ⇒ rewrite
      op = "rewrite";
      value = rest;
    } else {
      // bare host/ip ⇒ host redirect
      op = "host";
      value = rest;
    }

    // Guard: a host value with whitespace or an embedded operator almost always means a
    // multi-token filter pattern was left unquoted (e.g. `~u /x mock://…`). Reject loudly
    // rather than silently turning it into a match-all host redirect.
    if (op === "host" && (/\s/.test(value) || value.includes("://"))) {
      log.warn(`ignoring malformed rule (quote filter patterns containing spaces): ${line}`);
      return null;
    }

    return { raw: line, pattern, match: this.compilePattern(pattern), op, value };
  }

  private compilePattern(pattern: string): Predicate {
    if (pattern.startsWith("~")) return compileFilter(pattern);
    if (pattern.startsWith("^")) {
      let re: RegExp;
      try {
        re = new RegExp(pattern, "i");
      } catch {
        re = new RegExp(escapeRe(pattern), "i");
      }
      return (f) => re.test(f.request.url);
    }
    if (pattern.includes("*")) {
      const re = globToRe(pattern);
      const hasSlash = pattern.includes("/");
      return (f) => re.test(hasSlash ? f.request.url : f.request.prettyHost);
    }
    if (!pattern.includes("/")) {
      // bare domain: match host exactly or as a subdomain.
      const host = pattern.toLowerCase();
      return (f) => {
        const h = f.request.prettyHost.toLowerCase();
        return h === host || h.endsWith("." + host);
      };
    }
    // substring against URL
    return (f) => f.request.url.includes(pattern);
  }

  // ---- request phase ----

  applyRequest(flow: Flow): RequestDirective {
    const directive: RequestDirective = { block: false, delayMs: 0, mock: null };
    const mockHeaders = new Headers();
    let mockStatus = 0;
    let mockBody: Buffer | null = null;
    let hasMock = false;

    for (const rule of this.rules) {
      if (!REQUEST_OPS.has(rule.op)) continue;
      if (!rule.match(flow)) continue;
      flow.appliedRules.push(`${rule.op}`);

      switch (rule.op) {
        case "host": {
          const { host, port } = parseHostPort(rule.value, flow.request.port);
          flow.request.host = host;
          flow.request.port = port;
          break;
        }
        case "rewrite": {
          this.applyRewrite(flow, rule.value);
          break;
        }
        case "redirect": {
          mockStatus = 302;
          mockHeaders.set("location", rule.value);
          mockBody = Buffer.alloc(0);
          hasMock = true;
          break;
        }
        case "reqheaders":
          applyHeaderSpec(flow.request.headers, rule.value);
          break;
        case "reqtype":
          flow.request.headers.set("content-type", rule.value);
          break;
        case "ua":
          flow.request.headers.set("user-agent", rule.value);
          break;
        case "referer":
          flow.request.headers.set("referer", rule.value);
          break;
        case "reqreplace":
          flow.request.body = replaceBody(flow.request.body, rule.value);
          break;
        case "delay":
          directive.delayMs = Math.max(directive.delayMs, parseInt(rule.value, 10) || 0);
          break;
        case "block":
        case "abort":
          directive.block = true;
          break;
        case "file": {
          const r = loadFileMock(rule.value);
          if (r) {
            mockStatus = mockStatus || 200;
            for (const [k, v] of r.headers.entries()) mockHeaders.set(k, v);
            mockBody = r.body;
            hasMock = true;
          }
          break;
        }
        case "dir": {
          const r = loadDirMock(rule.value, flow.request.path, rule.pattern);
          mockStatus = r ? mockStatus || 200 : 404;
          if (r) {
            for (const [k, v] of r.headers.entries()) mockHeaders.set(k, v);
            mockBody = r.body;
          } else {
            mockBody = Buffer.from("cnproxy: not found in mapped directory");
          }
          hasMock = true;
          break;
        }
        case "highlight":
          flow.color = rule.value || "yellow";
          break;
        case "mock":
        case "resbody": {
          const r = resolveBodyValue(rule.value);
          mockBody = r.body;
          if (r.contentType && !mockHeaders.has("content-type")) mockHeaders.set("content-type", r.contentType);
          mockStatus = mockStatus || 200;
          hasMock = true;
          break;
        }
        case "status":
          mockStatus = parseInt(rule.value, 10) || 200;
          hasMock = true;
          break;
        case "resheaders":
          applyHeaderSpec(mockHeaders, rule.value);
          hasMock = hasMock || mockHeaders.entries().length > 0;
          break;
        case "restype":
          mockHeaders.set("content-type", rule.value);
          break;
        // resreplace is response-phase only; ignore here
      }
    }

    if (hasMock) {
      directive.mock = {
        status: mockStatus || 200,
        headers: mockHeaders,
        body: mockBody ?? Buffer.alloc(0),
      };
      flow.mocked = true;
    }
    return directive;
  }

  private applyRewrite(flow: Flow, value: string): void {
    try {
      const u = new URL(value);
      flow.request.scheme = u.protocol === "https:" ? "https" : "http";
      flow.request.host = u.hostname;
      flow.request.port = u.port ? parseInt(u.port, 10) : flow.request.scheme === "https" ? 443 : 80;
      flow.request.path = u.pathname + u.search;
      flow.request.headers.set("host", u.host);
    } catch {
      // not a full URL — treat as path replacement
      flow.request.path = value;
    }
  }

  /**
   * True if any matching rule rewrites the response BODY (resReplace/resBody), meaning the full
   * body must be buffered before relay — such a flow cannot be streamed.
   */
  hasResponseBodyRule(flow: Flow): boolean {
    for (const rule of this.rules) {
      if (rule.op !== "resreplace" && rule.op !== "resbody" && rule.op !== "mock" && rule.op !== "file") continue;
      if (rule.match(flow)) return true;
    }
    return false;
  }

  // ---- response phase ----

  applyResponse(flow: Flow): void {
    if (!flow.response) return;
    for (const rule of this.rules) {
      if (!rule.match(flow)) continue;
      switch (rule.op) {
        case "resheaders":
          applyHeaderSpec(flow.response.headers, rule.value);
          flow.appliedRules.push("resHeaders");
          break;
        case "restype":
          flow.response.headers.set("content-type", rule.value);
          break;
        case "status":
          flow.response.statusCode = parseInt(rule.value, 10) || flow.response.statusCode;
          break;
        case "resreplace":
          flow.response.body = replaceBody(flow.response.body, rule.value);
          flow.appliedRules.push("resReplace");
          break;
      }
    }
  }
}

// ---- helpers ----

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRe(glob: string): RegExp {
  const re = glob
    .split("*")
    .map(escapeRe)
    .join(".*");
  return new RegExp("^" + re + "$", "i");
}

function parseHostPort(value: string, fallbackPort: number): { host: string; port: number } {
  const m = value.match(/^(.+?)(?::(\d+))?$/);
  if (!m) return { host: value, port: fallbackPort };
  return { host: m[1]!, port: m[2] ? parseInt(m[2], 10) : fallbackPort };
}

/** Header spec: JSON object, or newline/`&`-separated `name: value` / `name=value` pairs. */
function applyHeaderSpec(headers: Headers, spec: string): void {
  const trimmed = spec.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, string>;
      for (const [k, v] of Object.entries(obj)) {
        if (v === "") headers.delete(k);
        else headers.set(k, String(v));
      }
      return;
    } catch {
      /* fall through to k:v parsing */
    }
  }
  for (const part of trimmed.split(/[\n&]+/)) {
    const kv = part.match(/^\s*([^:=]+)\s*[:=]\s*([\s\S]*?)\s*$/);
    if (!kv) continue;
    const name = kv[1]!.trim();
    const val = kv[2]!;
    if (val === "") headers.delete(name);
    else headers.set(name, val);
  }
}

/** `find/replace` or `s/find/replace/` style body string substitution. */
function replaceBody(body: Buffer | null, spec: string): Buffer | null {
  if (!body) return body;
  let find = "";
  let repl = "";
  const s = spec.match(/^s\/((?:\\\/|[^/])*)\/((?:\\\/|[^/])*)\/?$/);
  if (s) {
    find = s[1]!.replace(/\\\//g, "/");
    repl = s[2]!.replace(/\\\//g, "/");
  } else {
    const idx = spec.indexOf("/");
    if (idx === -1) return body;
    find = spec.slice(0, idx);
    repl = spec.slice(idx + 1);
  }
  if (!find) return body;
  const text = body.toString("utf8").split(find).join(repl);
  return Buffer.from(text, "utf8");
}

function resolveBodyValue(value: string): { body: Buffer; contentType?: string } {
  if (value.startsWith("file://")) {
    const r = loadFileMock(value.slice("file://".length));
    if (r) return { body: r.body, contentType: r.headers.get("content-type") };
  }
  // JSON-ish?
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return { body: Buffer.from(trimmed, "utf8"), contentType: "application/json; charset=utf-8" };
  }
  return { body: Buffer.from(value, "utf8"), contentType: "text/plain; charset=utf-8" };
}

function loadFileMock(path: string): { headers: Headers; body: Buffer } | null {
  const p = path.replace(/^file:\/\//, "");
  if (!existsSync(p)) {
    log.warn("file rule: not found:", p);
    return null;
  }
  const body = readFileSync(p);
  const headers = new Headers();
  headers.set("content-type", guessType(p));
  return { headers, body };
}

/** Map a request path onto a local directory (map-local), guarding traversal. */
function loadDirMock(dir: string, reqPath: string, pattern: string): { headers: Headers; body: Buffer } | null {
  const base = resolve(dir.replace(/^file:\/\//, ""));
  let rel = (reqPath.split("?")[0] || "/");
  // Strip matched path prefix — works for both `/path` and `domain/path` patterns.
  let pathPrefix = pattern;
  if (!pattern.startsWith("/")) {
    const slashIdx = pattern.indexOf("/");
    pathPrefix = slashIdx !== -1 ? pattern.slice(slashIdx) : "";
  }
  if (pathPrefix && rel.startsWith(pathPrefix)) rel = rel.slice(pathPrefix.length);
  const pathname = decodeURIComponent(rel.replace(/^\/+/, ""));
  let target = resolve(join(base, pathname));
  // Reject path traversal outside the mapped directory.
  if (target !== base && !target.startsWith(base + sep)) return null;
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, "index.html");
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  const headers = new Headers();
  headers.set("content-type", guessType(target));
  return { headers, body: readFileSync(target) };
}

function guessType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    json: "application/json; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    mjs: "application/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
  };
  return map[ext] ?? "application/octet-stream";
}
