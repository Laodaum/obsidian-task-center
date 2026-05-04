// Unit tests for VAL-CORE-008: View projection does not own business collections.
// List/week/month/matrix project the same filtered task set into layout models.
// Today/TODO/Unscheduled/Completed/Dropped are QueryPresets, not view types.
//
// Also covers M2 scrutiny fixes:
//   - List sections from configured view.sections
//   - Week/month trays from explicit view.tray.filters
//   - Matrix 2D cells (X×Y intersection) with unmatched/multiMatch

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/query/projection.ts",
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--outdir=test/.compiled",
      "--loader:.ts=ts",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("esbuild compile failed:\n" + result.stderr);
  }
}

let compileErr = null;
try {
  compilePure();
} catch (e) {
  compileErr = e;
}

// ── Helpers ──

function effectiveTask(overrides = {}) {
  const base = {
    id: "test.md:L1",
    path: "test.md",
    line: 0,
    indent: "",
    checkbox: " ",
    status: "todo",
    title: "Test task",
    rawTitle: "Test task",
    rawLine: "- [ ] Test task",
    tags: [],
    scheduled: null,
    deadline: null,
    start: null,
    completed: null,
    cancelled: null,
    created: null,
    recurrence: null,
    priority: null,
    calloutDepth: 0,
    inlineFields: {},
    durationFields: {},
    estimate: null,
    actual: null,
    parentLine: null,
    parentIndex: null,
    childrenLines: [],
    hash: "abcdef123456",
    mtime: 1000,
    inheritsTerminal: false,
    inheritedTerminalKind: null,
    effectiveStatus: "todo",
    effectiveScheduled: null,
    effectiveDeadline: null,
    effectiveCreated: null,
    terminalInheritedFrom: null,
    renderParentId: null,
    isTopLevelInQuery: true,
    ...overrides,
  };
  return base;
}

// ── VAL-CORE-008: List projection ──

test("VAL-CORE-008: list view — all tasks in a single default section", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Task A", effectiveScheduled: "2026-05-04" }),
    effectiveTask({ id: "test.md:L2", title: "Task B", effectiveScheduled: null }),
    effectiveTask({ id: "test.md:L3", title: "Task C", effectiveScheduled: "2026-05-05" }),
  ];

  const model = applyViewProjection(tasks, { type: "list" }, 1);
  assert.equal(model.type, "list");
  assert.ok(Array.isArray(model.sections));
  assert.equal(model.sections.length, 1, "One default section");
  assert.equal(model.sections[0].tasks.length, 3);
});

test("VAL-CORE-008: list view — tasks sorted by orderBy", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "ZZZ Task", effectiveScheduled: null }),
    effectiveTask({ id: "test.md:L2", title: "AAA Task", effectiveScheduled: null }),
    effectiveTask({ id: "test.md:L3", title: "MMM Task", effectiveScheduled: null }),
  ];

  const model = applyViewProjection(
    tasks,
    { type: "list", orderBy: ["title_asc"] },
    1,
  );
  assert.equal(model.sections[0].tasks[0].title, "AAA Task");
  assert.equal(model.sections[0].tasks[1].title, "MMM Task");
  assert.equal(model.sections[0].tasks[2].title, "ZZZ Task");
});

// ── M2: List sections from configured view.sections ──

test("M2: list view — configured sections partition tasks by filter", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Work task", tags: ["#work"] }),
    effectiveTask({ id: "test.md:L2", title: "Personal task", tags: ["#personal"] }),
    effectiveTask({ id: "test.md:L3", title: "Both tags", tags: ["#work", "#personal"] }),
    effectiveTask({ id: "test.md:L4", title: "No tag", tags: [] }),
  ];

  const model = applyViewProjection(
    tasks,
    {
      type: "list",
      sections: [
        { id: "s-work", title: "Work", when: { tags: ["#work"] } },
        { id: "s-personal", title: "Personal", when: { tags: ["#personal"] } },
      ],
    },
    1,
  );

  assert.equal(model.type, "list");
  assert.equal(model.sections.length, 2, "Two configured sections");

  const workSection = model.sections.find((s) => s.title === "Work");
  const personalSection = model.sections.find((s) => s.title === "Personal");
  assert.ok(workSection, "Work section exists");
  assert.ok(personalSection, "Personal section exists");

  // Section filters are independent: each section gets tasks matching its own filter
  assert.equal(workSection.tasks.length, 2, "Work section has 2 tasks matching #work");
  assert.equal(personalSection.tasks.length, 2, "Personal section has 2 tasks matching #personal");
});

