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
  SavedTaskView,
  SavedViewConfig,
  SavedViewStatus,
  SavedViewSummaryMetric,
  SavedViewTimeFilters,
  TaskStatus,
} from "./types";

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

export interface QueryPresetDsl {
  id?: string;
  name?: string;
  builtin?: boolean;
  hidden?: boolean;
  filters?: {
    search?: string;
    tags?: string[] | string;
    status?: SavedViewStatus;
    time?: SavedViewTimeFilters;
  };
  view?: SavedViewConfig;
  summary?: SavedViewSummaryMetric[];
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

export function ensureBuiltinSavedViews(
  views: readonly SavedTaskView[],
  labels: Partial<Record<BuiltinQueryTab, string>> = {},
): SavedTaskView[] {
  // Normalize all incoming views, converting QueryPreset shapes to SavedTaskView
  // if needed (loadSettings may receive QueryPreset-shaped data from data.json).
  const asSavedViews: SavedTaskView[] = views.map((v) => {
    if (isRecord(v) && isRecord(v.filters)) {
      return fromQueryPreset(v as unknown as QueryPreset);
    }
    return v;
  });
  const existing = new Map(asSavedViews.map((view) => [view.id, normalizeSavedTaskView(view)]));
  const out: SavedTaskView[] = [];
  for (const tab of BUILTIN_QUERY_TABS) {
    const seeded = seededBuiltinSavedView(tab, labels[tab] ?? DEFAULT_BUILTIN_LABELS[tab]);
    const current = existing.get(seeded.id);
    out.push(normalizeSavedTaskView(current ? { ...current, builtin: true } : seeded));
    existing.delete(seeded.id);
  }
  for (const view of asSavedViews) {
    if (isBuiltinSavedViewId(view.id)) continue;
    out.push(normalizeSavedTaskView(view));
  }
  return out;
}

export function restoreBuiltinSavedViewById(
  views: readonly SavedTaskView[],
  id: string,
  labels: Partial<Record<BuiltinQueryTab, string>> = {},
): SavedTaskView[] {
  const kind = builtinSavedViewKind(id);
  if (!kind) return [...views];
  const seeded = seededBuiltinSavedView(kind, labels[kind] ?? DEFAULT_BUILTIN_LABELS[kind]);
  const index = views.findIndex((view) => view.id === id);
  if (index === -1) {
    return ensureBuiltinSavedViews([...views, seeded], labels);
  }
  return views.map((view, currentIndex) => (currentIndex === index ? seeded : normalizeSavedTaskView(view)));
}

export function restoreBuiltinSavedViews(
  views: readonly SavedTaskView[],
  labels: Partial<Record<BuiltinQueryTab, string>> = {},
): SavedTaskView[] {
  const customViews = views.filter((view) => !isBuiltinSavedViewId(view.id));
  return ensureBuiltinSavedViews(customViews, labels);
}

export function createSavedView(
  name: string,
  filters: SavedViewFilters,
  makeId: () => string = defaultSavedViewId,
): SavedTaskView {
  return normalizeSavedTaskView({
    id: makeId(),
    name: name.trim(),
    search: filters.search.trim(),
    tag: filters.tag.trim(),
    time: normalizeTimeFilters(filters.time),
    status: normalizeSavedViewStatus(filters.status),
    view: normalizeSavedViewConfig(filters.view),
    summary: normalizeSavedViewSummary(filters.summary),
  });
}

export function upsertSavedView(views: readonly SavedTaskView[], view: SavedTaskView): SavedTaskView[] {
  const normalized = normalizeSavedTaskView(view);
  const existingIndex = views.findIndex((existing) => existing.id === normalized.id);
  if (existingIndex === -1) return [...views, normalized];
  return views.map((existing) => (existing.id === normalized.id ? normalized : existing));
}

export function updateSavedViewById(views: readonly SavedTaskView[], view: SavedTaskView): SavedTaskView[] {
  const normalized = normalizeSavedTaskView(view);
  return views.map((existing) => (existing.id === normalized.id ? normalized : existing));
}

export function applySavedViewFilters(view: SavedTaskView): AppliedSavedViewFilters {
  const normalized = normalizeSavedTaskView(view);
  return {
    savedViewId: normalized.id,
    search: normalized.search,
    tag: normalized.tag,
    time: normalizeTimeFilters(normalized.time),
    status: normalizeSavedViewStatus(normalized.status),
    view: normalizeSavedViewConfig(normalized.view),
    summary: normalizeSavedViewSummary(normalized.summary),
  };
}

export function clearSavedViewFilters(): AppliedSavedViewFilters {
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

export function hasSavedViewFilters(filters: SavedViewFilters): boolean {
  return !!(
    filters.search.trim()
    || filters.tag.trim()
    || Object.values(normalizeTimeFilters(filters.time)).some(Boolean)
    || normalizeSavedViewStatus(filters.status) !== "all"
  );
}

export function suggestSavedViewName(filters: Pick<SavedViewFilters, "tag" | "status">, fallback: string): string {
  if (filters.tag.trim()) return filters.tag.trim().replace(/^#/, "");
  const status = normalizeSavedViewStatus(filters.status);
  if (status !== "all") return status.join(",");
  return fallback;
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

export function normalizeSavedTaskView(view: SavedTaskView): SavedTaskView {
  return {
    ...view,
    builtin: !!view.builtin,
    hidden: !!view.hidden,
    name: view.name.trim(),
    search: view.search.trim(),
    tag: view.tag.trim(),
    time: normalizeTimeFilters(view.time),
    status: normalizeSavedViewStatus(view.status),
    view: normalizeSavedViewConfig(view.view),
    summary: normalizeSavedViewSummary(view.summary),
  };
}

export function savedViewToDsl(view: SavedTaskView): QueryPresetDsl {
  const normalized = normalizeSavedTaskView(view);
  const tags = parseSavedViewTags(normalized.tag);
  return {
    id: normalized.id,
    name: normalized.name,
    ...(normalized.builtin ? { builtin: true } : {}),
    ...(normalized.hidden ? { hidden: true } : {}),
    filters: {
      ...(normalized.search ? { search: normalized.search } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      status: normalized.status,
      ...(Object.keys(normalized.time).length > 0 ? { time: normalized.time } : {}),
    },
    view: normalized.view,
    summary: normalized.summary ?? [],
  };
}

export function stringifySavedViewDsl(view: SavedTaskView): string {
  return JSON.stringify(savedViewToDsl(view), null, 2);
}

export function parseSavedViewDsl(
  text: string,
  existing: Partial<Pick<SavedTaskView, "id" | "name" | "builtin" | "hidden">> = {},
): SavedTaskView {
  const raw = parseDslRoot(text);
  const base = "query" in raw && isRecord(raw.query) ? raw.query : raw;
  const name = stringOrFallback(base.name, existing.name ?? "");
  if (!name.trim()) {
    throw new Error("DSL 缺少 name。");
  }
  const filters = isRecord(base.filters) ? base.filters : {};
  const status = normalizeSavedViewStatus(filters.status);
  const time = normalizeTimeFilters(filters.time);
  const tags = normalizeDslTags(filters.tags);
  const view = normalizeSavedViewConfig(base.view);
  const summary = normalizeSavedViewSummary(Array.isArray(base.summary) ? (base.summary as SavedViewSummaryMetric[]) : []);
  const id = stringOrFallback(base.id, existing.id ?? defaultSavedViewId());
  return normalizeSavedTaskView({
    id,
    name,
    builtin: booleanOrFallback(base.builtin, existing.builtin ?? false),
    hidden: booleanOrFallback(base.hidden, existing.hidden ?? false),
    search: stringOrFallback(filters.search, ""),
    tag: tags.join(","),
    time,
    status,
    view,
    summary,
  });
}

export function sameSavedViewContent(a: SavedTaskView, b: SavedTaskView): boolean {
  const left = normalizeSavedTaskView(a);
  const right = normalizeSavedTaskView(b);
  return JSON.stringify({
    builtin: left.builtin,
    hidden: left.hidden,
    search: left.search,
    tag: left.tag,
    time: left.time,
    status: left.status,
    view: left.view,
    summary: left.summary,
  }) === JSON.stringify({
    builtin: right.builtin,
    hidden: right.hidden,
    search: right.search,
    tag: right.tag,
    time: right.time,
    status: right.status,
    view: right.view,
    summary: right.summary,
  });
}

export function renameSavedViewById(
  views: readonly SavedTaskView[],
  id: string,
  name: string,
): SavedTaskView[] {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Query Tab 名称不能为空。");
  return views.map((view) => (view.id === id ? normalizeSavedTaskView({ ...view, name: trimmed }) : view));
}

export function deleteSavedViewById(views: readonly SavedTaskView[], id: string): SavedTaskView[] {
  return views.filter((view) => view.id !== id);
}

export function setSavedViewHiddenById(
  views: readonly SavedTaskView[],
  id: string,
  hidden: boolean,
): SavedTaskView[] {
  return views.map((view) => (view.id === id ? normalizeSavedTaskView({ ...view, hidden }) : view));
}

export function duplicateSavedView(
  views: readonly SavedTaskView[],
  sourceId: string,
  name: string,
  makeId: () => string = defaultSavedViewId,
): SavedTaskView {
  const source = views.find((view) => view.id === sourceId);
  if (!source) throw new Error(`Query Tab 不存在：${sourceId}`);
  const normalized = normalizeSavedTaskView(source);
  return normalizeSavedTaskView({
    ...normalized,
    id: makeId(),
    name: name.trim(),
    builtin: false,
    hidden: false,
  });
}

export function visibleSavedViews(views: readonly SavedTaskView[]): SavedTaskView[] {
  return views.map((view) => normalizeSavedTaskView(view)).filter((view) => !view.hidden);
}

export function moveSavedViewById(
  views: readonly SavedTaskView[],
  id: string,
  direction: -1 | 1,
): SavedTaskView[] {
  const index = views.findIndex((view) => view.id === id);
  if (index === -1) return [...views];
  const target = index + direction;
  if (target < 0 || target >= views.length) return [...views];
  const out = [...views];
  const [item] = out.splice(index, 1);
  out.splice(target, 0, item);
  return out;
}

export function createSavedViewId(): string {
  return defaultSavedViewId();
}

function normalizeSavedViewConfig(view: unknown): SavedViewConfig {
  const raw = isRecord(view) ? view : {};
  const type = normalizeQueryViewType(typeof raw.type === "string" ? raw.type : undefined);
  const preset = typeof raw.preset === "string" ? raw.preset.trim() : undefined;
  const orderBy = Array.isArray(raw.orderBy)
    ? raw.orderBy.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)
    : undefined;
  return {
    type,
    ...(preset ? { preset } : {}),
    ...(orderBy && orderBy.length > 0 ? { orderBy } : {}),
  };
}

function normalizeSavedViewSummary(summary: SavedViewSummaryMetric[] | null | undefined): SavedViewSummaryMetric[] {
  if (!Array.isArray(summary)) return [];
  const out: SavedViewSummaryMetric[] = [];
  for (const metric of summary) {
    if (!metric || typeof metric.type !== "string") continue;
    const normalized: SavedViewSummaryMetric = { type: metric.type };
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

function seededBuiltinSavedView(tab: BuiltinQueryTab, name: string): SavedTaskView {
  switch (tab) {
    case "today":
      return normalizeSavedTaskView({
        id: BUILTIN_SAVED_VIEW_IDS.today,
        name,
        builtin: true,
        hidden: false,
        search: "",
        tag: "",
        time: {},
        status: ["todo"],
        view: { type: "list", preset: "today" },
        summary: [],
      });
    case "week":
      return normalizeSavedTaskView({
        id: BUILTIN_SAVED_VIEW_IDS.week,
        name,
        builtin: true,
        hidden: false,
        search: "",
        tag: "",
        time: {},
        status: ["todo"],
        view: { type: "week" },
        summary: [],
      });
    case "month":
      return normalizeSavedTaskView({
        id: BUILTIN_SAVED_VIEW_IDS.month,
        name,
        builtin: true,
        hidden: false,
        search: "",
        tag: "",
        time: {},
        status: ["todo"],
        view: { type: "month" },
        summary: [],
      });
    case "todo":
      return normalizeSavedTaskView({
        id: BUILTIN_SAVED_VIEW_IDS.todo,
        name,
        builtin: true,
        hidden: false,
        search: "",
        tag: "",
        time: {},
        status: ["todo"],
        view: { type: "list", preset: "todo" },
        summary: [{ type: "count" }],
      });
    case "completed":
      return normalizeSavedTaskView({
        id: BUILTIN_SAVED_VIEW_IDS.completed,
        name,
        builtin: true,
        hidden: false,
        search: "",
        tag: "",
        time: {},
        status: ["done"],
        view: { type: "list", preset: "completed", orderBy: ["completed_desc"] },
        summary: [
          { type: "count" },
          { type: "sum", field: "actual", format: "duration" },
          { type: "ratio", numerator: "actual", denominator: "estimate", format: "percent" },
        ],
      });
    case "dropped":
      return normalizeSavedTaskView({
        id: BUILTIN_SAVED_VIEW_IDS.dropped,
        name,
        builtin: true,
        hidden: false,
        search: "",
        tag: "",
        time: {},
        status: ["dropped"],
        view: { type: "list", preset: "dropped" },
        summary: [{ type: "count" }],
      });
    case "unscheduled":
    default:
      return normalizeSavedTaskView({
        id: BUILTIN_SAVED_VIEW_IDS.unscheduled,
        name,
        builtin: true,
        hidden: false,
        search: "",
        tag: "",
        time: {},
        status: ["todo"],
        view: { type: "list", preset: "unscheduled", orderBy: ["deadline_risk", "created_desc"] },
        summary: [{ type: "count" }],
      });
  }
}

function parseSavedViewTags(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
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
 * Convert a legacy SavedTaskView to the canonical QueryPreset.
 */
export function toQueryPreset(view: SavedTaskView): QueryPreset {
  const normalized = normalizeSavedTaskView(view);
  const tags = parseSavedViewTags(normalized.tag);
  return normalizeQueryPreset({
    id: normalized.id,
    name: normalized.name,
    builtin: normalized.builtin ?? false,
    hidden: normalized.hidden ?? false,
    filters: {
      ...(normalized.search ? { search: normalized.search } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      status: normalized.status,
      ...(Object.keys(normalized.time).length > 0 ? { time: normalized.time } : {}),
    },
    view: normalized.view ?? { type: "list" },
    summary: normalized.summary ?? [],
  });
}

/**
 * Convert a QueryPreset back to the legacy SavedTaskView shape
 * for backward compatibility with existing view/settings code.
 */
export function fromQueryPreset(preset: QueryPreset): SavedTaskView {
  const normalized = normalizeQueryPreset(preset);
  const tags = Array.isArray(normalized.filters.tags)
    ? normalized.filters.tags.join(",")
    : typeof normalized.filters.tags === "string"
      ? normalized.filters.tags
      : "";
  return normalizeSavedTaskView({
    id: normalized.id,
    name: normalized.name,
    builtin: normalized.builtin,
    hidden: normalized.hidden,
    search: normalized.filters.search ?? "",
    tag: tags,
    time: normalized.filters.time ?? {},
    status: normalized.filters.status ?? "all",
    view: normalized.view,
    summary: normalized.summary,
  });
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
  return BUILTIN_QUERY_TABS.map((tab) => {
    const flat = seededBuiltinSavedView(tab, labels[tab] ?? DEFAULT_BUILTIN_LABELS[tab]);
    return toQueryPreset(flat);
  });
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
    const seeded = toQueryPreset(seededBuiltinSavedView(tab, labels[tab] ?? DEFAULT_BUILTIN_LABELS[tab]));
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
  const seeded = toQueryPreset(seededBuiltinSavedView(kind, labels[kind] ?? DEFAULT_BUILTIN_LABELS[kind]));
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
