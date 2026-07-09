// View projection — projects a filtered EffectiveTask[] into layout models
// for list, week, month, matrix, and horizon views.  Does NOT own business
// collections; Today/TODO/Unscheduled/Completed/Dropped are QueryPresets, not
// view types.
//
// ARCHITECTURE.md §4.3 defines the projection semantics:
//   - List: sections from view.sections; one default section if unconfigured.
//   - Week/Month: date columns/cells from effectiveScheduled; tray from explicit
//     view.tray filters (independent query, does not alter main date area).
//   - Matrix: 2D cells (X buckets × Y buckets) with unmatched handling.
//   - Horizon: 4 time buckets (today, this-week, next-week, this-month) based on
//     effectiveScheduled; tray optional.
// Pure functions, no DOM, no Obsidian dependency.

import type { EffectiveTask } from "../task-tree";
import type {
  QueryPresetMatrixBucket,
  QueryPresetViewConfig,
} from "../types";
import { applyQueryFilters, queryFilterHasActiveConditions } from "./filter";
import { startOfWeek, addDays, startOfMonth, endOfMonth, daysBetween, todayISO, endOfWeek } from "../dates";

// ── View model types ──

export interface ListSectionModel {
  title: string;
  tasks: EffectiveTask[];
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
  sections: ListSectionModel[];
}

export interface WeekViewModel {
  type: "week";
  days: DayColumnModel[];
  tray?: ListSectionModel;
}

