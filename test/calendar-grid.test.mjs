// Unit tests for src/view/render/calendar-grid.ts — pure calendar math extracted
// from the TaskCenterView god class (ARCHITECTURE §7.6 first clean extraction).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const r = spawnSync(
    "npx",
    [
      "esbuild",
      "src/view/render/calendar-grid.ts",
      "--bundle=true",
      "--format=esm",
      "--platform=node",
      "--outdir=test/.compiled",
      "--loader:.ts=ts",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error("esbuild compile failed:\n" + r.stderr);
}
compilePure();
const mod = () => import("../test/.compiled/calendar-grid.js");

test("US-116: columnStats — plain count when no card carries an estimate", async () => {
  const { columnStats } = await mod();
  assert.equal(columnStats([{ estimate: null }, { estimate: null }]), "2");
  assert.equal(columnStats([]), "0");
});

test("US-116: columnStats — `count · duration` when estimates sum > 0", async () => {
  const { columnStats } = await mod();
  const s = columnStats([{ estimate: 30 }, { estimate: 60 }]);
  assert.match(s, /^2 · /, "leads with the task count and a separator");
});

test("buildWeekDays — 7 consecutive ISO days aligned to weekStartsOn", async () => {
  const { buildWeekDays } = await mod();
  const days = buildWeekDays("2026-06-24", 1); // Wed; Monday-start week
  assert.equal(days.length, 7);
  assert.equal(days[0], "2026-06-22"); // Monday
  assert.equal(days[6], "2026-06-28"); // Sunday
});

test("buildMonthGrid — week-aligned cells covering the whole month", async () => {
  const { buildMonthGrid } = await mod();
  const { first, last, gridStart, gridDays } = buildMonthGrid("2026-06-15", 1);
  assert.equal(first, "2026-06-01");
  assert.equal(last, "2026-06-30");
  assert.equal(gridDays[0], gridStart, "grid starts at the week-aligned start");
  assert.ok(gridDays.length >= 28 && gridDays.length <= 42, "full-week grid, trimmed");
  assert.ok(gridDays.includes("2026-06-15"), "covers the anchor day");
  assert.ok(gridDays.includes(last), "covers the month's last day");
});
