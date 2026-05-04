// Unit tests for pure writer string-mutation helpers.
// Run with: `node --test test/writer.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Compile writer.ts as a self-contained ESM bundle with obsidian stubbed out.
function compile() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/writer.ts",
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--outfile=test/.compiled/writer.bundle.js",
      "--external:obsidian",
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
  setEmojiDate,
  setInlineField,
  setCheckbox,
  addTagIfMissing,
  rebuildTaskLineWithNewTitle,
  indentLen,
  extractTaskBlock,
  findChildrenEnd,
  reindentBlock,
  planSameFileNest,
  planCrossFileNest,
  applyUndoOps,
} = await import("../test/.compiled/writer.bundle.js");

test("setEmojiDate — inject into bare line", () => {
  const r = setEmojiDate("- [ ] task", "⏳", "2026-04-25");
  assert.equal(r, "- [ ] task ⏳ 2026-04-25");
});

test("setEmojiDate — replace existing", () => {
  const r = setEmojiDate("- [ ] task ⏳ 2026-04-20", "⏳", "2026-04-25");
  assert.equal(r, "- [ ] task ⏳ 2026-04-25");
});

test("setEmojiDate — inject before Dataview field", () => {
  const r = setEmojiDate("- [ ] task [estimate:: 30m]", "⏳", "2026-04-25");
  assert.equal(r, "- [ ] task ⏳ 2026-04-25 [estimate:: 30m]");
});

test("setEmojiDate — clear (date=null)", () => {
  const r = setEmojiDate("- [ ] task ⏳ 2026-04-25", "⏳", null);
  assert.equal(r, "- [ ] task");
});

test("setEmojiDate — strip duplicate ⏳ defensively", () => {
  const r = setEmojiDate(
    "- [ ] task ⏳ 2026-04-20 ⏳ 2026-04-22",
    "⏳",
    "2026-04-25",
  );
  assert.equal(r, "- [ ] task ⏳ 2026-04-25");
});

test("setEmojiDate — different emoji preserved", () => {
  const r = setEmojiDate("- [ ] task 📅 2026-05-15 ⏳ 2026-04-20", "⏳", "2026-04-25");
  assert.equal(r, "- [ ] task 📅 2026-05-15 ⏳ 2026-04-25");
});

test("setCheckbox — todo → done", () => {
  assert.equal(setCheckbox("- [ ] foo", "x"), "- [x] foo");
});

test("setCheckbox — done → dropped", () => {
  assert.equal(setCheckbox("- [x] foo", "-"), "- [-] foo");
});

test("setCheckbox — callout prefix preserved", () => {
  assert.equal(setCheckbox("> - [ ] callout task", "x"), "> - [x] callout task");
});

test("setCheckbox — indented", () => {
  assert.equal(setCheckbox("    - [ ] sub", "x"), "    - [x] sub");
});

test("setInlineField — inject estimate", () => {
  const r = setInlineField("- [ ] task", "estimate", "30m");
  assert.equal(r, "- [ ] task [estimate:: 30m]");
});

test("setInlineField — replace existing actual", () => {
  const r = setInlineField("- [ ] task [actual:: 15m]", "actual", "45m");
  assert.equal(r, "- [ ] task [actual:: 45m]");
});

test("setInlineField — clear (value=null)", () => {
  const r = setInlineField("- [ ] task [estimate:: 30m]", "estimate", null);
  assert.equal(r, "- [ ] task");
});

test("addTagIfMissing — adds new tag", () => {
  assert.equal(addTagIfMissing("- [ ] task", "#2象限"), "- [ ] task #2象限");
});

test("addTagIfMissing — no-op if present", () => {
  const l = "- [ ] task #2象限";
  assert.equal(addTagIfMissing(l, "#2象限"), l);
});

test("addTagIfMissing — accepts bare tag", () => {
  assert.equal(addTagIfMissing("- [ ] task", "基建"), "- [ ] task #基建");
});

test("rebuildTaskLineWithNewTitle — plain", () => {
  assert.equal(
    rebuildTaskLineWithNewTitle("- [ ] old title", "new title"),
    "- [ ] new title",
  );
});

test("rebuildTaskLineWithNewTitle — preserves tags + ⏳ + [estimate::]", () => {
  const raw = "- [ ] old title #2象限 ⏳ 2026-04-25 [estimate:: 30m]";
  const r = rebuildTaskLineWithNewTitle(raw, "renamed");
  assert.equal(r, "- [ ] renamed #2象限 ⏳ 2026-04-25 [estimate:: 30m]");
});

test("rebuildTaskLineWithNewTitle — preserves 📅 ✅ ❌ ➕ 🛫", () => {
  const raw =
    "- [x] x #tag 📅 2026-05-15 🛫 2026-04-20 ⏳ 2026-04-22 ➕ 2026-04-18 ✅ 2026-04-23";
  const r = rebuildTaskLineWithNewTitle(raw, "y");
  assert.equal(
    r,
    "- [x] y #tag 📅 2026-05-15 🛫 2026-04-20 ⏳ 2026-04-22 ➕ 2026-04-18 ✅ 2026-04-23",
  );
});

test("rebuildTaskLineWithNewTitle — preserves recurrence", () => {
  const raw = "- [ ] old 🔁 every week ⏳ 2026-04-24";
  const r = rebuildTaskLineWithNewTitle(raw, "new");
  // 🔁 greedy capture swallows trailing space but metadata survives.
  assert.match(r, /🔁\s*every week\s*⏳\s*2026-04-24/);
  assert.match(r, /\[\s\] new/);
});

