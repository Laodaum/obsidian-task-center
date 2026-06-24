import {
  ItemView,
  Modal,
  WorkspaceLeaf,
  Notice,
  Platform,
  setIcon,
} from "obsidian";
import { ParsedTask, VIEW_TYPE_TASK_CENTER } from "./types";
import { formatMinutes } from "./parser";
import { TaskCenterApi } from "./api";
import {
  todayISO,
  fromISO,
  addDays,
  shiftMonth,
  startOfWeek,
  startOfMonth,
  isoWeekNumber,
  pad,
} from "./dates";
import { t as tr } from "./i18n";
import { animateOut } from "./anim";
import { TabDwellTracker } from "./view/dnd";
import { UndoStack, UndoEntry, UndoOp } from "./view/undo";
import { BottomSheet } from "./view/bottom-sheet";
import { openMobileDatePicker, openMobileTagEditor, type TagEditResult } from "./view/mobile-task-sheet";
import { shouldCloseFilterPopoverOnPointerDown, isClickInsideFilterControls } from "./view/filter-popover";
import { isMobileMode } from "./platform";
import { weekMinHeightFromViewHeightPx } from "./view/layout";
import { QueryDslModal, type QueryDslSubmitMode } from "./view/query-dsl-modal";
import { QueryEditorView, type QueryEditorScope, type QueryEditorAreaTab } from "./view/query-editor";
import { renderMigrationGate } from "./view/migration-gate";
import type { FilterPopoverKey, TabKey, ViewState } from "./view/state";
import { taskDisplayTags } from "./tags";
import { taskMatchesTimeToken, timeTokenAppliesToField } from "./time-filter";
import { deriveEffectiveTasks, recomputeTopLevelInQuery } from "./task-tree";
import type { EffectiveTask } from "./task-tree";
import { projectListArea } from "./query/projection";
import { applyQueryFilters, queryFilterHasActiveConditions } from "./query/filter";
import { TabOverflowMeasure } from "./view/tab-overflow";
import {
  suggestSavedViewName,
  askSavedViewName,
  saveCurrentView,
} from "./view/saved-view-actions";
import { openManageTabsSheet } from "./view/manage-tabs";
import { openParentPickerForTask } from "./view/parent-picker";
import { openSourceEditShell, openQuickAdd } from "./view/source-actions";
import { renderCard } from "./view/render/card";
import { renderWeek, renderMonth } from "./view/render/calendar";
import { renderTabBar } from "./view/tabbar";
import { renderToolbar } from "./view/toolbar";
import { statusFilterLabel } from "./view/area-filter-model";
import {
  applyQueryPresetFilters,
  builtinSavedViewId,
  collectAreas,
  computeQueryPresetSnapshot,
  clearQueryPresetFilters as emptySavedViewFilters,
  createSavedViewId,
  createQueryPreset,
  parseQueryDsl,
  sameQueryPresetContent,
  stringifyQueryPreset,
  renameQueryPresetById,
  normalizeQueryPreset,
  normalizeQueryStatus,
  upsertQueryPreset,
  updateQueryPresetById,
  visibleQueryPresets,
  queryPresetTagString,
} from "./saved-views";
import type {
  AreaConfig,
  AreaType,
  GridAreaConfig,
  LayoutNode,
  ListAreaConfig,
  WeekAreaConfig,
  MonthAreaConfig,
  UnknownAreaConfig,
  QueryPreset,
  QueryPresetFilters,
  QueryPresetViewConfig,
} from "./types";
import { isStackNode } from "./types";
import { areaSupportsWhen, areaHandler } from "./areas";
import type { QueryTimeField, QueryTimeFilters } from "./types";
import type TaskCenterPlugin from "./main";

type FilterControlsRerender = () => void;
// `UndoOp` and `UndoEntry` re-exported from `./view/undo` (the canonical
// definitions). Local re-export so existing usage in this file compiles.
export type { UndoOp, UndoEntry };

function normalizeFilterTag(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed.toLowerCase() : `#${trimmed.toLowerCase()}`;
}

