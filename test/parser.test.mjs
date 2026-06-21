// Unit tests for pure parser helpers. No Obsidian dependency — Node's
// built-in test runner. Run with: `node --test test/parser.test.mjs`
//
// We import from a tiny hand-rolled ESM shim that re-exports only the pure
// functions under test — the real module is CommonJS after esbuild.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Compile the parser + dates to a small ESM bundle for the test run.
function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/parser.ts",
      "src/dates.ts",
      "src/tags.ts",
      "src/task-tree.ts",
      "src/query/filter.ts",
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--outdir=test/.compiled",
      "--loader:.ts=ts",
      "--alias:obsidian=./test/obsidian-stub.mjs",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("esbuild compile failed:\n" + result.stderr);
  }
}

compilePure();
const {
  parseDurationToMinutes,
  formatMinutes,
  parseInlineFields,
  cleanTitle,
  parseTaskLine,
  statusFromCheckbox,
  shortHash,
  parseTaskFromLine,
  parseFileTasks,
} = await import("../test/.compiled/parser.js");
const { deriveEffectiveTasks } = await import("../test/.compiled/task-tree.js");
const { applyQueryFilters } = await import("../test/.compiled/query/filter.js");
const { addDays, startOfWeek, endOfMonth, shiftMonth, resolveWhen, isValidISO } =
  await import("../test/.compiled/dates.js");

function fakeAppForContent(content, cache = null) {
  return {
    metadataCache: {
      getFileCache: () => cache,
    },
    vault: {
      cachedRead: async () => content,
    },
  };
}

function fakeFile(path = "test.md") {
  return {
    path,
    stat: { mtime: 1000 },
  };
}

test("parseDurationToMinutes", () => {
  assert.equal(parseDurationToMinutes("90m"), 90);
  assert.equal(parseDurationToMinutes("1h"), 60);
  assert.equal(parseDurationToMinutes("1h30m"), 90);
  assert.equal(parseDurationToMinutes("1.5h"), 90);
  assert.equal(parseDurationToMinutes("45"), 45);
  assert.equal(parseDurationToMinutes("45min"), 45);
  assert.equal(parseDurationToMinutes("bogus"), null);
  assert.equal(parseDurationToMinutes(""), null);
  assert.equal(parseDurationToMinutes(null), null);
});

test("formatMinutes", () => {
  assert.equal(formatMinutes(30), "30m");
  assert.equal(formatMinutes(60), "1h");
  assert.equal(formatMinutes(90), "1h30m");
  assert.equal(formatMinutes(125), "2h5m");
});

test("statusFromCheckbox", () => {
  assert.equal(statusFromCheckbox(" "), "todo");
  assert.equal(statusFromCheckbox("x"), "done");
  assert.equal(statusFromCheckbox("X"), "done");
  assert.equal(statusFromCheckbox("-"), "dropped");
  assert.equal(statusFromCheckbox("/"), "in_progress");
  assert.equal(statusFromCheckbox(">"), "cancelled");
  assert.equal(statusFromCheckbox("!"), "custom");
});

test("parseTaskLine — plain", () => {
  const r = parseTaskLine("- [ ] hello");
  assert.deepEqual(r, { indent: "", marker: "-", checkbox: " ", content: "hello" });
});

test("parseTaskLine — indented", () => {
  const r = parseTaskLine("    - [x] done");
  assert.deepEqual(r, { indent: "    ", marker: "-", checkbox: "x", content: "done" });
});

test("parseTaskLine — callout (single >)", () => {
  const r = parseTaskLine("> - [ ] callout");
  assert.equal(r?.indent, "> ");
  assert.equal(r?.checkbox, " ");
  assert.equal(r?.content, "callout");
});

test("parseTaskLine — nested callout", () => {
  const r = parseTaskLine(">  >  - [-] nested");
  assert.equal(r?.checkbox, "-");
  assert.equal(r?.content, "nested");
});

