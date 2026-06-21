// Unit tests for EffectiveTask derivation (task-tree.ts).
// VAL-CORE-004: inheritance, terminal cascade, top-level dedupe,
// independent-date subtask breakout.
//
// Run with: `node --test test/task-tree.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compile() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/task-tree.ts",
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--outfile=test/.compiled/task-tree.bundle.js",
      "--alias:obsidian=./test/obsidian-stub.mjs",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("esbuild failed:\n" + result.stderr);
  }
}

compile();
const { deriveEffectiveTasks, countTopLevel } = await import(
  "../test/.compiled/task-tree.bundle.js"
);

// ── helpers ──

/**
 * Build a flat ParsedTask[] from a compact DSL so test fixtures are
 * readable.  Each entry is:
 *   [line, indent, checkbox, title, opts?]
 *
 * opts may contain { scheduled, deadline, created, statusOverride }.
 * parentLine is derived from indent: children are indented more than
 * the nearest previous task with less indent.
 */
function mkTasks(defs) {
  const tasks = [];
  const stack = []; // { line, indent }
  for (let i = 0; i < defs.length; i++) {
    const [line, indent, checkbox, title, opts = {}] = defs[i];
    const indentLen = indent.length;
    // Find parent: last task on stack with strictly less indent.
    while (stack.length > 0 && stack[stack.length - 1].indent >= indentLen) {
      stack.pop();
    }
    const parentLine = stack.length > 0 ? stack[stack.length - 1].line : null;
    stack.push({ line, indent: indentLen });

    const rawIndent = indent;
    const rawLine = `${indent}- [${checkbox}] ${title}`;
    const content = title;
    const statusMap = { " ": "todo", x: "done", X: "done", "-": "dropped", "/": "in_progress", ">": "cancelled" };
    const status = opts.statusOverride ?? (statusMap[checkbox] ?? "custom");

    // Simple hash
    const hashInput = `test.md::${title}`;
    let h1 = 0xdeadbeef ^ 0;
    let h2 = 0x41c6ce57 ^ 0;
    for (let j = 0; j < hashInput.length; j++) {
      const ch = hashInput.charCodeAt(j);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const hi = (h2 >>> 0).toString(16).padStart(8, "0");
    const lo = (h1 >>> 0).toString(16).padStart(8, "0");
    const hash = (hi + lo).slice(0, 12);

    tasks.push({
      id: `test.md:L${line + 1}`,
      path: "test.md",
      line,
      indent: rawIndent,
      checkbox,
      status,
      title,
      rawTitle: content,
      rawLine,
      tags: [],
      scheduled: opts.scheduled ?? null,
      deadline: opts.deadline ?? null,
      start: null,
      completed: null,
      cancelled: null,
      created: opts.created ?? null,
      recurrence: null,
      priority: null,
      calloutDepth: 0,
      inlineFields: {},
      durationFields: {},
      estimate: null,
      actual: null,
      parentLine,
      parentIndex: parentLine,
      childrenLines: [],
      hash,
      mtime: 1000,
      inheritsTerminal: opts.inheritsTerminal ?? false,
      inheritedTerminalKind: opts.inheritedTerminalKind ?? null,
    });
  }
  return tasks;
}

function cloneTaskForPath(task, path) {
  return {
    ...task,
    id: `${path}:L${task.line + 1}`,
    path,
    childrenLines: [...task.childrenLines],
  };
}

// ── US-144: Inheritance ──

test("US-144: child inherits parent's ⏳ when own is null", () => {
  const tasks = mkTasks([
    [0, "",    " ", "Parent", { scheduled: "2026-04-24" }],
    [1, "  ",  " ", "Child",  {}],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[1].effectiveScheduled, "2026-04-24");
});

test("US-144: child's own ⏳ overrides inherited", () => {
  const tasks = mkTasks([
    [0, "",    " ", "Parent", { scheduled: "2026-04-24" }],
    [1, "  ",  " ", "Child",  { scheduled: "2026-04-25" }],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[1].effectiveScheduled, "2026-04-25");
});

test("US-144: child inherits 📅 from parent", () => {
  const tasks = mkTasks([
    [0, "",    " ", "Parent", { deadline: "2026-05-15" }],
    [1, "  ",  " ", "Child",  {}],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[1].effectiveDeadline, "2026-05-15");
});

test("US-144: child inherits ➕ from parent", () => {
  const tasks = mkTasks([
    [0, "",    " ", "Parent", { created: "2026-04-19" }],
    [1, "  ",  " ", "Child",  {}],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[1].effectiveCreated, "2026-04-19");
});

test("US-144: multi-level inheritance — grandchild inherits from grandparent", () => {
  const tasks = mkTasks([
    [0, "",    " ", "Grandparent", { scheduled: "2026-04-20", deadline: "2026-06-01" }],
    [1, "  ",  " ", "Parent",      {}],
    [2, "    "," ", "Child",       {}],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[2].effectiveScheduled, "2026-04-20");
  assert.equal(eff[2].effectiveDeadline, "2026-06-01");
});

test("US-144: inheritance chain stops at own value even if ancestor also has one", () => {
  // Grandparent has scheduled=04-20, Parent has scheduled=04-22, Child has none.
  // Child should inherit from Parent (04-22), not grandparent.
  const tasks = mkTasks([
    [0, "",    " ", "GP",  { scheduled: "2026-04-20" }],
    [1, "  ",  " ", "P",   { scheduled: "2026-04-22" }],
    [2, "    "," ", "C",   {}],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[2].effectiveScheduled, "2026-04-22");
});

// ── US-145 / US-144a: Terminal cascade ──

test("US-145: done parent makes children inherit done status", () => {
  const tasks = mkTasks([
    [0, "",    "x", "DoneParent"],
    [1, "  ",  " ", "TodoChild"],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[1].effectiveStatus, "done");
  assert.ok(eff[1].terminalInheritedFrom);
});

test("US-145: dropped parent makes children inherit dropped status", () => {
  const tasks = mkTasks([
    [0, "",    "-", "DroppedParent"],
    [1, "  ",  " ", "TodoChild"],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[1].effectiveStatus, "dropped");
});

test("US-145: multi-level terminal cascade", () => {
  const tasks = mkTasks([
    [0, "",    "x", "DoneGP"],
    [1, "  ",  " ", "TodoP"],
    [2, "    "," ", "TodoC"],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[1].effectiveStatus, "done");
  assert.equal(eff[2].effectiveStatus, "done");
});

test("US-144a: child of terminal parent still gets inheritsTerminal status", () => {
  const tasks = mkTasks([
    [0, "",    "x", "DoneParent"],
    [1, "  ",  " ", "TodoChild"],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  // Child effectiveStatus should be "done"
  assert.equal(eff[1].effectiveStatus, "done");
  // terminalInheritedFrom should point to the parent
  assert.equal(eff[1].terminalInheritedFrom, eff[0].id);
});

test("US-145: already-completed child under terminal parent keeps its own completed status", () => {
  const tasks = mkTasks([
    [0, "",    "x", "DoneParent"],
    [1, "  ",  "x", "AlsoDoneChild"],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  // Already done child: terminal cascade doesn't change that it's done,
  // but terminalInheritedFrom should still be set.
  assert.equal(eff[1].effectiveStatus, "done");
});

// ── US-143: Top-level deduplication ──

test("US-143: parent-visible children are NOT top-level", () => {
  const tasks = mkTasks([
    [0, "",    " ", "Parent"],
    [1, "  ",  " ", "Child"],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[0].isTopLevelInQuery, true, "parent should be top-level");
  assert.equal(eff[1].isTopLevelInQuery, false, "child should not be top-level when parent visible");
  assert.equal(eff[1].renderParentId, eff[0].id);
});

test("US-143: children with NO visible parent ARE top-level", () => {
  // If somehow a child has no parent in the task set (orphaned), it's top-level.
  const tasks = mkTasks([
    [0, "  ",  " ", "OrphanedChild"],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[0].isTopLevelInQuery, true);
});

test("US-143: countTopLevel equals visible parent cards only", () => {
  const tasks = mkTasks([
    [0, "",    " ", "P1"],
    [1, "  ",  " ", "C1"],
    [2, "",    " ", "P2"],
    [3, "  ",  " ", "C2a"],
    [4, "    "," ", "C2b"],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  // 2 top-level parents
  assert.equal(countTopLevel(eff), 2);
});

// ── US-148 / US-149: Independent-date subtask breakout ──

test("US-148: child with own different ⏳ breaks out as independent top-level", () => {
  const tasks = mkTasks([
    [0, "",    " ", "Parent", { scheduled: "2026-04-24" }],
    [1, "  ",  " ", "Child",  { scheduled: "2026-04-26" }],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[0].isTopLevelInQuery, true, "parent is top-level");
  assert.equal(eff[1].isTopLevelInQuery, true, "independent-date child should break out");
  assert.equal(eff[1].renderParentId, null, "broken-out child has no render parent");
});

test("US-148: child with same ⏳ stays nested", () => {
  const tasks = mkTasks([
    [0, "",    " ", "Parent", { scheduled: "2026-04-24" }],
    [1, "  ",  " ", "Child",  { scheduled: "2026-04-24" }],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[0].isTopLevelInQuery, true);
  assert.equal(eff[1].isTopLevelInQuery, false, "same-date child stays nested");
  assert.equal(eff[1].renderParentId, eff[0].id);
});

test("US-148: child with no own ⏳ stays nested (inherits parent date)", () => {
  const tasks = mkTasks([
    [0, "",    " ", "Parent", { scheduled: "2026-04-24" }],
    [1, "  ",  " ", "Child",  {}],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[1].effectiveScheduled, "2026-04-24");
  assert.equal(eff[1].isTopLevelInQuery, false, "inheriting child stays nested");
});

test("US-148: grandchild with independent date breaks out from grandparent context", () => {
  const tasks = mkTasks([
    [0, "",    " ", "GP", { scheduled: "2026-04-20" }],
    [1, "  ",  " ", "P",  {}],                         // inherits 04-20
    [2, "    "," ", "GC", { scheduled: "2026-04-22" }], // own date differs
  ]);
  const eff = deriveEffectiveTasks(tasks);
  // GC has its own ⏳ that differs from effective parent (P inherits 04-20)
  assert.equal(eff[2].effectiveScheduled, "2026-04-22");
  assert.equal(eff[2].isTopLevelInQuery, true, "independent-date grandchild breaks out");
});

test("US-149: multiple children, only the one with different date breaks out", () => {
  const tasks = mkTasks([
    [0, "",    " ", "Parent", { scheduled: "2026-04-24" }],
    [1, "  ",  " ", "ChildA", { scheduled: "2026-04-24" }], // same → nested
    [2, "  ",  " ", "ChildB", { scheduled: "2026-04-26" }], // different → break out
    [3, "  ",  " ", "ChildC", {}],                           // no own → inherit → nested
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[0].isTopLevelInQuery, true);
  assert.equal(eff[1].isTopLevelInQuery, false, "same-date ChildA stays nested");
  assert.equal(eff[2].isTopLevelInQuery, true, "different-date ChildB breaks out");
  assert.equal(eff[3].isTopLevelInQuery, false, "inheriting ChildC stays nested");
});

test("US-148 regression: same line numbers in different files do not cross-parent", () => {
  const fileA = mkTasks([
    [0, "",   " ", "Learn Math", { scheduled: "2026-05-06" }],
    [1, "\t", "x", "Learn Lesson 1"],
    [2, "\t", " ", "Learn Lesson 2", { scheduled: "2026-04-29" }],
  ]).map((task) => cloneTaskForPath(task, "Daily/2026-04-28.md"));
  const fileB = mkTasks([
    [0, "",   " ", "Learn AI Agent", { scheduled: "2026-04-25" }],
    [1, "\t", " ", "Test [[Multica]]"],
    [2, "\t", " ", "Test [[Slock.ai]]"],
  ]).map((task) => cloneTaskForPath(task, "Daily/2026-04-24.md"));

  const eff = deriveEffectiveTasks([...fileA, ...fileB]);
  const learnMath = eff.find((task) => task.id === "Daily/2026-04-28.md:L1");
  const lesson1 = eff.find((task) => task.id === "Daily/2026-04-28.md:L2");
  const lesson2 = eff.find((task) => task.id === "Daily/2026-04-28.md:L3");
  const multica = eff.find((task) => task.id === "Daily/2026-04-24.md:L2");
  const slock = eff.find((task) => task.id === "Daily/2026-04-24.md:L3");

  assert.equal(lesson1?.renderParentId, learnMath?.id, "same-file child should stay under Learn Math");
  assert.equal(lesson2?.renderParentId, null, "different-date child should break out");
  assert.notEqual(multica?.renderParentId, learnMath?.id, "other file L2 must not render under Learn Math");
  assert.notEqual(slock?.renderParentId, learnMath?.id, "other file L3 must not render under Learn Math");
});

// ── Combined scenarios ──

test("VAL-CORE-004: terminal parent + independent-date child still breaks out", () => {
  // A done parent with a child that has its own separate date:
  // the child should be terminal-inherited (done) BUT still
  // broken out as its own top-level card on its date.
  const tasks = mkTasks([
    [0, "",    "x", "DoneParent", { scheduled: "2026-04-20" }],
    [1, "  ",  " ", "Child",      { scheduled: "2026-04-25" }],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  // Child inherits terminal status
  assert.equal(eff[1].effectiveStatus, "done");
  // But also breaks out because of different date
  assert.equal(eff[1].isTopLevelInQuery, true);
  assert.equal(eff[1].renderParentId, null);
});

test("VAL-CORE-004: multi-level with mixed inheritance", () => {
  const tasks = mkTasks([
    [0, "",    " ", "Root",   { scheduled: "2026-04-24", deadline: "2026-05-01" }],
    [1, "  ",  " ", "P1",     { scheduled: "2026-04-24" }],  // same date, own deadline missing
    [2, "    ","x", "P1Child",{}],                             // inherits from P1
    [3, "  ",  " ", "P2",     { scheduled: "2026-04-26" }],   // different date
    [4, "    "," ", "P2Child",{}],                             // inherits from P2
  ]);
  const eff = deriveEffectiveTasks(tasks);

  // Root: top-level
  assert.equal(eff[0].isTopLevelInQuery, true);
  assert.equal(eff[0].effectiveScheduled, "2026-04-24");

  // P1: same date → nested under Root
  assert.equal(eff[1].isTopLevelInQuery, false);
  assert.equal(eff[1].renderParentId, eff[0].id);
  assert.equal(eff[1].effectiveDeadline, "2026-05-01"); // inherited from Root

  // P1Child: terminal (parent is done), nested
  assert.equal(eff[2].effectiveStatus, "done");
  assert.equal(eff[2].isTopLevelInQuery, false);
  assert.equal(eff[2].effectiveScheduled, "2026-04-24"); // inherited

  // P2: different date → breaks out
  assert.equal(eff[3].isTopLevelInQuery, true);
  assert.equal(eff[3].renderParentId, null);
  assert.equal(eff[3].effectiveDeadline, "2026-05-01"); // inherited from Root

  // P2Child: nested under P2
  assert.equal(eff[4].isTopLevelInQuery, false);
  assert.equal(eff[4].renderParentId, eff[3].id);
  assert.equal(eff[4].effectiveScheduled, "2026-04-26"); // inherited from P2
});

test("VAL-CORE-004: sibling tasks at same indent level are all top-level", () => {
  const tasks = mkTasks([
    [0, "",    " ", "TaskA", { scheduled: "2026-04-24" }],
    [1, "",    " ", "TaskB", { scheduled: "2026-04-25" }],
    [2, "",    " ", "TaskC", { scheduled: "2026-04-26" }],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[0].isTopLevelInQuery, true);
  assert.equal(eff[1].isTopLevelInQuery, true);
  assert.equal(eff[2].isTopLevelInQuery, true);
  assert.equal(countTopLevel(eff), 3);
});

// ── fix-m1-effective-terminal-inheritance ──
// Non-task bullet/section with #dropped / [-] terminal marker
// makes descendant tasks effectiveStatus dropped (not done, not active).

test("US-144a: non-task #dropped section makes descendant todo task dropped", () => {
  // Simulates: - #dropped My Section
  //              - [ ] Task A        (inheritsTerminal from non-task #dropped)
  const tasks = mkTasks([
    [0, "  ",  " ", "TaskA", {
      inheritsTerminal: true,
      inheritedTerminalKind: "dropped",
    }],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[0].effectiveStatus, "dropped",
    "task under #dropped section should be dropped");
  assert.equal(eff[0].terminalInheritedFrom, eff[0].id,
    "terminalInheritedFrom should point to self when source is non-task");
});

test("US-144a: non-task #dropped section cascades through multiple task levels", () => {
  // Simulates: - #dropped My Section
  //              - [ ] Task A        (inheritsTerminal=dropped)
  //                - [ ] Task B      (inheritsTerminal=dropped, from non-task via chain)
  //                  - [ ] Task C    (inheritsTerminal=dropped, from non-task via chain)
  // Note: the parser sets inheritedTerminalKind on every descendant that
  // can walk to a terminal ancestor, so intermediate tasks also carry it.
  const tasks = mkTasks([
    [0, "  ",  " ", "TaskA", {
      inheritsTerminal: true,
      inheritedTerminalKind: "dropped",
    }],
    [1, "    ", " ", "TaskB", {
      inheritsTerminal: true,
      inheritedTerminalKind: "dropped",
    }],
    [2, "      ", " ", "TaskC", {
      inheritsTerminal: true,
      inheritedTerminalKind: "dropped",
    }],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  // Task A: directly inherits from non-task #dropped
  assert.equal(eff[0].effectiveStatus, "dropped",
    "Task A under #dropped section should be dropped");
  // Task B: inherits terminal from Task A
  assert.equal(eff[1].effectiveStatus, "dropped",
    "Task B under dropped parent should be dropped");
  assert.equal(eff[1].terminalInheritedFrom, eff[0].id);
  // Task C: deep descendant
  assert.equal(eff[2].effectiveStatus, "dropped",
    "deep descendant should preserve dropped kind");
  assert.equal(eff[2].terminalInheritedFrom, eff[1].id);
});

test("US-144a: dropped parent task cascades dropped (not done) to children", () => {
  // A dropped task's children should become dropped, not done.
  const tasks = mkTasks([
    [0, "",    "-", "DroppedParent"],
    [1, "  ",  " ", "TodoChild"],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[1].effectiveStatus, "dropped",
    "child of dropped parent should be dropped, not done");
  assert.equal(eff[1].terminalInheritedFrom, eff[0].id);
});

test("US-144a: done terminal kind remains done through deep descendants", () => {
  // A done parent's children should remain done (not collapsed to something else).
  const tasks = mkTasks([
    [0, "",    "x", "DoneGP"],
    [1, "  ",  " ", "TodoP"],
    [2, "    "," ", "TodoC"],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[1].effectiveStatus, "done");
  assert.equal(eff[2].effectiveStatus, "done");
});

test("US-144a: non-task [x] section makes descendant task done", () => {
  // Simulates: - [x] Completed Section
  //              - [ ] Task A        (inheritsTerminal from non-task [x])
  const tasks = mkTasks([
    [0, "  ",  " ", "TaskA", {
      inheritsTerminal: true,
      inheritedTerminalKind: "done",
    }],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[0].effectiveStatus, "done",
    "task under [x] section should be done");
  assert.equal(eff[0].terminalInheritedFrom, eff[0].id,
    "terminalInheritedFrom should point to self when source is non-task");
});

test("US-144a: done task ancestor with inheritedTerminalKind=done passes done to child", () => {
  // Task A inherits done from non-task section; Task B (child of A) should also be done.
  const tasks = mkTasks([
    [0, "  ",  " ", "TaskA", {
      inheritsTerminal: true,
      inheritedTerminalKind: "done",
    }],
    [1, "    ", " ", "TaskB", {
      inheritsTerminal: true,
    }],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[0].effectiveStatus, "done");
  assert.equal(eff[1].effectiveStatus, "done");
  assert.equal(eff[1].terminalInheritedFrom, eff[0].id);
});

test("US-144a: dropped kind survives through terminal cascade, done does not collapse it", () => {
  // Task A: inheritsTerminal=dropped from non-task source
  // Task B: child of A, should also be dropped (not done)
  const tasks = mkTasks([
    [0, "  ",  " ", "TaskA", {
      inheritsTerminal: true,
      inheritedTerminalKind: "dropped",
    }],
    [1, "    ", " ", "TaskB", {}],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[0].effectiveStatus, "dropped");
  assert.equal(eff[1].effectiveStatus, "dropped",
    "child of dropped-inheriting task must be dropped, not done");
  assert.equal(eff[1].terminalInheritedFrom, eff[0].id);
});

test("US-144a: terminalInheritedFrom is null when task has no terminal ancestor", () => {
  const tasks = mkTasks([
    [0, "",    " ", "NormalTask"],
  ]);
  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff[0].terminalInheritedFrom, null);
  assert.equal(eff[0].effectiveStatus, "todo");
});

// ── bug#6: cycle guard ──

test("bug#6: self-referencing parentLine does not hang (cycle guard)", () => {
  // Simulate a ListItemCache producing a task whose parentLine points
  // to itself — a cycle that would previously loop forever.
  const tasks = mkTasks([
    [0, "", " ", "SelfParent", {}],
  ]);
  // Manually corrupt the parent pointer so the task is its own parent.
  tasks[0].parentLine = 0;
  tasks[0].parentIndex = 0;

  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff.length, 1, "task should still be returned");
  assert.equal(eff[0].effectiveStatus, "todo");
});

test("bug#6: two-task cycle in parent chain does not hang", () => {
  // A → parent B, B → parent A: mutual cycle.
  const tasks = mkTasks([
    [0, "",   " ", "TaskA", {}],
    [1, "  ", " ", "TaskB", {}],
  ]);
  // Make A point to B as parent, and B already points to A (via mkTasks).
  // Manually make B also point back to A to create a cycle.
  tasks[0].parentLine = 1;
  tasks[0].parentIndex = 1;

  const eff = deriveEffectiveTasks(tasks);
  assert.equal(eff.length, 2, "both tasks should be returned");
});
