// Unit tests for VAL-CORE-008: View projection does not own business collections.
// List/week/month/matrix project the same filtered task set into per-area models.
// Today/TODO/Unscheduled/Completed/Dropped are QueryPresets, not view types.
//
// The view model is now a SwiftUI-style layout tree (row/col stacks of area
// leaves); each area projects independently via a per-area projector. The old
// single-view `applyViewProjection` is gone.
//
//   - projectListArea(tasks, ListAreaConfig, weekStartsOn)
//   - projectWeekArea(tasks, WeekAreaConfig, weekStartsOn, anchorISO)
//   - projectMonthArea(tasks, MonthAreaConfig, anchorISO)
//   - projectMatrixArea(tasks, MatrixAreaConfig, weekStartsOn)  // x/y/... inlined
//
// Trays are no longer embedded in week/month projections; a tray is a separate
// list area in the layout. We model "tray" behavior by projecting a list area
// whose `when` selects unscheduled tasks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/query/projection.ts",
      "--bundle=true",
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

test("VAL-CORE-008: list area — all tasks in a single ungrouped section", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Task A", effectiveScheduled: "2026-05-04" }),
    effectiveTask({ id: "test.md:L2", title: "Task B", effectiveScheduled: null }),
    effectiveTask({ id: "test.md:L3", title: "Task C", effectiveScheduled: "2026-05-05" }),
  ];

  const model = projectListArea(tasks, { type: "list" }, 1);
  assert.equal(model.type, "list");
  assert.equal(model.grouped, false, "No sections → ungrouped");
  assert.ok(Array.isArray(model.sections));
  assert.equal(model.sections.length, 1, "One default section");
  assert.equal(model.sections[0].title, "", "Ungrouped section has empty title");
  assert.equal(model.sections[0].tasks.length, 3);
});

test("VAL-CORE-008: list area — tasks sorted by orderBy", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "ZZZ Task", effectiveScheduled: null }),
    effectiveTask({ id: "test.md:L2", title: "AAA Task", effectiveScheduled: null }),
    effectiveTask({ id: "test.md:L3", title: "MMM Task", effectiveScheduled: null }),
  ];

  const model = projectListArea(
    tasks,
    { type: "list", orderBy: ["title_asc"] },
    1,
  );
  assert.equal(model.grouped, false);
  assert.equal(model.sections[0].tasks[0].title, "AAA Task");
  assert.equal(model.sections[0].tasks[1].title, "MMM Task");
  assert.equal(model.sections[0].tasks[2].title, "ZZZ Task");
});

// ── M2: List sections from configured area.sections ──

test("M2: list area — configured sections partition tasks by filter", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Work task", tags: ["#work"] }),
    effectiveTask({ id: "test.md:L2", title: "Personal task", tags: ["#personal"] }),
    effectiveTask({ id: "test.md:L3", title: "Both tags", tags: ["#work", "#personal"] }),
    effectiveTask({ id: "test.md:L4", title: "No tag", tags: [] }),
  ];

  const model = projectListArea(
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
  assert.equal(model.grouped, true, "Sections → grouped");
  assert.equal(model.sections.length, 2, "Two configured sections");

  const workSection = model.sections.find((s) => s.title === "Work");
  const personalSection = model.sections.find((s) => s.title === "Personal");
  assert.ok(workSection, "Work section exists");
  assert.ok(personalSection, "Personal section exists");

  // Section filters are independent: each section gets tasks matching its own filter
  assert.equal(workSection.tasks.length, 2, "Work section has 2 tasks matching #work");
  assert.equal(personalSection.tasks.length, 2, "Personal section has 2 tasks matching #personal");
});

test("M2: list area — section with empty when includes all tasks", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Task A" }),
    effectiveTask({ id: "test.md:L2", title: "Task B" }),
  ];

  const model = projectListArea(
    tasks,
    {
      type: "list",
      sections: [
        { id: "s-all", title: "All Tasks", when: {} },
      ],
    },
    1,
  );

  assert.equal(model.grouped, true);
  assert.equal(model.sections.length, 1);
  assert.equal(model.sections[0].tasks.length, 2);
});

