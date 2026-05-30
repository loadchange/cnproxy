/**
 * Flow diff tool — compare two captured flows (request + response, headers + body) and produce a
 * line-level diff, the way Reqable lets you locate deviations between two messages.
 */
import type { Flow } from "../flow/flow.ts";

export type DiffOp = "same" | "add" | "del";
export interface DiffLine {
  op: DiffOp;
  text: string;
}
export interface FlowDiff {
  request: DiffLine[];
  response: DiffLine[];
}

/** Longest-common-subsequence line diff (O(n*m), fine for message-sized inputs). */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: "del", text: a[i]! });
      i++;
    } else {
      out.push({ op: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ op: "del", text: a[i++]! });
  while (j < m) out.push({ op: "add", text: b[j++]! });
  return out;
}

function requestLines(f: Flow): string[] {
  const lines = [`${f.request.method} ${f.request.path} HTTP/${f.request.httpVersion}`];
  for (const [k, v] of f.request.headers.entries()) lines.push(`${k}: ${v}`);
  lines.push("");
  if (f.request.body) lines.push(...f.request.body.toString("utf8").split("\n"));
  return lines;
}

function responseLines(f: Flow): string[] {
  if (!f.response) return [];
  const lines = [`HTTP/${f.response.httpVersion} ${f.response.statusCode} ${f.response.reason}`];
  for (const [k, v] of f.response.headers.entries()) lines.push(`${k}: ${v}`);
  lines.push("");
  if (f.response.body) lines.push(...f.response.body.toString("utf8").split("\n"));
  return lines;
}

export function diffFlows(a: Flow, b: Flow): FlowDiff {
  return {
    request: diffLines(requestLines(a), requestLines(b)),
    response: diffLines(responseLines(a), responseLines(b)),
  };
}
