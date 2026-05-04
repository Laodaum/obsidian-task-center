// Unit + integration tests for TaskCache.
//
// Architecture invariants that block the large-vault startup regression:
//   - hasTaskListItem null-cache rule: parse when metadata is unindexed,
//     skip only when metadata explicitly says "no task list items".
//   - ensureAll() never opens task-free files (large-vault regression root cause).
//   - Write-path resolveRef goes single-file (no implicit ensureAll).
//   - cache.changed fires AFTER reparse settles, so flatten() in the callback
//     is post-state.
//
// Run with: `node --test test/cache.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compile() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/cache.ts",
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--outfile=test/.compiled/cache.bundle.js",
      "--alias:obsidian=./test/obsidian-stub.mjs",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("esbuild failed:\n" + result.stderr);
  }
}

compile();
// IMPORTANT: pull both `TaskCache` and `TFile` from the same bundle. If the
// test imports `TFile` from `obsidian-stub.mjs` directly, it gets a sibling
// class with the same shape; `instanceof TFile` inside the bundled cache
// then returns false for every event and the listeners no-op silently.
const { TaskCache, TFile } = await import("../test/.compiled/cache.bundle.js");

// ----------------------------------------------------------------------------
// Fake App — minimum surface needed by TaskCache and parseFileTasks.
//
// Each spec file carries:
//   - path, content
//   - hasTask: did Obsidian's metadataCache index it AND see a task list item?
//   - metaIndexed: has metadata been indexed at all? null/undefined = not yet
//
// `hasTask=false, metaIndexed=true` → confirmed task-free. cache must skip.
// `metaIndexed=false` → not yet indexed. cache must parse (#1 large-vault regression).
// ----------------------------------------------------------------------------

function mkFile(spec) {
  const f = new TFile();
  f.path = spec.path;
  f.extension = spec.path.endsWith(".md") ? "md" : "txt";
  f.stat = { mtime: spec.mtime ?? 1000 };
  f._content = spec.content ?? "";
  f._hasTask = spec.hasTask ?? false;
  f._metaIndexed = spec.metaIndexed ?? true;
  f._parseFails = spec.parseFails ?? false;
  return f;
}

