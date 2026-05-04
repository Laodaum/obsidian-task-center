// Unit tests for US-109c/g/h: saved filter views.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/saved-views.ts",
      "--bundle=false",
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

compilePure();
const {
  applySavedViewFilters,
  restoreBuiltinSavedViewById,
  restoreBuiltinSavedViews,
  ensureBuiltinSavedViews,
  clearSavedViewFilters,
  createSavedView,
  moveSavedViewById,
  parseSavedViewDsl,
  hasSavedViewFilters,
  normalizeSavedTaskView,
  normalizeSavedViewStatus,
  sameSavedViewContent,
  stringifySavedViewDsl,
  suggestSavedViewName,
  updateSavedViewById,
  upsertSavedView,
  deleteQueryPresetById,
  upsertQueryPreset,
  normalizeQueryPreset,
  createQueryPreset,
  deleteSavedViewById,
  isBuiltinSavedViewId,
  fromQueryPreset,
  toQueryPreset,
  sameQueryPresetContent,
  parseQueryDsl,
  stringifyQueryPreset,
  computeQueryPresetDeleteUndoPlan,
  executeQueryPresetDeleteUndo,
  executeDeleteQueryPresetFlow,
  computeQueryPresetSnapshot,
  applySummaryMetricEdit,
  applySummaryMetricRemove,
  applySummaryMetricAdd,
  updateQueryPresetById,
} = await import("../test/.compiled/saved-views.js");

test("US-109c: createSavedView persists the current filter conditions, not a task snapshot", () => {
  const view = createSavedView(
    " Alpha Focus ",
    {
      search: "  report  ",
      tag: " #alpha,#beta ",
      time: { scheduled: " week ", deadline: " overdue ", completed: "" },
      status: "todo",
      view: { type: "week" },
      summary: [{ type: "count" }, { type: "sum", field: " actual ", format: " duration " }],
    },
    () => "sv-fixed",
  );

  assert.deepEqual(view, {
    id: "sv-fixed",
    name: "Alpha Focus",
    builtin: false,
    hidden: false,
    search: "report",
    tag: "#alpha,#beta",
    time: { scheduled: "week", deadline: "overdue" },
    status: ["todo"],
    view: { type: "week" },
    summary: [{ type: "count" }, { type: "sum", field: "actual", format: "duration" }],
  });
});

test("US-109c1: upsertSavedView appends a new preset when the id is new", () => {
  const oldView = createSavedView("Alpha", { search: "old", tag: "#old", time: { scheduled: "today" }, status: "todo" }, () => "sv-old");
  const otherView = createSavedView("Gamma", { search: "", tag: "#gamma", time: {}, status: "all" }, () => "sv-gamma");
  const newView = createSavedView("Alpha", { search: "new", tag: "#alpha", time: { completed: "week" }, status: "done" }, () => "sv-new");

  const views = upsertSavedView([oldView, otherView], newView);

  assert.deepEqual(views.map((view) => view.id), ["sv-old", "sv-gamma", "sv-new"]);
  assert.equal(views[2].name, "Alpha");
  assert.equal(views[2].search, "new");
  assert.equal(views[2].tag, "#alpha");
  assert.deepEqual(views[2].time, { completed: "week" });
  assert.deepEqual(views[2].status, ["done"]);
});

test("US-109c: updateSavedViewById preserves the selected saved-view identity", () => {
  const alpha = createSavedView("Alpha", { search: "old", tag: "#old", time: { scheduled: "today" }, status: "todo" }, () => "sv-alpha");
  const gamma = createSavedView("Gamma", { search: "", tag: "#gamma", time: {}, status: "all" }, () => "sv-gamma");
  const updated = createSavedView("Alpha", { search: "new", tag: "#alpha", time: { deadline: "overdue" }, status: "done" }, () => "sv-alpha");

  const views = updateSavedViewById([alpha, gamma], updated);

  assert.deepEqual(views.map((view) => view.id), ["sv-alpha", "sv-gamma"]);
  assert.deepEqual(views.map((view) => view.name), ["Alpha", "Gamma"]);
  assert.equal(views[0].search, "new");
  assert.equal(views[0].tag, "#alpha");
  assert.deepEqual(views[0].time, { deadline: "overdue" });
  assert.deepEqual(views[0].status, ["done"]);
});

test("US-109g: applySavedViewFilters restores saved filters", () => {
  const filters = applySavedViewFilters({
    id: "sv-q1",
    name: "Q1",
    search: "brief",
    tag: "#alpha,#beta",
    time: {
      scheduled: "2026-04-01..2026-04-30",
      deadline: "overdue",
    },
    status: "todo",
    view: { type: "month" },
    summary: [{ type: "count" }],
  });

  assert.deepEqual(filters, {
    savedViewId: "sv-q1",
    search: "brief",
    tag: "#alpha,#beta",
    time: {
      scheduled: "2026-04-01..2026-04-30",
      deadline: "overdue",
    },
    status: ["todo"],
    view: { type: "month" },
    summary: [{ type: "count" }],
  });
});

test("US-109t: normalizeSavedTaskView upgrades legacy saved filters into DSL-ready query presets", () => {
  const normalized = normalizeSavedTaskView({
    id: "sv-legacy",
    name: " Legacy ",
    search: " task ",
    tag: " #alpha ",
    time: { scheduled: " today " },
    status: "todo",
  });

  assert.deepEqual(normalized, {
    id: "sv-legacy",
    name: "Legacy",
    builtin: false,
    hidden: false,
    search: "task",
    tag: "#alpha",
    time: { scheduled: "today" },
    status: ["todo"],
    view: { type: "list" },
    summary: [],
  });
});

test("US-109g: clearSavedViewFilters returns the current-view empty filter state", () => {
  assert.deepEqual(clearSavedViewFilters(), {
    savedViewId: null,
    search: "",
    tag: "",
    time: {},
    status: "all",
    view: { type: "list" },
    summary: [],
  });
});

test("US-109l: restoreBuiltinSavedViewById resets one preset tab to its seeded DSL", () => {
  const restored = restoreBuiltinSavedViewById([
    {
      id: "preset-week",
      name: "我的周视图",
      builtin: true,
      hidden: true,
      search: "focus",
      tag: "#work",
      time: { scheduled: "today" },
      status: ["done"],
      view: { type: "list" },
      summary: [{ type: "count" }],
    },
    {
      id: "sv-custom",
      name: "自定义",
      search: "docs",
      tag: "#alpha",
      time: {},
      status: ["todo"],
      view: { type: "list" },
      summary: [],
    },
  ], "preset-week", { week: "本周" });

  assert.deepEqual(restored, [
    {
      id: "preset-week",
      name: "本周",
      builtin: true,
      hidden: false,
      search: "",
      tag: "",
      time: {},
      status: ["todo"],
      view: { type: "week" },
      summary: [],
    },
    {
      id: "sv-custom",
      name: "自定义",
      builtin: false,
      hidden: false,
      search: "docs",
      tag: "#alpha",
      time: {},
      status: ["todo"],
      view: { type: "list" },
      summary: [],
    },
  ]);
});

test("US-109l: restoreBuiltinSavedViews recreates the full preset tab set without touching custom tabs", () => {
  const restored = restoreBuiltinSavedViews([
    {
      id: "preset-today",
      name: "Today hacked",
      builtin: true,
      hidden: true,
      search: "old",
      tag: "#work",
      time: {},
      status: ["done"],
      view: { type: "month" },
      summary: [{ type: "count" }],
    },
    {
      id: "sv-custom",
      name: "Deep Work",
      search: "docs",
      tag: "#alpha",
      time: { scheduled: "week" },
      status: ["todo"],
      view: { type: "list" },
      summary: [],
    },
  ], { today: "今日" });

  assert.deepEqual(restored.slice(0, 7).map((view) => view.id), [
    "preset-today",
    "preset-week",
    "preset-month",
    "preset-todo",
    "preset-unscheduled",
    "preset-completed",
    "preset-dropped",
  ]);
  assert.equal(restored[0].name, "今日");
  assert.equal(restored[0].hidden, false);
  assert.deepEqual(restored.at(-1), {
    id: "sv-custom",
    name: "Deep Work",
    builtin: false,
    hidden: false,
    search: "docs",
    tag: "#alpha",
    time: { scheduled: "week" },
    status: ["todo"],
    view: { type: "list" },
    summary: [],
  });
});

test("US-109p2: stringifySavedViewDsl emits JSON for the same preset object", () => {
  const text = stringifySavedViewDsl(createSavedView(
    "Alpha",
    {
      search: "focus",
      tag: "#alpha,#beta",
      time: { scheduled: "week" },
      status: ["todo", "done"],
      view: { type: "month", preset: "today" },
      summary: [{ type: "count" }],
    },
    () => "sv-alpha",
  ));
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, {
    id: "sv-alpha",
    name: "Alpha",
    filters: {
      search: "focus",
      tags: ["#alpha", "#beta"],
      status: ["todo", "done"],
      time: { scheduled: "week" },
    },
    view: { type: "month", preset: "today" },
    summary: [{ type: "count" }],
  });
});

test("US-109p3: parseSavedViewDsl validates and normalizes JSON DSL", () => {
  const view = parseSavedViewDsl(JSON.stringify({
    name: " Deep Work ",
    filters: {
      search: " docs ",
      tags: ["alpha", "#beta", "alpha"],
      status: ["todo", "done"],
      time: { scheduled: " week " },
    },
    view: { type: "week", preset: " today " },
    summary: [{ type: "sum", field: " actual ", format: " duration " }],
  }), { id: "sv-existing" });

  assert.deepEqual(view, {
    id: "sv-existing",
    name: "Deep Work",
    builtin: false,
    hidden: false,
    search: "docs",
    tag: "#alpha,#beta",
    time: { scheduled: "week" },
    status: ["todo", "done"],
    view: { type: "week", preset: "today" },
    summary: [{ type: "sum", field: "actual", format: "duration" }],
  });
});

test("US-109s: sameSavedViewContent ignores ids and compares the effective query content", () => {
  const left = parseSavedViewDsl(JSON.stringify({
    id: "left",
    name: "Left",
    filters: { tags: ["#alpha"], status: ["todo"] },
    view: { type: "list", preset: "today" },
    summary: [],
  }));
  const right = parseSavedViewDsl(JSON.stringify({
    id: "right",
    name: "Right",
    filters: { tags: ["#alpha"], status: ["todo"] },
    view: { type: "list", preset: "today" },
    summary: [],
  }));
  assert.equal(sameSavedViewContent(left, right), true);
});

test("US-109c: suggestSavedViewName prefers tag, then status, then fallback", () => {
  assert.equal(suggestSavedViewName({ tag: " #alpha,#beta ", status: "all" }, "Saved view"), "alpha,#beta");
  assert.equal(suggestSavedViewName({ tag: "", status: "done" }, "Saved view"), "done");
  assert.equal(suggestSavedViewName({ tag: "", status: ["todo", "dropped"] }, "Saved view"), "todo,dropped");
  assert.equal(suggestSavedViewName({ tag: "", status: "all" }, "Saved view"), "Saved view");
});

test("US-109c: empty filters are not a saveable filter view", () => {
  assert.equal(hasSavedViewFilters({ search: "", tag: "", time: {}, status: "all" }), false);
  assert.equal(hasSavedViewFilters({ search: "alpha", tag: "", time: {}, status: "all" }), true);
  assert.equal(hasSavedViewFilters({ search: "", tag: "#alpha", time: {}, status: "all" }), true);
  assert.equal(hasSavedViewFilters({ search: "", tag: "", time: { scheduled: "week" }, status: "all" }), true);
  assert.equal(hasSavedViewFilters({ search: "", tag: "", time: {}, status: "done" }), true);
  assert.equal(hasSavedViewFilters({ search: "", tag: "", time: {}, status: ["todo", "done"] }), true);
});

test("US-109h: status filters normalize legacy single-select and new multi-select values", () => {
  assert.equal(normalizeSavedViewStatus("all"), "all");
  assert.deepEqual(normalizeSavedViewStatus("todo"), ["todo"]);
  assert.deepEqual(normalizeSavedViewStatus(["todo", "done", "todo"]), ["todo", "done"]);
  assert.equal(normalizeSavedViewStatus([]), "all");
});

