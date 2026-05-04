// US-305: `[-] ❌` is "abandoned" and is its own checkbox-status semantic
// (`dropped`), separate from `done`. Keeping abandonment distinct lets
// users see what they walked away from — not lumped into "completed"
// counts and not pretending it never existed (vs. file deletion).
// see USER_STORIES.md
export type TaskStatus = "todo" | "done" | "dropped" | "in_progress" | "cancelled" | "custom";

export interface ParsedTask {
  id: string;
  path: string;
  line: number;
  indent: string;
  checkbox: string;
  status: TaskStatus;
  title: string;
  rawTitle: string;
  rawLine: string;
  tags: string[];
  scheduled: string | null;
  deadline: string | null;
  start: string | null;
  completed: string | null;
  cancelled: string | null;
  created: string | null;
  // US-142a: recurrence text from 🔁 token (e.g. "every week"). Consumed
  // greedily up to the next metadata boundary in parser.ts META_STRIP_RE.
  recurrence: string | null;
  // US-142a: priority emoji (🔺⏫🔼🔽⏬). Parsed from the raw title line.
  priority: string | null;
  // US-125: callout nesting depth — number of `> ` prefixes so the
  // writer can reconstruct the exact callout indent when writing back.
  calloutDepth: number;
  inlineFields: Record<string, string[]>;
  durationFields: Record<string, number>;
  // Backward-compatible aliases for the default summary preset. New UI and
  // aggregation paths should prefer durationFields so field names stay user data.
  estimate: number | null;
  actual: number | null;
  parentLine: number | null;
  parentIndex: number | null;
  childrenLines: number[];
  hash: string;
  mtime: number;
  // US-144: child inherits parent's terminal status (and via parent-side
  // emoji-date inspection in the renderer, parent's ⏳ / 📅 too) — so
  // children don't have to redundantly carry their parent's metadata.
  // Concretely this flag is "any ancestor list item (task OR bullet) is
  // `[x]` done, `[-]` dropped, or tagged `#dropped`". A terminated
  // ancestor suppresses its descendants from todo / unscheduled views
  // (finishing or abandoning a section implicitly finishes everything
  // below it — the cascade complement of US-145).
  // see USER_STORIES.md
  inheritsTerminal: boolean;
  // US-144a: the actual terminal kind propagated from the nearest terminal
  // ancestor (task or non-task bullet). When set, EffectiveTask derivation
  // uses this instead of mapping the task's own status or the ancestor's
  // status. This preserves the correct semantics when the terminal source
  // is a non-task bullet (e.g. `- #dropped`), a `[-]` dropped parent, or
  // a `[x]` done section header.
  // see USER_STORIES.md
  inheritedTerminalKind: TaskStatus | null;
}

export interface TaskCenterSettings {
  // Legacy settings may still exist in old data.json; loadSettings ignores
  // unknown keys, and these optional fields are only read by migration-safe
  // compatibility paths.
  inboxPath?: string;
  groupingTags?: string[];
  // US-724 / VAL-CORE-005: user-saved query presets. These are the
  // canonical QueryPreset DSL model shared by GUI, CLI, and storage.
  // Legacy SavedTaskView entries in data.json are detected and rejected
  // during loadSettings — no migration path exists.
  queryPresets: QueryPreset[];
  defaultSavedViewId: string | null;
  defaultView: "today" | "week" | "month" | "completed" | "unscheduled";
  openOnStartup: boolean;
  weekStartsOn: 0 | 1;
  stampCreated: boolean;
  // US-405: last tab the user was on when they closed the board. Persists
  // across Obsidian restarts so morning-open lands where evening-close
  // left off. Read in `TaskCenterView.constructor`'s ViewState init,
  // written in `setTab`.
  // see USER_STORIES.md
  lastTab: "today" | "week" | "month" | "completed" | "unscheduled" | null;
  lastSavedViewId: string | null;
  // US-510: platform-conditional UI strings — shortcut hints / mouse
  // descriptions are branched per platform (desktop hint vs mobile hint),
  // not localized; these tunables also live mobile-only. Safe defaults so
  // desktop users see no change.
  // see USER_STORIES.md
  mobileLongPressMs: number; // 200..1000, default 500
  mobileSwipeEnabled: boolean; // default true (left=done, right=drop)
  // US-502: viewport-based mobile layout switch + force-mobile escape
  // hatch for iPad / split-screen / large foldables that want column
  // layout regardless of width. UX-mobile §7.
  // see USER_STORIES.md
  mobileForceLayout: boolean; // default false (auto = follow viewport width)
}