function parseFilterTags(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(",")) {
    const tag = normalizeFilterTag(part);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function taskHasTag(t: ParsedTask, tag: string): boolean {
  const wanted = normalizeFilterTag(tag);
  return t.tags.some((existing) => existing.toLowerCase() === wanted);
}

function taskMatchesText(t: ParsedTask, q: string): boolean {
  if (t.title.toLowerCase().includes(q)) return true;
  for (const tag of t.tags) if (tag.toLowerCase().includes(q)) return true;
  return false;
}

function effectiveTimeValue(t: EffectiveTask, field: QueryTimeField): string | null {
  if (field === "scheduled") return t.effectiveScheduled;
  if (field === "deadline") return t.effectiveDeadline;
  if (field === "completed") return t.completed;
  if (field === "dropped") return t.cancelled;
  return t.effectiveCreated ?? t.created;
}

function taskMatchesTimeFilter(t: EffectiveTask, field: QueryTimeField, token: string, weekStartsOn: 0 | 1): boolean {
  if (!timeTokenAppliesToField(field, token)) return false;
  // "unscheduled" means effective scheduled is empty
  if (field === "scheduled" && token === "unscheduled") return t.effectiveScheduled === null;
  if (token === "unscheduled") return effectiveTimeValue(t, field) === null;
  return taskMatchesTimeToken(effectiveTimeValue(t, field), token, weekStartsOn);
}

class SwitchTabConfirmModal extends Modal {
  private onSave: () => void;
  private onSwitch: () => void;

  constructor(app: import("obsidian").App, onSave: () => void, onSwitch: () => void) {
    super(app);
    this.onSave = onSave;
    this.onSwitch = onSwitch;
  }

  onOpen() {
    this.modalEl.addClass("task-center-modal");
    this.titleEl.setText(tr("savedViews.switchDirtyTitle"));
    this.contentEl.createEl("p", { text: tr("savedViews.switchDirtyBody") });
    const row = this.contentEl.createDiv({ cls: "bt-confirm-row" });
    row.createEl("button", {
      text: tr("savedViews.switchDirtySave"),
      cls: "bt-confirm-btn bt-confirm-btn--primary",
    }).addEventListener("click", () => { this.close(); this.onSave(); });
    row.createEl("button", {
      text: tr("savedViews.switchDirtyDiscard"),
      cls: "bt-confirm-btn",
    }).addEventListener("click", () => { this.close(); this.onSwitch(); });
    row.createEl("button", {
      text: tr("savedViews.switchDirtyCancel"),
      cls: "bt-confirm-btn",
    }).addEventListener("click", () => this.close());
  }

  onClose() { this.contentEl.empty(); }
}

// Per-area render dispatch as a total registry, mirroring query/projection.ts
// AREA_PROJECTORS and areas.ts HANDLERS. Record<AreaType,…> keeps the renderer
// set exhaustive: a new AreaType with no renderer fails to compile. list/grid
// share renderListArea (grid is the multi-column CSS variant), same as
// AREA_PROJECTORS routes both to projectListArea. The `as XxxConfig` casts
// mirror AREA_PROJECTORS — the union is already narrowed by node.type at the
// call site. (REFACTOR.md §4.7: only this render-registry core was adopted.)
type AreaRenderer = (v: TaskCenterView, el: HTMLElement, area: AreaConfig, areaIndex: number) => void;
const AREA_RENDERERS: Record<AreaType | "unknown", AreaRenderer> = {
  list: (v, el, area, i) => v.renderListArea(el, area as ListAreaConfig, false, i),
  grid: (v, el, area, i) => v.renderListArea(el, area as GridAreaConfig, true, i),
  week: (v, el, area, i) => renderWeek(v, el, area as WeekAreaConfig, i),
  month: (v, el, area, i) => renderMonth(v, el, area as MonthAreaConfig, i),
  drop: (v, el) => v.renderTrashZone(el),
  unknown: (v, el, area) => v.renderUnknownArea(el, area as UnknownAreaConfig),
};

export class TaskCenterView extends ItemView {
  plugin: TaskCenterPlugin;
  api: TaskCenterApi;
  tasks: ParsedTask[] = [];
  /** Cached effective tasks derived from `this.tasks` via `deriveEffectiveTasks`. */
  private _effectiveTasks: EffectiveTask[] = [];
  state: ViewState;
  private refreshTimer: number | null = null;
  private cacheVersion = 0;
  private cacheUnsub: (() => void) | null = null;
  /** Prebuilt id→task index for O(1) parent lookups. Rebuilt on each render(). */
  _taskIndex: Map<string, ParsedTask> = new Map();
  // Cross-tab drag dwell: hovering a card over a tab head for 600ms switches
  // tabs. UX.md §6.1 / ARCHITECTURE.md §11. One tracker for the whole view —
  // tab heads route their dragover events through `update()`.
  dwellTracker = new TabDwellTracker<string>({
    durationMs: 600,
    onCommit: (id) => this.activateSavedViewById(id),
  });
  // US-128: Ctrl/Cmd+Z undo stack. Only records writes initiated from this
  // view (drag / keyboard / quick-add). CLI writes are not captured —
  // they're scriptable and idempotent enough that auto-undo would be more
  // confusing than helpful (UX.md §6.7). Capped at 20 entries (UndoStack.MAX).
  // see USER_STORIES.md
  undoStack: UndoStack;
  // US-153: ids of tasks the user just marked done via the ✔ check *in this
  // view session*. They bypass the status filter (filter.ts exemptStatusIds),
  // so a freshly-completed card lingers in place — rendered in its done state
  // (US-152) but still interactive — instead of vanishing the instant it is
  // checked off. Cleared on every genuine "re-enter view" (onOpen / tab switch
  // / cache-driven full refresh), never by the in-place re-render that the
  // completion toggle itself triggers.
  justCompletedIds = new Set<string>();
  // US-153: our own ✔ write triggers a cache `changed` → debounced
  // scheduleRefresh. That refresh must NOT clear `justCompletedIds` (it isn't a
  // user re-entering the view, it's the echo of the completion we just made).
  // toggleDone sets this so the next scheduleRefresh skips the clear exactly
  // once; genuine external changes still clear.
  private skipNextRefreshClear = false;
  filterPopoverOpen: FilterPopoverKey | null = null;
  // US-109q: desktop "更多" overflow tabs dropdown open state. Mirrors the
  // per-area filter popover model — open/close is a render-time flag closed by
  // outside pointerdown / Esc / row select / button toggle (mobile uses a sheet).
  overflowTabsMenuOpen = false;
  // US-109q: desktop tab-overflow geometry (measured-width cache + fit state).
  readonly tabOverflow = new TabOverflowMeasure({
    visibleTabs: () => this.visibleQueryTabs(),
    isMobileLayout: () => this.contentEl.dataset.mobileLayout === "true",
    findTabbar: () => this.contentEl.querySelector<HTMLElement>(".bt-tabbar"),
    requestRender: () => this.render(),
  });
  // Render-time DFS area counter, reset at the start of renderViewLayout so each
  // rendered area's index matches collectAreas(layout) order (for setAreaWhen).
  private renderAreaCounter = 0;
  // Whether the first content area has been seen this render pass — used to
  // give that area a title fallback (the tab name) so its header is labeled.
  private firstContentPlaced = false;
  // US-109p10: the Query editor panel (its render + transient scope/area state)
  // lives in view/query-editor.ts now; this view just holds the instance and
  // exposes the shared helpers it reads.
  private readonly queryEditor = new QueryEditorView(this);
  // US-109z2: secondary time fields (deadline/completed/created) the user has
  // progressively added in the area filter this session (scheduled is always
  // shown). Transient UI state — fields with a value show regardless.
  readonly areaFilterExtraFields = new Set<QueryTimeField>();
  // US-109z2: whether the area filter's tag select popover is open. A click-to-
  // open dropdown keeps the panel short when there are many tags.
  areaTagPopoverOpen = false;
  private dateCalendarAnchorISO = startOfMonth(todayISO());
  private pendingDateRangeStart: string | null = null;
  private viewResizeObserver: ResizeObserver | null = null;
  tabDrafts = new Map<string, QueryPreset>();

  constructor(leaf: WorkspaceLeaf, plugin: TaskCenterPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.api = plugin.api;
    this.undoStack = new UndoStack(this.app, {
      onApplied: () => this.scheduleRefresh(),
      notify: (msg, ms) => new Notice(msg, ms),
    });
    const restoredSavedView = this.initialSavedViewFromSettings();
    const restoredFilters = restoredSavedView ? applyQueryPresetFilters(restoredSavedView) : emptySavedViewFilters();
    const restoredTab = restoredSavedView
      ? this.tabForSavedView(restoredSavedView, "today")
      : "today";
    this.state = {
      // Priority: last-saved query preset → default saved query preset → first visible query tab.
      tab: restoredTab,
      anchorISO: todayISO(),
      selectedTaskId: null,
      filter: restoredFilters.search,
      savedViewId: restoredFilters.savedViewId,
      savedViewTag: restoredFilters.tag,
      savedViewTime: restoredFilters.time,
      savedViewStatus: restoredFilters.status,
      showUnscheduledPool: true,
      collapsedWeeks: new Set(),
      expandedDays: new Set(),
      selectedMonthDay: null,
    };
  }

  getViewType(): string {
    return VIEW_TYPE_TASK_CENTER;
  }
  getDisplayText(): string {
    return "Task center";
  }
  getIcon(): string {
    return "kanban-square";
  }

  private initialSavedViewFromSettings(): QueryPreset | null {
    const preferredId = this.plugin.settings.lastSavedViewId ?? this.plugin.settings.defaultSavedViewId;
    if (preferredId) {
      const match = this.plugin.settings.queryPresets.find((view) => view.id === preferredId);
      if (match) {
        const normalized = normalizeQueryPreset(match);
        if (!normalized.hidden) return normalized;
      }
    }
    return visibleQueryPresets(this.plugin.settings.queryPresets)[0] ?? null;
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("task-center-view");
    // Immediate placeholder so the tab doesn't flash blank on slow-parse vaults.
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "bt-loading", text: tr("loading") });
    // US-153: a fresh open starts a new view session — no lingering completions.
    this.justCompletedIds.clear();
    await this.reloadTasks();
    this.bumpCacheVersion();
    this.render();

    // Subscribe to the cache — and ONLY the cache. Vault and metadataCache
    // events are handled in one place (cache.bind in main.ts); the view reads
    // a settled snapshot via flatten() after each `cache.changed`. This is
    // the structural fix for #3 large-vault event-flood regression (double subscription → event flood).
    this.cacheUnsub = this.plugin.cache.on("changed", () => this.scheduleRefresh());

    // Keyboard
    this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", (e) => this.handleKey(e));
    // 使用 capture 阶段确保在 Obsidian 可能阻止冒泡前捕获 pointerdown。
    // 使用 activeDocument 而非 document，保证 popout 窗口兼容。
    this.registerDomEvent(activeDocument, "pointerdown", (e) => this.handleFilterOutsidePointerDown(e), { capture: true });

    // US-502: mobile layout gating. Reads viewport width (< 600px) OR
    // user setting `mobileForceLayout` (escape hatch for iPad / split-
    // screen) and writes `data-mobile-layout="true|false"` on contentEl;
    // styles.css attaches every mobile-only rule under
    // `[data-mobile-layout="true"]`. Driven by JS rather than @media so
    // the setting can override the viewport. UX-mobile §7.
    // see USER_STORIES.md
    this.applyMobileLayoutAttr();
    this.registerDomEvent(window, "resize", () => {
      this.applyMobileLayoutAttr();
      this.updateViewLayoutMetrics();
      this.tabOverflow.onResize();
    });
    this.viewResizeObserver = new ResizeObserver(() => {
      this.updateViewLayoutMetrics();
      this.tabOverflow.onResize();
    });
    this.viewResizeObserver.observe(this.contentEl);
    this.updateViewLayoutMetrics();

    // US-408: refresh when the user changes Obsidian's UI language.
    // Obsidian fires `css-change` on every theme/language reload; that's
    // our cheapest cross-platform signal. `t()` already re-detects the
    // locale on each call (i18n.ts), so the normal debounced refresh path
    // produces localized strings without a separate locale cache.
    this.registerEvent(this.app.workspace.on("css-change", () => this.scheduleRefresh()));
  }

  /** Idempotent — recompute and write the data-mobile-layout attribute. */
  private applyMobileLayoutAttr(): void {
    const narrow = window.innerWidth < 600;
    const force = !!this.plugin.settings.mobileForceLayout;
    this.contentEl.dataset.mobileLayout = narrow || force ? "true" : "false";
    this.contentEl.dataset.obsidianMobile = Platform.isMobile ? "true" : "false";
  }

  private updateViewLayoutMetrics(): void {
    const rectHeight = this.contentEl.getBoundingClientRect().height;
    const viewHeight = rectHeight || this.contentEl.clientHeight;
    const weekMinHeight = weekMinHeightFromViewHeightPx(viewHeight);
    if (weekMinHeight > 0) {
      this.contentEl.style.setProperty("--tc-week-min-height", `${weekMinHeight}px`);
    }
  }

  onClose(): Promise<void> {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    if (this.cacheUnsub) {
      this.cacheUnsub();
      this.cacheUnsub = null;
    }
    this.viewResizeObserver?.disconnect();
    this.viewResizeObserver = null;
    this.dwellTracker.reset();
    return Promise.resolve();
  }

  scheduleRefresh() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      void (async () => {
        this.refreshTimer = null;
        // US-153: a cache-driven full refresh is normally a genuine "re-enter
        // view" moment — drop the just-completed exemption so freshly-done
        // cards now settle out by the normal status filter. But skip the clear
        // once if this refresh is merely the echo of our own ✔ write.
        if (this.skipNextRefreshClear) {
          this.skipNextRefreshClear = false;
        } else {
          this.justCompletedIds.clear();
        }
        await this.reloadTasks();
        this.bumpCacheVersion();
        this.render();
      })();
    }, 400);
  }

  bumpCacheVersion() {
    this.cacheVersion++;
    this.contentEl.dataset.testCacheVersion = String(this.cacheVersion);
  }

  private findCardEl(taskId: string): HTMLElement | null {
    return this.contentEl.querySelector(
      `[data-task-id="${CSS.escape(taskId)}"]`,
    );
  }

  /**
   * Animate the source card out while running the data mutation in parallel,
   * then refresh immediately (bypassing the debounce so there's no awkward
   * 400ms gap between the fade-out and the layout settling).
   *
   * If the action no-ops (e.g. drop on the same day), the card briefly fades
   * and then reappears in the next render — accepted as a minor cost in
   * exchange for keeping every removal-style action smooth.
   *
   * For actions that add/remove lines (nest, add) the metadata cache lags
   * the file write — its cached `listItems` line numbers point at the wrong
   * content until the cache reparses. Pass `awaitCachePaths` so we wait for
   * `metadataCache.on('changed')` on each affected file before the render.
   */
  // US-125 task #33 observability gate. Disabled in release builds so Task
  // Center does not read browser storage for ad-hoc debug flags.
  private isDebugLogging(): boolean {
    return false;
  }

  async runWithRemoveAnim(
    taskId: string,
    action: () => Promise<unknown>,
    opts: { awaitCachePaths?: string[] } = {},
  ): Promise<void> {
    const card = this.findCardEl(taskId);
    // Register the cache listener BEFORE kicking off the action so we can't
    // miss a 'changed' event that fires while our awaits are queued.
    const cacheReady = opts.awaitCachePaths && opts.awaitCachePaths.length > 0
      ? this.waitForCacheUpdate(opts.awaitCachePaths)
      : Promise.resolve();
    await Promise.all([
      card ? animateOut(card) : Promise.resolve(),
      action(),
    ]);
    await cacheReady;
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    await this.reloadTasks();
    this.render();
  }

  /**
   * US-153: toggle a card's done state from the ✔ check. Unlike
   * `runWithRemoveAnim`, the card does NOT fade out and vanish. The toggle is
   * symmetric in BOTH directions — whichever way the status flips, the card
   * lingers in place until the next genuine view re-entry:
   *
   *  - todo → done: in a TODO view the now-done card would normally be filtered
   *    out; the exemption keeps it visible (in its done state, US-152).
   *  - done → todo (undone): in a Completed view the now-todo card would
   *    normally be filtered out; the exemption keeps it visible too, so the user
   *    can re-toggle or act on it.
   *
   * So `justCompletedIds` holds every id whose status was just toggled here
   * (either direction) — it is a "recently toggled, exempt from status filter"
   * set, cleared only on real view re-entry (see `applySavedView`,
   * `scheduleRefresh`, `onOpen`). The in-place reload+render below deliberately
   * does NOT clear it, otherwise the card would vanish the instant we re-render.
   */
  async toggleDone(t: EffectiveTask): Promise<void> {
    const wasDone = t.effectiveStatus === "done";
    if (wasDone) {
      await this.api.undone(t.id);
    } else {
      await this.api.done(t.id);
    }
    // Exempt this id from status filtering regardless of direction, so the card
    // stays put after either done or undone.
    this.justCompletedIds.add(t.id);
    // The file write above echoes back as a cache `changed` → debounced
    // scheduleRefresh. Tell that one refresh not to clear the exemption set,
    // so the just-toggled card keeps lingering.
    this.skipNextRefreshClear = true;
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    // US-153: the file write echoes back as an ASYNC cache reparse. Wait for it
    // before reload+render — otherwise the in-place re-render can read pre-reparse
    // state, so the lingering card (kept by the id-based justCompletedIds
    // exemption) renders its OLD status: it stays put but without the done class.
    // Mirrors runWithRemoveAnim / nestFromMobile, which already await the cache.
    await this.waitForCacheUpdate([t.path]);
    await this.reloadTasks();
    this.render();
  }

  /**
   * Resolve once `TaskCache` has emitted `'changed'` for every file in
   * `paths` (or after `timeoutMs` as a safety net). Used after structural
   * mutations so the next render sees up-to-date list-item line numbers.
   *
   * Reads `cache.on("changed")` (post-reparse), not raw metadataCache
   * (ARCHITECTURE.md §3.1: cache is the sole subscriber to vault events).
   */
  waitForCacheUpdate(paths: string[], timeoutMs = 1500): Promise<void> {
    const remaining = new Set(paths);
    if (remaining.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: number | null = null;
      const off = this.plugin.cache.on("changed", (changedPaths: Set<string>) => {
        for (const p of changedPaths) remaining.delete(p);
        if (remaining.size === 0) {
          if (timer !== null) window.clearTimeout(timer);
          off();
          resolve();
        }
      });
      timer = window.setTimeout(() => {
        off();
        resolve();
      }, timeoutMs);
    });
  }

  async reloadTasks() {
    // Wait for any in-flight single-file reparses to settle, so the snapshot
    // we take below reflects every metadataCache event Obsidian has dispatched
    // up to now. Without this, a write-then-reload race could read pre-parse
    // state.
    //
    // First reload also primes the cache (single full-vault pass, skipping
    // files Obsidian has confirmed task-free). Subsequent calls are cache
    // hits — `cache.ensureAll` returns the existing flatten().
    await this.plugin.cache.forFlush();
    const all = await this.plugin.cache.ensureAll();
    // US-107: silently drop blank-title task lines from the board. They're
    // valid markdown (`- [ ] ⏳ 2026-04-25`) but produce no useful card.
    // Filtering here also removes them from tab counts and tree traversals.
    this.tasks = all.filter((t) => t.title.trim() !== "");
    this._effectiveTasks = [];
  }

  /**
   * Returns the EffectiveTask[] derived from `this.tasks` via
   * `deriveEffectiveTasks`.  The result is cached until the next
   * `reloadTasks` clears it, so multiple render calls within a
   * single paint never recompute the tree.
   */
  getEffectiveTasks(): EffectiveTask[] {
    if (this._effectiveTasks.length === 0 && this.tasks.length > 0) {
      this._effectiveTasks = deriveEffectiveTasks(this.tasks);
    }
    return this._effectiveTasks;
  }

  /**
   * Test hook (ARCHITECTURE.md §8.5). Flushes the 400ms `scheduleRefresh`
   * debounce and any reparse the cache has in flight, so e2e can wait on a
   * single Promise instead of polling DOM versions.
   */
  async __forFlush(): Promise<void> {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
      await this.reloadTasks();
      this.bumpCacheVersion();
      this.render();
    }
    await this.plugin.cache.forFlush();
  }

  // US-405: persist the last-active tab so the next Obsidian open lands on
  // the same view the user closed on. Read back in the constructor's
  // ViewState init (priority: lastTab → defaultView → "week").
  // see USER_STORIES.md
  setTab(tab: TabKey) {
    const builtIn = this.plugin.settings.queryPresets.find((view) => view.id === this.builtinSavedViewIdForTab(tab));
    if (builtIn) {
      this.activateSavedView(builtIn);
      return;
    }
    this.state.tab = tab;
    if (tab !== "list") this.plugin.settings.lastTab = tab;
    this.plugin.saveSettings().catch(() => undefined);
    this.render();
  }

  render() {
    const el = this.contentEl;
    // Preserve scroll position of the body across rebuilds
    const oldBody = el.querySelector(".bt-body");
    const savedScrollTop = oldBody ? (oldBody as HTMLElement).scrollTop : 0;

    el.empty();
    el.addClass("task-center-view");

    // US-414 / US-415: when legacy view data was detected at load, the board
    // must NOT render — instead the whole view becomes a full-screen upgrade
    // gate. This guarantees the board never has to cope with two data shapes:
    // the migration is confirmed (and persisted) here before any tab/toolbar/
    // body is drawn.
    if (this.plugin.migratedLegacyCount > 0) {
      renderMigrationGate(el, this.plugin);
      return;
    }

    // Prebuild id→task index for O(1) parent/child lookups (§7.3).
    this._taskIndex = new Map();
    for (const t of this.tasks) this._taskIndex.set(t.id, t);
    // Settings can change between renders; recomputing the layout attr is
    // cheap and keeps the data attribute in sync without a separate hook.
    this.applyMobileLayoutAttr();

    const header = el.createDiv({ cls: "bt-header" });
    renderTabBar(this, header);
    this.renderMobileStatusRow(header);
    renderToolbar(this, header);

    const body = el.createDiv({ cls: "bt-body" });
    if (this.tasks.length === 0) {
      this.renderOnboarding(body);
    } else {
      this.renderViewLayout(body);
    }

    this.renderFooter(el);
    this.renderMobileActionBar(el);
    this.updateViewLayoutMetrics();

    // Restore scroll after layout settles
    if (savedScrollTop > 0) {
      const newBody = el.querySelector(".bt-body");
      if (newBody) {
        // rAF ensures contents are laid out so scrollTop clamps correctly
        window.requestAnimationFrame(() => {
          newBody.scrollTop = savedScrollTop;
        });
      }
    }
  }

  /**
   * US-507 (mobile portion): on narrow viewports there's no Obsidian status
   * bar slot, so we mirror `📋 N today · ⚠ M overdue` inside the board
   * header. Always rendered; styles.css hides it on ≥600px (where the real
   * status bar widget is visible).
   */
  private renderMobileStatusRow(header: HTMLElement) {
    const row = header.createDiv({ cls: "bt-mobile-status" });
    const today = todayISO();
    const effectiveTasks = this.getEffectiveTasks();
    const todo = effectiveTasks.filter((t) => t.effectiveStatus === "todo");
    const todayCount = todo.filter((t) => t.effectiveScheduled === today && t.isTopLevelInQuery).length;
    const overdue = todo.filter((t) => t.effectiveDeadline && t.effectiveDeadline < today && t.isTopLevelInQuery).length;
    // task #43: same i18n keys as the desktop status bar so the two
    // surfaces stay in lock-step under any locale.
    const parts = [tr("status.today", { n: todayCount })];
    if (overdue > 0) parts.push(tr("status.overdue", { n: overdue }));
    row.setText(parts.join(" · "));
  }

  /**
   * US-502 / US-507 mobile sticky action bar: explicit thumb-reachable
   * entries only. Mobile has no abandon drop target; abandon lives in
   * swipe / action-sheet paths, while this bar opens Unscheduled + Quick Add.
   */
  private renderMobileActionBar(parent: HTMLElement) {
    const bar = parent.createDiv({ cls: "bt-mobile-action-bar" });
    bar.dataset.mobileEntry = "true";

    const unscheduled = bar.createEl("button", {
      text: tr("tab.unscheduled"),
      cls: "bt-mobile-unscheduled-btn",
    });
    unscheduled.dataset.mobileAction = "open-unscheduled";
    unscheduled.addEventListener("click", () => this.setTab("unscheduled"));

    const add = bar.createEl("button", {
      text: tr("toolbar.add"),
      cls: "bt-mobile-add-btn",
    });
    add.dataset.mobileAction = "quick-add";
    add.addEventListener("click", () => openQuickAdd(this));
  }

  // US-113: empty-state onboarding card — "no tasks yet, press + to add" —
  // shown when the vault has zero parsed tasks. Beats a blank board: the
  // CTA also opens Quick Add so the first task is one click away.
  // see USER_STORIES.md
  private renderOnboarding(parent: HTMLElement) {
    const wrap = parent.createDiv({ cls: "bt-onboarding" });
    wrap.dataset.emptyState = "first-use";
    if (this.contentEl.dataset.mobileLayout === "true") {
      wrap.dataset.mobileEmptyState = "true";
    }
    wrap.createEl("h2", { text: tr("onboarding.title") });
    // UX-mobile §10: mobile body avoids desktop keyboard language.
    wrap.createEl("p", { text: tr(isMobileMode() ? "onboarding.mobileBody" : "onboarding.body") });
    const btn = wrap.createEl("button", { text: tr("onboarding.cta"), cls: "bt-onboarding-cta" });
    btn.dataset.mobileAction = "empty-quick-add";
    btn.addEventListener("click", () => openQuickAdd(this));
  }

  // ---------- Header ----------

  // UX.md §3.0: the time-range selector belongs to the time-axis views
  // (week / month), not the global toolbar. On desktop it is rendered by the
  // week / month component itself (see renderWeek / renderMonth) so the
  // toolbar can collapse to a single row (search + filter chips). On mobile
  // the two-row rule (§6.2) keeps the date nav in the toolbar's first row.
  // `data-action="nav-*"` is the stable e2e selector regardless of where the
  // nav lives in the DOM.
  renderRangeNav(parent: HTMLElement) {
    if (this.state.tab !== "week" && this.state.tab !== "month") return;
    const nav = parent.createDiv({ cls: "bt-nav" });
    const prev = nav.createEl("button", { text: "◀" });
    prev.dataset.action = "nav-prev";
    const todayLabel =
      this.state.tab === "week"
        ? tr("toolbar.weekNo", { n: isoWeekNumber(this.state.anchorISO) })
        : tr("toolbar.monthNo", { n: Number(this.state.anchorISO.slice(5, 7)) });
    const today = nav.createEl("button", { text: todayLabel });
    today.dataset.action = "nav-today";
    const next = nav.createEl("button", { text: "▶" });
    next.dataset.action = "nav-next";
    const label = nav.createSpan({ cls: "bt-nav-label" });
    label.setText(this.navLabel());
    // US-109p9: week / month no longer carry a bespoke filter chip here. Their
    // filter / summary / title edit entry is the shared area head 编辑 button
    // (renderAreaHead), same as list / grid.

    prev.addEventListener("click", () => {
      this.state.anchorISO =
        this.state.tab === "week"
          ? addDays(this.state.anchorISO, -7)
          : shiftMonth(this.state.anchorISO, -1);
      this.render();
    });
    next.addEventListener("click", () => {
      this.state.anchorISO =
        this.state.tab === "week"
          ? addDays(this.state.anchorISO, 7)
          : shiftMonth(this.state.anchorISO, 1);
      this.render();
    });
    today.addEventListener("click", () => {
      this.state.anchorISO = todayISO();
      this.render();
    });
  }

  renderSavedViewsActionControls(
    parent: HTMLElement,
    rerenderControls?: FilterControlsRerender,
    options: { includeSaveAs?: boolean; includeDsl?: boolean; includeManage?: boolean; contextualSaveAs?: boolean } = {},
  ): void {
    const selectedView = this.activeSavedView();
    const dirty = this.isSelectedSavedViewDirty(selectedView);

    const makeSaveAs = () => {
      const save = parent.createEl("button", { text: tr("savedViews.save"), cls: "bt-saved-view-save" });
      save.dataset.action = "save-current-view";
      save.addEventListener("click", () => {
        void (async () => {
          const name = await askSavedViewName(this, `${selectedView.name} Copy`);
          if (!name || !name.trim()) return;
          await saveCurrentView(this, name.trim());
          this.refreshFilterControls(rerenderControls);
        })();
      });
    };

    if (dirty) {
      const update = parent.createEl("button", {
        text: tr("savedViews.update"),
        cls: "bt-saved-view-save bt-saved-view-save--primary",
      });
      update.dataset.action = "update-current-view";
      update.addEventListener("click", () => {
        void (async () => {
          await this.updateCurrentSavedView(selectedView);
          this.refreshFilterControls(rerenderControls);
        })();
      });

      // DESIGN §5.0: "另存为新 tab" is a current-query action — surface it only
      // when there is a draft to save (Office-style contextual command).
      if (options.includeSaveAs && options.contextualSaveAs) makeSaveAs();

      const discard = parent.createEl("button", {
        text: tr("savedViews.discard"),
        cls: "bt-saved-view-save",
      });
      discard.dataset.action = "discard-current-view";
      discard.addEventListener("click", () => {
        this.discardCurrentDraft();
        this.refreshFilterControls(rerenderControls);
      });
    }

    // Non-contextual save-as (the full Query Editor panel) stays always visible.
    if (options.includeSaveAs && !options.contextualSaveAs) makeSaveAs();

    if (options.includeDsl) {
      // US-109p10: single editor entry. Opens the unified 编辑视图 (Tab) panel,
      // where DSL is a section alongside layout / save-as / manage — no separate
      // DSL modal anymore.
      const dsl = parent.createEl("button", {
        text: tr("savedViews.editQuery"),
        cls: "bt-saved-view-save",
      });
      dsl.dataset.action = "edit-current-view-dsl";
      dsl.addEventListener("click", () => this.openQueryControlsSheet({ scope: "tab" }));
    }

    if (options.includeManage) {
      const manage = parent.createEl("button", {
        text: tr("savedViews.manage"),
        cls: "bt-saved-view-save",
      });
      manage.dataset.action = "manage-query-tabs";
      manage.addEventListener("click", () => openManageTabsSheet(this));
    }
  }

  openPluginSettings(): void {
    const setting = (this.app as unknown as {
      setting: { open: () => void; openTabById: (id: string) => void };
    }).setting;
    setting.open();
    setting.openTabById("task-center");
  }

  visibleQueryTabs(): QueryPreset[] {
    return visibleQueryPresets(this.plugin.settings.queryPresets);
  }

  savedViewLabels(): Record<"today" | "week" | "month" | "completed" | "unscheduled", string> {
    return {
      today: tr("tab.today"),
      week: tr("tab.week"),
      month: tr("tab.month"),
      completed: tr("tab.completed"),
      unscheduled: tr("tab.unscheduled"),
    };
  }

  isViewCurrentlyActive(view: QueryPreset): boolean {
    return view.id === this.state.savedViewId;
  }

  private builtinSavedViewIdForTab(tab: TabKey): string | null {
    switch (tab) {
      case "today":
        return builtinSavedViewId("today");
      case "week":
        return builtinSavedViewId("week");
      case "month":
        return builtinSavedViewId("month");
      case "completed":
        return builtinSavedViewId("completed");
      case "unscheduled":
        return builtinSavedViewId("unscheduled");
      case "list":
      default:
        return null;
    }
  }

  legacyTabForSavedView(view: QueryPreset): TabKey | null {
    const normalized = normalizeQueryPreset(view);
    if (normalized.id === builtinSavedViewId("today")) return "today";
    if (normalized.id === builtinSavedViewId("week")) return "week";
    if (normalized.id === builtinSavedViewId("month")) return "month";
    if (normalized.id === builtinSavedViewId("completed")) return "completed";
    if (normalized.id === builtinSavedViewId("unscheduled")) return "unscheduled";
    return this.tabForSavedView(normalized, "list");
  }

  private activateSavedViewById(id: string): void {
    const view = this.plugin.settings.queryPresets.find((item) => item.id === id);
    if (!view) return;
    this.activateSavedView(view);
  }

  activateSavedView(view: QueryPreset): void {
    const current = this.activeSavedView();
    if (current.id !== view.id && this.isSelectedSavedViewDirty(current)) {
      new SwitchTabConfirmModal(
        this.app,
        () => {
          void (async () => {
            await this.updateCurrentSavedView(current);
            this.persistCurrentDraft();
            this.applySavedView(view);
            this.render();
          })();
        },
        () => {
          this.persistCurrentDraft();
          this.applySavedView(view);
          this.render();
        },
      ).open();
      return;
    }
    this.persistCurrentDraft();
    this.applySavedView(view);
    this.render();
  }

  public openManageTabs(): void {
    openManageTabsSheet(this);
  }

  // US-109n1: inline rename from the Tab panel's name input — renames the active
  // tab directly (no modal), keeping any draft's name in sync so the snapshot
  // doesn't revert it.
  setActiveTabName(name: string): void {
    const trimmed = name.trim();
    const active = this.activeSavedView();
    if (!trimmed || trimmed === active.name) return;
    this.plugin.settings.queryPresets = renameQueryPresetById(this.plugin.settings.queryPresets, active.id, trimmed);
    const draft = this.tabDrafts.get(active.id);
    if (draft) this.tabDrafts.set(active.id, normalizeQueryPreset({ ...draft, name: trimmed }));
    void this.plugin.saveSettings();
    this.render();
  }

  // US-109z2: there is no tab-level filter anymore, so the global filter state
  // is always empty — these are constant false. (Per-area `when` does the
  // narrowing inside projection / the area renderers.)
  private hasSaveableFilters(): boolean {
    return false;
  }

  hasActiveFilters(): boolean {
    return false;
  }

  /**
   * VAL-GUI-010: Empty-state explanations distinguish between:
   * 1. Vault has no tasks at all
   * 2. Current filters produce no results (with clear/switch actions)
   */
  renderFilterEmptyState(parent: HTMLElement): void {
    const empty = parent.createDiv({ cls: "bt-filter-empty" });
    empty.dataset.emptyState = "filters";

    const icon = empty.createDiv({ cls: "bt-filter-empty-icon" });

    // Distinguish: is the vault completely empty or just filtered empty?
    const totalAll = this.tasks.length;
    if (totalAll === 0) {
      setIcon(icon, "inbox");
      empty.createDiv({ text: tr("filters.emptyVault"), cls: "bt-filter-empty-title" });
      empty.createDiv({ text: tr("filters.emptyVaultHint"), cls: "bt-filter-empty-hint" });
    } else {
      setIcon(icon, "search-x");
      empty.createDiv({ text: tr("filters.emptyFiltersTitle"), cls: "bt-filter-empty-title" });
      empty.createDiv({ text: tr("filters.emptyFiltersHint"), cls: "bt-filter-empty-hint" });
      const actions = empty.createDiv({ cls: "bt-filter-empty-actions" });
      const clear = actions.createEl("button", { text: tr("filters.clear"), cls: "bt-filter-empty-clear" });
      clear.dataset.action = "clear-filters";
      clear.addEventListener("click", () => {
        this.resetActiveFilters();
        this.render();
      });
    }
  }

  // US-109p10: the Query editor panel lives in view/query-editor.ts now. Entry
  // points (toolbar / tab menu / area head) call this thin delegator.
  openQueryControlsSheet(
    opts: { scope?: QueryEditorScope; areaIndex?: number | null; areaTab?: QueryEditorAreaTab } = {},
  ): void {
    this.queryEditor.open(opts);
  }

  // US-109p9 / US-109z2: resolve an area's `when` by DFS index from the live tab
  // draft, so the Area panel filter tab edits the same object the DSL and area
  // head edit. Every task-rendering area is filterable (list / grid / week /
  // month) — only `drop` / `unknown` return null. Capability decided by the
  // single `areaSupportsWhen` guard, not ad-hoc type checks here.
  // Public: read by QueryEditorView (view/query-editor.ts) and renderAreaHead.
  areaWhenByIndex(areaIndex: number): QueryPresetFilters | null {
    const snapshot = this.currentQuerySnapshot(this.activeSavedView());
    const target = collectAreas(snapshot.view.layout)[areaIndex];
    if (target && areaSupportsWhen(target)) {
      return target.when ?? {};
    }
    return null;
  }

  private navLabel(): string {
    if (this.state.tab === "week") {
      const start = startOfWeek(this.state.anchorISO, this.plugin.settings.weekStartsOn);
      const end = addDays(start, 6);
      // Compact MM-DD → MM-DD; the year is already implied by the week button.
      return `${start.slice(5)} → ${end.slice(5)}`;
    } else if (this.state.tab === "month") {
      const d = fromISO(this.state.anchorISO);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    }
    return "";
  }

  // ---------- Week ----------

  // US-101: 7-day Mon–Sun (or Sun–Sat per settings) week view, today
  // highlighted, prev/next-week navigation. Desktop day columns are
  // makeDropZone targets so cards dragged across columns rewrite ⏳
  // (US-121). Mobile renders the same columns as vertical rows, but there
  // is no touch drop target (US-503 / US-507).
  // see USER_STORIES.md
  // US-109z2 / US-109x: filter a task set by an area's own `when` (the single
  // source of per-area filtering). Week / month areas must scope by this — they
  // previously used the removed global getTextFilter and so ignored area `when`.
  // `today` = the active anchor; justCompletedIds keeps US-153 linger semantics.
  scopeTasksToArea(tasks: EffectiveTask[], when: QueryPresetFilters | undefined): EffectiveTask[] {
    return when && queryFilterHasActiveConditions(when)
      ? applyQueryFilters(tasks, when, this.plugin.settings.weekStartsOn, this.state.anchorISO, this.justCompletedIds)
      : tasks;
  }

  /**
   * If a task's parent is also in the visible set, hide the child at the top
   * level — it will still render inside the parent's children block.
   *
   * US-143: parent-visible cards never duplicate the same child as a
   *  standalone top-level card; the child rides inside the parent's
   *  children block. This is the implementation of "child not duplicated
   *  as top-level when parent is visible".
   * US-148 carve-out: a child that has its OWN `⏳` different from the
   * parent's must NOT be hidden by the "parent has scheduled" branch — it
   * needs to surface in its own day column as a top-level card. Only hide
   * children that lack an independent schedule (so they ride with the
   * parent) or that share the parent's day (already represented by the
   * parent card).
   * see USER_STORIES.md
   */
  private hideChildrenOfVisibleParents(visible: ParsedTask[]): ParsedTask[] {
    const ids = new Set(visible.map((t) => t.id));
    return visible.filter((t) => {
      if (t.parentLine === null) return true;
      const parentId = `${t.path}:L${t.parentLine + 1}`;
      // Already in this list? Parent will render the child inline — but
      // only if the child rides with the parent (no independent ⏳ or
      // same day). Otherwise we want both: parent card without this
      // child, and the child as a top-level card on its own day.
      if (ids.has(parentId)) {
        const parent = this.findParentTask(t);
        return parent ? this.hasIndependentDateFromParent(t, parent) : true;
      }
      // Parent lives in another day column (has its own ⏳).
      const parent = this._taskIndex.get(parentId);
      if (parent && parent.scheduled) {
        // Only hide when the child rides with the parent — no independent
        // ⏳, or matching ⏳ (which is already covered by the parent card).
        if (!this.hasIndependentDateFromParent(t, parent)) return false;
      }
      return true;
    });
  }

  private hasIndependentDateFromParent(child: ParsedTask, parent: ParsedTask): boolean {
    const parentDate = parent.scheduled;
    if (child.scheduled && child.scheduled !== parentDate) return true;
    if (child.completed && child.completed !== parentDate) return true;
    if (child.cancelled && child.cancelled !== parentDate) return true;
    return false;
  }

  private findParentTask(t: ParsedTask): ParsedTask | undefined {
    if (t.parentLine === null) return undefined;
    return this._taskIndex.get(`${t.path}:L${t.parentLine + 1}`);
  }

  /**
   * Mobile-only: long-press a card → bottom sheet with task actions.
   * Mirrors the desktop right-click menu (UX-mobile.md §5.1 / US-506)
   * into a single thumb-reachable surface. Buttons call the same `api.*`
   * methods as the desktop UI; rendered as a flat list of large tap targets.
   */
  /**
   * Mobile default card tap: task details first, source Markdown only by
   * explicit action. This keeps the touch path small while still preserving
   * US-168's source-edit capability.
   */
  openMobileTaskDetailSheet(t: EffectiveTask): void {
    let sheet: BottomSheet | null = null;
    const run = async (op: () => Promise<unknown>) => {
      sheet?.close();
      try {
        await op();
      } catch (err) {
        new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
      }
      this.scheduleRefresh();
    };

    const scheduleWithPicker = async () => {
      const date = await openMobileDatePicker(this.app, {
        initialISO: t.effectiveScheduled ?? todayISO(),
        weekStartsOn: this.plugin.settings.weekStartsOn,
      });
      if (date !== null) await this.api.schedule(t.id, date);
    };

    sheet = new BottomSheet(this.app, {
      title: t.title,
      populate: (el) => {
        const detail = el.createDiv({ cls: "bt-mobile-task-detail" });
        detail.createDiv({ cls: "bt-sheet-source", text: `${t.path}:L${t.line + 1}` });

        const meta = detail.createDiv({ cls: "bt-mobile-task-detail-meta" });
        if (t.effectiveScheduled) meta.createSpan({ text: `⏳ ${t.effectiveScheduled}` });
        else meta.createSpan({ text: tr("sheet.unscheduled") });
        if (t.effectiveDeadline) meta.createSpan({ text: `📅 ${t.effectiveDeadline}` });
        if (t.estimate) meta.createSpan({ text: tr("meta.est", { dur: formatMinutes(t.estimate) }) });
        if (t.actual) meta.createSpan({ text: tr("meta.act", { dur: formatMinutes(t.actual) }) });
        for (const tag of taskDisplayTags(t.tags)) meta.createSpan({ text: tag });

        const primary = detail.createDiv({ cls: "bt-mobile-task-detail-actions" });
        const action = (id: string, text: string, fn: () => Promise<unknown>, danger = false) => {
          const btn = primary.createEl("button", {
            cls: "bt-sheet-action" + (danger ? " bt-sheet-action-danger" : ""),
            text,
          });
          btn.dataset.mobileDetailAction = id;
          btn.addEventListener("click", () => { void run(fn); });
        };

        action(
          "done",
          t.effectiveStatus === "done" ? tr("sheet.markUndone") : tr("sheet.done"),
          () => (t.effectiveStatus === "done" ? this.api.undone(t.id) : this.api.done(t.id)),
        );
        action("schedule", t.effectiveScheduled ? tr("sheet.reschedule") : tr("sheet.schedule"), scheduleWithPicker);
        if (t.effectiveScheduled) {
          action("clear-schedule", tr("sheet.scheduleClear"), () => this.api.schedule(t.id, null));
        }
        action("drop", tr("sheet.drop"), () => this.api.drop(t.id), true);

        const secondary = detail.createDiv({ cls: "bt-mobile-task-detail-secondary" });
        const secondaryAction = (id: string, text: string, fn: () => Promise<unknown>) => {
          const btn = secondary.createEl("button", { cls: "bt-sheet-action bt-sheet-action-secondary", text });
          btn.dataset.mobileDetailAction = id;
          btn.addEventListener("click", () => { void run(fn); });
        };
        secondaryAction("tag", tr("sheet.editTag"), async () => {
          const initialTags = taskDisplayTags(t.tags);
          const initialSet = new Set(initialTags);
          const suggestions = taskDisplayTags(
            this.getEffectiveTasks().flatMap((task) => taskDisplayTags(task.tags)),
          )
            .filter((tag) => !initialSet.has(tag))
            .slice(0, 16);
          const edit = await openMobileTagEditor(this.app, { initialTags, suggestions });
          if (edit !== null) await this.applyTagEditResult(t, edit);
        });
        secondaryAction("nest", tr("sheet.nest"), async () => {
          const parentId = await openParentPickerForTask(this, t);
          if (parentId !== null) await this.nestFromMobile(t, parentId);
        });
        secondaryAction("source", tr("sheet.editSource"), () => openSourceEditShell(this, t));
      },
    });
    sheet.open();
  }

  /**
   * Mobile nest commit. The picker only chooses a parent id; the actual
   * mutation still goes through the shared API/writer path used by desktop
   * drag and CLI nest.
   */
  private async nestFromMobile(t: EffectiveTask, parentId: string): Promise<void> {
    const parent = this._taskIndex.get(parentId) ?? this.tasks.find((candidate) => candidate.id === parentId);
    const awaitCachePaths = parent ? [t.path, ...(parent.path !== t.path ? [parent.path] : [])] : [t.path];
    const result = await this.api.nest(t.id, parentId);
    if (!result.unchanged) {
      const message = tr("notice.nested", {
        title: parent?.title ?? parentId,
        where: result.crossFile ? tr("notice.crossFile") : "",
      });
      if (result.undoOps && result.undoOps.length > 0) {
        this.undoStack.push({
          label: `nest under "${(parent?.title ?? parentId).slice(0, 20)}"`,
          ops: result.undoOps,
        });
        this.showUndoableNotice(message);
      } else {
        new Notice(message);
      }
    }
    await this.waitForCacheUpdate(awaitCachePaths);
  }

  private showUndoableNotice(message: string, duration = 5000): void {
    const notice = new Notice(message, duration);
    const undo = notice.messageEl.createSpan({
      text: `  ${tr("notice.undoAction")}`,
      cls: "bt-notice-undo",
    });
    let used = false;
    undo.addEventListener("click", () => {
      if (used) return;
      used = true;
      notice.hide();
      void this.undoStack.pop();
    });
  }

  /**
   * Opens a bottom sheet for parent selection. It is intentionally not a
   * raw "search + click commits" list: choosing a parent changes task
   * structure, so mobile users get context, disabled invalid rows, and an
   * explicit confirmation button before the shared nest writer runs.
   */
  private async applyTagEditResult(t: EffectiveTask, edit: TagEditResult): Promise<void> {
    for (const tag of edit.remove) await this.api.tag(t.id, tag, true);
    for (const tag of edit.add) await this.api.tag(t.id, tag);
  }

  // US-123: bottom abandon target — dragging a card here marks it
  // `[-] ❌ today` (abandoned), and by US-124 cascades to its `todo`
  // descendants while preserving already-done children as history.
  // `data-drop-zone="abandon"` is the desktop selector contract; the visible
  // UI intentionally avoids trash/delete wording. Mobile does not render an
  // abandon drop zone.
  // see USER_STORIES.md
  renderTrashZone(parent: HTMLElement) {
    // US-109p9: drop zone has no query (no title / 编辑 entry), but reserves an
    // equal-height empty head so it lines up with sibling areas that do.
    parent.addClass("bt-has-head");
    parent.createDiv({ cls: "bt-area-head bt-area-head--empty" });
    const trash = parent.createDiv({ cls: "bt-trash" });
    // e2e drop-zone selector: `[data-drop-zone="abandon"]`. Stable across the
    // visible icon / label / theme. Desktop-only; mobile abandon is handled
    // by swipe / action sheet.
    trash.dataset.dropZone = "abandon";
    // D1: linear lucide icon (inherits currentColor → follows the danger
    // state) instead of the platform-inconsistent `⏹` emoji.
    const icon = trash.createDiv({ cls: "bt-trash-icon" });
    setIcon(icon, "circle-slash");
    const label = trash.createDiv({ cls: "bt-trash-label" });
    label.createSpan({ text: tr("trash.title"), cls: "bt-trash-title" });
    label.createSpan({
      text: tr("trash.hint"),
      cls: "bt-trash-hint",
    });
    this.wireTrashDropTarget(trash);
  }

  /**
   * Wires `dragover` / `dragleave` / `drop` for the desktop abandon target.
   * Drop = `api.drop(id)` (mark `[-] ❌`). Mobile does not call this helper;
   * its abandon paths are explicit swipe / action sheet operations.
   */
  private wireTrashDropTarget(el: HTMLElement) {
    el.addEventListener("dragover", (e) => {
      const dt = e.dataTransfer;
      if (!dt || !dt.types.includes("text/task-id")) return;
      e.preventDefault();
      dt.dropEffect = "move";
      el.addClass("drop-hover");
    });
    el.addEventListener("dragleave", () => el.removeClass("drop-hover"));
    el.addEventListener("drop", (e) => {
      void (async () => {
        const dt = e.dataTransfer;
        if (!dt) return;
        const id = dt.getData("text/task-id");
        if (!id) return;
        e.preventDefault();
        el.removeClass("drop-hover");
        // US-128: push abandon mutations to the undo stack so the user
        // can recover via Ctrl/Cmd+Z. Same pattern as makeDropZone and
        // swipeAction — capture the before/after byte diff.
        const task = this.tasks.find((t) => t.id === id);
        const work = async () => {
          const r = await this.api.drop(id);
          if (!r.unchanged && task) {
            // fix-m4-abandon-undo-cascade: record one UndoOp per affected
            // line (parent + cascaded children) so Ctrl/Cmd+Z restores
            // the entire cascade atomically.
            const ops = (r.results ?? []).map((d) => ({
              path: d.path,
              line: d.line,
              before: [d.before],
              after: [d.after],
            }));
            this.undoStack.push({
              label: tr("dnd.droppedUndo"),
              ops,
            });
          }
          new Notice(tr("trash.dropped"));
        };
        try {
          await this.runWithRemoveAnim(id, work);
        } catch (err) {
          new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
          this.scheduleRefresh();
        }
      })();
    });
  }

  /**
   * Unknown area rendering: graceful degradation for an unsupported area
   * `type` (e.g. a typo, or a config written against a removed view type like
   * the old `matrix`). Shows a "未知类型" notice plus the raw node JSON so the
   * user can see and fix what they wrote, instead of silently dropping it.
   */
  renderUnknownArea(parent: HTMLElement, area: UnknownAreaConfig): void {
    const wrapper = parent.createDiv({ cls: "bt-unknown-area" });
    wrapper.dataset.view = "unknown";
    wrapper.createDiv({
      cls: "bt-unknown-area-title",
      text: tr("area.unknownType", { type: area.rawType }),
    });
    wrapper.createDiv({ cls: "bt-unknown-area-hint", text: tr("area.unknownHint") });
    const pre = wrapper.createEl("pre", { cls: "bt-unknown-area-json" });
    pre.setText(JSON.stringify(area.raw, null, 2));
  }

  // ── View = area 布局树（ARCHITECTURE.md §1.3 / §4.3）──
  // 遍历 active view 的 layout：row / col 容器递归排列，叶子 area 派发到
  // 对应组件。没有 today / completed / unscheduled 专属渲染分支。
  private renderViewLayout(parent: HTMLElement): void {
    // Render from the draft-merged preset so per-area `when` edits take effect.
    const active = this.effectiveSavedView();
    const layout: LayoutNode = active.view?.layout ?? { type: "list" };
    const root = parent.createDiv({ cls: "bt-view-root" });
    // Tag the view root with the legacy tab name (today/week/month/…) so stable
    // e2e selectors like `[data-view="today"]` keep resolving after the layout
    // refactor moved per-tab rendering into the generic area tree.
    const legacyTab = this.legacyTabForSavedView(active);
    if (legacyTab) root.dataset.view = legacyTab;
    // Reset the DFS area counter so each rendered area's index lines up with
    // collectAreas(layout) order — setAreaWhen uses it to address the draft.
    this.renderAreaCounter = 0;
    // Reset the per-pass "first content area" guard before walking the layout.
    this.firstContentPlaced = false;
    this.renderLayoutNode(root, layout);
  }

  private renderLayoutNode(parent: HTMLElement, node: LayoutNode): void {
    if (isStackNode(node)) {
      const box = parent.createDiv({ cls: `bt-stack bt-stack-${node.dir}` });
      if (node.weight) box.style.flexGrow = String(node.weight);
      // If any area in a row has a (localized) header, mark the row so its
      // header-less siblings (e.g. the drop zone) get a matching top offset
      // and align with the titled area's content.
      if (node.dir === "row") {
        const hasTitledChild = node.children.some(
          (c) => !isStackNode(c)
            && areaHandler(c.type).rendersTasks()
            && this.localizeBuiltinTitle(c.id, c.title) !== "",
        );
        if (hasTitledChild) box.addClass("bt-row-has-head");
      }
      for (const child of node.children) this.renderLayoutNode(box, child);
      return;
    }
    const areaEl = parent.createDiv({ cls: `bt-area bt-area-${node.type}` });
    if (node.weight) areaEl.style.flexGrow = String(node.weight);
    // DFS index aligned with collectAreas order; increment for every area node.
    const areaIndex = this.renderAreaCounter++;
    // Render dispatch via the AREA_RENDERERS total registry (mirrors
    // query/projection.ts AREA_PROJECTORS and areas.ts HANDLERS) instead of a
    // switch(node.type): adding an AreaType without a renderer now fails to
    // compile, where the former switch silently skipped it. (REFACTOR.md §4.7 —
    // only this render-registry core was adopted; the AreaKind / AreaView /
    // AreaSettingsSpec framework was reviewed and rejected as over-engineering
    // for a single-host plugin, see ARCHITECTURE §7.13/§7.14.)
    AREA_RENDERERS[node.type](this, areaEl, node, areaIndex);
  }

  // list area：today / TODO / completed / unscheduled / 周月 tray 都走这里。
  // area.when 在已应用的 preset filters 之上再收窄；sections 内部再分组。
  // area.onDrop 把列表区变成放置目标（tray = 拖入清空 ⏳）。
  // Builtin section / area ids → i18n keys. Localized at render so the title
  // follows the UI locale even for presets persisted with English defaults.
  // Unknown ids (user-created) fall back to the verbatim stored title.
  private static readonly BUILTIN_TITLE_KEYS: Record<string, string> = {
    "overdue": "today.groupOverdue",
    "today": "today.groupToday",
    "unscheduled-rec": "today.groupRec",
    "unscheduled-tray": "pool.unscheduled",
  };

  localizeBuiltinTitle(id: string | undefined, fallback: string | undefined): string {
    if (id) {
      const key = TaskCenterView.BUILTIN_TITLE_KEYS[id];
      if (key) return tr(key as Parameters<typeof tr>[0]);
    }
    return fallback ?? "";
  }

  renderListArea(
    parent: HTMLElement,
    area: ListAreaConfig | GridAreaConfig,
    grid: boolean,
    areaIndex: number,
  ): void {
    const filter = this.getTextFilter();
    const filtered = recomputeTopLevelInQuery(this.getEffectiveTasks().filter(filter));
    const model = projectListArea(filtered, area, this.plugin.settings.weekStartsOn, this.justCompletedIds);
    const cardsCls = grid ? "bt-list-grid" : "";

    if (area.onDrop?.clearScheduled) {
      parent.dataset.dropZone = "unscheduled-tray";
      this.makeDropZone(parent, null);
    } else if (area.onDrop?.setScheduled) {
      this.makeDropZone(parent, area.onDrop.setScheduled);
    }

    // US-109p9: every list/grid area (including the unscheduled tray) gets the
    // one shared area head — title + a single 编辑 entry → unified Query editor.
    const isFirstContent = !area.onDrop && !this.firstContentPlaced;
    const rawTitle = this.localizeBuiltinTitle(area.id, area.title);
    const areaTitle = rawTitle || (isFirstContent ? this.effectiveSavedView().name : "");
    if (isFirstContent) {
      this.firstContentPlaced = true;
    }
    this.renderAreaHead(parent, areaIndex, area, { title: areaTitle });

    if (model.grouped) {
      let totalVisible = 0;
      for (const section of model.sections) {
        const sectionTasks = section.tasks.filter((t) => t.isTopLevelInQuery);
        totalVisible += sectionTasks.length;
        const sectionWrap = parent.createDiv({ cls: "bt-list-section" });
        const sectionHead = sectionWrap.createDiv({ cls: "bt-list-section-head" });
        sectionHead.createSpan({
          text: `${this.localizeBuiltinTitle(section.id, section.title)} (${sectionTasks.length})`,
          cls: "bt-list-section-title",
        });
        const sectionBody = sectionWrap.createDiv({ cls: `bt-list-section-body ${cardsCls}`.trim() });
        if (sectionTasks.length === 0) {
          sectionBody.createDiv({ cls: "bt-list-section-empty", text: section.emptyText ?? tr("today.groupEmpty") });
        } else {
          for (const task of sectionTasks) renderCard(this, sectionBody, task);
        }
      }
      if (totalVisible === 0 && !area.onDrop) {
        if (this.tasks.length > 0) this.renderAreaEmptyState(parent, area, areaIndex);
        else parent.createDiv({ text: tr("filters.empty"), cls: "bt-empty" });
      }
      return;
    }

    const list = model.sections[0]?.tasks.filter((t) => t.isTopLevelInQuery) ?? [];
    const wrap = parent.createDiv({ cls: `bt-list-view ${cardsCls}`.trim() });
    wrap.dataset.view = grid ? "grid" : "list";
    if (list.length === 0) {
      // drop-only / tray 区为空时不抢占空状态。
      if (area.onDrop) return;
      if (this.tasks.length > 0) this.renderAreaEmptyState(wrap, area, areaIndex);
      else wrap.createDiv({ text: tr("filters.empty"), cls: "bt-empty" });
      return;
    }
    for (const task of list) renderCard(this, wrap, task);
  }

  // US-109w: per-area empty state. An area empty because of *its own* `when`
  // is a neutral "no tasks here", not a misleading global "clear filters".
  // User feedback: don't offer "clear this area's filter" — in a four-quadrant
  // an empty quadrant is a normal partition, not a filter mistake. Instead the
  // action mirrors the area head's 编辑区域 entry: open this area's settings
  // (Area panel), where the user can decide whether the `when` is wrong.
  private renderAreaEmptyState(
    parent: HTMLElement,
    area: ListAreaConfig | GridAreaConfig,
    areaIndex: number,
  ): void {
    void area;
    const empty = parent.createDiv({ cls: "bt-area-empty" });
    empty.dataset.emptyState = "area";
    const icon = empty.createDiv({ cls: "bt-area-empty-icon" });
    setIcon(icon, "search-x");
    empty.createDiv({ text: tr("area.emptyArea"), cls: "bt-area-empty-title" });
    const edit = empty.createEl("button", { text: tr("savedViews.editArea"), cls: "bt-area-empty-clear" });
    edit.dataset.action = "edit-area";
    edit.addEventListener("click", () => this.openQueryControlsSheet({ scope: "area", areaIndex, areaTab: "filter" }));
  }

  // US-109x: write a list/grid area's `when` into the current tab draft, keyed
  // by its DFS index (collectAreas order). Same data the DSL editor edits.
  // `rerenderControls` lets a host (e.g. the Query editor sheet) rebuild its own
  // body after the edit; the in-place popover passes none and just re-renders
  // the view. (US-109p8)
  setAreaWhen(areaIndex: number, when: QueryPresetFilters, rerenderControls?: FilterControlsRerender): void {
    const active = this.activeSavedView();
    const snapshot = this.currentQuerySnapshot(active);
    const layout = JSON.parse(JSON.stringify(snapshot.view.layout)) as LayoutNode;
    const target = collectAreas(layout)[areaIndex];
    if (target && areaSupportsWhen(target)) {
      target.when = when;
    }
    this.tabDrafts.set(active.id, normalizeQueryPreset({ ...snapshot, view: { layout } }));
    // The editor's rerender callback (view/query-editor.ts) already calls
    // this.v.render(), so the board live-updates on every area `when` edit; here
    // we only refresh the sheet's own controls.
    this.refreshFilterControls(rerenderControls);
  }

  // US-109p9: read the raw (non-localized) title of an area by DFS index from the
  // live draft, for the View tab's title input.
  areaTitleByIndex(areaIndex: number): string {
    const snapshot = this.currentQuerySnapshot(this.activeSavedView());
    const target = collectAreas(snapshot.view.layout)[areaIndex];
    return target?.title ?? "";
  }

  // US-109p9: write an area's title into the tab draft (empty clears it, so the
  // builtin localized fallback shows again). Mirrors setAreaWhen.
  setAreaTitle(areaIndex: number, title: string, rerenderControls?: FilterControlsRerender): void {
    const active = this.activeSavedView();
    const snapshot = this.currentQuerySnapshot(active);
    const layout = JSON.parse(JSON.stringify(snapshot.view.layout)) as LayoutNode;
    const target = collectAreas(layout)[areaIndex];
    if (target) {
      const trimmed = title.trim();
      if (trimmed) target.title = trimmed;
      else delete target.title;
    }
    this.tabDrafts.set(active.id, normalizeQueryPreset({ ...snapshot, view: { layout } }));
    this.refreshFilterControls(rerenderControls);
  }

  // US-109p9: one shared head for every queryable area (list / grid / week /
  // month / tray). Renders the area title + a single 编辑 entry that opens the
  // unified Query editor scoped to this area (Filters tab edits its `when`, View
  // tab its title). This replaces the old in-place funnel popover and the
  // week/month nav filter chip.
  renderAreaHead(
    parent: HTMLElement,
    areaIndex: number,
    area: AreaConfig,
    opts: { title: string; renderNav?: (host: HTMLElement) => void },
  ): void {
    parent.addClass("bt-has-head");
    const head = parent.createDiv({ cls: "bt-area-head" });
    head.dataset.areaHead = String(areaIndex);
    if (opts.title) head.createSpan({ cls: "bt-area-head-title", text: opts.title });
    // week/month 把日期导航（「功能」）放进同一行 head，不再单独占一行。
    if (opts.renderNav) {
      const nav = head.createDiv({ cls: "bt-area-head-nav" });
      opts.renderNav(nav);
    }
    const right = head.createDiv({ cls: "bt-area-head-right" });

    const edit = right.createEl("button", { cls: "bt-area-edit" });
    edit.dataset.areaEdit = String(areaIndex);
    edit.dataset.action = "edit-area";
    edit.setAttr("aria-label", tr("savedViews.editArea"));
    setIcon(edit.createSpan({ cls: "bt-area-edit-icon" }), "sliders-horizontal");
    // User feedback: the area-head edit button must stay quiet — a four-quadrant
    // gives EVERY area a `when` (that IS the quadrant), so an active/highlighted
    // chip on each head was loud noise. Render it like the no-filter state: just
    // the icon, no `active` accent, no `when` summary chip. The full `when`
    // overview lives in the Tab panel's layout tree instead.
    edit.addEventListener("click", () => this.openQueryControlsSheet({ scope: "area", areaIndex, areaTab: "filter" }));
  }

  areaTags(when: QueryPresetFilters): string[] {
    if (Array.isArray(when.tags)) return when.tags;
    if (typeof when.tags === "string") return parseFilterTags(when.tags);
    return [];
  }

  areaFilterSummary(when: QueryPresetFilters): string {
    const parts: string[] = [];
    if (when.search?.trim()) parts.push(`🔍 ${when.search.trim()}`);
    const tags = this.areaTags(when);
    if (tags.length === 1) parts.push(tags[0]);
    else if (tags.length > 1) parts.push(`${tags[0]} +${tags.length - 1}`);
    const status = normalizeQueryStatus(when.status);
    if (status !== "all") parts.push(status.map((s) => statusFilterLabel(s)).join("/"));
    const scheduled = when.time?.scheduled?.trim();
    if (scheduled) parts.push(scheduled === "unscheduled" ? tr("pool.unscheduled") : scheduled);
    return parts.join(" · ");
  }

  private async refreshAfterAction(): Promise<void> {
    await this.plugin.cache.forFlush();
    await this.reloadTasks();
    this.render();
  }

  makeDropZone(el: HTMLElement, targetDate: string | null) {
    el.addEventListener("dragover", (e) => {
      const dt = e.dataTransfer;
      if (!dt || !dt.types.includes("text/task-id")) return;
      e.preventDefault();
      dt.dropEffect = "move";
      el.addClass("drop-hover");
    });
    el.addEventListener("dragleave", () => {
      el.removeClass("drop-hover");
    });
    el.addEventListener("drop", (e) => {
      void (async () => {
        const dt = e.dataTransfer;
        if (!dt) return;
        const id = dt.getData("text/task-id");
        if (!id) return;
        e.preventDefault();
        el.removeClass("drop-hover");
        const task = this.tasks.find((t) => t.id === id);
        // US-122a: when clearing schedule via tray and the task's effective
        // schedule is inherited from a parent (no own ⏳), warn the user
        // instead of silently no-oping. Inherited schedules cannot be
        // cleared by drag — the user must edit source or move the task
        // out of its parent subtree first.
        if (targetDate === null && task && !task.scheduled) {
          const effectiveTask = this.getEffectiveTasks().find((t) => t.id === id);
          if (effectiveTask?.effectiveScheduled) {
            new Notice(tr("dnd.inheritedSchedule"), 4000);
            return;
          }
        }
        const willMove = !task || (task.scheduled ?? null) !== targetDate;
        const work = async () => {
          const r = await this.api.schedule(id, targetDate);
          if (!r.unchanged && task) {
            this.undoStack.push({
              label: targetDate ? `⏳ ${targetDate}` : "⏳ cleared",
              ops: [{ path: task.path, line: task.line, before: [r.before], after: [r.after] }],
            });
            new Notice(
              targetDate ? tr("notice.scheduled", { date: targetDate }) : tr("notice.clearedSchedule"),
            );
          }
        };
        try {
          if (willMove) {
            await this.runWithRemoveAnim(id, work);
          } else {
            await work();
            this.scheduleRefresh();
          }
        } catch (err) {
          new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
          this.scheduleRefresh();
        }
      })();
    });
  }

  /**
   * Build a filter predicate from the text filter controls.
   *
   * Uses effectiveStatus (post terminal-inheritance) and effective dates
   * instead of raw ParsedTask status/time fields, so that children under
   * done/dropped parents are correctly excluded even when their raw
   * checkbox is unchecked.
   */
  getTextFilter(): (t: EffectiveTask) => boolean {
    const q = this.state.filter.trim().toLowerCase();
    const tags = parseFilterTags(this.state.savedViewTag);
    const time = this.state.savedViewTime;
    const status = normalizeQueryStatus(this.state.savedViewStatus);
    if (!q && tags.length === 0 && !this.hasTimeFilters(time) && status === "all") return () => true;
    return (t) => {
      if (q && !taskMatchesText(t, q)) return false;
      for (const tag of tags) {
        if (!taskHasTag(t, tag)) return false;
      }
      if (!this.taskMatchesTimeFilters(t, time)) return false;
      // US-153: a just-completed task bypasses the status predicate only (the
      // base preset.filters layer carries `status: todo` for built-in single-
      // area tabs like Today / TODO). search / tags / time still apply.
      if (status !== "all" && !this.justCompletedIds.has(t.id) && !status.includes(t.effectiveStatus)) return false;
      return true;
    };
  }

  getSavedViewFilter(view: QueryPreset): (t: EffectiveTask) => boolean {
    // US-109z2: the tab badge count derives from the primary content area's
    // own `when` (no tab-level filter anymore).
    const normalized = normalizeQueryPreset(view);
    const areas = collectAreas(normalized.view.layout);
    const primary = areas.find((a) => a.type !== "drop") ?? areas[0];
    const when: QueryPresetFilters =
      primary && primary.type !== "unknown" && primary.type !== "drop"
        ? ((primary as { when?: QueryPresetFilters }).when ?? {})
        : {};
    const q = (when.search ?? "").trim().toLowerCase();
    const tagStr = Array.isArray(when.tags) ? when.tags.join(",") : (when.tags ?? "");
    const tags = parseFilterTags(tagStr);
    const time = when.time ?? {};
    const status = normalizeQueryStatus(when.status);
    if (!q && tags.length === 0 && !this.hasTimeFilters(time) && status === "all") return () => true;
    return (t) => {
      if (q && !taskMatchesText(t, q)) return false;
      for (const tag of tags) {
        if (!taskHasTag(t, tag)) return false;
      }
      if (!this.taskMatchesTimeFilters(t, time)) return false;
      if (status !== "all" && !status.includes(t.effectiveStatus)) return false;
      return true;
    };
  }

  private hasTimeFilters(time: QueryTimeFilters): boolean {
    return Object.values(time).some((value) => !!value?.trim());
  }

  private taskMatchesTimeFilters(task: EffectiveTask, time: QueryTimeFilters): boolean {
    for (const field of ["scheduled", "deadline", "completed", "created"] as QueryTimeField[]) {
      const token = time[field]?.trim();
      if (token && !taskMatchesTimeFilter(task, field, token, this.plugin.settings.weekStartsOn)) return false;
    }
    return true;
  }

  collectTagOptions(selectedTags?: string[]): Array<{ tag: string; count: number }> {
    const options = new Map<string, { tag: string; count: number }>();
    const selected = new Set(
      (selectedTags ?? parseFilterTags(this.state.savedViewTag)).map((t) => t.toLowerCase()),
    );
    const add = (raw: string, count = 0) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      const tag = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
      const key = tag.toLowerCase();
      const existing = options.get(key);
      if (existing) {
        existing.count += count;
      } else {
        options.set(key, { tag, count });
      }
    };
    const q = this.state.filter.trim().toLowerCase();
    const time = this.state.savedViewTime;
    const status = normalizeQueryStatus(this.state.savedViewStatus);
    for (const task of this.getEffectiveTasks()) {
      if (q && !taskMatchesText(task, q)) continue;
      if (!this.taskMatchesTimeFilters(task, time)) continue;
      if (status !== "all" && !status.includes(task.effectiveStatus)) continue;
      for (const tag of task.tags) add(tag, 1);
    }
    for (const view of this.plugin.settings.queryPresets.map((item) => normalizeQueryPreset(item))) {
      for (const tag of parseFilterTags(queryPresetTagString(view))) add(tag);
    }
    for (const tag of selected) add(tag);
    return Array.from(options.values()).sort((a, b) => {
      const aSelected = selected.has(a.tag.toLowerCase());
      const bSelected = selected.has(b.tag.toLowerCase());
      if (aSelected !== bSelected) return aSelected ? -1 : 1;
      if (a.count !== b.count) return b.count - a.count;
      return a.tag.localeCompare(b.tag);
    });
  }

  collectKnownTags(): string[] {
    return this.collectTagOptions().map((option) => option.tag);
  }

  private discardCurrentDraft(): void {
    const active = this.activeSavedView();
    this.tabDrafts.delete(active.id);
    this.applySavedView(active);
  }

  private resetActiveFilters(): void {
    this.state.filter = "";
    this.state.savedViewTag = "";
    this.state.savedViewTime = {};
    this.state.savedViewStatus = "all";
    this.filterPopoverOpen = null;
    this.pendingDateRangeStart = null;
  }

  applySavedView(view: QueryPreset): void {
    // US-153: switching / re-activating a saved view is a genuine "re-enter
    // view" — drop any just-completed exemptions so completed cards from the
    // previous browse settle out by the normal filter.
    this.justCompletedIds.clear();
    const saved = normalizeQueryPreset(view);
    const effective = normalizeQueryPreset(this.tabDrafts.get(saved.id) ?? saved);
    const filters = applyQueryPresetFilters(effective);
    this.state.savedViewId = filters.savedViewId;
    this.state.filter = filters.search;
    this.state.savedViewTag = filters.tag;
    this.state.savedViewTime = filters.time;
    this.state.savedViewStatus = filters.status;
    this.state.tab = this.tabForSavedView(effective, this.state.tab);
    const legacyTab = this.legacyTabForSavedView(saved);
    this.plugin.settings.lastTab = legacyTab && legacyTab !== "list" ? legacyTab : null;
    this.plugin.settings.lastSavedViewId = saved.id;
    this.plugin.saveSettings().catch(() => undefined);
    this.filterPopoverOpen = null;
  }

  private async saveCurrentViewFromDsl(view: QueryPreset): Promise<void> {
    const normalized = normalizeQueryPreset({
      ...view,
      id: createSavedViewId(),
      builtin: false,
      hidden: false,
    });
    this.plugin.settings.queryPresets = upsertQueryPreset(this.plugin.settings.queryPresets, normalized);
    this.tabDrafts.delete(normalized.id);
    this.applySavedView(normalized);
    await this.plugin.saveSettings();
  }

  private async updateCurrentSavedView(existing: QueryPreset): Promise<void> {
    const tags = this.state.savedViewTag ? this.state.savedViewTag.split(",").filter(Boolean) : undefined;
    const view = createQueryPreset(
      existing.name,
      {
        search: this.state.filter,
        tags,
        time: this.state.savedViewTime,
        status: this.state.savedViewStatus,
        view: this.currentQueryPresetViewConfig(),
      },
      () => existing.id,
    );
    this.plugin.settings.queryPresets = updateQueryPresetById(this.plugin.settings.queryPresets, view);
    this.tabDrafts.delete(existing.id);
    this.applySavedView(view);
    await this.plugin.saveSettings();
  }

  private async updateCurrentSavedViewFromDsl(existing: QueryPreset, dslText: string): Promise<void> {
    const parsed = parseQueryDsl(dslText, existing);
    const normalized = normalizeQueryPreset({
      ...parsed,
      id: existing.id,
      builtin: existing.builtin,
    });
    this.plugin.settings.queryPresets = updateQueryPresetById(this.plugin.settings.queryPresets, normalized);
    this.tabDrafts.delete(existing.id);
    this.applySavedView(normalized);
    await this.plugin.saveSettings();
  }

  private selectedSavedView(): QueryPreset | null {
    const view = this.plugin.settings.queryPresets.find((item) => item.id === this.state.savedViewId) ?? null;
    return view ? normalizeQueryPreset(view) : null;
  }

  // US-109x: the active preset MERGED with its unsaved draft (tabDrafts), so the
  // rendered layout/summary reflect in-progress edits — notably per-area `when`
  // set via the area filter popover. `activeSavedView()` returns only the saved
  // preset; the board must render from this instead or filter edits do nothing.
  effectiveSavedView(): QueryPreset {
    const active = this.activeSavedView();
    const draft = this.tabDrafts.get(active.id);
    return draft ? normalizeQueryPreset(draft) : active;
  }

  private persistCurrentDraft(): void {
    const selected = this.selectedSavedView();
    if (!selected) return;
    if (this.isSelectedSavedViewDirty(selected)) {
      this.tabDrafts.set(selected.id, this.currentQuerySnapshot(selected));
    } else {
      this.tabDrafts.delete(selected.id);
    }
  }

  activeSavedView(): QueryPreset {
    const selected = this.selectedSavedView();
    if (selected) return selected;
    const fallback = this.visibleQueryTabs()[0];
    if (fallback) return fallback;
    return normalizeQueryPreset({
      id: builtinSavedViewId("today"),
      name: tr("tab.today"),
      builtin: true,
      hidden: false,
      view: { layout: { type: "list", when: { status: ["todo"] } } },
    });
  }

  currentQuerySnapshot(existing?: QueryPreset | null, name?: string): QueryPreset {
    return computeQueryPresetSnapshot({
      existing,
      tabDrafts: this.tabDrafts,
      filterSearch: this.state.filter,
      filterTags: this.state.savedViewTag,
      filterTime: this.state.savedViewTime,
      filterStatus: this.state.savedViewStatus,
      fallbackView: () => this.currentQueryPresetViewConfig(),
      name: name ?? (existing ? undefined : suggestSavedViewName(this)),
    });
  }

  isSelectedSavedViewDirty(view: QueryPreset): boolean {
    return !sameQueryPresetContent(this.currentQuerySnapshot(view), view);
  }

  private openQueryDslModal(rerenderControls?: FilterControlsRerender): void {
    const selected = this.activeSavedView();
    const snapshot = this.currentQuerySnapshot(selected);
    const initial = stringifyQueryPreset(snapshot);
    new QueryDslModal(this.app, initial, true, async (mode: QueryDslSubmitMode, text: string) => {
      if (mode === "update") {
        await this.updateCurrentSavedViewFromDsl(selected, text);
      } else {
        const parsed = parseQueryDsl(text, { name: suggestSavedViewName(this) });
        await this.saveCurrentViewFromDsl(parsed);
      }
      this.refreshFilterControls(rerenderControls);
    }).open();
  }

  currentQueryPresetViewConfig(): QueryPresetViewConfig {
    // Read from the active saved QueryPreset's view config (draft or saved),
    // falling back to legacy tab-based defaults only when no saved view exists.
    const saved = this.selectedSavedView();
    if (saved) {
      const draft = this.tabDrafts.get(saved.id);
      const effective = draft ?? saved;
      if (effective.view) return effective.view;
    }
    return this.defaultViewConfigForLegacyTab();
  }

  private defaultViewConfigForLegacyTab(): QueryPresetViewConfig {
    switch (this.state.tab) {
      case "week":
        return { layout: { type: "week" } };
      case "month":
        return { layout: { type: "month" } };
      default:
        return { layout: { type: "list" } };
    }
  }

  // state.tab 现在只是「主内容 area 类型」的粗标签，用于日期导航与
  // lastTab 记忆。list 家族（today/todo/completed/unscheduled/dropped）
  // 统一映射成 "list"。
  tabForSavedView(view: QueryPreset, fallback: TabKey): TabKey {
    const config = normalizeQueryPreset(view).view;
    const type = this.primaryAreaType(config);
    if (type === "week") return "week";
    if (type === "month") return "month";
    if (type === "list") return "list";
    return fallback;
  }

  // 布局里第一个非 drop area 的类型（找不到则第一个 area，再退化 list）。
  // unknown area 也归到 list，避免泄漏到 AreaType。
  private primaryAreaType(view: QueryPresetViewConfig): AreaType {
    const areas = collectAreas(view.layout);
    const content = areas.find((a) => a.type !== "drop");
    const type = (content ?? areas[0])?.type ?? "list";
    return type === "unknown" ? "list" : type;
  }

  refreshFilterControls(rerenderControls?: FilterControlsRerender): void {
    if (rerenderControls) rerenderControls();
    else this.render();
  }

  private handleFilterOutsidePointerDown(event: PointerEvent): void {
    // US-109q: close the desktop overflow tabs dropdown on an outside click.
    // Clicks on the menu itself or the "更多" anchor toggle keep / toggle it,
    // so only count clicks landing outside both as "outside".
    if (this.overflowTabsMenuOpen) {
      const insideOverflow = event.composedPath().some(
        (target) =>
          target instanceof HTMLElement &&
          !!target.closest(".bt-overflow-tabs-menu, .bt-tab-more"),
      );
      if (!insideOverflow) {
        this.overflowTabsMenuOpen = false;
        this.render();
      }
    }
    const insideControls = isClickInsideFilterControls(event);
    if (shouldCloseFilterPopoverOnPointerDown({
      isOpen: this.filterPopoverOpen !== null,
      isInsideFilterControls: insideControls,
    })) {
      this.filterPopoverOpen = null;
      this.pendingDateRangeStart = null;
      this.render();
      return;
    }
  }

  // ---------- Footer / Add ----------

  private renderFooter(parent: HTMLElement) {
    const foot = parent.createDiv({ cls: "bt-footer" });
    const info = foot.createDiv({ cls: "bt-footer-info" });
    const effectiveTasks = this.getEffectiveTasks();
    const total = effectiveTasks.filter((t) => t.effectiveStatus === "todo" && t.isTopLevelInQuery).length;
    const done = effectiveTasks.filter((t) => t.effectiveStatus === "done" && t.isTopLevelInQuery).length;
    const overdue = effectiveTasks.filter(
      (t) => t.effectiveStatus === "todo" && t.isTopLevelInQuery && t.effectiveDeadline && t.effectiveDeadline < todayISO(),
    ).length;
    info.setText(tr("footer.status", { todo: total, done, overdue }));

    const selected = this.getSelectedTask();
    if (selected) {
      const bar = foot.createDiv({ cls: "bt-footer-selected" });
      bar.createSpan({
        text: `${tr("footer.selected")}: ${selected.title}`,
        cls: "bt-footer-selected-title",
      });
      bar.createSpan({
        text: ` · ${selected.path}:L${selected.line + 1}`,
        cls: "bt-footer-selected-path",
      });
      // UX-mobile §10: keyboard shortcut hints don't apply on touch — the
      // gestures replace them — so suppress the hint string entirely on
      // mobile. The selected-task line itself remains useful.
      if (!Platform.isMobile) {
        bar.createSpan({
          text: " · " + tr("footer.hint"),
          cls: "bt-footer-selected-hint",
        });
      } else {
        bar.createSpan({
          text: " · " + tr("footer.mobileHint"),
          cls: "bt-footer-selected-hint",
        });
      }
    }
  }

  // ---------- Keyboard ----------

  // US-166 / UX.md §6.8: global desktop hotkeys live here — Ctrl+1~5
  // switch tabs, `/` focuses the search input, Ctrl/Cmd+Z pops the undo
  // stack. Card-level shortcuts were removed with the old README residue.
  // US-501: desktop-only features silently no-op on Obsidian Mobile —
  // returning early here means the board never claims to handle a key
  // the user can't produce. CLI / hover popovers do the same at their
  // respective sites. Layout switching is screen-width based (CSS
  // @media); *capability* gating like this is a Platform check, allowed
  // at the UI layer per UX-mobile §13 #7.
  // see USER_STORIES.md
  handleKey(e: KeyboardEvent): void {
    if (Platform.isMobile) return;

    // US-109q: Esc closes the desktop overflow tabs dropdown.
    if (e.key === "Escape" && this.overflowTabsMenuOpen) {
      e.preventDefault();
      e.stopPropagation();
      this.overflowTabsMenuOpen = false;
      this.render();
      return;
    }

    // Global query-tab switching
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      const tabs = this.visibleQueryTabs().slice(0, 9);
      const target = tabs[Number(e.key) - 1];
      if (target) {
        e.preventDefault();
        this.activateSavedView(target);
        return;
      }
    }

    // Undo (Ctrl/Cmd+Z) — view-scoped undo of the most recent drag/keyboard mutation.
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey && !e.altKey) {
      const active = activeDocument.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      e.preventDefault();
      e.stopPropagation();
      void this.undoStack.pop();
      return;
    }

    // Focus search
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      const active = activeDocument.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      e.preventDefault();
      const search = this.contentEl.querySelector<HTMLInputElement>(".bt-search");
      if (search) {
        search.focus();
        search.select();
      }
      return;
    }

  }

  // Undo stack push / pop now live on `this.undoStack` (UndoStack instance).
  // Kept callsites use `this.undoStack.push(entry)` and
  // `this.undoStack.pop()` — see `./view/undo` for the implementation.

  private getSelectedTask(): ParsedTask | null {
    if (!this.state.selectedTaskId) return null;
    return this.tasks.find((t) => t.id === this.state.selectedTaskId) ?? null;
  }

}
