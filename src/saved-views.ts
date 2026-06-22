import type {
  QueryPreset,
  QueryPresetFilters,
  QueryPresetMatrixBucket,
  QueryPresetMatrixConfig,
  QueryPresetMatrixAxis,
  QueryPresetSummaryMetric,
  QueryPresetValidationError,
  QueryPresetValidationResult,
  QueryPresetViewConfig,
  QuerySection,
  QueryTray,
  QueryViewType,
  SavedViewConfig,
  SavedViewStatus,
  SavedViewSummaryMetric,
  SavedViewTimeFilters,
  TaskStatus,
} from "./types";
import { BUILTIN_VIEW_DATA } from "./builtin-views/index";

const KNOWN_STATUS_VALUES: TaskStatus[] = ["todo", "done", "dropped", "in_progress", "cancelled", "custom"];
const BUILTIN_QUERY_TABS = ["today", "week", "month", "todo", "unscheduled", "completed", "dropped"] as const;
type BuiltinQueryTab = typeof BUILTIN_QUERY_TABS[number];

export const BUILTIN_SAVED_VIEW_IDS: Record<BuiltinQueryTab, string> = {
  today: "preset-today",
  week: "preset-week",
  month: "preset-month",
  todo: "preset-todo",
  unscheduled: "preset-unscheduled",
  completed: "preset-completed",
  dropped: "preset-dropped",
};

const DEFAULT_BUILTIN_LABELS: Record<BuiltinQueryTab, string> = {
  today: "Today",
  week: "Week",
  month: "Month",
  todo: "TODO",
  unscheduled: "Unscheduled",
  completed: "Completed",
  dropped: "Dropped",
};

export interface SavedViewFilters {
  search: string;
  tag: string;
  time: SavedViewTimeFilters;
  status: SavedViewStatus;
  view?: SavedViewConfig;
  summary?: SavedViewSummaryMetric[];
}

export interface AppliedSavedViewFilters extends SavedViewFilters {
  savedViewId: string | null;
}

export function builtinSavedViewId(tab: BuiltinQueryTab): string {
  return BUILTIN_SAVED_VIEW_IDS[tab];
}

export function builtinSavedViewIdForLegacyTab(tab: string | null | undefined): string | null {
  if (!tab || !(tab in BUILTIN_SAVED_VIEW_IDS)) return null;
  return BUILTIN_SAVED_VIEW_IDS[tab as BuiltinQueryTab];
}

export function isBuiltinSavedViewId(id: string): boolean {
  return Object.values(BUILTIN_SAVED_VIEW_IDS).includes(id);
}

export function builtinSavedViewKind(id: string): BuiltinQueryTab | null {
  return BUILTIN_QUERY_TABS.find((tab) => BUILTIN_SAVED_VIEW_IDS[tab] === id) ?? null;
}