test("M2: list area — section limit caps task count", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Task A" }),
    effectiveTask({ id: "test.md:L2", title: "Task B" }),
    effectiveTask({ id: "test.md:L3", title: "Task C" }),
    effectiveTask({ id: "test.md:L4", title: "Task D" }),
  ];

  const model = projectListArea(
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

test("M2: list area — section-specific orderBy overrides area orderBy", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "ZZZ" }),
    effectiveTask({ id: "test.md:L2", title: "AAA" }),
    effectiveTask({ id: "test.md:L3", title: "MMM" }),
  ];

  const model = projectListArea(
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

// ── List area as "tray": unscheduled filter ──
// Trays are no longer embedded in week/month projections. A tray is just a list
// area whose `when` selects unscheduled tasks. This replaces the old
// `view.tray` assertions.

test("M2: list area — unscheduled when filter selects only unscheduled tasks (tray semantics)", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04", title: "Scheduled" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null, title: "Unscheduled" }),
    effectiveTask({ id: "test.md:L3", effectiveScheduled: null, title: "Also unscheduled" }),
  ];

  // The tray area: list with when:{time:{scheduled:"unscheduled"}}
  const tray = projectListArea(
    tasks,
    {
      type: "list",
      title: "未排期",
      when: { time: { scheduled: "unscheduled" } },
    },
    1,
  );

  assert.equal(tray.type, "list");
  assert.equal(tray.grouped, false);
  assert.equal(tray.sections.length, 1);
  assert.equal(tray.sections[0].title, "未排期");
  assert.equal(tray.sections[0].tasks.length, 2, "Tray has the 2 unscheduled tasks");
  const trayIds = tray.sections[0].tasks.map((t) => t.id).sort();
  assert.deepEqual(trayIds, ["test.md:L2", "test.md:L3"]);
});

test("M2: list area — tray with extra filter (unscheduled + tag)", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04", title: "Scheduled" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null, tags: ["#work"], title: "Unscheduled work" }),
    effectiveTask({ id: "test.md:L3", effectiveScheduled: null, tags: ["#personal"], title: "Unscheduled personal" }),
  ];

  const tray = projectListArea(
    tasks,
    {
      type: "list",
      title: "未排期工作",
      when: { time: { scheduled: "unscheduled" }, tags: ["#work"] },
    },
    1,
  );

  assert.equal(tray.sections[0].tasks.length, 1, "Only 1 task matches tray filter");
  assert.equal(tray.sections[0].tasks[0].id, "test.md:L2");
});

// ── VAL-CORE-008: Week projection ──

test("VAL-CORE-008: week area — 7 day columns with tasks grouped by effectiveScheduled", async () => {
  if (compileErr) throw compileErr;

  const { projectWeekArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04" }), // Monday
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-04" }), // Monday
    effectiveTask({ id: "test.md:L3", effectiveScheduled: "2026-05-06" }), // Wednesday
    effectiveTask({ id: "test.md:L4", effectiveScheduled: "2026-05-10" }), // Sunday
    effectiveTask({ id: "test.md:L5", effectiveScheduled: null }),          // unscheduled — not in any column
  ];

  const model = projectWeekArea(
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

  // Total tasks in columns = 4 (null-scheduled task excluded; week area has no tray)
  const totalInColumns = model.days.reduce((sum, d) => sum + d.tasks.length, 0);
  assert.equal(totalInColumns, 4);
});

test("VAL-CORE-008: week area — respects weekStartsOn=0 (Sunday)", async () => {
  if (compileErr) throw compileErr;

  const { projectWeekArea } = await import("../test/.compiled/projection.js");

  // 2026-05-04 is Monday. With weekStartsOn=0 (Sunday), the week starts on May 3.
  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-03" }), // Sunday
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-04" }), // Monday
  ];

  const model = projectWeekArea(tasks, { type: "week" }, 0, "2026-05-04");

  assert.equal(model.days[0].date, "2026-05-03");
  assert.equal(model.days[0].tasks.length, 1);
  assert.equal(model.days[1].date, "2026-05-04");
  assert.equal(model.days[1].tasks.length, 1);
});