// US-125 task #33 — CRLF root cause. Lines pasted from external sources
// often carry trailing `\r` on each line (CRLF instead of LF).
// CHECKBOX_RE's `(.*)$` trailing capture greedily eats the `\r`, putting
// it into `content`. Downstream metadata parsers don't strip it, the
// task's hash is computed from a `\r`-tainted title, and the line
// quietly diverges from its sibling tasks — visually "missing" from the
// parent's card render.
test("parseTaskLine — strips trailing CR (CRLF)", () => {
  const r = parseTaskLine("    - [ ] Fixture child task(App A\\App B) ➕ 2026-04-26 ⏳ 2026-04-26\r");
  assert.equal(r?.checkbox, " ");
  // Critical: content must NOT carry trailing `\r`.
  assert.equal(
    r?.content,
    "Fixture child task(App A\\App B) ➕ 2026-04-26 ⏳ 2026-04-26",
  );
});

test("parseTaskLine — non-task returns null", () => {
  assert.equal(parseTaskLine("- plain bullet"), null);
  assert.equal(parseTaskLine("# heading"), null);
});

test("US-168: parseFileTasks raw fallback ignores fenced code block task examples", async () => {
  const content = [
    "Before",
    "```",
    "- [ ] Code example is not a task",
    "- [x] Completed example is not a task either",
    "```",
    "- [ ] Real task",
  ].join("\n");

  const tasks = await parseFileTasks(fakeAppForContent(content, null), fakeFile());

  assert.deepEqual(tasks.map((task) => task.title), ["Real task"]);
});

test("US-143/145: parseFileTasks raw fallback preserves parent-child hierarchy before metadata is indexed", async () => {
  const content = [
    "- [x] Done parent",
    "    - [ ] Todo child",
    "    - [ ] Another child",
  ].join("\n");

  const parsed = await parseFileTasks(fakeAppForContent(content, null), fakeFile());
  const effective = deriveEffectiveTasks(parsed);

  assert.equal(parsed[1].parentLine, 0);
  assert.equal(parsed[2].parentLine, 0);
  assert.deepEqual(parsed[0].childrenLines, [1, 2]);
  assert.equal(effective[1].effectiveStatus, "done");
  assert.equal(effective[2].effectiveStatus, "done");
  assert.equal(effective[1].isTopLevelInQuery, false);
  assert.equal(effective[2].isTopLevelInQuery, false);

  const todo = applyQueryFilters(effective, { status: "todo" }, 1);
  assert.deepEqual(todo.map((task) => task.title), []);
});

test("cleanTitle — strips emoji dates + tags + inline fields + block anchors", () => {
  const t = cleanTitle(
    "real title #tag1 📅 2026-05-15 ⏳ 2026-04-24 ➕ 2026-04-23 ✅ 2026-04-23 [estimate:: 30m] [actual:: 25m] ^abc123",
  );
  assert.equal(t, "real title");
});

test("US-108: cleanTitle strips arbitrary inline fields without treating names as app knowledge", () => {
  const t = cleanTitle("real title [planned:: 45m] [花了:: 30m] [owner:: fixture-user]");
  assert.equal(t, "real title");
});

test("US-108: parseInlineFields preserves field names and parses duration values generically", () => {
  const r = parseInlineFields(
    "task [estimate:: 1h] [planned:: 45m] [花了:: 30m] [owner:: fixture-user] [planned:: 15m]",
  );
  assert.deepEqual(r.inlineFields, {
    estimate: ["1h"],
    planned: ["45m", "15m"],
    花了: ["30m"],
    owner: ["fixture-user"],
  });
  assert.deepEqual(r.durationFields, {
    estimate: 60,
    planned: 60,
    花了: 30,
  });
});

test("cleanTitle — preserves wikilinks", () => {
  const t = cleanTitle("task with [[wikilink]] reference ⏳ 2026-04-24");
  assert.equal(t, "task with [[wikilink]] reference");
});

test("US-109d: parseTaskFromLine exposes only legal markdown tags", () => {
  const task = parseTaskFromLine(
    "Tasks/Inbox.md",
    0,
    "- [ ] task [[Note#Heading]] #第一象限、#第二象限 等。并通过`advance` #^624c3648-bca7-4ee2 #alpha/project",
    null,
    0,
  );
  assert.deepEqual(task?.tags, ["#第一象限", "#第二象限", "#alpha/project"]);
});