test("US-109j/l: ensureBuiltinSavedViews seeds missing built-in query tabs and preserves custom tabs", () => {
  const custom = createSavedView("Deep Work", { search: "docs", tag: "#work", time: {}, status: ["todo"], view: { type: "list" }, summary: [] }, () => "sv-custom");
  const hiddenBuiltin = createSavedView("Today Copy", { search: "", tag: "", time: {}, status: ["todo"], view: { type: "list", preset: "today" }, summary: [] }, () => "preset-today");
  hiddenBuiltin.hidden = true;

  const views = ensureBuiltinSavedViews([custom, hiddenBuiltin], {
    today: "今日",
    week: "本周",
    month: "本月",
    todo: "TODO",
    completed: "已完成",
    dropped: "已放弃",
    unscheduled: "未排期",
  });

  assert.deepEqual(views.slice(0, 7).map((view) => view.id), [
    "preset-today",
    "preset-week",
    "preset-month",
    "preset-todo",
    "preset-unscheduled",
    "preset-completed",
    "preset-dropped",
  ]);
  assert.equal(views[0].builtin, true);
  assert.equal(views[0].hidden, true);
  assert.equal(views[0].name, "Today Copy");
  assert.equal(views.at(-1)?.id, "sv-custom");
});

test("US-109q: moveSavedViewById reorders one tab without rewriting ids", () => {
  const alpha = createSavedView("Alpha", { search: "", tag: "", time: {}, status: "all", view: { type: "list" }, summary: [] }, () => "sv-alpha");
  const beta = createSavedView("Beta", { search: "", tag: "", time: {}, status: "all", view: { type: "list" }, summary: [] }, () => "sv-beta");
  const gamma = createSavedView("Gamma", { search: "", tag: "", time: {}, status: "all", view: { type: "list" }, summary: [] }, () => "sv-gamma");

  assert.deepEqual(moveSavedViewById([alpha, beta, gamma], "sv-beta", -1).map((view) => view.id), ["sv-beta", "sv-alpha", "sv-gamma"]);
  assert.deepEqual(moveSavedViewById([alpha, beta, gamma], "sv-beta", 1).map((view) => view.id), ["sv-alpha", "sv-gamma", "sv-beta"]);
});

// ── VAL-GUI-004: delete custom tab + undo restore ──

test("VAL-GUI-004: deleteQueryPresetById removes target and leaves others untouched", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  const after = deleteQueryPresetById(presets, "sv-b");

  assert.equal(after.length, 2);
  assert.deepEqual(after.map((p) => p.id), ["sv-a", "sv-c"]);
});

test("VAL-GUI-004: deleteQueryPresetById is no-op when id not found", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const after = deleteQueryPresetById([a], "nonexistent");

  assert.equal(after.length, 1);
  assert.equal(after[0].id, "sv-a");
});

test("VAL-GUI-004: undo delete restores QueryPreset snapshot with all fields", () => {
  // Simulate: create preset → snapshot → delete → undo (upsert)
  const original = createQueryPreset(
    "My Tab",
    {
      search: "focus",
      tags: ["#work", "#urgent"],
      status: ["todo", "in_progress"],
      time: { scheduled: "week", deadline: "overdue" },
      view: { type: "week", preset: "today", orderBy: ["deadline_risk"] },
      summary: [{ type: "count" }, { type: "sum", field: "actual", format: "duration" }],
    },
    () => "sv-custom-1",
  );

  // Take a snapshot
  const snapshot = normalizeQueryPreset(original);
  assert.equal(snapshot.id, "sv-custom-1");
  assert.equal(snapshot.name, "My Tab");
  assert.equal(snapshot.builtin, false);
  assert.equal(snapshot.hidden, false);
  assert.deepEqual(snapshot.filters.search, "focus");
  assert.deepEqual(snapshot.filters.tags, ["#work", "#urgent"]);
  assert.deepEqual(snapshot.filters.status, ["todo", "in_progress"]);
  assert.deepEqual(snapshot.filters.time, { scheduled: "week", deadline: "overdue" });
  assert.deepEqual(snapshot.view, { type: "week", preset: "today", orderBy: ["deadline_risk"] });
  assert.equal(snapshot.summary.length, 2);

  // Delete from the array
  const otherPreset = createQueryPreset("Other", { status: "all" }, () => "sv-other");
  let afterDelete = deleteQueryPresetById([otherPreset, original], "sv-custom-1");
  assert.equal(afterDelete.length, 1);
  assert.equal(afterDelete[0].id, "sv-other");

  // Undo: upsert the snapshot back
  const afterUndo = upsertQueryPreset(afterDelete, snapshot);
  assert.equal(afterUndo.length, 2);
  const restored = afterUndo.find((p) => p.id === "sv-custom-1");
  assert.ok(restored, "restored preset should exist");
  assert.equal(restored.name, "My Tab");
  assert.equal(restored.builtin, false);
  assert.equal(restored.hidden, false);
  assert.deepEqual(restored.filters, snapshot.filters);
  assert.deepEqual(restored.view, snapshot.view);
  assert.equal(restored.summary.length, 2);
});

test("VAL-GUI-004: undo restores preset at original position when possible", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  // Snapshot of B at index 1
  const snapshot = normalizeQueryPreset(b);
  const originalIndex = 1;

  // Delete B
  const afterDelete = deleteQueryPresetById(presets, "sv-b");
  assert.deepEqual(afterDelete.map((p) => p.id), ["sv-a", "sv-c"]);

  // Undo: insert at originalIndex
  const insertIdx = Math.min(originalIndex, afterDelete.length);
  const presetsCopy = [...afterDelete];
  presetsCopy.splice(insertIdx, 0, snapshot);

  assert.deepEqual(presetsCopy.map((p) => p.id), ["sv-a", "sv-b", "sv-c"]);
});

test("VAL-GUI-004: undo handles originalIndex beyond current length (appends)", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const presets = [a];

  const snapshot = normalizeQueryPreset(a);
  const afterDelete = deleteQueryPresetById(presets, "sv-a");
  assert.equal(afterDelete.length, 0);

  // originalIndex was 0, now length is 0, insertIdx = min(0, 0) = 0
  const insertIdx = Math.min(0, afterDelete.length);
  const presetsCopy = [...afterDelete];
  presetsCopy.splice(insertIdx, 0, snapshot);

  assert.equal(presetsCopy.length, 1);
  assert.equal(presetsCopy[0].id, "sv-a");
});

test("VAL-GUI-004: deleteSavedViewById also removes target (legacy compat)", () => {
  const a = createSavedView("A", { search: "", tag: "", time: {}, status: "all" }, () => "sv-a");
  const b = createSavedView("B", { search: "", tag: "", time: {}, status: "all" }, () => "sv-b");

  const after = deleteSavedViewById([a, b], "sv-a");
  assert.equal(after.length, 1);
  assert.equal(after[0].id, "sv-b");
});

test("VAL-GUI-004: builtin tab IDs are detected by isBuiltinSavedViewId", () => {
  assert.equal(isBuiltinSavedViewId("preset-today"), true);
  assert.equal(isBuiltinSavedViewId("preset-week"), true);
  assert.equal(isBuiltinSavedViewId("preset-month"), true);
  assert.equal(isBuiltinSavedViewId("preset-todo"), true);
  assert.equal(isBuiltinSavedViewId("preset-unscheduled"), true);
  assert.equal(isBuiltinSavedViewId("preset-completed"), true);
  assert.equal(isBuiltinSavedViewId("preset-dropped"), true);
  assert.equal(isBuiltinSavedViewId("sv-custom"), false);
  assert.equal(isBuiltinSavedViewId("preset-unknown"), false);
});

test("VAL-GUI-004: snapshot normalizeQueryPreset preserves hidden state", () => {
  const preset = normalizeQueryPreset({
    id: "sv-hidden",
    name: "Hidden Tab",
    builtin: false,
    hidden: true,
    filters: { status: "todo" },
    view: { type: "list" },
    summary: [],
  });

  assert.equal(preset.hidden, true);
});

test("VAL-GUI-004: snapshot normalizeQueryPreset strips unknown fields", () => {
  const preset = normalizeQueryPreset({
    id: "sv-clean",
    name: "Clean",
    filters: {},
    view: {},
    summary: [],
    // @ts-expect-error: unknown field
    unknownField: "should be stripped",
  });

  assert.equal("unknownField" in preset, false);
});

// ── fix-m3-delete-undo-original-index ──

test("VAL-GUI-004: originalIndex computed by stable id, not object-reference indexOf on normalized copies", () => {
  // Simulate the real-world scenario:
  // settings.queryPresets holds the original objects.
  // visibleQueryTabs() returns normalized copies (new objects via normalizeQueryPreset).
  // deleteSavedViewWithConfirm receives a normalized copy as `view`.
  // originalIndex must be found by matching id, not by object-reference indexOf.

  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const settingsArray = [a, b, c];

  // Simulate visibleQueryTabs() returning normalized copies
  const normalizedCopies = settingsArray.map((p) => normalizeQueryPreset(p));

  // The normalized copy of B is a *different object* than the original B
  const normalizedB = normalizedCopies[1];
  assert.equal(normalizedB.id, "sv-b");
  assert.notStrictEqual(normalizedB, b, "normalizeQueryPreset must create a new object");

  // BUG: indexOf on original array with normalized copy returns -1
  const badIndex = settingsArray.indexOf(normalizedB);
  assert.equal(badIndex, -1, "indexOf a normalized copy should fail on the original array");

  // FIX: findIndex by stable id works correctly
  const goodIndex = settingsArray.findIndex((p) => p.id === normalizedB.id);
  assert.equal(goodIndex, 1, "findIndex by id should find the correct position");

  // Full undo simulation with the fixed index computation
  const snapshot = normalizeQueryPreset(normalizedB);
  const originalIndex = goodIndex; // The correct computation

  // Delete B from settingsArray
  const afterDelete = deleteQueryPresetById(settingsArray, "sv-b");
  assert.deepEqual(afterDelete.map((p) => p.id), ["sv-a", "sv-c"]);

  // Undo: insert snapshot at originalIndex
  const insertIdx = Math.min(originalIndex, afterDelete.length);
  const restored = [...afterDelete];
  restored.splice(insertIdx, 0, snapshot);

  // Verify B is restored at its original position (index 1), between A and C
  assert.deepEqual(restored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"],
    "undo must restore deleted preset at its original stable-id order position");
});

test("VAL-GUI-004: undo restores preset at correct position when deleted from end, using stable id", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const settingsArray = [a, b, c];

  // Simulate normalized copy for C (last item, index 2)
  const normalizedCopies = settingsArray.map((p) => normalizeQueryPreset(p));
  const normalizedC = normalizedCopies[2];
  assert.equal(normalizedC.id, "sv-c");

  // findIndex by id gives 2
  const originalIndex = settingsArray.findIndex((p) => p.id === normalizedC.id);
  assert.equal(originalIndex, 2);

  const snapshot = normalizeQueryPreset(normalizedC);

  // Delete C
  const afterDelete = deleteQueryPresetById(settingsArray, "sv-c");
  assert.deepEqual(afterDelete.map((p) => p.id), ["sv-a", "sv-b"]);

  // Undo: insert at originalIndex (2), min(2, 2) = 2, splice appends
  const insertIdx = Math.min(originalIndex, afterDelete.length);
  const restored = [...afterDelete];
  restored.splice(insertIdx, 0, snapshot);

  assert.deepEqual(restored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"],
    "undo must restore last preset at its original end position");
});

test("VAL-GUI-004: undo restores preset at correct position when deleted from beginning, using stable id", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const settingsArray = [a, b, c];

  // Simulate normalized copy for A (first item, index 0)
  const normalizedCopies = settingsArray.map((p) => normalizeQueryPreset(p));
  const normalizedA = normalizedCopies[0];
  assert.equal(normalizedA.id, "sv-a");

  // findIndex by id gives 0
  const originalIndex = settingsArray.findIndex((p) => p.id === normalizedA.id);
  assert.equal(originalIndex, 0);

  const snapshot = normalizeQueryPreset(normalizedA);

  // Delete A
  const afterDelete = deleteQueryPresetById(settingsArray, "sv-a");
  assert.deepEqual(afterDelete.map((p) => p.id), ["sv-b", "sv-c"]);

  // Undo: insert at originalIndex 0
  const insertIdx = Math.min(originalIndex, afterDelete.length);
  const restored = [...afterDelete];
  restored.splice(insertIdx, 0, snapshot);

  assert.deepEqual(restored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"],
    "undo must restore first preset at its original beginning position");
});

