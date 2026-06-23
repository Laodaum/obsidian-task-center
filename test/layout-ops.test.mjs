// US-109p11: pure layout-tree editing operators (ARCHITECTURE.md §1.3.1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/layout-ops.ts",
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

compilePure();
const {
  nodeAt,
  pathToAreaIndex,
  mapAreaAt,
  setAreaType,
  insertNode,
  appendArea,
  removeNode,
  wrapInStack,
  setStackDir,
  setWeight,
  reorderChild,
} = await import("../test/.compiled/layout-ops.js");

const quad = () => ({
  dir: "col",
  children: [
    { dir: "row", children: [{ type: "grid", title: "A" }, { type: "grid", title: "B" }] },
    { dir: "row", children: [{ type: "grid", title: "C" }, { type: "grid", title: "D" }] },
  ],
});

test("pathToAreaIndex matches DFS order", () => {
  const tree = quad();
  assert.deepEqual(pathToAreaIndex(tree, 0), [0, 0]);
  assert.deepEqual(pathToAreaIndex(tree, 3), [1, 1]);
  assert.equal(pathToAreaIndex(tree, 4), null);
});

test("nodeAt resolves stacks and leaves", () => {
  const tree = quad();
  assert.equal(nodeAt(tree, [0, 1]).title, "B");
  assert.equal(nodeAt(tree, []).dir, "col");
  assert.equal(nodeAt(tree, [9]), null);
});

test("setAreaType only changes the targeted leaf, keeps siblings & structure", () => {
  const before = quad();
  const after = setAreaType(before, 2, "list"); // C → list
  assert.equal(nodeAt(after, [1, 0]).type, "list");
  assert.equal(nodeAt(after, [1, 0]).title, "C"); // title preserved
  assert.equal(nodeAt(after, [0, 0]).type, "grid"); // sibling untouched
  assert.equal(after.children.length, 2); // structure untouched
  // input not mutated
  assert.equal(nodeAt(before, [1, 0]).type, "grid");
});

test("setAreaType carries list/grid fields between list and grid", () => {
  const tree = { type: "list", when: { status: "todo" }, sections: [{ id: "s", title: "S", when: {} }] };
  const after = setAreaType(tree, 0, "grid");
  assert.equal(after.type, "grid");
  assert.deepEqual(after.when, { status: "todo" });
  assert.equal(after.sections.length, 1);
});

test("mapAreaAt patches a single area immutably", () => {
  const before = { type: "list", title: "x" };
  const after = mapAreaAt(before, 0, (a) => ({ ...a, title: "y" }));
  assert.equal(after.title, "y");
  assert.equal(before.title, "x");
});

test("appendArea wraps a bare-area root into a col", () => {
  const after = appendArea({ type: "list", title: "only" });
  assert.equal(after.dir, "col");
  assert.equal(after.children.length, 2);
  assert.equal(after.children[0].title, "only");
  assert.equal(after.children[1].type, "list");
});

test("appendArea pushes into an existing stack root", () => {
  const after = appendArea({ dir: "col", children: [{ type: "list" }] });
  assert.equal(after.children.length, 2);
});

test("insertNode wraps bare-area root and inserts at index", () => {
  const after = insertNode({ type: "list", title: "root" }, [], 0, { type: "week" });
  assert.equal(after.dir, "col");
  assert.equal(after.children[0].type, "week");
  assert.equal(after.children[1].title, "root");
});

test("removeNode drops a leaf and collapses an emptied stack", () => {
  const tree = { dir: "col", children: [{ dir: "row", children: [{ type: "grid" }] }, { type: "list" }] };
  const after = removeNode(tree, [0, 0]); // empties the row → row collapses out
  // The emptied row stack collapses to default within editAt's collapse pass.
  assert.equal(nodeAt(after, [0]).type ?? nodeAt(after, [0]).dir, "list");
});

test("removeNode on root falls back to a default list", () => {
  const after = removeNode({ type: "week" }, []);
  assert.equal(after.type, "list");
});

test("wrapInStack wraps a node in a fresh container", () => {
  const after = wrapInStack({ type: "list", title: "x" }, [], "row");
  assert.equal(after.dir, "row");
  assert.equal(after.children[0].title, "x");
});

test("setStackDir flips a container, no-op on leaves", () => {
  assert.equal(setStackDir({ dir: "col", children: [{ type: "list" }] }, [], "row").dir, "row");
  assert.equal(setStackDir({ type: "list" }, [], "row").type, "list");
});

test("setWeight sets and clears weight", () => {
  const set = setWeight({ dir: "row", children: [{ type: "list" }] }, [0], 2);
  assert.equal(nodeAt(set, [0]).weight, 2);
  const cleared = setWeight(set, [0], undefined);
  assert.equal(nodeAt(cleared, [0]).weight, undefined);
});

test("reorderChild moves a child within its container", () => {
  const tree = { dir: "row", children: [{ type: "list", title: "a" }, { type: "list", title: "b" }, { type: "list", title: "c" }] };
  const after = reorderChild(tree, [], 0, 2);
  assert.deepEqual(after.children.map((c) => c.title), ["b", "c", "a"]);
});