test("M2: list view — section with empty when includes all tasks", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Task A" }),
    effectiveTask({ id: "test.md:L2", title: "Task B" }),
  ];

  const model = applyViewProjection(
    tasks,
    {
      type: "list",
      sections: [
        { id: "s-all", title: "All Tasks", when: {} },
      ],
    },
    1,
  );

  assert.equal(model.sections.length, 1);
  assert.equal(model.sections[0].tasks.length, 2);
});

test("M2: list view — section limit caps task count", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Task A" }),
    effectiveTask({ id: "test.md:L2", title: "Task B" }),
    effectiveTask({ id: "test.md:L3", title: "Task C" }),
    effectiveTask({ id: "test.md:L4", title: "Task D" }),
  ];

  const model = applyViewProjection(
    tasks,
    {
      type: "list",
      sections: [
        { id: "s-limited", title: "Top 2", when: {}, limit: 2 },
      ],
    },
    1,
  );

  assert.equal(model.sections[0].tasks.length, 2, "Section limited to 2 tasks");
});

test("M2: list view — section-specific orderBy overrides view orderBy", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "ZZZ" }),
    effectiveTask({ id: "test.md:L2", title: "AAA" }),
    effectiveTask({ id: "test.md:L3", title: "MMM" }),
  ];

  const model = applyViewProjection(
    tasks,
    {
      type: "list",
      orderBy: ["title_desc"],
      sections: [
        { id: "s-asc", title: "Ascending", when: {}, orderBy: ["title_asc"] },
      ],
    },
    1,
  );

  assert.equal(model.sections[0].tasks[0].title, "AAA", "Section uses its own orderBy");
  assert.equal(model.sections[0].tasks[2].title, "ZZZ");
});

// ── VAL-CORE-008: Week projection ──

test("VAL-CORE-008: week view — 7 day columns with tasks grouped by effectiveScheduled", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04" }), // Monday
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-04" }), // Monday
    effectiveTask({ id: "test.md:L3", effectiveScheduled: "2026-05-06" }), // Wednesday
    effectiveTask({ id: "test.md:L4", effectiveScheduled: "2026-05-10" }), // Sunday
    effectiveTask({ id: "test.md:L5", effectiveScheduled: null }),          // unscheduled — not in any column
  ];

  const model = applyViewProjection(
    tasks,
    { type: "week" },
    1,
    "2026-05-04",
  );

  assert.equal(model.type, "week");
  assert.ok(Array.isArray(model.days));
  assert.equal(model.days.length, 7);

  // Monday (2026-05-04) should have 2 tasks
  const monday = model.days[0];
  assert.equal(monday.date, "2026-05-04");
  assert.equal(monday.tasks.length, 2);

  // Wednesday (2026-05-06) should have 1 task
  const wednesday = model.days[2];
  assert.equal(wednesday.date, "2026-05-06");
  assert.equal(wednesday.tasks.length, 1);

  // Total tasks in columns = 4 (null-scheduled task excluded)
  const totalInColumns = model.days.reduce((sum, d) => sum + d.tasks.length, 0);
  assert.equal(totalInColumns, 4);
});

