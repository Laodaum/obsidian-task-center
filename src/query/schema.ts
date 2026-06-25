// Query schema primitives shared by the pure query pipeline (filter / projection)
// and the upper QueryPreset store. Status normalization lives HERE — not in
// saved-views — so the query layer never has to import up into the persistence
// layer: the dependency points saved-views → query/schema, never the reverse.
// (ARCHITECTURE.md §2.1 依赖规则; REFACTOR.md D5)

import type { TaskStatus } from "../types";

export const KNOWN_STATUS_VALUES: TaskStatus[] = [
  "todo",
  "done",
  "dropped",
  "in_progress",
  "cancelled",
  "custom",
];

export function isKnownTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (KNOWN_STATUS_VALUES as readonly string[]).includes(value);
}

/**
 * Extract a tag filter's include values + match mode + exclude values from any
 * accepted DSL shape:
 *   - `string[]`                        → include AND, no exclude (back-compat)
 *   - comma-separated `string`          → include AND, no exclude (back-compat)
 *   - `{ values, mode, exclude }`       → explicit mode ("or" only when literally
 *                                         "or"); `exclude` = US-109d3 exclude group
 * Values are returned verbatim (no `#`-prefixing / dedup — each layer does its
 * own); empty / malformed input degrades to `{ values: [], mode: "and", exclude: [] }`.
 */
export function resolveTagFilter(
  tags: unknown,
): { values: string[]; mode: "and" | "or"; exclude: string[] } {
  if (!tags) return { values: [], mode: "and", exclude: [] };
  if (Array.isArray(tags)) {
    return { values: tags.filter((t): t is string => typeof t === "string"), mode: "and", exclude: [] };
  }
  if (typeof tags === "string") {
    return { values: tags.split(",").map((t) => t.trim()).filter(Boolean), mode: "and", exclude: [] };
  }
  if (typeof tags === "object") {
    const obj = tags as { values?: unknown; mode?: unknown; exclude?: unknown };
    const values = Array.isArray(obj.values)
      ? obj.values.filter((t): t is string => typeof t === "string")
      : [];
    const exclude = Array.isArray(obj.exclude)
      ? obj.exclude.filter((t): t is string => typeof t === "string")
      : [];
    return { values, mode: obj.mode === "or" ? "or" : "and", exclude };
  }
  return { values: [], mode: "and", exclude: [] };
}

/**
 * Normalize a raw `status` filter into the canonical form: "all" or a deduped
 * list of known TaskStatus values (an empty / all-unknown list → "all").
 */
export function normalizeQueryStatus(status: unknown): "all" | TaskStatus[] {
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