test("VAL-CORE-008: week area — does not embed unscheduled tasks (no tray)", async () => {
  if (compileErr) throw compileErr;

  const { projectWeekArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null }),
  ];

  const model = projectWeekArea(tasks, { type: "week" }, 1, "2026-05-04");

  // Week area only renders day columns; unscheduled tasks live in a separate
  // list area, not inside the week model.
  assert.equal(model.days[0].tasks.length, 1, "Scheduled task in Monday column");
  assert.equal("tray" in model, false, "Week area produces no tray");
  const totalInColumns = model.days.reduce((sum, d) => sum + d.tasks.length, 0);
  assert.equal(totalInColumns, 1, "Unscheduled task is not in any day column");
});

// ── VAL-CORE-008: Month projection ──

test("VAL-CORE-008: month area — calendar grid with tasks per date", async () => {
  if (compileErr) throw compileErr;

  const { projectMonthArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-01" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-15" }),
    effectiveTask({ id: "test.md:L3", effectiveScheduled: "2026-05-31" }),
  ];

  const model = projectMonthArea(
    tasks,
    { type: "month" },
    "2026-05-04",
  );

  assert.equal(model.type, "month");
  assert.ok(Array.isArray(model.cells));

  // Find cells with tasks
  const populatedCells = model.cells.filter((c) => c.tasks.length > 0);
  assert.equal(populatedCells.length, 3);
});

test("VAL-CORE-008: month area — empty cells still have date", async () => {
  if (compileErr) throw compileErr;

  const { projectMonthArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-01" }),
  ];

  const model = projectMonthArea(tasks, { type: "month" }, "2026-05-04");

  // May 2026 has 31 days. Cells should cover the full month.
  assert.ok(model.cells.length >= 28, "At least 28 cells for a month");
  // Each cell has a date property
  for (const cell of model.cells) {
    assert.ok(cell.date, "Each cell has a date");
  }
});

test("VAL-CORE-008: month area — does not embed unscheduled tasks (no tray)", async () => {
  if (compileErr) throw compileErr;

  const { projectMonthArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-01", title: "In month" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null, title: "Unscheduled" }),
  ];

  const model = projectMonthArea(tasks, { type: "month" }, "2026-05-04");

  // Month area only renders date cells; unscheduled tasks live in a separate
  // list area, not inside the month model.
  assert.equal("tray" in model, false, "Month area produces no tray");
  const totalInCells = model.cells.reduce((sum, c) => sum + c.tasks.length, 0);
  assert.equal(totalInCells, 1, "Only the scheduled task is placed in a cell");
});

// ── VAL-CORE-008: Matrix projection (2D cells) ──

test("VAL-CORE-008: matrix area — 2D cells from X×Y bucket intersection", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Work + Active", tags: ["#work"], status: "todo", effectiveStatus: "todo" }),
    effectiveTask({ id: "test.md:L2", title: "Personal + Done", tags: ["#personal"], status: "done", effectiveStatus: "done" }),
    effectiveTask({ id: "test.md:L3", title: "Work + Done", tags: ["#work"], status: "done", effectiveStatus: "done" }),
    effectiveTask({ id: "test.md:L4", title: "Neither", tags: [], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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

test("VAL-CORE-008: matrix area — multiMatch=duplicate puts task in all matching cells", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Both tags", tags: ["#work", "#personal"], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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

test("VAL-CORE-008: matrix area — unmatched=hide removes unmatched tasks", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Has tag", tags: ["#work"], status: "todo" }),
    effectiveTask({ id: "test.md:L2", title: "No tag", tags: [], status: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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
    1,
  );

  assert.equal(model.unmatched.length, 0, "Unmatched tasks hidden");
});

test("M2: matrix area — multiMatch=first only puts task in first matching cell", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Multi-match", tags: ["#work", "#personal"], status: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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
    1,
  );

  // With multiMatch=first, the task should appear in only ONE cell
  const allCellTaskIds = model.cells.flatMap((c) => c.tasks.map((t) => t.id));
  const l1Count = allCellTaskIds.filter((id) => id === "test.md:L1").length;
  assert.equal(l1Count, 1, "Task appears exactly once with multiMatch=first");
});

test("M2: matrix area — empty buckets when no Y axis configured", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Has tag", tags: ["#work"] }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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
    1,
  );

  // No Y buckets → no rows → no cells
  assert.equal(model.cells.length, 0, "No cells when Y axis has no buckets");
  assert.equal(model.unmatched.length, 1, "All tasks unmatched");
});