test("VAL-CORE-008: week view — respects weekStartsOn=0 (Sunday)", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  // 2026-05-04 is Monday. With weekStartsOn=0 (Sunday), the week starts on May 3.
  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-03" }), // Sunday
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-04" }), // Monday
  ];

  const model = applyViewProjection(tasks, { type: "week" }, 0, "2026-05-04");

  assert.equal(model.days[0].date, "2026-05-03");
  assert.equal(model.days[0].tasks.length, 1);
  assert.equal(model.days[1].date, "2026-05-04");
  assert.equal(model.days[1].tasks.length, 1);
});

// ── M2: Week tray from explicit view.tray.filters ──

test("M2: week view — explicit tray filters produce independent tray", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04", title: "In week" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null, title: "Unscheduled" }),
    effectiveTask({ id: "test.md:L3", effectiveScheduled: null, title: "Also unscheduled" }),
  ];

  const model = applyViewProjection(
    tasks,
    {
      type: "week",
      tray: {
        enabled: true,
        title: "未排期",
        filters: {},  // all tasks — but deduped against main area
      },
    },
    1,
    "2026-05-04",
  );

  // Main area: task in week
  assert.equal(model.days[0].tasks.length, 1);

  // Tray: unscheduled tasks (excludes the one already in main area)
  assert.ok(model.tray, "Week should have a tray");
  assert.equal(model.tray.title, "未排期");
  assert.equal(model.tray.tasks.length, 2, "Tray has 2 unscheduled tasks not in main area");
  const trayIds = model.tray.tasks.map((t) => t.id).sort();
  assert.deepEqual(trayIds, ["test.md:L2", "test.md:L3"]);
});

test("M2: week view — tray with specific filter (unscheduled only)", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04", title: "Scheduled" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null, tags: ["#work"], title: "Unscheduled work" }),
    effectiveTask({ id: "test.md:L3", effectiveScheduled: null, tags: ["#personal"], title: "Unscheduled personal" }),
  ];

  const model = applyViewProjection(
    tasks,
    {
      type: "week",
      tray: {
        enabled: true,
        title: "未排期工作",
        filters: { tags: ["#work"] },
      },
    },
    1,
    "2026-05-04",
  );

  assert.ok(model.tray, "Tray exists");
  assert.equal(model.tray.tasks.length, 1, "Only 1 task matches tray filter");
  assert.equal(model.tray.tasks[0].id, "test.md:L2");
});

test("M2: week view — tray disabled produces no tray even with unscheduled tasks", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null }),
  ];

  const model = applyViewProjection(
    tasks,
    {
      type: "week",
      tray: {
        enabled: false,
        title: "未排期",
        filters: {},
      },
    },
    1,
    "2026-05-04",
  );

  assert.equal(model.tray, undefined, "No tray when disabled");
});

// ── VAL-CORE-008: Month projection ──

test("VAL-CORE-008: month view — calendar grid with tasks per date", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-01" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-15" }),
    effectiveTask({ id: "test.md:L3", effectiveScheduled: "2026-05-31" }),
  ];

  const model = applyViewProjection(
    tasks,
    { type: "month" },
    1,
    "2026-05-04",
  );

  assert.equal(model.type, "month");
  assert.ok(Array.isArray(model.cells));

  // Find cells with tasks
  const populatedCells = model.cells.filter((c) => c.tasks.length > 0);
  assert.equal(populatedCells.length, 3);
});

test("VAL-CORE-008: month view — empty cells still have date", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-01" }),
  ];

  const model = applyViewProjection(tasks, { type: "month" }, 1, "2026-05-04");

  // May 2026 has 31 days. Cells should cover the full month.
  assert.ok(model.cells.length >= 28, "At least 28 cells for a month");
  // Each cell has a date property
  for (const cell of model.cells) {
    assert.ok(cell.date, "Each cell has a date");
  }
});

// ── M2: Month tray from explicit view.tray.filters ──

test("M2: month view — explicit tray with filter", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-01", title: "In month" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null, title: "Unscheduled" }),
  ];

  const model = applyViewProjection(
    tasks,
    {
      type: "month",
      tray: {
        enabled: true,
        title: "未排期",
        filters: {},
      },
    },
    1,
    "2026-05-04",
  );

  assert.ok(model.tray, "Month should have a tray");
  assert.equal(model.tray.tasks.length, 1, "Tray has 1 unscheduled task");
  assert.equal(model.tray.tasks[0].id, "test.md:L2");
});