test("rebuildTaskLineWithNewTitle — preserves priority glyphs", () => {
  assert.equal(
    rebuildTaskLineWithNewTitle("- [ ] old 🔺", "new"),
    "- [ ] new 🔺",
  );
  assert.equal(
    rebuildTaskLineWithNewTitle("- [ ] old ⏬ #x", "new"),
    "- [ ] new ⏬ #x",
  );
});

test("rebuildTaskLineWithNewTitle — preserves block anchor", () => {
  assert.equal(
    rebuildTaskLineWithNewTitle("- [ ] old ^abc123", "new"),
    "- [ ] new ^abc123",
  );
});

test("rebuildTaskLineWithNewTitle — callout prefix preserved", () => {
  assert.equal(
    rebuildTaskLineWithNewTitle("> - [ ] old #tag", "new"),
    "> - [ ] new #tag",
  );
});

test("rebuildTaskLineWithNewTitle — non-task returns null", () => {
  assert.equal(rebuildTaskLineWithNewTitle("# heading", "x"), null);
  assert.equal(rebuildTaskLineWithNewTitle("- plain bullet", "x"), null);
});

// ---------- nest helpers ----------

test("indentLen — counts whitespace + callout prefix", () => {
  assert.equal(indentLen("- [ ] foo"), 0);
  assert.equal(indentLen("    - [ ] sub"), 4);
  assert.equal(indentLen("> - [ ] callout"), 2);
  assert.equal(indentLen("> > - [ ] nested callout"), 4);
  assert.equal(indentLen(">     - [ ] indented in callout"), 6);
});

test("extractTaskBlock — bare task, no descendants", () => {
  const lines = [
    "- [ ] A",
    "- [ ] B",
  ];
  assert.deepEqual(extractTaskBlock(lines, 0, 0), ["- [ ] A"]);
});

test("extractTaskBlock — task with one subtask", () => {
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
    "- [ ] B",
  ];
  assert.deepEqual(extractTaskBlock(lines, 0, 0), [
    "- [ ] A",
    "    - [ ] A.1",
  ]);
});

test("extractTaskBlock — task with grandchildren and a sibling", () => {
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
    "        - [ ] A.1.1",
    "    - [ ] A.2",
    "- [ ] B",
  ];
  assert.deepEqual(extractTaskBlock(lines, 0, 0), [
    "- [ ] A",
    "    - [ ] A.1",
    "        - [ ] A.1.1",
    "    - [ ] A.2",
  ]);
});

test("extractTaskBlock — trims trailing blank lines", () => {
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
    "",
    "",
    "- [ ] B",
  ];
  assert.deepEqual(extractTaskBlock(lines, 0, 0), [
    "- [ ] A",
    "    - [ ] A.1",
  ]);
});

test("extractTaskBlock — block at end of file (no terminator)", () => {
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
  ];
  assert.deepEqual(extractTaskBlock(lines, 0, 0), [
    "- [ ] A",
    "    - [ ] A.1",
  ]);
});

test("extractTaskBlock — callout-prefixed task", () => {
  const lines = [
    "> - [ ] in callout",
    ">     - [ ] sub in callout",
    "- [ ] outside",
  ];
  assert.deepEqual(extractTaskBlock(lines, 0, 2), [
    "> - [ ] in callout",
    ">     - [ ] sub in callout",
  ]);
});

test("findChildrenEnd — empty parent (no children)", () => {
  const lines = [
    "- [ ] A",
    "- [ ] B",
  ];
  assert.equal(findChildrenEnd(lines, 0, 0), 1);
});

test("findChildrenEnd — parent with one subtask", () => {
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
    "- [ ] B",
  ];
  assert.equal(findChildrenEnd(lines, 0, 0), 2);
});

test("findChildrenEnd — parent at end of file", () => {
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
  ];
  assert.equal(findChildrenEnd(lines, 0, 0), 2);
});

test("findChildrenEnd — skips blank lines inside subtree", () => {
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
    "",
    "    - [ ] A.2",
    "- [ ] B",
  ];
  assert.equal(findChildrenEnd(lines, 0, 0), 4);
});

test("findChildrenEnd — does NOT skip trailing blanks before next sibling", () => {
  // Critical: inserting after a blank line detaches the new item from the
  // parent's list. Must stop right after the last descendant.
  const lines = [
    "- [ ] A",
    "    - [ ] A.1",
    "",
    "",
    "- [ ] B",
  ];
  assert.equal(findChildrenEnd(lines, 0, 0), 2);
});

test("findChildrenEnd — empty parent followed by blank then sibling", () => {
  const lines = [
    "- [ ] A",
    "",
    "- [ ] B",
  ];
  // No descendants → insertion point is right after the parent line.
  assert.equal(findChildrenEnd(lines, 0, 0), 1);
});

test("findChildrenEnd — no descendants, blanks then EOF", () => {
  const lines = [
    "- [ ] A",
    "",
    "",
  ];
  assert.equal(findChildrenEnd(lines, 0, 0), 1);
});

test("reindentBlock — root + subtree, plain → indented", () => {
  const block = [
    "- [ ] A",
    "    - [ ] A.1",
    "        - [ ] A.1.1",
  ];
  assert.deepEqual(reindentBlock(block, 0, "    "), [
    "    - [ ] A",
    "        - [ ] A.1",
    "            - [ ] A.1.1",
  ]);
});

test("reindentBlock — moving deeper subtree to top level", () => {
  const block = [
    "    - [ ] A",
    "        - [ ] A.1",
  ];
  assert.deepEqual(reindentBlock(block, 4, ""), [
    "- [ ] A",
    "    - [ ] A.1",
  ]);
});

