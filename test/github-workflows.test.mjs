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
