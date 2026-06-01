import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readWorkflow(name) {
  return readFile(`.github/workflows/${name}`, "utf8");
}

function assertLinuxObsidianE2eGate(workflow, filename) {
  assert.match(
    workflow,
    /Install Xvfb \+ Electron Linux deps/,
    `${filename} must install Xvfb and Electron runtime deps before Obsidian e2e`,
  );
  assert.match(
    workflow,
    /xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24"/,
    `${filename} must run WebDriverIO through xvfb-run on ubuntu`,
  );
  assert.match(
    workflow,
    /libgtk-3-0t64|libgtk-3-0/,
    `${filename} must provision GTK for the Linux Obsidian runtime`,
  );
  assert.match(
    workflow,
    /kernel\.apparmor_restrict_unprivileged_userns=0/,
    `${filename} must relax the Ubuntu 24.04 AppArmor userns restriction before Electron e2e`,
  );
}

test("ci workflow runs Obsidian e2e under Xvfb on ubuntu", async () => {
  const workflow = await readWorkflow("ci.yml");
  assertLinuxObsidianE2eGate(workflow, "ci.yml");
});

test("release workflow runs Obsidian e2e under Xvfb on ubuntu", async () => {
  const workflow = await readWorkflow("release.yml");
  assertLinuxObsidianE2eGate(workflow, "release.yml");
});

test("US-602: CI e2e script runs the full WebDriverIO suite, not only board-basics", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(
    pkg.scripts["test:e2e:ci"],
    "pnpm run build && wdio run ./wdio.conf.mts",
    "test:e2e:ci must match the documented full release/PR e2e gate",
  );
});

test("release workflow attests Obsidian release assets", async () => {
  const workflow = await readWorkflow("release.yml");

  assert.match(
    workflow,
    /id-token:\s*write/,
    "release.yml must allow OIDC token minting for Sigstore artifact attestations",
  );
  assert.match(
    workflow,
    /attestations:\s*write/,
    "release.yml must allow persisting GitHub artifact attestations",
  );
  assert.match(
    workflow,
    /uses:\s*actions\/attest@v4/,
    "release.yml must generate artifact attestations before publishing assets",
  );
  assert.match(workflow, /subject-path:\s*\|\s*[\s\S]*main\.js/);
  assert.match(workflow, /subject-path:\s*\|\s*[\s\S]*manifest\.json/);
  assert.match(workflow, /subject-path:\s*\|\s*[\s\S]*styles\.css/);
});

test("release notes diff from the previous strict semver tag only", async () => {
  const workflow = await readWorkflow("release.yml");

  assert.match(
    workflow,
    /git tag --list --sort=-v:refname \| grep -E '\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$' \| grep -v "\^\$\{TAG_VERSION\}\$" \| head -1/,
    "release notes must ignore non-release tags such as test-upload-delete-me when choosing the previous tag",
  );
});