test("reindentBlock — strips callout prefix when target is plain", () => {
  const block = [
    "> - [ ] in callout",
    ">     - [ ] sub",
  ];
  assert.deepEqual(reindentBlock(block, 2, "    "), [
    "    - [ ] in callout",
    "        - [ ] sub",
  ]);
});

// ---------- applyUndoOps ----------

test("applyUndoOps — single-line replace (schedule undo)", () => {
  const lines = ["- [ ] task ⏳ 2026-04-25"];
  const ops = [
    {
      path: "a.md",
      line: 0,
      before: ["- [ ] task"],
      after: ["- [ ] task ⏳ 2026-04-25"],
    },
  ];
  const files = { "a.md": lines };
  const out = applyUndoOps(files, ops);
  assert.deepEqual(out["a.md"], ["- [ ] task"]);
});

test("applyUndoOps — reverse deletion (before=block, after=[])", () => {
  const files = { "a.md": ["- [ ] sibling"] };
  const ops = [{ path: "a.md", line: 0, before: ["- [ ] removed"], after: [] }];
  const out = applyUndoOps(files, ops);
  assert.deepEqual(out["a.md"], ["- [ ] removed", "- [ ] sibling"]);
});

test("applyUndoOps — reverse insertion (before=[], after=block)", () => {
  const files = { "a.md": ["- [ ] kept", "- [ ] inserted"] };
  const ops = [{ path: "a.md", line: 1, before: [], after: ["- [ ] inserted"] }];
  const out = applyUndoOps(files, ops);
  assert.deepEqual(out["a.md"], ["- [ ] kept"]);
});

test("applyUndoOps — multi-op applied in reverse order (delete-then-insert move)", () => {
  // Forward op modeled as: delete "A" at line 0, insert "A" at line 2 of the "without" array.
  // Final state ends up as [B, C, A]; undoing should restore [A, B, C].
  const files = { "a.md": ["- [ ] B", "- [ ] C", "- [ ] A"] };
  const ops = [
    { path: "a.md", line: 0, before: ["- [ ] A"], after: [] },
    { path: "a.md", line: 2, before: [], after: ["- [ ] A"] },
  ];
  const out = applyUndoOps(files, ops);
  assert.deepEqual(out["a.md"], ["- [ ] A", "- [ ] B", "- [ ] C"]);
});

test("applyUndoOps — mismatch on 'after' throws (drift guard)", () => {
  const files = { "a.md": ["- [ ] modified by user"] };
  const ops = [
    {
      path: "a.md",
      line: 0,
      before: ["- [ ] original"],
      after: ["- [ ] expected"],
    },
  ];
  assert.throws(() => applyUndoOps(files, ops), /diverged|drift|mismatch/i);
});

// ---------- planSameFileNest ----------

test("planSameFileNest — nest sibling under preceding task", () => {
  const lines = ["- [ ] Parent", "- [ ] Child"];
  const plan = planSameFileNest(lines, /*childLine*/ 1, /*childIndentLen*/ 0, /*parent*/ { line: 0, indentLen: 0 });
  assert.deepEqual(plan.newLines, ["- [ ] Parent", "    - [ ] Child"]);
  // Undo restores.
  const files = { "f.md": plan.newLines };
  const restored = applyUndoOps(files, plan.undoOps.map((o) => ({ ...o, path: "f.md" })));
  assert.deepEqual(restored["f.md"], lines);
});

test("planSameFileNest — nest preceding task under later one", () => {
  const lines = ["- [ ] Child", "- [ ] Parent"];
  const plan = planSameFileNest(lines, 0, 0, { line: 1, indentLen: 0 });
  assert.deepEqual(plan.newLines, ["- [ ] Parent", "    - [ ] Child"]);
  const files = { "f.md": plan.newLines };
  const restored = applyUndoOps(files, plan.undoOps.map((o) => ({ ...o, path: "f.md" })));
  assert.deepEqual(restored["f.md"], lines);
});

test("planSameFileNest — preserves grandchildren when moving", () => {
  const lines = [
    "- [ ] A",
    "- [ ] B",
    "    - [ ] B.1",
    "        - [ ] B.1.1",
  ];
  const plan = planSameFileNest(lines, 1, 0, { line: 0, indentLen: 0 });
  assert.deepEqual(plan.newLines, [
    "- [ ] A",
    "    - [ ] B",
    "        - [ ] B.1",
    "            - [ ] B.1.1",
  ]);
  const files = { "f.md": plan.newLines };
  const restored = applyUndoOps(files, plan.undoOps.map((o) => ({ ...o, path: "f.md" })));
  assert.deepEqual(restored["f.md"], lines);
});

// ---------- planCrossFileNest ----------

test("planCrossFileNest — undo restores both files", () => {
  const childFileLines = [
    "- [ ] moved task",
    "    - [ ] subtask",
    "- [ ] sibling",
  ];
  const parentFileLines = ["- [ ] target parent"];
  const plan = planCrossFileNest(
    childFileLines,
    /*childLine*/ 0,
    /*childIndentLen*/ 0,
    parentFileLines,
    /*parent*/ { line: 0, indentLen: 0 },
  );
  assert.deepEqual(plan.newChildLines, ["- [ ] sibling"]);
  assert.deepEqual(plan.newParentLines, [
    "- [ ] target parent",
    "    - [ ] moved task",
    "        - [ ] subtask",
  ]);
  // Apply undo across both files.
  const files = {
    "child.md": plan.newChildLines,
    "parent.md": plan.newParentLines,
  };
  const withPaths = plan.undoOps.map((o) => ({
    ...o,
    path: o.which === "child" ? "child.md" : "parent.md",
  }));
  const restored = applyUndoOps(files, withPaths);
  assert.deepEqual(restored["child.md"], childFileLines);
  assert.deepEqual(restored["parent.md"], parentFileLines);
});

