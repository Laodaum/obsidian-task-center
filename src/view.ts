import {
  ItemView,
  WorkspaceLeaf,
  Menu,
  Notice,
  Platform,
} from "obsidian";
import { ParsedTask, VIEW_TYPE_TASK_CENTER } from "./types";
import { formatMinutes } from "./parser";
import { TaskCenterApi, computeStats } from "./cli";
import {
  todayISO,
  fromISO,
  addDays,
  shiftMonth,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  daysBetween,
  isoWeekNumber,
  pad,
} from "./dates";
import { QuickAddModal } from "./quickadd";
import { DatePromptModal } from "./dateprompt";
import { t as tr, getLocale } from "./i18n";
import { animateOut } from "./anim";
import { TabDwellTracker } from "./view/dnd";
import { UndoStack, UndoEntry, UndoOp } from "./view/undo";
import { BottomSheet } from "./view/bottom-sheet";
import { attachCardGestures } from "./view/touch";
import { shouldCloseFilterPopoverOnPointerDown } from "./view/filter-popover";
import { isMobileMode } from "./platform";
import { openTaskSourceEditShell } from "./view/source-dialog";
import { weekMinHeightFromViewHeightPx } from "./view/layout";
import { SavedViewNameModal } from "./view/saved-view-name-modal";
import { QueryDslModal, type QueryDslSubmitMode } from "./view/query-dsl-modal";
import type { FilterPopoverKey, TabKey, ViewState } from "./view/state";
import { taskDisplayTags } from "./tags";
import { formatDateFilterLabel } from "./date-filter";
import { taskMatchesTimeToken, timeTokenAppliesToField } from "./time-filter";
import {
  applyQueryPresetFilters,
  builtinSavedViewId,
  restoreBuiltinQueryPresetById,
  restoreBuiltinQueryPresets,
  clearQueryPresetFilters as emptySavedViewFilters,
  createSavedViewId,
  createQueryPreset,
  parseQueryDsl,
  sameQueryPresetContent,
  stringifyQueryPreset,
  hasQueryPresetFilters,
  duplicateQueryPreset,
  moveQueryPresetById,
  renameQueryPresetById,
  setQueryPresetHiddenById,
  deleteQueryPresetById,
  normalizeQueryPreset,
  normalizeSavedViewStatus,
  suggestQueryPresetName as suggestSavedViewNameForFilters,
  upsertQueryPreset,
  updateQueryPresetById,
  visibleQueryPresets,
  queryPresetTagString,
} from "./saved-views";
import type {
  QueryPreset,
  QueryPresetViewConfig,
  SavedViewStatus,
  QueryPresetSummaryMetric,
  TaskStatus,
} from "./types";
import type { SavedViewTimeField, SavedViewTimeFilters } from "./types";
import type TaskCenterPlugin from "./main";

const PRIMARY_TIME_FIELD: SavedViewTimeField = "scheduled";
const SECONDARY_TIME_FIELDS: SavedViewTimeField[] = ["deadline", "completed", "created"];
type FilterControlsRerender = () => void;

// `UndoOp` and `UndoEntry` re-exported from `./view/undo` (the canonical
// definitions). Local re-export so existing usage in this file compiles.
export type { UndoOp, UndoEntry };

const WEEKDAY_KEYS = [
  "weekday.0",
  "weekday.1",
  "weekday.2",
  "weekday.3",
  "weekday.4",
  "weekday.5",
  "weekday.6",
] as const;

function weekdayLabel(dow: number): string {
  const label = tr(WEEKDAY_KEYS[dow]);
  return getLocale() === "zh" ? `周${label}` : label;
}

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

function taskTimeValue(t: ParsedTask, field: SavedViewTimeField): string | null {
  if (field === "scheduled") return t.scheduled;
  if (field === "deadline") return t.deadline;
  if (field === "completed") return t.completed;
  return t.created;
}

function taskMatchesTimeFilter(t: ParsedTask, field: SavedViewTimeField, token: string, weekStartsOn: 0 | 1): boolean {
  if (!timeTokenAppliesToField(field, token)) return false;
  return taskMatchesTimeToken(taskTimeValue(t, field), token, weekStartsOn);
}

function taskDateColumn(t: ParsedTask): string | null {
  if (t.status === "todo") return t.inheritsTerminal ? null : t.scheduled;
  if (t.status === "done") return t.completed;
  return null;
}