// ── VAL-CORE-008: Same tasks projected to different areas ──

test("VAL-CORE-008: same filtered tasks projected to list, week, month produce different models", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea, projectWeekArea, projectMonthArea } =
    await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: "2026-05-05" }),
    effectiveTask({ id: "test.md:L3", effectiveScheduled: null }),
  ];

  const listModel = projectListArea(tasks, { type: "list" }, 1);
  const weekModel = projectWeekArea(tasks, { type: "week" }, 1, "2026-05-04");
  const monthModel = projectMonthArea(tasks, { type: "month" }, "2026-05-04");
  // The "tray" is a separate list area selecting unscheduled tasks.
  const trayModel = projectListArea(
    tasks,
    { type: "list", when: { time: { scheduled: "unscheduled" } } },
    1,
  );

  assert.equal(listModel.type, "list");
  assert.equal(weekModel.type, "week");
  assert.equal(monthModel.type, "month");

  // List contains all 3 tasks in its ungrouped section
  const listTaskIds = listModel.sections[0].tasks.map((t) => t.id).sort();
  assert.deepEqual(listTaskIds, ["test.md:L1", "test.md:L2", "test.md:L3"]);

  // Week contains 2 scheduled in day columns; the tray area carries the 1 unscheduled
  const weekTaskIds = weekModel.days
    .flatMap((d) => d.tasks)
    .concat(trayModel.sections[0].tasks)
    .map((t) => t.id)
    .sort();
  assert.deepEqual(weekTaskIds, ["test.md:L1", "test.md:L2", "test.md:L3"]);

  // Month contains 2 scheduled in cells; the tray area carries the 1 unscheduled
  const monthTaskIds = monthModel.cells
    .flatMap((c) => c.tasks)
    .concat(trayModel.sections[0].tasks)
    .map((t) => t.id)
    .sort();
  assert.deepEqual(monthTaskIds, ["test.md:L1", "test.md:L2", "test.md:L3"]);
});

test("M2: tray list area and week area partition tasks without overlap", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea, projectWeekArea } =
    await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", effectiveScheduled: "2026-05-04", title: "In week" }),
    effectiveTask({ id: "test.md:L2", effectiveScheduled: null, title: "Unscheduled" }),
  ];

  const week = projectWeekArea(tasks, { type: "week" }, 1, "2026-05-04");
  const tray = projectListArea(
    tasks,
    { type: "list", title: "未排期", when: { time: { scheduled: "unscheduled" } } },
    1,
  );

  // Week area has the scheduled task in Monday
  assert.equal(week.days[0].tasks.length, 1);
  assert.equal(week.days[0].tasks[0].id, "test.md:L1");

  // Tray (unscheduled list) has only the unscheduled task; no overlap with week
  const trayIds = tray.sections[0].tasks.map((t) => t.id);
  assert.ok(!trayIds.includes("test.md:L1"), "Tray excludes scheduled task");
  assert.ok(trayIds.includes("test.md:L2"), "Tray includes unscheduled task");
});

// ── Negative / edge cases ──

test("M2: matrix empty axes — all tasks unmatched", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Task A" }),
    effectiveTask({ id: "test.md:L2", title: "Task B" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
      x: { id: "x", title: "X", buckets: [] },
      y: { id: "y", title: "Y", buckets: [] },
      unmatched: "show",
      multiMatch: "first",
      showEmptyBuckets: true,
    },
    1,
  );

  assert.equal(model.type, "matrix");
  assert.equal(model.cells.length, 0, "No cells without buckets");
  assert.equal(model.unmatched.length, 2, "All tasks unmatched");
});

test("M2: sections with no matching tasks produce empty sections", async () => {
  if (compileErr) throw compileErr;

  const { projectListArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Task A", tags: [] }),
  ];

  const model = projectListArea(
    tasks,
    {
      type: "list",
      sections: [
        { id: "s-empty", title: "No Match", when: { tags: ["#nonexistent"] } },
      ],
    },
    1,
  );

  assert.equal(model.grouped, true);
  assert.equal(model.sections.length, 1);
  assert.equal(model.sections[0].tasks.length, 0, "Section is empty when no tasks match filter");
});

