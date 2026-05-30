/**
 * Workspace persistence — API collections + environments, stored as a single
 * JSON file under the data directory. Environments hold `{{var}}` substitution values; an active
 * environment is applied to composed requests.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { RequestSpec } from "./composer.ts";

export interface Collection {
  name: string;
  requests: (RequestSpec & { name?: string })[];
}

export interface Workspace {
  activeEnv: string;
  environments: Record<string, Record<string, string>>;
  collections: Collection[];
}

const EMPTY: Workspace = { activeEnv: "", environments: {}, collections: [] };

function workspacePath(dataDir: string): string {
  return join(dataDir, "workspace.json");
}

export function loadWorkspace(dataDir: string): Workspace {
  const path = workspacePath(dataDir);
  if (!existsSync(path)) return structuredClone(EMPTY);
  try {
    return { ...structuredClone(EMPTY), ...(JSON.parse(readFileSync(path, "utf8")) as Workspace) };
  } catch {
    return structuredClone(EMPTY);
  }
}

export function saveWorkspace(dataDir: string, ws: Workspace): void {
  const path = workspacePath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ws, null, 2));
}

/** Resolve the active environment's variable map (empty if none active). */
export function activeEnvVars(ws: Workspace): Record<string, string> {
  return ws.environments[ws.activeEnv] ?? {};
}