function makeApp(specs) {
  const files = specs.map(mkFile);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const metaListeners = []; // {event,cb}
  const vaultListeners = []; // {event,cb}

  return {
    _files: files,
    _byPath: byPath,

    vault: {
      getMarkdownFiles: () => files.filter((f) => f.extension === "md"),
      getAbstractFileByPath: (p) => byPath.get(p) ?? null,
      cachedRead: async (f) => {
        if (f._parseFails) throw new Error("simulated read failure");
        return f._content;
      },
      on: (event, cb) => {
        const ref = { event, cb };
        vaultListeners.push(ref);
        return ref;
      },
    },

    metadataCache: {
      getFileCache: (f) => {
        if (!f._metaIndexed) return null;
        if (f._hasTask) {
          return {
            listItems: [
              { task: " ", position: { start: { line: 0 } }, parent: -1 },
            ],
          };
        }
        return { listItems: [] };
      },
      on: (event, cb) => {
        const ref = { event, cb };
        metaListeners.push(ref);
        return ref;
      },
    },

    /** Fire a metadataCache.changed for the named file (simulates Obsidian indexing). */
    _fireMetaChanged(path) {
      const f = byPath.get(path);
      if (!f) return;
      for (const l of metaListeners) if (l.event === "changed") l.cb(f);
    },

    /** Fire a vault event (delete / rename / etc). */
    _fireVault(event, ...args) {
      for (const l of vaultListeners) if (l.event === event) l.cb(...args);
    },

    _setContent(path, content) {
      const f = byPath.get(path);
      if (f) f._content = content;
    },

    _setHasTask(path, hasTask) {
      const f = byPath.get(path);
      if (f) f._hasTask = hasTask;
    },
  };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

test("ensureAll: skips metadata-confirmed task-free files (#1 large-vault regression fix)", async () => {
  // 6500 daily notes Obsidian has indexed and confirmed task-free, plus 50
  // task-bearing files. The pre-Phase-1 path read all 6550; the post-fix
  // path must only read 50.
  const specs = [];
  for (let i = 0; i < 6500; i++) {
    specs.push({ path: `Daily/d${i}.md`, hasTask: false, metaIndexed: true });
  }
  for (let i = 0; i < 50; i++) {
    specs.push({
      path: `Tasks/t${i}.md`,
      hasTask: true,
      metaIndexed: true,
      content: `- [ ] Task ${i}\n`,
    });
  }
  const app = makeApp(specs);
  const cache = new TaskCache(app);
  cache.bind();

  const t0 = Date.now();
  const tasks = await cache.ensureAll();
  const dt = Date.now() - t0;

  assert.equal(
    cache.__stats.parseCount,
    50,
    `parseCount must equal 50 (only task-bearing files), got ${cache.__stats.parseCount}`,
  );
  assert.equal(
    cache.__stats.skipCount,
    6500,
    `skipCount must equal 6500, got ${cache.__stats.skipCount}`,
  );
  assert.equal(tasks.length, 50);
  // Performance budget: 6550 mock files (50 actual reads, no real I/O) must
  // settle in well under a second on any dev machine. The point is that the
  // skip path is O(1) per file.
  assert.ok(dt < 1000, `ensureAll over 6550 mock files must finish < 1000ms, got ${dt}ms`);
});

test("ensureAll: parses files where metadata is not yet indexed (no false skip)", async () => {
  // metadata not yet indexed must NOT be treated as task-free — parser must
  // still see the bytes (#1 large-vault regression corollary).
  const app = makeApp([
    { path: "Tasks/t1.md", hasTask: true, metaIndexed: false, content: "- [ ] X\n" },
    { path: "Tasks/t2.md", hasTask: false, metaIndexed: false, content: "no tasks\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  // Both files must be parsed (we can't prove t2 has no tasks until we read).
  assert.equal(cache.__stats.parseCount, 2);
  assert.equal(cache.__stats.skipCount, 0);
});

test("invalidateFile: re-parses ONE file, emits cache.changed with that path", async () => {
  const app = makeApp([
    { path: "Tasks/t1.md", hasTask: true, content: "- [ ] Old title\n" },
    { path: "Tasks/t2.md", hasTask: true, content: "- [ ] Untouched\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  const beforeParseCount = cache.__stats.parseCount;
  const changedEvents = [];
  cache.on("changed", (paths) => changedEvents.push(new Set(paths)));

  // Edit t1 then fire metadataCache.changed (what Obsidian does after a write).
  app._setContent("Tasks/t1.md", "- [ ] New title\n");
  app._fireMetaChanged("Tasks/t1.md");
  await cache.forFlush();

  assert.equal(
    cache.__stats.parseCount - beforeParseCount,
    1,
    "exactly ONE file should re-parse on a single metadataCache.changed event",
  );
  assert.equal(changedEvents.length, 1);
  assert.deepEqual(Array.from(changedEvents[0]), ["Tasks/t1.md"]);

  // Subscriber reading flatten() in the changed callback must see the new title.
  const tasksAfter = cache.flatten();
  const t1 = tasksAfter.find((t) => t.path === "Tasks/t1.md");
  assert.ok(t1, "t1 should still be in cache after invalidation");
  assert.match(t1.rawLine, /New title/);
});

test("resolveRef path:Lnnn — single-file resolve, never triggers ensureAll", async () => {
  const app = makeApp([
    { path: "Tasks/a.md", hasTask: true, content: "- [ ] Alpha\n" },
    { path: "Tasks/b.md", hasTask: true, content: "- [ ] Bravo\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  // Start from cold — never call ensureAll directly.

  const t = await cache.resolveRef("Tasks/a.md:L1");
  assert.ok(t, "should resolve a path:L1 ref directly");
  assert.equal(t.path, "Tasks/a.md");
  assert.equal(t.line, 0);

  assert.equal(
    cache.__stats.ensureCount,
    0,
    "path:L resolve must not trigger a full ensureAll",
  );
  // Only the requested file was parsed.
  assert.equal(cache.__stats.parseCount, 1);
});

test("resolveRef hash — falls back to ensureAll only on first miss", async () => {
  const app = makeApp([
    { path: "Tasks/a.md", hasTask: true, content: "- [ ] Alpha\n" },
    { path: "Tasks/b.md", hasTask: true, content: "- [ ] Bravo\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();
  const tasks = cache.flatten();
  const targetHash = tasks[0].hash;

  const found = await cache.resolveRef(targetHash);
  assert.ok(found);
  assert.equal(found.hash, targetHash);
  // ensureAll already happened above, no extra one.
  assert.equal(cache.__stats.ensureCount, 1);
});

test("invalidateFile dedups concurrent in-flight invocations", async () => {
  const app = makeApp([
    { path: "Tasks/t1.md", hasTask: true, content: "- [ ] X\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  const before = cache.__stats.parseCount;
  // Three concurrent invalidations of the same path must coalesce.
  const ps = [
    cache.invalidateFile("Tasks/t1.md"),
    cache.invalidateFile("Tasks/t1.md"),
    cache.invalidateFile("Tasks/t1.md"),
  ];
  await Promise.all(ps);

  assert.equal(
    cache.__stats.parseCount - before,
    1,
    "concurrent invalidateFile calls for the same path must produce exactly one parse",
  );
});

test("parse error in one file: console.warn, others continue (mapLimit isolation)", async () => {
  const app = makeApp([
    { path: "Tasks/ok.md", hasTask: true, content: "- [ ] OK\n" },
    { path: "Tasks/fail.md", hasTask: true, parseFails: true },
    { path: "Tasks/ok2.md", hasTask: true, content: "- [ ] OK2\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  // Suppress the expected warning so test output stays clean.
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await cache.ensureAll();
  } finally {
    console.warn = origWarn;
  }

  assert.ok(
    cache.__stats.parseErrCount >= 1,
    `parseErrCount should bump on read failure, got ${cache.__stats.parseErrCount}`,
  );
  // Other two files parsed successfully — failure does not poison the batch.
  assert.equal(cache.__stats.parseCount, 2);
  const tasks = cache.flatten();
  const paths = tasks.map((t) => t.path).sort();
  assert.deepEqual(paths, ["Tasks/ok.md", "Tasks/ok2.md"]);
});

test("delete event: drops the file's tasks from cache, emits changed", async () => {
  const app = makeApp([
    { path: "Tasks/t1.md", hasTask: true, content: "- [ ] One\n" },
    { path: "Tasks/t2.md", hasTask: true, content: "- [ ] Two\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  const events = [];
  cache.on("changed", (paths) => events.push(new Set(paths)));

  // Simulate Obsidian deleting the file.
  const t1 = app._byPath.get("Tasks/t1.md");
  app._byPath.delete("Tasks/t1.md");
  app._files.splice(app._files.indexOf(t1), 1);
  app._fireVault("delete", t1);

  const remaining = cache.flatten();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].path, "Tasks/t2.md");
  assert.ok(events.length >= 1);
  assert.ok(events[0].has("Tasks/t1.md"));
});

test("dispose: clears state and unsubscribes listeners", async () => {
  const app = makeApp([
    { path: "Tasks/t1.md", hasTask: true, content: "- [ ] One\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();
  assert.equal(cache.flatten().length, 1);

  const events = [];
  cache.on("changed", (paths) => events.push(paths));

  cache.dispose();

  assert.equal(cache.flatten().length, 0);
  // After dispose, listeners are cleared — firing changed must not call them.
  app._fireMetaChanged("Tasks/t1.md");
  await cache.forFlush();
  assert.equal(events.length, 0);
});

// ── VAL-CORE-003: TaskCache is the only vault read path ──

test("VAL-CORE-003: cache construction does NOT trigger ensureAll (onload safety)", () => {
  const app = makeApp([
    { path: "Tasks/t1.md", hasTask: true, content: "- [ ] One\n" },
    { path: "Tasks/t2.md", hasTask: true, content: "- [ ] Two\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();

  // After construction + bind, no file should have been parsed.
  assert.equal(cache.__stats.ensureCount, 0);
  assert.equal(cache.__stats.parseCount, 0);
  assert.equal(cache.flatten().length, 0);
});

test("VAL-CORE-003: single-file change invalidates only the affected file", async () => {
  const app = makeApp([
    { path: "Tasks/a.md", hasTask: true, content: "- [ ] Alpha\n" },
    { path: "Tasks/b.md", hasTask: true, content: "- [ ] Bravo\n" },
    { path: "Tasks/c.md", hasTask: true, content: "- [ ] Charlie\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  const beforeParse = cache.__stats.parseCount;

  // Change only file b.
  app._setContent("Tasks/b.md", "- [ ] Bravo updated\n");
  app._fireMetaChanged("Tasks/b.md");
  await cache.forFlush();

  // Exactly ONE additional parse.
  assert.equal(
    cache.__stats.parseCount - beforeParse,
    1,
    "single-file invalidation must parse exactly one file",
  );

  // Verify a and c are unchanged.
  const tasks = cache.flatten();
  const a = tasks.find((t) => t.path === "Tasks/a.md");
  const c = tasks.find((t) => t.path === "Tasks/c.md");
  assert.ok(a, "unchanged file a should still be in cache");
  assert.ok(c, "unchanged file c should still be in cache");
  assert.match(a.rawLine, /Alpha/);
  assert.match(c.rawLine, /Charlie/);
});

test("VAL-CORE-003: changed event carries only the affected path", async () => {
  const app = makeApp([
    { path: "Tasks/x.md", hasTask: true, content: "- [ ] X\n" },
    { path: "Tasks/y.md", hasTask: true, content: "- [ ] Y\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  const events = [];
  cache.on("changed", (paths) => events.push(new Set(paths)));

  app._setContent("Tasks/x.md", "- [ ] X updated\n");
  app._fireMetaChanged("Tasks/x.md");
  await cache.forFlush();

  assert.equal(events.length, 1);
  assert.deepEqual(Array.from(events[0]), ["Tasks/x.md"]);
  // y.md must not appear in the changed set.
  assert.ok(!events[0].has("Tasks/y.md"));
});

test("VAL-CORE-003: resolveRef path:Lnnn on cold cache does not load other files", async () => {
  // A vault with many files — resolveRef for ONE path must parse only that
  // file, not trigger a vault-wide scan.
  const specs = [];
  for (let i = 0; i < 100; i++) {
    specs.push({
      path: `Vault/f${i}.md`,
      hasTask: true,
      metaIndexed: true,
      content: `- [ ] Task ${i}\n`,
    });
  }
  const app = makeApp(specs);
  const cache = new TaskCache(app);
  cache.bind();

  const t = await cache.resolveRef("Vault/f42.md:L1");
  assert.ok(t, "should resolve the single ref");
  assert.equal(cache.__stats.parseCount, 1, "must parse ONLY the requested file");
  assert.equal(cache.__stats.ensureCount, 0, "must NOT trigger ensureAll");
});

// ── VAL-CLI-004: stale path:Lnn hash recovery ──

test("resolveRef — stale path:Lnn recovers by hash when unique (line shifted)", async () => {
  const app = makeApp([
    { path: "Tasks/t1.md", hasTask: true, metaIndexed: false, content: "- [ ] Original task\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  // Get the original task's id and hash
  const tasks = cache.flatten();
  assert.equal(tasks.length, 1);
  const originalRef = tasks[0].id; // "Tasks/t1.md:L1"
  const originalHash = tasks[0].hash;

  // Simulate external edit: add a blank line above, shifting the task to line 2
  app._setContent("Tasks/t1.md", "\n- [ ] Original task\n");
  app._fireMetaChanged("Tasks/t1.md");
  await cache.forFlush();

  // The task is now at line 1 (0-indexed), but ref still says L1 (line 0).
  // resolveRef should recover via stale-hash lookup.
  const recovered = await cache.resolveRef(originalRef);
  assert.ok(recovered, "should recover task via stale hash");
  assert.equal(recovered.hash, originalHash);
  assert.equal(recovered.line, 1, "recovered task should be at the new line");
  assert.equal(recovered.id, "Tasks/t1.md:L2");
});

test("resolveRef — stale path:Lnn with hash collision returns ambiguous_slug", async () => {
  // Two tasks with identical path+title → identical hash (hash is path::title).
  // When the line shifts, the stale ref hash matches BOTH tasks.
  const app = makeApp([
    {
      path: "Tasks/t1.md",
      hasTask: true,
      metaIndexed: false,
      content: "- [ ] Dupe\n- [ ] Dupe\n",
    },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  const tasks = cache.flatten();
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].hash, tasks[1].hash, "identical title+path must produce identical hash");

  const staleRef = tasks[0].id; // "Tasks/t1.md:L1"

  // Shift lines: add a line above
  app._setContent("Tasks/t1.md", "# header\n- [ ] Dupe\n- [ ] Dupe\n");
  app._fireMetaChanged("Tasks/t1.md");
  await cache.forFlush();

  // The stale ref should now throw ambiguous_slug because hash matches 2 tasks
  await assert.rejects(
    () => cache.resolveRef(staleRef),
    (err) => err.code === "ambiguous_slug",
    "stale ref with hash collision should throw ambiguous_slug",
  );
});

test("resolveRef — stale path:Lnn with no hash match throws not_found", async () => {
  const app = makeApp([
    { path: "Tasks/t1.md", hasTask: true, metaIndexed: false, content: "- [ ] Will be deleted\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  const tasks = cache.flatten();
  const staleRef = tasks[0].id; // "Tasks/t1.md:L1"

  // Replace with a non-task line at line 0 — the original task is gone and
  // the new content doesn't produce a matching hash for the stale ref.
  app._setContent("Tasks/t1.md", "Just text, not a task\n");
  app._fireMetaChanged("Tasks/t1.md");
  await cache.forFlush();

  // The stale ref hash doesn't match any task in the updated cache
  await assert.rejects(
    () => cache.resolveRef(staleRef),
    (err) => err.code === "not_found",
    "stale ref with no hash match should throw not_found",
  );
});

test("resolveRef — stale path:Lnn recovery works when task is deleted then re-added later in same file", async () => {
  // A task is deleted from its original line and a matching task (same path+title)
  // appears later in the same file. The stale hash maps to the re-added task.
  const app = makeApp([
    { path: "Tasks/a.md", hasTask: true, metaIndexed: false, content: "- [ ] Recurring\n\nSome text\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  const tasksA = cache.get("Tasks/a.md");
  const originalRef = tasksA.tasks[0].id; // "Tasks/a.md:L1"
  const originalHash = tasksA.tasks[0].hash;

  // Delete the original task, add same-title task at a later line
  app._setContent("Tasks/a.md", "Some text\n\n- [ ] Recurring\n");
  app._fireMetaChanged("Tasks/a.md");
  await cache.forFlush();

  // The original ref (Tasks/a.md:L1) is stale because line 0 is now "Some text".
  // Hash recovery should find the task at the new position.
  const recovered = await cache.resolveRef(originalRef);
  assert.ok(recovered, "should recover task via stale hash");
  assert.equal(recovered.hash, originalHash);
  assert.equal(recovered.line, 2, "recovered task should be at the new line (0-indexed)");
});

test("resolveRef — different task at same line after edit is not incorrectly returned (identity check)", async () => {
  // Bug: When the original task at a line is replaced by a DIFFERENT task
  // at the same position, resolveRef should NOT return the new occupant.
  // It must detect the hash mismatch and recover by stored hash or return
  // not_found — never silently return the wrong task.
  const app = makeApp([
    { path: "Tasks/t1.md", hasTask: true, metaIndexed: true, content: "- [ ] Original task\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  const tasks = cache.flatten();
  assert.equal(tasks.length, 1);
  const originalRef = tasks[0].id; // "Tasks/t1.md:L1"
  const originalHash = tasks[0].hash;
  const originalTitle = tasks[0].title;

  // Replace with a DIFFERENT task at the same line (different title → different hash).
  app._setContent("Tasks/t1.md", "- [ ] Completely different\n");
  app._fireMetaChanged("Tasks/t1.md");
  await cache.forFlush();

  // The original task is gone, replaced by a different one.
  // resolveRef should NOT return the new occupant as if it were the original.
  // Since the original hash no longer matches any task in the cache,
  // it should throw not_found.
  await assert.rejects(
    () => cache.resolveRef(originalRef),
    (err) => err.code === "not_found",
    "stale ref where line is occupied by a different task should throw not_found",
  );
});

test("resolveRef — stale path:Lnn where original task moved and different task occupies old line", async () => {
  // When a task moves to a different line AND a different task takes its
  // old position, resolveRef must detect the identity mismatch and recover
  // the original task by hash.
  const app = makeApp([
    {
      path: "Tasks/t2.md",
      hasTask: true,
      metaIndexed: false,
      content: "- [ ] Task A\n- [ ] Task B\n",
    },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  const tasks = cache.flatten();
  assert.equal(tasks.length, 2);
  const refA = tasks[0].id; // "Tasks/t2.md:L1"
  const hashA = tasks[0].hash;

  // Edit: add a new task above, pushing Task A to line 2 and Task B to line 3.
  // The new task at line 1 has a different title than Task A.
  app._setContent("Tasks/t2.md", "- [ ] New task C\n- [ ] Task A\n- [ ] Task B\n");
  app._fireMetaChanged("Tasks/t2.md");
  await cache.forFlush();

  // resolveRef for the original Task A ref (Tasks/t2.md:L1) should detect
  // that the line-1 occupant (New task C) has a different hash, then recover
  // Task A at its new position.
  const recovered = await cache.resolveRef(refA);
  assert.ok(recovered, "should recover original task via hash when line is occupied by different task");
  assert.equal(recovered.hash, hashA);
  assert.equal(recovered.title, "Task A");
  assert.equal(recovered.line, 1, "Task A should be at line 2 (0-indexed 1)");
  assert.equal(recovered.id, "Tasks/t2.md:L2");
});

test("resolveRef — same-hash old-line occupant collision returns ambiguous_slug", async () => {
  // Two tasks with identical title → identical hash.
  // When the file content is rearranged so that a DIFFERENT same-hash task
  // occupies the original line, resolveRef must NOT return the line occupant
  // but instead return ambiguous_slug listing all candidates.
  const app = makeApp([
    {
      path: "Tasks/t3.md",
      hasTask: true,
      metaIndexed: false,
      content: "- [ ] Dupe\n- [ ] Dupe\n- [ ] Marker\n",
    },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  const tasks = cache.flatten();
  assert.equal(tasks.length, 3);
  // First two tasks have the same hash (same path + title)
  assert.equal(tasks[0].hash, tasks[1].hash, "identical title+path must produce identical hash");

  const refA = tasks[0].id; // "Tasks/t3.md:L1" — Task A (first Dupe)

  // Rearrange: swap the first Dupe with Marker so a different same-hash
  // Dupe occupies the original L1 position.
  // Original: L0=Dupe(A), L1=Dupe(B), L2=Marker
  // New:      L0=Dupe(B), L1=Marker,  L2=Dupe(A)
  app._setContent("Tasks/t3.md", "- [ ] Dupe\n- [ ] Marker\n- [ ] Dupe\n");
  app._fireMetaChanged("Tasks/t3.md");
  await cache.forFlush();

  // The stale ref (Tasks/t3.md:L1) now finds a Dupe at L0 that has the
  // SAME hash as the stored original hash. But there are TWO Dupe tasks
  // in the cache with that hash — we can't tell which one was the original
  // Task A. Must return ambiguous_slug, not silently return the wrong one.
  await assert.rejects(
    () => cache.resolveRef(refA),
    (err) => err.code === "ambiguous_slug",
    "stale ref where old line is occupied by same-hash different task should throw ambiguous_slug",
  );
});

test("resolveRef — live path:Lnn ref still resolves directly (no regression)", async () => {
  const app = makeApp([
    { path: "Tasks/t1.md", hasTask: true, content: "- [ ] Live task\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  // Ref that still points to the right line should resolve normally.
  const t = await cache.resolveRef("Tasks/t1.md:L1");
  assert.ok(t, "live ref should resolve");
  assert.equal(t.line, 0);
  assert.equal(t.title, "Live task");
});

// ── VAL-CORE-003: rename event ──

test("VAL-CORE-003: rename event remaps path without re-parsing", async () => {
  const app = makeApp([
    { path: "Tasks/old.md", hasTask: true, content: "- [ ] Old\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  const beforeParse = cache.__stats.parseCount;

  const oldFile = app._byPath.get("Tasks/old.md");
  const newFile = new TFile();
  newFile.path = "Tasks/new.md";
  newFile.extension = "md";
  newFile.stat = { mtime: 2000 };
  newFile._content = oldFile._content;
  newFile._hasTask = true;
  newFile._metaIndexed = true;
  app._byPath.delete("Tasks/old.md");
  app._byPath.set("Tasks/new.md", newFile);
  const idx = app._files.indexOf(oldFile);
  if (idx >= 0) app._files.splice(idx, 1);
  app._files.push(newFile);

  app._fireVault("rename", newFile, "Tasks/old.md");
  await cache.forFlush();

  // Rename should remap without re-parsing the same bytes.
  assert.equal(
    cache.__stats.parseCount,
    beforeParse,
    "rename must NOT re-parse",
  );

  const tasks = cache.flatten();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].path, "Tasks/new.md");
  assert.equal(tasks[0].id, "Tasks/new.md:L1");
});