test("planCrossFileNest — destination insertion appears right after parent's last descendant", () => {
  const childFileLines = ["- [ ] moved", "- [ ] stays"];
  const parentFileLines = [
    "- [ ] parent",
    "    - [ ] existing-child",
    "- [ ] next-sibling",
  ];
  const plan = planCrossFileNest(
    childFileLines,
    0,
    0,
    parentFileLines,
    { line: 0, indentLen: 0 },
  );
  // Inserted block should sit *after* existing-child (last descendant), before next-sibling.
  assert.deepEqual(plan.newParentLines, [
    "- [ ] parent",
    "    - [ ] existing-child",
    "    - [ ] moved",
    "- [ ] next-sibling",
  ]);
  assert.deepEqual(plan.newChildLines, ["- [ ] stays"]);
});

// task #57 (P1 regression): sanitized mixed-indent repro — drag a task from
// one daily note into a parent task in another daily note.
// The destination parent uses TAB-indented children; current
// `planCrossFileNest` hard-codes `parentIndent + "    "` (4 spaces) for
// the new child, which Obsidian's markdown list parser then nests under
// the LAST tab-indented sibling instead of the parent. Fix: derive the
// new-child indent from the parent's existing first-child indent style
// when present, else fall back to "    ".
//
// This test reproduces the mixed-indent shape without carrying over any
// real vault path or task title: one 4-space-indented outlier among otherwise
// tab-indented children, plus a deeper grandchild. The dragged subtree is a
// top-level task with one 4-space-indented subchild.
test("planCrossFileNest — task #57: parent has TAB-indented children → new child must use TAB to stay parent's direct child, not Obsidian's 'last tab-indented sibling''s child", () => {
  // Sanitized source subtree.
  const childFileLines = [
    "- [ ] C_top ➕ 2026-04-26",
    "    - [ ] C_subchild",
  ];

  // Sanitized target subtree for indent shape:
  //   L0: A_parent           — indent="" (root)
  //   L1: A_child_1          — indent="\t"
  //   L2:   A_grandchild     — indent="\t    "
  //   L3: A_child_2          — indent="\t"
  //   L4: A_child_3_done     — indent="\t"
  //   L5: A_child_4_4space   — indent="    "  (the one outlier user really has)
  //   L6: A_child_5          — indent="\t"
  const parentFileLines = [
    "- [ ] A_parent ⏳ 2026-04-26",
    "\t- [ ] A_child_1",
    "\t    - [ ] A_grandchild",
    "\t- [ ] A_child_2",
    "\t- [x] A_child_3_done ✅ 2026-04-24",
    "    - [ ] A_child_4_4space",
    "\t- [ ] A_child_5",
  ];

  const plan = planCrossFileNest(
    childFileLines,
    0, // C_top is at line 0 of child file
    0, // C_top's indent is "" (root) → indentLen 0
    parentFileLines,
    { line: 0, indentLen: 0 }, // A_parent at L0, indent="" → indentLen 0
  );

  // Source side: C_top + its subchild fully removed.
  assert.deepEqual(plan.newChildLines, []);

  // Destination side: the new child must use TAB indent so it parses as
  // A_parent's direct child. Currently the planner emits `"    "` (4
  // spaces), and after L6 (`\t- [ ] A_child_5`), Obsidian's CommonMark
  // list parser walks back up to the deepest preceding item whose
  // content column matches and treats `    - [ ] C_top` as a CHILD of
  // `\t- [ ] A_child_5`. That's the user-reported regression.
  //
  // After fix: new child uses `\t` (matching A_child_1/_2/_3/_5) and
  // C_subchild keeps its relative depth (so it ends up `\t    - [ ]`).
  assert.deepEqual(plan.newParentLines, [
    "- [ ] A_parent ⏳ 2026-04-26",
    "\t- [ ] A_child_1",
    "\t    - [ ] A_grandchild",
    "\t- [ ] A_child_2",
    "\t- [x] A_child_3_done ✅ 2026-04-24",
    "    - [ ] A_child_4_4space",
    "\t- [ ] A_child_5",
    "\t- [ ] C_top ➕ 2026-04-26",
    "\t    - [ ] C_subchild",
  ]);
});

// Coverage backstop: when the parent has NO existing children, the
// fallback to "    " (4 spaces) still applies. This keeps the original
// task-#37 scenario green.
test("planCrossFileNest — task #57 corollary: parent with NO children falls back to 4-space new-child indent", () => {
  const childFileLines = ["- [ ] moved"];
  const parentFileLines = ["- [ ] empty-parent"];
  const plan = planCrossFileNest(
    childFileLines,
    0,
    0,
    parentFileLines,
    { line: 0, indentLen: 0 },
  );
  assert.deepEqual(plan.newParentLines, [
    "- [ ] empty-parent",
    "    - [ ] moved",
  ]);
  assert.deepEqual(plan.newChildLines, []);
});

// task #57 v2: reviewer's mandatory review (msg `1e4304ab`) caught that the
// production cross-file `nestUnder()` runtime path duplicates the
// planner's indent decision INLINE (writer.ts:865 `parent.indent +
// "    "`) instead of delegating to `planCrossFileNest`. So the
// planner-only fix from `087fcbc` greens the unit but the actual
// vault-touching nestUnder cross-file write still emits 4-space.
//
// This test imports the runtime `nestUnder` and drives it through a
// minimal in-memory vault stub mirroring the sanitized mixed-indent setup. Asserts
// the parent file ends with `\t- [ ] C_top` (matching its existing
// TAB-indented children), not `    - [ ] C_top`.
const { addTask, nestUnder, TFile } = await import("../test/.compiled/writer.bundle.js");

