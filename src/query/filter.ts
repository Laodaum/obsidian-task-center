// Query filter execution — applies QueryPresetFilters to EffectiveTask[].
//
// Pure function, no DOM, no Obsidian dependency.  Shared by GUI, CLI,
// and summary computation.
//
// ARCHITECTURE.md §4.2 defines the filter semantics:
//   - search: title/tag keyword match (case-insensitive)
//   - tags: AND match (all specified tags must be present)
//   - status: multi-select over effectiveStatus
//   - time: per-field date token matching using effective dates
//   - unscheduled: means effectiveScheduled is null

import type { EffectiveTask } from "../task-tree";
import type {
  QueryPresetFilters,
  QueryTimeField,
  QueryTimeFilters,
} from "../types";
import { normalizeQueryStatus } from "./schema";
import { taskMatchesTimeToken, timeTokenAppliesToField } from "../time-filter";
import { todayISO } from "../dates";

// ── Field helpers ──

/**
 * Get the effective time value for a time filter field.
 * Uses effective dates (post-inheritance), not raw parsed values.
 */
function effectiveTimeValue(
  task: EffectiveTask,
  field: QueryTimeField,
): string | null {
  switch (field) {
    case "scheduled":
      return task.effectiveScheduled;
    case "deadline":
      return task.effectiveDeadline;
    case "completed":
      return task.completed;
    case "created":
      return task.effectiveCreated ?? task.created;
    case "dropped":
      return task.cancelled;
    default:
      return null;
  }
}

// ── Normalization ──

function normalizeTags(tags: QueryPresetFilters["tags"]): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  // Comma-separated string
  return tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function normalizeStatusFilter(
  status: QueryPresetFilters["status"],
): "all" | string[] {
  return normalizeQueryStatus(status);
}

interface NormalizedQueryFilters {
  searchQ: string;
  tagList: string[];
  statusFilter: "all" | string[];
  time: QueryTimeFilters;
  hasTime: boolean;
}

function normalizeQueryFilters(
  filters: QueryPresetFilters,
): NormalizedQueryFilters {
  const time = filters.time ?? {};
  return {
    searchQ: (filters.search ?? "").trim().toLowerCase(),
    tagList: normalizeTags(filters.tags),
    statusFilter: normalizeStatusFilter(filters.status),
    time,
    hasTime: Object.values(time).some(
      (v) => typeof v === "string" && v.trim(),
    ),
  };
}

// ── Individual filter predicates ──

function matchesSearch(task: EffectiveTask, q: string): boolean {
  const lower = q.toLowerCase();
  if (task.title.toLowerCase().includes(lower)) return true;
  for (const tag of task.tags) {
    if (tag.toLowerCase().includes(lower)) return true;
  }
  return false;
}

function matchesTags(task: EffectiveTask, wanted: string[]): boolean {
  for (const wantedTag of wanted) {
    const normalized = wantedTag.startsWith("#")
      ? wantedTag.toLowerCase()
      : `#${wantedTag.toLowerCase()}`;
    const found = task.tags.some(
      (t) => t.toLowerCase() === normalized,
    );
    if (!found) return false;
  }
  return true;
}

function matchesStatus(
  task: EffectiveTask,
  status: "all" | string[],
): boolean {
  if (status === "all") return true;
  // Use effectiveStatus (post terminal-inheritance), not raw checkbox status
  return status.includes(task.effectiveStatus);
}

function matchesTime(
  task: EffectiveTask,
  time: QueryTimeFilters,
  weekStartsOn: 0 | 1,
  today: string,
): boolean {
  for (const field of [
    "scheduled",
    "deadline",
    "completed",
    "created",
    "dropped",
  ] as QueryTimeField[]) {
    const token = time[field]?.trim();
    if (!token) continue;

    // ARCHITECTURE.md §4.2: "unscheduled" means effective scheduled is empty
    if (field === "scheduled" && token === "unscheduled") {
      if (task.effectiveScheduled !== null) return false;
      continue;
    }
    // "unscheduled" on non-scheduled fields: treated as "value is null"
    if (token === "unscheduled") {
      if (effectiveTimeValue(task, field) !== null) return false;
      continue;
    }

    // "overdue" and "next-7-days" only apply to deadline
    if (!timeTokenAppliesToField(field, token)) return false;

    const value = effectiveTimeValue(task, field);
    if (!taskMatchesTimeToken(value, token, weekStartsOn, today)) return false;
  }
  return true;
}

// ── Main entry point ──

export function queryFilterHasActiveConditions(
  filters: QueryPresetFilters,
): boolean {
  const normalized = normalizeQueryFilters(filters);
  return normalizedQueryFilterHasActiveConditions(normalized);
}

function normalizedQueryFilterHasActiveConditions(
  normalized: NormalizedQueryFilters,
): boolean {
  return Boolean(
    normalized.searchQ ||
      normalized.tagList.length > 0 ||
      normalized.statusFilter !== "all" ||
      normalized.hasTime,
  );
}

function taskMatchesNormalizedQueryFilters(
  task: EffectiveTask,
  normalized: NormalizedQueryFilters,
  weekStartsOn: 0 | 1,
  today: string,
  exemptStatusIds?: ReadonlySet<string>,
): boolean {
  if (normalized.searchQ && !matchesSearch(task, normalized.searchQ))
    return false;
  if (normalized.tagList.length > 0 && !matchesTags(task, normalized.tagList))
    return false;
  // US-153: a task in `exemptStatusIds` (just completed in this view session)
  // bypasses the status predicate only — every other filter still applies — so
  // a freshly-done card lingers in a `status: todo` view until the next
  // re-entry, instead of being filtered out the instant it is checked off.
  const statusExempt = exemptStatusIds?.has(task.id) ?? false;
  if (!statusExempt && !matchesStatus(task, normalized.statusFilter))
    return false;
  if (
    normalized.hasTime &&
    !matchesTime(task, normalized.time, weekStartsOn, today)
  )
    return false;
  return true;
}

/**
 * Apply QueryPreset filters to an array of EffectiveTask.
 *
 * All filters are AND-ed: a task must pass every active filter to be included.
 * Filters that are undefined/empty/absent are treated as "match all".
 *
 * @param tasks  EffectiveTask[] from deriveEffectiveTasks
 * @param filters  QueryPresetFilters from a QueryPreset
 * @param weekStartsOn  0=Sunday, 1=Monday
 * @param today  ISO date for "today" token (defaults to actual today)
 * @param exemptStatusIds  US-153: task ids that bypass the status filter only
 *   (just-completed cards in the current view session). Optional; GUI-only.
 *   CLI / summary / badge counts never pass it, so they are unaffected.
 * @returns filtered EffectiveTask[]
 */
export function applyQueryFilters(
  tasks: EffectiveTask[],
  filters: QueryPresetFilters,
  weekStartsOn: 0 | 1,
  today: string = todayISO(),
  exemptStatusIds?: ReadonlySet<string>,
): EffectiveTask[] {
  // Quick-pass: no active filters
  const normalized = normalizeQueryFilters(filters);
  if (!normalizedQueryFilterHasActiveConditions(normalized)) return tasks;
  return tasks.filter((task) =>
    taskMatchesNormalizedQueryFilters(task, normalized, weekStartsOn, today, exemptStatusIds),
  );
}