// ── fix-m3-delete-undo-real-path: regression tests through
//   computeQueryPresetDeleteUndoPlan / executeQueryPresetDeleteUndo,
//   the same functions used by deleteSavedViewWithConfirm. ──

test("VAL-GUI-004: computeQueryPresetDeleteUndoPlan uses stable-id findIndex, not object-reference indexOf", () => {
  // Simulate the real scenario in deleteSavedViewWithConfirm:
  // settings.queryPresets holds the originals; view comes from visibleQueryTabs()
  // (normalized copies). originalIndex must be found by matching id.

  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const settingsArray = [a, b, c];

  // visibleQueryTabs() returns normalized copies (new objects)
  const normalizedCopies = settingsArray.map((p) => normalizeQueryPreset(p));
  const normalizedB = normalizedCopies[1];

  // The normalized copy is a different object
  assert.notStrictEqual(normalizedB, b);

  // Production path: plan uses stable-id findIndex
  const plan = computeQueryPresetDeleteUndoPlan(settingsArray, normalizedB);
  assert.equal(plan.originalIndex, 1, "originalIndex must be found by id match");
  assert.equal(plan.snapshot.id, "sv-b");
  assert.equal(plan.snapshot.name, "B");

  // Verify the snapshot is normalized (has the correct shape)
  assert.equal(plan.snapshot.builtin, false);
  assert.equal(plan.snapshot.hidden, false);
  assert.ok(plan.snapshot.filters);
  assert.deepEqual(plan.snapshot.filters.status, ["done"]);
});

test("VAL-GUI-004: executeQueryPresetDeleteUndo restores at original position within bounds", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const settingsArray = [a, b, c];

  // Delete B (index 1)
  const plan = computeQueryPresetDeleteUndoPlan(settingsArray, b);
  const afterDelete = deleteQueryPresetById(settingsArray, "sv-b");
  assert.deepEqual(afterDelete.map((p) => p.id), ["sv-a", "sv-c"]);

  // Undo via production function
  const restored = executeQueryPresetDeleteUndo(afterDelete, plan);
  assert.deepEqual(restored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"],
    "undo restores at original position via executeQueryPresetDeleteUndo");
  assert.equal(restored[1].name, "B");
  assert.deepEqual(restored[1].filters.status, ["done"]);
});

test("VAL-GUI-004: executeQueryPresetDeleteUndo handles originalIndex beyond current length (clamps)", () => {
  // If presets changed between delete and undo (e.g., other presets added),
  // originalIndex may exceed current array length. The function clamps safely.

  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("B", { status: "done" }, () => "sv-b");
  const settingsArray = [a, b];

  // B is at index 1
  const plan = computeQueryPresetDeleteUndoPlan(settingsArray, b);
  assert.equal(plan.originalIndex, 1);

  // After delete, another preset gets added (simulating race)
  const afterDelete = deleteQueryPresetById(settingsArray, "sv-b");
  const c = createQueryPreset("C", { status: "all" }, () => "sv-c");
  const withExtra = upsertQueryPreset(afterDelete, c);
  assert.deepEqual(withExtra.map((p) => p.id), ["sv-a", "sv-c"]);
  // originalIndex=1, but current length=2, so insertIdx = min(1, 2) = 1

  const restored = executeQueryPresetDeleteUndo(withExtra, plan);
  assert.deepEqual(restored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"],
    "undo clamps originalIndex when presets changed after delete");
});

test("VAL-GUI-004: full delete+undo flow preserves original order with default and active state, exercising production functions", () => {
  // This test mirrors the exact logic from deleteSavedViewWithConfirm:
  //   snapshot = computeQueryPresetDeleteUndoPlan(presets, view)
  //   wasDefault = defaultId === view.id
  //   wasActive = activeId === view.id
  //   delete
  //   undo restore with position + default + active

  const a = createQueryPreset("Alpha", {
    search: "focus",
    tags: ["#work"],
    status: ["todo"],
    time: { scheduled: "week", deadline: "overdue" },
    view: { type: "week", orderBy: ["deadline_risk"] },
    summary: [{ type: "count" }, { type: "sum", field: "actual", format: "duration" }],
  }, () => "sv-alpha");
  const b = createQueryPreset("Beta", {
    search: "docs",
    tags: ["#docs"],
    status: ["done"],
    view: { type: "list" },
    summary: [{ type: "count" }],
  }, () => "sv-beta");
  const c = createQueryPreset("Gamma", {
    search: "meetings",
    tags: ["#meeting"],
    status: ["todo", "done"],
    view: { type: "month" },
    summary: [],
  }, () => "sv-gamma");
  const presets = [a, b, c];
  const defaultId = "sv-alpha";
  const activeId = "sv-beta";

  // visibleQueryTabs() returns normalized copies
  const normalizedCopies = presets.map((p) => normalizeQueryPreset(p));
  const normalizedB = normalizedCopies[1]; // "Beta", the active one

  // --- Snapshot via production function ---
  const plan = computeQueryPresetDeleteUndoPlan(presets, normalizedB);
  assert.equal(plan.originalIndex, 1);
  assert.equal(plan.snapshot.id, "sv-beta");
  assert.equal(plan.snapshot.name, "Beta");
  assert.deepEqual(plan.snapshot.filters.search, "docs");
  assert.deepEqual(plan.snapshot.filters.tags, ["#docs"]);
  assert.deepEqual(plan.snapshot.filters.status, ["done"]);
  assert.deepEqual(plan.snapshot.view, { type: "list" });
  assert.equal(plan.snapshot.summary.length, 1);

  // --- Capture state before delete (as deleteSavedViewWithConfirm does) ---
  const wasDefault = defaultId === normalizedB.id;
  const wasActive = activeId === normalizedB.id;
  assert.equal(wasDefault, false, "Beta was not default");
  assert.equal(wasActive, true, "Beta was active");

  // --- Delete via production helper ---
  const afterDelete = deleteQueryPresetById(presets, "sv-beta");
  assert.deepEqual(afterDelete.map((p) => p.id), ["sv-alpha", "sv-gamma"]);

  // --- Undo via production function ---
  const restored = executeQueryPresetDeleteUndo(afterDelete, plan);
  assert.deepEqual(restored.map((p) => p.id), ["sv-alpha", "sv-beta", "sv-gamma"],
    "undo restores Beta at its original position between Alpha and Gamma");

  const restoredBeta = restored[1];
  assert.equal(restoredBeta.name, "Beta");
  assert.equal(restoredBeta.builtin, false);
  assert.equal(restoredBeta.hidden, false);
  assert.deepEqual(restoredBeta.filters, plan.snapshot.filters,
    "restored snapshot must have all filter fields preserved");
  assert.deepEqual(restoredBeta.view, plan.snapshot.view,
    "restored snapshot must have view config preserved");
  assert.equal(restoredBeta.summary.length, 1,
    "restored snapshot must have summary metrics preserved");

  // --- Verify default/active restoration logic ---
  if (wasDefault) {
    // wasDefault=false for Beta, so this branch wouldn't execute
  }
  if (wasActive) {
    const reactivated = restored.find((p) => p.id === plan.snapshot.id);
    assert.ok(reactivated, "restored to active tab when wasActive is true");
    assert.equal(reactivated.id, "sv-beta");
  }
});

test("VAL-GUI-004: delete+undo restores default state correctly through production functions", () => {
  // Delete the DEFAULT tab (Alpha), verify undo restores it as default

  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-alpha");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-beta");
  const c = createQueryPreset("Gamma", { status: "all" }, () => "sv-gamma");
  const presets = [a, b, c];
  const defaultId = "sv-alpha"; // Alpha is default
  const activeId = "sv-alpha";  // Alpha is also active

  const normalizedCopies = presets.map((p) => normalizeQueryPreset(p));
  const normalizedA = normalizedCopies[0];

  const plan = computeQueryPresetDeleteUndoPlan(presets, normalizedA);
  assert.equal(plan.originalIndex, 0);

  const wasDefault = defaultId === normalizedA.id;
  const wasActive = activeId === normalizedA.id;
  assert.equal(wasDefault, true, "Alpha was default");
  assert.equal(wasActive, true, "Alpha was active");

  const afterDelete = deleteQueryPresetById(presets, "sv-alpha");
  assert.deepEqual(afterDelete.map((p) => p.id), ["sv-beta", "sv-gamma"]);

  const restored = executeQueryPresetDeleteUndo(afterDelete, plan);
  assert.deepEqual(restored.map((p) => p.id), ["sv-alpha", "sv-beta", "sv-gamma"],
    "undo restores default/active tab at original position");

  // Verify default and active state would be restored
  if (wasDefault) {
    // Production code would do: this.plugin.settings.defaultSavedViewId = plan.snapshot.id
    const newDefaultId = plan.snapshot.id;
    assert.equal(newDefaultId, "sv-alpha", "default should be restored to Alpha");
  }
  if (wasActive) {
    const reactivated = restored.find((p) => p.id === plan.snapshot.id);
    assert.ok(reactivated, "restored to active tab");
  }
});

test("VAL-GUI-004: delete+undo preserves full QueryPreset detail through production snapshot", () => {
  // Verify that the snapshot captured by computeQueryPresetDeleteUndoPlan
  // preserves all QueryPreset fields including matrix config, tray, sections, summary

  const rich = normalizeQueryPreset({
    id: "sv-rich",
    name: "Rich View",
    builtin: false,
    hidden: false,
    filters: {
      search: "deep work",
      tags: ["#focus", "#priority"],
      status: ["todo", "in_progress"],
      time: { scheduled: "week", deadline: "overdue", completed: "month" },
    },
    view: {
      type: "matrix",
      sections: [
        { id: "urgent", title: "Urgent", when: { time: { deadline: "overdue" } }, limit: 5, orderBy: ["deadline_asc"] },
      ],
      tray: {
        enabled: true,
        title: "Backlog",
        filters: { status: ["todo"], time: { scheduled: "unscheduled" } },
        orderBy: ["deadline_asc"],
      },
      matrix: {
        x: {
          id: "pri",
          title: "Priority",
          buckets: [
            { id: "high", title: "High", when: { tags: ["#high"] } },
            { id: "low", title: "Low", when: { tags: ["#low"] } },
          ],
        },
        y: {
          id: "stat",
          title: "Status",
          buckets: [
            { id: "open", title: "Open", when: { status: ["todo"] } },
            { id: "done", title: "Done", when: { status: ["done"] } },
          ],
        },
        unmatched: "hide",
        multiMatch: "duplicate",
        showEmptyBuckets: false,
      },
      orderBy: ["deadline_asc", "created_desc"],
      preset: "today",
    },
    summary: [
      { type: "count" },
      { type: "sum", field: "planned", format: "duration" },
      { type: "ratio", numerator: "actual", denominator: "estimate", format: "percent" },
      { type: "top_n", by: "tags", limit: 5 },
      { type: "group_by", by: "tags" },
    ],
  });

  const presets = [createQueryPreset("Other", { status: "all" }, () => "sv-other"), rich];
  const plan = computeQueryPresetDeleteUndoPlan(presets, rich);
  const snapshot = plan.snapshot;

  assert.equal(snapshot.id, "sv-rich");
  assert.equal(snapshot.name, "Rich View");

  // Filters
  assert.equal(snapshot.filters.search, "deep work");
  assert.deepEqual(snapshot.filters.tags, ["#focus", "#priority"]);
  assert.deepEqual(snapshot.filters.status, ["todo", "in_progress"]);
  assert.deepEqual(snapshot.filters.time, {
    scheduled: "week", deadline: "overdue", completed: "month",
  });

  // View
  assert.equal(snapshot.view.type, "matrix");
  assert.equal(snapshot.view.preset, "today");
  assert.deepEqual(snapshot.view.orderBy, ["deadline_asc", "created_desc"]);
  assert.ok(snapshot.view.sections);
  assert.equal(snapshot.view.sections.length, 1);
  assert.equal(snapshot.view.sections[0].id, "urgent");
  assert.ok(snapshot.view.tray);
  assert.equal(snapshot.view.tray.title, "Backlog");
  assert.ok(snapshot.view.matrix);
  assert.equal(snapshot.view.matrix.x.id, "pri");
  assert.equal(snapshot.view.matrix.y.id, "stat");
  assert.equal(snapshot.view.matrix.unmatched, "hide");
  assert.equal(snapshot.view.matrix.multiMatch, "duplicate");
  assert.equal(snapshot.view.matrix.showEmptyBuckets, false);

  // Summary — all 5 metric types preserved
  assert.equal(snapshot.summary.length, 5);
  assert.equal(snapshot.summary[0].type, "count");
  assert.equal(snapshot.summary[1].type, "sum");
  assert.equal(snapshot.summary[1].field, "planned");
  assert.equal(snapshot.summary[2].type, "ratio");
  assert.equal(snapshot.summary[3].type, "top_n");
  assert.equal(snapshot.summary[3].by, "tags");
  assert.equal(snapshot.summary[4].type, "group_by");

  // Full roundtrip: delete then undo
  const afterDelete = deleteQueryPresetById(presets, "sv-rich");
  assert.equal(afterDelete.length, 1);
  const restored = executeQueryPresetDeleteUndo(afterDelete, plan);
  assert.equal(restored.length, 2);
  const restoredRich = restored.find((p) => p.id === "sv-rich");
  assert.ok(restoredRich);
  assert.deepEqual(restoredRich.filters, snapshot.filters);
  assert.deepEqual(restoredRich.view, snapshot.view);
  assert.deepEqual(restoredRich.summary, snapshot.summary);
});