// ── VAL-CORE-008: Matrix projection (2D cells) ──

test("VAL-CORE-008: matrix view — 2D cells from X×Y bucket intersection", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Work + Active", tags: ["#work"], status: "todo", effectiveStatus: "todo" }),
    effectiveTask({ id: "test.md:L2", title: "Personal + Done", tags: ["#personal"], status: "done", effectiveStatus: "done" }),
    effectiveTask({ id: "test.md:L3", title: "Work + Done", tags: ["#work"], status: "done", effectiveStatus: "done" }),
    effectiveTask({ id: "test.md:L4", title: "Neither", tags: [], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = applyViewProjection(
    tasks,
    {
      type: "matrix",
      matrix: {
        x: {
          id: "x-tags",
          title: "Tags",
          buckets: [
            { id: "b-work", title: "Work", when: { tags: ["#work"] } },
            { id: "b-personal", title: "Personal", when: { tags: ["#personal"] } },
          ],
        },
        y: {
          id: "y-status",
          title: "Status",
          buckets: [
            { id: "s-todo", title: "TODO", when: { status: "todo" } },
            { id: "s-done", title: "Done", when: { status: "done" } },
          ],
        },
        unmatched: "show",
        multiMatch: "first",
        showEmptyBuckets: true,
      },
    },
    1,
  );

  assert.equal(model.type, "matrix");
  assert.ok(Array.isArray(model.cells), "Matrix has cells array");
  assert.ok(Array.isArray(model.unmatched), "Matrix has unmatched array");

  // 2 X buckets × 2 Y buckets = 4 cells
  assert.equal(model.cells.length, 4, "2×2 = 4 cells");

  // Check axis metadata
  assert.equal(model.xAxis.id, "x-tags");
  assert.equal(model.xAxis.title, "Tags");
  assert.equal(model.xAxis.buckets.length, 2);
  assert.equal(model.yAxis.id, "y-status");
  assert.equal(model.yAxis.title, "Status");
  assert.equal(model.yAxis.buckets.length, 2);

  // Cell: Work × TODO → task L1 and L3 (but L3 is done, so only L1 for TODO)
  const workTodoCell = model.cells.find((c) => c.rowId === "s-todo" && c.colId === "b-work");
  assert.ok(workTodoCell, "Work×TODO cell exists");
  assert.equal(workTodoCell.tasks.length, 1);
  assert.equal(workTodoCell.tasks[0].id, "test.md:L1");

  // Cell: Work × Done → task L3
  const workDoneCell = model.cells.find((c) => c.rowId === "s-done" && c.colId === "b-work");
  assert.ok(workDoneCell, "Work×Done cell exists");
  assert.equal(workDoneCell.tasks.length, 1);
  assert.equal(workDoneCell.tasks[0].id, "test.md:L3");

  // Cell: Personal × TODO → none (personal task L2 is done)
  const personalTodoCell = model.cells.find((c) => c.rowId === "s-todo" && c.colId === "b-personal");
  assert.ok(personalTodoCell, "Personal×TODO cell exists");
  assert.equal(personalTodoCell.tasks.length, 0);

  // Cell: Personal × Done → task L2
  const personalDoneCell = model.cells.find((c) => c.rowId === "s-done" && c.colId === "b-personal");
  assert.ok(personalDoneCell, "Personal×Done cell exists");
  assert.equal(personalDoneCell.tasks.length, 1);
  assert.equal(personalDoneCell.tasks[0].id, "test.md:L2");

  // Unmatched: task L4 (no tag) — matches neither X bucket
  assert.equal(model.unmatched.length, 1);
  assert.equal(model.unmatched[0].id, "test.md:L4");
});

test("VAL-CORE-008: matrix view — multiMatch=duplicate puts task in all matching cells", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Both tags", tags: ["#work", "#personal"], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = applyViewProjection(
    tasks,
    {
      type: "matrix",
      matrix: {
        x: {
          id: "x-tags",
          title: "Tags",
          buckets: [
            { id: "b-work", title: "Work", when: { tags: ["#work"] } },
            { id: "b-personal", title: "Personal", when: { tags: ["#personal"] } },
          ],
        },
        y: {
          id: "y-status",
          title: "Status",
          buckets: [
            { id: "s-todo", title: "TODO", when: { status: "todo" } },
          ],
        },
        unmatched: "show",
        multiMatch: "duplicate",
        showEmptyBuckets: true,
      },
    },
    1,
  );

  // L1 matches both Work×TODO and Personal×TODO
  const workTodoCell = model.cells.find((c) => c.rowId === "s-todo" && c.colId === "b-work");
  const personalTodoCell = model.cells.find((c) => c.rowId === "s-todo" && c.colId === "b-personal");

  assert.ok(workTodoCell, "Work×TODO cell exists");
  assert.ok(personalTodoCell, "Personal×TODO cell exists");
  assert.equal(workTodoCell.tasks.length, 1, "Task in Work×TODO");
  assert.equal(personalTodoCell.tasks.length, 1, "Task also in Personal×TODO with duplicate mode");
  assert.equal(workTodoCell.tasks[0].id, "test.md:L1");
  assert.equal(personalTodoCell.tasks[0].id, "test.md:L1");
});