// ── M4: Matrix showEmptyBuckets semantics ──

test("M4: showEmptyBuckets=true preserves all configured cells including empty ones", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Work task", tags: ["#work"], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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
    1,
  );

  // 2×2 = 4 cells, all present including empty ones
  assert.equal(model.type, "matrix");
  assert.equal(model.cells.length, 4, "showEmptyBuckets=true preserves all 4 cells");

  // Verify empty cells exist
  const emptyCells = model.cells.filter((c) => c.tasks.length === 0);
  assert.ok(emptyCells.length > 0, "Empty cells exist with showEmptyBuckets=true");
});

test("M4: showEmptyBuckets=false hides empty cells", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Work task", tags: ["#work"], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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
      showEmptyBuckets: false,
    },
    1,
  );

  assert.equal(model.type, "matrix");
  // Only Work×TODO should be non-empty (3 others are empty)
  assert.equal(model.cells.length, 1, "showEmptyBuckets=false hides 3 empty cells, keeps 1 non-empty");
  assert.equal(model.cells[0].rowId, "s-todo");
  assert.equal(model.cells[0].colId, "b-work");
  assert.equal(model.cells[0].tasks.length, 1);
  assert.equal(model.cells[0].tasks[0].id, "test.md:L1");

  // Verify no empty cells remain
  const emptyCells = model.cells.filter((c) => c.tasks.length === 0);
  assert.equal(emptyCells.length, 0, "No empty cells with showEmptyBuckets=false");
});

test("M4: showEmptyBuckets=false does not change unmatched behavior", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Work task", tags: ["#work"], status: "todo", effectiveStatus: "todo" }),
    effectiveTask({ id: "test.md:L2", title: "Unmatched", tags: [], status: "todo", effectiveStatus: "todo" }),
  ];

  const matrixArea = (showEmptyBuckets) => ({
    type: "matrix",
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
    showEmptyBuckets,
  });

  const modelTrue = projectMatrixArea(tasks, matrixArea(true), 1);
  const modelFalse = projectMatrixArea(tasks, matrixArea(false), 1);

  // Unmatched is identical regardless of showEmptyBuckets
  assert.equal(modelTrue.unmatched.length, modelFalse.unmatched.length, "Unmatched count unchanged");
  assert.deepEqual(
    modelTrue.unmatched.map((t) => t.id).sort(),
    modelFalse.unmatched.map((t) => t.id).sort(),
    "Unmatched task IDs identical",
  );
});

test("M4: showEmptyBuckets=false does not change multiMatch=first behavior", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Multi-tag", tags: ["#work", "#personal"], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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
      showEmptyBuckets: false,
    },
    1,
  );

  // With multiMatch=first, the task appears exactly once
  const allCellTaskIds = model.cells.flatMap((c) => c.tasks.map((t) => t.id));
  const l1Count = allCellTaskIds.filter((id) => id === "test.md:L1").length;
  assert.equal(l1Count, 1, "Task appears exactly once with multiMatch=first and showEmptyBuckets=false");

  // Only 1 non-empty cell (the one with the task)
  assert.equal(model.cells.length, 1, "Only one cell visible (non-empty)");
});

test("M4: showEmptyBuckets=false does not change multiMatch=duplicate behavior", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Multi-tag", tags: ["#work", "#personal"], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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
      showEmptyBuckets: false,
    },
    1,
  );

  // With multiMatch=duplicate, the task appears in both matching cells
  const allCellTaskIds = model.cells.flatMap((c) => c.tasks.map((t) => t.id));
  const l1Count = allCellTaskIds.filter((id) => id === "test.md:L1").length;
  assert.equal(l1Count, 2, "Task appears in both cells with multiMatch=duplicate and showEmptyBuckets=false");
  assert.equal(model.cells.length, 2, "2 non-empty cells visible");
});

