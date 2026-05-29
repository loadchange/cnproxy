/**
 * Incremental WebSocket frame parser (RFC 6455) used purely for *capture*.
 * The proxy relays raw bytes untouched; a copy is fed here to extract messages
 * for display. Handles fragmentation, masking, and the common opcodes.
 */

export interface ParsedMessage {
  type: "text" | "binary";
  data: Buffer;
}

export class WsFrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;

  /** Feed bytes; returns any complete application messages decoded so far. */
  push(chunk: Buffer): ParsedMessage[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: ParsedMessage[] = [];

    while (true) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      const fin = (b0 & 0x80) !== 0;
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
      if (opcode === 8 || opcode === 9 || opcode === 10) continue; // control frames: skip capture

      if (opcode === 0) {
        this.fragments.push(Buffer.from(payload));
      } else {
        this.fragments = [Buffer.from(payload)];
        this.fragmentOpcode = opcode;
      }

      if (fin) {
        const data = Buffer.concat(this.fragments);
        this.fragments = [];
        out.push({ type: this.fragmentOpcode === 2 ? "binary" : "text", data });
      }
    }
    return out;
  }
}
