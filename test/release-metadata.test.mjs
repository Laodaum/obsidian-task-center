import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("release metadata is ready for Obsidian community plugin submission", async () => {
  const [manifest, pkg, versions] = await Promise.all([
    readJson("manifest.json"),
    readJson("package.json"),
    readJson("versions.json"),
  ]);

  assert.equal(manifest.id, "task-center");
  assert.doesNotMatch(manifest.id, /obsidian/i);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(versions[manifest.version], manifest.minAppVersion);
  assert.equal(manifest.minAppVersion, "1.12.2");
  assert.ok(
    Object.values(versions).every((minAppVersion) => minAppVersion === "1.12.2"),
    "all published versions use native CLI APIs and must require Obsidian 1.12.2+",
  );
  assert.equal(manifest.name, "Task Center");
  assert.doesNotMatch(
    manifest.description,
    /\bobsidian\b/i,
    "community plugin descriptions must omit the platform name",
  );
  assert.equal(manifest.author, "CorrectRoadH");
  assert.equal(manifest.isDesktopOnly, false);
});

test("local plugin settings are not published as release defaults", async (t) => {
  const gitignore = await readFile(".gitignore", "utf8");
  assert.match(gitignore, /^data\.json$/m);

  // The tracking invariant can only be evaluated where a real repository (with
  // history) exists — every dev checkout and GitHub Actions CI. The remote test
  // box (crabbox external) is a synced working tree without .git, so skip the
  // git probe there rather than asserting against a non-existent repo.
  let inGitRepo = true;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "pipe" });
  } catch {
    inGitRepo = false;
  }
  if (!inGitRepo) {
    t.skip("no git work tree in this environment (e.g. crabbox synced box)");
    return;
  }

  assert.throws(
    () => execFileSync("git", ["ls-files", "--error-unmatch", "data.json"], { stdio: "pipe" }),
    /did not match any file\(s\) known to git/,
    "data.json is per-vault plugin state and must never be tracked in git",
  );
});

test("local lint gate mirrors Obsidian review bot required rules", async () => {
  const { default: eslintConfig } = await import("../eslint.config.mjs");
  const srcOverride = eslintConfig.find((entry) =>
    Array.isArray(entry.files) && entry.files.includes("src/**/*.ts")
  );

  assert.equal(srcOverride?.rules?.["@typescript-eslint/require-await"], "error");
  assert.equal(srcOverride?.rules?.["obsidianmd/ui/sentence-case"], undefined);
});
