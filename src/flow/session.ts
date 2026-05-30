/**
 * Session persistence — save/load captured flows to disk so they survive restarts and can be
 * revisited. Sessions are JSONL files (one FlowRecord per line) under
 * `<dataDir>/sessions/`, written with the `.cnp` extension.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Flow, type FlowRecord } from "./flow.ts";

export interface SessionInfo {
  name: string;
  path: string;
  size: number;
  flows: number;
  modified: number;
}

export function sessionsDir(dataDir: string): string {
  return join(dataDir, "sessions");
}

function sessionPath(dataDir: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(sessionsDir(dataDir), safe.endsWith(".cnp") ? safe : `${safe}.cnp`);
}

/** Write flows to a session file (JSONL of FlowRecord). Returns the absolute path. */
export function saveSession(dataDir: string, name: string, flows: Flow[]): string {
  const dir = sessionsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const path = sessionPath(dataDir, name);
  const lines = flows.map((f) => JSON.stringify(f.toRecord()));
  writeFileSync(path, lines.join("\n") + (lines.length ? "\n" : ""));
  return path;
}

/** Load flows from a session file. Accepts a bare name or an absolute path. */
export function loadSession(dataDir: string, nameOrPath: string): Flow[] {
  const path = nameOrPath.includes("/") ? nameOrPath : sessionPath(dataDir, nameOrPath);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const flows: Flow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      flows.push(Flow.fromRecord(JSON.parse(t) as FlowRecord));
    } catch {
      /* skip malformed line */
    }
  }
  return flows;
}

/** List saved sessions, newest first. */
export function listSessions(dataDir: string): SessionInfo[] {
  const dir = sessionsDir(dataDir);
  if (!existsSync(dir)) return [];
  const out: SessionInfo[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".cnp")) continue;
    const path = join(dir, file);
    const st = statSync(path);
    let flows = 0;
    try {
      flows = readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).length;
    } catch {
      /* ignore */
    }
    out.push({ name: file, path, size: st.size, flows, modified: st.mtimeMs });
  }
  return out.sort((a, b) => b.modified - a.modified);
}