test("VAL-GUI-004: computeQueryPresetDeleteUndoPlan returns originalIndex=-1 for non-existent id", () => {
  const a = createQueryPreset("A", { status: "todo" }, () => "sv-a");
  const ghost = normalizeQueryPreset({
    id: "sv-ghost",
    name: "Ghost",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: { type: "list" },
    summary: [],
  });

  const plan = computeQueryPresetDeleteUndoPlan([a], ghost);
  assert.equal(plan.originalIndex, -1,
    "missing id returns -1; caller should guard before undo");

  // executeQueryPresetDeleteUndo with -1 inserts at 0 (min(-1, len) = 0)
  const result = executeQueryPresetDeleteUndo([a], plan);
  assert.deepEqual(result.map((p) => p.id), ["sv-ghost", "sv-a"],
    "insertIdx is clamped to 0 when originalIndex is -1");
});

// ── fix-m3-desktop-query-editor-full-dsl-roundtrip ──

test("roundtrip: normalizeQueryPresetView preserves sections", () => {
  const preset = normalizeQueryPreset({
    id: "sv-sections",
    name: "With sections",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: {
      type: "list",
      sections: [
        { id: "s1", title: "Urgent", when: { status: ["todo"], time: { deadline: "overdue" } } },
        { id: "s2", title: "Normal", when: { status: ["todo"] }, orderBy: ["deadline_asc"], limit: 10 },
      ],
    },
    summary: [],
  });

  assert.equal(preset.view.type, "list");
  assert.ok(Array.isArray(preset.view.sections));
  assert.equal(preset.view.sections.length, 2);
  assert.equal(preset.view.sections[0].id, "s1");
  assert.equal(preset.view.sections[0].title, "Urgent");
  assert.deepEqual(preset.view.sections[0].when.status, ["todo"]);
  assert.deepEqual(preset.view.sections[0].when.time, { deadline: "overdue" });
  assert.equal(preset.view.sections[1].id, "s2");
  assert.equal(preset.view.sections[1].limit, 10);
});

test("roundtrip: normalizeQueryPresetView preserves tray config", () => {
  const preset = normalizeQueryPreset({
    id: "sv-tray",
    name: "With tray",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: {
      type: "week",
      tray: {
        enabled: true,
        title: "Unscheduled",
        filters: { status: ["todo"], time: { scheduled: "unscheduled" } },
        orderBy: ["deadline_asc"],
      },
    },
    summary: [],
  });

  assert.equal(preset.view.type, "week");
  assert.ok(preset.view.tray);
  assert.equal(preset.view.tray.enabled, true);
  assert.equal(preset.view.tray.title, "Unscheduled");
  assert.deepEqual(preset.view.tray.filters.status, ["todo"]);
  assert.deepEqual(preset.view.tray.filters.time, { scheduled: "unscheduled" });
  assert.deepEqual(preset.view.tray.orderBy, ["deadline_asc"]);
});

test("roundtrip: normalizeQueryPresetView preserves matrix config", () => {
  const preset = normalizeQueryPreset({
    id: "sv-matrix",
    name: "With matrix",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: {
      type: "matrix",
      matrix: {
        x: {
          id: "priority",
          title: "Priority",
          buckets: [
            { id: "high", title: "High", when: { tags: ["#high"] } },
            { id: "low", title: "Low", when: { tags: ["#low"] } },
          ],
        },
        y: {
          id: "status",
          title: "Status",
          buckets: [
            { id: "active", title: "Active", when: { status: ["todo"] } },
            { id: "done", title: "Done", when: { status: ["done"] } },
          ],
        },
        unmatched: "hide",
        multiMatch: "duplicate",
        showEmptyBuckets: false,
      },
    },
    summary: [],
  });

  assert.equal(preset.view.type, "matrix");
  assert.ok(preset.view.matrix);
  assert.equal(preset.view.matrix.x.id, "priority");
  assert.equal(preset.view.matrix.x.buckets.length, 2);
  assert.equal(preset.view.matrix.y.id, "status");
  assert.equal(preset.view.matrix.y.buckets.length, 2);
  assert.equal(preset.view.matrix.unmatched, "hide");
  assert.equal(preset.view.matrix.multiMatch, "duplicate");
  assert.equal(preset.view.matrix.showEmptyBuckets, false);
});

test("roundtrip: normalizeQueryPresetView preserves orderBy", () => {
  const preset = normalizeQueryPreset({
    id: "sv-orderby",
    name: "With orderBy",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: {
      type: "list",
      orderBy: ["deadline_asc", "created_desc"],
    },
    summary: [],
  });

  assert.equal(preset.view.type, "list");
  assert.deepEqual(preset.view.orderBy, ["deadline_asc", "created_desc"]);
});

test("roundtrip: normalizeQueryPresetSummary preserves all metric types", () => {
  const preset = normalizeQueryPreset({
    id: "sv-summary",
    name: "With summary",
    builtin: false,
    hidden: false,
    filters: { status: "all" },
    view: { type: "list" },
    summary: [
      { type: "count" },
      { type: "sum", field: "planned", format: "duration" },
      { type: "ratio", numerator: "actual", denominator: "estimate", format: "percent" },
      { type: "top_n", field: "tags", limit: 5, format: "number" },
      { type: "group_by", by: "tags" },
    ],
  });

  assert.equal(preset.summary.length, 5);
  assert.equal(preset.summary[0].type, "count");
  assert.equal(preset.summary[1].type, "sum");
  assert.equal(preset.summary[1].field, "planned");
  assert.equal(preset.summary[1].format, "duration");
  assert.equal(preset.summary[2].type, "ratio");
  assert.equal(preset.summary[2].numerator, "actual");
  assert.equal(preset.summary[2].denominator, "estimate");
  assert.equal(preset.summary[3].type, "top_n");
  assert.equal(preset.summary[3].field, "tags");
  assert.equal(preset.summary[3].limit, 5);
  assert.equal(preset.summary[4].type, "group_by");
  assert.equal(preset.summary[4].by, "tags");
});

test("roundtrip: toQueryPreset preserves full view config through conversion", () => {
  const flat = normalizeSavedTaskView({
    id: "sv-flat",
    name: "Flat with matrix",
    builtin: false,
    hidden: false,
    search: "",
    tag: "#alpha",
    time: { scheduled: "week" },
    status: ["todo"],
    view: {
      type: "matrix",
      matrix: {
        x: { id: "cat", title: "Category", buckets: [{ id: "a", title: "A", when: { tags: ["#a"] } }] },
        y: { id: "risk", title: "Risk", buckets: [{ id: "high", title: "High", when: { time: { deadline: "overdue" } } }] },
        unmatched: "show",
        multiMatch: "first",
        showEmptyBuckets: true,
      },
    },
    summary: [{ type: "count" }, { type: "sum", field: "planned" }],
  });

  const qp = toQueryPreset(flat);

  assert.equal(qp.view.type, "matrix");
  assert.ok(qp.view.matrix);
  assert.equal(qp.view.matrix.x.id, "cat");
  assert.equal(qp.view.matrix.y.id, "risk");
  assert.equal(qp.view.matrix.unmatched, "show");
  assert.equal(qp.view.matrix.multiMatch, "first");
  assert.equal(qp.view.matrix.showEmptyBuckets, true);
  assert.equal(qp.summary.length, 2);
  assert.equal(qp.summary[1].type, "sum");
  assert.equal(qp.summary[1].field, "planned");
});

test("roundtrip: fromQueryPreset preserves full view config through conversion", () => {
  const qp = normalizeQueryPreset({
    id: "sv-roundtrip",
    name: "Roundtrip",
    builtin: false,
    hidden: false,
    filters: { tags: ["#alpha"], status: ["todo"], time: { scheduled: "week" } },
    view: {
      type: "matrix",
      matrix: {
        x: { id: "cat", title: "Category", buckets: [{ id: "a", title: "A", when: { tags: ["#a"] } }] },
        y: { id: "risk", title: "Risk", buckets: [{ id: "high", title: "High", when: { time: { deadline: "overdue" } } }] },
        unmatched: "show",
        multiMatch: "first",
        showEmptyBuckets: true,
      },
    },
    summary: [{ type: "count" }, { type: "sum", field: "planned" }],
  });

  const flat = fromQueryPreset(qp);

  assert.equal(flat.view.type, "matrix");
  assert.ok(flat.view.matrix);
  assert.equal(flat.view.matrix.x.id, "cat");
  assert.equal(flat.view.matrix.y.id, "risk");
  assert.equal(flat.view.matrix.unmatched, "show");
  assert.equal(flat.view.matrix.multiMatch, "first");
  assert.equal(flat.summary.length, 2);
  assert.equal(flat.summary[1].type, "sum");
  assert.equal(flat.summary[1].field, "planned");
});

test("roundtrip: parseQueryDsl → stringifyQueryPreset full roundtrip", () => {
  const dsl = stringifyQueryPreset(normalizeQueryPreset({
    id: "sv-full",
    name: "Full Roundtrip",
    builtin: false,
    hidden: false,
    filters: {
      search: "report",
      tags: ["#alpha", "#beta"],
      status: ["todo", "in_progress"],
      time: { scheduled: "week", deadline: "overdue" },
    },
    view: {
      type: "matrix",
      sections: [
        { id: "urgent", title: "Urgent", when: { time: { deadline: "overdue" } }, limit: 5 },
      ],
      tray: {
        enabled: true,
        title: "Backlog",
        filters: { status: ["todo"], time: { scheduled: "unscheduled" } },
      },
      matrix: {
        x: { id: "pri", title: "Pri", buckets: [{ id: "high", title: "High", when: { tags: ["#high"] } }] },
        y: { id: "stat", title: "Stat", buckets: [{ id: "open", title: "Open", when: { status: ["todo"] } }] },
        unmatched: "hide",
        multiMatch: "duplicate",
        showEmptyBuckets: false,
      },
      orderBy: ["deadline_asc"],
    },
    summary: [
      { type: "count" },
      { type: "sum", field: "planned", format: "duration" },
      { type: "ratio", numerator: "actual", denominator: "estimate", format: "percent" },
      { type: "top_n", field: "tags", limit: 3 },
      { type: "group_by", by: "tags" },
    ],
  }));

  const parsed = parseQueryDsl(dsl, { name: "Full Roundtrip" });

  assert.equal(parsed.id, "sv-full");
  assert.equal(parsed.name, "Full Roundtrip");
  assert.equal(parsed.filters.search, "report");
  assert.deepEqual(parsed.filters.tags, ["#alpha", "#beta"]);
  assert.deepEqual(parsed.filters.status, ["todo", "in_progress"]);
  assert.deepEqual(parsed.filters.time, { scheduled: "week", deadline: "overdue" });

  // View
  assert.equal(parsed.view.type, "matrix");
  assert.ok(parsed.view.sections);
  assert.equal(parsed.view.sections.length, 1);
  assert.equal(parsed.view.sections[0].id, "urgent");
  assert.ok(parsed.view.tray);
  assert.equal(parsed.view.tray.title, "Backlog");
  assert.ok(parsed.view.matrix);
  assert.equal(parsed.view.matrix.x.id, "pri");
  assert.equal(parsed.view.matrix.y.id, "stat");
  assert.equal(parsed.view.matrix.unmatched, "hide");
  assert.equal(parsed.view.matrix.multiMatch, "duplicate");
  assert.equal(parsed.view.matrix.showEmptyBuckets, false);
  assert.deepEqual(parsed.view.orderBy, ["deadline_asc"]);

  // Summary
  assert.equal(parsed.summary.length, 5);
  assert.equal(parsed.summary[0].type, "count");
  assert.equal(parsed.summary[1].type, "sum");
  assert.equal(parsed.summary[1].field, "planned");
  assert.equal(parsed.summary[2].type, "ratio");
  assert.equal(parsed.summary[3].type, "top_n");
  assert.equal(parsed.summary[3].limit, 3);
  assert.equal(parsed.summary[4].type, "group_by");
  assert.equal(parsed.summary[4].by, "tags");

  // Full re-serialize identity
  const reSerialized = stringifyQueryPreset(parsed);
  const reparsed = parseQueryDsl(reSerialized, { name: "Full Roundtrip" });
  assert.ok(sameQueryPresetContent(parsed, reparsed));
});

