// View projection — projects a filtered EffectiveTask[] into per-area render
// models. Views are SwiftUI-style layout trees (row/col stacks of area leaves);
// each area projects independently. Today/Completed/Unscheduled are just list
// areas with different DSL, not view types.
//
// ARCHITECTURE.md §4.3 defines the projection semantics:
//   - List: area `when` narrows preset.filters, then sections group further;
//     no sections → one default (ungrouped) section.
//   - Week/Month: date columns/cells from effectiveScheduled. Trays are
//     separate list areas in the layout, not embedded here.
// Pure functions, no DOM, no Obsidian dependency.

import type { EffectiveTask } from "../task-tree";
import type {
  AreaConfig,
  GridAreaConfig,
  ListAreaConfig,
  MonthAreaConfig,
  WeekAreaConfig,
} from "../types";
import { applyQueryFilters, queryFilterHasActiveConditions } from "./filter";
import { startOfWeek, addDays, startOfMonth, endOfMonth, daysBetween, todayISO } from "../dates";

// ── View model types ──

export interface ListSectionModel {
  id?: string;
  title: string;
  tasks: EffectiveTask[];
  emptyText?: string;
}

export interface DayColumnModel {
  date: string;
  tasks: EffectiveTask[];
}

export interface MonthCellModel {
  date: string;
  tasks: EffectiveTask[];
}

export interface ListViewModel {
  type: "list";
  // grouped=false → a single implicit section, render flat with no header.
  grouped: boolean;
  sections: ListSectionModel[];
}

export interface WeekViewModel {
  type: "week";
  days: DayColumnModel[];
}

export interface MonthViewModel {
  type: "month";
  cells: MonthCellModel[];
}

export type ViewModel = ListViewModel | WeekViewModel | MonthViewModel;

/**
 * Project a single area into its ViewModel. Used by the CLI / API query-run,
 * which represents a preset's result via its primary content area. A `drop`
 * area has no data, so it projects to an empty ungrouped list.
 */
export function projectArea(
  area: AreaConfig,
  tasks: EffectiveTask[],
  weekStartsOn: 0 | 1,
  anchorISO: string = todayISO(),
): ViewModel {
  switch (area.type) {
    case "week":
      return projectWeekArea(tasks, area, weekStartsOn, anchorISO);
    case "month":
      return projectMonthArea(tasks, area, anchorISO);
    case "drop":
    case "unknown":
      return { type: "list", grouped: false, sections: [{ title: "", tasks: [] }] };
    case "grid":
    case "list":
    default:
      return projectListArea(tasks, area, weekStartsOn);
  }
}

// ── Sorting ──

type SortKey = "title_asc" | "title_desc" | "scheduled_asc" | "scheduled_desc"
  | "deadline_asc" | "deadline_desc" | "completed_desc" | "created_desc"
  | "deadline_risk" | "priority_desc";

function parseSortKey(raw: string): SortKey | null {
  const valid = new Set<string>([
    "title_asc", "title_desc", "scheduled_asc", "scheduled_desc",
    "deadline_asc", "deadline_desc", "completed_desc", "created_desc",
    "deadline_risk", "priority_desc",
  ]);
  return valid.has(raw) ? (raw as SortKey) : null;
}

