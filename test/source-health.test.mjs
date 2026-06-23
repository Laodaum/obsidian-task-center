import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function read(path) {
  return readFile(path, "utf8");
}

test("US-602 quality gate rejects deprecated source dependencies", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  assert.equal(
    deps["builtin-modules"],
    undefined,
    "use Node's native builtinModules from node:module instead of builtin-modules",
  );
});

// pnpm 10 no longer reads `pnpm.overrides` from package.json; overrides live in
// pnpm-workspace.yaml. Parse that flat block instead of adding a YAML dep.
function parseWorkspaceOverrides(text) {
  const overrides = {};
  let inOverrides = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^overrides:\s*$/.test(line)) { inOverrides = true; continue; }
    if (!inOverrides) continue;
    if (/^\S/.test(line)) break; // dedent → left the overrides block
    const m = line.match(/^\s+(.+?):\s*(.+?)\s*$/);
    if (m) overrides[m[1].trim()] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return overrides;
}

test("US-602 quality gate pins reviewed dev-tool dependency advisories to patched ranges", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const overrides = parseWorkspaceOverrides(await read("pnpm-workspace.yaml"));

  assert.equal(overrides.diff, "^8.0.4");
  assert.equal(overrides["serialize-javascript"], "^7.0.5");
  assert.equal(overrides.lodash, "^4.18.1");
  assert.equal(overrides["fast-xml-builder"], "^1.2.0");
  assert.equal(overrides["fast-uri"], "^3.1.2");
  assert.match(pkg.devDependencies?.esbuild ?? "", /^\^0\.(2[5-9]|[3-9]\d)\./);
});

test("US-602 quality gate rejects Obsidian-incompatible CSS features", async () => {
  const css = await read("styles.css");

  assert.doesNotMatch(css, /\bcolumn-(width|gap|span)\s*:/, "avoid multicolumn CSS in Obsidian views");
  assert.doesNotMatch(css, /\bbreak-inside\s*:/, "avoid multicolumn break-inside CSS in Obsidian views");
  assert.doesNotMatch(css, /\btext-decoration-color\s*:/, "avoid partially supported text-decoration-color");
  assert.doesNotMatch(css, /\btext-indent\s*:/, "avoid css-text-indent for visually hiding labels");
  assert.doesNotMatch(css, /!important\b/, "override Obsidian styles with scoped classes instead of !important");
  assert.doesNotMatch(css, /:has\(/, "avoid :has() in plugin CSS because it broadens selector invalidation");
});

test("US-602 quality gate rejects duplicate unscheduled CSS selectors", async () => {
  const css = await read("styles.css");
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const count = [...withoutComments.matchAll(/\.task-center-view\s+\.bt-unscheduled-col-head\s*\{/g)].length;

  // Selector may be absent (feature removed in the 1.0 area-layout refactor);
  // the guard is "never duplicated", so 0 or 1 is acceptable.
  assert.ok(count <= 1, "bt-unscheduled-col-head rules should be merged instead of duplicated");
});

test("US-102/US-305: month mini cards expose distinct todo/done/dropped states", async () => {
  const source = await read("src/view.ts");
  const css = await read("styles.css");

  assert.match(
    source,
    /chip\.dataset\.taskStatus\s*=\s*t\.effectiveStatus/,
    "month mini cards should expose effectiveStatus for stable UI/state assertions",
  );
  assert.match(
    source,
    /chip\.addClass\(`bt-mini-card-\$\{t\.effectiveStatus\}`\)/,
    "month mini cards should add a status class derived from effectiveStatus",
  );
  assert.match(
    css,
    /\.task-center-view\s+\.bt-mini-card\.bt-mini-card-done\s*\{/,
    "done month mini cards need their own visual treatment",
  );
  assert.match(
    css,
    /\.task-center-view\s+\.bt-mini-card\.bt-mini-card-dropped\s*\{/,
    "dropped month mini cards need a visual treatment distinct from done",
  );
});