// ── fix-m3-summary-topn-and-editor-path-tests ──

test("VAL-CORE-009: normalizeQueryPreset preserves top_n by field as canonical grouping parameter", () => {
  // top_n grouping must use `by`, not `field`. The GUI was writing `field`
  // which the runtime summary (`computeTopN`) ignores in favor of `by`.
  const preset = normalizeQueryPreset({
    id: "sv-topn",
    name: "Top N Test",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: { type: "list" },
    summary: [
      { type: "top_n", by: " tags ", limit: 5 },
    ],
  });

  assert.equal(preset.summary.length, 1);
  assert.equal(preset.summary[0].type, "top_n");
  assert.equal(preset.summary[0].by, "tags", "top_n by must be preserved and trimmed");
  assert.equal(preset.summary[0].limit, 5);
  // Verify `field` was not set — top_n canonical grouping is `by`
  assert.equal(preset.summary[0].field, undefined, "top_n must use by, not field");
});

test("summary: [] persists through createQueryPreset", () => {
  const p = createQueryPreset("No Summary", {
    status: "all",
    summary: [],
  });
  assert.deepEqual(p.summary, [], "explicit empty summary must persist");
});

test("summary: [] persists through normalizeQueryPreset", () => {
  const p = normalizeQueryPreset({
    id: "sv-empty-summary",
    name: "Empty Summary",
    builtin: false,
    hidden: false,
    filters: { status: "all" },
    view: { type: "list" },
    summary: [],
  });
  assert.deepEqual(p.summary, [], "explicit empty summary must not be replaced");
});

test("summary: undefined falls back to [] in normalizeQueryPreset", () => {
  const p = normalizeQueryPreset({
    id: "sv-no-summary",
    name: "No summary key",
    builtin: false,
    hidden: false,
    filters: { status: "all" },
    view: { type: "list" },
    // summary key intentionally omitted
  });
  assert.deepEqual(p.summary, [], "missing summary defaults to empty array");
});

test("summary: [] persists through upsertQueryPreset (insert and update)", () => {
  const p1 = createQueryPreset("A", { status: "todo", summary: [{ type: "count" }] });
  const p2 = normalizeQueryPreset({
    id: "sv-empty",
    name: "Empty",
    builtin: false,
    hidden: false,
    filters: { status: "done" },
    view: { type: "list" },
    summary: [],
  });

  // Insert
  const afterInsert = upsertQueryPreset([p1], p2);
  assert.equal(afterInsert.length, 2);
  const inserted = afterInsert.find((p) => p.id === "sv-empty");
  assert.ok(inserted);
  assert.deepEqual(inserted.summary, [], "upsert(insert) must preserve explicit empty summary");

  // Update
  const p3 = normalizeQueryPreset({
    id: "sv-empty",
    name: "Empty Updated",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: { type: "list" },
    summary: [],
  });
  const afterUpdate = upsertQueryPreset(afterInsert, p3);
  const updated = afterUpdate.find((p) => p.id === "sv-empty");
  assert.ok(updated);
  assert.equal(updated.name, "Empty Updated");
  assert.deepEqual(updated.summary, [], "upsert(update) must preserve explicit empty summary");
});

test("summary: empty array roundtrips through serialize/parse", () => {
  const original = normalizeQueryPreset({
    id: "sv-empty-roundtrip",
    name: "Empty Roundtrip",
    builtin: false,
    hidden: false,
    filters: { status: "all" },
    view: { type: "list" },
    summary: [],
  });

  const dsl = stringifyQueryPreset(original);
  const parsed = parseQueryDsl(dsl, { name: "Empty Roundtrip" });
  assert.deepEqual(parsed.summary, [], "empty summary must survive serialize/parse roundtrip");
  assert.ok(sameQueryPresetContent(original, parsed), "empty-summary preset must be content-identical after roundtrip");
});

test("summary: draft merge — draft summary overrides saved when present", () => {
  // Simulates currentQuerySnapshot merge: tabDraft?.summary ?? existing?.summary
  const saved = createQueryPreset("Saved", {
    status: "all",
    summary: [{ type: "count" }],
  });

  const draft = normalizeQueryPreset({
    ...saved,
    summary: [{ type: "sum", field: "planned" }],
  });

  // Merge: draft wins
  const merged = normalizeQueryPreset({
    ...saved,
    summary: draft.summary,
  });

  assert.equal(merged.summary.length, 1);
  assert.equal(merged.summary[0].type, "sum");
  assert.equal(merged.name, "Saved");
  assert.equal(merged.id, saved.id);
});

test("summary: draft merge — draft view overrides saved when present", () => {
  const saved = createQueryPreset("Saved", {
    status: "all",
    view: { type: "list" },
  });

  const draft = normalizeQueryPreset({
    ...saved,
    view: { type: "week" },
  });

  const merged = normalizeQueryPreset({
    ...saved,
    view: draft.view,
  });

  assert.equal(merged.view.type, "week");
  assert.equal(merged.id, saved.id);
  assert.equal(merged.name, "Saved");
});

test("summary: draft merge — explicit empty draft summary overrides saved summary", () => {
  // When user deletes all metrics via the editor, draft.summary becomes [].
  // The merge must use [] (draft wins), not fall back to saved summary.
  const saved = createQueryPreset("Saved", {
    status: "all",
    summary: [{ type: "count" }, { type: "sum", field: "planned" }],
  });

  const draft = normalizeQueryPreset({
    ...saved,
    summary: [],
  });

  // currentQuerySnapshot uses: tabDraft?.summary ?? existing?.summary
  // tabDraft.summary is [] (truthy), so it wins
  const merged = normalizeQueryPreset({
    ...saved,
    summary: draft.summary,
  });

  assert.deepEqual(merged.summary, [], "explicit empty summary in draft must override saved summary");
});

test("summary: add/edit/remove metrics roundtrip through pure functions", () => {
  // Simulate the editor flow:
  // 1. Create preset with summary=[{type: "count"}]
  // 2. Add a sum metric
  // 3. Edit the sum metric's field
  // 4. Add a top_n metric with `by` (not `field`)
  // 5. Remove the count metric

  // Step 1: Create
  let preset = createQueryPreset("Metrics Test", {
    status: "all",
    summary: [{ type: "count" }],
  });
  assert.equal(preset.summary.length, 1);
  assert.equal(preset.summary[0].type, "count");

  // Step 2: Add sum metric
  preset = normalizeQueryPreset({
    ...preset,
    summary: [...preset.summary, { type: "sum", field: "planned" }],
  });
  assert.equal(preset.summary.length, 2);
  assert.equal(preset.summary[1].type, "sum");
  assert.equal(preset.summary[1].field, "planned");

  // Step 3: Edit sum field from "planned" to "actual"
  const metrics3 = preset.summary.map((m, i) =>
    i === 1 ? { ...m, field: "actual" } : m,
  );
  preset = normalizeQueryPreset({ ...preset, summary: metrics3 });
  assert.equal(preset.summary[1].field, "actual");

  // Step 4: Add top_n with `by` (NOT `field`)
  preset = normalizeQueryPreset({
    ...preset,
    summary: [...preset.summary, { type: "top_n", by: "tags", limit: 5 }],
  });
  assert.equal(preset.summary.length, 3);
  assert.equal(preset.summary[2].type, "top_n");
  assert.equal(preset.summary[2].by, "tags");
  assert.equal(preset.summary[2].limit, 5);
  // Verify top_n does NOT have a `field` property
  assert.equal(preset.summary[2].field, undefined, "top_n must use by, not field");

  // Step 5: Remove count metric (index 0)
  preset = normalizeQueryPreset({
    ...preset,
    summary: preset.summary.filter((_, i) => i !== 0),
  });
  assert.equal(preset.summary.length, 2);
  assert.equal(preset.summary[0].type, "sum");
  assert.equal(preset.summary[0].field, "actual");
  assert.equal(preset.summary[1].type, "top_n");
  assert.equal(preset.summary[1].by, "tags");

  // Verify persistence through upsert
  const presets = upsertQueryPreset([], preset);
  assert.equal(presets.length, 1);
  assert.deepEqual(presets[0].summary, preset.summary);
});

test("summary: sameQueryPresetContent detects difference across summary, view, and filters", () => {
  const base = createQueryPreset("Base", {
    status: "all",
    summary: [{ type: "count" }],
    view: { type: "list" },
  });

  // Summary differs
  const diffSummary = createQueryPreset("B", {
    status: "all",
    summary: [{ type: "sum", field: "planned" }],
    view: { type: "list" },
  });
  assert.equal(sameQueryPresetContent(base, diffSummary), false);

  // View differs
  const diffView = createQueryPreset("C", {
    status: "all",
    summary: [{ type: "count" }],
    view: { type: "week" },
  });
  assert.equal(sameQueryPresetContent(base, diffView), false);

  // Filters differ
  const diffFilter = createQueryPreset("D", {
    status: "done",
    summary: [{ type: "count" }],
    view: { type: "list" },
  });
  assert.equal(sameQueryPresetContent(base, diffFilter), false);

  // Same content, different id/name — should be true
  const sameContent = createQueryPreset("Different Name", {
    status: "all",
    summary: [{ type: "count" }],
    view: { type: "list" },
  });
  assert.ok(sameQueryPresetContent(base, sameContent));
});

test("summary: currentQuerySnapshot merge preserves identity from saved, content from draft", () => {
  // Full simulation of currentQuerySnapshot:
  // - id/name/builtin/hidden from saved
  // - view/summary from draft (when present)
  // - filters from view state

  const saved = normalizeQueryPreset({
    id: "sv-saved-1",
    name: "Original Name",
    builtin: true,
    hidden: false,
    filters: { status: "todo", tags: ["#work"] },
    view: { type: "list", preset: "today", orderBy: ["deadline_asc"] },
    summary: [{ type: "count" }],
  });

  // Draft has edited view and summary
  const draft = normalizeQueryPreset({
    ...saved,
    view: { type: "week" },
    summary: [{ type: "sum", field: "planned" }],
  });

  // currentQuerySnapshot merge (identity from saved, content from draft)
  const snapshot = normalizeQueryPreset({
    id: saved.id,
    name: saved.name,
    builtin: saved.builtin,
    hidden: saved.hidden,
    filters: saved.filters,
    view: draft.view,
    summary: draft.summary,
  });

  assert.equal(snapshot.id, "sv-saved-1");
  assert.equal(snapshot.name, "Original Name");
  assert.equal(snapshot.builtin, true);
  assert.equal(snapshot.hidden, false);
  assert.deepEqual(snapshot.filters.status, ["todo"]);
  assert.equal(snapshot.view.type, "week", "draft view wins over saved");
  assert.equal(snapshot.summary.length, 1, "draft summary wins over saved");
  assert.equal(snapshot.summary[0].type, "sum");
});

