/**
 * Flow data model — the central unit of captured traffic.
 * Mirrors mitmproxy's HTTPFlow = Request + Response (+ error, websocket, metadata).
 */

import { Headers } from "./headers.ts";
import { randomUUID } from "node:crypto";

export interface ClientInfo {
  address: string;
  port: number;
  tls: boolean;
}

export class CnRequest {
  scheme: "http" | "https" = "http";
  host = "";
  port = 80;
  method = "GET";
  path = "/";
  httpVersion = "1.1";
  headers = new Headers();
  body: Buffer | null = null;
  /** True when the body was dropped because it exceeded maxBodySize. */
  bodyTruncated = false;
  timestampStart = 0;
  timestampEnd = 0;

  get url(): string {
    const defaultPort = this.scheme === "https" ? 443 : 80;
    const hostPart = this.port === defaultPort ? this.host : `${this.host}:${this.port}`;
    return `${this.scheme}://${hostPart}${this.path}`;
  }

  get prettyHost(): string {
    return this.headers.get("host")?.split(":")[0] || this.host;
  }
}

export class CnResponse {
  statusCode = 0;
  reason = "";
  httpVersion = "1.1";
  headers = new Headers();
  body: Buffer | null = null;
  bodyTruncated = false;
  timestampStart = 0;
  timestampEnd = 0;

  get contentType(): string {
    return this.headers.get("content-type") || "";
  }
}

export interface WebSocketMessage {
  fromClient: boolean;
  /** "text" | "binary" */
  type: "text" | "binary";
  content: Buffer;
  timestamp: number;
}

export class FlowError {
  constructor(public msg: string, public timestamp: number) {}
}

export type FlowType = "http" | "websocket";

/** Interception state: how a paused flow should be resumed. */
type ResumeResolver = (action: "resume" | "kill") => void;

export class Flow {
  readonly id: string;
  type: FlowType = "http";
  request: CnRequest;
  response: CnResponse | null = null;
  error: FlowError | null = null;
  client: ClientInfo;
  websocketMessages: WebSocketMessage[] = [];

  // metadata
  timestampCreated: number;
  marked = false;
  comment = "";
  /** Names of rules that touched this flow (for UI badges). */
  appliedRules: string[] = [];
  /** True when this flow's response was synthesized (mocked) rather than fetched. */
  mocked = false;

  // interception
  intercepted = false;
  private resumeResolver: ResumeResolver | null = null;

  constructor(client: ClientInfo, now: number, id?: string) {
    this.id = id ?? randomUUID();
    this.request = new CnRequest();
    this.client = client;
    this.timestampCreated = now;
  }

  get duration(): number | null {
    if (!this.response) return null;
    return this.response.timestampEnd - this.request.timestampStart;
  }

  /** Pause this flow; await the returned promise at a streaming boundary. */
  intercept(): Promise<"resume" | "kill"> {
    this.intercepted = true;
    return new Promise<"resume" | "kill">((resolve) => {
      this.resumeResolver = resolve;
    });
  }

  resume(): void {
    if (this.resumeResolver) {
      this.intercepted = false;
      this.resumeResolver("resume");
      this.resumeResolver = null;
    }
  }

  kill(): void {
    if (this.resumeResolver) {
      this.intercepted = false;
      this.resumeResolver("kill");
      this.resumeResolver = null;
    }
  }

  /** Lossless serialization for persistence (full fields + base64 bodies). */
  toRecord(): FlowRecord {
    const reqHdr = this.request.headers.entries();
    return {
      id: this.id,
      type: this.type,
      timestampCreated: this.timestampCreated,
      marked: this.marked,
      comment: this.comment,
      mocked: this.mocked,
      appliedRules: this.appliedRules,
      error: this.error ? { msg: this.error.msg, timestamp: this.error.timestamp } : null,
      client: this.client,
      request: {
        scheme: this.request.scheme,
        host: this.request.host,
        port: this.request.port,
        method: this.request.method,
        path: this.request.path,
        httpVersion: this.request.httpVersion,
        headers: reqHdr,
        body: this.request.body ? this.request.body.toString("base64") : null,
        bodyTruncated: this.request.bodyTruncated,
        timestampStart: this.request.timestampStart,
        timestampEnd: this.request.timestampEnd,
      },
      response: this.response
        ? {
            statusCode: this.response.statusCode,
            reason: this.response.reason,
            httpVersion: this.response.httpVersion,
            headers: this.response.headers.entries(),
            body: this.response.body ? this.response.body.toString("base64") : null,
            bodyTruncated: this.response.bodyTruncated,
            timestampStart: this.response.timestampStart,
            timestampEnd: this.response.timestampEnd,
          }
        : null,
      websocketMessages: this.websocketMessages.map((m) => ({
        fromClient: m.fromClient,
        type: m.type,
        content: m.content.toString("base64"),
        timestamp: m.timestamp,
      })),
    };
  }