test("nestUnder cross-file — task #57 runtime: production path also matches existing TAB-indented children", async () => {
  // Sanitized shape: parent file has TAB children with one 4-space
  // outlier; source file has a top-level task with one 4-space subchild.
  const parentInitial =
    "- [ ] A_parent ⏳ 2026-04-26\n" +
    "\t- [ ] A_child_1\n" +
    "\t- [ ] A_child_2\n" +
    "    - [ ] A_child_3_4space\n" +
    "\t- [ ] A_child_4\n";
  const childInitial =
    "- [ ] C_top ➕ 2026-04-26\n" +
    "    - [ ] C_subchild\n";

  // Vault stub: each file is a real TFile instance (so instanceof checks
  // inside nestUnder pass). Track each file's content; expose
  // getAbstractFileByPath, cachedRead, and `vault.process(file, fn)`.
  const fileObjs = new Map();
  const fileData = new Map();
  for (const [path, data] of [
    ["parent.md", parentInitial],
    ["child.md", childInitial],
  ]) {
    const f = new TFile();
    f.path = path;
    f.extension = "md";
    f.stat = { mtime: 1000 };
    fileObjs.set(path, f);
    fileData.set(path, data);
  }

  const app = {
    vault: {
      getAbstractFileByPath: (p) => fileObjs.get(p) ?? null,
      cachedRead: async (file) => fileData.get(file.path),
      process: async (file, fn) => {
        const data = fileData.get(file.path);
        const next = fn(data);
        fileData.set(file.path, next);
      },
    },
  };

  // Minimal ParsedTask shapes — only the fields nestUnder actually
  // reads (id, path, line, indent, rawLine, parentLine).
  const child = {
    id: "child.md:L0",
    path: "child.md",
    line: 0,
    indent: "",
    rawLine: "- [ ] C_top ➕ 2026-04-26",
    parentLine: null,
  };
  const parent = {
    id: "parent.md:L0",
    path: "parent.md",
    line: 0,
    indent: "",
    rawLine: "- [ ] A_parent ⏳ 2026-04-26",
    parentLine: null,
  };

  await nestUnder(app, child, parent);

  const parentAfter = fileData.get("parent.md");
  // The new child must use TAB to match A_child_1/_2/_4 (the dominant
  // indent style under A_parent). NOT 4-space — that would cause
  // CommonMark to nest under the last TAB-indented sibling.
  assert.ok(
    parentAfter.includes("\t- [ ] C_top ➕ 2026-04-26"),
    `parent file did not get TAB-indented C_top.\nGot:\n${parentAfter}`,
  );
  // C_subchild moves with C_top: was 4-space relative to C_top (root),
  // so under TAB-prefixed C_top it becomes "\t    - [ ] C_subchild".
  assert.ok(
    parentAfter.includes("\t    - [ ] C_subchild"),
    `parent file did not get C_subchild at the correct relative depth.\nGot:\n${parentAfter}`,
  );
  // The original C_top in child.md must be removed (cross-file move).
  const childAfter = fileData.get("child.md");
  assert.ok(
    !childAfter.includes("- [ ] C_top"),
    `child file still has C_top after move.\nGot:\n${childAfter}`,
  );
});

// ---------- VAL-CORE-010: writer vault.process integration ----------
// These tests verify writer operations flow through vault.process, return
// before/after, are idempotent (no-op when already satisfied), and preserve
// non-target bytes.

const {
  setScheduled,
  setDeadline,
  markDone,
  markDropped,
  markUndone,
  renameTask,
  addTag,
  removeTag,
  setActual,
  setEstimate,
} = await import("../test/.compiled/writer.bundle.js");

test("setScheduled — inject ⏳ via vault.process", async () => {
  const initial = "daily.md\n- [ ] task\nother.md\n";
  const file = new TFile();
  file.path = "daily.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "daily.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "daily.md", line: 1, rawLine: "- [ ] task" };
  const r = await setScheduled(app, task, "2026-04-25");
  assert.equal(r.before, "- [ ] task");
  assert.equal(r.after, "- [ ] task ⏳ 2026-04-25");
  assert.equal(r.unchanged, false);
  assert.ok(data.includes("- [ ] task ⏳ 2026-04-25"));
});

test("setScheduled — no-op when already same date (idempotent)", async () => {
  const initial = "- [ ] task ⏳ 2026-04-25";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: "- [ ] task ⏳ 2026-04-25" };
  const r = await setScheduled(app, task, "2026-04-25");
  assert.equal(r.unchanged, true);
  assert.equal(data, initial);
});

test("setScheduled — clear ⏳ (date=null)", async () => {
  const initial = "- [ ] task ⏳ 2026-04-25";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: "- [ ] task ⏳ 2026-04-25" };
  const r = await setScheduled(app, task, null);
  assert.equal(r.before, "- [ ] task ⏳ 2026-04-25");
  assert.equal(r.after, "- [ ] task");
  assert.equal(r.unchanged, false);
  assert.equal(data, "- [ ] task");
});

test("markDone — todo → done via vault.process", async () => {
  const initial = "- [ ] important task";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: "- [ ] important task" };
  const r = await markDone(app, task, "2026-04-30");
  assert.equal(r.unchanged, false);
  assert.match(r.after, /- \[x\] .* ✅ 2026-04-30/);
  assert.match(data, /- \[x\] .* ✅ 2026-04-30/);
});

