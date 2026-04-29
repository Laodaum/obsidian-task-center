import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "wdio-local-guard.mts",
      "--bundle=false",
      "--format=esm",
      "--platform=node",
      "--outdir=test/.compiled",
      "--loader:.mts=ts",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("esbuild compile failed:\n" + result.stderr);
  }
}

compilePure();
const { assertE2eRunsOnlyInCi } = await import("../test/.compiled/wdio-local-guard.js");

test("local macOS e2e is blocked before WebDriverIO starts", () => {
  assert.throws(
    () => assertE2eRunsOnlyInCi({}, "darwin"),
    /Local e2e is disabled on macOS/,
  );
});

test("GitHub Actions e2e is allowed on macOS and Linux runners", () => {
  assert.doesNotThrow(() => assertE2eRunsOnlyInCi({ CI: "true", GITHUB_ACTIONS: "true" }, "darwin"));
  assert.doesNotThrow(() => assertE2eRunsOnlyInCi({ CI: "true", GITHUB_ACTIONS: "true" }, "linux"));
});

test("non-GitHub-Actions e2e is blocked on every platform", () => {
  assert.throws(
    () => assertE2eRunsOnlyInCi({ CI: "true" }, "darwin"),
    /GitHub Actions CI/,
  );
  assert.throws(
    () => assertE2eRunsOnlyInCi({}, "linux"),
    /Run WebDriverIO e2e only in GitHub Actions CI/,
  );
});
