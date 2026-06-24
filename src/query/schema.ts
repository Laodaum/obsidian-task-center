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
