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
//   - Matrix: 2D cells (X buckets × Y buckets) with unmatched handling.
// Pure functions, no DOM, no Obsidian dependency.

import type { EffectiveTask } from "../task-tree";
import type {
  AreaConfig,
  GridAreaConfig,
  ListAreaConfig,
  MatrixAreaConfig,
  MonthAreaConfig,
  QueryPresetMatrixBucket,
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

/**
 * A single cell in a 2D matrix: the intersection of one X bucket and one Y bucket.
 */
export interface MatrixCellModel {
  rowId: string;
  colId: string;
  rowTitle: string;
  colTitle: string;
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

export interface MatrixViewModel {
  type: "matrix";
  /** 2D cells: row (y-axis bucket) × col (x-axis bucket). */
  cells: MatrixCellModel[];
  /** Axis metadata for rendering headers. */
  xAxis: { id: string; title: string; buckets: { id: string; title: string }[] };
  yAxis: { id: string; title: string; buckets: { id: string; title: string }[] };
  unmatched: EffectiveTask[];
}

export type ViewModel = ListViewModel | WeekViewModel | MonthViewModel | MatrixViewModel;

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
    case "matrix":
      return projectMatrixArea(tasks, area, weekStartsOn);
    case "drop":
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
): ListViewModel {
  const base = area.when && queryFilterHasActiveConditions(area.when)
    ? applyQueryFilters(tasks, area.when, weekStartsOn)
    : tasks;

  if (area.sections && area.sections.length > 0) {
    const sections: ListSectionModel[] = area.sections.map((section) => {
      const sectionTasks = queryFilterHasActiveConditions(section.when)
        ? applyQueryFilters(base, section.when, weekStartsOn)
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

/**
 * Matrix area projection: a 2D matrix where each cell is the intersection of
 * one X-axis bucket and one Y-axis bucket. The matrix config is inlined on the
 * area (x / y / unmatched / multiMatch / showEmptyBuckets).
 */
export function projectMatrixArea(
  tasks: EffectiveTask[],
  area: MatrixAreaConfig,
  weekStartsOn: 0 | 1,
): MatrixViewModel {
  const xBuckets = area.x?.buckets ?? [];
  const yBuckets = area.y?.buckets ?? [];

  const cells: MatrixCellModel[] = [];
  const xMatches = new Map<string, Set<string>>();
  const yMatches = new Map<string, Set<string>>();

  for (const bucket of xBuckets) {
    xMatches.set(bucket.id, matchingTaskIds(tasks, bucket.when, weekStartsOn));
  }
  for (const bucket of yBuckets) {
    yMatches.set(bucket.id, matchingTaskIds(tasks, bucket.when, weekStartsOn));
  }

  for (const yBucket of yBuckets) {
    for (const xBucket of xBuckets) {
      const xSet = xMatches.get(xBucket.id)!;
      const ySet = yMatches.get(yBucket.id)!;
      const cellTasks = tasks.filter((task) => xSet.has(task.id) && ySet.has(task.id));
      cells.push({
        rowId: yBucket.id,
        colId: xBucket.id,
        rowTitle: yBucket.title,
        colTitle: xBucket.title,
        tasks: cellTasks,
      });
    }
  }

  if (area.multiMatch !== "duplicate") {
    const firstSeen = new Set<string>();
    for (const cell of cells) {
      cell.tasks = cell.tasks.filter((t) => {
        if (firstSeen.has(t.id)) return false;
        firstSeen.add(t.id);
        return true;
      });
    }
  }

  const allCellTaskIds = new Set<string>();
  for (const cell of cells) {
    for (const t of cell.tasks) allCellTaskIds.add(t.id);
  }

  const unmatched = area.unmatched === "hide"
    ? []
    : tasks.filter((t) => !allCellTaskIds.has(t.id));

  const showEmpty = area.showEmptyBuckets !== false;
  const visibleCells = showEmpty ? cells : cells.filter((c) => c.tasks.length > 0);

  const visibleColIds = new Set(visibleCells.map((c) => c.colId));
  const visibleRowIds = new Set(visibleCells.map((c) => c.rowId));
  const xAxisBuckets = xBuckets
    .filter((b) => showEmpty || visibleColIds.has(b.id))
    .map((b) => ({ id: b.id, title: b.title }));
  const yAxisBuckets = yBuckets
    .filter((b) => showEmpty || visibleRowIds.has(b.id))
    .map((b) => ({ id: b.id, title: b.title }));

  return {
    type: "matrix",
    cells: visibleCells,
    xAxis: { id: area.x.id, title: area.x.title, buckets: xAxisBuckets },
    yAxis: { id: area.y.id, title: area.y.title, buckets: yAxisBuckets },
    unmatched,
  };
}

function matchingTaskIds(
  tasks: EffectiveTask[],
  filters: QueryPresetMatrixBucket["when"],
  weekStartsOn: 0 | 1,
): Set<string> {
  if (!queryFilterHasActiveConditions(filters)) {
    return new Set(tasks.map((task) => task.id));
  }
  return new Set(
    applyQueryFilters(tasks, filters, weekStartsOn).map((task) => task.id),
  );
}
