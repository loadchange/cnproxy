/**
 * Incremental WebSocket frame parser (RFC 6455) used purely for *capture*.
 * The proxy relays raw bytes untouched; a copy is fed here to extract messages
 * for display. Handles fragmentation, masking, and the common opcodes.
 */

import zlib from "node:zlib";
import { log } from "../logger.ts";

export interface ParsedMessage {
  type: "text" | "binary" | "ping" | "pong" | "close";
  data: Buffer;
}

/**
 * Encode a single (unfragmented) WebSocket frame. Client→server frames MUST be masked per
 * RFC 6455; server→client frames MUST NOT be. Used to inject messages into a live connection.
 */
export function encodeFrame(data: Buffer, opts: { masked: boolean; opcode?: number }): Buffer {
  const opcode = opts.opcode ?? (isProbablyText(data) ? 0x1 : 0x2);
  const len = data.length;
  const header: number[] = [0x80 | opcode]; // FIN + opcode
  let lenBytes: number[];
  if (len < 126) lenBytes = [len];
  else if (len < 65536) lenBytes = [126, (len >> 8) & 0xff, len & 0xff];
  else lenBytes = [127, 0, 0, 0, 0, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff];
  header.push((opts.masked ? 0x80 : 0) | lenBytes[0]!);
  header.push(...lenBytes.slice(1));
  if (!opts.masked) return Buffer.concat([Buffer.from(header), data]);
  // Deterministic-but-arbitrary mask key (randomness is unavailable in some runtimes here).
  const mask = Buffer.from([0xa1, 0xb2, 0xc3, 0xd4]);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i]! ^ mask[i & 3]!;
  return Buffer.concat([Buffer.from(header), mask, masked]);
}

function isProbablyText(b: Buffer): boolean {
  for (const byte of b) if (byte === 0 || (byte < 0x09 && byte !== 0x0a && byte !== 0x0d)) return false;
  return true;
}

export class WsFrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private isCompressed = false;
  public enableDeflate = false;

  /** Feed bytes; returns any complete application messages decoded so far. */
  push(chunk: Buffer): ParsedMessage[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: ParsedMessage[] = [];

    while (true) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const rsv1 = (b0 & 0x40) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buf.length < offset + 2) break;
        len = this.buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buf.length < offset + 8) break;
        // Only support payloads within Number range (plenty for capture).
        len = Number(this.buf.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskKey: Buffer | null = null;
      if (masked) {
        if (this.buf.length < offset + 4) break;
        maskKey = this.buf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buf.length < offset + len) break; // wait for full payload

      let payload = this.buf.subarray(offset, offset + len);
      if (maskKey) {
        const unmasked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i]! ^ maskKey[i & 3]!;
        payload = unmasked;
      }
      this.buf = this.buf.subarray(offset + len);

      // opcodes: 0 continuation, 1 text, 2 binary, 8 close, 9 ping, 10 pong
      if (opcode === 8 || opcode === 9 || opcode === 10) {
        const type = opcode === 8 ? "close" : opcode === 9 ? "ping" : "pong";
        out.push({ type, data: Buffer.from(payload) });
        continue;
      }

      if (opcode === 0) {
        this.fragments.push(Buffer.from(payload));
      } else {
        this.fragments = [Buffer.from(payload)];
        this.fragmentOpcode = opcode;
        this.isCompressed = this.enableDeflate && rsv1;
      }

      if (fin) {
        let data = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.isCompressed) {
          try {
            data = zlib.inflateRawSync(Buffer.concat([data, Buffer.from([0x00, 0x00, 0xff, 0xff])]));
          } catch (e: any) {
            log.debug("WS inflate error:", e.message);
          }
        }
        const type = this.fragmentOpcode === 2 ? "binary" : "text";
        out.push({ type, data });
      }
    }
    return out;
  }
}
