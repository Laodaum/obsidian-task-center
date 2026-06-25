// Query schema primitives shared by the pure query pipeline (filter / projection)
// and the upper QueryPreset store. Status normalization lives HERE — not in
// saved-views — so the query layer never has to import up into the persistence
// layer: the dependency points saved-views → query/schema, never the reverse.
// (ARCHITECTURE.md §2.1 依赖规则; REFACTOR.md D5)

import type { TaskStatus } from "../types";
import { tagSelectionToExpr } from "./tag-expr";

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
 * Extract a tag filter's parts from any accepted DSL shape. US-109d4 unifies tag
 * filtering on a boolean expression; the legacy three-state shapes are still
 * accepted as input and surfaced here so callers can convert them to one:
 *   - `string[]`                  → include AND, no exclude (back-compat)
 *   - comma-separated `string`    → include AND, no exclude (back-compat)
 *   - `{ values, mode, exclude }` → US-109d3 three-state; `expr` stays null
 *   - `{ expr }`                  → US-109d4 expression; values/exclude empty
 * Values are returned verbatim; empty / malformed input degrades to the AND-empty
 * default with `expr: null`.
 */
export function resolveTagFilter(
  tags: unknown,
): { values: string[]; mode: "and" | "or"; exclude: string[]; expr: string | null } {
  if (!tags) return { values: [], mode: "and", exclude: [], expr: null };
  if (Array.isArray(tags)) {
    return { values: tags.filter((t): t is string => typeof t === "string"), mode: "and", exclude: [], expr: null };
  }
  if (typeof tags === "string") {
    return { values: tags.split(",").map((t) => t.trim()).filter(Boolean), mode: "and", exclude: [], expr: null };
  }
  if (typeof tags === "object") {
    const obj = tags as { values?: unknown; mode?: unknown; exclude?: unknown; expr?: unknown };
    if (typeof obj.expr === "string" && obj.expr.trim()) {
      return { values: [], mode: "and", exclude: [], expr: obj.expr };
    }
    const values = Array.isArray(obj.values)
      ? obj.values.filter((t): t is string => typeof t === "string")
      : [];
    const exclude = Array.isArray(obj.exclude)
      ? obj.exclude.filter((t): t is string => typeof t === "string")
      : [];
    return { values, mode: obj.mode === "or" ? "or" : "and", exclude, expr: null };
  }
  return { values: [], mode: "and", exclude: [], expr: null };
}

/**
 * US-109d4: the single canonical view of a tag filter — a boolean expression
 * string. `{ expr }` is returned verbatim; any legacy three-state / array shape
 * is converted to the equivalent expression. Empty filter → "".
 */
export function tagsToExpr(tags: unknown): string {
  const r = resolveTagFilter(tags);
  if (r.expr !== null) return r.expr;
  return tagSelectionToExpr(r.values, r.mode, r.exclude);
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
