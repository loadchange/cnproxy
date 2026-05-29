/**
 * Case-insensitive, order-preserving header collection (mitmproxy Headers analogue).
 * Stores raw [name, value] pairs so we can replay traffic faithfully, while offering
 * convenient case-insensitive get/set.
 */
export class Headers {
  private fields: [string, string][] = [];

  constructor(init?: [string, string][] | Record<string, string | string[]>) {
    if (Array.isArray(init)) {
      this.fields = init.map(([k, v]) => [k, v]);
    } else if (init) {
      for (const [k, v] of Object.entries(init)) {
        if (Array.isArray(v)) for (const item of v) this.fields.push([k, item]);
        else this.fields.push([k, v]);
      }
    }
  }

  /** Build from a Node http.IncomingMessage rawHeaders array [k,v,k,v,...]. */
  static fromRaw(raw: string[]): Headers {
    const h = new Headers();
    for (let i = 0; i + 1 < raw.length; i += 2) h.fields.push([raw[i]!, raw[i + 1]!]);
    return h;
  }

  get(name: string): string | undefined {
    const lower = name.toLowerCase();
    const matches = this.fields.filter(([k]) => k.toLowerCase() === lower);
    if (!matches.length) return undefined;
    // RFC 7230 folding for duplicates.
    return matches.map(([, v]) => v).join(", ");
  }

  has(name: string): boolean {
    const lower = name.toLowerCase();
    return this.fields.some(([k]) => k.toLowerCase() === lower);
  }

  /** Replace all occurrences of `name` with a single value. */
  set(name: string, value: string): void {
    const lower = name.toLowerCase();
    let placed = false;
    this.fields = this.fields.filter(([k]) => {
      if (k.toLowerCase() !== lower) return true;
      if (!placed) {
        placed = true;
        return true; // keep first slot, value rewritten below
      }
      return false;
    });
    if (placed) {
      const idx = this.fields.findIndex(([k]) => k.toLowerCase() === lower);
      this.fields[idx]![1] = value;
    } else {
      this.fields.push([name, value]);
    }
  }

  add(name: string, value: string): void {
    this.fields.push([name, value]);
  }

  delete(name: string): void {
    const lower = name.toLowerCase();
    this.fields = this.fields.filter(([k]) => k.toLowerCase() !== lower);
  }

  entries(): [string, string][] {
    return this.fields.map(([k, v]) => [k, v]);
  }

  /** Flatten to Node's outgoing header array form [k, v, k, v, ...]. */
  toFlat(): string[] {
    const out: string[] = [];
    for (const [k, v] of this.fields) out.push(k, v);
    return out;
  }

  toObject(): Record<string, string> {
    const o: Record<string, string> = {};
    for (const [k, v] of this.fields) {
      const lower = k.toLowerCase();
      o[lower] = lower in o ? `${o[lower]}, ${v}` : v;
    }
    return o;
  }

  clone(): Headers {
    return new Headers(this.entries());
  }
}
