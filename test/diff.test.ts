/**
 * Flow diff tool — locate deviations between two captured messages (Reqable's diff).
 */
import { test, expect } from "vitest";
import { diffLines, diffFlows } from "../src/api/diff.ts";
import { Flow, CnResponse } from "../src/flow/flow.ts";

test("diffLines marks added, removed, and unchanged lines", () => {
  const d = diffLines(["a", "b", "c"], ["a", "x", "c"]);
  expect(d).toEqual([
    { op: "same", text: "a" },
    { op: "del", text: "b" },
    { op: "add", text: "x" },
    { op: "same", text: "c" },
  ]);
});

function flowWith(path: string, body: string, status: number): Flow {
  const f = new Flow({ address: "x", port: 0, tls: false }, 0);
  f.request.method = "GET";
  f.request.path = path;
  const r = new CnResponse();
  r.statusCode = status;
  r.body = Buffer.from(body);
  f.response = r;
  return f;
}

test("diffFlows reports request and response deltas", () => {
  const a = flowWith("/v1/users", '{"n":1}', 200);
  const b = flowWith("/v2/users", '{"n":2}', 201);
  const d = diffFlows(a, b);
  // request line differs (path)
  expect(d.request.some((l) => l.op === "del" && l.text.includes("/v1/users"))).toBe(true);
  expect(d.request.some((l) => l.op === "add" && l.text.includes("/v2/users"))).toBe(true);
  // response status + body differ
  expect(d.response.some((l) => l.op === "del" && l.text.includes("200"))).toBe(true);
  expect(d.response.some((l) => l.op === "add" && l.text.includes("201"))).toBe(true);
  expect(d.response.some((l) => l.op === "add" && l.text.includes('"n":2'))).toBe(true);
});

test("identical flows diff to all-same", () => {
  const a = flowWith("/same", "body", 200);
  const b = flowWith("/same", "body", 200);
  const d = diffFlows(a, b);
  expect(d.request.every((l) => l.op === "same")).toBe(true);
  expect(d.response.every((l) => l.op === "same")).toBe(true);
});