export function normalizeSavedViewStatus(status: unknown): "all" | TaskStatus[] {
  if (!status || status === "all") return "all";
  const raw: unknown[] = Array.isArray(status) ? status : [status];
  const seen = new Set<TaskStatus>();
  const out: TaskStatus[] = [];
  for (const value of raw) {
    if (!isKnownTaskStatus(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.length > 0 ? out : "all";
}

export function createSavedViewId(): string {
  return defaultSavedViewId();
}

function normalizeQueryViewType(type: string | null | undefined): QueryViewType {
  return type === "week" || type === "month" || type === "matrix" ? type : "list";
}

function normalizeTimeFilters(time: unknown): SavedViewTimeFilters {
  const raw = isRecord(time) ? time : {};
  const out: SavedViewTimeFilters = {};
  for (const key of ["scheduled", "deadline", "completed", "created"] as const) {
    const value = raw[key];
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

function isKnownTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (KNOWN_STATUS_VALUES as readonly string[]).includes(value);
}

function defaultSavedViewId(): string {
  return `sv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function seededBuiltinQueryPreset(tab: BuiltinQueryTab, name: string): QueryPreset {
  const data = BUILTIN_VIEW_DATA[tab] ?? BUILTIN_VIEW_DATA.unscheduled;
  return normalizeQueryPreset({
    id: BUILTIN_SAVED_VIEW_IDS[tab] ?? BUILTIN_SAVED_VIEW_IDS.unscheduled,
    name,
    builtin: true,
    hidden: false,
    ...data,
  });
}

function normalizeDslTags(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const tag = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
    const normalized = tag.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(tag);
  }
  return out;
}

function parseDslRoot(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`DSL 当前只支持 JSON，解析失败：${detail}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("DSL 根节点必须是对象。");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function booleanOrFallback(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

// ── QueryPreset DSL — canonical model (VAL-CORE-005, VAL-CORE-006, VAL-CROSS-002) ──

/**
 * Normalize a QueryPreset: ensure required fields, trim strings,
 * normalize status/tags/time, coerce view type, deduplicate summary.
 */
export function normalizeQueryPreset(raw: QueryPreset): QueryPreset {
  const filters = normalizeQueryPresetFilters(raw.filters);
  const view = normalizeQueryPresetView(raw.view);
  const summary = normalizeQueryPresetSummary(raw.summary);
  return {
    id: (typeof raw.id === "string" ? raw.id.trim() : "") || defaultSavedViewId(),
    name: (typeof raw.name === "string" ? raw.name.trim() : "") || "Query",
    builtin: !!raw.builtin,
    hidden: !!raw.hidden,
    filters,
    view,
    summary,
  };
}

function normalizeQueryPresetFilters(raw: unknown): QueryPresetFilters {
  const filters = isRecord(raw) ? raw : {};
  const search = typeof filters.search === "string" ? filters.search.trim() : "";
  const tags = normalizeDslTags(filters.tags);
  const status = normalizeSavedViewStatus(filters.status);
  const time = normalizeTimeFilters(filters.time);
  const out: QueryPresetFilters = {};
  if (search) out.search = search;
  if (tags.length > 0) out.tags = tags;
  out.status = status;
  if (Object.keys(time).length > 0) out.time = time;
  return out;
}

function normalizeQueryPresetView(raw: unknown): QueryPresetViewConfig {
  const cfg = isRecord(raw) ? raw : {};
  const type = normalizeQueryViewType(typeof cfg.type === "string" ? cfg.type : undefined);
  const preset = typeof cfg.preset === "string" ? cfg.preset.trim() : undefined;
  const orderBy = Array.isArray(cfg.orderBy)
    ? cfg.orderBy.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean)
    : undefined;
  const matrix = isRecord(cfg.matrix) ? normalizeMatrixConfig(cfg.matrix) : undefined;
  const sections = Array.isArray(cfg.sections)
    ? cfg.sections.map(normalizeQuerySection).filter((s): s is QuerySection => s !== null)
    : undefined;
  const tray = isRecord(cfg.tray) ? normalizeQueryTray(cfg.tray) : undefined;
  const out: QueryPresetViewConfig = { type };
  if (preset) out.preset = preset;
  if (orderBy && orderBy.length > 0) out.orderBy = orderBy;
  if (sections && sections.length > 0) out.sections = sections;
  if (tray) out.tray = tray;
  if (matrix) out.matrix = matrix;
  return out;
}

function normalizeQuerySection(raw: unknown): QuerySection | null {
  const cfg = isRecord(raw) ? raw : {};
  const id = typeof cfg.id === "string" ? cfg.id.trim() : "";
  if (!id) return null;
  const title = typeof cfg.title === "string" ? cfg.title.trim() : id;
  const when: QueryPresetFilters = isRecord(cfg.when) ? normalizeQueryPresetFilters(cfg.when) : {};
  const orderBy: string[] | undefined = Array.isArray(cfg.orderBy)
    ? cfg.orderBy.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean)
    : undefined;
  const limit = typeof cfg.limit === "number" && cfg.limit > 0 ? cfg.limit : undefined;
  const emptyText = typeof cfg.emptyText === "string" ? cfg.emptyText.trim() : undefined;
  const out: QuerySection = { id, title, when };
  if (orderBy && orderBy.length > 0) out.orderBy = orderBy;
  if (limit !== undefined) out.limit = limit;
  if (emptyText) out.emptyText = emptyText;
  return out;
}

function normalizeQueryTray(raw: unknown): QueryTray | undefined {
  const cfg = isRecord(raw) ? raw : {};
  const enabled = typeof cfg.enabled === "boolean" ? cfg.enabled : false;
  if (!enabled) return undefined;
  const title = typeof cfg.title === "string" ? cfg.title.trim() : "Tray";
  const filters: QueryPresetFilters = isRecord(cfg.filters) ? normalizeQueryPresetFilters(cfg.filters) : {};
  const orderBy: string[] | undefined = Array.isArray(cfg.orderBy)
    ? cfg.orderBy.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean)
    : undefined;
  const out: QueryTray = { enabled, title, filters };
  if (orderBy && orderBy.length > 0) out.orderBy = orderBy;
  return out;
}

function normalizeMatrixConfig(raw: Record<string, unknown>): QueryPresetMatrixConfig | undefined {
  const x = isRecord(raw.x) ? normalizeMatrixAxis(raw.x) : undefined;
  const y = isRecord(raw.y) ? normalizeMatrixAxis(raw.y) : undefined;
  if (!x || !y) return undefined;
  const unmatched = raw.unmatched === "hide" ? "hide" : "show";
  const multiMatch = raw.multiMatch === "duplicate" ? "duplicate" : "first";
  const showEmptyBuckets = typeof raw.showEmptyBuckets === "boolean" ? raw.showEmptyBuckets : true;
  return { x, y, unmatched, multiMatch, showEmptyBuckets };
}

function normalizeMatrixAxis(raw: Record<string, unknown>): QueryPresetMatrixAxis | undefined {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!id) return undefined;
  const buckets: QueryPresetMatrixBucket[] = Array.isArray(raw.buckets)
    ? raw.buckets.map((b: unknown) => normalizeMatrixBucket(isRecord(b) ? b : {})).filter((b): b is QueryPresetMatrixBucket => b !== null)
    : [];
  return { id, title: title || id, buckets };
}

function normalizeMatrixBucket(raw: Record<string, unknown>): QueryPresetMatrixBucket | null {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const when: QueryPresetFilters = isRecord(raw.when) ? normalizeQueryPresetFilters(raw.when) : {};
  return { id, title: title || id, when };
}

function normalizeQueryPresetSummary(
  summary: QueryPreset["summary"] | null | undefined,
): QueryPreset["summary"] {
  if (!Array.isArray(summary)) return [];
  const out: QueryPreset["summary"] = [];
  for (const metric of summary) {
    if (!metric || typeof metric.type !== "string") continue;
    const normalized: QueryPreset["summary"][number] = { type: metric.type };
    if (metric.field?.trim()) normalized.field = metric.field.trim();
    if (metric.numerator?.trim()) normalized.numerator = metric.numerator.trim();
    if (metric.denominator?.trim()) normalized.denominator = metric.denominator.trim();
    if (metric.by?.trim()) normalized.by = metric.by.trim();
    if (typeof metric.limit === "number" && Number.isFinite(metric.limit)) normalized.limit = metric.limit;
    if (metric.format?.trim()) normalized.format = metric.format.trim();
    out.push(normalized);
  }
  return out;
}

/**
 * Validate a QueryPreset and return section-specific errors.
 * VAL-CORE-006: Errors point to `filters`, `view`, or `summary`.
 */
export function validateQueryPreset(raw: unknown): QueryPresetValidationResult {
  const errors: QueryPresetValidationError[] = [];

  if (!isRecord(raw)) {
    errors.push({ section: "filters", code: "not_object", message: "QueryPreset 根节点必须是对象。" });
    return { valid: false, errors };
  }

  // Name
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    errors.push({ section: "filters", code: "missing_name", message: "QueryPreset 缺少 name。" });
  }

  // Filters section
  const filters = raw.filters;
  if (filters !== undefined && !isRecord(filters)) {
    errors.push({ section: "filters", code: "invalid_filters", message: "filters 必须是对象。" });
  } else if (isRecord(filters)) {
    // Validate status
    if (filters.status !== undefined) {
      const rawStatus = filters.status;
      if (rawStatus !== "all" && !Array.isArray(rawStatus) && typeof rawStatus !== "string") {
        errors.push({
          section: "filters",
          code: "invalid_status",
          message: "status 值无效。允许: \"all\", \"todo\", \"done\", \"dropped\", 或其数组。",
        });
      } else if (typeof rawStatus === "string" && rawStatus !== "all") {
        // Single string status — validate it's a known value
        if (!KNOWN_STATUS_VALUES.includes(rawStatus as TaskStatus)) {
          errors.push({
            section: "filters",
            code: "invalid_status",
            message: `status 值 "${rawStatus}" 无效。允许: todo, done, dropped。`,
          });
        }
      } else if (Array.isArray(rawStatus)) {
        for (const s of rawStatus) {
          if (typeof s !== "string" || !KNOWN_STATUS_VALUES.includes(s as TaskStatus)) {
            errors.push({
              section: "filters",
              code: "invalid_status",
              message: `status 数组中包含无效值 "${String(s)}"。允许: todo, done, dropped。`,
            });
            break;
          }
        }
      }
    }
    // Validate tags
    if (filters.tags !== undefined) {
      if (!Array.isArray(filters.tags) && typeof filters.tags !== "string") {
        errors.push({
          section: "filters",
          code: "invalid_tags",
          message: "tags 必须是字符串或字符串数组。",
        });
      }
    }
    // Validate time
    if (filters.time !== undefined && !isRecord(filters.time)) {
      errors.push({
        section: "filters",
        code: "invalid_time",
        message: "time 必须是对象。",
      });
    }
    // Validate search
    if (filters.search !== undefined && typeof filters.search !== "string") {
      errors.push({
        section: "filters",
        code: "invalid_search",
        message: "search 必须是字符串。",
      });
    }
  }

  // View section
  const view = raw.view;
  if (view !== undefined && !isRecord(view)) {
    errors.push({ section: "view", code: "invalid_view", message: "view 必须是对象。" });
  } else if (isRecord(view)) {
    const viewType = view.type;
    if (viewType !== undefined && typeof viewType !== "string") {
      errors.push({
        section: "view",
        code: "invalid_view_type",
        message: 'view.type 必须是 "list" | "week" | "month" | "matrix"。',
      });
    } else if (typeof viewType === "string" && !["list", "week", "month", "matrix"].includes(viewType)) {
      errors.push({
        section: "view",
        code: "unknown_view_type",
        message: `未知 view.type "${viewType}"，允许: list, week, month, matrix。`,
      });
    }
    // Validate orderBy
    if (view.orderBy !== undefined) {
      if (!Array.isArray(view.orderBy)) {
        errors.push({
          section: "view",
          code: "invalid_order_by",
          message: "view.orderBy 必须是字符串数组。",
        });
      } else {
        for (let index = 0; index < view.orderBy.length; index++) {
          if (typeof view.orderBy[index] !== "string") {
            errors.push({
              section: "view",
              code: "invalid_order_by_item",
              message: `view.orderBy[${index}] 必须是字符串。`,
            });
            break;
          }
        }
      }
    }
    // Validate preset
    if (view.preset !== undefined && typeof view.preset !== "string") {
      errors.push({
        section: "view",
        code: "invalid_preset",
        message: "view.preset 必须是字符串。",
      });
    }
  }

  // Summary section
  const summary = raw.summary;
  if (summary !== undefined && !Array.isArray(summary)) {
    errors.push({
      section: "summary",
      code: "invalid_summary",
      message: "summary 必须是数组。",
    });
  } else if (Array.isArray(summary)) {
    for (let index = 0; index < summary.length; index++) {
      const metric: unknown = summary[index];
      if (!isRecord(metric)) {
        errors.push({
          section: "summary",
          code: "invalid_metric",
          message: `summary[${index}] 必须是对象。`,
        });
        continue;
      }
      const metricType = metric.type;
      if (typeof metricType !== "string" || !["count", "sum", "ratio", "top_n", "group_by"].includes(metricType)) {
        errors.push({
          section: "summary",
          code: "invalid_metric_type",
          message: `summary[${index}].type 无效 "${String(metricType)}"，允许: count, sum, ratio, top_n, group_by。`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Detect whether an object is a legacy SavedTaskView (flat shape with top-level
 * `search` / `tag` / `time` / `status` rather than nested `filters`).
 * VAL-CORE-005 / VAL-CROSS-002: these are rejected during settings load.
 */
export function isLegacySavedTaskView(obj: unknown): boolean {
  if (!isRecord(obj)) return false;
  // A QueryPreset has `filters` as a nested object. Legacy SavedTaskView
  // has flat `search` / `tag` / `time` / `status` at top level.
  if (isRecord(obj.filters)) return false; // has nested filters → QueryPreset
  const hasFlatLegacyField =
    "search" in obj
    || "tag" in obj
    || "time" in obj
    || "status" in obj;
  // It might also have `id` and `name` (both models share these).
  return hasFlatLegacyField;
}

/**
 * Serialize a QueryPreset to JSON DSL string.
 */
export function stringifyQueryPreset(preset: QueryPreset): string {
  return JSON.stringify(normalizeQueryPreset(preset), null, 2);
}

/**
 * Parse a JSON DSL string into a normalized QueryPreset.
 */
export function parseQueryDsl(
  text: string,
  existing: Partial<Pick<QueryPreset, "id" | "name" | "builtin" | "hidden">> = {},
): QueryPreset {
  const raw = parseDslRoot(text);
  const base = "query" in raw && isRecord(raw.query) ? raw.query : raw;

  // VAL-CORE-005 / VAL-CROSS-002: reject legacy SavedTaskView flat DSL
  // (top-level search/tag/time/status without nested filters).
  if (isLegacySavedTaskView(base)) {
    throw new Error(
      "无效 Query DSL：检测到旧版 SavedTaskView 扁平格式（顶层 search/tag/time/status）。请改用嵌套 filters 对象。",
    );
  }

  const name = stringOrFallback(base.name, existing.name ?? "");
  if (!name.trim()) {
    throw new Error("DSL 缺少 name。");
  }

  // VAL-CORE-006: validate raw input BEFORE normalization so invalid
  // values (e.g. unknown view type, bad tags, bad summary) are caught
  // rather than silently coerced to defaults.
  const validation = validateQueryPreset(base);
  if (!validation.valid) {
    const details = validation.errors
      .map((e) => `[${e.section}] ${e.code}: ${e.message}`)
      .join("；");
    throw new Error(`Query DSL 校验失败：${details}`);
  }

  return normalizeQueryPreset({
    id: stringOrFallback(base.id, existing.id ?? defaultSavedViewId()),
    name,
    builtin: booleanOrFallback(base.builtin, existing.builtin ?? false),
    hidden: booleanOrFallback(base.hidden, existing.hidden ?? false),
    filters: isRecord(base.filters) ? base.filters : {},
    view: isRecord(base.view) ? base.view : { type: "list" },
    summary: Array.isArray(base.summary) ? base.summary : [],
  } as unknown as QueryPreset);
}

/**
 * Builtin QueryPreset factory — produces the 7 default presets
 * matching VAL-GUI-003: 今日, 本周, 本月, TODO, 未排期, 已完成, 已放弃.
 */
export function createBuiltinQueryPresets(
  labels: Partial<Record<BuiltinQueryTab, string>> = {},
): QueryPreset[] {
  return BUILTIN_QUERY_TABS.map((tab) =>
    seededBuiltinQueryPreset(tab, labels[tab] ?? DEFAULT_BUILTIN_LABELS[tab])
  );
}

// ── QueryPreset-native runtime helpers (VAL-CORE-005: no fromQueryPreset bridge) ──

/**
 * Ensure the 7 builtin QueryPreset tabs are present, preserving user
 * modifications. Custom presets are appended after builtins.
 * This is the QueryPreset-native replacement for `ensureBuiltinSavedViews`
 * — it does NOT call `fromQueryPreset`.
 */
export function ensureBuiltinQueryPresets(
  presets: readonly QueryPreset[],
  labels: Partial<Record<BuiltinQueryTab, string>> = {},
): QueryPreset[] {
  const existing = new Map(presets.map((p) => [p.id, normalizeQueryPreset(p)]));
  const out: QueryPreset[] = [];
  for (const tab of BUILTIN_QUERY_TABS) {
    const seeded = seededBuiltinQueryPreset(tab, labels[tab] ?? DEFAULT_BUILTIN_LABELS[tab]);
    const current = existing.get(seeded.id);
    out.push(normalizeQueryPreset(current ? { ...current, builtin: true } : seeded));
    existing.delete(seeded.id);
  }
  for (const preset of presets) {
    if (isBuiltinSavedViewId(preset.id)) continue;
    out.push(normalizeQueryPreset(preset));
  }
  return out;
}

export function restoreBuiltinQueryPresetById(
  presets: readonly QueryPreset[],
  id: string,
  labels: Partial<Record<BuiltinQueryTab, string>> = {},
): QueryPreset[] {
  const kind = builtinSavedViewKind(id);
  if (!kind) return [...presets];
  const seeded = seededBuiltinQueryPreset(kind, labels[kind] ?? DEFAULT_BUILTIN_LABELS[kind]);
  const index = presets.findIndex((p) => p.id === id);
  if (index === -1) {
    return ensureBuiltinQueryPresets([...presets, seeded], labels);
  }
  return presets.map((p, i) => (i === index ? seeded : normalizeQueryPreset(p)));
}

export function restoreBuiltinQueryPresets(
  presets: readonly QueryPreset[],
  labels: Partial<Record<BuiltinQueryTab, string>> = {},
): QueryPreset[] {
  const customPresets = presets.filter((p) => !isBuiltinSavedViewId(p.id));
  return ensureBuiltinQueryPresets(customPresets, labels);
}

export function createQueryPreset(
  name: string,
  filters: {
    search?: string;
    tags?: string[];
    time?: SavedViewTimeFilters;
    status?: SavedViewStatus;
    view?: QueryPresetViewConfig;
    summary?: QueryPresetSummaryMetric[];
  },
  makeId: () => string = defaultSavedViewId,
): QueryPreset {
  return normalizeQueryPreset({
    id: makeId(),
    name: name.trim(),
    builtin: false,
    hidden: false,
    filters: {
      ...(filters.search?.trim() ? { search: filters.search.trim() } : {}),
      ...(filters.tags && filters.tags.length > 0 ? { tags: filters.tags } : {}),
      status: filters.status ?? "all",
      ...(filters.time && Object.keys(filters.time).length > 0 ? { time: normalizeTimeFilters(filters.time) } : {}),
    },
    view: filters.view ?? { type: "list" },
    summary: filters.summary ?? [],
  });
}

export function upsertQueryPreset(presets: readonly QueryPreset[], preset: QueryPreset): QueryPreset[] {
  const normalized = normalizeQueryPreset(preset);
  const existingIndex = presets.findIndex((p) => p.id === normalized.id);
  if (existingIndex === -1) return [...presets, normalized];
  return presets.map((p) => (p.id === normalized.id ? normalized : p));
}

export function updateQueryPresetById(presets: readonly QueryPreset[], preset: QueryPreset): QueryPreset[] {
  const normalized = normalizeQueryPreset(preset);
  return presets.map((p) => (p.id === normalized.id ? normalized : p));
}

/** Extract flat filter state from a QueryPreset for the view state. */
export function applyQueryPresetFilters(preset: QueryPreset): AppliedSavedViewFilters {
  const normalized = normalizeQueryPreset(preset);
  const tags = Array.isArray(normalized.filters.tags)
    ? normalized.filters.tags.join(",")
    : typeof normalized.filters.tags === "string"
      ? normalized.filters.tags
      : "";
  return {
    savedViewId: normalized.id,
    search: normalized.filters.search ?? "",
    tag: tags,
    time: normalized.filters.time ?? {},
    status: normalized.filters.status ?? "all",
    view: normalized.view,
    summary: normalized.summary,
  };
}

export function clearQueryPresetFilters(): AppliedSavedViewFilters {
  return {
    savedViewId: null,
    search: "",
    tag: "",
    time: {},
    status: "all",
    view: { type: "list" },
    summary: [],
  };
}

export function hasQueryPresetFilters(preset: QueryPreset): boolean {
  const normalized = normalizeQueryPreset(preset);
  return !!(
    (normalized.filters.search?.trim())
    || (Array.isArray(normalized.filters.tags) && normalized.filters.tags.length > 0)
    || (typeof normalized.filters.tags === "string" && normalized.filters.tags.trim())
    || Object.values(normalized.filters.time ?? {}).some(Boolean)
    || normalizeSavedViewStatus(normalized.filters.status) !== "all"
  );
}

export function suggestQueryPresetName(
  filters: { tags?: string[] | string; status?: SavedViewStatus },
  fallback: string,
): string {
  if (Array.isArray(filters.tags) && filters.tags.length > 0) {
    return filters.tags[0].replace(/^#/, "");
  }
  if (typeof filters.tags === "string" && filters.tags.trim()) {
    return filters.tags.trim().replace(/^#/, "");
  }
  const status = normalizeSavedViewStatus(filters.status);
  if (status !== "all") return status.join(",");
  return fallback;
}

export function visibleQueryPresets(presets: readonly QueryPreset[]): QueryPreset[] {
  return presets.map((p) => normalizeQueryPreset(p)).filter((p) => !p.hidden);
}

export function renameQueryPresetById(
  presets: readonly QueryPreset[],
  id: string,
  name: string,
): QueryPreset[] {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Query Tab 名称不能为空。");
  return presets.map((p) => (p.id === id ? normalizeQueryPreset({ ...p, name: trimmed }) : p));
}

export function deleteQueryPresetById(presets: readonly QueryPreset[], id: string): QueryPreset[] {
  return presets.filter((p) => p.id !== id);
}

export function setQueryPresetHiddenById(
  presets: readonly QueryPreset[],
  id: string,
  hidden: boolean,
): QueryPreset[] {
  return presets.map((p) => (p.id === id ? normalizeQueryPreset({ ...p, hidden }) : p));
}

export function duplicateQueryPreset(
  presets: readonly QueryPreset[],
  sourceId: string,
  name: string,
  makeId: () => string = defaultSavedViewId,
): QueryPreset {
  const source = presets.find((p) => p.id === sourceId);
  if (!source) throw new Error(`Query Tab 不存在：${sourceId}`);
  const normalized = normalizeQueryPreset(source);
  return normalizeQueryPreset({
    ...normalized,
    id: makeId(),
    name: name.trim(),
    builtin: false,
    hidden: false,
  });
}

export function moveQueryPresetById(
  presets: readonly QueryPreset[],
  id: string,
  direction: -1 | 1,
): QueryPreset[] {
  const index = presets.findIndex((p) => p.id === id);
  if (index === -1) return [...presets];
  const target = index + direction;
  if (target < 0 || target >= presets.length) return [...presets];
  const out = [...presets];
  const [item] = out.splice(index, 1);
  out.splice(target, 0, item);
  return out;
}

/**
 * 将指定 id 的 QueryPreset 移动到目标索引位置。
 * 拖动排序时需要将 tab 移到任意目标位置，而非仅 ±1 步。
 */
export function reorderQueryPresetById(
  presets: readonly QueryPreset[],
  id: string,
  targetIndex: number,
): QueryPreset[] {
  const index = presets.findIndex((p) => p.id === id);
  if (index === -1) return [...presets];
  if (index === targetIndex) return [...presets];
  const out = [...presets];
  const [item] = out.splice(index, 1);
  // targetIndex is the desired position in the original array;
  // after splice, indices shift so we clamp to valid range.
  const insertAt = Math.max(0, Math.min(targetIndex, out.length));
  out.splice(insertAt, 0, item);
  return out;
}

export function sameQueryPresetContent(a: QueryPreset, b: QueryPreset): boolean {
  const left = normalizeQueryPreset(a);
  const right = normalizeQueryPreset(b);
  return JSON.stringify({
    builtin: left.builtin,
    hidden: left.hidden,
    filters: left.filters,
    view: left.view,
    summary: left.summary,
  }) === JSON.stringify({
    builtin: right.builtin,
    hidden: right.hidden,
    filters: right.filters,
    view: right.view,
    summary: right.summary,
  });
}

/**
 * Helper: get comma-separated tag string from QueryPreset filters.
 */
export function queryPresetTagString(preset: QueryPreset): string {
  const tags = normalizeQueryPreset(preset).filters.tags;
  if (Array.isArray(tags)) return tags.join(",");
  if (typeof tags === "string") return tags;
  return "";
}

/**
 * Helper: get normalized tags array from QueryPreset filters.
 */
export function queryPresetTagsArray(preset: QueryPreset): string[] {
  const tags = normalizeQueryPreset(preset).filters.tags;
  if (Array.isArray(tags)) return tags;
  if (typeof tags === "string") return parseSavedViewTags(tags);
  return [];
}

// ── VAL-GUI-004: delete undo plan / execute ──

/**
 * Snapshot-and-index plan used by deleteSavedViewWithConfirm (GUI) and
 * unit-testable without DOM.  `view` is normally a normalized copy from
 * visibleQueryTabs().
 */
export interface QueryPresetDeleteUndoPlan {
  snapshot: QueryPreset;
  originalIndex: number;
}

export function computeQueryPresetDeleteUndoPlan(
  presets: readonly QueryPreset[],
  view: QueryPreset,
): QueryPresetDeleteUndoPlan {
  return {
    snapshot: normalizeQueryPreset(view),
    originalIndex: presets.findIndex((p) => p.id === view.id),
  };
}

/**
 * Re-inserts the snapshot at `plan.originalIndex` (clamped to the current
 * array length) so undo restores the tab to its original position even when
 * other tabs were added/removed between delete and undo.
 */
export function executeQueryPresetDeleteUndo(
  presets: readonly QueryPreset[],
  plan: QueryPresetDeleteUndoPlan,
): QueryPreset[] {
  const result = [...presets];
  const insertIdx = Math.min(plan.originalIndex, result.length);
  result.splice(insertIdx, 0, plan.snapshot);
  return result;
}

// ── VAL-GUI-004: production-path delete-with-confirm-and-undo ──

/**
 * Injected callbacks for the delete-confirm-undo flow.
 *
 * Production (view.ts): `confirm` opens a Modal; `createUndoNotice` creates
 * a clickable Notice whose undo handler the caller wires to restore state.
 * Tests: inject stub spies to verify confirmation, deletion, and undo
 * without DOM dependencies.
 */
export interface QueryPresetDeleteFlowCallbacks {
  /** Show confirmation prompt. Return `true` to proceed with deletion. */
  confirm: (viewName: string) => Promise<boolean>;
  /**
   * Show undo toast with clickable undo action.
   * Returns a controller so the caller can wire state restoration.
   */
  createUndoNotice: (viewName: string, undoLabel: string) => QueryPresetDeleteUndoNotice;
  /** Show a success notice after undo completes. */
  showRestoredNotice: (viewName: string) => void;
}

/** Controller returned by `createUndoNotice` — caller wires the handler. */
export interface QueryPresetDeleteUndoNotice {
  /** Register the undo handler (called when user clicks undo). */
  onUndoClick: (handler: () => Promise<void>) => void;
  /** Hide the notice (e.g. after undo executes). */
  close: () => void;
}

export interface QueryPresetDeleteFlowResult {
  /** Whether the user confirmed the deletion */
  confirmed: boolean;
  /** The undo plan, or null if not confirmed */
  undoPlan: QueryPresetDeleteUndoPlan | null;
  /** Whether the deleted tab was the default */
  wasDefault: boolean;
  /** Whether the deleted tab was the active tab */
  wasActive: boolean;
  /** The presets array after deletion (same as before if cancelled) */
  presetsAfter: QueryPreset[];
  /** The undo notice controller, or null if not confirmed.
   *  Caller MUST wire `onUndoClick` to restore state. */
  undoNotice: QueryPresetDeleteUndoNotice | null;
}

/**
 * Execute the confirm-delete-notice production flow for a QueryPreset.
 *
 * This is the testable pure-logic counterpart of
 * `TaskCenterView.deleteSavedViewWithConfirm`.  The production view method
 * delegates here and wires the injected callbacks to Modal / Notice.
 *
 * The returned `undoNotice` controller MUST be wired by the caller:
 *
 * ```ts
 * result.undoNotice?.onUndoClick(async () => {
 *   // restore presets, default, active state
 *   result.undoNotice.close();
 * });
 * ```
 *
 * Tests can exercise the exact same confirm / delete / undo–restore logic
 * by passing stub callbacks.
 *
 * @param presets    Current QueryPreset array (settings.queryPresets).
 * @param view       The view to delete (normally a normalized copy from
 *                   visibleQueryTabs()).
 * @param defaultId  Current `defaultSavedViewId` setting.
 * @param activeId   Current active tab id (`state.savedViewId`).
 * @param callbacks  Injected Modal / Notice factories.
 */
export async function executeDeleteQueryPresetFlow(
  presets: QueryPreset[],
  view: QueryPreset,
  defaultId: string | null,
  activeId: string | null,
  callbacks: QueryPresetDeleteFlowCallbacks,
): Promise<QueryPresetDeleteFlowResult> {
  // Step 1 — confirmation (Modal in production)
  const confirmed = await callbacks.confirm(view.name);
  if (!confirmed) {
    return {
      confirmed: false,
      undoPlan: null,
      wasDefault: false,
      wasActive: false,
      presetsAfter: presets,
      undoNotice: null,
    };
  }

  // Step 2 — snapshot state before deletion
  const wasDefault = defaultId === view.id;
  const wasActive = activeId === view.id;
  const undoPlan = computeQueryPresetDeleteUndoPlan(presets, view);

  // Step 3 — delete (pure, no DOM)
  const presetsAfter = deleteQueryPresetById(presets, view.id);

  // Step 4 — show clickable undo notice (Notice in production)
  // The caller MUST wire `undoNotice.onUndoClick` to restore state.
  const undoNotice = callbacks.createUndoNotice(undoPlan.snapshot.name, "撤销");

  return {
    confirmed: true,
    undoPlan,
    wasDefault,
    wasActive,
    presetsAfter,
    undoNotice,
  };
}

// ── Production-path: delete + undo view state computation ──

/**
 * Post-delete state computed from a confirmed deletion flow result.
 * Pure — no DOM, no settings mutation.  The caller (view.ts) applies
 * these values to plugin settings and triggers save/render.
 */
export interface DeleteQueryPresetViewState {
  /** Presets array after deletion (same as result.presetsAfter). */
  presetsAfter: QueryPreset[];
  /** New defaultSavedViewId when the deleted tab was the default. */
  newDefaultId: string | null;
  /** Whether active tab should be switched. */
  shouldSwitchActive: boolean;
  /** The next visible tab to activate, or null. */
  nextActiveView: QueryPreset | null;
}

/**
 * Compute the state that should be applied to plugin settings immediately
 * after a confirmed deletion.  Pure — callers wire side effects.
 *
 * Used by `TaskCenterView.deleteSavedViewWithConfirm` to derive the
 * settings mutation from the flow result + visible tabs.
 */
export function computeDeleteQueryPresetState(params: {
  result: QueryPresetDeleteFlowResult;
  /** Visible (non-hidden) tabs BEFORE deletion. */
  visibleTabs: QueryPreset[];
  /** The view being deleted. */
  view: QueryPreset;
}): DeleteQueryPresetViewState {
  const presetsAfter = params.result.presetsAfter;
  let newDefaultId: string | null = null;
  let shouldSwitchActive = false;
  let nextActiveView: QueryPreset | null = null;

  if (params.result.wasDefault) {
    newDefaultId = params.visibleTabs.find((t) => t.id !== params.view.id)?.id ?? null;
  }
  if (params.result.wasActive) {
    shouldSwitchActive = true;
    nextActiveView = params.visibleTabs.find((t) => t.id !== params.view.id) ?? null;
  }

  return { presetsAfter, newDefaultId, shouldSwitchActive, nextActiveView };
}

/**
 * Post-undo state computed from the undo plan and current presets.
 * Pure — no DOM, no settings mutation.
 */
export interface UndoQueryPresetViewState {
  /** Presets array after re-inserting the snapshot. */
  presetsRestored: QueryPreset[];
  /** Restored defaultSavedViewId, or null. */
  restoredDefaultId: string | null;
  /** Whether the active tab should be restored. */
  shouldRestoreActive: boolean;
  /** The restored QueryPreset to activate, or null. */
  restoredView: QueryPreset | null;
}

/**
 * Compute the state that should be applied to plugin settings when the
 * user clicks the undo button.  Pure — callers wire side effects.
 *
 * Used by the undo handler inside `TaskCenterView.deleteSavedViewWithConfirm`.
 */
export function computeUndoQueryPresetState(params: {
  presets: readonly QueryPreset[];
  undoPlan: QueryPresetDeleteUndoPlan;
  wasDefault: boolean;
  wasActive: boolean;
}): UndoQueryPresetViewState {
  const presetsRestored = executeQueryPresetDeleteUndo(params.presets, params.undoPlan);

  let restoredDefaultId: string | null = null;
  let shouldRestoreActive = false;
  let restoredView: QueryPreset | null = null;

  if (params.wasDefault) {
    restoredDefaultId = params.undoPlan.snapshot.id;
  }
  if (params.wasActive) {
    restoredView = presetsRestored.find((p) => p.id === params.undoPlan.snapshot.id) ?? null;
    shouldRestoreActive = restoredView !== null;
  }

  return { presetsRestored, restoredDefaultId, shouldRestoreActive, restoredView };
}

// ── Query Editor production-path helpers ──

/**
 * Parameters for computing a QueryPreset snapshot that merges tabDrafts
 * into the saved preset identity.
 */
export interface ComputeQueryPresetSnapshotParams {
  /** The saved/existing preset (may be null for new drafts). */
  existing?: QueryPreset | null;
  /** The tabDrafts map (real Map<string, QueryPreset>). */
  tabDrafts: ReadonlyMap<string, QueryPreset>;
  /** Current search filter text. */
  filterSearch: string;
  /** Current tag filter string (comma-separated). */
  filterTags: string;
  /** Current time filters. */
  filterTime: SavedViewTimeFilters;
  /** Current status filter. */
  filterStatus: SavedViewStatus;
  /** Fallback view config when neither draft nor saved provides one. */
  fallbackView: () => QueryPresetViewConfig;
  /** Fallback summary when neither draft nor saved provides one. */
  fallbackSummary: () => QueryPresetSummaryMetric[];
  /** Optional override for the snapshot name. */
  name?: string;
}

/**
 * Pure computation of a QueryPreset snapshot that merges tabDrafts
 * view/summary into the saved preset identity.  This is the testable
 * counterpart of `TaskCenterView.currentQuerySnapshot`.
 *
 * Draft view/summary win over saved view/summary.  Explicit empty draft
 * arrays ([]) win over saved arrays — they are not falsy.  All other
 * fields come from the explicit state parameters plus the saved preset
 * identity (id, name, builtin, hidden).
 */
export function computeQueryPresetSnapshot(params: ComputeQueryPresetSnapshotParams): QueryPreset {
  const {
    existing,
    tabDrafts,
    filterSearch,
    filterTags,
    filterTime,
    filterStatus,
    fallbackView,
    fallbackSummary,
    name,
  } = params;

  const tagArray = filterTags ? filterTags.split(",").filter(Boolean) : undefined;
  const tabDraft = existing ? tabDrafts.get(existing.id) : undefined;

  return normalizeQueryPreset({
    id: existing?.id ?? `draft-list`,
    name: (name ?? existing?.name ?? "").trim(),
    builtin: existing?.builtin ?? false,
    hidden: existing?.hidden ?? false,
    filters: {
      ...(filterSearch ? { search: filterSearch } : {}),
      ...(tagArray && tagArray.length > 0 ? { tags: tagArray } : {}),
      time: filterTime,
      status: filterStatus,
    },
    view: tabDraft?.view ?? existing?.view ?? fallbackView(),
    summary: tabDraft?.summary ?? existing?.summary ?? fallbackSummary(),
  });
}

/**
 * Applies a partial edit to the summary metric at index `i`, returning a
 * new summary array.  Used by the Query Editor visual controls "edit"
 * path (changing field/by/limit etc. on an existing metric).
 */
export function applySummaryMetricEdit(
  summary: readonly QueryPresetSummaryMetric[],
  i: number,
  patch: Partial<QueryPresetSummaryMetric>,
): QueryPresetSummaryMetric[] {
  const next = [...summary];
  if (i >= 0 && i < next.length) {
    next[i] = { ...next[i], ...patch };
  }
  return next;
}

/**
 * Removes the summary metric at index `i`, returning a new summary array.
 * Used by the Query Editor "remove" button path.
 */
export function applySummaryMetricRemove(
  summary: readonly QueryPresetSummaryMetric[],
  i: number,
): QueryPresetSummaryMetric[] {
  return summary.filter((_, idx) => idx !== i);
}

/**
 * Appends a new summary metric to the end of the array, returning a new
 * summary array.  Used by the Query Editor "add" button path.
 */
export function applySummaryMetricAdd(
  summary: readonly QueryPresetSummaryMetric[],
  metric: QueryPresetSummaryMetric,
): QueryPresetSummaryMetric[] {
  return [...summary, metric];
}

// ── Query Editor Summary production-path helpers ──
// These functions encapsulate the handler pattern used by TaskCenterView's
// Query Editor summary visual controls.  They make the production handlers
// testable without requiring a full Obsidian DOM environment.

/**
 * Parameters shared by all Query Editor summary draft handlers.
 * Mirrors the closure environment of the rendering code in view.ts.
 */
export interface QueryEditorSummaryDraftParams {
  /** The tabDrafts Map — shared mutable draft store. */
  tabDrafts: Map<string, QueryPreset>;
  /** The active QueryPreset id (what tab is currently selected). */
  activePresetId: string;
  /** The saved (non-draft) preset for the active tab. */
  savedPreset: QueryPreset | null;
  /** Returns a snapshot merging saved preset identity with draft content + view state. */
  getSnapshot: (existing: QueryPreset | null) => QueryPreset;
}

/**
 * Production-path handler for editing a summary metric in a draft.
 * This is the testable counterpart of the `updateMetricInDraft` closure
 * inside TaskCenterView's Query Editor rendering code.
 *
 * Reads the draft from tabDrafts (via getSnapshot), applies the edit,
 * writes back into tabDrafts, and returns the updated draft.
 */
export function handleQueryEditorSummaryEdit(
  params: QueryEditorSummaryDraftParams,
  metricIndex: number,
  patch: Partial<QueryPresetSummaryMetric>,
): QueryPreset {
  const { tabDrafts, activePresetId, getSnapshot, savedPreset } = params;
  const draft = getSnapshot(savedPreset);
  draft.summary = applySummaryMetricEdit(draft.summary ?? [], metricIndex, patch);
  tabDrafts.set(activePresetId, draft);
  return draft;
}

/**
 * Production-path handler for adding a new summary metric to a draft.
 * This is the testable counterpart of the "add" button click handler
 * inside TaskCenterView's Query Editor rendering code.
 */
export function handleQueryEditorSummaryAdd(
  params: QueryEditorSummaryDraftParams,
  newMetric: QueryPresetSummaryMetric,
): QueryPreset {
  const { tabDrafts, activePresetId, getSnapshot, savedPreset } = params;
  const draft = getSnapshot(savedPreset);
  draft.summary = applySummaryMetricAdd(draft.summary ?? [], newMetric);
  tabDrafts.set(activePresetId, draft);
  return draft;
}

/**
 * Production-path handler for removing a summary metric from a draft.
 * This is the testable counterpart of the "remove" button click handler
 * inside TaskCenterView's Query Editor rendering code.
 */
export function handleQueryEditorSummaryRemove(
  params: QueryEditorSummaryDraftParams,
  metricIndex: number,
): QueryPreset {
  const { tabDrafts, activePresetId, getSnapshot, savedPreset } = params;
  const draft = getSnapshot(savedPreset);
  draft.summary = applySummaryMetricRemove(draft.summary ?? [], metricIndex);
  tabDrafts.set(activePresetId, draft);
  return draft;
}

/**
 * Production-path helper: computes a save-as result from a snapshot +
 * draft state.  This is the testable counterpart of TaskCenterView's
 * `saveCurrentView` method.
 *
 * Returns the snapshot (what currentQuerySnapshot produced) and the
 * normalized preset that would be saved via upsertQueryPreset.
 */
export function computeSaveAsFromSnapshot(params: {
  getSnapshot: (existing: QueryPreset | null) => QueryPreset;
  savedPreset: QueryPreset | null;
  newId: string;
  name: string;
}): { snapshot: QueryPreset; saved: QueryPreset } {
  const { getSnapshot, savedPreset, newId, name } = params;
  const snapshot = getSnapshot(savedPreset);
  const saved = normalizeQueryPreset({
    ...snapshot,
    id: newId,
    name,
    builtin: false,
    hidden: false,
  });
  return { snapshot, saved };
}

/**
 * Production-path helper: computes an update result from a snapshot +
 * draft state.  This is the testable counterpart of TaskCenterView's
 * `updateCurrentSavedView` method.
 *
 * Reads view/summary from the draft (via currentQueryPresetViewConfig /
 * currentSavedViewSummary equivalents) and returns the normalized preset
 * that would be saved via updateQueryPresetById.
 */
export function computeUpdateFromDraftComponents(params: {
  /** The saved preset being updated in-place. */
  existing: QueryPreset;
  /** Draft view config (from currentQueryPresetViewConfig). */
  draftView: QueryPresetViewConfig;
  /** Draft summary (from currentSavedViewSummary). */
  draftSummary: QueryPresetSummaryMetric[];
}): QueryPreset {
  const { existing, draftView, draftSummary } = params;
  return normalizeQueryPreset({
    ...existing,
    view: draftView,
    summary: draftSummary,
  });
}