export type SavedViewStatus = "all" | TaskStatus | TaskStatus[];
export type SavedViewTimeField = "scheduled" | "deadline" | "completed" | "created" | "dropped";
export type SavedViewTimeFilters = Partial<Record<SavedViewTimeField, string>>;
export type QueryViewType = "list" | "week" | "month" | "matrix";

export interface SavedViewConfig {
  type: QueryViewType;
  // Optional preset semantic. Examples: "today", "completed", "unscheduled".
  // This is not a new view type; it is metadata that lets the runtime restore
  // which query preset semantics the user saved.
  preset?: string;
  orderBy?: string[];
}

export interface SavedViewSummaryMetric {
  type: "count" | "sum" | "ratio" | "top_n" | "group_by";
  field?: string;
  numerator?: string;
  denominator?: string;
  by?: string;
  limit?: number;
  format?: string;
}

export interface SavedTaskView {
  id: string;
  name: string;
  builtin?: boolean;
  hidden?: boolean;
  search: string;
  tag: string;
  time: SavedViewTimeFilters;
  status: SavedViewStatus;
  view?: SavedViewConfig;
  summary?: SavedViewSummaryMetric[];
}

// ── QueryPreset DSL — the canonical query model (ARCHITECTURE.md §1.3) ──
// Legacy SavedTaskView is the flat predecessor; QueryPreset nests
// filters/view/summary into a single DSL object shared by GUI, CLI,
// and settings storage. No migration path exists for old SavedTaskView
// data.json entries (VAL-CORE-005 / VAL-CROSS-002).

export interface QueryPresetFilters {
  search?: string;
  tags?: string[] | string;
  status?: SavedViewStatus;
  time?: SavedViewTimeFilters;
}

export interface QueryPresetMatrixBucket {
  id: string;
  title: string;
  when: QueryPresetFilters;
}

export interface QueryPresetMatrixAxis {
  id: string;
  title: string;
  buckets: QueryPresetMatrixBucket[];
}

export interface QueryPresetMatrixConfig {
  x: QueryPresetMatrixAxis;
  y: QueryPresetMatrixAxis;
  unmatched: "show" | "hide";
  multiMatch: "first" | "duplicate";
  showEmptyBuckets: boolean;
}

// ARCHITECTURE.md §1.3: QuerySection — a named filter group for list views.
// Each section applies its own `when` filter to the effective task set and
// may override sorting and limit independently.
export interface QuerySection {
  id: string;
  title: string;
  when: QueryPresetFilters;
  orderBy?: string[];
  limit?: number;
  emptyText?: string;
}

// ARCHITECTURE.md §1.3: QueryTray — a separate query area for week/month
// views (e.g. unscheduled tray). The tray's data source is an independent
// filter applied to the effective task set; it does not alter the main
// date area collection.
export interface QueryTray {
  enabled: boolean;
  title: string;
  filters: QueryPresetFilters;
  orderBy?: string[];
}

export interface QueryPresetViewConfig {
  type: QueryViewType;
  preset?: string;
  orderBy?: string[];
  sections?: QuerySection[];
  tray?: QueryTray;
  matrix?: QueryPresetMatrixConfig;
}

export interface QueryPresetSummaryMetric {
  type: "count" | "sum" | "ratio" | "top_n" | "group_by";
  field?: string;
  numerator?: string;
  denominator?: string;
  by?: string;
  limit?: number;
  format?: string;
}

export interface QueryPreset {
  id: string;
  name: string;
  builtin: boolean;
  hidden: boolean;
  filters: QueryPresetFilters;
  view: QueryPresetViewConfig;
  summary: QueryPresetSummaryMetric[];
}

export type QueryPresetSection = "filters" | "view" | "summary";

export interface QueryPresetValidationError {
  section: QueryPresetSection;
  code: string;
  message: string;
}

export interface QueryPresetValidationResult {
  valid: boolean;
  errors: QueryPresetValidationError[];
}

export const DEFAULT_SETTINGS: TaskCenterSettings = {
  queryPresets: [],
  defaultSavedViewId: null,
  defaultView: "week",
  openOnStartup: false,
  weekStartsOn: 1,
  stampCreated: true,
  lastTab: null,
  lastSavedViewId: null,
  mobileLongPressMs: 500,
  mobileSwipeEnabled: true,
  mobileForceLayout: false,
};

export const VIEW_TYPE_TASK_CENTER = "task-center-board";
