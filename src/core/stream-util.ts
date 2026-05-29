/**
 * Stream helpers for the proxy hot path.
 */

import type { Readable } from "node:stream";

/** Read a stream fully into one Buffer (bounded only by memory). */
export function collectBody(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** Slice a body for storage in a flow, marking truncation past `max`. */
export function boundForStorage(body: Buffer, max: number): { body: Buffer; truncated: boolean } {
  if (body.length <= max) return { body, truncated: false };
  return { body: body.subarray(0, max), truncated: true };
}