export interface MonthViewModel {
  type: "month";
  cells: MonthCellModel[];
  tray?: ListSectionModel;
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

export interface HorizonBucketModel {
  id: "today" | "this-week" | "next-week" | "this-month";
  title: string;
  tasks: EffectiveTask[];
}

export interface HorizonViewModel {
  type: "horizon";
  buckets: HorizonBucketModel[];
  tray?: ListSectionModel;
}

export type ViewModel =
  | ListViewModel
  | WeekViewModel
  | MonthViewModel
  | MatrixViewModel
  | HorizonViewModel;

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

// ── Projections ──

/**
 * List projection: uses configured sections when available, otherwise
 * falls back to a single default section with all tasks.
 */
function projectList(
  tasks: EffectiveTask[],
  view: QueryPresetViewConfig,
): ListViewModel {
  // Use configured sections when available
  if (view.sections && view.sections.length > 0) {
    const sections: ListSectionModel[] = [];
    for (const section of view.sections) {
      // Filter tasks by section.when conditions
      const sectionTasks = Object.keys(section.when).length > 0
        ? applyQueryFilters(tasks, section.when, 0)
        : [...tasks];
      const sorted = sortTasks(sectionTasks, section.orderBy ?? view.orderBy);
      const limited = section.limit !== undefined && section.limit > 0
        ? sorted.slice(0, section.limit)
        : sorted;
      sections.push({
        title: section.title,
        tasks: limited,
      });
    }
    return { type: "list", sections };
  }

  // Fallback: single default section
  const sorted = sortTasks(tasks, view.orderBy);
  return {
    type: "list",
    sections: [{ title: "Tasks", tasks: sorted }],
  };
}

/**
 * Compute the tray for week/month views using explicit tray filters.
 * The tray is an independent query: it filters the full task set with
 * view.tray.filters and excludes tasks already placed in the main date area.
 */
function computeTray(
  tasks: EffectiveTask[],
  view: QueryPresetViewConfig,
  weekStartsOn: 0 | 1,
  mainAreaTaskIds: Set<string>,
): ListSectionModel | undefined {
  const trayCfg = view.tray;
  if (!trayCfg || !trayCfg.enabled) return undefined;

  // Apply tray-specific filters to the input task set
  const trayTasks = Object.keys(trayCfg.filters).length > 0
    ? applyQueryFilters(tasks, trayCfg.filters, weekStartsOn)
    : [...tasks];

  // Exclude tasks already in the main date area (avoid double-display)
  const deduped = trayTasks.filter((t) => !mainAreaTaskIds.has(t.id));
  if (deduped.length === 0) return undefined;

  const sorted = sortTasks(deduped, trayCfg.orderBy ?? view.orderBy);
  return { title: trayCfg.title, tasks: sorted };
}

function projectWeek(
  tasks: EffectiveTask[],
  traySourceTasks: EffectiveTask[],
  view: QueryPresetViewConfig,
  weekStartsOn: 0 | 1,
  anchorISO: string,
): WeekViewModel {
  const weekStart = startOfWeek(anchorISO, weekStartsOn);
  const days: DayColumnModel[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    days.push({ date, tasks: [] });
  }

  const mainAreaIds = new Set<string>();
  const daysByDate = new Map(days.map((day) => [day.date, day]));

  const sorted = sortTasks(tasks, view.orderBy);
  for (const task of sorted) {
    if (task.effectiveScheduled) {
      const dayCol = daysByDate.get(task.effectiveScheduled);
      if (dayCol) {
        dayCol.tasks.push(task);
        mainAreaIds.add(task.id);
        continue;
      }
    }
    // Tasks without effectiveScheduled or with a date outside the week:
    // when no explicit tray is configured, they go into the implicit tray.
    // When an explicit tray is configured, the tray is computed separately
    // and these leftovers are not included in the tray (unless they also
    // match the tray filter).
  }

  const tray = computeTray(traySourceTasks, view, weekStartsOn, mainAreaIds);

  return {
    type: "week",
    days,
    ...(tray ? { tray } : {}),
  };
}

function projectMonth(
  tasks: EffectiveTask[],
  traySourceTasks: EffectiveTask[],
  view: QueryPresetViewConfig,
  anchorISO: string,
): MonthViewModel {
  const monthStart = startOfMonth(anchorISO);
  const monthEnd = endOfMonth(anchorISO);
  const totalDays = daysBetween(monthStart, monthEnd) + 1;

  // Build cells for every day in the month.
  const cells: MonthCellModel[] = [];
  for (let i = 0; i < totalDays; i++) {
    cells.push({ date: addDays(monthStart, i), tasks: [] });
  }

  const mainAreaIds = new Set<string>();
  const cellsByDate = new Map(cells.map((cell) => [cell.date, cell]));

  const sorted = sortTasks(tasks, view.orderBy);
  for (const task of sorted) {
    if (task.effectiveScheduled) {
      const cell = cellsByDate.get(task.effectiveScheduled);
      if (cell) {
        cell.tasks.push(task);
        mainAreaIds.add(task.id);
        continue;
      }
    }
  }

  const tray = computeTray(traySourceTasks, view, 0, mainAreaIds);

  return {
    type: "month",
    cells,
    ...(tray ? { tray } : {}),
  };
}

/**
 * Matrix projection: builds a true 2D matrix where each cell is the
 * intersection of one X-axis bucket and one Y-axis bucket.
 *
 * - A task must match BOTH the X bucket AND Y bucket conditions to be in a cell.
 * - With multiMatch="first", a task appears in the first matching cell.
 * - With multiMatch="duplicate", a task appears in every matching cell.
 * - Unmatched tasks go into the unmatched section (unless unmatched="hide").
 */
function projectMatrix(
  tasks: EffectiveTask[],
  view: QueryPresetViewConfig,
  weekStartsOn: 0 | 1,
): MatrixViewModel {
  const mx = view.matrix;
  if (!mx) {
    return {
      type: "matrix",
      cells: [],
      xAxis: { id: "", title: "", buckets: [] },
      yAxis: { id: "", title: "", buckets: [] },
      unmatched: tasks,
    };
  }

  const xBuckets = mx.x?.buckets ?? [];
  const yBuckets = mx.y?.buckets ?? [];

  // Build the 2D cell grid: rows (y) × cols (x)
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
      // A task must match BOTH the X bucket AND Y bucket conditions.
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

  // Handle multiMatch: deduplicate across cells when multiMatch="first"
  if (mx.multiMatch !== "duplicate") {
    const firstSeen = new Set<string>();
    for (const cell of cells) {
      cell.tasks = cell.tasks.filter((t) => {
        if (firstSeen.has(t.id)) return false;
        firstSeen.add(t.id);
        return true;
      });
    }
  }

  // Collect all task IDs that appear in any cell
  const allCellTaskIds = new Set<string>();
  for (const cell of cells) {
    for (const t of cell.tasks) allCellTaskIds.add(t.id);
  }

  // Unmatched: tasks not in any cell
  const unmatched = mx.unmatched === "hide"
    ? []
    : tasks.filter((t) => !allCellTaskIds.has(t.id));

  // showEmptyBuckets: when false, hide cells with no tasks.
  // This also filters axis bucket metadata so that only buckets
  // contributing to at least one visible cell are exposed — empty
  // row/column labels are not rendered.
  const showEmpty = mx.showEmptyBuckets !== false;
  const visibleCells = showEmpty
    ? cells
    : cells.filter((c) => c.tasks.length > 0);

  // Derive visible axis bucket metadata from visible cells.
  // When showEmptyBuckets=false, xAxis/yAxis.buckets should only
  // list buckets that appear in at least one visible cell.
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
    xAxis: { id: mx.x.id, title: mx.x.title, buckets: xAxisBuckets },
    yAxis: { id: mx.y.id, title: mx.y.title, buckets: yAxisBuckets },
    unmatched: sortTasks(unmatched, view.orderBy),
  };
}

