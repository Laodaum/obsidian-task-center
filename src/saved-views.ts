import type { SavedTaskView, SavedViewStatus, SavedViewTimeFilters, TaskStatus } from "./types";

const KNOWN_STATUS_VALUES: TaskStatus[] = ["todo", "done", "dropped", "in_progress", "cancelled", "custom"];

export interface SavedViewFilters {
  search: string;
  tag: string;
  time: SavedViewTimeFilters;
  status: SavedViewStatus;
}

export interface AppliedSavedViewFilters extends SavedViewFilters {
  savedViewId: string | null;
}

export function createSavedView(
  name: string,
  filters: SavedViewFilters,
  makeId: () => string = defaultSavedViewId,
): SavedTaskView {
  return {
    id: makeId(),
    name: name.trim(),
    search: filters.search.trim(),
    tag: filters.tag.trim(),
    time: normalizeTimeFilters(filters.time),
    status: normalizeSavedViewStatus(filters.status),
  };
}

export function upsertSavedView(views: readonly SavedTaskView[], view: SavedTaskView): SavedTaskView[] {
  return [
    ...views.filter((existing) => existing.name !== view.name),
    view,
  ];
}

export function updateSavedViewById(views: readonly SavedTaskView[], view: SavedTaskView): SavedTaskView[] {
  return views.map((existing) => existing.id === view.id ? view : existing);
}

export function applySavedViewFilters(view: SavedTaskView): AppliedSavedViewFilters {
  return {
    savedViewId: view.id,
    search: view.search,
    tag: view.tag,
    time: normalizeTimeFilters(view.time),
    status: normalizeSavedViewStatus(view.status),
  };
}

export function clearSavedViewFilters(): AppliedSavedViewFilters {
  return {
    savedViewId: null,
    search: "",
    tag: "",
    time: {},
    status: "all",
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

export function normalizeSavedViewStatus(status: SavedViewStatus | null | undefined): "all" | TaskStatus[] {
  if (!status || status === "all") return "all";
  const raw = Array.isArray(status) ? status : [status];
  const seen = new Set<TaskStatus>();
  const out: TaskStatus[] = [];
  for (const value of raw) {
    if (!KNOWN_STATUS_VALUES.includes(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.length > 0 ? out : "all";
}

function normalizeTimeFilters(time: SavedViewTimeFilters): SavedViewTimeFilters {
  const out: SavedViewTimeFilters = {};
  for (const [key, value] of Object.entries(time) as Array<[keyof SavedViewTimeFilters, string | undefined]>) {
    const trimmed = value?.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

function defaultSavedViewId(): string {
  return `sv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