test("markDone — already done → unchanged (idempotent)", async () => {
  const initial = "- [x] task ✅ 2026-04-30";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: "- [x] task ✅ 2026-04-30" };
  const r = await markDone(app, task, "2026-04-30");
  assert.equal(r.unchanged, true);
  assert.equal(data, initial);
});

test("markDropped — todo → dropped via vault.process", async () => {
  const initial = "- [ ] stale task #dropped";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: "- [ ] stale task #dropped" };
  const r = await markDropped(app, task, "2026-05-01");
  assert.equal(r.unchanged, false);
  assert.match(r.after, /- \[-\] .* ❌ 2026-05-01/);
  // Legacy #dropped tag stripped (one-way migration)
  assert.ok(!r.after.includes("#dropped"));
});

test("markDropped — already dropped → unchanged (idempotent)", async () => {
  const initial = "- [-] task ❌ 2026-05-01";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: "- [-] task ❌ 2026-05-01" };
  const r = await markDropped(app, task, "2026-05-01");
  assert.equal(r.unchanged, true);
  assert.equal(data, initial);
});

test("markUndone — done → todo via vault.process", async () => {
  const initial = "- [x] task ✅ 2026-04-30";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: "- [x] task ✅ 2026-04-30" };
  const r = await markUndone(app, task);
  assert.equal(r.unchanged, false);
  assert.equal(r.after, "- [ ] task");
  assert.equal(data, "- [ ] task");
});

test("markUndone — already todo → unchanged (idempotent)", async () => {
  const initial = "- [ ] task";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: "- [ ] task" };
  const r = await markUndone(app, task);
  assert.equal(r.unchanged, true);
  assert.equal(data, initial);
});

test("renameTask — renames title, preserves metadata", async () => {
  const initial = "- [ ] old title #tag ⏳ 2026-04-25 [estimate:: 30m]";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: initial };
  const r = await renameTask(app, task, "new title");
  assert.equal(r.unchanged, false);
  assert.match(r.after, /- \[ \] new title #tag ⏳ 2026-04-25 \[estimate:: 30m\]/);
});

test("renameTask — no-op when same title (idempotent)", async () => {
  const initial = "- [ ] unchanged #tag";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: initial };
  const r = await renameTask(app, task, "unchanged");
  assert.equal(r.unchanged, true);
  assert.equal(data, initial);
});

test("addTag — adds new tag via vault.process", async () => {
  const initial = "- [ ] task #existing";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: initial };
  const r = await addTag(app, task, "newtag");
  assert.equal(r.unchanged, false);
  assert.match(r.after, /#existing/);
  assert.match(r.after, /#newtag/);
});

test("addTag — no-op when tag already present (idempotent)", async () => {
  const initial = "- [ ] task #existing";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: initial };
  const r = await addTag(app, task, "existing");
  assert.equal(r.unchanged, true);
  assert.equal(data, initial);
});

test("removeTag — removes tag via vault.process", async () => {
  const initial = "- [ ] task #stale #keep";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: initial };
  const r = await removeTag(app, task, "#stale");
  assert.equal(r.unchanged, false);
  assert.ok(!r.after.includes("#stale"));
  assert.match(r.after, /#keep/);
});

test("removeTag — no-op when tag not present (idempotent)", async () => {
  const initial = "- [ ] task #keep";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: initial };
  const r = await removeTag(app, task, "#absent");
  assert.equal(r.unchanged, true);
  assert.equal(data, initial);
});

test("setDeadline — inject 📅 via vault.process", async () => {
  const initial = "- [ ] task";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: "- [ ] task" };
  const r = await setDeadline(app, task, "2026-05-15");
  assert.equal(r.before, "- [ ] task");
  assert.equal(r.after, "- [ ] task 📅 2026-05-15");
  assert.equal(r.unchanged, false);
});

test("setDeadline — no-op when already same date (idempotent)", async () => {
  const initial = "- [ ] task 📅 2026-05-15";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: initial };
  const r = await setDeadline(app, task, "2026-05-15");
  assert.equal(r.unchanged, true);
  assert.equal(data, initial);
});

test("setActual — inject [actual::] via vault.process", async () => {
  const initial = "- [ ] task";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: "- [ ] task", actual: 0 };
  const r = await setActual(app, task, 90);
  assert.equal(r.unchanged, false);
  assert.match(r.after, /\[actual:: 1h30m\]/);
});

test("setEstimate — inject [estimate::] via vault.process", async () => {
  const initial = "- [ ] task";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: "- [ ] task" };
  const r = await setEstimate(app, task, 30);
  assert.equal(r.unchanged, false);
  assert.match(r.after, /\[estimate:: 30m\]/);
});

test("setEstimate — clear (minutes=null) via vault.process", async () => {
  const initial = "- [ ] task [estimate:: 30m]";
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "f.md" ? file : null),
      process: async (_f, fn) => { data = fn(data); },
    },
  };
  const task = { path: "f.md", line: 0, rawLine: initial };
  const r = await setEstimate(app, task, null);
  assert.equal(r.unchanged, false);
  assert.ok(!r.after.includes("estimate::"));
});

// ---------- VAL-CORE-011: nest clears moved root's scheduled token ----------