test("VAL-CORE-008: matrix view — unmatched=hide removes unmatched tasks", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Has tag", tags: ["#work"], status: "todo" }),
    effectiveTask({ id: "test.md:L2", title: "No tag", tags: [], status: "todo" }),
  ];

  const model = applyViewProjection(
    tasks,
    {
      type: "matrix",
      matrix: {
        x: {
          id: "x-tags",
          title: "Tags",
          buckets: [
            { id: "b-work", title: "Work", when: { tags: ["#work"] } },
          ],
        },
        y: {
          id: "y-status",
          title: "Status",
          buckets: [
            { id: "s-todo", title: "TODO", when: { status: "todo" } },
          ],
        },
        unmatched: "hide",
        multiMatch: "first",
        showEmptyBuckets: true,
      },
    },
    1,
  );

  assert.equal(model.unmatched.length, 0, "Unmatched tasks hidden");
});

test("M2: matrix view — multiMatch=first only puts task in first matching cell", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Multi-match", tags: ["#work", "#personal"], status: "todo" }),
  ];

  const model = applyViewProjection(
    tasks,
    {
      type: "matrix",
      matrix: {
        x: {
          id: "x-tags",
          title: "Tags",
          buckets: [
            { id: "b-work", title: "Work", when: { tags: ["#work"] } },
            { id: "b-personal", title: "Personal", when: { tags: ["#personal"] } },
          ],
        },
        y: {
          id: "y-status",
          title: "Status",
          buckets: [
            { id: "s-todo", title: "TODO", when: { status: "todo" } },
          ],
        },
        unmatched: "show",
        multiMatch: "first",
        showEmptyBuckets: true,
      },
    },
    1,
  );

  // With multiMatch=first, the task should appear in only ONE cell
  const allCellTaskIds = model.cells.flatMap((c) => c.tasks.map((t) => t.id));
  const l1Count = allCellTaskIds.filter((id) => id === "test.md:L1").length;
  assert.equal(l1Count, 1, "Task appears exactly once with multiMatch=first");
});

test("M2: matrix view — empty buckets when no Y axis configured", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Has tag", tags: ["#work"] }),
  ];

  const model = applyViewProjection(
    tasks,
    {
      type: "matrix",
      matrix: {
        x: {
          id: "x-tags",
          title: "Tags",
          buckets: [
            { id: "b-work", title: "Work", when: { tags: ["#work"] } },
          ],
        },
        y: { id: "y-empty", title: "Empty", buckets: [] },
        unmatched: "show",
        multiMatch: "first",
        showEmptyBuckets: true,
      },
    },
    1,
  );

  // No Y buckets → no rows → no cells
  assert.equal(model.cells.length, 0, "No cells when Y axis has no buckets");
  assert.equal(model.unmatched.length, 1, "All tasks unmatched");
});

