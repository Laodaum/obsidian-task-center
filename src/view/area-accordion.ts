// US-511: pure single-open ("exclusive") accordion semantics for the mobile
// area list. Kept dependency-free so it is unit-testable on its own (the view
// layer wires DOM + state around these); no week/month special-casing — every
// task-rendering area goes through the same path.

// The default-open section: the first task-rendering area. `rendersTasks` is the
// per-area flag in DFS (collectAreas) order. Falls back to 0 when none render
// tasks, so an index always exists.
export function defaultExpandedAreaIndex(rendersTasks: boolean[]): number {
  const i = rendersTasks.findIndex(Boolean);
  return i < 0 ? 0 : i;
}

// The effective open section: the user's stored choice if any (including -1,
// meaning they collapsed the open one so nothing is expanded), else the default.
export function resolveExpandedAreaIndex(stored: number | undefined, fallback: number): number {
  return stored === undefined ? fallback : stored;
}

// Single-open toggle: re-clicking the open section collapses it (-1); clicking
// another opens it (and the renderer collapses the rest).
export function nextExpandedAreaIndex(open: number, clicked: number): number {
  return open === clicked ? -1 : clicked;
}
