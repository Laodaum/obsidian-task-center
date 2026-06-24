// Pure calendar grid math for the week / month renderers — no DOM, no view
// state (REFACTOR.md / ARCHITECTURE §7.6: clean first extraction toward the
// CalendarRenderPort split). Unit-testable in isolation.

import { addDays, startOfWeek, startOfMonth, endOfMonth } from "../../dates";
import { formatMinutes } from "../../parser";
import type { ParsedTask } from "../../types";

// US-116: per-column header line "N · XhYm" — task count plus the summed
// `[estimate::]` minutes (omitted when zero).
export function columnStats(tasks: ParsedTask[]): string {
  const sum = tasks.reduce((s, t) => s + (t.estimate ?? 0), 0);
  if (sum === 0) return `${tasks.length}`;
  return `${tasks.length} · ${formatMinutes(sum)}`;
}

// The 7 ISO days of the week containing `anchorISO`, aligned to `weekStartsOn`.
export function buildWeekDays(anchorISO: string, weekStartsOn: 0 | 1): string[] {
  const weekStart = startOfWeek(anchorISO, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

// The month grid: week-aligned cells covering `anchorISO`'s month, up to 42 but
// trimmed once the month's last day is covered (≥ 28 cells, full weeks only).
export function buildMonthGrid(
  anchorISO: string,
  weekStartsOn: 0 | 1,
): { first: string; last: string; gridStart: string; gridDays: string[] } {
  const first = startOfMonth(anchorISO);
  const last = endOfMonth(anchorISO);
  const gridStart = startOfWeek(first, weekStartsOn);
  const gridDays: string[] = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    gridDays.push(d);
    if (i >= 27 && d > last) break;
  }
  return { first, last, gridStart, gridDays };
}
