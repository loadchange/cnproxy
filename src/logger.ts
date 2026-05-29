/**
 * Tiny leveled logger with ANSI colors. No external deps — keeps the proxy hot path cheap.
 */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

let current: LogLevel = "info";
let useColor = process.stdout.isTTY ?? false;

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function setColor(on: boolean): void {
  useColor = on;
}

function paint(color: string, s: string): string {
  return useColor ? `${color}${s}${c.reset}` : s;
}

function ts(): string {
  // Avoid Date.now()-style nondeterminism concerns are irrelevant at runtime; fine here.
  const d = new Date();
  return d.toISOString().slice(11, 23);
}

function emit(level: LogLevel, color: string, tag: string, args: unknown[]): void {
  if (LEVELS[current] < LEVELS[level]) return;
  const prefix = `${paint(c.gray, ts())} ${paint(color, tag)}`;
  // eslint-disable-next-line no-console
  console.error(prefix, ...args);
}

export const log = {
  error: (...args: unknown[]) => emit("error", c.red, "ERR ", args),
  warn: (...args: unknown[]) => emit("warn", c.yellow, "WARN", args),
  info: (...args: unknown[]) => emit("info", c.cyan, "INFO", args),
  debug: (...args: unknown[]) => emit("debug", c.gray, "DBG ", args),
  /** Always-visible banner line, independent of level (unless silent). */
  banner: (msg: string) => {
    if (current === "silent") return;
    // eslint-disable-next-line no-console
    console.error(paint(c.green, msg));
  },
};

export const colors = c;
export const paintText = paint;
