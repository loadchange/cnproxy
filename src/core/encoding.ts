/**
 * Content-encoding (de)coding for capture + rewrite fidelity.
 *
 * We capture and let you edit the DECODED body even when the wire is gzip/br/deflate.
 * We decode on capture so the inspector and body filters
 * (~b/~bs) see real text and rules (resReplace/resBody) operate on real content. On the way out
 * we either relay the original bytes verbatim (untouched flows) or re-send the decoded body with
 * the content-encoding header stripped (modified flows) — never a corrupt half-encoded buffer.
 */
import zlib from "node:zlib";

/** Lowercased content-encoding tokens we can decode. */
export function isDecodable(encoding: string): boolean {
  const e = encoding.trim().toLowerCase();
  return e === "gzip" || e === "x-gzip" || e === "deflate" || e === "br";
}

/** Decode a compressed body. Returns the input unchanged on unknown/identity encodings or error. */
export function decodeBody(body: Buffer, encoding: string): Buffer {
  const e = encoding.trim().toLowerCase();
  try {
    switch (e) {
      case "gzip":
      case "x-gzip":
        return zlib.gunzipSync(body);
      case "deflate":
        // Some servers send raw deflate without zlib headers; try both.
        try {
          return zlib.inflateSync(body);
        } catch {
          return zlib.inflateRawSync(body);
        }
      case "br":
        return zlib.brotliDecompressSync(body);
      default:
        return body;
    }
  } catch {
    // Corrupt or not actually compressed — keep the raw bytes rather than throwing.
    return body;
  }
}