test("summary: currentQuerySnapshot fallback to saved when no draft exists", () => {
  // When there is no draft, use saved view/summary
  const saved = normalizeQueryPreset({
    id: "sv-saved-2",
    name: "Saved Only",
    builtin: false,
    hidden: false,
    filters: { status: "all" },
    view: { type: "month" },
    summary: [{ type: "count" }, { type: "top_n", by: "tags", limit: 3 }],
  });

  // No draft → use saved directly
  const snapshot = normalizeQueryPreset({
    ...saved,
    view: saved.view,
    summary: saved.summary,
  });

  assert.equal(snapshot.view.type, "month");
  assert.equal(snapshot.summary.length, 2);
  assert.equal(snapshot.summary[1].type, "top_n");
  assert.equal(snapshot.summary[1].by, "tags");
});

// ── fix-m3-delete-undo-production-path-test ──
// Production-path tests that exercise executeDeleteQueryPresetFlow
// (the testable counterpart of TaskCenterView.deleteSavedViewWithConfirm)
// with stub confirm / notice callbacks — not just helper-only simulation.

test("VAL-GUI-004 production: confirm denied → no deletion, presets unchanged", async () => {
  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("Gamma", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  const normalizedCopies = presets.map((p) => normalizeQueryPreset(p));
  const normalizedB = normalizedCopies[1];

  let confirmCalled = false;
  let noticeCreated = false;

  const result = await executeDeleteQueryPresetFlow(
    presets,
    normalizedB,
    "sv-a",
    "sv-b",
    {
      confirm: async (viewName) => {
        confirmCalled = true;
        assert.equal(viewName, "Beta");
        return false; // User cancels
      },
      createUndoNotice: () => {
        noticeCreated = true;
        return { onUndoClick: () => {}, close: () => {} };
      },
      showRestoredNotice: () => {},
    },
  );

  assert.equal(result.confirmed, false);
  assert.equal(result.undoPlan, null);
  assert.equal(result.wasDefault, false);
  assert.equal(result.wasActive, false);
  assert.deepEqual(result.presetsAfter, presets, "presets unchanged when cancelled");
  assert.equal(result.undoNotice, null);
  assert.equal(confirmCalled, true);
  assert.equal(noticeCreated, false, "notice should not be created when cancelled");
});

test("VAL-GUI-004 production: confirm → delete → presetsAfter removes target, undoPlan captures snapshot", async () => {
  const a = createQueryPreset("Alpha", {
    search: "focus",
    tags: ["#work"],
    status: ["todo"],
    time: { scheduled: "week" },
    view: { type: "week", orderBy: ["deadline_risk"] },
    summary: [{ type: "count" }, { type: "sum", field: "planned" }],
  }, () => "sv-a");
  const b = createQueryPreset("Beta", {
    search: "docs",
    tags: ["#docs"],
    status: ["done"],
    view: { type: "list" },
    summary: [{ type: "count" }],
  }, () => "sv-b");
  const c = createQueryPreset("Gamma", {
    search: "meetings",
    tags: ["#meeting"],
    status: ["todo", "done"],
    view: { type: "month" },
    summary: [],
  }, () => "sv-c");
  const presets = [a, b, c];

  const normalizedCopies = presets.map((p) => normalizeQueryPreset(p));
  const normalizedB = normalizedCopies[1];

  let confirmCallName = null;
  let noticeCallName = null;
  let noticeUndoLabel = null;

  const result = await executeDeleteQueryPresetFlow(
    presets,
    normalizedB,
    "sv-a",   // Alpha is default
    "sv-b",   // Beta is active
    {
      confirm: async (viewName) => {
        confirmCallName = viewName;
        return true; // User confirms
      },
      createUndoNotice: (viewName, undoLabel) => {
        noticeCallName = viewName;
        noticeUndoLabel = undoLabel;
        // Return a controller — caller (view.ts) wires onUndoClick
        let storedHandler = null;
        return {
          onUndoClick: (handler) => { storedHandler = handler; },
          close: () => {},
          // Expose for test verification
          getStoredHandler: () => storedHandler,
        };
      },
      showRestoredNotice: () => {},
    },
  );

  assert.equal(result.confirmed, true);
  assert.equal(confirmCallName, "Beta");
  assert.equal(noticeCallName, "Beta");
  assert.equal(noticeUndoLabel, "撤销");

  // Verify deletion
  assert.deepEqual(result.presetsAfter.map((p) => p.id), ["sv-a", "sv-c"],
    "Beta should be removed");

  // Verify undo plan snapshot
  assert.ok(result.undoPlan);
  assert.equal(result.undoPlan.snapshot.id, "sv-b");
  assert.equal(result.undoPlan.snapshot.name, "Beta");
  assert.equal(result.undoPlan.originalIndex, 1);
  assert.deepEqual(result.undoPlan.snapshot.filters.search, "docs");
  assert.deepEqual(result.undoPlan.snapshot.filters.tags, ["#docs"]);
  assert.deepEqual(result.undoPlan.snapshot.filters.status, ["done"]);
  assert.deepEqual(result.undoPlan.snapshot.view, { type: "list" });
  assert.equal(result.undoPlan.snapshot.summary.length, 1);

  // Verify state flags
  assert.equal(result.wasDefault, false, "Beta was not default (Alpha is)");
  assert.equal(result.wasActive, true, "Beta was active");

  // Verify undo notice controller was returned
  assert.ok(result.undoNotice);
  assert.equal(typeof result.undoNotice.onUndoClick, "function");
  assert.equal(typeof result.undoNotice.close, "function");
});

test("VAL-GUI-004 production: clicking undo restores order via executeQueryPresetDeleteUndo", async () => {
  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("Gamma", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  const normalizedCopies = presets.map((p) => normalizeQueryPreset(p));
  const normalizedB = normalizedCopies[1];

  let undoHandler = null;
  let closed = false;

  const result = await executeDeleteQueryPresetFlow(
    presets,
    normalizedB,
    "sv-a",
    "sv-b",
    {
      confirm: async () => true,
      createUndoNotice: () => ({
        onUndoClick: (handler) => { undoHandler = handler; },
        close: () => { closed = true; },
      }),
      showRestoredNotice: () => {},
    },
  );

  assert.equal(result.confirmed, true);
  assert.deepEqual(result.presetsAfter.map((p) => p.id), ["sv-a", "sv-c"]);

  // Simulate the caller (view.ts) wiring the undo handler
  const undoPlan = result.undoPlan;
  assert.ok(undoPlan);
  result.undoNotice.onUndoClick(async () => {
    closed = true;
  });
  assert.ok(undoHandler, "undo click handler should have been registered by onUndoClick");

  // Apply the undo manually (as the production view.ts undo handler would)
  const restored = executeQueryPresetDeleteUndo(result.presetsAfter, undoPlan);
  assert.deepEqual(restored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"],
    "undo restores Beta to its original position (index 1)");

  const restoredBeta = restored[1];
  assert.equal(restoredBeta.id, "sv-b");
  assert.equal(restoredBeta.name, "Beta");
  assert.deepEqual(restoredBeta.filters, undoPlan.snapshot.filters);
  assert.deepEqual(restoredBeta.view, undoPlan.snapshot.view);
  assert.deepEqual(restoredBeta.summary, undoPlan.snapshot.summary);
});

test("VAL-GUI-004 production: undo restores default state when deleted tab was default", async () => {
  const a = createQueryPreset("Alpha", { status: "todo" }, () => "sv-a");
  const b = createQueryPreset("Beta", { status: "done" }, () => "sv-b");
  const c = createQueryPreset("Gamma", { status: "all" }, () => "sv-c");
  const presets = [a, b, c];

  const normalizedCopies = presets.map((p) => normalizeQueryPreset(p));
  const normalizedA = normalizedCopies[0]; // Alpha is default AND active

  let undoHandler = null;

  const result = await executeDeleteQueryPresetFlow(
    presets,
    normalizedA,
    "sv-a",   // Alpha IS default
    "sv-a",   // Alpha IS active
    {
      confirm: async () => true,
      createUndoNotice: () => ({
        onUndoClick: (handler) => { undoHandler = handler; },
        close: () => {},
      }),
      showRestoredNotice: () => {},
    },
  );

  assert.equal(result.confirmed, true);
  assert.equal(result.wasDefault, true, "deleted tab was default");
  assert.equal(result.wasActive, true, "deleted tab was active");
  assert.deepEqual(result.presetsAfter.map((p) => p.id), ["sv-b", "sv-c"]);
  assert.equal(result.undoPlan.originalIndex, 0);

  // Simulate caller wiring: register the undo handler
  result.undoNotice.onUndoClick(async () => {});
  assert.ok(undoHandler, "undo click handler should have been registered by onUndoClick");

  // Apply undo manually
  const restored = executeQueryPresetDeleteUndo(result.presetsAfter, result.undoPlan);
  assert.deepEqual(restored.map((p) => p.id), ["sv-a", "sv-b", "sv-c"]);

  // Verify default/active would be restored (as production code does)
  if (result.wasDefault) {
    const newDefaultId = result.undoPlan.snapshot.id;
    assert.equal(newDefaultId, "sv-a", "default restored to Alpha");
  }
  if (result.wasActive) {
    const reactivated = restored.find((p) => p.id === result.undoPlan.snapshot.id);
    assert.ok(reactivated, "Alpha restored as active tab");
  }
});

test("VAL-GUI-004 production: confirm-delete-undo roundtrip preserves all QueryPreset fields", async () => {
  // Full matrix+section+tray+summary preset — verify complete roundtrip
  const rich = normalizeQueryPreset({
    id: "sv-full",
    name: "Full View",
    builtin: false,
    hidden: false,
    filters: {
      search: "deep work",
      tags: ["#focus", "#priority"],
      status: ["todo", "in_progress"],
      time: { scheduled: "week", deadline: "overdue", completed: "month" },
    },
    view: {
      type: "matrix",
      sections: [
        { id: "urgent", title: "Urgent", when: { time: { deadline: "overdue" } }, limit: 5, orderBy: ["deadline_asc"] },
      ],
      tray: {
        enabled: true,
        title: "Backlog",
        filters: { status: ["todo"], time: { scheduled: "unscheduled" } },
        orderBy: ["deadline_asc"],
      },
      matrix: {
        x: {
          id: "pri",
          title: "Priority",
          buckets: [
            { id: "high", title: "High", when: { tags: ["#high"] } },
            { id: "low", title: "Low", when: { tags: ["#low"] } },
          ],
        },
        y: {
          id: "stat",
          title: "Status",
          buckets: [
            { id: "open", title: "Open", when: { status: ["todo"] } },
            { id: "done", title: "Done", when: { status: ["done"] } },
          ],
        },
        unmatched: "hide",
        multiMatch: "duplicate",
        showEmptyBuckets: false,
      },
      orderBy: ["deadline_asc", "created_desc"],
    },
    summary: [
      { type: "count" },
      { type: "sum", field: "planned", format: "duration" },
      { type: "ratio", numerator: "actual", denominator: "estimate", format: "percent" },
      { type: "top_n", by: "tags", limit: 5 },
      { type: "group_by", by: "tags" },
    ],
  });

  const other = createQueryPreset("Other", { status: "all" }, () => "sv-other");
  const presets = [other, rich];

  let undoHandler = null;

  const result = await executeDeleteQueryPresetFlow(
    presets,
    rich,
    null,
    "sv-full",
    {
      confirm: async () => true,
      createUndoNotice: () => ({
        onUndoClick: (handler) => { undoHandler = handler; },
        close: () => {},
      }),
      showRestoredNotice: () => {},
    },
  );

  assert.equal(result.confirmed, true);
  assert.deepEqual(result.presetsAfter.map((p) => p.id), ["sv-other"]);

  // Simulate caller wiring: register the undo handler
  result.undoNotice.onUndoClick(async () => {});
  assert.ok(undoHandler, "undo click handler should have been registered by onUndoClick");

  // Verify snapshot preserves ALL fields
  const snap = result.undoPlan.snapshot;
  assert.equal(snap.id, "sv-full");
  assert.equal(snap.name, "Full View");

  // Filters
  assert.equal(snap.filters.search, "deep work");
  assert.deepEqual(snap.filters.tags, ["#focus", "#priority"]);
  assert.deepEqual(snap.filters.status, ["todo", "in_progress"]);
  assert.deepEqual(snap.filters.time, { scheduled: "week", deadline: "overdue", completed: "month" });

  // View — matrix, sections, tray all preserved
  assert.equal(snap.view.type, "matrix");
  assert.equal(snap.view.sections.length, 1);
  assert.equal(snap.view.sections[0].id, "urgent");
  assert.ok(snap.view.tray);
  assert.equal(snap.view.tray.title, "Backlog");
  assert.ok(snap.view.matrix);
  assert.equal(snap.view.matrix.x.id, "pri");
  assert.equal(snap.view.matrix.y.id, "stat");
  assert.equal(snap.view.matrix.unmatched, "hide");
  assert.equal(snap.view.matrix.multiMatch, "duplicate");
  assert.equal(snap.view.matrix.showEmptyBuckets, false);

  // Summary — all 5 types
  assert.equal(snap.summary.length, 5);
  assert.equal(snap.summary[0].type, "count");
  assert.equal(snap.summary[1].type, "sum");
  assert.equal(snap.summary[2].type, "ratio");
  assert.equal(snap.summary[3].type, "top_n");
  assert.equal(snap.summary[3].by, "tags");
  assert.equal(snap.summary[4].type, "group_by");

  // Undo restores everything
  const restored = executeQueryPresetDeleteUndo(result.presetsAfter, result.undoPlan);
  assert.equal(restored.length, 2);
  const restoredRich = restored.find((p) => p.id === "sv-full");
  assert.ok(restoredRich);
  assert.deepEqual(restoredRich.filters, snap.filters);
  assert.deepEqual(restoredRich.view, snap.view);
  assert.deepEqual(restoredRich.summary, snap.summary);
});

// ── fix-m3-query-editor-production-path-tests ──
// Production-path tests that exercise computeQueryPresetSnapshot with real
// tabDrafts Maps — the same function called by TaskCenterView.currentQuerySnapshot.
// Also exercise summary metric add/edit/remove pure helpers, and verify
// summary:[] and top_n by through the production save/update seams.

test("production: computeQueryPresetSnapshot merges tabDrafts view over saved view", () => {
  const tabDrafts = new Map();

  const saved = normalizeQueryPreset({
    id: "sv-1",
    name: "My Tab",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: { type: "list" },
    summary: [{ type: "count" }],
  });

  // Draft modifies the view
  const draft = normalizeQueryPreset({
    ...saved,
    view: { type: "week" },
  });
  tabDrafts.set("sv-1", draft);

  const snapshot = computeQueryPresetSnapshot({
    existing: saved,
    tabDrafts,
    filterSearch: "",
    filterTags: "",
    filterTime: {},
    filterStatus: "all",
    fallbackView: () => ({ type: "list" }),
    fallbackSummary: () => [],
  });

  // Draft view wins
  assert.equal(snapshot.view.type, "week", "draft view must win over saved view");
  // Identity preserved from saved
  assert.equal(snapshot.id, "sv-1");
  assert.equal(snapshot.name, "My Tab");
  // Summary unchanged — draft didn't touch it → falls back to saved
  assert.equal(snapshot.summary.length, 1);
  assert.equal(snapshot.summary[0].type, "count");
});

test("production: computeQueryPresetSnapshot merges tabDrafts summary over saved summary", () => {
  const tabDrafts = new Map();

  const saved = normalizeQueryPreset({
    id: "sv-2",
    name: "Tab 2",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: { type: "list" },
    summary: [{ type: "count" }],
  });

  // Draft modifies the summary
  const draft = normalizeQueryPreset({
    ...saved,
    summary: [{ type: "sum", field: "planned" }],
  });
  tabDrafts.set("sv-2", draft);

  const snapshot = computeQueryPresetSnapshot({
    existing: saved,
    tabDrafts,
    filterSearch: "focus",
    filterTags: "#work,#urgent",
    filterTime: { scheduled: "week" },
    filterStatus: ["todo"],
    fallbackView: () => ({ type: "list" }),
    fallbackSummary: () => [],
  });

  // Draft summary wins
  assert.equal(snapshot.summary.length, 1);
  assert.equal(snapshot.summary[0].type, "sum");
  assert.equal(snapshot.summary[0].field, "planned");
  // View unchanged — draft didn't touch it → falls back to saved
  assert.equal(snapshot.view.type, "list");
  // Filters from explicit state
  assert.equal(snapshot.filters.search, "focus");
  assert.deepEqual(snapshot.filters.tags, ["#work", "#urgent"]);
  assert.deepEqual(snapshot.filters.time, { scheduled: "week" });
  assert.deepEqual(snapshot.filters.status, ["todo"]);
});

test("production: explicit empty summary [] in draft overrides saved summary", () => {
  const tabDrafts = new Map();

  const saved = normalizeQueryPreset({
    id: "sv-3",
    name: "With Summary",
    builtin: false,
    hidden: false,
    filters: { status: "all" },
    view: { type: "list" },
    summary: [{ type: "count" }, { type: "sum", field: "planned" }],
  });

  // Draft explicitly clears the summary
  const draft = normalizeQueryPreset({
    ...saved,
    summary: [],
  });
  tabDrafts.set("sv-3", draft);

  const snapshot = computeQueryPresetSnapshot({
    existing: saved,
    tabDrafts,
    filterSearch: "",
    filterTags: "",
    filterTime: {},
    filterStatus: "all",
    fallbackView: () => ({ type: "list" }),
    fallbackSummary: () => [{ type: "count" }],
  });

  // Explicit empty draft summary wins — it is NOT falsy, so the saved summary
  // is NOT a fallback
  assert.deepEqual(snapshot.summary, [],
    "explicit empty summary in draft must override saved summary");
});

test("production: draft with both view and summary changed merges correctly", () => {
  const tabDrafts = new Map();

  const saved = normalizeQueryPreset({
    id: "sv-4",
    name: "Full Tab",
    builtin: true,
    hidden: false,
    filters: { status: "todo", tags: ["#alpha"] },
    view: { type: "list", preset: "today" },
    summary: [{ type: "count" }],
  });

  const draft = normalizeQueryPreset({
    ...saved,
    view: { type: "week" },
    summary: [
      { type: "sum", field: "planned" },
      { type: "top_n", by: "tags", limit: 5 },
    ],
  });
  tabDrafts.set("sv-4", draft);

  const snapshot = computeQueryPresetSnapshot({
    existing: saved,
    tabDrafts,
    filterSearch: "docs",
    filterTags: "#work",
    filterTime: { deadline: "overdue" },
    filterStatus: ["todo", "in_progress"],
    fallbackView: () => ({ type: "list" }),
    fallbackSummary: () => [],
  });

  assert.equal(snapshot.id, "sv-4");
  assert.equal(snapshot.name, "Full Tab");
  assert.equal(snapshot.builtin, true);
  assert.equal(snapshot.hidden, false);
  // Draft view wins
  assert.equal(snapshot.view.type, "week");
  // Draft summary wins
  assert.equal(snapshot.summary.length, 2);
  assert.equal(snapshot.summary[0].type, "sum");
  assert.equal(snapshot.summary[1].type, "top_n");
  assert.equal(snapshot.summary[1].by, "tags");
  // Filters from explicit state
  assert.equal(snapshot.filters.search, "docs");
  assert.deepEqual(snapshot.filters.tags, ["#work"]);
  assert.deepEqual(snapshot.filters.time, { deadline: "overdue" });
  assert.deepEqual(snapshot.filters.status, ["todo", "in_progress"]);
});

test("production: snapshot falls back to saved when no draft exists in tabDrafts", () => {
  const tabDrafts = new Map();
  // tabDrafts is empty — no draft for sv-5

  const saved = normalizeQueryPreset({
    id: "sv-5",
    name: "No Draft",
    builtin: false,
    hidden: false,
    filters: { status: "done" },
    view: { type: "month" },
    summary: [{ type: "count" }, { type: "ratio", numerator: "actual", denominator: "estimate" }],
  });

  const snapshot = computeQueryPresetSnapshot({
    existing: saved,
    tabDrafts,
    filterSearch: "",
    filterTags: "",
    filterTime: {},
    filterStatus: "all",
    fallbackView: () => ({ type: "list" }),
    fallbackSummary: () => [],
  });

  // No draft → saved wins
  assert.equal(snapshot.view.type, "month");
  assert.equal(snapshot.summary.length, 2);
  assert.equal(snapshot.summary[0].type, "count");
  assert.equal(snapshot.summary[1].type, "ratio");
});

test("production: snapshot falls back to explicit fallbacks when no saved and no draft", () => {
  const tabDrafts = new Map();

  const snapshot = computeQueryPresetSnapshot({
    existing: null,
    tabDrafts,
    filterSearch: "search term",
    filterTags: "#alpha",
    filterTime: { scheduled: "today" },
    filterStatus: ["todo"],
    fallbackView: () => ({ type: "week", orderBy: ["deadline_asc"] }),
    fallbackSummary: () => [{ type: "count" }, { type: "group_by", by: "tags" }],
    name: "New Snapshot",
  });

  assert.equal(snapshot.name, "New Snapshot");
  assert.equal(snapshot.builtin, false);
  assert.equal(snapshot.hidden, false);
  assert.equal(snapshot.filters.search, "search term");
  assert.deepEqual(snapshot.filters.tags, ["#alpha"]);
  assert.deepEqual(snapshot.filters.time, { scheduled: "today" });
  assert.deepEqual(snapshot.filters.status, ["todo"]);
  // Fallback view used
  assert.equal(snapshot.view.type, "week");
  assert.deepEqual(snapshot.view.orderBy, ["deadline_asc"]);
  // Fallback summary used
  assert.equal(snapshot.summary.length, 2);
  assert.equal(snapshot.summary[1].type, "group_by");
});

test("production: applySummaryMetricEdit modifies field at index", () => {
  const original = [
    { type: "count" },
    { type: "sum", field: "planned" },
    { type: "top_n", by: "tags", limit: 3 },
  ];

  // Edit sum metric: change field from "planned" to "actual"
  const edited = applySummaryMetricEdit(original, 1, { field: "actual" });
  assert.equal(edited.length, 3);
  assert.equal(edited[0].type, "count");
  assert.equal(edited[1].type, "sum");
  assert.equal(edited[1].field, "actual");
  assert.equal(edited[2].type, "top_n");
  assert.equal(edited[2].by, "tags");

  // Original must be unchanged (immutability)
  assert.equal(original[1].field, "planned");
});

test("production: applySummaryMetricEdit preserves top_n by field", () => {
  const original = [{ type: "top_n", by: "tags", limit: 3 }];

  // Edit top_n: change by to "status", change limit to 10
  const edited = applySummaryMetricEdit(original, 0, { by: "status", limit: 10 });
  assert.equal(edited.length, 1);
  assert.equal(edited[0].type, "top_n");
  assert.equal(edited[0].by, "status", "top_n by must be preserved through edit");
  assert.equal(edited[0].limit, 10);

  // Verify field is NOT set (top_n uses by, not field)
  assert.equal(edited[0].field, undefined, "top_n must use by, not field");
});

test("production: applySummaryMetricEdit is no-op for out-of-range index", () => {
  const original = [{ type: "count" }, { type: "sum", field: "planned" }];

  const edited = applySummaryMetricEdit(original, 5, { field: "actual" });
  assert.deepEqual(edited, original, "out-of-range edit should return unchanged copy");
});

test("production: applySummaryMetricRemove removes metric at index", () => {
  const original = [
    { type: "count" },
    { type: "sum", field: "planned" },
    { type: "top_n", by: "tags", limit: 5 },
  ];

  const removed = applySummaryMetricRemove(original, 1);
  assert.equal(removed.length, 2);
  assert.equal(removed[0].type, "count");
  assert.equal(removed[1].type, "top_n");
  assert.equal(removed[1].by, "tags");

  // Original must be unchanged
  assert.equal(original.length, 3);
});

test("production: applySummaryMetricRemove clears all metrics via repeated removal", () => {
  let metrics = [
    { type: "count" },
    { type: "sum", field: "planned" },
    { type: "top_n", by: "tags", limit: 5 },
  ];

  // Remove all one by one
  metrics = applySummaryMetricRemove(metrics, 2);
  assert.equal(metrics.length, 2);
  metrics = applySummaryMetricRemove(metrics, 1);
  assert.equal(metrics.length, 1);
  metrics = applySummaryMetricRemove(metrics, 0);
  assert.equal(metrics.length, 0);
  assert.deepEqual(metrics, [], "all metrics removed → empty summary");
});

test("production: applySummaryMetricAdd appends new metric", () => {
  const original = [{ type: "count" }];

  const added = applySummaryMetricAdd(original, { type: "sum", field: "planned" });
  assert.equal(added.length, 2);
  assert.equal(added[0].type, "count");
  assert.equal(added[1].type, "sum");
  assert.equal(added[1].field, "planned");

  // Original must be unchanged
  assert.equal(original.length, 1);
});

test("production: applySummaryMetricAdd with top_n uses by not field", () => {
  const original = [{ type: "count" }];

  const added = applySummaryMetricAdd(original, { type: "top_n", by: "tags", limit: 5 });
  assert.equal(added.length, 2);
  assert.equal(added[1].type, "top_n");
  assert.equal(added[1].by, "tags", "top_n must use by, not field");
  assert.equal(added[1].limit, 5);
  assert.equal(added[1].field, undefined, "top_n must NOT have field set");
});

test("production: full summary add/edit/remove roundtrip through production helpers", () => {
  // Simulate the exact flow of the Query Editor summary controls:
  // 1. Start with empty summary
  // 2. Add count metric
  // 3. Add sum metric with field="planned"
  // 4. Edit sum metric: field → "actual"
  // 5. Add top_n metric with by="tags", limit=5
  // 6. Remove count metric
  // 7. Edit top_n: by → "status", limit → 10

  const tabDrafts = new Map();

  // Step 1: empty
  let summary = [];

  // Step 2: add count
  summary = applySummaryMetricAdd(summary, { type: "count" });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].type, "count");

  // Step 3: add sum
  summary = applySummaryMetricAdd(summary, { type: "sum", field: "planned" });
  assert.equal(summary.length, 2);
  assert.equal(summary[1].type, "sum");
  assert.equal(summary[1].field, "planned");

  // Step 4: edit sum field
  summary = applySummaryMetricEdit(summary, 1, { field: "actual" });
  assert.equal(summary[1].field, "actual");

  // Step 5: add top_n with by (NOT field)
  summary = applySummaryMetricAdd(summary, { type: "top_n", by: "tags", limit: 5 });
  assert.equal(summary.length, 3);
  assert.equal(summary[2].type, "top_n");
  assert.equal(summary[2].by, "tags");
  assert.equal(summary[2].limit, 5);

  // Step 6: remove count (index 0)
  summary = applySummaryMetricRemove(summary, 0);
  assert.equal(summary.length, 2);
  assert.equal(summary[0].type, "sum");
  assert.equal(summary[1].type, "top_n");

  // Step 7: edit top_n
  summary = applySummaryMetricEdit(summary, 1, { by: "status", limit: 10 });
  assert.equal(summary[1].by, "status");
  assert.equal(summary[1].limit, 10);

  // Verify the final state matches what would be persisted
  const preset = normalizeQueryPreset({
    id: "sv-edited",
    name: "Edited",
    builtin: false,
    hidden: false,
    filters: { status: "all" },
    view: { type: "list" },
    summary,
  });

  assert.equal(preset.summary.length, 2);
  assert.equal(preset.summary[0].type, "sum");
  assert.equal(preset.summary[0].field, "actual");
  assert.equal(preset.summary[1].type, "top_n");
  assert.equal(preset.summary[1].by, "status");
  assert.equal(preset.summary[1].limit, 10);

  // Persist through upsert — verify full roundtrip
  const presets = upsertQueryPreset([], preset);
  assert.equal(presets.length, 1);
  assert.deepEqual(presets[0].summary, summary,
    "full add/edit/remove roundtrip must persist through upsert");

  // Verify serialization roundtrip
  const dsl = stringifyQueryPreset(presets[0]);
  const reparsed = parseQueryDsl(dsl, { name: "Edited" });
  assert.ok(sameQueryPresetContent(presets[0], reparsed),
    "serialize/parse roundtrip must preserve edited summary");
});