test("M4: showEmptyBuckets=false with no tasks — all cells empty → zero cells returned", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    // No tasks match any bucket
    effectiveTask({ id: "test.md:L1", title: "No match", tags: [], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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
          { id: "s-done", title: "Done", when: { status: "done" } },
        ],
      },
      unmatched: "show",
      multiMatch: "first",
      showEmptyBuckets: false,
    },
    1,
  );

  assert.equal(model.type, "matrix");
  assert.equal(model.cells.length, 0, "All cells empty → no cells with showEmptyBuckets=false");
  assert.equal(model.unmatched.length, 1, "Unmatched still captures non-matching task");
});

test("M4: showEmptyBuckets default fallback — missing field preserves all cells", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Work task", tags: ["#work"], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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
      // showEmptyBuckets intentionally absent
    },
    1,
  );

  // Default behavior: keep all cells (same as showEmptyBuckets=true)
  assert.equal(model.type, "matrix");
  assert.equal(model.cells.length, 2, "Without showEmptyBuckets field, all 2 cells preserved");
});

test("M4: showEmptyBuckets=true with multiMatch=duplicate — empty cells remain", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Work task", tags: ["#work"], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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
      multiMatch: "duplicate",
      showEmptyBuckets: true,
    },
    1,
  );

  // 2×2 = 4 cells, all preserved
  assert.equal(model.cells.length, 4, "showEmptyBuckets=true preserves all 4 cells with multiMatch=duplicate");
  const emptyCells = model.cells.filter((c) => c.tasks.length === 0);
  assert.ok(emptyCells.length > 0, "Empty cells exist with showEmptyBuckets=true");
});

// ── M4: Matrix axis metadata visibility (showEmptyBuckets) ──

test("M4: showEmptyBuckets=false — xAxis buckets only include columns with visible cells", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Work task", tags: ["#work"], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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
      showEmptyBuckets: false,
    },
    1,
  );

  assert.equal(model.type, "matrix");

  // xAxis.buckets should only contain "Work" — "Personal" has no visible cells
  assert.equal(model.xAxis.buckets.length, 1, "xAxis only has 1 visible bucket when showEmptyBuckets=false");
  assert.equal(model.xAxis.buckets[0].id, "b-work");
  assert.equal(model.xAxis.buckets[0].title, "Work");

  // yAxis.buckets should only contain "TODO" — "Done" has no visible cells
  assert.equal(model.yAxis.buckets.length, 1, "yAxis only has 1 visible bucket when showEmptyBuckets=false");
  assert.equal(model.yAxis.buckets[0].id, "s-todo");
  assert.equal(model.yAxis.buckets[0].title, "TODO");

  // Axis id and title are preserved
  assert.equal(model.xAxis.id, "x-tags");
  assert.equal(model.xAxis.title, "Tags");
  assert.equal(model.yAxis.id, "y-status");
  assert.equal(model.yAxis.title, "Status");
});

test("M4: showEmptyBuckets=true — xAxis/yAxis buckets include all configured buckets", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Work task", tags: ["#work"], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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
    1,
  );

  // All buckets included when showEmptyBuckets=true
  assert.equal(model.xAxis.buckets.length, 2, "xAxis has all 2 buckets with showEmptyBuckets=true");
  assert.equal(model.xAxis.buckets[0].id, "b-work");
  assert.equal(model.xAxis.buckets[1].id, "b-personal");

  assert.equal(model.yAxis.buckets.length, 2, "yAxis has all 2 buckets with showEmptyBuckets=true");
  assert.equal(model.yAxis.buckets[0].id, "s-todo");
  assert.equal(model.yAxis.buckets[1].id, "s-done");
});

test("M4: showEmptyBuckets=false — all cells empty → both axes have empty buckets", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "No match", tags: [], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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
          { id: "s-done", title: "Done", when: { status: "done" } },
        ],
      },
      unmatched: "show",
      multiMatch: "first",
      showEmptyBuckets: false,
    },
    1,
  );

  assert.equal(model.cells.length, 0, "No visible cells");
  // When all cells are empty, axis buckets should be empty too
  assert.equal(model.xAxis.buckets.length, 0, "xAxis buckets empty when all cells are hidden");
  assert.equal(model.yAxis.buckets.length, 0, "yAxis buckets empty when all cells are hidden");
  // Axis id/title still preserved
  assert.equal(model.xAxis.id, "x-tags");
  assert.equal(model.xAxis.title, "Tags");
  assert.equal(model.yAxis.id, "y-status");
  assert.equal(model.yAxis.title, "Status");
});

