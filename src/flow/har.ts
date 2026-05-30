/**
 * HAR 1.2 export — the universal capture-interchange format (Chrome DevTools, Charles, Reqable,
 * Fiddler all read/write it). Lets users hand a captured session to any other tool. Bodies are
 * already stored decoded, so the HAR `content.text` is human-readable.
 */
import { Flow, CnResponse } from "./flow.ts";
import { Headers } from "./headers.ts";

interface HarNameValue {
  name: string;
  value: string;
}

function pairs(headers: Headers): HarNameValue[] {
  return headers.entries().map(([name, value]) => ({ name, value }));
}

function queryString(path: string): HarNameValue[] {
  const q = path.indexOf("?");
  if (q === -1) return [];
  const out: HarNameValue[] = [];
  for (const part of path.slice(q + 1).split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const name = eq === -1 ? part : part.slice(0, eq);
    const value = eq === -1 ? "" : part.slice(eq + 1);
    try {
      out.push({ name: decodeURIComponent(name), value: decodeURIComponent(value) });
    } catch {
      out.push({ name, value });
    }
  }
  return out;
}

function bodyText(body: Buffer | null): string {
  if (!body) return "";
  return body.toString("utf8");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function entry(flow: Flow) {
  const req = flow.request;
  const res = flow.response;
  const time = flow.duration ?? 0;
  const reqBody = req.body;
  return {
    startedDateTime: iso(req.timestampStart || flow.timestampCreated),
    time,
    request: {
      method: req.method,
      url: req.url,
      httpVersion: `HTTP/${req.httpVersion}`,
      headers: pairs(req.headers),
      queryString: queryString(req.path),
      cookies: [] as HarNameValue[],
      headersSize: -1,
      bodySize: reqBody?.length ?? 0,
      ...(reqBody && reqBody.length
        ? { postData: { mimeType: req.headers.get("content-type") ?? "application/octet-stream", text: bodyText(reqBody) } }
        : {}),
    },
    response: res
      ? {
          status: res.statusCode,
          statusText: res.reason,
          httpVersion: `HTTP/${res.httpVersion}`,
          headers: pairs(res.headers),
          cookies: [] as HarNameValue[],
          content: {
            size: res.body?.length ?? 0,
            mimeType: res.contentType || "application/octet-stream",
            text: bodyText(res.body),
          },
          redirectURL: res.headers.get("location") ?? "",
          headersSize: -1,
          bodySize: res.body?.length ?? 0,
        }
      : {
          status: 0,
          statusText: flow.error?.msg ?? "",
          httpVersion: "HTTP/1.1",
          headers: [] as HarNameValue[],
          cookies: [] as HarNameValue[],
          content: { size: 0, mimeType: "", text: "" },
          redirectURL: "",
          headersSize: -1,
          bodySize: 0,
        },
    cache: {},
    timings: { send: 0, wait: time, receive: 0 },
    _cnproxy: { id: flow.id, mocked: flow.mocked, marked: flow.marked, appliedRules: flow.appliedRules },
  };
}

/** Build a HAR 1.2 log from a set of flows (HTTP flows only; websockets are skipped). */
export function flowsToHar(flows: Flow[], version: string): object {
  return {
    log: {
      version: "1.2",
      creator: { name: "cnproxy", version },
      entries: flows.filter((f) => f.type === "http").map(entry),
    },
  };
}

/** Parse a HAR log into flows so a session captured elsewhere can be opened here. */
export function harToFlows(har: any): Flow[] {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) return [];
  const out: Flow[] = [];
  for (const e of entries) {
    const f = harEntryToFlow(e);
    if (f) out.push(f);
  }
  return out;
}

function harEntryToFlow(e: any): Flow | null {
  const req = e?.request;
  if (!req?.url) return null;
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return null;
  }
  const ts = Date.parse(e.startedDateTime) || 0;
  const flow = new Flow({ address: "har", port: 0, tls: u.protocol === "https:" }, ts);
  flow.request.scheme = u.protocol === "https:" ? "https" : "http";
  flow.request.host = u.hostname;
  flow.request.port = u.port ? parseInt(u.port, 10) : flow.request.scheme === "https" ? 443 : 80;
  flow.request.method = req.method || "GET";
  flow.request.path = u.pathname + u.search;
  flow.request.headers = new Headers((req.headers ?? []).map((h: HarNameValue) => [h.name, h.value] as [string, string]));
  if (req.postData?.text) flow.request.body = Buffer.from(req.postData.text, "utf8");
  flow.request.timestampStart = ts;
  flow.request.timestampEnd = ts;

  const r = e?.response;
  if (r && typeof r.status === "number" && r.status > 0) {
    const res = new CnResponse();
    res.statusCode = r.status;
    res.reason = r.statusText || "";
    res.headers = new Headers((r.headers ?? []).map((h: HarNameValue) => [h.name, h.value] as [string, string]));
    if (r.content?.text) res.body = Buffer.from(r.content.text, "utf8");
    res.timestampStart = ts;
    res.timestampEnd = ts + (e.time || 0);
    flow.response = res;
  }
  flow.comment = "imported from HAR";
  return flow;
}
