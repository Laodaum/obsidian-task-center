// Pure presentation helpers for the area filter controls — no DOM, no view
// state, only i18n. Extracted from the TaskCenterView god class so the area
// filter UI's label/option/toggle logic is unit-testable and reusable.
// (REFACTOR.md Phase 2 — first pure-logic extraction.)

import { t as tr } from "../i18n";
import type { QueryStatus, QueryTimeField, TagSelector, TaskStatus } from "../types";

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

// 把三态选择（包含组 + 与/或模式 + 排除组）拼成可写回 `when.tags` 的形态：
// 纯 AND 包含组、无排除 → 裸数组（向后兼容）；否则 `{ values, mode, exclude? }`
// 对象。空包含 + 无排除 → 裸空数组。（US-109d3）
export function buildTagsField(
  include: string[],
  mode: "and" | "or",
  exclude: string[] = [],
): string[] | TagSelector {
  const hasExclude = exclude.length > 0;
  const useObject = hasExclude || (mode === "or" && include.length > 0);
  if (!useObject) return include;
  const sel: TagSelector = { values: include, mode: include.length > 0 ? mode : "and" };
  if (hasExclude) sel.exclude = exclude;
  return sel;
}

// 标签匹配模式的选项（全部匹配 = AND / 任一匹配 = OR）。
export function tagModeOptions(): Array<{ value: "and" | "or"; label: string }> {
  return [
    { value: "and", label: tr("savedViews.tagModeAll") },
    { value: "or", label: tr("savedViews.tagModeAny") },
  ];
}

// US-109d3: trigger summary covering both include and exclude groups, e.g.
// "#a +1 · −#c". Exclude is prefixed with a minus sign (locale-neutral).
export function tagSelectionSummary(include: string[], exclude: string[]): string {
  const fmt = (tags: string[]): string =>
    tags.length === 1 ? tags[0] : `${tags[0]} +${tags.length - 1}`;
  const parts: string[] = [];
  if (include.length > 0) parts.push(fmt(include));
  if (exclude.length > 0) parts.push(`−${fmt(exclude)}`);
  return parts.length > 0 ? parts.join(" · ") : tr("savedViews.tag");
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