test("planSameFileNest — clears moved root's ⏳, preserves descendant ⏳ and other metadata", () => {
  const lines = [
    "- [ ] Parent task",
    "- [ ] Child task ⏳ 2026-04-25 #tag [estimate:: 30m]",
    "    - [ ] Grandchild ⏳ 2026-04-26 📅 2026-05-01",
    "        - [ ] Great-grandchild",
  ];
  const plan = planSameFileNest(lines, /*childLine*/ 1, /*childIndentLen*/ 0, /*parent*/ { line: 0, indentLen: 0 });

  // The moved root (Child task) should appear WITHOUT its own ⏳
  const childLine = plan.newLines.find(l => /Child task/.test(l) && !/Grandchild/.test(l));
  assert.ok(childLine, "Child task line not found in result");
  assert.ok(!childLine.includes("⏳"), `Child task should NOT have ⏳ but got: ${childLine}`);
  // But it should still have its tag and estimate
  assert.ok(childLine.includes("#tag"), `Child task should preserve #tag: ${childLine}`);
  assert.ok(childLine.includes("[estimate:: 30m]"), `Child task should preserve estimate: ${childLine}`);

  // Grandchild should still have its own ⏳ and 📅
  const grandchildLine = plan.newLines.find(l => /Grandchild/.test(l));
  assert.ok(grandchildLine, "Grandchild line not found in result");
  assert.ok(grandchildLine.includes("⏳ 2026-04-26"), `Grandchild should keep ⏳: ${grandchildLine}`);
  assert.ok(grandchildLine.includes("📅 2026-05-01"), `Grandchild should keep 📅: ${grandchildLine}`);

  // Undo should restore original state (with ⏳ on root)
  const files = { "f.md": plan.newLines };
  const restored = applyUndoOps(files, plan.undoOps.map((o) => ({ ...o, path: "f.md" })));
  assert.deepEqual(restored["f.md"], lines, "Undo should restore original ⏳ on root");
});

test("planSameFileNest — no-op on root without ⏳ (no false clearing)", () => {
  const lines = [
    "- [ ] Parent",
    "- [ ] Child #tag",
    "    - [ ] Grandchild ⏳ 2026-04-26",
  ];
  const plan = planSameFileNest(lines, 1, 0, { line: 0, indentLen: 0 });

  // Child should be preserved as-is (no ⏳ to clear)
  const childLine = plan.newLines.find(l => /Child/.test(l) && !/Grandchild/.test(l));
  assert.ok(childLine.includes("#tag"), `Child should keep #tag: ${childLine}`);
  assert.ok(!childLine.includes("⏳"), `Child should not gain ⏳: ${childLine}`);

  // Grandchild should keep its ⏳
  const grandchildLine = plan.newLines.find(l => /Grandchild/.test(l));
  assert.ok(grandchildLine.includes("⏳ 2026-04-26"), `Grandchild should keep ⏳: ${grandchildLine}`);
});

test("planCrossFileNest — clears moved root's ⏳, preserves descendant ⏳ and other metadata", () => {
  const childLines = [
    "- [ ] Child ⏳ 2026-04-25 #urgent [actual:: 1h]",
    "    - [ ] Sub ⏳ 2026-04-26 🔺",
    "        - [ ] SubSub 📅 2026-05-01",
  ];
  const parentLines = [
    "- [ ] Parent",
    "    - [ ] Existing child",
  ];
  const plan = planCrossFileNest(
    childLines, /*childLine*/ 0, /*childIndentLen*/ 0,
    parentLines, /*parent*/ { line: 0, indentLen: 0 },
  );

  // Parent file should have the moved "Child" WITHOUT ⏳
  const movedChildLine = plan.newParentLines.find(l => /Child/.test(l) && !/Existing/.test(l) && !/Sub/.test(l));
  assert.ok(movedChildLine, "Moved child line not found in parent result");
  assert.ok(!movedChildLine.includes("⏳"), `Moved child should NOT have ⏳: ${movedChildLine}`);
  assert.ok(movedChildLine.includes("#urgent"), `Moved child should keep #urgent: ${movedChildLine}`);
  assert.ok(movedChildLine.includes("[actual:: 1h]"), `Moved child should keep actual: ${movedChildLine}`);

  // "Sub" (descendant) should keep its ⏳ and 🔺
  const subLine = plan.newParentLines.find(l => /Sub\b/.test(l) && !/SubSub/.test(l));
  assert.ok(subLine, "Sub line not found in parent result");
  assert.ok(subLine.includes("⏳ 2026-04-26"), `Sub should keep ⏳: ${subLine}`);
  assert.ok(subLine.includes("🔺"), `Sub should keep 🔺: ${subLine}`);

  // "SubSub" should keep its 📅
  const subSubLine = plan.newParentLines.find(l => /SubSub/.test(l));
  assert.ok(subSubLine, "SubSub line not found");
  assert.ok(subSubLine.includes("📅 2026-05-01"), `SubSub should keep 📅: ${subSubLine}`);

  // Child file should lose the moved task
  assert.deepEqual(plan.newChildLines, []);

  // Undo should restore original state on both files
  const files = { "child.md": plan.newChildLines, "parent.md": plan.newParentLines };
  const withPaths = plan.undoOps.map((o) => ({
    ...o,
    path: o.which === "child" ? "child.md" : "parent.md",
  }));
  const restored = applyUndoOps(files, withPaths);
  assert.deepEqual(restored["child.md"], childLines, "Undo should restore child file with ⏳");
});