  /** Reconstruct a flow from a persisted record. */
  static fromRecord(rec: FlowRecord): Flow {
    const flow = new Flow(rec.client, rec.timestampCreated, rec.id);
    flow.type = rec.type;
    flow.marked = rec.marked;
    flow.comment = rec.comment;
    flow.mocked = rec.mocked;
    flow.appliedRules = rec.appliedRules ?? [];
    flow.error = rec.error ? new FlowError(rec.error.msg, rec.error.timestamp) : null;
    const r = rec.request;
    flow.request.scheme = r.scheme;
    flow.request.host = r.host;
    flow.request.port = r.port;
    flow.request.method = r.method;
    flow.request.path = r.path;
    flow.request.httpVersion = r.httpVersion;
    flow.request.headers = new Headers(r.headers);
    flow.request.body = r.body ? Buffer.from(r.body, "base64") : null;
    flow.request.bodyTruncated = r.bodyTruncated;
    flow.request.timestampStart = r.timestampStart;
    flow.request.timestampEnd = r.timestampEnd;
    if (rec.response) {
      const res = new CnResponse();
      res.statusCode = rec.response.statusCode;
      res.reason = rec.response.reason;
      res.httpVersion = rec.response.httpVersion;
      res.headers = new Headers(rec.response.headers);
      res.body = rec.response.body ? Buffer.from(rec.response.body, "base64") : null;
      res.bodyTruncated = rec.response.bodyTruncated;
      res.timestampStart = rec.response.timestampStart;
      res.timestampEnd = rec.response.timestampEnd;
      flow.response = res;
    }
    flow.websocketMessages = rec.websocketMessages.map((m) => ({
      fromClient: m.fromClient,
      type: m.type,
      content: Buffer.from(m.content, "base64"),
      timestamp: m.timestamp,
    }));
    return flow;
  }

  /** Serializable summary for the flow list (no bodies). */
  toSummary(): FlowSummary {
    return {
      id: this.id,
      type: this.type,
      method: this.request.method,
      scheme: this.request.scheme,
      host: this.request.prettyHost,
      path: this.request.path,
      url: this.request.url,
      statusCode: this.response?.statusCode ?? null,
      contentType: this.response?.contentType ?? "",
      reqSize: this.request.body?.length ?? 0,
      resSize: this.response?.body?.length ?? 0,
      duration: this.duration,
      timestamp: this.timestampCreated,
      marked: this.marked,
      mocked: this.mocked,
      intercepted: this.intercepted,
      error: this.error?.msg ?? null,
      appliedRules: this.appliedRules,
      wsMessages: this.type === "websocket" ? this.websocketMessages.length : 0,
    };
  }

  /** Full detail including decoded-as-base64 bodies. */
  toDetail(): FlowDetail {
    return {
      ...this.toSummary(),
      request: {
        httpVersion: this.request.httpVersion,
        headers: this.request.headers.entries(),
        body: this.request.body ? this.request.body.toString("base64") : null,
        bodyTruncated: this.request.bodyTruncated,
      },
      response: this.response
        ? {
            statusCode: this.response.statusCode,
            reason: this.response.reason,
            httpVersion: this.response.httpVersion,
            headers: this.response.headers.entries(),
            body: this.response.body ? this.response.body.toString("base64") : null,
            bodyTruncated: this.response.bodyTruncated,
          }
        : null,
      websocketMessages: this.websocketMessages.map((m) => ({
        fromClient: m.fromClient,
        type: m.type,
        content: m.content.toString("base64"),
        timestamp: m.timestamp,
      })),
      client: this.client,
      comment: this.comment,
    };
  }
}

export interface FlowRecord {
  id: string;
  type: FlowType;
  timestampCreated: number;
  marked: boolean;
  comment: string;
  mocked: boolean;
  appliedRules: string[];
  error: { msg: string; timestamp: number } | null;
  client: ClientInfo;
  request: {
    scheme: "http" | "https";
    host: string;
    port: number;
    method: string;
    path: string;
    httpVersion: string;
    headers: [string, string][];
    body: string | null;
    bodyTruncated: boolean;
    timestampStart: number;
    timestampEnd: number;
  };
  response: {
    statusCode: number;
    reason: string;
    httpVersion: string;
    headers: [string, string][];
    body: string | null;
    bodyTruncated: boolean;
    timestampStart: number;
    timestampEnd: number;
  } | null;
  websocketMessages: { fromClient: boolean; type: "text" | "binary"; content: string; timestamp: number }[];
}

export interface FlowSummary {
  id: string;
  type: FlowType;
  method: string;
  scheme: string;
  host: string;
  path: string;
  url: string;
  statusCode: number | null;
  contentType: string;
  reqSize: number;
  resSize: number;
  duration: number | null;
  timestamp: number;
  marked: boolean;
  mocked: boolean;
  intercepted: boolean;
  error: string | null;
  appliedRules: string[];
  wsMessages: number;
}

export interface FlowDetail extends FlowSummary {
  request: {
    httpVersion: string;
    headers: [string, string][];
    body: string | null;
    bodyTruncated: boolean;
  };
  response: {
    statusCode: number;
    reason: string;
    httpVersion: string;
    headers: [string, string][];
    body: string | null;
    bodyTruncated: boolean;
  } | null;
  websocketMessages: { fromClient: boolean; type: string; content: string; timestamp: number }[];
  client: ClientInfo;
  comment: string;
}
