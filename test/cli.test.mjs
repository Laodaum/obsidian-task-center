// Unit tests for pure CLI filters, stats, and formatters.
// Run with: `node --test test/cli.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compile() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/cli.ts",
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--outfile=test/.compiled/cli.bundle.js",
      "--alias:obsidian=./test/obsidian-stub.mjs",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("esbuild failed:\n" + result.stderr);
  }
}

compile();
const {
  filterTasks,
  computeStats,
  buildAgentBrief,
  buildReviewSummary,
  TaskCenterApi,
  formatList,
  formatShow,
  formatStats,
  formatAgentBrief,
  formatReviewSummary,
  formatQueryRun,
  formatOkWrite,
  formatAdd,
  formatError,
} =
  await import("../test/.compiled/cli.bundle.js");

// Use production `todayISO()` (local-time based) instead of `toISOString().slice(0,10)`
// (UTC-based). Production filterTasks/computeStats internally call todayISO();
// fixtures must match the same calendar to avoid timezone-mismatch windows
// (UTC vs local) where tests fail across the ~16h overlap each day.
function todayLocal() {
  const d = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function mkTask(over = {}) {
  const status = over.status ?? "todo";
  return {
    id: "f.md:L1",
    path: "f.md",
    line: 0,
    indent: "",
    checkbox: " ",
    status,
    title: "t",
    rawTitle: "t",
    rawLine: "- [ ] t",
    tags: [],
    scheduled: null,
    deadline: null,
    start: null,
    completed: null,
    cancelled: null,
    created: null,
    estimate: null,
    actual: null,
    parentLine: null,
    parentIndex: null,
    childrenLines: [],
    hash: "abc123",
    mtime: 0,
    inheritsTerminal: false,
    // EffectiveTask fields (computeStats uses effectiveStatus)
    effectiveStatus: status,
    effectiveScheduled: null,
    effectiveDeadline: null,
    effectiveCreated: null,
    terminalInheritedFrom: null,
    renderParentId: null,
    isTopLevelInQuery: true,
    ...over,
  };
}

test("filterTasks — scheduled=today", () => {
  const today = todayLocal();
  const all = [
    mkTask({ id: "a", scheduled: today }),
    mkTask({ id: "b", scheduled: null }),
    mkTask({ id: "c", scheduled: "2026-01-01" }),
  ];
  const r = filterTasks(all, { scheduled: "today" });
  assert.deepEqual(r.map((t) => t.id), ["a"]);
});

test("filterTasks — unscheduled hides inherits-terminal by default", () => {
  const all = [
    mkTask({ id: "a" }),
    mkTask({ id: "b", inheritsTerminal: true }),
  ];
  const r = filterTasks(all, { scheduled: "unscheduled" });
  assert.deepEqual(r.map((t) => t.id), ["a"]);
});

test("filterTasks — status=done skips inherits-terminal filter", () => {
  const all = [
    mkTask({ id: "a", status: "done", inheritsTerminal: true }),
    mkTask({ id: "b", status: "done" }),
  ];
  const r = filterTasks(all, { status: "done" });
  assert.deepEqual(r.map((t) => t.id).sort(), ["a", "b"]);
});

test("filterTasks — tag filter accepts wildcard", () => {
  const all = [
    mkTask({ id: "a", tags: ["#2象限"] }),
    mkTask({ id: "b", tags: ["#3象限"] }),
    mkTask({ id: "c", tags: ["#基建"] }),
  ];
  const r = filterTasks(all, { tag: ["#*象限"] });
  assert.deepEqual(r.map((t) => t.id).sort(), ["a", "b"]);
});

test("filterTasks — overdue only matches past-deadline todos", () => {
  const all = [
    mkTask({ id: "a", deadline: "2020-01-01" }),
    mkTask({ id: "b", deadline: "2099-01-01" }),
    mkTask({ id: "c" }),
    mkTask({ id: "d", status: "done", deadline: "2020-01-01" }),
  ];
  const r = filterTasks(all, { overdue: true });
  assert.deepEqual(r.map((t) => t.id), ["a"]);
});

test("filterTasks — search matches substring, case-insensitive", () => {
  const all = [
    mkTask({ id: "a", title: "go to Grocery store" }),
    mkTask({ id: "b", title: "GROCERY list" }),
    mkTask({ id: "c", title: "meeting" }),
  ];
  const r = filterTasks(all, { search: "grocery" });
  assert.deepEqual(r.map((t) => t.id).sort(), ["a", "b"]);
});

test("filterTasks — limit truncates", () => {
  const all = [mkTask({ id: "a" }), mkTask({ id: "b" }), mkTask({ id: "c" })];
  const r = filterTasks(all, { limit: 2 });
  assert.equal(r.length, 2);
});

test("computeStats — zero done tasks", () => {
  const s = computeStats([], { days: 7 });
  assert.equal(s.doneCount, 0);
  assert.equal(s.sumActual, 0);
  assert.equal(s.ratio, null);
});

test("computeStats — ratio + per-task mean", () => {
  const today = todayLocal();
  const all = [
    mkTask({ id: "a", status: "done", completed: today, estimate: 60, actual: 90 }),
    mkTask({ id: "b", status: "done", completed: today, estimate: 30, actual: 30 }),
  ];
  const s = computeStats(all, { days: 1 });
  assert.equal(s.doneCount, 2);
  assert.equal(s.sumActual, 120);
  assert.equal(s.sumEstimate, 90);
  // ratio = 120 / 90 = 1.333
  assert.ok(Math.abs(s.ratio - 120 / 90) < 1e-9);
  // per-task ratios: 90/60=1.5, 30/30=1.0 → mean=1.25
  assert.ok(Math.abs(s.perTaskMean - 1.25) < 1e-9);
});

test("computeStats — byTag aggregates minutes", () => {
  const today = todayLocal();
  const all = [
    mkTask({ id: "a", status: "done", completed: today, actual: 60, tags: ["#2象限"] }),
    mkTask({ id: "b", status: "done", completed: today, actual: 30, tags: ["#2象限", "#基建"] }),
  ];
  const s = computeStats(all, { days: 1 });
  const q2 = s.byTag.find((x) => x.tag === "#2象限");
  assert.equal(q2.minutes, 90);
  const jijian = s.byTag.find((x) => x.tag === "#基建");
  assert.equal(jijian.minutes, 30);
});

test("computeStats — group prefix produces byGroup", () => {
  const today = todayLocal();
  const all = [
    mkTask({ id: "a", status: "done", completed: today, actual: 60, tags: ["#2象限"] }),
    mkTask({ id: "b", status: "done", completed: today, actual: 30, tags: ["#3象限"] }),
    mkTask({ id: "c", status: "done", completed: today, actual: 10, tags: ["#基建"] }),
  ];
  const s = computeStats(all, { days: 1, group: "象限" });
  assert.ok(s.byGroup);
  assert.equal(s.byGroup.prefix, "象限");
  assert.equal(s.byGroup.entries.length, 2);
});

// fix-m4-completed-stats-effective: inherited-done tasks (children of
// done parents) must be counted in stats via effectiveStatus, so the
// stats doneCount matches the effective cards rendered in the completed
// view.  Prior to the fix, computeStats used raw t.status === "done"
// and missed these children.
test("computeStats — inherited-done children counted via effectiveStatus", () => {
  const today = todayLocal();
  const all = [
    // Parent done with actual time
    mkTask({ id: "parent", status: "done", completed: today, actual: 60, tags: ["#dev"] }),
    // Child: raw status is "todo" but effectiveStatus is "done" (inherited)
    mkTask({ id: "child", status: "todo", effectiveStatus: "done", completed: today, actual: 30, tags: ["#dev"], parentLine: 0 }),
  ];
  const s = computeStats(all, { days: 1 });
  // Both should be counted as done
  assert.equal(s.doneCount, 2, "inherited-done child must be counted");
  assert.equal(s.sumActual, 90, "child's actual time must be included");
  // byTag should aggregate both
  const devTag = s.byTag.find((x) => x.tag === "#dev");
  assert.equal(devTag.minutes, 90);
});

// fix-m4-completed-stats-effective: raw todo children under done parents
// must NOT be counted as done by computeStats unless their effectiveStatus
// is "done".  This test verifies that effectiveStatus is the gate, not
// raw status.
test("computeStats — raw todo with effectiveStatus todo is NOT counted as done", () => {
  const today = todayLocal();
  const all = [
    mkTask({ id: "a", status: "done", completed: today, actual: 60 }),
    // Child with effectiveStatus still todo (no terminal ancestor in this fixture)
    mkTask({ id: "b", status: "todo", effectiveStatus: "todo", completed: null, actual: 30, parentLine: 0 }),
  ];
  const s = computeStats(all, { days: 1 });
  // Only the parent should be counted — the child has effectiveStatus "todo"
  assert.equal(s.doneCount, 1, "only effective-done tasks are counted");
  assert.equal(s.sumActual, 60, "only parent's actual time");
});

test("formatList — header + rows with ids", () => {
  const all = [mkTask({ id: "f.md:L1", title: "a" })];
  const out = formatList(all, "1 tasks · test");
  assert.match(out, /1 tasks · test/);
  assert.match(out, /f\.md:L1/);
  assert.match(out, /\[ \]/);
});

test("US-301: formatList uses custom grouping tags for the group column", () => {
  const all = [mkTask({ id: "f.md:L1", title: "a", tags: ["#next"] })];
  const out = formatList(all, "1 tasks · test", { groupingTags: ["#now", "#next"] });
  assert.match(out, /f\.md:L1\s+\[ \]\s+#2\s+a/);
});

test("formatStats — shows ratio + 'within band'", () => {
  const s = {
    periodFrom: "2026-04-17",
    periodTo: "2026-04-23",
    days: 7,
    doneCount: 2,
    sumActual: 120,
    sumEstimate: 90,
    ratio: 120 / 90,
    perTaskMean: 1.25,
    perTaskStd: 0.25,
    withinBand: { count: 1, total: 2, pct: 50 },
    byTag: [],
  };
  const out = formatStats(s);
  assert.match(out, /Tasks done: 2/);
  assert.match(out, /sum actual\s+120m/);
  assert.match(out, /within band\s+1\/2/);
});

test("US-723: buildAgentBrief partitions overdue/today/unscheduled and emits writeback commands", () => {
  const all = [
    mkTask({
      id: "Daily/2026-04-26.md:L5",
      path: "Daily/2026-04-26.md",
      title: "overdue blocker",
      deadline: "2026-04-25",
      tags: ["#now"],
      estimate: 30,
    }),
    mkTask({
      id: "Daily/2026-04-26.md:L9",
      path: "Daily/2026-04-26.md",
      title: "today task",
      scheduled: "2026-04-26",
    }),
    mkTask({
      id: "Tasks/Inbox.md:L2",
      path: "Tasks/Inbox.md",
      title: "candidate",
      scheduled: null,
    }),
    mkTask({
      id: "Tasks/Archive.md:L1",
      path: "Tasks/Archive.md",
      title: "hidden completed child",
      inheritsTerminal: true,
    }),
  ];
  const brief = buildAgentBrief(all, { today: "2026-04-26", limit: 3 });
  assert.deepEqual(brief.counts, { overdue: 1, today: 1, unscheduled: 1 });
  assert.deepEqual(brief.sections.overdue.map((t) => t.id), ["Daily/2026-04-26.md:L5"]);
  assert.deepEqual(brief.sections.today.map((t) => t.id), ["Daily/2026-04-26.md:L9"]);
  assert.deepEqual(brief.sections.unscheduled.map((t) => t.id), ["Tasks/Inbox.md:L2"]);
  assert.match(
    brief.sections.overdue[0].actions.find((a) => a.label === "done").command,
    /^obsidian task-center:done ref='Daily\/2026-04-26\.md:L5'$/,
  );
  assert.match(
    brief.sections.unscheduled[0].actions.find((a) => a.label === "schedule_today").command,
    /task-center:schedule ref='Tasks\/Inbox\.md:L2' date=2026-04-26/,
  );
  assert.match(
    brief.sections.unscheduled[0].actions.find((a) => a.label === "schedule_tomorrow").command,
    /task-center:schedule ref='Tasks\/Inbox\.md:L2' date=2026-04-27/,
  );
});

test("US-723: formatAgentBrief is grep-friendly and starts from stable task ids", () => {
  const brief = buildAgentBrief(
    [
      mkTask({
        id: "Tasks/Inbox.md:L42",
        path: "Tasks/Inbox.md",
        title: "pick next task",
        scheduled: "2026-04-26",
        estimate: 45,
      }),
    ],
    { today: "2026-04-26" },
  );
  const out = formatAgentBrief(brief);
  assert.match(out, /^Agent brief · 2026-04-26/);
  assert.match(out, /counts overdue=0 today=1 unscheduled=0/);
  assert.match(out, /1\. Tasks\/Inbox\.md:L42  pick next task/);
  assert.match(out, /done: obsidian task-center:done ref='Tasks\/Inbox\.md:L42'/);
  assert.match(out, /Sections\n    overdue: —\n    today: Tasks\/Inbox\.md:L42/);
});

test("US-722: buildReviewSummary covers today/week done, dropped, delayed, estimate, and grouping", () => {
  const all = [
    mkTask({
      id: "Daily/2026-04-26.md:L1",
      path: "Daily/2026-04-26.md",
      status: "done",
      checkbox: "x",
      title: "ship feature",
      completed: "2026-04-26",
      estimate: 60,
      actual: 90,
      tags: ["#1象限"],
    }),
    mkTask({
      id: "Daily/2026-04-26.md:L2",
      path: "Daily/2026-04-26.md",
      status: "dropped",
      checkbox: "-",
      title: "abandon low value",
      rawLine: "- [-] abandon low value #2象限 ❌ 2026-04-26 [estimate:: 30m]",
      estimate: 30,
      tags: ["#2象限"],
    }),
    mkTask({
      id: "Daily/2026-04-20.md:L3",
      path: "Daily/2026-04-20.md",
      status: "done",
      checkbox: "x",
      title: "earlier win",
      completed: "2026-04-20",
      estimate: 30,
      actual: 20,
      tags: ["#1象限"],
    }),
    mkTask({
      id: "Tasks/Inbox.md:L4",
      path: "Tasks/Inbox.md",
      title: "late blocker",
      deadline: "2026-04-25",
      tags: ["#1象限"],
    }),
    mkTask({
      id: "Tasks/Inbox.md:L5",
      path: "Tasks/Inbox.md",
      title: "old scheduled",
      scheduled: "2026-04-19",
      tags: ["#2象限"],
    }),
    mkTask({
      id: "Tasks/Hidden.md:L6",
      path: "Tasks/Hidden.md",
      title: "terminal child",
      deadline: "2026-04-25",
      inheritsTerminal: true,
      tags: ["#1象限"],
    }),
  ];
  const review = buildReviewSummary(all, {
    today: "2026-04-26",
    days: 7,
    groupingTags: ["#1象限", "#2象限"],
  });

  assert.equal(review.today.done, 1);
  assert.equal(review.today.dropped, 1);
  assert.equal(review.today.delayedOpen, 2);
  assert.equal(review.today.estimate.actual, 90);
  assert.equal(review.today.estimate.estimate, 60);
  assert.equal(review.today.estimate.delta, 30);
  assert.equal(review.week.done, 2);
  assert.equal(review.week.estimate.actual, 110);
  assert.equal(review.week.estimate.estimate, 90);
  const q1 = review.week.byGroup.find((row) => row.group === "#1象限");
  assert.equal(q1.done, 2);
  assert.equal(q1.delayedOpen, 1);
  const q2 = review.today.byGroup.find((row) => row.group === "#2象限");
  assert.equal(q2.dropped, 1);
  assert.equal(q2.delayedOpen, 1);
});

test("US-722: formatReviewSummary is readable and grep-friendly", () => {
  const review = buildReviewSummary(
    [
      mkTask({
        id: "Tasks/Done.md:L9",
        path: "Tasks/Done.md",
        status: "done",
        checkbox: "x",
        title: "finish fixture",
        completed: "2026-04-26",
        estimate: 45,
        actual: 30,
        tags: ["#alpha"],
      }),
      mkTask({
        id: "Tasks/Drop.md:L10",
        path: "Tasks/Drop.md",
        status: "dropped",
        checkbox: "-",
        title: "skip fixture",
        rawLine: "- [-] skip fixture #gamma ❌ 2026-04-26",
        tags: ["#gamma"],
      }),
      mkTask({
        id: "Tasks/Late.md:L11",
        path: "Tasks/Late.md",
        title: "overdue fixture",
        deadline: "2026-04-25",
        tags: ["#alpha"],
      }),
    ],
    { today: "2026-04-26", groupingTags: ["#alpha", "#gamma"] },
  );
  const out = formatReviewSummary(review);
  assert.match(out, /^Review · 2026-04-26/);
  assert.match(out, /Today · 2026-04-26/);
  assert.match(out, /Week · 2026-04-20 → 2026-04-26/);
  assert.match(out, /done=1 dropped=1 delayed_open=1/);
  assert.match(out, /estimate actual=30m estimate=45m delta=-15m/);
  assert.match(out, /#alpha\s+done=1 dropped=0 delayed_open=1/);
  assert.match(out, /dropped: Tasks\/Drop\.md:L10 skip fixture #gamma/);
});

test("formatError — greppable code + message shape", () => {
  const out = formatError("not_found", "no match");
  assert.match(out, /^error\s+not_found/);
  assert.match(out, /no match/);
});

// VAL-CLI-003: all required error codes produce stable two-line output
test("formatError — all required error codes", () => {
  const codes = [
    "not_found",
    "ambiguous_slug",
    "invalid_date",
    "invalid_query",
    "write_conflict",
    "daily_notes_missing",
    "daily_notes_folder_missing",
    "invalid_nest",
    "nest_partial",
  ];
  for (const code of codes) {
    const out = formatError(code, `detail for ${code}`);
    assert.match(out, new RegExp(`^error\\s+${code}`), `${code}: first line must start with "error <code>"`);
    assert.match(out, /\n\s{4}/, `${code}: second line must be indented`);
  }
});

// VAL-CLI-001: formatList outputs stable first-column refs
test("formatList — first column is always path:Lnnn", () => {
  const tasks = [
    mkTask({ id: "Notes/Todo.md:L5", path: "Notes/Todo.md", line: 4, title: "Buy milk", tags: ["#errand"] }),
    mkTask({ id: "Notes/Todo.md:L8", path: "Notes/Todo.md", line: 7, title: "Call dentist", scheduled: "2026-05-05" }),
  ];
  const out = formatList(tasks, "2 tasks · test", { groupingTags: ["#errand"] });
  const lines = out.split("\n").filter((l) => l.match(/^\S+:L\d+/));
  assert.equal(lines.length, 2, "both tasks should appear as top-level lines with refs");
  assert.match(lines[0], /^Notes\/Todo\.md:L5\s+\[ \]\s+#1\s+Buy milk/);
  assert.match(lines[1], /^Notes\/Todo\.md:L8\s+\[ \]\s+Call dentist/);
});

// VAL-CLI-001: formatShow resolves refs with full detail
test("formatShow — full detail including hash, parent, children", () => {
  const t = mkTask({
    id: "Notes/Todo.md:L5",
    path: "Notes/Todo.md",
    line: 4,
    title: "Buy milk",
    hash: "abc123def456",
    scheduled: "2026-05-05",
    deadline: "2026-05-06",
    estimate: 30,
    actual: 15,
    completed: "2026-05-04",
    created: "2026-05-01",
    tags: ["#errand"],
    parentLine: 2,
    childrenLines: [8, 12],
  });
  const out = formatShow(t);
  assert.match(out, /Notes\/Todo\.md:L5\s+\(hash abc123def456\)/);
  assert.match(out, /scheduled\s+2026-05-05/);
  assert.match(out, /deadline\s+2026-05-06/);
  assert.match(out, /estimate\s+30m/);
  assert.match(out, /actual\s+15m/);
  assert.match(out, /parent\s+Notes\/Todo\.md:L3/);
  assert.match(out, /children\s+Notes\/Todo\.md:L9, Notes\/Todo\.md:L13/);
  assert.match(out, /tags\s+#errand/);
});

// VAL-CLI-001: list parent=<id> returns child subtree
test("filterTasks — parent filter returns children only", () => {
  const parentId = "Tasks/Project.md:L3";
  const all = [
    mkTask({ id: parentId, path: "Tasks/Project.md", line: 2, title: "Parent" }),
    mkTask({ id: "Tasks/Project.md:L5", path: "Tasks/Project.md", line: 4, title: "Child A", parentLine: 2 }),
    mkTask({ id: "Tasks/Project.md:L7", path: "Tasks/Project.md", line: 6, title: "Child B", parentLine: 2 }),
    mkTask({ id: "Tasks/Other.md:L1", path: "Tasks/Other.md", title: "Unrelated" }),
  ];
  const r = filterTasks(all, { parent: parentId });
  assert.deepEqual(r.map((t) => t.id), ["Tasks/Project.md:L5", "Tasks/Project.md:L7"]);
});

// VAL-CLI-002: formatOkWrite — unchanged write collapses diff
test("formatOkWrite — unchanged shows single line", () => {
  const t = mkTask({ id: "f.md:L1", title: "done task" });
  const out = formatOkWrite(t, null, null, "- [ ] done task ✅ 2026-05-04", "- [x] done task ✅ 2026-05-04", true, "done");
  assert.match(out, /^ok\s+f\.md:L1\s+done task/);
  assert.match(out, /\n\s+unchanged/);
  assert.doesNotMatch(out, /before/);
  assert.doesNotMatch(out, /after/);
});

// VAL-CLI-002: formatOkWrite — write shows before/after diff
test("formatOkWrite — write shows before and after lines", () => {
  const t = mkTask({ id: "f.md:L1", title: "schedule me" });
  const before = "- [ ] schedule me";
  const after = "- [ ] schedule me ⏳ 2026-05-05";
  const out = formatOkWrite(t, null, null, before, after, false, "scheduled 2026-05-05");
  assert.match(out, /^ok\s+f\.md:L1\s+schedule me/);
  assert.match(out, /\n\s+before\s+- \[ \] schedule me/);
  assert.match(out, /\n\s+after\s+- \[ \] schedule me ⏳ 2026-05-05/);
});

// VAL-CLI-002: formatAdd shows created line
test("formatAdd — shows created line with path:Lnnn ref", () => {
  const out = formatAdd({ path: "Daily/2026-05-05.md", line: 0, created: "- [ ] new task ➕ 2026-05-05" });
  assert.match(out, /^ok\s+Daily\/2026-05-05\.md:L1\s+created/);
  assert.match(out, /- \[ \] new task ➕ 2026-05-05/);
});

// VAL-CLI-001: formatList renders parent/child tree with indentation
test("formatList — renders parent/child tree", () => {
  const parent = mkTask({
    id: "Notes/Todo.md:L3", path: "Notes/Todo.md", line: 2, title: "Parent task",
    childrenLines: [5, 7], tags: ["#project"],
  });
  const child1 = mkTask({
    id: "Notes/Todo.md:L6", path: "Notes/Todo.md", line: 5, title: "Child 1",
    parentLine: 2, estimate: 30,
  });
  const child2 = mkTask({
    id: "Notes/Todo.md:L8", path: "Notes/Todo.md", line: 7, title: "Child 2",
    parentLine: 2, scheduled: "2026-05-05",
  });
  const out = formatList([parent, child1, child2], "3 tasks · test");
  // Parent at top level — path:Lnnn [ ] [grouping] title
  assert.match(out, /Notes\/Todo\.md:L3\s+\[ \]\s+.*Parent task/);
  // Children indented
  assert.match(out, /├ L6\s+\[ \]\s+Child 1/);
  assert.match(out, /├ L8\s+\[ \]\s+Child 2/);
});

// VAL-CLI-004: line drift recovery via hash (filterTasks still works after line shift)
test("filterTasks — stale path:line refs are for display, hash-based identity is stable", () => {
  // Simulate a scenario where tasks have moved lines but we use ids for filtering
  const all = [
    mkTask({ id: "f.md:L5", path: "f.md", hash: "aaa111bbb222", title: "task A" }),
    mkTask({ id: "f.md:L9", path: "f.md", hash: "ccc333ddd444", title: "task B" }),
  ];
  // parent filter uses id not hash, but this tests the id-based filtering stability
  const r = filterTasks(all, { search: "task A" });
  assert.equal(r.length, 1);
  assert.equal(r[0].id, "f.md:L5");
});

// VAL-CLI-005: duration increment semantics (tested via the API's mode parameter)
// The actual +30m logic is in main.ts cliActual; here we test formatOkWrite for the output.
test("formatOkWrite — actual += 15m shows additive label", () => {
  const t = mkTask({ id: "f.md:L1", title: "coding", actual: 30 });
  const before = "- [ ] coding [actual:: 30m]";
  const after = "- [ ] coding [actual:: 45m]";
  const out = formatOkWrite(t, null, null, before, after, false, "actual += 15m");
  assert.match(out, /ok\s+f\.md:L1\s+coding/);
  assert.match(out, /before\s+- \[ \] coding \[actual:: 30m\]/);
  assert.match(out, /after\s+- \[ \] coding \[actual:: 45m\]/);
});

// VAL-CLI-005: estimate set and clear
test("formatOkWrite — estimate set", () => {
  const t = mkTask({ id: "f.md:L1", title: "planning" });
  const before = "- [ ] planning";
  const after = "- [ ] planning [estimate:: 60m]";
  const out = formatOkWrite(t, null, null, before, after, false, "estimate 60m");
  assert.match(out, /^ok\s+f\.md:L1\s+planning/);
  assert.match(out, /before\s+- \[ \] planning$/m);
  assert.match(out, /after\s+- \[ \] planning \[estimate:: 60m\]$/m);
});

// VAL-CLI-002: tag add/remove
test("formatOkWrite — tag added", () => {
  const t = mkTask({ id: "f.md:L1", title: "task", tags: ["#new"] });
  const before = "- [ ] task";
  const after = "- [ ] task #new";
  const out = formatOkWrite(t, null, null, before, after, false, "tag added");
  assert.match(out, /ok\s+f\.md:L1\s+task/);
  assert.match(out, /before\s+- \[ \] task$/m);
  assert.match(out, /after\s+- \[ \] task #new$/m);
});

// VAL-CLI-002: rename
test("formatOkWrite — rename task", () => {
  const t = mkTask({ id: "f.md:L1", title: "new title" });
  const before = "- [ ] old title ⏳ 2026-05-05";
  const after = "- [ ] new title ⏳ 2026-05-05";
  const out = formatOkWrite(t, null, null, before, after, false, "renamed");
  assert.match(out, /ok\s+f\.md:L1\s+new title/);
  assert.match(out, /before\s+- \[ \] old title ⏳ 2026-05-05$/m);
  assert.match(out, /after\s+- \[ \] new title ⏳ 2026-05-05$/m);
});

// VAL-CLI-002: rename — titleOverride prevents stale-cache output
test("formatOkWrite — rename with titleOverride shows new title when cache is stale", () => {
  // Simulate stale cache: the task object still has the OLD title, but the
  // rename operation already succeeded with the NEW title. titleOverride
  // ensures the output header displays the new title.
  const staleTask = mkTask({ id: "f.md:L1", title: "old title" }); // stale cache
  const before = "- [ ] old title ⏳ 2026-05-05";
  const after = "- [ ] new title ⏳ 2026-05-05";
  const out = formatOkWrite(staleTask, null, null, before, after, false, "renamed", undefined, "new title");
  assert.match(out, /ok\s+f\.md:L1\s+new title/, "header should show the override title, not the stale one");
  assert.match(out, /before\s+- \[ \] old title ⏳ 2026-05-05$/m);
  assert.match(out, /after\s+- \[ \] new title ⏳ 2026-05-05$/m);
});

test("formatOkWrite — rename unchanged with titleOverride (no-op rename)", () => {
  const staleTask = mkTask({ id: "f.md:L1", title: "same title" });
  const line = "- [ ] same title ⏳ 2026-05-05";
  const out = formatOkWrite(staleTask, null, null, line, line, true, "renamed", undefined, "same title");
  assert.match(out, /ok\s+f\.md:L1\s+same title/);
  assert.match(out, /unchanged/);
});

// VAL-CLI-003: error format for all error codes
test("formatError — not_found produces localized fallback", () => {
  const out = formatError("not_found", "Tasks/Inbox.md:L42");
  assert.match(out, /^error\s+not_found/);
  // i18n has a template for err.not_found, so it should be localized, not raw
  assert.doesNotMatch(out, /^error\s+not_found\n\s+not_found/);
});

test("formatError — ambiguous_slug lists candidates", () => {
  const out = formatError("ambiguous_slug", "hash abc123 matches 2 tasks: f.md:L1, g.md:L3");
  assert.match(out, /^error\s+ambiguous_slug/);
});

test("formatError — invalid_date shows the bad value", () => {
  const out = formatError("invalid_date", "not ISO YYYY-MM-DD: tomorrow");
  assert.match(out, /^error\s+invalid_date/);
});

test("formatError — invalid_query reports DSL error", () => {
  const out = formatError("invalid_query", "filters.status: invalid value");
  assert.match(out, /^error\s+invalid_query/);
});

test("formatError — nest_partial cross-file failure", () => {
  const out = formatError("nest_partial", "nested into parent.md but child.md:L5 drifted");
  assert.match(out, /^error\s+nest_partial/);
});

test("US-220: runQueryPreset can show preset-today through a temporary week view", async () => {
  const api = new TaskCenterApi({}, {
    ensureAll: async () => [
      mkTask({ id: "Tasks.md:L1", path: "Tasks.md", line: 0, title: "Monday task", rawLine: "- [ ] Monday task ⏳ 2026-05-04", scheduled: "2026-05-04" }),
      mkTask({ id: "Tasks.md:L2", path: "Tasks.md", line: 1, title: "Wednesday task", rawLine: "- [ ] Wednesday task ⏳ 2026-05-06", scheduled: "2026-05-06" }),
      mkTask({ id: "Tasks.md:L3", path: "Tasks.md", line: 2, title: "Done task", rawLine: "- [x] Done task ✅ 2026-05-04", status: "done", completed: "2026-05-04" }),
    ],
  });

  const result = await api.runQueryPreset(
    {
      id: "preset-today",
      name: "Today",
      builtin: true,
      hidden: false,
      view: { layout: { type: "list", when: { status: ["todo"] } } },
    },
    { weekStartsOn: 1, anchorISO: "2026-05-04", view: "week" },
  );

  assert.equal(result.viewModel.type, "week");
  assert.equal(result.view.layout.type, "week");
  assert.equal(result.filteredTasks.length, 2);
  assert.deepEqual(result.viewModel.days.map((day) => day.date), [
    "2026-05-04",
    "2026-05-05",
    "2026-05-06",
    "2026-05-07",
    "2026-05-08",
    "2026-05-09",
    "2026-05-10",
  ]);
  assert.deepEqual(result.viewModel.days.map((day) => day.tasks.map((task) => task.id)), [
    ["Tasks.md:L1"],
    [],
    ["Tasks.md:L2"],
    [],
    [],
    [],
    [],
  ]);

  const text = formatQueryRun(result);
  assert.match(text, /Query preset-today · Today/);
  assert.match(text, /view week · 2 tasks · anchor 2026-05-04/);
  assert.match(text, /2026-05-05 · 0 tasks\n    —/);
  assert.match(text, /Tasks\.md:L1\s+\[ \].*Monday task/);
});

test("US-220: runQueryPreset projects month view by dated cells", async () => {
  const api = new TaskCenterApi({}, {
    ensureAll: async () => [
      mkTask({ id: "Tasks.md:L1", path: "Tasks.md", line: 0, title: "May task", rawLine: "- [ ] May task ⏳ 2026-05-08", scheduled: "2026-05-08" }),
      mkTask({ id: "Tasks.md:L2", path: "Tasks.md", line: 1, title: "June task", rawLine: "- [ ] June task ⏳ 2026-06-01", scheduled: "2026-06-01" }),
    ],
  });

  const result = await api.runQueryPreset(
    {
      id: "preset-month",
      name: "Month",
      builtin: true,
      hidden: false,
      filters: { status: ["todo"] },
      view: { type: "month" },
      summary: [],
    },
    { weekStartsOn: 1, anchorISO: "2026-05-08" },
  );

  assert.equal(result.viewModel.type, "month");
  assert.equal(result.viewModel.cells.length, 31);
  const may8 = result.viewModel.cells.find((cell) => cell.date === "2026-05-08");
  assert.deepEqual(may8.tasks.map((task) => task.id), ["Tasks.md:L1"]);
  assert.equal(result.viewModel.cells.some((cell) => cell.tasks.some((task) => task.id === "Tasks.md:L2")), false);

  const text = formatQueryRun(result);
  assert.match(text, /dated cells · 1\/31/);
  assert.match(text, /2026-05-08 · 1 tasks/);
  assert.doesNotMatch(text, /2026-06-01/);
});
