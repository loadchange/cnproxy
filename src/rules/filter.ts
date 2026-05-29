/**
 * Flow filter expression language — a TypeScript port of the *concepts* in
 * mitmproxy's flowfilter.py. Compiles a string like `~m POST & ~u /api & !~c 200`
 * into a predicate `(flow) => boolean`.
 *
 * Supported atoms:
 *   ~u REGEX   url           ~d REGEX   domain/host
 *   ~m REGEX   method        ~c CODE    response status code (prefix match)
 *   ~h REGEX   any header    ~hq REGEX  request header   ~hs REGEX  response header
 *   ~b REGEX   any body      ~bq REGEX  request body     ~bs REGEX  response body
 *   ~t REGEX   content-type  ~q  has request (always)    ~s  has response
 *   ~a         asset (js/css/img/font/media)             ~e  has error
 *   ~marked    marked flows  ~websocket / ~http          flow type
 *   "naked regex"            defaults to ~u
 * Combinators: ! (not)  & (and)  | (or)  ( ) grouping.  Whitespace = implicit AND.
 */

import type { Flow } from "../flow/flow.ts";

export type Predicate = (flow: Flow) => boolean;

const ASSET_RE = /\.(?:js|mjs|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|mp4|webm|mp3)(?:$|\?)/i;

interface Token {
  type: "atom" | "(" | ")" | "&" | "|" | "!";
  code?: string;
  arg?: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "&" || ch === "|" || ch === "!") {
      tokens.push({ type: ch });
      i++;
      continue;
    }
    if (ch === "~") {
      // read code letters
      i++;
      let code = "";
      while (i < n && /[a-z]/.test(input[i]!)) code += input[i++]!;
      // optional argument (skip ws, then a quoted or bare token)
      while (i < n && /\s/.test(input[i]!) && needsArg(code)) i++;
      let arg = "";
      if (needsArg(code) && i < n && input[i] !== "&" && input[i] !== "|" && input[i] !== ")") {
        arg = readArg(input, () => i, (v) => (i = v));
      }
      tokens.push({ type: "atom", code, arg });
      continue;
    }
    // naked regex → ~u
    const arg = readArg(input, () => i, (v) => (i = v));
    tokens.push({ type: "atom", code: "u", arg });
  }
  return tokens;
}

function needsArg(code: string): boolean {
  return !["q", "s", "a", "e", "marked", "websocket", "http", "tcp"].includes(code);
}

function readArg(input: string, getI: () => number, setI: (v: number) => void): string {
  let i = getI();
  const n = input.length;
  if (input[i] === '"' || input[i] === "'") {
    const quote = input[i];
    i++;
    let out = "";
    while (i < n && input[i] !== quote) out += input[i++];
    i++; // closing quote
    setI(i);
    return out;
  }
  let out = "";
  while (i < n && !/\s/.test(input[i]!) && input[i] !== "&" && input[i] !== "|" && input[i] !== ")") {
    out += input[i++];
  }
  setI(i);
  return out;
}

// ---- atom predicates ----

function bodyText(flow: Flow): string {
  const r = flow.request.body?.toString("utf8") ?? "";
  const s = flow.response?.body?.toString("utf8") ?? "";
  return r + "\n" + s;
}

function headerText(entries: [string, string][]): string {
  return entries.map(([k, v]) => `${k}: ${v}`).join("\n");
}

function atomPredicate(code: string, arg: string): Predicate {
  let re: RegExp | null = null;
  if (arg) {
    try {
      re = new RegExp(arg, "i");
    } catch {
      re = new RegExp(escapeRe(arg), "i");
    }
  }
  const test = (s: string) => (re ? re.test(s) : true);

  switch (code) {
    case "u":
      return (f) => test(f.request.url);
    case "d":
      return (f) => test(f.request.prettyHost);
    case "m":
      return (f) => test(f.request.method);
    case "c":
      return (f) => (f.response ? String(f.response.statusCode).startsWith(arg) : false);
    case "t":
      return (f) => test(f.response?.contentType ?? "");
    case "h":
      return (f) =>
        test(headerText(f.request.headers.entries())) ||
        test(headerText(f.response?.headers.entries() ?? []));
    case "hq":
      return (f) => test(headerText(f.request.headers.entries()));
    case "hs":
      return (f) => test(headerText(f.response?.headers.entries() ?? []));
    case "b":
      return (f) => test(bodyText(f));
    case "bq":
      return (f) => test(f.request.body?.toString("utf8") ?? "");
    case "bs":
      return (f) => test(f.response?.body?.toString("utf8") ?? "");
    case "q":
      return () => true;
    case "s":
      return (f) => f.response !== null;
    case "e":
      return (f) => f.error !== null;
    case "a":
      return (f) => ASSET_RE.test(f.request.path);
    case "marked":
      return (f) => f.marked;
    case "websocket":
      return (f) => f.type === "websocket";
    case "http":
      return (f) => f.type === "http";
    default:
      return () => true;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- recursive-descent parser: or → and → unary → primary ----

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parse(): Predicate {
    if (!this.tokens.length) return () => true;
    const p = this.parseOr();
    return p;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private parseOr(): Predicate {
    let left = this.parseAnd();
    while (this.peek()?.type === "|") {
      this.pos++;
      const right = this.parseAnd();
      const l = left;
      left = (f) => l(f) || right(f);
    }
    return left;
  }

  private parseAnd(): Predicate {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (!t) break;
      if (t.type === "&") {
        this.pos++;
        const right = this.parseUnary();
        const l = left;
        left = (f) => l(f) && right(f);
      } else if (t.type === "atom" || t.type === "!" || t.type === "(") {
        // implicit AND
        const right = this.parseUnary();
        const l = left;
        left = (f) => l(f) && right(f);
      } else break;
    }
    return left;
  }

  private parseUnary(): Predicate {
    if (this.peek()?.type === "!") {
      this.pos++;
      const inner = this.parseUnary();
      return (f) => !inner(f);
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Predicate {
    const t = this.peek();
    if (!t) return () => true;
    if (t.type === "(") {
      this.pos++;
      const inner = this.parseOr();
      if (this.peek()?.type === ")") this.pos++;
      return inner;
    }
    if (t.type === "atom") {
      this.pos++;
      return atomPredicate(t.code!, t.arg ?? "");
    }
    this.pos++; // skip stray combinator
    return () => true;
  }
}

/** Compile a filter expression. Returns a predicate; empty/invalid → match-all. */
export function compileFilter(expr: string): Predicate {
  const trimmed = expr.trim();
  if (!trimmed) return () => true;
  try {
    return new Parser(tokenize(trimmed)).parse();
  } catch {
    return () => true;
  }
}
