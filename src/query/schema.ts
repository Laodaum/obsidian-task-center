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
 * Extract a tag filter's values + match mode from any accepted DSL shape:
 *   - `string[]`               → AND (back-compat)
 *   - comma-separated `string` → AND (back-compat)
 *   - `{ values, mode }`       → explicit mode ("or" only when literally "or")
 * Values are returned verbatim (no `#`-prefixing / dedup — each layer does its
 * own); empty / malformed input degrades to `{ values: [], mode: "and" }`.
 */
export function resolveTagFilter(
  tags: unknown,
): { values: string[]; mode: "and" | "or" } {
  if (!tags) return { values: [], mode: "and" };
  if (Array.isArray(tags)) {
    return { values: tags.filter((t): t is string => typeof t === "string"), mode: "and" };
  }
  if (typeof tags === "string") {
    return { values: tags.split(",").map((t) => t.trim()).filter(Boolean), mode: "and" };
  }
  if (typeof tags === "object") {
    const obj = tags as { values?: unknown; mode?: unknown };
    const values = Array.isArray(obj.values)
      ? obj.values.filter((t): t is string => typeof t === "string")
      : [];
    return { values, mode: obj.mode === "or" ? "or" : "and" };
  }
  return { values: [], mode: "and" };
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