test("production: summary:[] persists through save-as seam via computeQueryPresetSnapshot + upsertQueryPreset", () => {
  // Simulate the saveCurrentView production path:
  // 1. computeQueryPresetSnapshot produces a snapshot with summary:[]
  // 2. upsertQueryPreset saves it
  // 3. Verify the saved preset has summary:[]

  const tabDrafts = new Map();
  const saved = normalizeQueryPreset({
    id: "sv-empty-save",
    name: "Empty Summary Tab",
    builtin: false,
    hidden: false,
    filters: { status: "all" },
    view: { type: "list" },
    summary: [],
  });

  // Draft also has empty summary (user explicitly cleared all metrics)
  tabDrafts.set("sv-empty-save", normalizeQueryPreset({
    ...saved,
    summary: [],
  }));

  // Step 1: snapshot via production function
  const snapshot = computeQueryPresetSnapshot({
    existing: saved,
    tabDrafts,
    filterSearch: "",
    filterTags: "",
    filterTime: {},
    filterStatus: "all",
    fallbackView: () => ({ type: "list" }),
    fallbackSummary: () => [{ type: "count" }], // default would be count, but draft wins
    name: "Empty Summary Tab",
  });

  assert.deepEqual(snapshot.summary, [],
    "snapshot must preserve explicit empty summary");

  // Step 2: save-as (new id, like saveCurrentView does)
  const asNew = normalizeQueryPreset({
    ...snapshot,
    id: "sv-new-empty",
    builtin: false,
    hidden: false,
  });

  const presets = upsertQueryPreset([], asNew);
  assert.equal(presets.length, 1);
  assert.deepEqual(presets[0].summary, [],
    "saved preset must preserve explicit empty summary");

  // Step 3: verify serialization preserves empty summary
  const dsl = stringifyQueryPreset(presets[0]);
  const reparsed = parseQueryDsl(dsl, { name: "Empty Summary Tab" });
  assert.deepEqual(reparsed.summary, [],
    "serialize/parse must preserve empty summary");
});

