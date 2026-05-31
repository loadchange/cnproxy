/**
 * SOCKS4/4a/5 inbound negotiation. The public front peeks the first byte of every connection:
 * `0x05`/`0x04` means a SOCKS client, which we negotiate here and reduce to a target host:port —
 * after which the socket is routed exactly like a post-CONNECT tunnel (MITM TLS, plain HTTP, or
 * blind relay). No authentication is required (NO-AUTH).
 */
import type { Socket } from "node:net";

export interface SocksTarget {
  host: string;
  port: number;
}

/** A small exact-length reader over a socket's data stream, seeded with already-read bytes. */
function makeReader(socket: Socket, initial: Buffer) {
  let buf = initial;
  let done = false;
  const waiters: { n: number; resolve: (b: Buffer | null) => void }[] = [];
  const onData = (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    pump();
  };
  const onEnd = () => {
    done = true;
    for (const w of waiters.splice(0)) w.resolve(null);
  };
  socket.on("data", onData);
  socket.on("end", onEnd);
  socket.on("error", onEnd);
  function pump() {
    while (waiters.length && buf.length >= waiters[0]!.n) {
      const w = waiters.shift()!;
      const out = buf.subarray(0, w.n);
      buf = buf.subarray(w.n);
      w.resolve(out);
    }
  }
  return {
    read(n: number): Promise<Buffer | null> {
      if (done) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiters.push({ n, resolve });
        pump();
      });
    },
    /** Detach and return any bytes already buffered past the handshake. */
    release(): Buffer {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onEnd);
      return buf;
    },
  };
}

/**
 * Negotiate a SOCKS connection over `socket`, seeded with the already-read `initial` bytes.
 * Resolves the CONNECT target plus any payload bytes received past the handshake (`leftover`).
 * (We thread leftovers explicitly rather than `socket.unshift` for reliable cross-runtime behavior.)
 */
export async function negotiateSocks(
  socket: Socket,
  initial: Buffer,
  socksAuth?: { username: string; password: string } | null,
): Promise<{ target: SocksTarget; leftover: Buffer } | null> {
  const reader = makeReader(socket, initial);
  try {
    const ver = await reader.read(1);
    if (!ver) return null;
    const target = ver[0] === 0x05 ? await socks5(socket, reader, socksAuth) : ver[0] === 0x04 ? await socks4(socket, reader) : null;
    if (!target) return null;
    return { target, leftover: reader.release() };
  } catch {
    reader.release();
    return null;
  }
}

async function socks5(socket: Socket, reader: ReturnType<typeof makeReader>, socksAuth?: { username: string; password: string } | null): Promise<SocksTarget | null> {
  const nmethods = await reader.read(1);
  if (!nmethods) return null;
  const methods = await reader.read(nmethods[0]!);
  if (!methods) return null;

  if (socksAuth) {
    const offered = new Set(methods);
    if (!offered.has(0x02)) {
      socket.write(Buffer.from([0x05, 0xff]));
      return null;
    }
    socket.write(Buffer.from([0x05, 0x02]));
    const authVer = await reader.read(1);
    if (!authVer || authVer[0] !== 0x01) return null;
    const ulen = await reader.read(1);
    if (!ulen) return null;
    const uname = await reader.read(ulen[0]!);
    if (!uname) return null;
    const plen = await reader.read(1);
    if (!plen) return null;
    const passwd = await reader.read(plen[0]!);
    if (!passwd) return null;
    if (uname.toString("utf8") !== socksAuth.username || passwd.toString("utf8") !== socksAuth.password) {
      socket.write(Buffer.from([0x01, 0x01]));
      return null;
    }
    socket.write(Buffer.from([0x01, 0x00]));
  } else {
    socket.write(Buffer.from([0x05, 0x00]));
  }

  const head = await reader.read(4); // ver, cmd, rsv, atyp
  if (!head) return null;
  const [, cmd, , atyp] = head;
  if (cmd !== 0x01) {
    socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // command not supported
    return null;
  }

  let host: string;
  if (atyp === 0x01) {
    const a = await reader.read(4);
    if (!a) return null;
    host = `${a[0]}.${a[1]}.${a[2]}.${a[3]}`;
  } else if (atyp === 0x03) {
    const len = await reader.read(1);
    if (!len) return null;
    const name = await reader.read(len[0]!);
    if (!name) return null;
    host = name.toString("utf8");
  } else if (atyp === 0x04) {
    const a = await reader.read(16);
    if (!a) return null;
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) parts.push(a.readUInt16BE(i).toString(16));
    host = parts.join(":");
  } else {
    return null;
  }
  const portBuf = await reader.read(2);
  if (!portBuf) return null;
  const port = portBuf.readUInt16BE(0);

  // Success; bound address is irrelevant (we proxy), reply 0.0.0.0:0.
  socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
  return { host, port };
}

async function socks4(socket: Socket, reader: ReturnType<typeof makeReader>): Promise<SocksTarget | null> {
  const head = await reader.read(7); // cmd, port(2), ip(4)  (version byte already consumed)
  if (!head) return null;
  const cmd = head[0]!;
  const port = head.readUInt16BE(1);
  const ip = `${head[3]}.${head[4]}.${head[5]}.${head[6]}`;
  // userid (null-terminated)
  await readUntilNull(reader);
  let host = ip;
  // SOCKS4a: 0.0.0.x means a hostname follows the userid.
  if (head[3] === 0 && head[4] === 0 && head[5] === 0 && head[6] !== 0) {
    const name = await readUntilNull(reader);
    if (name) host = name.toString("utf8");
  }
  if (cmd !== 0x01) {
    socket.write(Buffer.from([0x00, 0x5b, 0, 0, 0, 0, 0, 0])); // rejected
    return null;
  }
  socket.write(Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0])); // granted
  return { host, port };
}

async function readUntilNull(reader: ReturnType<typeof makeReader>): Promise<Buffer | null> {
  const out: number[] = [];
  for (;;) {
    const b = await reader.read(1);
    if (!b) return null;
    if (b[0] === 0) break;
    out.push(b[0]!);
  }
  return Buffer.from(out);
}
