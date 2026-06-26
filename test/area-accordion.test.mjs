import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

// US-511 mobile single-open area accordion: the pure semantics live in
// src/view/area-accordion.ts (dependency-free) so they can be compiled and
// imported on their own, mirroring layout.test.mjs.
function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/view/area-accordion.ts",
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
const { defaultExpandedAreaIndex, resolveExpandedAreaIndex, nextExpandedAreaIndex } = await import(
  "../test/.compiled/view/area-accordion.js"
);

test("US-511 default open = first task-rendering area (week: index 0)", () => {
  // week.json: [week(rendersTasks), grid tray(rendersTasks), drop(no)]
  assert.equal(defaultExpandedAreaIndex([true, true, false]), 0);
});

test("US-511 default open skips leading non-rendering areas", () => {
  assert.equal(defaultExpandedAreaIndex([false, false, true]), 2);
});

test("US-511 default open falls back to 0 when nothing renders tasks", () => {
  assert.equal(defaultExpandedAreaIndex([false, false]), 0);
  assert.equal(defaultExpandedAreaIndex([]), 0);
});

test("US-511 resolve uses the stored choice when present", () => {
  assert.equal(resolveExpandedAreaIndex(2, 0), 2);
  // -1 (user collapsed the open one) is a real stored value, not "unset".
  assert.equal(resolveExpandedAreaIndex(-1, 0), -1);
});

test("US-511 resolve falls back to default when unset", () => {
  assert.equal(resolveExpandedAreaIndex(undefined, 3), 3);
});

test("US-511 single-open toggle: clicking another area opens it", () => {
  assert.equal(nextExpandedAreaIndex(0, 1), 1);
});

test("US-511 single-open toggle: re-clicking the open area collapses it", () => {
  assert.equal(nextExpandedAreaIndex(1, 1), -1);
});