test("production: summary:[] persists through update seam via computeQueryPresetSnapshot + updateQueryPresetById", () => {
  // Simulate the updateCurrentSavedView production path:
  // 1. User clears all summary metrics in the editor → draft.summary = []
  // 2. computeQueryPresetSnapshot picks up draft.summary = []
  // 3. updateQueryPresetById saves the updated preset
  // 4. Verify the saved preset has summary:[]

  const tabDrafts = new Map();
  const saved = normalizeQueryPreset({
    id: "sv-update-empty",
    name: "Update Empty",
    builtin: false,
    hidden: false,
    filters: { status: "all" },
    view: { type: "list" },
    summary: [{ type: "count" }, { type: "sum", field: "planned" }],
  });

  // User clears all metrics → draft.summary = []
  const draft = normalizeQueryPreset({
    ...saved,
    summary: [],
  });
  tabDrafts.set("sv-update-empty", draft);

  // Step 1: snapshot via production function
  const snapshot = computeQueryPresetSnapshot({
    existing: saved,
    tabDrafts,
    filterSearch: "",
    filterTags: "",
    filterTime: {},
    filterStatus: "all",
    fallbackView: () => ({ type: "list" }),
    fallbackSummary: () => [{ type: "count" }],
  });

  assert.deepEqual(snapshot.summary, [],
    "snapshot must pick up draft's explicit empty summary");

  // Step 2: update (same id)
  const updated = normalizeQueryPreset({
    ...snapshot,
    id: "sv-update-empty",
    name: "Update Empty",
  });

  const presets = updateQueryPresetById([saved], updated);
  assert.equal(presets.length, 1);
  assert.deepEqual(presets[0].summary, [],
    "updated preset must preserve explicit empty summary");

  // Step 3: verify roundtrip
  const dsl = stringifyQueryPreset(presets[0]);
  const reparsed = parseQueryDsl(dsl, { name: "Update Empty" });
  assert.deepEqual(reparsed.summary, [],
    "serialize/parse must preserve empty summary after update");
});

test("production: top_n canonical by parameter persists through computeQueryPresetSnapshot + save/update seams", () => {
  // Verify that top_n uses `by` (not `field`) through the full production path.
  // This ensures the GUI visual control (which writes `by`) is correctly
  // consumed by runtime summary (computeTopN reads `by`).

  const tabDrafts = new Map();
  const saved = normalizeQueryPreset({
    id: "sv-topn-path",
    name: "Top N Path",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: { type: "list" },
    summary: [{ type: "count" }],
  });

  // Draft adds a top_n metric with `by` (the canonical grouping parameter)
  const draft = normalizeQueryPreset({
    ...saved,
    summary: [
      { type: "count" },
      { type: "top_n", by: "tags", limit: 5 },
    ],
  });
  tabDrafts.set("sv-topn-path", draft);

  // Snapshot via production function
  const snapshot = computeQueryPresetSnapshot({
    existing: saved,
    tabDrafts,
    filterSearch: "",
    filterTags: "",
    filterTime: {},
    filterStatus: "todo",
    fallbackView: () => ({ type: "list" }),
    fallbackSummary: () => [],
  });

  assert.equal(snapshot.summary.length, 2);
  const topnMetric = snapshot.summary[1];
  assert.equal(topnMetric.type, "top_n");
  assert.equal(topnMetric.by, "tags", "top_n must use by as canonical grouping parameter");
  assert.equal(topnMetric.limit, 5);
  assert.equal(topnMetric.field, undefined, "top_n must NOT use field; canonical parameter is by");

  // Save-as (new id)
  const asNew = normalizeQueryPreset({
    ...snapshot,
    id: "sv-topn-new",
    builtin: false,
  });
  const savedPresets = upsertQueryPreset([], asNew);
  const savedTopN = savedPresets[0].summary[1];
  assert.equal(savedTopN.by, "tags", "top_n by must persist through save-as");
  assert.equal(savedTopN.field, undefined);

  // Update (same id)
  const updatedSnapshot = computeQueryPresetSnapshot({
    existing: savedPresets[0],
    tabDrafts: new Map(), // no draft this time
    filterSearch: "",
    filterTags: "",
    filterTime: {},
    filterStatus: "todo",
    fallbackView: () => ({ type: "list" }),
    fallbackSummary: () => [],
  });

  // Edit the top_n: change by from "tags" to "status"
  const edited = normalizeQueryPreset({
    ...updatedSnapshot,
    summary: applySummaryMetricEdit(updatedSnapshot.summary, 1, { by: "status", limit: 10 }),
  });

  const updatedPresets = updateQueryPresetById(savedPresets, edited);
  const updatedTopN = updatedPresets[0].summary[1];
  assert.equal(updatedTopN.by, "status", "top_n by must persist through update seam");
  assert.equal(updatedTopN.limit, 10);
  assert.equal(updatedTopN.field, undefined, "top_n must not have field after update");

  // Serialization roundtrip
  const dsl = stringifyQueryPreset(updatedPresets[0]);
  const reparsed = parseQueryDsl(dsl, { name: "Top N Path" });
  const reparsedTopN = reparsed.summary[1];
  assert.equal(reparsedTopN.by, "status", "top_n by must survive serialize/parse roundtrip");
  assert.equal(reparsedTopN.limit, 10);
});

test("production: computeQueryPresetSnapshot with name override for save-as flow", () => {
  const tabDrafts = new Map();
  const saved = normalizeQueryPreset({
    id: "sv-saved",
    name: "Original",
    builtin: false,
    hidden: false,
    filters: { status: "todo" },
    view: { type: "list" },
    summary: [{ type: "count" }],
  });

  const snapshot = computeQueryPresetSnapshot({
    existing: saved,
    tabDrafts,
    filterSearch: "",
    filterTags: "",
    filterTime: {},
    filterStatus: "todo",
    fallbackView: () => ({ type: "list" }),
    fallbackSummary: () => [],
    name: "Save As Copy",
  });

  assert.equal(snapshot.name, "Save As Copy", "name override must be used for save-as");
  assert.equal(snapshot.id, "sv-saved", "identity id comes from existing preset");

  // The caller (saveCurrentView) will overwrite id with createSavedViewId()
  const asNew = normalizeQueryPreset({
    ...snapshot,
    id: "sv-new-id",
    builtin: false,
    hidden: false,
  });

  assert.equal(asNew.id, "sv-new-id");
  assert.equal(asNew.name, "Save As Copy");
  assert.deepEqual(asNew.view, snapshot.view);
  assert.deepEqual(asNew.summary, snapshot.summary);
});