test("cleanTitle — recurrence swallow", () => {
  const t = cleanTitle("recurring task 🔁 every week ⏳ 2026-04-24");
  assert.equal(t, "recurring task");
});

test("shortHash — deterministic + stable length", () => {
  const h1 = shortHash("foo");
  const h2 = shortHash("foo");
  const h3 = shortHash("bar");
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(h1.length, 12);
});

test("addDays", () => {
  assert.equal(addDays("2026-04-23", 1), "2026-04-24");
  assert.equal(addDays("2026-04-23", -1), "2026-04-22");
  assert.equal(addDays("2026-04-30", 1), "2026-05-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("startOfWeek — Monday", () => {
  assert.equal(startOfWeek("2026-04-23", 1), "2026-04-20"); // Thu → Mon
  assert.equal(startOfWeek("2026-04-20", 1), "2026-04-20"); // already Mon
  assert.equal(startOfWeek("2026-04-19", 1), "2026-04-13"); // Sun → prior Mon
});

test("startOfWeek — Sunday", () => {
  assert.equal(startOfWeek("2026-04-23", 0), "2026-04-19"); // Thu → prior Sun
});

test("shiftMonth — end-of-month clamp", () => {
  assert.equal(shiftMonth("2026-01-31", 1), "2026-02-28"); // Feb has no 31
  assert.equal(shiftMonth("2026-03-31", -1), "2026-02-28");
  assert.equal(shiftMonth("2026-02-15", 1), "2026-03-15");
});

test("endOfMonth", () => {
  assert.equal(endOfMonth("2026-02-10"), "2026-02-28");
  assert.equal(endOfMonth("2024-02-10"), "2024-02-29"); // leap
});

test("resolveWhen", () => {
  assert.equal(resolveWhen("today", "2026-04-23").exact, "2026-04-23");
  assert.equal(resolveWhen("tomorrow", "2026-04-23").exact, "2026-04-24");
  assert.ok(resolveWhen("unscheduled").unscheduled);
  const wk = resolveWhen("week", "2026-04-23", 1);
  assert.equal(wk.from, "2026-04-20");
  assert.equal(wk.to, "2026-04-26");
  const range = resolveWhen("2026-04-01..2026-04-30");
  assert.equal(range.from, "2026-04-01");
  assert.equal(range.to, "2026-04-30");
});

test("isValidISO", () => {
  assert.ok(isValidISO("2026-04-23"));
  assert.ok(!isValidISO("2026-4-23"));
  assert.ok(!isValidISO("hello"));
  assert.ok(!isValidISO(null));
});

// ── VAL-CORE-001: Obsidian Tasks field coverage ──

test("VAL-CORE-001: parseTaskFromLine extracts Obsidian Tasks emoji fields", () => {
  const task = parseTaskFromLine(
    "test.md",
    0,
    "- [ ] task ⏳ 2026-04-24 📅 2026-05-15 🛫 2026-04-20 ✅ 2026-04-23 ❌ 2026-04-22 ➕ 2026-04-19",
    null,
    0,
  );
  assert.equal(task?.scheduled, "2026-04-24");
  assert.equal(task?.deadline, "2026-05-15");
  assert.equal(task?.start, "2026-04-20");
  assert.equal(task?.completed, "2026-04-23");
  assert.equal(task?.cancelled, "2026-04-22");
  assert.equal(task?.created, "2026-04-19");
});

test("US-111: parseTaskFromLine reads Dataview scheduled field when emoji is absent", () => {
  const task = parseTaskFromLine(
    "test.md",
    0,
    "- [ ] task [scheduled:: 2026-06-01]",
    null,
    0,
  );
  assert.equal(task?.scheduled, "2026-06-01");
  assert.deepEqual(task?.inlineFields.scheduled, ["2026-06-01"]);
});

test("US-111: emoji scheduled date wins over Dataview scheduled field", () => {
  const task = parseTaskFromLine(
    "test.md",
    0,
    "- [ ] task ⏳ 2026-06-02 [scheduled:: 2026-06-01]",
    null,
    0,
  );
  assert.equal(task?.scheduled, "2026-06-02");
});

test("US-111: only scheduled Dataview field maps to scheduled and invalid dates are ignored", () => {
  const task = parseTaskFromLine(
    "test.md",
    0,
    "- [ ] task [scheduled:: 2026-06-01] [planned:: 2026-06-02] [bad:: soon]",
    null,
    0,
  );
  const invalid = parseTaskFromLine(
    "test.md",
    1,
    "- [ ] task [bad:: soon]",
    null,
    0,
  );
  assert.equal(task?.scheduled, "2026-06-01");
  assert.equal(invalid?.scheduled, null);
});

test("US-111: parseTaskFromLine reads Dataview task date fields", () => {
  const task = parseTaskFromLine(
    "test.md",
    0,
    "- [x] task [created:: 2026-04-19] [start:: 2026-04-20] [scheduled:: 2026-04-24] [due:: 2026-05-15] [completion:: 2026-04-23] [cancelled:: 2026-04-22]",
    null,
    0,
  );
  assert.equal(task?.created, "2026-04-19");
  assert.equal(task?.start, "2026-04-20");
  assert.equal(task?.scheduled, "2026-04-24");
  assert.equal(task?.deadline, "2026-05-15");
  assert.equal(task?.completed, "2026-04-23");
  assert.equal(task?.cancelled, "2026-04-22");
});

test("US-111: Tasks emoji dates win over Dataview date fields", () => {
  const task = parseTaskFromLine(
    "test.md",
    0,
    "- [x] task ➕ 2026-04-19 ✅ 2026-04-23 📅 2026-05-15 [created:: 2026-01-01] [completion:: 2026-01-02] [due:: 2026-01-03]",
    null,
    0,
  );
  assert.equal(task?.created, "2026-04-19");
  assert.equal(task?.completed, "2026-04-23");
  assert.equal(task?.deadline, "2026-05-15");
});

test("VAL-CORE-001: parseTaskFromLine extracts priority emoji", () => {
  const high = parseTaskFromLine("test.md", 0, "- [ ] urgent task ⏫", null, 0);
  assert.equal(high?.priority, "⏫");

  const highest = parseTaskFromLine("test.md", 0, "- [ ] critical 🔺", null, 0);
  assert.equal(highest?.priority, "🔺");

  const medium = parseTaskFromLine("test.md", 0, "- [ ] normal task 🔼", null, 0);
  assert.equal(medium?.priority, "🔼");

  const low = parseTaskFromLine("test.md", 0, "- [ ] low prio 🔽", null, 0);
  assert.equal(low?.priority, "🔽");

  const lowest = parseTaskFromLine("test.md", 0, "- [ ] meh ⏬", null, 0);
  assert.equal(lowest?.priority, "⏬");

  // No priority
  const none = parseTaskFromLine("test.md", 0, "- [ ] plain task", null, 0);
  assert.equal(none?.priority, null);
});

test("US-111: parseTaskFromLine maps Dataview priority field to priority rank", () => {
  const high = parseTaskFromLine("test.md", 0, "- [ ] urgent task [priority:: high]", null, 0);
  assert.equal(high?.priority, "⏫");

  const lowest = parseTaskFromLine("test.md", 0, "- [ ] someday [priority:: lowest]", null, 0);
  assert.equal(lowest?.priority, "⏬");
});

test("VAL-CORE-001: parseTaskFromLine extracts recurrence", () => {
  const weekly = parseTaskFromLine(
    "test.md",
    0,
    "- [ ] review notes 🔁 every week ⏳ 2026-04-24",
    null,
    0,
  );
  assert.equal(weekly?.recurrence, "every week");

  const daily = parseTaskFromLine(
    "test.md",
    0,
    "- [ ] standup 🔁 every day",
    null,
    0,
  );
  assert.equal(daily?.recurrence, "every day");

  // No recurrence
  const none = parseTaskFromLine("test.md", 0, "- [ ] plain task", null, 0);
  assert.equal(none?.recurrence, null);
});

test("US-111: parseTaskFromLine reads Dataview repeat field as recurrence", () => {
  const task = parseTaskFromLine(
    "test.md",
    0,
    "- [ ] review notes [repeat:: every week when done]",
    null,
    0,
  );
  assert.equal(task?.recurrence, "every week when done");
});

test("VAL-CORE-001: parseTaskFromLine computes calloutDepth", () => {
  const plain = parseTaskFromLine("test.md", 0, "- [ ] plain task", null, 0);
  assert.equal(plain?.calloutDepth, 0);

  const single = parseTaskFromLine("test.md", 0, "> - [ ] callout task", null, 0);
  assert.equal(single?.calloutDepth, 1);

  const nested = parseTaskFromLine("test.md", 0, "> > - [x] deep callout", null, 0);
  assert.equal(nested?.calloutDepth, 2);

  const indentedCallout = parseTaskFromLine("test.md", 0, "    > - [ ] indented callout", null, 0);
  assert.equal(indentedCallout?.calloutDepth, 1);
});

test("VAL-CORE-001: empty-title task line is ignored", () => {
  const empty = parseTaskFromLine("test.md", 0, "- [ ]", null, 0);
  assert.equal(empty, null);

  const onlySpaces = parseTaskFromLine("test.md", 0, "- [ ]   ", null, 0);
  assert.equal(onlySpaces, null);
});

test("VAL-CORE-001: rawTitle preserves user literals", () => {
  const task = parseTaskFromLine(
    "test.md",
    0,
    "- [ ] my task #mytag [[wikilink]] 🔺 ⏳ 2026-04-24 📅 2026-05-15 [estimate:: 1h] [owner:: 我] ^block123",
    null,
    0,
  );
  // rawTitle must contain everything after the checkbox
  assert.ok(task?.rawTitle.includes("#mytag"));
  assert.ok(task?.rawTitle.includes("[[wikilink]]"));
  assert.ok(task?.rawTitle.includes("⏳ 2026-04-24"));
  assert.ok(task?.rawTitle.includes("[estimate:: 1h]"));
  assert.ok(task?.rawTitle.includes("[owner:: 我]"));
  assert.ok(task?.rawTitle.includes("^block123"));
  assert.ok(task?.rawTitle.includes("🔺"));
});

test("VAL-CORE-001: rawLine is the exact original line", () => {
  const raw = "- [ ] original line text  ⏳ 2026-04-24  ";
  const task = parseTaskFromLine("test.md", 0, raw, null, 0);
  assert.equal(task?.rawLine, raw);
});

test("VAL-CORE-001: duplicate tags are preserved in tags array but deduped in display", () => {
  const task = parseTaskFromLine(
    "test.md",
    0,
    "- [ ] task #tag1 #tag2 #tag1",
    null,
    0,
  );
  // tags array contains all hashtags including duplicates
  assert.deepEqual(task?.tags, ["#tag1", "#tag2", "#tag1"]);
});

test("bug#6: line with embedded checkbox - [ ] - [ ] does not hang", async () => {
  // When a line contains two checkbox patterns, the plugin must return
  // within bounded time — no infinite loop in ancestor-walking code.
  const content = "- [ ] - [ ] some task text\n";
  const app = fakeAppForContent(content);
  const file = { path: "test.md", stat: { mtime: 1000 } };
  const tasks = await parseFileTasks(app, file);
  // One task is parsed (first checkbox matches, rest is the content).
  assert.ok(tasks.length <= 1, "should not produce more than one task");
});

test("VAL-CORE-001: inline duration fields are parsed generically", () => {
  const task = parseTaskFromLine(
    "test.md",
    0,
    "- [ ] task [planned:: 2h] [spent:: 45m] [custom:: hello]",
    null,
    0,
  );
  assert.deepEqual(task?.inlineFields, {
    planned: ["2h"],
    spent: ["45m"],
    custom: ["hello"],
  });
  assert.deepEqual(task?.durationFields, {
    planned: 120,
    spent: 45,
  });
});