test("M4: showEmptyBuckets=false — mixed visibility: some rows visible, some columns hidden", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  // Two tasks: one matches Work×TODO, one matches Personal×TODO
  // Work column has content, Personal also has content (via task L2)
  // But Done row has no content in either column → yAxis should exclude Done
  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Work todo", tags: ["#work"], status: "todo", effectiveStatus: "todo" }),
    effectiveTask({ id: "test.md:L2", title: "Personal todo", tags: ["#personal"], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
      x: {
        id: "x-tags",
        title: "Tags",
        buckets: [
          { id: "b-work", title: "Work", when: { tags: ["#work"] } },
          { id: "b-personal", title: "Personal", when: { tags: ["#personal"] } },
          { id: "b-none", title: "None", when: { tags: ["#nonexistent"] } },
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
      showEmptyBuckets: false,
    },
    1,
  );

  // Cells: Work×TODO + Personal×TODO = 2 non-empty, Done row hidden, "None" col hidden
  assert.equal(model.cells.length, 2, "2 non-empty cells visible");

  // xAxis: only Work and Personal columns have visible cells; "None" is hidden
  assert.equal(model.xAxis.buckets.length, 2, "xAxis has 2 visible buckets");
  const xIds = model.xAxis.buckets.map((b) => b.id).sort();
  assert.deepEqual(xIds, ["b-personal", "b-work"]);

  // yAxis: only TODO row has visible cells; Done is hidden
  assert.equal(model.yAxis.buckets.length, 1, "yAxis has 1 visible bucket");
  assert.equal(model.yAxis.buckets[0].id, "s-todo");
});

test("M4: showEmptyBuckets=false — axis metadata unchanged when all cells have content", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  // Every cell has at least one task — no filtering needed
  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Work todo", tags: ["#work"], status: "todo", effectiveStatus: "todo" }),
    effectiveTask({ id: "test.md:L2", title: "Work done", tags: ["#work"], status: "done", effectiveStatus: "done" }),
    effectiveTask({ id: "test.md:L3", title: "Personal todo", tags: ["#personal"], status: "todo", effectiveStatus: "todo" }),
    effectiveTask({ id: "test.md:L4", title: "Personal done", tags: ["#personal"], status: "done", effectiveStatus: "done" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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
      showEmptyBuckets: false,
    },
    1,
  );

  // All 4 cells are non-empty
  assert.equal(model.cells.length, 4, "All 4 cells visible");
  // Axis buckets should match configured (all have content)
  assert.equal(model.xAxis.buckets.length, 2, "Both xAxis buckets visible");
  assert.equal(model.yAxis.buckets.length, 2, "Both yAxis buckets visible");
});

test("M4: showEmptyBuckets=false — unmatched and multiMatch=duplicate unaffected by axis filtering", async () => {
  if (compileErr) throw compileErr;

  const { projectMatrixArea } = await import("../test/.compiled/projection.js");

  const tasks = [
    effectiveTask({ id: "test.md:L1", title: "Multi-tag", tags: ["#work", "#personal"], status: "todo", effectiveStatus: "todo" }),
    effectiveTask({ id: "test.md:L2", title: "Unmatched", tags: [], status: "todo", effectiveStatus: "todo" }),
  ];

  const model = projectMatrixArea(
    tasks,
    {
      type: "matrix",
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
      showEmptyBuckets: false,
    },
    1,
  );

  // multiMatch=duplicate: L1 in both Work×TODO and Personal×TODO → 2 cells
  assert.equal(model.cells.length, 2, "2 non-empty cells with multiMatch=duplicate");
  // Axis: both columns visible
  assert.equal(model.xAxis.buckets.length, 2, "Both xAxis buckets visible");
  // Unmatched: L2
  assert.equal(model.unmatched.length, 1, "Unmatched task still present");
  assert.equal(model.unmatched[0].id, "test.md:L2");
});