function sortTasks(tasks: EffectiveTask[], orderBy?: string[]): EffectiveTask[] {
  if (!orderBy || orderBy.length === 0) return tasks;
  const keys = orderBy.map(parseSortKey).filter((k): k is SortKey => k !== null);
  if (keys.length === 0) return tasks;

  return [...tasks].sort((a, b) => {
    for (const key of keys) {
      const cmp = compareByKey(a, b, key);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

function compareByKey(a: EffectiveTask, b: EffectiveTask, key: SortKey): number {
  switch (key) {
    case "title_asc":
      return a.title.localeCompare(b.title);
    case "title_desc":
      return b.title.localeCompare(a.title);
    case "scheduled_asc":
      return (a.effectiveScheduled ?? "9999").localeCompare(b.effectiveScheduled ?? "9999");
    case "scheduled_desc":
      return (b.effectiveScheduled ?? "0000").localeCompare(a.effectiveScheduled ?? "0000");
    case "deadline_asc":
      return (a.effectiveDeadline ?? "9999").localeCompare(b.effectiveDeadline ?? "9999");
    case "deadline_desc":
      return (b.effectiveDeadline ?? "0000").localeCompare(a.effectiveDeadline ?? "0000");
    case "deadline_risk": {
      // Urgent (overdue) first, then nearest deadline, then no deadline
      const today = todayISO();
      const aRisk = deadlineRisk(a, today);
      const bRisk = deadlineRisk(b, today);
      if (aRisk !== bRisk) return aRisk - bRisk;
      return (a.effectiveDeadline ?? "9999").localeCompare(b.effectiveDeadline ?? "9999");
    }
    case "completed_desc":
      return (b.completed ?? "0000").localeCompare(a.completed ?? "0000");
    case "created_desc":
      return (b.effectiveCreated ?? "0000").localeCompare(a.effectiveCreated ?? "0000");
    case "priority_desc":
      return (priorityRank(b.priority) - priorityRank(a.priority));
    default:
      return 0;
  }
}

function deadlineRisk(t: EffectiveTask, today: string): number {
  if (!t.effectiveDeadline) return 3; // no deadline
  if (t.effectiveDeadline < today) return 0; // overdue
  const diff = daysBetween(today, t.effectiveDeadline);
  if (diff <= 3) return 1; // soon
  return 2; // later
}

function priorityRank(p: string | null): number {
  switch (p) {
    case "🔺": return 5;
    case "⏫": return 4;
    case "🔼": return 3;
    case "🔽": return 2;
    case "⏬": return 1;
    default: return 0;
  }
}

// ── Per-area projections ──

/**
 * List area projection: area `when` narrows the (already preset-filtered)
 * task set, then `sections` group further. No sections → a single ungrouped
 * section (rendered flat, no header). Today and TODO share this projection.
 */
export function projectListArea(
  tasks: EffectiveTask[],
  area: ListAreaConfig | GridAreaConfig,
  weekStartsOn: 0 | 1,
  // US-153: ids that bypass the status filter only (just-completed cards in the
  // current view session). Threaded into both the area `when` and section `when`
  // so a freshly-done card keeps its place in a `status: todo` list. GUI-only;
  // CLI / summary never pass it.
  exemptStatusIds?: ReadonlySet<string>,
): ListViewModel {
  const base = area.when && queryFilterHasActiveConditions(area.when)
    ? applyQueryFilters(tasks, area.when, weekStartsOn, undefined, exemptStatusIds)
    : tasks;

  if (area.sections && area.sections.length > 0) {
    const sections: ListSectionModel[] = area.sections.map((section) => {
      const sectionTasks = queryFilterHasActiveConditions(section.when)
        ? applyQueryFilters(base, section.when, weekStartsOn, undefined, exemptStatusIds)
        : [...base];
      const sorted = sortTasks(sectionTasks, section.orderBy ?? area.orderBy);
      const limited = section.limit !== undefined && section.limit > 0
        ? sorted.slice(0, section.limit)
        : sorted;
      return { id: section.id, title: section.title, tasks: limited, emptyText: section.emptyText };
    });
    return { type: "list", grouped: true, sections };
  }

  const sorted = sortTasks(base, area.orderBy);
  const limited = area.limit !== undefined && area.limit > 0
    ? sorted.slice(0, area.limit)
    : sorted;
  return {
    type: "list",
    grouped: false,
    sections: [{ title: area.title ?? "", tasks: limited, emptyText: area.emptyText }],
  };
}

export function projectWeekArea(
  tasks: EffectiveTask[],
  _area: WeekAreaConfig,
  weekStartsOn: 0 | 1,
  anchorISO: string = todayISO(),
): WeekViewModel {
  const weekStart = startOfWeek(anchorISO, weekStartsOn);
  const days: DayColumnModel[] = [];
  for (let i = 0; i < 7; i++) {
    days.push({ date: addDays(weekStart, i), tasks: [] });
  }
  const daysByDate = new Map(days.map((day) => [day.date, day]));
  for (const task of tasks) {
    if (task.effectiveScheduled) {
      const dayCol = daysByDate.get(task.effectiveScheduled);
      if (dayCol) dayCol.tasks.push(task);
    }
  }
  return { type: "week", days };
}

export function projectMonthArea(
  tasks: EffectiveTask[],
  _area: MonthAreaConfig,
  anchorISO: string = todayISO(),
): MonthViewModel {
  const monthStart = startOfMonth(anchorISO);
  const monthEnd = endOfMonth(anchorISO);
  const totalDays = daysBetween(monthStart, monthEnd) + 1;
  const cells: MonthCellModel[] = [];
  for (let i = 0; i < totalDays; i++) {
    cells.push({ date: addDays(monthStart, i), tasks: [] });
  }
  const cellsByDate = new Map(cells.map((cell) => [cell.date, cell]));
  for (const task of tasks) {
    if (task.effectiveScheduled) {
      const cell = cellsByDate.get(task.effectiveScheduled);
      if (cell) cell.tasks.push(task);
    }
  }
  return { type: "month", cells };
}