export class TaskCenterView extends ItemView {
  plugin: TaskCenterPlugin;
  api: TaskCenterApi;
  tasks: ParsedTask[] = [];
  state: ViewState;
  private refreshTimer: number | null = null;
  private cacheVersion = 0;
  private cacheUnsub: (() => void) | null = null;
  /** Prebuilt id→task index for O(1) parent lookups. Rebuilt on each render(). */
  private _taskIndex: Map<string, ParsedTask> = new Map();
  // Cross-tab drag dwell: hovering a card over a tab head for 600ms switches
  // tabs. UX.md §6.1 / ARCHITECTURE.md §11. One tracker for the whole view —
  // tab heads route their dragover events through `update()`.
  private dwellTracker = new TabDwellTracker<string>({
    durationMs: 600,
    onCommit: (id) => this.activateSavedViewById(id),
  });
  // US-128: Ctrl/Cmd+Z undo stack. Only records writes initiated from this
  // view (drag / keyboard / quick-add). CLI writes are not captured —
  // they're scriptable and idempotent enough that auto-undo would be more
  // confusing than helpful (UX.md §6.7). Capped at 20 entries (UndoStack.MAX).
  // see USER_STORIES.md
  private undoStack: UndoStack;
  private filterPopoverOpen: FilterPopoverKey | null = null;
  private dateCalendarAnchorISO = startOfMonth(todayISO());
  private pendingDateRangeStart: string | null = null;
  private viewResizeObserver: ResizeObserver | null = null;
  private tabDrafts = new Map<string, QueryPreset>();

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
    this.registerDomEvent(this.contentEl.ownerDocument, "pointerdown", (e) => this.handleFilterOutsidePointerDown(e));

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
    });
    this.viewResizeObserver = new ResizeObserver(() => this.updateViewLayoutMetrics());
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

  private scheduleRefresh() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      void (async () => {
        this.refreshTimer = null;
        await this.reloadTasks();
        this.bumpCacheVersion();
        this.render();
      })();
    }, 400);
  }

  private bumpCacheVersion() {
    this.cacheVersion++;
    this.contentEl.dataset.testCacheVersion = String(this.cacheVersion);
  }

  private findCardEl(taskId: string): HTMLElement | null {
    return this.contentEl.querySelector(
      `[data-task-id="${CSS.escape(taskId)}"]`,
    );
  }

  private async openSourceEditShell(task: ParsedTask): Promise<void> {
    this.state.selectedTaskId = task.id;
    this.contentEl.focus();
    await openTaskSourceEditShell(this.app, this.leaf, task, {
      onSave: async () => {
        await this.waitForCacheUpdate([task.path], 2000);
        await this.reloadTasks();
        this.bumpCacheVersion();
        this.render();
      },
    });
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
  // US-125 task #33 observability gate. Set
  //   localStorage.setItem("task-center-debug","1")
  // in dev console to enable; reload Obsidian to take effect. Logs are
  // gated so they cost nothing for non-debug users.
  private isDebugLogging(): boolean {
    try {
      return window.localStorage.getItem("task-center-debug") === "1";
    } catch {
      return false;
    }
  }

  private async runWithRemoveAnim(
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
   * Resolve once `TaskCache` has emitted `'changed'` for every file in
   * `paths` (or after `timeoutMs` as a safety net). Used after structural
   * mutations so the next render sees up-to-date list-item line numbers.
   *
   * Reads `cache.on("changed")` (post-reparse), not raw metadataCache
   * (ARCHITECTURE.md §3.1: cache is the sole subscriber to vault events).
   */
  private waitForCacheUpdate(paths: string[], timeoutMs = 1500): Promise<void> {
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
    // Prebuild id→task index for O(1) parent/child lookups (§7.3).
    this._taskIndex = new Map();
    for (const t of this.tasks) this._taskIndex.set(t.id, t);
    // Settings can change between renders; recomputing the layout attr is
    // cheap and keeps the data attribute in sync without a separate hook.
    this.applyMobileLayoutAttr();

    const header = el.createDiv({ cls: "bt-header" });
    this.renderTabBar(header);
    this.renderMobileStatusRow(header);
    this.renderToolbar(header);

    const body = el.createDiv({ cls: "bt-body" });
    if (this.tasks.length === 0) {
      this.renderOnboarding(body);
    } else {
      switch (this.state.tab) {
        case "today":
          this.renderToday(body);
          break;
        case "week":
          this.renderWeek(body);
          this.renderUnscheduledPool(body);
          break;
        case "month":
          this.renderMonth(body);
          this.renderUnscheduledPool(body);
          break;
        case "completed":
          this.renderCompleted(body);
          break;
        case "unscheduled":
          this.renderUnscheduledBig(body);
          break;
        case "list":
          this.renderList(body);
          break;
      }
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
    const todo = this.tasks.filter((t) => t.status === "todo" && !t.inheritsTerminal);
    const todayCount = todo.filter((t) => t.scheduled === today).length;
    const overdue = todo.filter((t) => t.deadline && t.deadline < today).length;
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
    add.addEventListener("click", () => this.openQuickAdd());
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
    btn.addEventListener("click", () => this.openQuickAdd());
  }

  // ---------- Header ----------

  private renderTabBar(parent: HTMLElement) {
    const bar = parent.createDiv({ cls: "bt-tabbar" });
    const tabs = this.visibleQueryTabs();
    // VAL-GUI-005: when there are more than MAX_VISIBLE_TABS, overflow
    // tabs go into a "更多" button. Overflow tabs retain order, badges,
    // default behavior, and keyboard shortcuts.
    const MAX_VISIBLE_TABS = 7;
    const visibleTabs = tabs.slice(0, MAX_VISIBLE_TABS);
    const overflowTabs = tabs.slice(MAX_VISIBLE_TABS);

    for (const [index, view] of visibleTabs.entries()) {
      this.renderTabButton(bar, view, index);
    }

    // Overflow "更多" button
    if (overflowTabs.length > 0) {
      const moreBtn = bar.createDiv({ cls: "bt-tab bt-tab-more" });
      const label = moreBtn.createDiv({ cls: "bt-tab-label" });
      label.createSpan({ text: tr("savedViews.tabMore"), cls: "bt-tab-name" });
      // Show total count of overflow tabs plus their badges
      const overflowCount = overflowTabs.reduce((sum, v) => sum + this.countForSavedView(v), 0);
      if (overflowCount > 0) {
        moreBtn.createSpan({ text: String(overflowCount), cls: "bt-tab-count" });
      }
      moreBtn.title = overflowTabs.map((v) => v.name).join(", ");
      moreBtn.addEventListener("click", () => this.openOverflowTabsMenu(moreBtn, overflowTabs));
      moreBtn.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.openOverflowTabsMenu(event.target as HTMLElement, overflowTabs);
      });
    }
  }

  private renderTabButton(bar: HTMLElement, view: QueryPreset, index: number): void {
    const active = view.id === this.state.savedViewId;
    const dirty = this.isSavedViewDirty(view);
    const badges = this.savedViewBadges(view);
    const btn = bar.createDiv({ cls: "bt-tab" + (active ? " active" : "") });
    const legacyTab = this.legacyTabForSavedView(view);
    if (legacyTab) btn.dataset.tab = legacyTab;
    btn.dataset.queryTabId = view.id;
    btn.dataset.tabId = view.id;
    if (dirty) btn.dataset.queryTabDirty = "true";
    if (this.plugin.settings.defaultSavedViewId === view.id) btn.dataset.queryTabDefault = "true";
    btn.title = badges.length > 0 ? `${view.name} · ${badges.join(" · ")}` : view.name;
    const label = btn.createDiv({ cls: "bt-tab-label" });
    label.createSpan({ text: view.name, cls: "bt-tab-name" });
    if (dirty) {
      label.createSpan({ text: "•", cls: "bt-tab-dirty-dot" });
    }
    const count = this.countForSavedView(view);
    if (count > 0) {
      btn.createSpan({ text: String(count), cls: "bt-tab-count" });
    }
    if (index < 9) {
      btn.createSpan({ text: `⌃${index + 1}`, cls: "bt-hotkey" });
    }
    btn.addEventListener("click", () => this.activateSavedView(view));
    btn.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.renameSavedView(view);
    });
    btn.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openSavedViewMenu(event, view);
    });

    btn.addEventListener("dragover", (e) => {
      const dt = e.dataTransfer;
      if (!dt || !dt.types.includes("text/task-id")) return;
      e.preventDefault();
      dt.dropEffect = "move";
      btn.addClass("drag-hover");
      this.dwellTracker.update(view.id, btn, this.state.savedViewId ?? "");
    });
    btn.addEventListener("dragleave", () => {
      btn.removeClass("drag-hover");
      this.dwellTracker.reset();
    });
  }

  private openOverflowTabsMenu(anchor: HTMLElement, overflowTabs: QueryPreset[]): void {
    const menu = new Menu();
    for (const [index, view] of overflowTabs.entries()) {
      const badge = this.savedViewBadges(view);
      const count = this.countForSavedView(view);
      const label = count > 0 ? `${view.name} (${count})` : view.name;
      menu.addItem((item) => {
        item.setTitle(label);
        if (badge.length > 0) item.setSection("tab-overflow");
        item.onClick(() => this.activateSavedView(view));
      });
      void index; // intentional no-op, index preserved for shortcut order
    }
    // Separator + manage option
    if (overflowTabs.length > 0) {
      menu.addSeparator();
      menu.addItem((item) =>
        item.setTitle(tr("savedViews.manage")).onClick(() => this.openManageTabsSheet()),
      );
    }
    // Position the menu near the "更多" button
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left + rect.width / 2, y: rect.bottom + 4 });
  }

  private renderToolbar(parent: HTMLElement) {
    const bar = parent.createDiv({ cls: "bt-toolbar" });
    const mainRow = bar.createDiv({ cls: "bt-toolbar-row bt-toolbar-main" });
    const subRow = isMobileMode() ? mainRow : bar.createDiv({ cls: "bt-toolbar-row bt-toolbar-sub" });

    // Navigation arrows for week/month
    if (this.state.tab === "week" || this.state.tab === "month") {
      const nav = mainRow.createDiv({ cls: "bt-nav" });
      const prev = nav.createEl("button", { text: "◀" });
      // Stable e2e selector — the visible label changes (in week tab the
      // "today" button shows the week number; in month tab it shows
      // localized "Today"). Tests select via `[data-action="nav-*"]`.
      prev.dataset.action = "nav-prev";
      const todayLabel =
        this.state.tab === "week"
          ? tr("toolbar.weekNo", { n: isoWeekNumber(this.state.anchorISO) })
          : tr("toolbar.today");
      const today = nav.createEl("button", { text: todayLabel });
      today.dataset.action = "nav-today";
      const next = nav.createEl("button", { text: "▶" });
      next.dataset.action = "nav-next";
      const label = nav.createSpan({ cls: "bt-nav-label" });
      label.setText(this.navLabel());
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

    // US-109: title / tag search box. The matching impl in `getTextFilter`
    // also searches across tags so users can type `#3象限` or part of a
    // tag to narrow the board; CLI exposes the same filter via
    // `task-center:list search=…`.
    // see USER_STORIES.md
    const search = mainRow.createEl("input", { type: "text", placeholder: tr("toolbar.filter") });
    search.addClass("bt-search");
    search.value = this.state.filter;
    // §7.3: debounce search input to avoid full teardown+rebuild per keystroke
    let searchTimer: number | null = null;
    search.addEventListener("input", () => {
      const val = search.value;
      const caret = search.selectionStart;
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        searchTimer = null;
        this.state.filter = val;
        this.render();
        const el = this.contentEl.querySelector<HTMLInputElement>(".bt-search");
        if (el) {
          el.focus();
          const pos = caret ?? el.value.length;
          el.selectionStart = el.selectionEnd = pos;
        }
      }, 150);
    });

    if (isMobileMode()) {
      const mobileFilters = mainRow.createEl("button", {
        text: tr("savedViews.editQuery"),
        cls: "bt-mobile-filter-btn",
      });
      mobileFilters.dataset.mobileAction = "filters";
      mobileFilters.addEventListener("click", () => this.openQueryControlsSheet());
    } else {
      this.renderSavedViewsToolbar(subRow);
    }

    const utility = mainRow.createDiv({ cls: "bt-toolbar-utility" });

    // US-163: toolbar `+` opens Quick Add, which writes the new line to
    // today's daily-note tail (the only entry point — see writer.addTask
    // resolution order). Default scheduled = unset; user adds ⏳ inline
    // via Quick Add tokens or schedules later via drag.
    // see USER_STORIES.md
    const add = utility.createEl("button", { text: tr("toolbar.add") });
    add.addClass("bt-add-btn");
    add.addEventListener("click", () => this.openQuickAdd());

    // settings gear
    const gear = utility.createEl("button", { text: "⚙" });
    gear.addClass("bt-gear");
    gear.addEventListener("click", () => {
      (this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.open();
      (this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.openTabById("task-center");
    });
  }

  private renderSavedViewsToolbar(parent: HTMLElement, rerenderControls?: FilterControlsRerender) {
    const wrap = parent.createDiv({ cls: "bt-saved-views" });
    wrap.dataset.savedViews = "true";

    // VAL-GUI-010: Toolbar summary — readable summary of current filter conditions
    this.renderFilterSummary(wrap);

    const filters = wrap.createDiv({ cls: "bt-saved-view-filters" });
    const actions = wrap.createDiv({ cls: "bt-saved-view-actions" });

    this.renderSavedViewsFilterControls(filters, rerenderControls);
    this.renderSavedViewsActionControls(actions, rerenderControls, {
      includeSaveAs: true,
      includeDsl: true,
      includeManage: true,
    });
  }

  /**
   * VAL-GUI-010: Render a readable summary of current filter conditions.
   * Example: "tag:#alpha,#beta · 排期:本周 · 状态:TODO · view:周"
   */
  private renderFilterSummary(parent: HTMLElement): void {
    const summary = parent.createDiv({ cls: "bt-filter-summary" });
    const parts: string[] = [];

    // Search
    if (this.state.filter.trim()) {
      parts.push(`🔍 ${this.state.filter.trim()}`);
    }
    // Tags
    const selectedTags = parseFilterTags(this.state.savedViewTag);
    if (selectedTags.length > 0) {
      const first = selectedTags[0];
      const more = selectedTags.length > 1 ? `+${selectedTags.length - 1}` : "";
      parts.push(`${first}${more}`);
    }
    // Scheduled time
    const scheduledVal = this.state.savedViewTime["scheduled"]?.trim();
    if (scheduledVal) {
      parts.push(`${tr("savedViews.timeScheduled")}:${this.timeFilterLabel("scheduled", scheduledVal)}`);
    }
    // Status
    const status = normalizeSavedViewStatus(this.state.savedViewStatus);
    if (status !== "all") {
      parts.push(tr("savedViews.statusAll") + ":" + status.join(","));
    }
    // More time fields
    const activeMoreFields = ["deadline", "completed", "created"] as const;
    for (const field of activeMoreFields) {
      const val = this.state.savedViewTime[field]?.trim();
      if (val) {
        parts.push(`${this.timeFieldLabel(field)}:${this.timeFilterLabel(field, val)}`);
      }
    }
    // View type
    const active = this.activeSavedView();
    if (active.view?.type && active.view.type !== "list") {
      parts.push(active.view.type);
    }

    if (parts.length === 0) {
      summary.createSpan({ text: tr("savedViews.emptyCondition"), cls: "bt-filter-summary-text bt-filter-summary-empty" });
    } else {
      summary.createSpan({ text: parts.join(" · "), cls: "bt-filter-summary-text" });
    }
  }

  private renderSavedViewsCompactBar(parent: HTMLElement) {
    const wrap = parent.createDiv({ cls: "bt-saved-views" });
    wrap.dataset.savedViews = "true";
    const actions = wrap.createDiv({ cls: "bt-saved-view-actions" });
    const selectedView = this.activeSavedView();
    const dirty = this.isSelectedSavedViewDirty(selectedView);

    const filters = actions.createEl("button", {
      text: tr("savedViews.editQuery"),
      cls: "bt-saved-view-save",
    });
    filters.dataset.action = "open-query-controls";
    filters.addEventListener("click", () => this.openQueryControlsSheet());

    if (dirty) {
      const update = actions.createEl("button", {
        text: tr("savedViews.update"),
        cls: "bt-saved-view-save",
      });
      update.dataset.action = "update-current-view";
      update.addEventListener("click", () => {
        void this.updateCurrentSavedView(selectedView);
      });

      const discard = actions.createEl("button", {
        text: tr("savedViews.discard"),
        cls: "bt-saved-view-save",
      });
      discard.dataset.action = "discard-current-view";
      discard.addEventListener("click", () => {
        this.discardCurrentDraft();
        this.render();
      });
    }

    const manage = actions.createEl("button", {
      text: tr("savedViews.manage"),
      cls: "bt-saved-view-save",
    });
    manage.dataset.action = "manage-query-tabs";
    manage.addEventListener("click", () => this.openManageTabsSheet());
  }

  private renderSavedViewsFilterControls(parent: HTMLElement, rerenderControls?: FilterControlsRerender): void {
    this.renderTagFilter(parent, rerenderControls);
    this.renderTimeFilter(parent, PRIMARY_TIME_FIELD, rerenderControls);
    this.renderMoreTimeFilters(parent, rerenderControls);
    this.renderStatusFilter(parent, rerenderControls);
  }

  private renderSavedViewsActionControls(
    parent: HTMLElement,
    rerenderControls?: FilterControlsRerender,
    options: { includeSaveAs?: boolean; includeDsl?: boolean; includeManage?: boolean } = {},
  ): void {
    const selectedView = this.activeSavedView();
    const dirty = this.isSelectedSavedViewDirty(selectedView);

    if (dirty) {
      const update = parent.createEl("button", {
        text: tr("savedViews.update"),
        cls: "bt-saved-view-save",
      });
      update.dataset.action = "update-current-view";
      update.addEventListener("click", () => {
        void (async () => {
          await this.updateCurrentSavedView(selectedView);
          this.refreshFilterControls(rerenderControls);
        })();
      });

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

    if (options.includeSaveAs) {
      const save = parent.createEl("button", {
        text: tr("savedViews.save"),
        cls: "bt-saved-view-save",
      });
      save.dataset.action = "save-current-view";
      save.addEventListener("click", () => {
        void (async () => {
          const name = await this.askSavedViewName(`${selectedView.name} Copy`);
          if (!name || !name.trim()) return;
          await this.saveCurrentView(name.trim());
          this.refreshFilterControls(rerenderControls);
        })();
      });
    }

    if (options.includeDsl) {
      const dsl = parent.createEl("button", {
        text: tr("savedViews.editDsl"),
        cls: "bt-saved-view-save",
      });
      dsl.dataset.action = "edit-current-view-dsl";
      dsl.addEventListener("click", () => {
        this.openQueryDslModal(rerenderControls);
      });
    }

    if (options.includeManage) {
      const manage = parent.createEl("button", {
        text: tr("savedViews.manage"),
        cls: "bt-saved-view-save",
      });
      manage.dataset.action = "manage-query-tabs";
      manage.addEventListener("click", () => this.openManageTabsSheet());
    }
  }

  private visibleQueryTabs(): QueryPreset[] {
    return visibleQueryPresets(this.plugin.settings.queryPresets);
  }

  private savedViewLabels(): Record<"today" | "week" | "month" | "completed" | "unscheduled", string> {
    return {
      today: tr("tab.today"),
      week: tr("tab.week"),
      month: tr("tab.month"),
      completed: tr("tab.completed"),
      unscheduled: tr("tab.unscheduled"),
    };
  }

  private isViewCurrentlyActive(view: QueryPreset): boolean {
    return view.id === this.state.savedViewId;
  }

  private isSavedViewDirty(view: QueryPreset): boolean {
    const normalized = normalizeQueryPreset(view);
    if (this.isViewCurrentlyActive(normalized)) {
      return this.isSelectedSavedViewDirty(normalized);
    }
    const draft = this.tabDrafts.get(normalized.id);
    return !!draft && !sameQueryPresetContent(draft, normalized);
  }

  private savedViewBadges(view: QueryPreset): string[] {
    const badges: string[] = [];
    if (this.isViewCurrentlyActive(view)) badges.push(tr("savedViews.currentBadge"));
    if (this.plugin.settings.defaultSavedViewId === view.id) badges.push(tr("savedViews.defaultBadge"));
    if (this.isSavedViewDirty(view)) badges.push(tr("savedViews.dirtyBadge"));
    if (view.hidden) badges.push(tr("savedViews.hiddenBadge"));
    if (view.builtin) badges.push(tr("savedViews.presetBadge"));
    return badges;
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

  private legacyTabForSavedView(view: QueryPreset): TabKey | null {
    const normalized = normalizeQueryPreset(view);
    if (normalized.id === builtinSavedViewId("today")) return "today";
    if (normalized.id === builtinSavedViewId("week")) return "week";
    if (normalized.id === builtinSavedViewId("month")) return "month";
    if (normalized.id === builtinSavedViewId("completed")) return "completed";
    if (normalized.id === builtinSavedViewId("unscheduled")) return "unscheduled";
    return normalized.view?.type === "list" ? "list" : this.tabForSavedView(normalized, "list");
  }

  private activateSavedViewById(id: string): void {
    const view = this.plugin.settings.queryPresets.find((item) => item.id === id);
    if (!view) return;
    this.activateSavedView(view);
  }

  private activateSavedView(view: QueryPreset): void {
    this.persistCurrentDraft();
    this.applySavedView(view);
    this.render();
  }

  private countForSavedView(view: QueryPreset): number {
    const normalized = normalizeQueryPreset(view);
    const tab = this.tabForSavedView(normalized, "list");
    const filter = this.getSavedViewFilter(normalized);
    const today = todayISO();
    if (tab === "today") {
      const activeTodos = this.tasks.filter(filter).filter((task) => task.status === "todo" && !task.inheritsTerminal);
      const overdueCount = activeTodos.filter((task) => task.deadline && task.deadline < today).length;
      const todayScheduled = activeTodos.filter((task) => task.scheduled === today).length;
      return overdueCount + todayScheduled;
    }
    if (tab === "week") {
      const weekStart = startOfWeek(today, this.plugin.settings.weekStartsOn);
      const weekEnd = addDays(weekStart, 6);
      return this.hideChildrenOfVisibleParents(
        this.tasks.filter(filter).filter((task) => {
          const date = taskDateColumn(task);
          return !!date && date >= weekStart && date <= weekEnd;
        }),
      ).length;
    }
    if (tab === "month") {
      const monthStart = startOfMonth(today);
      const monthEnd = endOfMonth(today);
      return this.hideChildrenOfVisibleParents(
        this.tasks.filter(filter).filter((task) => {
          const date = taskDateColumn(task);
          return !!date && date >= monthStart && date <= monthEnd;
        }),
      ).length;
    }
    if (tab === "completed") {
      return this.hideChildrenOfVisibleParents(this.tasks.filter(filter).filter((task) => task.status === "done")).length;
    }
    if (tab === "unscheduled") {
      return this.hideChildrenOfVisibleParents(
        this.tasks.filter(filter).filter((task) => task.status === "todo" && !task.inheritsTerminal && !task.scheduled),
      ).length;
    }
    return this.hideChildrenOfVisibleParents(this.tasks.filter(filter)).length;
  }

  private openSavedViewMenu(event: MouseEvent, view: QueryPreset): void {
    const normalized = normalizeQueryPreset(view);
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle(tr("savedViews.copy")).onClick(() => {
        void this.copySavedView(normalized);
      }),
    );
    menu.addItem((item) =>
      item.setTitle(tr("savedViews.editDsl")).onClick(() => {
        this.activateSavedView(normalized);
        this.openQueryDslModal();
      }),
    );
    menu.addItem((item) =>
      item.setTitle(tr("savedViews.rename")).onClick(() => {
        void this.renameSavedView(normalized);
      }),
    );
    menu.addItem((item) =>
      item.setTitle(tr("savedViews.setDefault")).onClick(() => {
        void this.setDefaultSavedView(normalized.id);
      }),
    );
    menu.addItem((item) =>
      item.setTitle(tr("savedViews.moveLeft")).onClick(() => {
        void this.moveSavedView(normalized, -1);
      }),
    );
    menu.addItem((item) =>
      item.setTitle(tr("savedViews.moveRight")).onClick(() => {
        void this.moveSavedView(normalized, 1);
      }),
    );
    menu.addItem((item) =>
      item.setTitle(normalized.hidden ? tr("savedViews.show") : tr("savedViews.hide")).onClick(() => {
        void this.toggleSavedViewHidden(normalized, !normalized.hidden);
      }),
    );
    if (!normalized.builtin) {
      menu.addItem((item) =>
        item.setTitle(tr("savedViews.delete")).onClick(() => {
          void this.deleteSavedViewWithConfirm(normalized);
        }),
      );
    }
    menu.showAtMouseEvent(event);
  }

  private openManageTabsSheet(): void {
    let body: HTMLElement;
    const rerender = () => {
      this.render();
      if (!body) return;
      body.empty();
      this.renderManageTabsSheet(body, rerender);
    };
    const sheet = new BottomSheet(this.app, {
      title: tr("savedViews.manageTitle"),
      populate: (el) => {
        body = el.createDiv({ cls: "bt-manage-tabs-sheet" });
        this.renderManageTabsSheet(body, rerender);
      },
    });
    sheet.open();
  }

  public openManageTabs(): void {
    this.openManageTabsSheet();
  }

  private renderManageTabsSheet(parent: HTMLElement, rerender: () => void): void {
    const topActions = parent.createDiv({ cls: "bt-manage-tabs-actions" });
    const create = topActions.createEl("button", {
      text: tr("savedViews.create"),
      cls: "bt-manage-tab-btn",
    });
    create.addEventListener("click", () => {
      void this.createSavedViewFromCurrent().then(rerender).catch((error) =>
        new Notice(tr("notice.error", { msg: error instanceof Error ? error.message : String(error) }), 4000),
      );
    });
    const restoreDefaults = topActions.createEl("button", {
      text: tr("savedViews.restoreDefaultTabs"),
      cls: "bt-manage-tab-btn",
    });
    restoreDefaults.addEventListener("click", () => {
      void this.restoreAllBuiltinSavedViews().then(rerender).catch((error) =>
        new Notice(tr("notice.error", { msg: error instanceof Error ? error.message : String(error) }), 4000),
      );
    });

    const rows = parent.createDiv({ cls: "bt-manage-tabs-list" });
    for (const view of this.plugin.settings.queryPresets.map((item) => normalizeQueryPreset(item))) {
      const row = rows.createDiv({ cls: "bt-manage-tab-row" });
      const main = row.createDiv({ cls: "bt-manage-tab-main" });
      const title = main.createDiv({ cls: "bt-manage-tab-title", text: view.name });
      title.dataset.queryTabId = view.id;
      const meta = main.createDiv({ cls: "bt-manage-tab-meta" });
      for (const badge of this.savedViewBadges(view)) {
        if (view.hidden && badge === tr("savedViews.currentBadge")) continue;
        meta.createSpan({ cls: "bt-manage-tab-badge", text: badge });
      }
      const actions = row.createDiv({ cls: "bt-manage-tab-actions" });
      const action = (label: string, handler: () => void | Promise<void>) => {
        const btn = actions.createEl("button", { text: label, cls: "bt-manage-tab-btn" });
        btn.addEventListener("click", () => {
          Promise.resolve(handler()).then(rerender).catch((error) =>
            new Notice(tr("notice.error", { msg: error instanceof Error ? error.message : String(error) }), 4000),
          );
        });
      };
      action(tr("savedViews.open"), () => this.activateSavedView(view));
      action(tr("savedViews.editDsl"), () => {
        this.activateSavedView(view);
        this.openQueryDslModal();
      });
      action(tr("savedViews.rename"), () => this.renameSavedView(view));
      action(tr("savedViews.copy"), () => this.copySavedView(view));
      action(tr("savedViews.setDefault"), () => this.setDefaultSavedView(view.id));
      action(tr("savedViews.moveLeft"), () => this.moveSavedView(view, -1));
      action(tr("savedViews.moveRight"), () => this.moveSavedView(view, 1));
      action(view.hidden ? tr("savedViews.show") : tr("savedViews.hide"), () => this.toggleSavedViewHidden(view, !view.hidden));
      if (view.builtin) action(tr("savedViews.restore"), () => this.restoreBuiltinSavedView(view));
      if (!view.builtin) {
        action(tr("savedViews.delete"), () => this.deleteSavedView(view));
      }
    }
  }

  private async createSavedViewFromCurrent(): Promise<void> {
    const active = this.activeSavedView();
    const suggestedName = active.builtin ? this.suggestSavedViewName() : `${active.name} Copy`;
    const name = await this.askSavedViewName(suggestedName);
    if (!name?.trim()) return;
    await this.saveCurrentView(name.trim());
  }

  private async copySavedView(view: QueryPreset): Promise<void> {
    const name = await this.askSavedViewName(`${view.name} Copy`);
    if (!name?.trim()) return;
    const copied = duplicateQueryPreset(this.plugin.settings.queryPresets, view.id, name.trim(), createSavedViewId);
    this.plugin.settings.queryPresets = upsertQueryPreset(this.plugin.settings.queryPresets, copied);
    this.tabDrafts.delete(copied.id);
    this.applySavedView(copied);
    await this.plugin.saveSettings();
    this.render();
  }

  private async setDefaultSavedView(id: string): Promise<void> {
    const view = this.plugin.settings.queryPresets.find((item) => item.id === id);
    if (!view) return;
    if (view.hidden) {
      throw new Error("不能把已隐藏的 Tab 设为默认。");
    }
    this.plugin.settings.defaultSavedViewId = id;
    await this.plugin.saveSettings();
    this.render();
  }

  private async moveSavedView(view: QueryPreset, direction: -1 | 1): Promise<void> {
    this.plugin.settings.queryPresets = moveQueryPresetById(this.plugin.settings.queryPresets, view.id, direction);
    await this.plugin.saveSettings();
    this.render();
  }

  private async renameSavedView(view: QueryPreset): Promise<void> {
    const name = await this.askSavedViewName(view.name);
    if (!name?.trim()) return;
    this.plugin.settings.queryPresets = renameQueryPresetById(this.plugin.settings.queryPresets, view.id, name.trim());
    const renamed = this.plugin.settings.queryPresets.find((item) => item.id === view.id);
    if (renamed) this.applySavedView(renamed);
    await this.plugin.saveSettings();
    this.render();
  }

  private async toggleSavedViewHidden(view: QueryPreset, hidden: boolean): Promise<void> {
    const visible = this.visibleQueryTabs();
    if (hidden && visible.length <= 1 && visible[0]?.id === view.id) {
      throw new Error("至少保留一个可见 Tab。");
    }
    this.plugin.settings.queryPresets = setQueryPresetHiddenById(this.plugin.settings.queryPresets, view.id, hidden);
    if (hidden) this.tabDrafts.delete(view.id);
    if (hidden && this.plugin.settings.defaultSavedViewId === view.id) {
      this.plugin.settings.defaultSavedViewId = this.visibleQueryTabs().find((item) => item.id !== view.id)?.id ?? null;
    }
    if (hidden && this.state.savedViewId === view.id) {
      const next = this.visibleQueryTabs().find((item) => item.id !== view.id);
      if (next) this.applySavedView(next);
    }
    await this.plugin.saveSettings();
    this.render();
  }

  private async deleteSavedView(view: QueryPreset): Promise<void> {
    const visible = this.visibleQueryTabs();
    if (visible.length <= 1 && visible[0]?.id === view.id) {
      throw new Error("至少保留一个可见 Tab。");
    }
    this.plugin.settings.queryPresets = deleteQueryPresetById(this.plugin.settings.queryPresets, view.id);
    this.tabDrafts.delete(view.id);
    if (this.plugin.settings.defaultSavedViewId === view.id) {
      this.plugin.settings.defaultSavedViewId = this.visibleQueryTabs()[0]?.id ?? null;
    }
    if (this.state.savedViewId === view.id) {
      const next = this.visibleQueryTabs()[0];
      if (next) this.applySavedView(next);
    }
    await this.plugin.saveSettings();
    this.render();
  }

  /**
   * VAL-GUI-004: delete a custom tab with confirmation.
   * Shows "只删除这个视图，不删除任何任务" and provides toast undo.
   */
  private async deleteSavedViewWithConfirm(view: QueryPreset): Promise<void> {
    const visible = this.visibleQueryTabs();
    if (visible.length <= 1 && visible[0]?.id === view.id) {
      new Notice(tr("notice.error", { msg: "至少保留一个可见 Tab。" }), 4000);
      return;
    }
    // Show confirmation dialog
    const confirmed = await new Promise<boolean>((resolve) => {
      const modal = new BottomSheet(this.app, {
        title: tr("savedViews.deleteConfirmTitle"),
        populate: (el) => {
          el.createDiv({ cls: "bt-delete-confirm-body", text: tr("savedViews.deleteConfirmBody") });
          el.createDiv({ cls: "bt-delete-confirm-detail", text: `"${view.name}"` });
          const actions = el.createDiv({ cls: "bt-delete-confirm-actions" });
          const cancel = actions.createEl("button", { text: tr("savedViews.cancel") });
          cancel.addEventListener("click", () => { modal.close(); resolve(false); });
          const del = actions.createEl("button", {
            text: tr("savedViews.deleteConfirmAction"),
            cls: "mod-warning",
          });
          del.addEventListener("click", () => { modal.close(); resolve(true); });
        },
      });
      modal.open();
    });
    if (!confirmed) return;
    // Snapshot for undo
    const snapshot = normalizeQueryPreset(view);
    await this.deleteSavedView(view);
    // Toast undo
    new Notice(tr("notice.deleted", { name: snapshot.name }), 4000);
  }

  private async restoreBuiltinSavedView(view: QueryPreset): Promise<void> {
    this.plugin.settings.queryPresets = restoreBuiltinQueryPresetById(
      this.plugin.settings.queryPresets,
      view.id,
      this.savedViewLabels(),
    );
    this.tabDrafts.delete(view.id);
    const restored = this.plugin.settings.queryPresets.find((item) => item.id === view.id);
    if (restored && this.state.savedViewId === view.id) {
      this.applySavedView(restored);
    }
    await this.plugin.saveSettings();
    this.render();
  }

  private async restoreAllBuiltinSavedViews(): Promise<void> {
    this.plugin.settings.queryPresets = restoreBuiltinQueryPresets(this.plugin.settings.queryPresets, this.savedViewLabels());
    for (const id of [
      builtinSavedViewId("today"),
      builtinSavedViewId("week"),
      builtinSavedViewId("month"),
      builtinSavedViewId("completed"),
      builtinSavedViewId("unscheduled"),
    ]) {
      this.tabDrafts.delete(id);
    }
    const active = this.plugin.settings.queryPresets.find((item) => item.id === this.state.savedViewId);
    if (active) {
      this.applySavedView(active);
    }
    await this.plugin.saveSettings();
    this.render();
  }

  private renderTimeFilter(parent: HTMLElement, field: SavedViewTimeField, rerenderControls?: FilterControlsRerender): void {
    const container = parent.createDiv({ cls: "bt-filter-popover-wrap" });
    const options = this.timeFilterOptions(field);
    const active = this.timeFilterValue(field);
    const label = this.timeFilterLabel(field, active);
    const popoverKey = this.timePopoverKey(field);
    const trigger = container.createEl("button", { text: label, cls: "bt-saved-view-filter bt-date-trigger" });
    trigger.title = label;
    trigger.dataset.savedViewFilter = `time-${field}`;
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", this.filterPopoverOpen === popoverKey ? "true" : "false");
    trigger.addEventListener("click", () => {
      const willOpen = this.filterPopoverOpen !== popoverKey;
      this.filterPopoverOpen = willOpen ? popoverKey : null;
      if (willOpen) {
        this.dateCalendarAnchorISO = this.dateCalendarAnchorForField(field);
        this.pendingDateRangeStart = null;
      }
      this.refreshFilterControls(rerenderControls);
    });
    if (this.filterPopoverOpen !== popoverKey) return;

    const popover = container.createDiv({ cls: "bt-filter-popover bt-date-popover" });
    popover.setAttribute("role", "listbox");
    this.renderTimeRangePopover(popover, field, options, rerenderControls);
  }

  private renderTimeRangePopover(
    parent: HTMLElement,
    field: SavedViewTimeField,
    options = this.timeFilterOptions(field),
    rerenderControls?: FilterControlsRerender,
  ): void {
    const presetPanel = parent.createDiv({ cls: "bt-date-presets" });
    presetPanel.createDiv({ text: tr("savedViews.timePreset", { field: this.timeFieldLabel(field) }), cls: "bt-date-section-title" });
    for (const [value, text] of options) {
      const option = presetPanel.createEl("button", { cls: "bt-date-preset" });
      option.createSpan({ text, cls: "bt-date-preset-label" });
      option.dataset.timeOption = `${field}:${value || "all"}`;
      option.setAttribute("aria-selected", (this.timeFilterValue(field) || "") === value ? "true" : "false");
      option.addEventListener("click", () => this.setTimeFilter(field, value, rerenderControls));
    }

    this.renderDateCalendar(parent, field, rerenderControls);
  }

  private renderMoreTimeFilters(parent: HTMLElement, rerenderControls?: FilterControlsRerender): void {
    const container = parent.createDiv({ cls: "bt-filter-popover-wrap" });
    const count = SECONDARY_TIME_FIELDS.filter((field) => this.timeFilterValue(field)).length;
    const text = count > 0 ? tr("savedViews.timeMoreActive", { count }) : tr("savedViews.timeMore");
    const trigger = container.createEl("button", { text, cls: "bt-saved-view-filter bt-time-more-trigger" });
    trigger.dataset.savedViewFilter = "time-more";
    trigger.setAttribute("aria-haspopup", "listbox");
    const openForSecondary = this.filterPopoverOpen?.startsWith("time:")
      && this.filterPopoverOpen !== this.timePopoverKey(PRIMARY_TIME_FIELD);
    trigger.setAttribute("aria-expanded", this.filterPopoverOpen === "time-more" || openForSecondary ? "true" : "false");
    trigger.addEventListener("click", () => {
      this.filterPopoverOpen = this.filterPopoverOpen === "time-more" ? null : "time-more";
      this.pendingDateRangeStart = null;
      this.refreshFilterControls(rerenderControls);
    });

    if (!(this.filterPopoverOpen === "time-more" || openForSecondary)) return;

    const popover = container.createDiv({ cls: "bt-filter-popover bt-time-more-popover" });
    popover.setAttribute("role", "listbox");
    const activeField = this.timeFieldFromPopover(this.filterPopoverOpen);
    if (activeField && activeField !== PRIMARY_TIME_FIELD) {
      popover.addClass("bt-date-popover");
      const back = popover.createEl("button", { text: tr("savedViews.timeBack"), cls: "bt-time-back" });
      back.addEventListener("click", () => {
        this.filterPopoverOpen = "time-more";
        this.pendingDateRangeStart = null;
        this.refreshFilterControls(rerenderControls);
      });
      this.renderTimeRangePopover(popover, activeField, this.timeFilterOptions(activeField), rerenderControls);
      return;
    }

    for (const field of SECONDARY_TIME_FIELDS) {
      const value = this.timeFilterValue(field);
      const row = popover.createDiv({ cls: "bt-time-more-row" });
      row.createSpan({ text: this.timeFieldLabel(field), cls: "bt-time-more-label" });
      const pick = row.createEl("button", {
        text: this.timeFilterLabel(field, value),
        cls: "bt-time-more-pick",
      });
      pick.dataset.timeField = field;
      pick.addEventListener("click", () => {
        this.filterPopoverOpen = this.timePopoverKey(field);
        this.dateCalendarAnchorISO = this.dateCalendarAnchorForField(field);
        this.pendingDateRangeStart = null;
        this.refreshFilterControls(rerenderControls);
      });
      const clear = row.createEl("button", { text: "×", cls: "bt-time-more-clear" });
      clear.ariaLabel = tr("savedViews.clearTimeRange", { field: this.timeFieldLabel(field) });
      clear.disabled = !value;
      clear.addEventListener("click", () => this.setTimeFilter(field, "", rerenderControls));
    }
  }

  private timeFilterOptions(field: SavedViewTimeField): Array<readonly [string, string]> {
    const base: Array<readonly [string, string]> = [
      ["", tr("savedViews.timeAll", { field: this.timeFieldLabel(field) })],
    ];
    if (field === "deadline") {
      base.push(["overdue", tr("savedViews.dateOverdue")], ["next-7-days", tr("savedViews.dateNext7Days")]);
    }
    base.push(
      ["today", tr("savedViews.dateToday")],
      ["tomorrow", tr("savedViews.dateTomorrow")],
      ["week", tr("savedViews.dateWeek")],
      ["next-week", tr("savedViews.dateNextWeek")],
      ["month", tr("savedViews.dateMonth")],
    );
    return base;
  }

  private timeFilterLabel(field: SavedViewTimeField, value: string): string {
    return formatDateFilterLabel(value, {
      emptyLabel: this.timeFieldLabel(field),
      openStartLabel: tr("savedViews.rangeOpenStart"),
      openEndLabel: tr("savedViews.rangeOpenEnd"),
      presets: new Map(this.timeFilterOptions(field)),
    });
  }

  private timeFieldLabel(field: SavedViewTimeField): string {
    if (field === "scheduled") return tr("savedViews.timeScheduled");
    if (field === "deadline") return tr("savedViews.timeDeadline");
    if (field === "completed") return tr("savedViews.timeCompleted");
    return tr("savedViews.timeCreated");
  }

  private timeFilterValue(field: SavedViewTimeField): string {
    return this.state.savedViewTime[field]?.trim() ?? "";
  }

  private timePopoverKey(field: SavedViewTimeField): FilterPopoverKey {
    return `time:${field}`;
  }

  private timeFieldFromPopover(key: FilterPopoverKey | null): SavedViewTimeField | null {
    if (!key?.startsWith("time:")) return null;
    const field = key.slice("time:".length) as SavedViewTimeField;
    return ["scheduled", "deadline", "completed", "created"].includes(field) ? field : null;
  }

  private parseDateFilterValue(value: string): { exact: string; from: string; to: string } {
    const token = value.trim();
    if (!token) return { exact: "", from: "", to: "" };
    if (token.includes("..")) {
      const [from, to] = token.split("..", 2);
      return { exact: "", from, to };
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return { exact: token, from: "", to: "" };
    return { exact: "", from: "", to: "" };
  }

  private renderDateCalendar(parent: HTMLElement, field: SavedViewTimeField, rerenderControls?: FilterControlsRerender): void {
    const calendar = parent.createDiv({ cls: "bt-date-calendar" });
    const head = calendar.createDiv({ cls: "bt-date-calendar-head" });
    head.createSpan({ text: tr("savedViews.customTimeRange", { field: this.timeFieldLabel(field) }), cls: "bt-date-section-title" });
    const clear = head.createEl("button", { text: tr("savedViews.clearTimeRange", { field: this.timeFieldLabel(field) }), cls: "bt-date-clear" });
    clear.dataset.timeClear = field;
    clear.disabled = !this.timeFilterValue(field) && !this.pendingDateRangeStart;
    clear.addEventListener("click", () => this.setTimeFilter(field, "", rerenderControls));

    const nav = calendar.createDiv({ cls: "bt-date-calendar-nav" });
    const prev = nav.createEl("button", { text: "‹", cls: "bt-date-month-nav" });
    prev.ariaLabel = tr("savedViews.datePreviousMonth");
    prev.addEventListener("click", () => this.moveDateCalendarMonth(-1, rerenderControls));
    nav.createSpan({ text: this.dateCalendarMonthLabel(), cls: "bt-date-month-label" });
    const next = nav.createEl("button", { text: "›", cls: "bt-date-month-nav" });
    next.ariaLabel = tr("savedViews.dateNextMonth");
    next.addEventListener("click", () => this.moveDateCalendarMonth(1, rerenderControls));

    const weekdays = calendar.createDiv({ cls: "bt-date-calendar-weekdays" });
    const weekStart = this.plugin.settings.weekStartsOn;
    for (let i = 0; i < 7; i++) {
      const day = (weekStart + i) % 7;
      weekdays.createSpan({ text: tr(WEEKDAY_KEYS[day]), cls: "bt-date-calendar-weekday" });
    }

    const active = this.parseDateFilterValue(this.timeFilterValue(field));
    const rangeFrom = active.from || active.exact || "";
    const rangeTo = active.to || active.exact || "";
    const monthStart = startOfMonth(this.dateCalendarAnchorISO);
    const gridStart = startOfWeek(monthStart, weekStart);
    const today = todayISO();
    const days = calendar.createDiv({ cls: "bt-date-calendar-grid" });
    for (let i = 0; i < 42; i++) {
      const iso = addDays(gridStart, i);
      const day = fromISO(iso);
      const cell = days.createEl("button", { text: String(day.getDate()), cls: "bt-date-calendar-day" });
      cell.dataset.dateCalendarDay = iso;
      cell.setAttribute("aria-selected", active.exact === iso || iso === active.from || iso === active.to ? "true" : "false");
      if (!iso.startsWith(monthStart.slice(0, 7))) cell.addClass("other-month");
      if (iso === today) cell.addClass("today");
      if (this.pendingDateRangeStart === iso) cell.addClass("pending");
      if (rangeFrom && rangeTo && iso >= rangeFrom && iso <= rangeTo) cell.addClass("in-range");
      if (iso === active.from) cell.addClass("range-start");
      if (iso === active.to) cell.addClass("range-end");
      cell.addEventListener("click", () => this.handleDateCalendarDayClick(field, iso, rerenderControls));
    }
  }

  private moveDateCalendarMonth(delta: number, rerenderControls?: FilterControlsRerender): void {
    this.dateCalendarAnchorISO = startOfMonth(shiftMonth(this.dateCalendarAnchorISO, delta));
    this.refreshFilterControls(rerenderControls);
  }

  private handleDateCalendarDayClick(field: SavedViewTimeField, iso: string, rerenderControls?: FilterControlsRerender): void {
    if (!this.pendingDateRangeStart) {
      this.pendingDateRangeStart = iso;
      this.filterPopoverOpen = this.timePopoverKey(field);
      this.refreshFilterControls(rerenderControls);
      return;
    }
    const from = this.pendingDateRangeStart <= iso ? this.pendingDateRangeStart : iso;
    const to = this.pendingDateRangeStart <= iso ? iso : this.pendingDateRangeStart;
    this.pendingDateRangeStart = null;
    this.setTimeFilter(field, `${from}..${to}`, rerenderControls);
  }

  private dateCalendarAnchorForField(field: SavedViewTimeField): string {
    const parsed = this.parseDateFilterValue(this.timeFilterValue(field));
    return startOfMonth(parsed.exact || parsed.from || parsed.to || todayISO());
  }

  private dateCalendarMonthLabel(): string {
    const d = fromISO(this.dateCalendarAnchorISO);
    return new Intl.DateTimeFormat(getLocale(), { month: "long", year: "numeric" }).format(d);
  }

  private renderStatusFilter(parent: HTMLElement, rerenderControls?: FilterControlsRerender): void {
    const container = parent.createDiv({ cls: "bt-filter-popover-wrap" });
    const selected = normalizeSavedViewStatus(this.state.savedViewStatus);
    const label = this.statusFilterSummary(selected);
    const trigger = container.createEl("button", {
      text: label,
      cls: "bt-saved-view-filter bt-status-trigger",
    });
    if (selected !== "all") trigger.title = selected.map((value) => this.statusFilterLabel(value)).join(", ");
    trigger.dataset.savedViewFilter = "status";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", this.filterPopoverOpen === "status" ? "true" : "false");
    trigger.addEventListener("click", () => {
      this.filterPopoverOpen = this.filterPopoverOpen === "status" ? null : "status";
      this.refreshFilterControls(rerenderControls);
    });
    if (this.filterPopoverOpen !== "status") return;

    const popover = container.createDiv({ cls: "bt-filter-popover bt-status-popover" });
    popover.setAttribute("role", "listbox");
    for (const option of this.statusFilterOptions()) {
      const item = popover.createEl("button", { cls: "bt-status-option" });
      item.dataset.statusOption = option.value;
      const checked = selected === "all" ? option.value === "all" : option.value !== "all" && selected.includes(option.value);
      item.setAttribute("role", "checkbox");
      item.setAttribute("aria-checked", checked ? "true" : "false");
      item.setAttribute("aria-selected", checked ? "true" : "false");
      item.createSpan({ text: checked ? "✓" : "", cls: "bt-status-check" });
      item.createSpan({ text: option.label, cls: "bt-status-option-label" });
      item.addEventListener("click", () => {
        if (option.value === "all") this.setStatusFilter("all", rerenderControls);
        else this.toggleStatusFilter(option.value, rerenderControls);
      });
    }
  }

  private statusFilterOptions(): Array<{ value: "all" | TaskStatus; label: string }> {
    return [
      { value: "all", label: tr("savedViews.statusAny") },
      { value: "todo", label: tr("savedViews.statusTodo") },
      { value: "done", label: tr("savedViews.statusDone") },
      { value: "dropped", label: tr("savedViews.statusDropped") },
    ];
  }

  private statusFilterSummary(selected: "all" | TaskStatus[]): string {
    if (selected === "all" || selected.length === 0) return tr("savedViews.statusAll");
    const first = this.statusFilterLabel(selected[0]);
    if (selected.length === 1) return first;
    return `${first} +${selected.length - 1}`;
  }

  private statusFilterLabel(status: TaskStatus): string {
    return this.statusFilterOptions().find((option) => option.value === status)?.label ?? status;
  }

  private renderTagFilter(parent: HTMLElement, rerenderControls?: FilterControlsRerender): void {
    const selected = parseFilterTags(this.state.savedViewTag);
    const selectedSet = new Set(selected);
    const container = parent.createDiv({ cls: "bt-tag-filter" });
    const triggerText = this.tagFilterSummary(selected);
    const trigger = container.createEl("button", { text: triggerText, cls: "bt-tag-filter-trigger" });
    if (selected.length > 0) trigger.title = selected.join(", ");
    trigger.dataset.savedViewFilter = "tag";
    trigger.ariaLabel = tr("savedViews.tag");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", this.filterPopoverOpen === "tag" ? "true" : "false");
    trigger.addEventListener("click", () => {
      this.filterPopoverOpen = this.filterPopoverOpen === "tag" ? null : "tag";
      this.refreshFilterControls(rerenderControls);
    });

    if (this.filterPopoverOpen !== "tag") return;

    const popover = container.createDiv({ cls: "bt-tag-popover" });
    popover.setAttribute("role", "listbox");
    const search = popover.createEl("input", {
      type: "text",
      placeholder: tr("savedViews.tagSearch"),
      cls: "bt-tag-search",
    });
    const clear = popover.createEl("button", { text: tr("savedViews.clearTags"), cls: "bt-tag-clear" });
    clear.dataset.tagClear = "true";
    clear.addEventListener("click", () => this.setSelectedTags([], rerenderControls));

    const list = popover.createDiv({ cls: "bt-tag-options" });
    const rows: HTMLElement[] = [];
    for (const option of this.collectTagOptions()) {
      const row = list.createEl("button", { cls: "bt-tag-option" });
      row.dataset.tagOption = option.tag;
      row.title = option.tag;
      row.setAttribute("role", "checkbox");
      row.setAttribute("aria-checked", selectedSet.has(option.tag.toLowerCase()) ? "true" : "false");
      row.createSpan({ text: selectedSet.has(option.tag.toLowerCase()) ? "✓" : "", cls: "bt-tag-check" });
      row.createSpan({ text: option.tag, cls: "bt-tag-option-label" });
      row.createSpan({ text: String(option.count), cls: "bt-tag-option-count" });
      row.addEventListener("click", () => {
        const isSelected = selectedSet.has(option.tag.toLowerCase());
        const next = !isSelected
          ? [...selected, option.tag]
          : selected.filter((tag) => tag !== option.tag.toLowerCase());
        this.setSelectedTags(next, rerenderControls);
      });
      rows.push(row);
    }
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      for (const row of rows) {
        const value = row.dataset.tagOption?.toLowerCase() ?? "";
        row.style.display = !q || value.includes(q) ? "" : "none";
      }
    });
    search.focus();
  }

  private tagFilterSummary(selected: string[]): string {
    if (selected.length === 0) return tr("savedViews.tag");
    const first = selected[0];
    if (selected.length === 1) return first;
    return `${first} +${selected.length - 1}`;
  }

  private hasSaveableFilters(): boolean {
    const tags = this.state.savedViewTag ? this.state.savedViewTag.split(",").filter(Boolean) : undefined;
    return hasQueryPresetFilters({
      id: "",
      name: "",
      builtin: false,
      hidden: false,
      filters: {
        ...(this.state.filter ? { search: this.state.filter } : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
        time: this.state.savedViewTime,
        status: this.state.savedViewStatus,
      },
      view: { type: "list" },
      summary: [],
    });
  }

  private hasActiveFilters(): boolean {
    return this.hasSaveableFilters();
  }

  /**
   * VAL-GUI-010: Empty-state explanations distinguish between:
   * 1. Vault has no tasks at all
   * 2. Current filters produce no results (with clear/switch actions)
   */
  private renderFilterEmptyState(parent: HTMLElement): void {
    const empty = parent.createDiv({ cls: "bt-filter-empty" });
    empty.dataset.emptyState = "filters";

    // Distinguish: is the vault completely empty or just filtered empty?
    const totalAll = this.tasks.length;
    if (totalAll === 0) {
      empty.createDiv({ text: tr("filters.emptyVault"), cls: "bt-filter-empty-title" });
      empty.createDiv({ text: tr("filters.emptyVaultHint"), cls: "bt-filter-empty-hint" });
    } else {
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

  private setTimeFilter(field: SavedViewTimeField, value: string, rerenderControls?: FilterControlsRerender): void {
    const next = { ...this.state.savedViewTime };
    const trimmed = value === "all" ? "" : value.trim();
    if (trimmed) next[field] = trimmed;
    else delete next[field];
    this.state.savedViewTime = next;
    this.filterPopoverOpen = null;
    this.pendingDateRangeStart = null;
    this.refreshFilterControls(rerenderControls);
  }

  private setStatusFilter(value: SavedViewStatus, rerenderControls?: FilterControlsRerender): void {
    this.state.savedViewStatus = value;
    this.filterPopoverOpen = "status";
    this.refreshFilterControls(rerenderControls);
  }

  private toggleStatusFilter(value: TaskStatus, rerenderControls?: FilterControlsRerender): void {
    const selected = normalizeSavedViewStatus(this.state.savedViewStatus);
    const current = selected === "all" ? [] : selected;
    const next = current.includes(value)
      ? current.filter((status) => status !== value)
      : [...current, value];
    this.state.savedViewStatus = next.length > 0 ? next : "all";
    this.filterPopoverOpen = "status";
    this.refreshFilterControls(rerenderControls);
  }

  private openQueryControlsSheet(): void {
    let body: HTMLElement;
    const bodyClass = isMobileMode() ? "bt-mobile-filter-sheet" : "bt-query-controls-sheet";
    const rerenderControls = () => {
      this.render();
      if (!body) return;
      body.empty();
      this.renderQueryControlsSheet(body, rerenderControls);
    };
    const sheet = new BottomSheet(this.app, {
      title: tr("savedViews.queryEditorTitle"),
      populate: (el) => {
        body = el.createDiv({ cls: bodyClass });
        this.renderQueryControlsSheet(body, rerenderControls);
      },
    });
    sheet.open();
  }

  private renderQueryControlsSheet(parent: HTMLElement, rerenderControls?: FilterControlsRerender): void {
    parent.dataset.savedViews = "true";
    parent.dataset.queryEditor = "true";

    // VAL-GUI-010: Filter summary at top of editor
    this.renderFilterSummary(parent);

    // ── Filters ──────────────────────────────────────────
    const filtersSection = parent.createDiv({ cls: "bt-query-editor-section" });
    filtersSection.createDiv({ cls: "bt-query-editor-section-title", text: tr("savedViews.queryEditorFilters") });
    const filters = filtersSection.createDiv({ cls: "bt-saved-view-filters" });
    this.renderSavedViewsFilterControls(filters, rerenderControls);

    // ── View ─────────────────────────────────────────────
    const viewSection = parent.createDiv({ cls: "bt-query-editor-section" });
    viewSection.createDiv({ cls: "bt-query-editor-section-title", text: tr("savedViews.queryEditorView") });
    const viewCfg = this.currentQueryPresetViewConfig();
    const viewRow = viewSection.createDiv({ cls: "bt-query-editor-view-row" });
    viewRow.createSpan({ text: tr("savedViews.queryEditorViewType") + ":", cls: "bt-query-editor-view-label" });
    const viewTypes: Array<{ value: string; label: string }> = [
      { value: "list", label: "List" },
      { value: "week", label: "Week" },
      { value: "month", label: "Month" },
      { value: "matrix", label: "Matrix" },
    ];
    for (const vt of viewTypes) {
      const btn = viewRow.createEl("button", {
        text: vt.label,
        cls: "bt-query-editor-view-btn" + (viewCfg.type === vt.value ? " active" : ""),
      });
      btn.addEventListener("click", () => {
        const current = this.currentQueryPresetViewConfig();
        const next: QueryPresetViewConfig = { ...current, type: vt.value as QueryPresetViewConfig["type"] };
        // Update the draft
        const active = this.activeSavedView();
        const draft = this.currentQuerySnapshot(active);
        draft.view = next;
        this.tabDrafts.set(active.id, draft);
        this.applySavedView(draft);
        this.render();
      });
    }

    // ── Summary ──────────────────────────────────────────
    const summarySection = parent.createDiv({ cls: "bt-query-editor-section" });
    summarySection.createDiv({ cls: "bt-query-editor-section-title", text: tr("savedViews.queryEditorSummary") });
    summarySection.createDiv({ cls: "bt-query-editor-section-note", text: tr("savedViews.queryEditorSummaryHelp") });

    // ── DSL ──────────────────────────────────────────────
    const dslSection = parent.createDiv({ cls: "bt-query-editor-section" });
    dslSection.createDiv({ cls: "bt-query-editor-section-title", text: tr("savedViews.dslTitle") });
    const active = this.activeSavedView();
    const snapshot = this.currentQuerySnapshot(active);
    const dslText = stringifyQueryPreset(snapshot);
    const dslArea = dslSection.createEl("textarea", { cls: "tc-full-width-input" });
    dslArea.rows = 8;
    dslArea.value = dslText;
    dslArea.dataset.queryDslInput = "true";
    const dslError = dslSection.createDiv({ cls: "bt-query-editor-dsl-error" });
    dslError.hide();

    const dslApply = dslSection.createEl("button", {
      text: tr("savedViews.apply"),
      cls: "bt-query-editor-dsl-apply",
    });
    dslApply.addEventListener("click", () => {
      try {
        const parsed = parseQueryDsl(dslArea.value, { id: active.id, name: active.name, builtin: active.builtin, hidden: active.hidden });
        this.tabDrafts.set(active.id, parsed);
        this.applySavedView(parsed);
        dslError.hide();
        dslError.setText("");
        this.refreshFilterControls(rerenderControls);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dslError.setText(msg);
        dslError.show();
        // Keep the invalid DSL visible for editing
      }
    });

    // ── Actions ──────────────────────────────────────────
    const actionsSection = parent.createDiv({ cls: "bt-query-editor-section" });
    actionsSection.createDiv({ cls: "bt-query-editor-section-title", text: tr("savedViews.queryEditorActions") });
    actionsSection.createDiv({ cls: "bt-query-editor-section-note", text: tr("savedViews.queryEditorActionsNote") });
    const actions = actionsSection.createDiv({ cls: "bt-saved-view-actions" });
    this.renderSavedViewsActionControls(actions, rerenderControls, {
      includeSaveAs: true,
      includeDsl: false, // DSL is inline above
      includeManage: true,
    });
  }

  private navLabel(): string {
    if (this.state.tab === "week") {
      const start = startOfWeek(this.state.anchorISO, this.plugin.settings.weekStartsOn);
      const end = addDays(start, 6);
      return `${start} → ${end}`;
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
  private renderWeek(parent: HTMLElement) {
    const today = todayISO();
    const weekStart = startOfWeek(this.state.anchorISO, this.plugin.settings.weekStartsOn);
    const days: string[] = [];
    for (let i = 0; i < 7; i++) days.push(addDays(weekStart, i));

    const filter = this.getTextFilter();
    if (this.hasActiveFilters()) {
      const unfilteredCount = days.reduce(
        (sum, day) => sum + this.hideChildrenOfVisibleParents(
          this.tasks.filter((t) => taskDateColumn(t) === day),
        ).length,
        0,
      );
      const filteredCount = days.reduce(
        (sum, day) => sum + this.hideChildrenOfVisibleParents(
          this.tasks.filter((t) => taskDateColumn(t) === day).filter(filter),
        ).length,
        0,
      );
      if (unfilteredCount > 0 && filteredCount === 0) this.renderFilterEmptyState(parent);
    }

    const wrapper = parent.createDiv({ cls: "bt-week" });
    wrapper.dataset.view = "week";

    for (const day of days) {
      // Mobile collapsible per-day rows (UX-mobile §3.1): `today` always
      // shows its body; other days show body only when `expanded` class
      // is present. Desktop CSS overrides and shows body unconditionally,
      // so this class is mobile-only state.
      const isToday = day === today;
      const isExpanded = this.state.expandedDays.has(day);
      let cls = "bt-week-col";
      if (isToday) cls += " today";
      if (isExpanded) cls += " expanded";
      const col = wrapper.createDiv({ cls });
      // e2e drop-target selector: `[data-date="YYYY-MM-DD"]`. Stable across
      // i18n / weekday labels.
      col.dataset.date = day;
      const head = col.createDiv({ cls: "bt-week-head" });
      // Tap-to-toggle on mobile. Today's row stays open (no toggle).
      if (!isToday) {
        head.addEventListener("click", (e) => {
          // Ignore clicks that bubbled up from the card area inside the body.
          if ((e.target as HTMLElement).closest(".bt-card, .bt-subcard")) return;
          if (this.state.expandedDays.has(day)) this.state.expandedDays.delete(day);
          else this.state.expandedDays.add(day);
          this.render();
        });
      }
      const d = fromISO(day);
      head.createSpan({
        text: weekdayLabel(d.getDay()),
        cls: "bt-week-dow",
      });
      head.createSpan({ text: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, cls: "bt-week-date" });

      const dayTasks = this.tasks
        .filter((t) => taskDateColumn(t) === day)
        .filter(filter);
      dayTasks.sort((a, b) => {
        if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
        if (a.deadline) return -1;
        if (b.deadline) return 1;
        return 0;
      });
      const topLevel = this.hideChildrenOfVisibleParents(dayTasks);
      const stats = col.createSpan({
        text: this.columnStats(dayTasks),
        cls: "bt-week-stats",
      });
      stats.title = "Scheduled estimate (hours)";

      const list = col.createDiv({ cls: "bt-week-list" });
      // Drop handler on the COLUMN (which carries `data-date`), not the
      // inner list. The column is the published e2e drop target; if the
      // handler lives on a child the synthesized drop event from
      // `simulateDrag()` never reaches it.
      this.makeDropZone(col, day);
      for (const t of topLevel) {
        this.renderCard(list, t, day);
      }
    }
  }

  // US-116: per-column header line `N tasks · XhYm` — task count plus
  // summed `[estimate::]` minutes. Lets the user see at a glance whether
  // a day is overbooked before they drop a new card on it. Sum collapses
  // to plain count when no card on the day carries an estimate.
  // see USER_STORIES.md
  private columnStats(tasks: ParsedTask[]): string {
    const sum = tasks.reduce((s, t) => s + (t.estimate ?? 0), 0);
    if (sum === 0) return `${tasks.length}`;
    return `${tasks.length} · ${formatMinutes(sum)}`;
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

  // ---------- Month ----------

  // US-102: month calendar grid (6 weeks × 7 days, anchored to month-start
  // week). Prev / next-month navigation lives on the toolbar buttons in
  // `renderToolbar`. Each day cell renders up to 6 mini-cards plus a
  // `+N more` overflow chip; tapping the cell on mobile opens the day's
  // task list as a bottom sheet (US-504).
  // US-122: on desktop every cell is a `makeDropZone` target so dragging a
  // card onto a date in the month grid rewrites its ⏳ to that day — same
  // write semantics as the week-view day columns (US-121). Mobile taps open
  // the day's bottom sheet instead (US-504 / US-507).
  // see USER_STORIES.md
  private renderMonth(parent: HTMLElement) {
    const today = todayISO();
    const weekStart = this.plugin.settings.weekStartsOn;
    const first = startOfMonth(this.state.anchorISO);
    const last = endOfMonth(this.state.anchorISO);
    const gridStart = startOfWeek(first, weekStart);
    const gridDays: string[] = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i);
      gridDays.push(d);
      if (i >= 27 && d > last) break;
    }

    const wrapper = parent.createDiv({ cls: "bt-month" });
    wrapper.dataset.view = "month";
    // DOW header
    const header = wrapper.createDiv({ cls: "bt-month-header" });
    for (let i = 0; i < 7; i++) {
      const d = fromISO(addDays(gridStart, i));
      header.createDiv({ text: weekdayLabel(d.getDay()), cls: "bt-month-dow" });
    }

    const filter = this.getTextFilter();
    if (this.hasActiveFilters()) {
      const unfilteredCount = gridDays.reduce(
        (sum, day) => sum + this.hideChildrenOfVisibleParents(
          this.tasks.filter((t) => taskDateColumn(t) === day),
        ).length,
        0,
      );
      const filteredCount = gridDays.reduce(
        (sum, day) => sum + this.hideChildrenOfVisibleParents(
          this.tasks.filter((t) => taskDateColumn(t) === day).filter(filter),
        ).length,
        0,
      );
      if (unfilteredCount > 0 && filteredCount === 0) this.renderFilterEmptyState(wrapper);
    }

    const grid = wrapper.createDiv({ cls: "bt-month-grid" });
    for (const day of gridDays) {
      const dObj = fromISO(day);
      const isCurMonth = day >= first && day <= last;
      const cell = grid.createDiv({
        cls:
          "bt-month-cell" +
          (day === today ? " today" : "") +
          (isCurMonth ? "" : " other-month"),
      });
      // e2e drop-target selector — same contract as the week view.
      cell.dataset.date = day;
      const dayTasksAll = this.tasks
        .filter((t) => taskDateColumn(t) === day)
        .filter(filter);
      const dayTasks = this.hideChildrenOfVisibleParents(dayTasksAll);
      const head = cell.createDiv({ cls: "bt-month-cell-head" });
      head.createSpan({ text: `${dObj.getDate()}`, cls: "bt-month-cell-date" });
      if (dayTasks.length > 0) {
        head.createSpan({ text: `${dayTasks.length}`, cls: "bt-month-cell-count" });
      }
      const list = cell.createDiv({ cls: "bt-month-cell-list" });
      this.makeDropZone(cell, day);
      for (const t of dayTasks.slice(0, 6)) {
        const chip = list.createDiv({ cls: "bt-mini-card" });
        chip.dataset.taskId = t.id;
        if (this.contentEl.dataset.mobileLayout !== "true") chip.draggable = true;
        chip.setText(t.title);
        if (t.deadline) {
          const deadlineDays = daysBetween(today, t.deadline);
          if (deadlineDays < 0) chip.addClass("overdue");
          else if (deadlineDays <= 3) chip.addClass("near-deadline");
        }
        this.wireCardEvents(chip, t);
      }
      if (dayTasks.length > 6) {
        list.createDiv({ text: `+${dayTasks.length - 6} more`, cls: "bt-mini-more" });
      }
      // US-504: mobile month tab is calendar-grid + per-day dot density;
      // tapping a day opens that day's task list as a bottom sheet (the
      // desktop path leaves the click as a no-op — chips inside handle
      // their own drag / select). Detection is "in mobile layout" — the
      // same predicate `applyMobileLayoutAttr` uses for the data-attr,
      // so viewport-narrow OR US-502 mobileForceLayout both qualify.
      // task #42 fixed the case where force-mobile was on but the
      // viewport was wide — the click previously silently no-op'd.
      // see USER_STORIES.md
      cell.addEventListener("click", (e) => {
        const narrow = window.innerWidth < 600;
        const force = !!this.plugin.settings.mobileForceLayout;
        if (!narrow && !force) return;
        // Don't fire when the click bubbled from a chip — that's a select
        // intent, not "open the day".
        if ((e.target as HTMLElement).closest(".bt-mini-card")) return;
        this.openDayTasksSheet(day, dayTasks);
      });
    }
  }

  /**
   * Mobile-only: long-press a card → bottom sheet with task actions.
   * Mirrors the desktop right-click menu (UX-mobile.md §5.1 / US-506)
   * into a single thumb-reachable surface. Buttons call the same `api.*`
   * methods as the desktop UI; rendered as a flat list of large tap targets.
   */
  private openCardActionSheet(t: ParsedTask): void {
    const today = todayISO();
    const tomorrow = addDays(today, 1);
    let sheet: BottomSheet | null = null;
    const run = async (label: string, op: () => Promise<unknown>) => {
      sheet?.close();
      try {
        await op();
      } catch (err) {
        new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
      }
      this.scheduleRefresh();
      void label; // for future telemetry; intentional no-op
    };

    sheet = new BottomSheet(this.app, {
      title: t.title,
      populate: (el) => {
        // Source location — quick orientation only. Editing source context
        // now goes through the US-168 single-click source edit shell.
        const source = el.createDiv({ cls: "bt-sheet-source" });
        source.setText(`${t.path}:L${t.line + 1}`);

        const actions = el.createDiv({ cls: "bt-sheet-actions" });

        const btn = (text: string, action: () => Promise<unknown>) => {
          const b = actions.createEl("button", {
            cls: "bt-sheet-action",
            text,
          });
          b.addEventListener("click", () => {
            void run(text, async () => action());
          });
        };

        // task #43: route every label in the long-press action sheet
        // through tr() so a Chinese session sees "完成 / 取消完成 / 放弃"
        // etc. instead of the raw EN literals. The two
        // ⏳ <date> entries keep the date verbatim — the i18n template
        // wraps it without reformatting (locale-stable per US-411).
        btn(
          t.status === "done" ? tr("sheet.markUndone") : tr("sheet.done"),
          () => (t.status === "done" ? this.api.undone(t.id) : this.api.done(t.id)),
        );
        btn(tr("sheet.scheduleAt", { date: today }), () => this.api.schedule(t.id, today));
        btn(tr("sheet.scheduleAt", { date: tomorrow }), () => this.api.schedule(t.id, tomorrow));
        btn(tr("sheet.scheduleClear"), () => this.api.schedule(t.id, null));
        btn(tr("sheet.drop"), () => this.api.drop(t.id));
      },
    });
    sheet.open();
  }

  /**
   * Mobile-only: bottom sheet listing every todo task scheduled to `day`.
   * Tapping a row switches to the week tab anchored on that day with the
   * row's day expanded (so the user can act on the task with the full
   * card UI rather than re-implementing card actions inside the sheet).
   */
  private openDayTasksSheet(day: string, dayTasks: ParsedTask[]): void {
    const sheet = new BottomSheet(this.app, {
      title: day,
      populate: (el) => {
        if (dayTasks.length === 0) {
          el.createDiv({ cls: "bt-sheet-empty", text: tr("sheet.empty") });
          return;
        }
        for (const t of dayTasks) {
          const row = el.createDiv({ cls: "bt-sheet-task" });
          row.dataset.taskId = t.id;
          row.createSpan({ cls: "bt-sheet-task-title", text: t.title });
          if (t.deadline) {
            row.createSpan({
              cls: "bt-sheet-task-meta",
              text: `📅 ${t.deadline}`,
            });
          }
          row.addEventListener("click", () => {
            this.state.tab = "week";
            this.state.anchorISO = day;
            this.state.expandedDays.add(day);
            this.state.selectedTaskId = t.id;
            sheet.close();
            this.render();
          });
        }
      },
    });
    sheet.open();
  }

  // ---------- Completed ----------

  private renderCompleted(parent: HTMLElement) {
    const filter = this.getTextFilter();
    const completedAll = this.tasks.filter((t) => t.status === "done" && t.completed);
    const completed = completedAll
      .filter(filter)
      .sort((a, b) => (b.completed! < a.completed! ? -1 : 1));

    const wrap = parent.createDiv({ cls: "bt-completed" });
    wrap.dataset.view = "list";
    if (completed.length === 0 && completedAll.length > 0 && this.hasActiveFilters()) {
      this.renderFilterEmptyState(wrap);
      return;
    }

    // US-303: 7-day estimate-accuracy headline + top-tag minutes preset.
    // Mirrors the CLI `stats days=7` summary so the GUI user gets the same
    // calibration signal an AI agent would. Implementation lives in
    // `computeStats` (cli.ts) — view just renders the StatsResult.
    // see USER_STORIES.md
    const stats = computeStats(this.tasks, { days: 7 });
    if (stats.doneCount > 0) {
      const header = wrap.createDiv({ cls: "bt-stats-header" });
      const left = header.createDiv({ cls: "bt-stats-left" });
      // task #43 (PM HOLD msg cbf0489c): Completed-tab stats header
      // through tr() so a CN session reads "近 7 日 · 完成 N 条 / 准确率…"
      // instead of the EN literals.
      left.createSpan({
        text: tr("stats.sevenDayDone", { n: stats.doneCount }),
        cls: "bt-stats-period",
      });
      if (stats.ratio !== null) {
        const delta = Math.round((stats.ratio - 1) * 100);
        const sign = delta >= 0 ? "+" : "";
        const cls =
          stats.ratio >= 0.8 && stats.ratio <= 1.25
            ? "bt-stats-ok"
            : "bt-stats-off";
        left.createSpan({
          text: tr("stats.ratio", { ratio: stats.ratio.toFixed(2), sign, delta }),
          cls: "bt-stats-ratio " + cls,
        });
        left.createSpan({
          text: `${stats.sumActual}m / ${stats.sumEstimate}m`,
          cls: "bt-stats-time",
        });
      }
      const tagsRow = header.createDiv({ cls: "bt-stats-tags" });
      for (const t of stats.byTag.slice(0, 4)) {
        const chip = tagsRow.createDiv({ cls: "bt-stats-chip" });
        chip.createSpan({ text: t.tag, cls: "bt-stats-chip-tag" });
        chip.createSpan({ text: `${t.minutes}m`, cls: "bt-stats-chip-min" });
      }
    }


    // Group by week
    const weeks = new Map<string, ParsedTask[]>();
    for (const t of completed) {
      const weekKey = startOfWeek(t.completed!, this.plugin.settings.weekStartsOn);
      if (!weeks.has(weekKey)) weeks.set(weekKey, []);
      weeks.get(weekKey)!.push(t);
    }
    const weekKeys = Array.from(weeks.keys()).sort((a, b) => (a < b ? 1 : -1));

    if (weekKeys.length === 0) {
      wrap.createDiv({ text: tr("completed.empty"), cls: "bt-empty" });
      return;
    }

    const currentWeek = startOfWeek(todayISO(), this.plugin.settings.weekStartsOn);
    for (const wk of weekKeys) {
      // US-304: history weeks default-collapsed, current week expanded —
      // keeps the past from pushing this week below the fold. The user's
      // explicit expand / collapse choice lives in collapsedWeeks (with an
      // `EXPANDED:` marker for the inverse) and overrides the default.
      // see USER_STORIES.md
      const hasUserPreference =
        this.state.collapsedWeeks.has(wk) || this.state.collapsedWeeks.has("EXPANDED:" + wk);
      const collapsed = hasUserPreference
        ? this.state.collapsedWeeks.has(wk)
        : wk < currentWeek;
      const group = wrap.createDiv({ cls: "bt-completed-week" + (collapsed ? " collapsed" : "") });
      const items = weeks.get(wk)!;
      const sumActual = items.reduce((s, t) => s + (t.actual ?? 0), 0);
      const sumEst = items.reduce((s, t) => s + (t.estimate ?? 0), 0);
      const accuracy = sumEst > 0 ? (sumActual / sumEst) : null;
      const accLabel =
        accuracy !== null
          ? tr("completed.accuracy", { ratio: accuracy.toFixed(2), actual: sumActual, est: sumEst })
          : tr("completed.total", { actual: sumActual });

      const head = group.createDiv({ cls: "bt-completed-week-head" });
      head.createSpan({ text: collapsed ? "▸" : "▾", cls: "bt-completed-toggle" });
      head.createSpan({ text: tr("completed.weekOf", { date: wk }), cls: "bt-completed-week-label" });
      head.createSpan({ text: tr("completed.tasks", { n: items.length }), cls: "bt-completed-count" });
      head.createSpan({ text: accLabel, cls: "bt-completed-accuracy" });
      head.addEventListener("click", () => {
        const wasCollapsed = collapsed;
        if (wasCollapsed) {
          this.state.collapsedWeeks.delete(wk);
          this.state.collapsedWeeks.add("EXPANDED:" + wk); // mark as user-chosen expanded
        } else {
          this.state.collapsedWeeks.delete("EXPANDED:" + wk);
          this.state.collapsedWeeks.add(wk);
        }
        this.render();
      });

      if (!collapsed) {
        const list = group.createDiv({ cls: "bt-completed-list" });
        for (const t of items) {
          const row = list.createDiv({ cls: "bt-completed-row" });
          row.dataset.taskId = t.id;
          row.createSpan({ text: `${t.completed}`, cls: "bt-completed-date" });
          row.createSpan({ text: t.title, cls: "bt-completed-title" });
          const meta = row.createSpan({ cls: "bt-completed-meta" });
          if (t.estimate || t.actual) {
            meta.setText(
              `${t.actual ? formatMinutes(t.actual) : "—"} / ${t.estimate ? formatMinutes(t.estimate) : "—"}`,
            );
          }
          row.addEventListener("click", () => {
            void this.openSourceEditShell(t);
          });
        }
      }
    }
  }

  // ---------- Unscheduled ----------

  // US-104: unscheduled pool sorted "what should I pick next" — deadline
  // ascending first (nearest 📅 wins), tasks with no deadline fall to the
  // end, and ties are broken by created date desc (newest on top). Same
  // sort runs in `renderUnscheduledBig` below; if you change one, change
  // both — they're the two surfaces that show the pool.
  // see USER_STORIES.md
  private renderUnscheduledPool(parent: HTMLElement) {
    const filter = this.getTextFilter();
    const unscheduledBase = this.tasks.filter((t) => !t.scheduled && t.status === "todo" && !t.inheritsTerminal);
    const unscheduledAll = unscheduledBase.filter(filter);
    // Sort for triage: deadline ascending first (nearest deadline is urgent),
    // tasks without deadline fall to the end; tie-break by created date desc
    // (newer tasks first). Children-of-visible-parents dedup happens after.
    unscheduledAll.sort((a, b) => {
      if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      if (a.created && b.created) return b.created.localeCompare(a.created);
      if (a.created) return -1;
      if (b.created) return 1;
      return 0;
    });
    const unscheduled = this.hideChildrenOfVisibleParents(unscheduledAll);
    if (unscheduled.length === 0 && !this.state.showUnscheduledPool) return;

    const wrap = parent.createDiv({ cls: "bt-pool-wrap" });

    const section = wrap.createDiv({ cls: "bt-unscheduled-pool" });
    const head = section.createDiv({ cls: "bt-unscheduled-head" });
    head.createSpan({
      text: `${tr("pool.unscheduled")}  (${unscheduled.length})`,
      cls: "bt-unscheduled-label",
    });
    head.createSpan({
      text: tr("pool.hint"),
      cls: "bt-unscheduled-hint",
    });

    const list = section.createDiv({ cls: "bt-unscheduled-list" });
    this.makeDropZone(list, null);
    for (const t of unscheduled) {
      this.renderCard(list, t);
    }

    this.renderTrashZone(wrap);
  }

  // US-123: bottom abandon target — dragging a card here marks it
  // `[-] ❌ today` (abandoned), and by US-124 cascades to its `todo`
  // descendants while preserving already-done children as history.
  // `data-drop-zone="abandon"` is the desktop selector contract; the visible
  // UI intentionally avoids trash/delete wording. Mobile does not render an
  // abandon drop zone.
  // see USER_STORIES.md
  private renderTrashZone(parent: HTMLElement) {
    const trash = parent.createDiv({ cls: "bt-trash" });
    // e2e drop-zone selector: `[data-drop-zone="abandon"]`. Stable across the
    // visible icon / label / theme. Desktop-only; mobile abandon is handled
    // by swipe / action sheet.
    trash.dataset.dropZone = "abandon";
    trash.createDiv({ cls: "bt-trash-icon", text: "⏹" });
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
        try {
          await this.runWithRemoveAnim(id, async () => {
            await this.api.drop(id);
            new Notice(tr("trash.dropped"));
          });
        } catch (err) {
          new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
          this.scheduleRefresh();
        }
      })();
    });
  }

  // US-720 (task #63): today execution view.
  //
  // Single question this view answers: "what should I do today?". Three
  // capped groups — overdue, scheduled-for-today, and one recommendation
  // pulled from the inbox/unscheduled. Each card carries the three minimal
  // inline actions (done / reschedule-to-tomorrow / drop); clicking the
  // card opens the US-168 source edit shell. The
  // view intentionally does NOT mirror the full board: per-group cap is 3
  // so the first screen stays scannable.
  //
  // DOM contract (frozen as test fixtures in test/e2e/specs/today-view.e2e.ts):
  //   [data-view="today"]                    container
  //   [data-today-group="overdue"]            section
  //   [data-today-group="today"]              section
  //   [data-today-group="unscheduled-rec"]    section
  //   [data-today-empty]                      empty-state element
  //   [data-action="reschedule-tomorrow"]     per-card primary action
  // see USER_STORIES.md
  private renderToday(parent: HTMLElement) {
    const wrap = parent.createDiv({ cls: "bt-today" });
    wrap.dataset.view = "today";

    const today = todayISO();
    const tomorrow = addDays(today, 1);
    const activeTodos = this.tasks.filter(
      (t) => t.status === "todo" && !t.inheritsTerminal && t.title.trim() !== "",
    );

    // Overdue: anything with a deadline in the past, regardless of schedule.
    // Sort earliest-deadline first so the most-overdue rises to the top.
    const overdue = activeTodos
      .filter((t) => t.deadline && t.deadline < today)
      .sort((a, b) => (a.deadline ?? "").localeCompare(b.deadline ?? ""));

    // Today: scheduled to land on today. Cards already in the overdue group
    // are skipped to avoid double-listing.
    const overdueIds = new Set(overdue.map((t) => t.id));
    const todayList = activeTodos
      .filter((t) => t.scheduled === today && !overdueIds.has(t.id));

    // Unscheduled recommendation: just the one freshest unscheduled todo.
    // The full backlog lives on the Unscheduled tab — this slot is a single
    // nudge so the user doesn't sit on an empty Today screen when they have
    // inbox items waiting.
    const unscheduledRec = activeTodos
      .filter((t) => !t.scheduled && !t.deadline)
      .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""))
      .slice(0, 1);

    const PER_GROUP_CAP = 3;

    const isAllEmpty =
      overdue.length === 0 && todayList.length === 0 && unscheduledRec.length === 0;
    if (isAllEmpty) {
      const empty = wrap.createDiv({ cls: "bt-today-empty" });
      empty.dataset.todayEmpty = "true";
      empty.setText(tr("today.empty"));
      return;
    }

    this.renderTodayGroup(wrap, "overdue", tr("today.groupOverdue"), overdue.slice(0, PER_GROUP_CAP), tomorrow);
    this.renderTodayGroup(wrap, "today", tr("today.groupToday"), todayList.slice(0, PER_GROUP_CAP), tomorrow);
    this.renderTodayGroup(wrap, "unscheduled-rec", tr("today.groupRec"), unscheduledRec, tomorrow);
  }

  private renderTodayGroup(
    parent: HTMLElement,
    key: "overdue" | "today" | "unscheduled-rec",
    label: string,
    list: ParsedTask[],
    tomorrow: string,
  ) {
    const section = parent.createDiv({ cls: `bt-today-group bt-today-group-${key}` });
    section.dataset.todayGroup = key;
    const head = section.createDiv({ cls: "bt-today-group-head" });
    head.createSpan({ text: label, cls: "bt-today-group-label" });
    if (list.length > 0) {
      head.createSpan({ text: String(list.length), cls: "bt-today-group-count" });
    }
    if (list.length === 0) {
      section.createDiv({ cls: "bt-today-group-empty", text: tr("today.groupEmpty") });
      return;
    }
    for (const t of list) this.renderTodayCard(section, t, tomorrow);
  }

  private renderTodayCard(parent: HTMLElement, t: ParsedTask, tomorrow: string) {
    const card = parent.createDiv({ cls: "bt-today-card" });
    card.dataset.taskId = t.id;
    if (this.state.selectedTaskId === t.id) card.addClass("selected");

    const main = card.createDiv({ cls: "bt-today-card-main" });
    main.createDiv({ cls: "bt-today-card-title", text: t.title });
    this.renderTaskTags(main, t.tags, "bt-today-card-tags");
    const meta = main.createDiv({ cls: "bt-today-card-meta" });
    const metaParts: string[] = [];
    metaParts.push(t.path);
    if (t.scheduled) metaParts.push(`⏳ ${t.scheduled}`);
    if (t.deadline) metaParts.push(`📅 ${t.deadline}`);
    if (typeof t.estimate === "number") metaParts.push(`⏱ ${formatMinutes(t.estimate)}`);
    meta.setText(metaParts.join(" · "));

    const actions = card.createDiv({ cls: "bt-today-card-actions" });
    const mkBtn = (
      text: string,
      action: "done" | "reschedule-tomorrow" | "drop",
      handler: () => void | Promise<void>,
    ) => {
      const btn = actions.createEl("button", { text, cls: `bt-today-action bt-today-action-${action}` });
      btn.dataset.action = action;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        Promise.resolve(handler()).catch((err) =>
          console.warn("[task-center US-720] action failed:", err),
        );
      });
      return btn;
    };

    mkBtn(tr("today.actionDone"), "done", async () => {
      await this.api.done(t.id);
      await this.refreshAfterAction();
    });
    mkBtn(tr("today.actionReschedule"), "reschedule-tomorrow", async () => {
      await this.api.schedule(t.id, tomorrow);
      await this.refreshAfterAction();
    });
    mkBtn(tr("today.actionDrop"), "drop", async () => {
      await this.api.drop(t.id);
      await this.refreshAfterAction();
    });

    card.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.openSourceEditShell(t);
    });
  }

  private renderList(parent: HTMLElement): void {
    const active = this.activeSavedView();
    const filter = this.getTextFilter();
    const list = this.hideChildrenOfVisibleParents(this.tasks.filter(filter));
    this.sortListTasks(list, active.view?.orderBy);
    if (list.length === 0) {
      if (this.tasks.length > 0) this.renderFilterEmptyState(parent);
      else parent.createDiv({ text: tr("filters.empty"), cls: "bt-empty" });
      return;
    }
    const wrap = parent.createDiv({ cls: "bt-list-view" });
    wrap.dataset.view = "list";
    for (const task of list) this.renderCard(wrap, task);
  }

  private sortListTasks(tasks: ParsedTask[], orderBy: string[] | undefined): void {
    const order = orderBy ?? [];
    tasks.sort((left, right) => {
      for (const rule of order) {
        if (rule === "completed_desc") {
          const cmp = (right.completed ?? "").localeCompare(left.completed ?? "");
          if (cmp !== 0) return cmp;
          continue;
        }
        if (rule === "created_desc") {
          const cmp = (right.created ?? "").localeCompare(left.created ?? "");
          if (cmp !== 0) return cmp;
          continue;
        }
        if (rule === "deadline_risk") {
          const leftDeadline = left.deadline ?? "9999-99-99";
          const rightDeadline = right.deadline ?? "9999-99-99";
          const cmp = leftDeadline.localeCompare(rightDeadline);
          if (cmp !== 0) return cmp;
          continue;
        }
      }
      const scheduledCmp = (left.scheduled ?? "9999-99-99").localeCompare(right.scheduled ?? "9999-99-99");
      if (scheduledCmp !== 0) return scheduledCmp;
      const deadlineCmp = (left.deadline ?? "9999-99-99").localeCompare(right.deadline ?? "9999-99-99");
      if (deadlineCmp !== 0) return deadlineCmp;
      const createdCmp = (right.created ?? "").localeCompare(left.created ?? "");
      if (createdCmp !== 0) return createdCmp;
      return left.title.localeCompare(right.title);
    });
  }

  private async refreshAfterAction(): Promise<void> {
    await this.plugin.cache.forFlush();
    await this.reloadTasks();
    this.render();
  }

  private renderUnscheduledBig(parent: HTMLElement) {
    const filter = this.getTextFilter();
    const unscheduledBase = this.tasks.filter((t) => !t.scheduled && t.status === "todo" && !t.inheritsTerminal);
    const unscheduledAll = unscheduledBase.filter(filter);
    unscheduledAll.sort((a, b) => {
      if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      if (a.created && b.created) return b.created.localeCompare(a.created);
      if (a.created) return -1;
      if (b.created) return 1;
      return 0;
    });
    const unscheduled = this.hideChildrenOfVisibleParents(unscheduledAll);

    const wrap = parent.createDiv({ cls: "bt-unscheduled-big" });
    wrap.dataset.view = "list";
    const head = wrap.createDiv({ cls: "bt-unscheduled-big-head" });
    head.createSpan({
      text: `${tr("pool.unscheduled")} (${unscheduled.length})`,
      cls: "bt-unscheduled-big-label",
    });
    const hint = head.createSpan({ cls: "bt-unscheduled-big-hint" });
    // UX-mobile §10: shortcut hint is desktop-only.
    hint.setText(tr(Platform.isMobile ? "unscheduled.mobileHint" : "unscheduled.hint"));

    const grid = wrap.createDiv({ cls: "bt-unscheduled-grid" });
    const col = grid.createDiv({ cls: "bt-unscheduled-col" });
    if (unscheduled.length === 0 && unscheduledBase.length > 0 && this.hasActiveFilters()) {
      this.renderFilterEmptyState(col);
    } else {
      for (const t of unscheduled) this.renderCard(col, t);
    }

    this.renderTrashZone(wrap);
  }

  // ---------- Card ----------

  /**
   * Render a top-level task card.
   *
   * `contextDate` (US-150): if the card is being rendered inside a column
   * whose day already represents the task's `⏳`, the meta-row `⏳ {date}`
   * badge is suppressed — it'd just repeat what the column header says.
   * Pass the column's ISO date for week / month tabs; pass `null` (the
   * default) for unscheduled / completed views, where the date isn't
   * implied by position and the badge is useful.
   */
  private renderCard(
    parent: HTMLElement,
    t: ParsedTask,
    contextDate: string | null = null,
  ) {
    const card = parent.createDiv({ cls: "bt-card" });
    card.dataset.taskId = t.id;
    if (this.contentEl.dataset.mobileLayout !== "true") card.draggable = true;
    if (this.state.selectedTaskId === t.id) card.addClass("selected");

    // US-115: deadline 已过 → red (`bt-overdue`); 3 days or fewer → yellow
    // (`bt-near-deadline`). Both a CSS hook AND a data attribute so e2e
    // selectors can read `[data-overdue]` / `[data-near-deadline]` per
    // ARCHITECTURE.md §8.6 (CSS class names are not part of the contract).
    // see USER_STORIES.md
    //
    // Only annotate active (todo) tasks. A done / dropped task that happens
    // to have a past deadline shouldn't render with the urgency styling — its
    // outcome is already settled.
    if (t.deadline && t.status === "todo") {
      const today = todayISO();
      const dd = daysBetween(today, t.deadline);
      if (dd < 0) {
        card.addClass("bt-overdue");
        card.dataset.overdue = "true";
      } else if (dd <= 3) {
        card.addClass("bt-near-deadline");
        card.dataset.nearDeadline = "true";
      }
    }

    // Title row
    const titleRow = card.createDiv({ cls: "bt-card-title-row" });
    const check = titleRow.createDiv({ cls: "bt-check" });
    check.setText(statusIcon(t.status));
    check.title = "Toggle done (space)";
    check.addEventListener("click", (e) => {
      void (async () => {
        e.stopPropagation();
        await this.runWithRemoveAnim(t.id, async () => {
          if (t.status === "done") await this.api.undone(t.id);
          else await this.api.done(t.id);
        });
      })();
    });

    const title = titleRow.createDiv({ cls: "bt-card-title", text: t.title });
    title.title = t.title; // tooltip for long titles
    if (t.status === "done") card.addClass("done");

    this.renderTaskTags(card, t.tags, "bt-card-tags");

    // Meta row
    const meta = card.createDiv({ cls: "bt-card-meta" });
    // task #43: route est/act labels through tr() so a CN session reads
    // "预估 30m / 实际 25m" instead of the raw English literals.
    if (t.estimate) meta.createSpan({ text: tr("meta.est", { dur: formatMinutes(t.estimate) }), cls: "bt-meta-est" });
    if (t.deadline) meta.createSpan({ text: `📅${t.deadline}`, cls: "bt-meta-deadline" });
    if (t.actual) meta.createSpan({ text: tr("meta.act", { dur: formatMinutes(t.actual) }), cls: "bt-meta-actual" });
    // US-150: hide the `⏳ {date}` badge when the card is rendered in a
    // column whose day already implies it. Otherwise (unscheduled pool /
    // completed view / etc.) the badge stays — date isn't implied by
    // position there, and the user needs to see when it was scheduled.
    if (t.scheduled && t.scheduled !== contextDate) {
      meta.createSpan({ text: `⏳${t.scheduled}`, cls: "bt-meta-sched" });
    }
    const path = meta.createSpan({ text: compactPath(t.path), cls: "bt-meta-path" });
    path.title = t.path;

    // Children expansion (recursive — renders grandchildren and deeper).
    //
    // US-148: a child with its own `⏳` ≠ the parent's belongs in *that* day's
    // column as a standalone card, NOT nested here. `hideChildrenOfVisibleParents`
    // surfaces it there; we just need to skip it on the parent side so it
    // doesn't double-render. Children without an independent schedule (or
    // matching the parent's) still render inline — they ride with the parent.
    const childLines = t.childrenLines;
    if (childLines.length > 0) {
      const expander = card.createDiv({ cls: "bt-card-children" });
      const resolved = childLines
        .map((l) => this.tasks.find((x) => x.path === t.path && x.line === l))
        .filter((x): x is ParsedTask => !!x);
      const children = resolved
        .filter((c) => !this.hasIndependentDateFromParent(c, t));
      // US-125 task #33 observability — the "subtask missing from parent
      // card" repro is hard to capture in synthetic e2e (Engineer scanned 6
      // axes, none reproduced). When a user trips the bug, ask them to
      // run `localStorage.setItem("task-center-debug","1")` then reload;
      // the next render dumps which children were resolved vs filtered
      // and why. Strip this once the bug is closed.
      if (childLines.length !== children.length && this.isDebugLogging()) {
        const dropped = childLines
          .map((l) => {
            const r = resolved.find((x) => x.line === l);
            if (!r) return { line: l, reason: "not_found_in_tasks" };
            if (r.scheduled && r.scheduled !== t.scheduled) {
              return {
                line: l,
                title: r.title,
                scheduled: r.scheduled,
                reason: "cross_day_filter",
              };
            }
            return null;
          })
          .filter((x) => x !== null);
        console.debug(
          "[task-center US-125] renderCard children diff",
          { parent: t.id, childLines, resolvedCount: resolved.length, kept: children.length, dropped },
        );
      }
      for (const c of children) this.renderSubcard(expander, c, t.scheduled ?? null);
    }

    this.wireCardEvents(card, t);
    // Mobile gestures still need the pointer controller; source/context
    // editing is now the single-click source shell on every platform.
    if (isMobileMode()) {
      // Unified mobile gesture controller (UX-mobile §13 #6): long-press,
      // scroll cancellation, and swipe share one state machine.
      //   US-506: hold N ms still → openCardActionSheet (action menu)
      //   US-507: no mobile drag/drop; movement routes to scroll/swipe.
      //   US-508: swipe ≥ 30% left → done; ≥ 30% right → drop; both with
      //           1s undo toast (settings.mobileSwipeEnabled gates).
      //   US-510: swipe is opt-out via settings (platform-conditional UI).
      // see USER_STORIES.md
      const settings = this.plugin.settings;
      attachCardGestures(card, {
        longPressMs: settings.mobileLongPressMs,
        moveThresholdPx: 4,
        swipeThresholdRatio: 0.3,
        onLongPress: () => this.openCardActionSheet(t),
        // Per US-510, swipe is opt-out via settings. When disabled the
        // gesture controller still parses left/right but never commits.
        onSwipeLeft: settings.mobileSwipeEnabled
          ? () => { void this.swipeAction(t, "done"); }
          : undefined,
        onSwipeRight: settings.mobileSwipeEnabled
          ? () => { void this.swipeAction(t, "drop"); }
          : undefined,
      });
    }
  }

  /**
   * US-508: commit a swipe action. Pushes the resulting byte-level diff to
   * the undo stack so the user can recover via the long-press menu (M-3
   * step 3 will surface an explicit undo button there). Notice toast is
   * 1s — short enough not to block, long enough to register what happened.
   */
  private async swipeAction(t: ParsedTask, kind: "done" | "drop"): Promise<void> {
    try {
      const r =
        kind === "done" ? await this.api.done(t.id) : await this.api.drop(t.id);
      if (!r.unchanged) {
        this.undoStack.push({
          label: kind === "done" ? "swipe done" : "swipe drop",
          ops: [
            {
              path: t.path,
              line: t.line,
              before: [r.before],
              after: [r.after],
            },
          ],
        });
      }
      new Notice(kind === "done" ? "✓ Done" : tr("trash.dropped"), 1000);
    } catch (err) {
      new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
    }
    this.scheduleRefresh();
  }

  // Renders a subcard + its own children recursively. The nested
  // `.bt-card-children` block is a sibling of the subcard so each level
  // inherits the 22px margin-left from CSS, producing a staircase indent.
  //
  // No `parent` parameter: cross-day subtasks are surfaced as top-level
  // cards on their own day (US-148), so by the time we reach this
  // function the subtask either rides with its parent's `⏳` or has none
  // — no `parent` comparison needed.
  //
  // US-142: subcards render recursively (this fn calls itself for each
  // grandchild that's still in scope), so nested subtasks display all
  // levels under their visible parent on desktop.
  // US-149: subtask `⏳` badge rules — child sharing parent's date never
  // shows a badge here (parent's column already implies it); cross-day
  // children are filtered out before reaching this function (US-148).
  // US-505: on mobile, deeper-than-1-level subtrees collapse to a `+N`
  // chip that opens a bottom sheet (see Platform.isMobile branch below)
  // rather than rendering inline — keeps card height bounded on phones.
  //
  // Task #36: `effectiveScheduled` is the date inherited from the
  // visible card chain — top card's `⏳` for direct children, propagated
  // through subcards that don't carry their own `⏳`. The recursive
  // grandchild filter compares against this inherited value, so a
  // grandchild whose `⏳` matches the TOP card still renders even if
  // the middle subcard has no `⏳` of its own.
  // see USER_STORIES.md
  private renderSubcard(
    container: HTMLElement,
    c: ParsedTask,
    effectiveScheduled: string | null,
  ) {
    const subCard = container.createDiv({ cls: "bt-subcard" });
    subCard.dataset.taskId = c.id;
    if (this.contentEl.dataset.mobileLayout !== "true") subCard.draggable = true;
    if (this.state.selectedTaskId === c.id) subCard.addClass("selected");

    const check = subCard.createEl("button", { cls: "bt-sub-check", text: statusIcon(c.status) });
    check.type = "button";
    check.dataset.cardAction = "done";
    check.title = c.status === "done" ? tr("ctx.markTodo") : tr("ctx.markDone");
    check.setAttr("aria-label", check.title);
    check.addEventListener("click", (e) => {
      void (async () => {
        e.stopPropagation();
        await this.runWithRemoveAnim(c.id, async () => {
          if (c.status === "done") await this.api.undone(c.id);
          else await this.api.done(c.id);
        });
      })();
    });

    const title = subCard.createDiv({ cls: "bt-subcard-title", text: c.title });
    title.dataset.cardAction = "open";
    title.title = c.title;

    // (Previous `bt-sub-sched` badge for cross-day subtasks removed —
    //  US-148 now surfaces such subtasks as standalone top-level cards
    //  on their own day, so the inline badge can never trigger. Subcards
    //  reaching this branch always share their parent's `⏳` or have
    //  none of their own; no badge needed in either case.)
    if (c.estimate) subCard.createDiv({ cls: "bt-sub-est", text: formatMinutes(c.estimate) });
    if (c.status === "done") subCard.addClass("done");
    // task #37: subcards are drag SOURCES but not nest drop targets. The
    // browser's hit-test lands on the deepest DOM node under the cursor, so
    // a drop visually aimed at the parent card's body would otherwise nest
    // under the subcard the cursor happened to be over. Letting the drop
    // event bubble up to the enclosing `.bt-card` makes the drop land where
    // the user expects (the parent). To explicitly nest under a subcard the
    // user can still drop onto its top-level card rendering on its own day
    // when it has its own ⏳.
    this.wireCardEvents(subCard, c, { acceptNestDrop: false });

    const grandLines = c.childrenLines;
    if (grandLines.length > 0) {
      if (Platform.isMobile) {
        // US-505: mobile collapses to 1 level. Each subcard with deeper
        // children gets a `+N` chip; tapping it opens a bottom-sheet
        // preview of the full subtree (recursive semantic preserved per
        // US-142 — just visually deferred).
        const total = this.countDescendants(c);
        const more = subCard.createDiv({ cls: "bt-subcard-more" });
        more.setText(`+${total}`);
        more.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openSubtreeSheet(c);
        });
      } else {
        // US-148 (recursive): a grandchild with its own ⏳ different from the
        // **effective inherited** day should render independently in its
        // own day, not nested here. Same rule as the top-level card /
        // first-level subtask filter — but we compare against the
        // inherited chain (top card → … → c), not just c's raw
        // `scheduled`, so a grandchild matching top survives even when
        // middle subcards have no `⏳` of their own (task #36).
        const inheritedDown = c.scheduled ?? effectiveScheduled;
        const sub = container.createDiv({ cls: "bt-card-children" });
        const grand = grandLines
          .map((l) => this.tasks.find((x) => x.path === c.path && x.line === l))
          .filter((x): x is ParsedTask => !!x)
          .filter((g) => !(g.scheduled && g.scheduled !== inheritedDown));
        for (const g of grand) this.renderSubcard(sub, g, inheritedDown);
      }
    }
  }

  private renderTaskTags(parent: HTMLElement, tags: string[], extraClass: string) {
    const displayTags = taskDisplayTags(tags);
    if (displayTags.length === 0) return;

    const row = parent.createDiv({ cls: `bt-task-tags ${extraClass}` });
    for (const tag of displayTags) {
      row.createSpan({ cls: "bt-task-tag", text: tag });
    }
  }

  /** Count all descendants (children + grandchildren + …) of a task. */
  private countDescendants(c: ParsedTask): number {
    let count = 0;
    const queue: number[] = [...c.childrenLines];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const line = queue.shift()!;
      if (seen.has(line)) continue;
      seen.add(line);
      const child = this._taskIndex.get(`${c.path}:L${line + 1}`);
      if (child) {
        count++;
        queue.push(...child.childrenLines);
      }
    }
    return count;
  }

  /**
   * Mobile-only: open a bottom-sheet preview of a subtree. Each descendant
   * renders as one row, indented by depth. Used by the `+N` chip on
   * subcards (US-505 second sentence — visual collapse to 1 level, full
   * tree available on demand).
   */
  private openSubtreeSheet(root: ParsedTask): void {
    // Walk the subtree depth-first, recording each task with its depth
    // relative to the root. Same-file children only (ARCHITECTURE §1.4).
    // Cycle guard mirrors `countDescendants` — production data shouldn't
    // produce cycles, but parser bugs / hand-edited files could, and a
    // BottomSheet that hangs is worse than one that under-counts.
    const rows: Array<{ task: ParsedTask; depth: number }> = [];
    const seen = new Set<number>();
    const walk = (parent: ParsedTask, depth: number) => {
      for (const line of parent.childrenLines) {
        if (seen.has(line)) continue;
        seen.add(line);
        const child = this._taskIndex.get(`${parent.path}:L${line + 1}`);
        if (!child) continue;
        rows.push({ task: child, depth });
        walk(child, depth + 1);
      }
    };
    walk(root, 0);

    const sheet = new BottomSheet(this.app, {
      title: root.title,
      populate: (el) => {
        if (rows.length === 0) {
          el.createDiv({ cls: "bt-sheet-empty", text: tr("sheet.empty") });
          return;
        }
        for (const { task, depth } of rows) {
          const row = el.createDiv({ cls: "bt-sheet-task" });
          row.dataset.taskId = task.id;
          // Indent visually by depth — uses padding-left so the row stays
          // a normal flex container for the title + meta.
          row.style.paddingLeft = `${8 + depth * 16}px`;
          row.createSpan({
            cls: "bt-sheet-task-title",
            text: `${statusIcon(task.status)} ${task.title}`,
          });
          if (task.scheduled) {
            row.createSpan({
              cls: "bt-sheet-task-meta",
              text: `⏳ ${task.scheduled}`,
            });
          }
          row.addEventListener("click", () => {
            sheet.close();
            this.state.selectedTaskId = task.id;
            this.render();
          });
        }
      },
    });
    sheet.open();
  }

  private wireCardEvents(
    el: HTMLElement,
    t: ParsedTask,
    opts: { acceptNestDrop?: boolean } = {},
  ) {
    const acceptNestDrop = opts.acceptNestDrop ?? true;
    // Drag source
    el.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.stopPropagation();
      e.dataTransfer.setData("text/task-id", t.id);
      e.dataTransfer.effectAllowed = "move";
      el.addClass("dragging");
      // View-wide "a drag is in progress" marker so drop zones (esp. the
      // abandon target can attract attention without waiting for direct hover.
      this.contentEl.addClass("dragging-active");
    });
    el.addEventListener("dragend", (e) => {
      e.stopPropagation();
      el.removeClass("dragging");
      this.contentEl.removeClass("dragging-active");
    });

    // Drop target: dropping another card onto this one nests it as a subtask
    // (works cross-file). stopPropagation prevents the underlying day column
    // from also receiving the drop and just rescheduling.
    //
    // Skipped for subcards (task #37): subcards live inside a parent card's
    // visible area, so registering them as drop targets would steal drops
    // aimed at the parent. Letting the event bubble up to the enclosing
    // `.bt-card` matches the user's visual intent (they see the parent card,
    // not the inner sub-row, as the drop target).
    if (acceptNestDrop) {
      el.addEventListener("dragover", (e) => {
        const dt = e.dataTransfer;
        if (!dt || !dt.types.includes("text/task-id")) return;
        if (el.classList.contains("dragging")) return; // self
        e.preventDefault();
        e.stopPropagation();
        dt.dropEffect = "move";
        el.addClass("nest-target");
      });
      el.addEventListener("dragleave", (e) => {
        // dragleave fires for child elements as the cursor moves between them;
        // only clear the class when the cursor truly leaves this card.
        const related = e.relatedTarget as Node | null;
        if (related && el.contains(related)) return;
        el.removeClass("nest-target");
      });
      el.addEventListener("drop", (e) => {
        void (async () => {
          const dt = e.dataTransfer;
          if (!dt) return;
          const droppedId = dt.getData("text/task-id");
          if (!droppedId || droppedId === t.id) return;
          e.preventDefault();
          e.stopPropagation();
          el.removeClass("nest-target");
          // Nest writes to one or two files (cross-file). Wait for metadataCache to
          // reparse them before rendering so the new parent shows the new child.
          const droppedTask = this.tasks.find((x) => x.id === droppedId);
          const awaitCachePaths = [t.path];
          if (droppedTask && droppedTask.path !== t.path) awaitCachePaths.push(droppedTask.path);
          try {
            await this.runWithRemoveAnim(droppedId, async () => {
              const r = await this.api.nest(droppedId, t.id);
              if (!r.unchanged) {
                if (r.undoOps && r.undoOps.length > 0) {
                  this.undoStack.push({
                    label: `nest under "${t.title.slice(0, 20)}"`,
                    ops: r.undoOps,
                  });
                }
                new Notice(
                  tr("notice.nested", {
                    title: t.title,
                    where: r.crossFile ? tr("notice.crossFile") : "",
                  }),
                );
              }
            }, { awaitCachePaths });
          } catch (err) {
            new Notice(tr("notice.error", { msg: (err as Error).message }), 6000);
            this.scheduleRefresh();
          }
        })();
      });
    }

    // Click → source edit shell. US-168 replaces hover previews and
    // double-click source jumps with one primary card action.
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.openSourceEditShell(t);
    });

    // Right-click context menu
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openContextMenu(e, t);
    });
  }

  private makeDropZone(el: HTMLElement, targetDate: string | null) {
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

  private getTextFilter(): (t: ParsedTask) => boolean {
    const q = this.state.filter.trim().toLowerCase();
    const tags = parseFilterTags(this.state.savedViewTag);
    const time = this.state.savedViewTime;
    const status = normalizeSavedViewStatus(this.state.savedViewStatus);
    if (!q && tags.length === 0 && !this.hasTimeFilters(time) && status === "all") return () => true;
    return (t) => {
      if (q && !taskMatchesText(t, q)) return false;
      for (const tag of tags) {
        if (!taskHasTag(t, tag)) return false;
      }
      if (!this.taskMatchesTimeFilters(t, time)) return false;
      if (status !== "all" && !status.includes(t.status)) return false;
      return true;
    };
  }

  private getSavedViewFilter(view: QueryPreset): (t: ParsedTask) => boolean {
    const normalized = normalizeQueryPreset(view);
    const q = (normalized.filters.search ?? "").trim().toLowerCase();
    const tags = parseFilterTags(queryPresetTagString(normalized));
    const time = normalized.filters.time ?? {};
    const status = normalizeSavedViewStatus(normalized.filters.status);
    if (!q && tags.length === 0 && !this.hasTimeFilters(time) && status === "all") return () => true;
    return (t) => {
      if (q && !taskMatchesText(t, q)) return false;
      for (const tag of tags) {
        if (!taskHasTag(t, tag)) return false;
      }
      if (!this.taskMatchesTimeFilters(t, time)) return false;
      if (status !== "all" && !status.includes(t.status)) return false;
      return true;
    };
  }

  private hasTimeFilters(time: SavedViewTimeFilters): boolean {
    return Object.values(time).some((value) => !!value?.trim());
  }

  private taskMatchesTimeFilters(task: ParsedTask, time: SavedViewTimeFilters): boolean {
    for (const field of ["scheduled", "deadline", "completed", "created"] as SavedViewTimeField[]) {
      const token = time[field]?.trim();
      if (token && !taskMatchesTimeFilter(task, field, token, this.plugin.settings.weekStartsOn)) return false;
    }
    return true;
  }

  private collectTagOptions(): Array<{ tag: string; count: number }> {
    const options = new Map<string, { tag: string; count: number }>();
    const selected = new Set(parseFilterTags(this.state.savedViewTag));
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
    const status = normalizeSavedViewStatus(this.state.savedViewStatus);
    for (const task of this.tasks) {
      if (q && !taskMatchesText(task, q)) continue;
      if (!this.taskMatchesTimeFilters(task, time)) continue;
      if (status !== "all" && !status.includes(task.status)) continue;
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

  private collectKnownTags(): string[] {
    return this.collectTagOptions().map((option) => option.tag);
  }

  private setSelectedTags(tags: string[], rerenderControls?: FilterControlsRerender): void {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of tags) {
      const tag = normalizeFilterTag(raw);
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
    }
    this.state.savedViewTag = out.join(",");
    this.filterPopoverOpen = "tag";
    this.refreshFilterControls(rerenderControls);
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

  private applySavedView(view: QueryPreset): void {
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

  private suggestSavedViewName(): string {
    return suggestSavedViewNameForFilters(
      { tags: this.state.savedViewTag, status: this.state.savedViewStatus },
      tr("savedViews.defaultName"),
    );
  }

  private askSavedViewName(initialName = this.suggestSavedViewName()): Promise<string | null> {
    return new Promise((resolve) => {
      new SavedViewNameModal(this.app, initialName, resolve).open();
    });
  }

  private async saveCurrentView(name: string): Promise<void> {
    const active = this.activeSavedView();
    const view = normalizeQueryPreset({
      ...this.currentQuerySnapshot(active, name),
      id: createSavedViewId(),
      builtin: false,
      hidden: false,
    });
    this.plugin.settings.queryPresets = upsertQueryPreset(this.plugin.settings.queryPresets, view);
    this.tabDrafts.delete(view.id);
    this.applySavedView(view);
    await this.plugin.saveSettings();
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
        summary: this.currentSavedViewSummary(),
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

  private persistCurrentDraft(): void {
    const selected = this.selectedSavedView();
    if (!selected) return;
    if (this.isSelectedSavedViewDirty(selected)) {
      this.tabDrafts.set(selected.id, this.currentQuerySnapshot(selected));
    } else {
      this.tabDrafts.delete(selected.id);
    }
  }

  private activeSavedView(): QueryPreset {
    const selected = this.selectedSavedView();
    if (selected) return selected;
    const fallback = this.visibleQueryTabs()[0];
    if (fallback) return fallback;
    return normalizeQueryPreset({
      id: builtinSavedViewId("today"),
      name: tr("tab.today"),
      builtin: true,
      hidden: false,
      filters: { status: ["todo"] },
      view: { type: "list", preset: "today" },
      summary: [],
    });
  }

  private currentQuerySnapshot(existing?: QueryPreset | null, name?: string): QueryPreset {
    const tagStr = this.state.savedViewTag;
    const tagArray = tagStr ? tagStr.split(",").filter(Boolean) : undefined;
    return normalizeQueryPreset({
      id: existing?.id ?? `draft-${this.state.tab}`,
      name: (name ?? existing?.name ?? this.suggestSavedViewName()).trim(),
      builtin: existing?.builtin ?? false,
      hidden: existing?.hidden ?? false,
      filters: {
        ...(this.state.filter ? { search: this.state.filter } : {}),
        ...(tagArray && tagArray.length > 0 ? { tags: tagArray } : {}),
        time: this.state.savedViewTime,
        status: this.state.savedViewStatus,
      },
      view: this.currentQueryPresetViewConfig(),
      summary: this.currentSavedViewSummary(),
    });
  }

  private isSelectedSavedViewDirty(view: QueryPreset): boolean {
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
        const parsed = parseQueryDsl(text, { name: this.suggestSavedViewName() });
        await this.saveCurrentViewFromDsl(parsed);
      }
      this.refreshFilterControls(rerenderControls);
    }).open();
  }

  private currentQueryPresetViewConfig(): QueryPresetViewConfig {
    switch (this.state.tab) {
      case "week":
        return { type: "week" };
      case "month":
        return { type: "month" };
      case "list":
        return { type: "list" };
      case "completed":
        return { type: "list", preset: "completed", orderBy: ["completed_desc"] };
      case "unscheduled":
        return { type: "list", preset: "unscheduled", orderBy: ["deadline_risk", "created_desc"] };
      case "today":
      default:
        return { type: "list", preset: "today" };
    }
  }

  private currentSavedViewSummary(): QueryPresetSummaryMetric[] {
    if (this.state.tab === "completed") {
      return [
        { type: "count" },
        { type: "sum", field: "actual", format: "duration" },
        { type: "ratio", numerator: "actual", denominator: "estimate", format: "percent" },
      ];
    }
    if (this.state.tab === "unscheduled") {
      return [{ type: "count" }];
    }
    return [];
  }

  private tabForSavedView(view: QueryPreset, fallback: TabKey): TabKey {
    const config = normalizeQueryPreset(view).view;
    if (config?.type === "week") return "week";
    if (config?.type === "month") return "month";
    if (config?.preset === "completed") return "completed";
    if (config?.preset === "unscheduled") return "unscheduled";
    if (config?.preset === "today") return "today";
    if (config?.type === "list") return "list";
    return fallback;
  }

  private refreshFilterControls(rerenderControls?: FilterControlsRerender): void {
    if (rerenderControls) rerenderControls();
    else this.render();
  }

  private handleFilterOutsidePointerDown(event: PointerEvent): void {
    const isInsideFilterControls = event.composedPath().some((target) => {
      return target instanceof HTMLElement && !!target.closest("[data-saved-views]");
    });
    if (!shouldCloseFilterPopoverOnPointerDown({
      isOpen: this.filterPopoverOpen !== null,
      isInsideFilterControls,
    })) return;

    this.filterPopoverOpen = null;
    this.pendingDateRangeStart = null;
    this.render();
  }

  // ---------- Footer / Add ----------

  private renderFooter(parent: HTMLElement) {
    const foot = parent.createDiv({ cls: "bt-footer" });
    const info = foot.createDiv({ cls: "bt-footer-info" });
    const total = this.tasks.filter((t) => t.status === "todo" && !t.inheritsTerminal).length;
    const done = this.tasks.filter((t) => t.status === "done").length;
    const overdue = this.tasks.filter(
      (t) => t.status === "todo" && !t.inheritsTerminal && t.deadline && t.deadline < todayISO(),
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

  // ---------- Context menu / source ----------

  // US-164: right-click a card to get secondary task actions — toggle
  // done, schedule today / tomorrow / clear, drop.
  // Source/context editing is now the US-168 single-click source shell.
  // Wired from `wireCardEvents`'s `contextmenu` listener.
  // see USER_STORIES.md
  openContextMenu(e: MouseEvent, task: ParsedTask) {
    const m = new Menu();
    m.addItem((i) =>
      i.setTitle(task.status === "done" ? tr("ctx.markTodo") : tr("ctx.markDone")).onClick(async () => {
        await this.runWithRemoveAnim(task.id, async () => {
          if (task.status === "done") await this.api.undone(task.id);
          else await this.api.done(task.id);
        });
      }),
    );
    m.addItem((i) =>
      i.setTitle(tr("ctx.scheduleToday")).onClick(async () => {
        const target = todayISO();
        if ((task.scheduled ?? null) !== target) {
          await this.runWithRemoveAnim(task.id, () => this.api.schedule(task.id, target));
        } else {
          this.scheduleRefresh();
        }
      }),
    );
    m.addItem((i) =>
      i.setTitle(tr("ctx.scheduleTomorrow")).onClick(async () => {
        const target = addDays(todayISO(), 1);
        if ((task.scheduled ?? null) !== target) {
          await this.runWithRemoveAnim(task.id, () => this.api.schedule(task.id, target));
        } else {
          this.scheduleRefresh();
        }
      }),
    );
    m.addItem((i) =>
      i.setTitle(tr("ctx.clearSchedule")).onClick(async () => {
        if (task.scheduled) {
          await this.runWithRemoveAnim(task.id, () => this.api.schedule(task.id, null));
        } else {
          this.scheduleRefresh();
        }
      }),
    );
    m.addItem((i) =>
      i.setTitle(tr("ctx.drop")).onClick(async () => {
        await this.runWithRemoveAnim(task.id, () => this.api.drop(task.id));
      }),
    );
    m.showAtMouseEvent(e);
  }

  openDatePrompt(task: ParsedTask) {
    new DatePromptModal(
      this.app,
      tr("prompt.setScheduled", { title: task.title }),
      task.scheduled ?? todayISO(),
      (resolved) => {
        void (async () => {
          if (resolved === undefined) return;
          const willMove = (task.scheduled ?? null) !== (resolved ?? null);
          const work = async () => {
            const r = await this.api.schedule(task.id, resolved);
            if (!r.unchanged) {
              this.undoStack.push({
                label: resolved ? `⏳ ${resolved}` : "⏳ cleared",
                ops: [{ path: task.path, line: task.line, before: [r.before], after: [r.after] }],
              });
            }
          };
          if (willMove) {
            await this.runWithRemoveAnim(task.id, work);
          } else {
            await work();
            this.scheduleRefresh();
          }
        })();
      },
    ).open();
  }

  openQuickAdd() {
    new QuickAddModal(
      this.app,
      this.api,
      () => this.scheduleRefresh(),
      this.plugin.settings,
      this.collectKnownTags(),
    ).open();
  }

}

function statusIcon(s: string): string {
  if (s === "done") return "✔";
  if (s === "dropped") return "✕";
  if (s === "in_progress") return "◐";
  return "○";
}

function compactPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 2) return p;
  return ".../" + parts.slice(-2).join("/");
}