/**
 * Horizon projection: split tasks into 4 time buckets:
 *   today, this-week, next-week, this-month.
 *
 * Bucket boundaries follow the user's week-start setting.
 * Tasks without effectiveScheduled do not enter date buckets
 * (they may appear in the optional tray).
 */
function projectHorizon(
  tasks: EffectiveTask[],
  traySourceTasks: EffectiveTask[],
  view: QueryPresetViewConfig,
  weekStartsOn: 0 | 1,
  anchorISO: string,
): HorizonViewModel {
  const today = todayISO();
  const weekStart = startOfWeek(anchorISO, weekStartsOn);
  const weekEnd = endOfWeek(anchorISO, weekStartsOn);
  const nextWeekStart = addDays(weekStart, 7);
  const nextWeekEnd = addDays(weekEnd, 7);
  const monthStart = startOfMonth(anchorISO);
  const monthEnd = endOfMonth(anchorISO);

  const buckets: HorizonBucketModel[] = [
    { id: "today", title: "Today", tasks: [] },
    { id: "this-week", title: "This Week", tasks: [] },
    { id: "next-week", title: "Next Week", tasks: [] },
    { id: "this-month", title: "This Month", tasks: [] },
  ];

  const mainAreaIds = new Set<string>();

  const sorted = sortTasks(tasks, view.orderBy);
  for (const task of sorted) {
    const s = task.effectiveScheduled;
    if (!s) continue;

    if (s === today) {
      buckets[0].tasks.push(task);
      mainAreaIds.add(task.id);
    } else if (s >= weekStart && s <= weekEnd) {
      buckets[1].tasks.push(task);
      mainAreaIds.add(task.id);
    } else if (s >= nextWeekStart && s <= nextWeekEnd) {
      buckets[2].tasks.push(task);
      mainAreaIds.add(task.id);
    } else if (s >= monthStart && s <= monthEnd) {
      buckets[3].tasks.push(task);
      mainAreaIds.add(task.id);
    }
  }

  const tray = computeTray(traySourceTasks, view, weekStartsOn, mainAreaIds);

  return {
    type: "horizon",
    buckets,
    ...(tray ? { tray } : {}),
  };
}

// ── Main entry point ──

/**
 * Project a filtered EffectiveTask[] into a view layout model.
 *
 * The same task set can be projected into list, week, month, matrix, or horizon.
 * Views do not own business collections — they only organize the given tasks.
 *
 * @param tasks  Filtered EffectiveTask[] (output of applyQueryFilters)
 * @param view   QueryPresetViewConfig from the active QueryPreset
 * @param weekStartsOn  0=Sunday, 1=Monday
 * @param anchorISO  ISO date for the current view cursor (defaults to today)
 * @returns ViewModel for rendering
 */
export function applyViewProjection(
  tasks: EffectiveTask[],
  view: QueryPresetViewConfig,
  weekStartsOn: 0 | 1,
  anchorISO: string = todayISO(),
  traySourceTasks: EffectiveTask[] = tasks,
): ViewModel {
  switch (view.type) {
    case "list":
      return projectList(tasks, view);
    case "week":
      return projectWeek(tasks, traySourceTasks, view, weekStartsOn, anchorISO);
    case "month":
      return projectMonth(tasks, traySourceTasks, view, anchorISO);
    case "matrix":
      return projectMatrix(tasks, view, weekStartsOn);
    case "horizon":
      return projectHorizon(tasks, traySourceTasks, view, weekStartsOn, anchorISO);
    default:
      return projectList(tasks, view);
  }
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
