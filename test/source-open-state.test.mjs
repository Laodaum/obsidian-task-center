import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/view/source-open-state.ts",
      "--bundle=false",
      "--format=esm",
      "--platform=node",
      "--outdir=test/.compiled/view",
      "--loader:.ts=ts",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("esbuild compile failed:\n" + result.stderr);
  }
}

compilePure();
const { markdownSourceOpenState } = await import("../test/.compiled/view/source-open-state.js");

test("US-168h: source editor open state carries both persisted and ephemeral line state", () => {
  assert.deepEqual(markdownSourceOpenState(11, true), {
    active: true,
    state: { line: 11 },
    eState: { line: 11 },
  });
});
