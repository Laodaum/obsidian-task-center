// Pure presentation helpers for the area filter controls — no DOM, no view
// state, only i18n. Extracted from the TaskCenterView god class so the area
// filter UI's label/option/toggle logic is unit-testable and reusable.
// (REFACTOR.md Phase 2 — first pure-logic extraction.)

import { t as tr } from "../i18n";
import type { QueryStatus, QueryTimeField, TaskStatus } from "../types";

// The scheduled field is always shown; the rest are progressive (added on
// demand). Shared by the area filter controls and the legacy filter popovers.
export const PRIMARY_TIME_FIELD: QueryTimeField = "scheduled";
export const SECONDARY_TIME_FIELDS: QueryTimeField[] = ["deadline", "completed", "created"];

export function statusFilterOptions(): Array<{ value: "all" | TaskStatus; label: string }> {
  return [
    { value: "all", label: tr("savedViews.statusAny") },
    { value: "todo", label: tr("savedViews.statusTodo") },
    { value: "done", label: tr("savedViews.statusDone") },
    { value: "dropped", label: tr("savedViews.statusDropped") },
  ];
}

export function statusFilterLabel(status: TaskStatus): string {
  return statusFilterOptions().find((option) => option.value === status)?.label ?? status;
}

export function timeFieldLabel(field: QueryTimeField): string {
  if (field === "scheduled") return tr("savedViews.timeScheduled");
  if (field === "deadline") return tr("savedViews.timeDeadline");
  if (field === "completed") return tr("savedViews.timeCompleted");
  return tr("savedViews.timeCreated");
}

export function timeFilterOptions(field: QueryTimeField): Array<readonly [string, string]> {
  const base: Array<readonly [string, string]> = [
    ["", tr("savedViews.timeAll", { field: timeFieldLabel(field) })],
  ];
  if (field === "deadline") {
    base.push(["overdue", tr("savedViews.dateOverdue")], ["next-7-days", tr("savedViews.dateNext7Days")]);
  }
  base.push(
    ["today", tr("savedViews.dateToday")],
    ["tomorrow", tr("savedViews.dateTomorrow")],
    ["week", tr("savedViews.dateWeek")],
    ["next-week", tr("savedViews.dateNextWeek")],
    ["month", tr("savedViews.dateMonth")],
  );
  return base;
}

export function tagFilterSummary(selected: string[]): string {
  if (selected.length === 0) return tr("savedViews.tag");
  const first = selected[0];
  if (selected.length === 1) return first;
  return `${first} +${selected.length - 1}`;
}

// Toggle a status value in/out of the current selection. "all" clears the
// selection; toggling the last specific status off also falls back to "all".
export function toggledStatus(
  current: "all" | TaskStatus[],
  value: "all" | TaskStatus,
): QueryStatus {
  if (value === "all") return "all";
  const set = current === "all" ? [] : [...current];
  const idx = set.indexOf(value);
  if (idx >= 0) set.splice(idx, 1);
  else set.push(value);
  return set.length > 0 ? set : "all";
}