test("nestUnder — cross-file runtime clears moved root's ⏳, preserves descendant ⏳", async () => {
  // Parent file with TAB-indented children
  const parentInitial =
    "- [ ] A_parent ⏳ 2026-04-26\n" +
    "\t- [ ] A_child_1\n";

  // Child file: root has ⏳, sub has its own ⏳ and tag
  const childInitial =
    "- [ ] C_top ⏳ 2026-04-25 #move-me [estimate:: 15m]\n" +
    "    - [ ] C_sub ⏳ 2026-04-27 #keep-me\n";

  const fileObjs = new Map();
  const fileData = new Map();
  for (const [path, data] of [
    ["parent.md", parentInitial],
    ["child.md", childInitial],
  ]) {
    const f = new TFile();
    f.path = path;
    f.extension = "md";
    f.stat = { mtime: 1000 };
    fileObjs.set(path, f);
    fileData.set(path, data);
  }

  const app = {
    vault: {
      getAbstractFileByPath: (p) => fileObjs.get(p) ?? null,
      cachedRead: async (file) => fileData.get(file.path),
      process: async (file, fn) => {
        const data = fileData.get(file.path);
        const next = fn(data);
        fileData.set(file.path, next);
      },
    },
  };

  const child = {
    id: "child.md:L0",
    path: "child.md",
    line: 0,
    indent: "",
    rawLine: "- [ ] C_top ⏳ 2026-04-25 #move-me [estimate:: 15m]",
    parentLine: null,
  };
  const parent = {
    id: "parent.md:L0",
    path: "parent.md",
    line: 0,
    indent: "",
    rawLine: "- [ ] A_parent ⏳ 2026-04-26",
    parentLine: null,
  };

  const result = await nestUnder(app, child, parent);

  const parentAfter = fileData.get("parent.md");

  // C_top should be present in parent file WITHOUT its ⏳
  const cTopLine = parentAfter.split("\n").find(l => /C_top/.test(l));
  assert.ok(cTopLine, `C_top not found in parent.\nGot:\n${parentAfter}`);
  assert.ok(!cTopLine.includes("⏳"), `C_top should NOT have ⏳, got: ${cTopLine}`);
  assert.ok(cTopLine.includes("#move-me"), `C_top should keep #move-me: ${cTopLine}`);
  assert.ok(cTopLine.includes("[estimate:: 15m]"), `C_top should keep estimate: ${cTopLine}`);

  // C_sub should keep its ⏳ and tag
  const cSubLine = parentAfter.split("\n").find(l => /C_sub/.test(l));
  assert.ok(cSubLine, `C_sub not found in parent.\nGot:\n${parentAfter}`);
  assert.ok(cSubLine.includes("⏳ 2026-04-27"), `C_sub should keep ⏳: ${cSubLine}`);
  assert.ok(cSubLine.includes("#keep-me"), `C_sub should keep #keep-me: ${cSubLine}`);

  // Child file should not have C_top anymore
  const childAfter = fileData.get("child.md");
  assert.ok(!childAfter.includes("C_top"), `child file still has C_top:\n${childAfter}`);

  // before/after metadata
  assert.ok(result.before.includes("⏳ 2026-04-25"), "result.before should show original with ⏳");
  assert.ok(!result.after.includes("⏳ 2026-04-25"), "result.after should show cleared version");

  // Undo should restore original state
  const undoFiles = { "child.md": childAfter.split("\n"), "parent.md": parentAfter.split("\n") };
  const restored = applyUndoOps(undoFiles, result.undoOps);
  assert.ok(
    restored["child.md"].join("\n").includes("C_top ⏳ 2026-04-25"),
    `Undo should restore ⏳ on C_top in child file.\nGot:\n${restored["child.md"].join("\n")}`,
  );
  assert.ok(
    !restored["parent.md"].join("\n").includes("C_top"),
    `Undo should remove C_top from parent file.\nGot:\n${restored["parent.md"].join("\n")}`,
  );
});

// ---------- VAL-CORE-011: invalid nest rejection ----------

test("nestUnder — self-nest throws invalid_nest", async () => {
  const file = new TFile();
  file.path = "f.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  const task = {
    id: "f.md:L0",
    path: "f.md",
    line: 0,
    indent: "",
    rawLine: "- [ ] self",
    parentLine: null,
  };
  const app = {
    vault: {
      getAbstractFileByPath: () => file,
      process: async () => {},
    },
  };
  await assert.rejects(
    () => nestUnder(app, task, task),
    (err) => err.code === "invalid_nest" && /itself/i.test(err.message),
  );
});

test("planSameFileNest — rejects descendant-as-parent nest (cycle guard)", () => {
  const lines = [
    "- [ ] Parent",
    "    - [ ] Child",
    "        - [ ] Grandchild",
  ];
  assert.throws(
    () => planSameFileNest(lines, /*childLine*/ 0, /*childIndent*/ 0, /*parent*/ { line: 2, indentLen: 8 }),
    (err) => err.code === "invalid_nest" && /descendant/i.test(err.message),
  );
});

test("addTask(parent) — task #70 runtime: new child matches existing TAB-indented children", async () => {
  const initial =
    "- [ ] A_parent ⏳ 2026-04-26\n" +
    "\t- [ ] A_child_1\n" +
    "\t- [ ] A_child_2\n" +
    "    - [ ] A_child_3_4space\n";

  const file = new TFile();
  file.path = "parent.md";
  file.extension = "md";
  file.stat = { mtime: 1000 };
  let data = initial;
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === "parent.md" ? file : null),
      process: async (_file, fn) => {
        data = fn(data);
      },
    },
  };
  const parent = {
    id: "parent.md:L0",
    path: "parent.md",
    line: 0,
    indent: "",
    rawLine: "- [ ] A_parent ⏳ 2026-04-26",
    parentLine: null,
    created: null,
  };

  const result = await addTask(app, {
    text: "New child",
    parent,
    stampCreated: false,
  });

  assert.equal(result.created, "\t- [ ] New child");
  assert.ok(
    data.includes("\t- [ ] New child"),
    `addTask(parent) did not use TAB child indent.\nGot:\n${data}`,
  );
  assert.ok(
    !data.includes("    - [ ] New child"),
    `addTask(parent) still emitted 4-space child indent.\nGot:\n${data}`,
  );
});
