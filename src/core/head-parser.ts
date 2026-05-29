/**
 * Peek and parse the head (request line + headers) of an HTTP message off a raw socket,
 * without consuming it from the data stream. Used by the router to decide how to handle a
 * connection (CONNECT vs WebSocket upgrade vs normal request) before any node:http parsing.
 */

import type { Duplex } from "node:stream";

export interface PeekedRequest {
  method: string;
  target: string;
  httpVersion: string;
  /** Raw header field pairs in order: [name, value, name, value, ...]. */
  rawHeaders: string[];
  /** Lower-cased header lookup. */
  headers: Map<string, string>;
  /** The full head bytes including the terminating CRLFCRLF. */
  headBuf: Buffer;
  /** Bytes already received past the head (start of body / first ws frame). */
  rest: Buffer;
}

const MAX_HEAD = 64 * 1024;

/** Resolve once the request head is fully buffered. The bytes are pushed back via `rest`. */
export function peekRequestHead(socket: Duplex): Promise<PeekedRequest | null> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) {
        if (buf.length > MAX_HEAD) finish(null);
        return;
      }
      const headBuf = buf.subarray(0, idx + 4);
      const rest = buf.subarray(idx + 4);
      finish(parse(headBuf, rest));
    };
    const onEnd = () => finish(null);
    const onErr = () => finish(null);

    function finish(result: PeekedRequest | null) {
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("error", onErr);
      resolve(result);
    }

    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onErr);
  });
}

function parse(headBuf: Buffer, rest: Buffer): PeekedRequest | null {
  const text = headBuf.toString("latin1");
  const lines = text.split("\r\n");
  const requestLine = lines[0] ?? "";
  const m = requestLine.match(/^(\S+)\s+(\S+)\s+HTTP\/(\d(?:\.\d)?)/);
  if (!m) return null;
  const rawHeaders: string[] = [];
  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.indexOf(":");
    if (c === -1) continue;
    const name = line.slice(0, c).trim();
    const value = line.slice(c + 1).trim();
    rawHeaders.push(name, value);
    headers.set(name.toLowerCase(), value);
  }
  return { method: m[1]!, target: m[2]!, httpVersion: m[3]!, rawHeaders, headers, headBuf, rest };
}
