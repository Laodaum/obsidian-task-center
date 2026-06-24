// Desktop tab-bar overflow geometry, extracted from TaskCenterView
// (ARCHITECTURE §7.9 TabOverflowMeasure). The class holds the measured-width
// cache + fit state and reads the DOM (offsetWidth is inherently view-layer);
// the core `fitTabCountFromWidths` is DOM-free and unit-testable (§0 原则 10).

// `TAB_BAR_GAP` is the flex gap between bar items; `MORE_CHIP_RESERVE` is a
// FALLBACK width for the "更多 N" chip, used only until its real rendered width
// is measured — a fixed guess over-reserved and collapsed too many tabs.
const TAB_BAR_GAP = 2;
const MORE_CHIP_RESERVE = 64;

/**
 * Largest number of leading tabs that fit in `avail` px, reserving `moreReserve`
 * px for the "更多" chip when not all fit. Always keeps at least one real tab so
 * the bar is never reduced to just "更多". Pure — unit-testable without the DOM.
 */
export function fitTabCountFromWidths(widths: number[], avail: number, moreReserve: number): number {
  const total = widths.length;
  if (total === 0) return 0;
  // Everything fits without a "更多" chip?
  let sum = 0;
  for (let i = 0; i < total; i++) sum += widths[i] + (i > 0 ? TAB_BAR_GAP : 0);
  if (sum <= avail) return total;
  // Otherwise take the largest prefix that fits alongside the chip.
  let used = 0;
  let fit = 0;
  for (let i = 0; i < total; i++) {
    used += widths[i] + (i > 0 ? TAB_BAR_GAP : 0);
    if (used + TAB_BAR_GAP + moreReserve <= avail) fit = i + 1;
    else break;
  }
  return Math.max(1, fit);
}

export interface TabOverflowDeps {
  visibleTabs: () => Array<{ id: string }>;
  isMobileLayout: () => boolean;
  findTabbar: () => HTMLElement | null;
  requestRender: () => void;
}

export class TabOverflowMeasure {
  private fittedVisibleTabCount: number | null = null;
  private lastTabbarMeasureWidth = 0;
  // Per-tab measured pixel widths (keyed by tab id), cached so the fit can be
  // recomputed for tabs hidden inside "更多" (lets the bar grow back).
  private readonly tabWidthCache = new Map<string, number>();
  // Last measured "更多" chip width (0 until first seen), used as the reserve.
  private moreChipWidth = 0;

  constructor(private readonly deps: TabOverflowDeps) {}

  /** How many leading tabs to show; null = everything fits ("show all"). */
  get fittedCount(): number | null {
    return this.fittedVisibleTabCount;
  }

  measure(bar: HTMLElement): void {
    window.requestAnimationFrame(() => {
      if (!bar.isConnected) return;
      if (this.deps.isMobileLayout()) return;
      const barWidth = bar.clientWidth;
      // Layout not settled (leaf still mounting) — bail without caching a bad
      // width; the ResizeObserver fires again once the bar has real width.
      if (barWidth < 40) return;
      const tabEls = Array.from(bar.querySelectorAll<HTMLElement>(".bt-tab:not(.bt-tab-more)"));
      // Styles-not-applied guard: before the plugin CSS lands, .bt-tab divs fall
      // back to display:block and each fills the row. Caching those bogus widths
      // pinned the bar to a single tab; treat that as "not ready" and retry.
      if (tabEls.length >= 2 && tabEls.every((el) => el.offsetWidth >= barWidth * 0.9)) {
        window.requestAnimationFrame(() => this.measure(bar));
        return;
      }
      this.lastTabbarMeasureWidth = barWidth;
      for (const el of tabEls) {
        const id = el.dataset.tabId;
        if (id) this.tabWidthCache.set(id, el.offsetWidth);
      }
      const tabs = this.deps.visibleTabs();
      // A tab has never been measured — render the full strip once so every
      // width caches, then recompute on the next pass.
      if (tabs.some((t) => !this.tabWidthCache.has(t.id))) {
        if (this.fittedVisibleTabCount !== null) {
          this.fittedVisibleTabCount = null;
          this.deps.requestRender();
        }
        return;
      }
      const tail = bar.querySelector<HTMLElement>(".bt-tabbar-tail");
      const avail = barWidth - (tail ? tail.offsetWidth + TAB_BAR_GAP : 0);
      // Reserve the "更多" chip's REAL rendered width once it exists.
      const moreEl = bar.querySelector<HTMLElement>(".bt-tab-more");
      if (moreEl && moreEl.offsetWidth > 0 && moreEl.offsetWidth < barWidth * 0.5) {
        this.moreChipWidth = moreEl.offsetWidth;
      }
      const reserve = this.moreChipWidth || MORE_CHIP_RESERVE;
      const widths = tabs.map((t) => this.tabWidthCache.get(t.id) ?? 0);
      const fit = fitTabCountFromWidths(widths, avail, reserve);
      // fit >= total → everything fits, keep "show all" (null) to avoid churn.
      const desired = fit >= tabs.length ? null : fit;
      if (desired !== this.fittedVisibleTabCount) {
        this.fittedVisibleTabCount = desired;
        this.deps.requestRender();
      }
    });
  }

  /** Re-measure when the bar width actually changed (resize / css change). */
  onResize(): void {
    if (this.deps.isMobileLayout()) return;
    const bar = this.deps.findTabbar();
    if (!bar) return;
    if (Math.abs(bar.clientWidth - this.lastTabbarMeasureWidth) < 1) return;
    // Cached widths are container-width independent, so a plain re-render lets
    // the measure pass re-split on the new width.
    this.deps.requestRender();
  }
}