// ── VAL-CORE-008: Same tasks projected to different views ──

test("VAL-CORE-008: same filtered tasks projected to list, week, month produce different models", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-05" }),
    effectiveTask({ id: "test.md:L3", effectiveScheduled: null }),
  ];

  const listModel = applyViewProjection(tasks, { type: "list" }, 1);
  const weekModel = applyViewProjection(
    tasks,
    {
      type: "week",
      tray: { enabled: true, title: "未排期", filters: {} },
    },
    1,
    "2026-05-04",
  );
  const monthModel = applyViewProjection(
    tasks,
    {
      type: "month",
      tray: { enabled: true, title: "未排期", filters: {} },
    },
    1,
    "2026-05-04",
  );

  assert.equal(listModel.type, "list");
  assert.equal(weekModel.type, "week");
  assert.equal(monthModel.type, "month");

  // List contains all 3 tasks in default section
  const listTaskIds = listModel.sections[0].tasks.map((t) => t.id).sort();
  assert.deepEqual(listTaskIds, ["test.md:L1", "test.md:L2", "test.md:L3"]);

  // Week contains 2 scheduled in day columns + 1 unscheduled in tray
  const weekTaskIds = weekModel.days
    .flatMap((d) => d.tasks)
    .concat(weekModel.tray?.tasks ?? [])
    .map((t) => t.id)
    .sort();
  assert.deepEqual(weekTaskIds, ["test.md:L1", "test.md:L2", "test.md:L3"]);

  // Month contains 2 scheduled in cells + 1 unscheduled in tray
  const monthTaskIds = monthModel.cells
    .flatMap((c) => c.tasks)
    .concat(monthModel.tray?.tasks ?? [])
    .map((t) => t.id)
    .sort();
  assert.deepEqual(monthTaskIds, ["test.md:L1", "test.md:L2", "test.md:L3"]);
});

test("M2: tray does not duplicate tasks already in main date area", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04", title: "In week" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null, title: "Unscheduled" }),
  ];

  const model = applyViewProjection(
    tasks,
    {
      type: "week",
      tray: {
        enabled: true,
        title: "All",
        filters: {}, // matches everything
      },
    },
    1,
    "2026-05-04",
  );

  // Main area has L1
  assert.equal(model.days[0].tasks.length, 1);
  assert.equal(model.days[0].tasks[0].id, "test.md:L1");

  // Tray should NOT include L1 (already in main area)
  assert.ok(model.tray, "Tray exists");
  const trayIds = model.tray.tasks.map((t) => t.id);
  assert.ok(!trayIds.includes("test.md:L1"), "Tray excludes main area tasks");
  assert.ok(trayIds.includes("test.md:L2"), "Tray includes unscheduled task");
});

// ── Negative / edge cases ──

test("M2: matrix no config fallback — all tasks unmatched", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Task A" }),
    effectiveTask({ id: "test.md:L2", title: "Task B" }),
  ];

  const model = applyViewProjection(tasks, { type: "matrix" }, 1);

  assert.equal(model.type, "matrix");
  assert.equal(model.cells.length, 0, "No cells without matrix config");
  assert.equal(model.unmatched.length, 2, "All tasks unmatched");
});

test("M2: sections with no matching tasks produce empty sections", async () => {
  if (compileErr) throw compileErr;

  const { applyViewProjection } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Task A", tags: [] }),
  ];

  const model = applyViewProjection(
    tasks,
    {
      type: "list",
      sections: [
        { id: "s-empty", title: "No Match", when: { tags: ["#nonexistent"] } },
      ],
    },
    1,
  );

  assert.equal(model.sections.length, 1);
  assert.equal(model.sections[0].tasks.length, 0, "Section is empty when no tasks match filter");
});
