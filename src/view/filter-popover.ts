export interface FilterPopoverPointerState {
  isOpen: boolean;
  isInsideFilterControls: boolean;
}

export function shouldCloseFilterPopoverOnPointerDown(state: FilterPopoverPointerState): boolean {
  return state.isOpen && !state.isInsideFilterControls;
}

/**
 * Determines whether a PointerEvent originated inside the filter controls
 * area (toolbar filter bar or query editor sheet) so the popover should
 * stay open.
 *
 * Checks the entire composed event path against `[data-saved-views]`
 * (the filter toolbar / query editor sheet container).  Also recognizes
 * the popover elements themselves so that a click on the popover
 * dropdown keeps it open even if the popover renders outside the
 * `[data-saved-views]` subtree for some reason (e.g. portal / fixed
 * positioning by a parent).
 */
export function isClickInsideFilterControls(event: { composedPath(): EventTarget[] }): boolean {
  return event.composedPath().some((target) => {
    if (!(target instanceof HTMLElement)) return false;
    return (
      !!target.closest("[data-saved-views]") ||
      !!target.closest(".bt-filter-popover, .bt-tag-popover, .bt-date-popover, .bt-status-popover, .bt-time-more-popover") ||
      // US-109w: per-area filter trigger + popover live in the area header, not
      // inside [data-saved-views]; clicking them must not count as "outside".
      !!target.closest(".bt-area-filter")
    );
  });
}
