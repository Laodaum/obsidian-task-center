import {
  ItemView,
  MarkdownView,
  Modal,
  WorkspaceLeaf,
  Menu,
  Notice,
  Platform,
  TFile,
  setIcon,
} from "obsidian";
import { ParsedTask, VIEW_TYPE_TASK_CENTER } from "./types";
import { formatMinutes } from "./parser";
import { TaskCenterApi } from "./api";
import { computeSummary, type SummaryResultItem } from "./query/summary";
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
import { attachCardGestures, attachLongPress } from "./view/touch";
import { shouldCloseFilterPopoverOnPointerDown, isClickInsideFilterControls } from "./view/filter-popover";
import { isMobileMode } from "./platform";
import { openTaskSourceEditShell } from "./view/source-dialog";
import { markdownSourceOpenState } from "./view/source-open-state";
import { weekMinHeightFromViewHeightPx } from "./view/layout";
import { SavedViewNameModal } from "./view/saved-view-name-modal";
import { QueryDslModal, type QueryDslSubmitMode } from "./view/query-dsl-modal";
import type { FilterPopoverKey, TabKey, ViewState } from "./view/state";
import { taskDisplayTags } from "./tags";
import { formatDateFilterLabel } from "./date-filter";
import { taskMatchesTimeToken, timeTokenAppliesToField } from "./time-filter";
import { deriveEffectiveTasks, countTopLevel, recomputeTopLevelInQuery } from "./task-tree";
import type { EffectiveTask } from "./task-tree";
import { applyQueryFilters } from "./query/filter";
import { projectListArea, projectMatrixArea } from "./query/projection";
import type { MatrixViewModel } from "./query/projection";
import {
  applyQueryPresetFilters,
  builtinSavedViewId,
  collectAreas,
  findAreaByType,
  computeQueryPresetSnapshot,
  computeDeleteQueryPresetState,
  computeUndoQueryPresetState,
  executeDeleteQueryPresetFlow,
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
  reorderQueryPresetById,
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
  handleQueryEditorSummaryEdit,
  handleQueryEditorSummaryAdd,
  handleQueryEditorSummaryRemove,
} from "./saved-views";
import type {
  QueryPresetDeleteFlowCallbacks,
  QueryEditorSummaryDraftParams,
} from "./saved-views";
import type {
  AreaConfig,
  AreaType,
  GridAreaConfig,
  LayoutNode,
  ListAreaConfig,
  MatrixAreaConfig,
  QueryPreset,
  QueryPresetViewConfig,
  SavedViewStatus,
  QueryPresetSummaryMetric,
  TaskStatus,
} from "./types";
import { isStackNode } from "./types";
import type { SavedViewTimeField, SavedViewTimeFilters } from "./types";
import type TaskCenterPlugin from "./main";

const PRIMARY_TIME_FIELD: SavedViewTimeField = "scheduled";
const SECONDARY_TIME_FIELDS: SavedViewTimeField[] = ["deadline", "completed", "created"];
type FilterControlsRerender = () => void;
type TagEditResult = {
  add: string[];
  remove: string[];
};

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

function normalizeEditorTag(value: string): string | null {
  const trimmed = value.trim().replace(/^#+/, "");
  if (!trimmed) return null;
  const token = trimmed.split(/[\s,，]+/)[0]?.trim();
  if (!token) return null;
  return `#${token}`;
}

function parseEditorTags(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(/[\s,，]+/)) {
    const tag = normalizeEditorTag(part);
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

function effectiveTimeValue(t: EffectiveTask, field: SavedViewTimeField): string | null {
  if (field === "scheduled") return t.effectiveScheduled;
  if (field === "deadline") return t.effectiveDeadline;
  if (field === "completed") return t.completed;
  if (field === "dropped") return t.cancelled;
  return t.effectiveCreated ?? t.created;
}

function taskMatchesTimeFilter(t: EffectiveTask, field: SavedViewTimeField, token: string, weekStartsOn: 0 | 1): boolean {
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
    this.contentEl.createEl("h4", { text: tr("savedViews.switchDirtyTitle") });
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
    if (isMobileMode()) {
      await this.openNativeSourceEditor(task);
      return;
    }
    await openTaskSourceEditShell(this.app, this.leaf, task, {
      onSave: async () => {
        await this.waitForCacheUpdate([task.path], 2000);
        await this.reloadTasks();
        this.bumpCacheVersion();
        this.render();
      },
    });
  }

  private async openNativeSourceEditor(task: ParsedTask): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.path);
    if (!(file instanceof TFile)) {
      new Notice(tr("notice.fileNotFound", { path: task.path }));
      return;
    }
    try {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file, markdownSourceOpenState(task.line, true));
      if (typeof leaf.loadIfDeferred === "function") await leaf.loadIfDeferred();
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.editor) {
        throw new Error("native MarkdownView editor missing");
      }
      const pos = { line: task.line, ch: 0 };
      view.editor.setCursor(pos);
      view.editor.scrollIntoView({ from: pos, to: pos }, true);
      view.editor.focus();
    } catch (err) {
      new Notice(tr("sourceEdit.nativeFailed"));
      console.error(err);
    }
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
    this._effectiveTasks = [];
  }

  /**
   * Returns the EffectiveTask[] derived from `this.tasks` via
   * `deriveEffectiveTasks`.  The result is cached until the next
   * `reloadTasks` clears it, so multiple render calls within a
   * single paint never recompute the tree.
   */
  private getEffectiveTasks(): EffectiveTask[] {
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
      this.renderMigrationGate(el);
      return;
    }

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
   * US-415: full-view upgrade gate. Shown instead of the board when legacy
   * view data (flat SavedTaskView or old-DSL `view`) was detected at load.
   * Tells the user what changed and what's new, then offers a single confirm
   * action that persists the already-in-memory-migrated data and enters the
   * new board. Nothing of the board renders until the user confirms.
   */
  private renderMigrationGate(el: HTMLElement): void {
    const count = this.plugin.migratedLegacyCount;
    const gate = el.createDiv({ cls: "tc-migration-gate" });
    gate.dataset.migratedCount = String(count);

    const card = gate.createDiv({ cls: "tc-migration-card" });

    const header = card.createDiv({ cls: "tc-migration-header" });
    header.createSpan({ cls: "tc-migration-badge", text: tr("migration.badge") });
    header.createEl("h2", { cls: "tc-migration-title", text: tr("migration.title") });
    header.createEl("p", { cls: "tc-migration-lead", text: tr("migration.lead", { n: count }) });

    // What's new — a bento grid where each new capability is one cell with a
    // small CSS-drawn illustration so the change is easy to grasp at a glance.
    card.createEl("h3", { cls: "tc-migration-subhead", text: tr("migration.whatsNewTitle") });
    const bento = card.createDiv({ cls: "tc-migration-bento" });
    this.renderBentoCell(bento, "layout", "migration.feature1Title", "migration.feature1Desc");
    this.renderBentoCell(bento, "model", "migration.feature2Title", "migration.feature2Desc");
    this.renderBentoCell(bento, "preset", "migration.feature3Title", "migration.feature3Desc");
    this.renderBentoCell(bento, "ui", "migration.feature4Title", "migration.feature4Desc");

    // Primary action sits right under What's New so it's visible without
    // scrolling past the (potentially long) migrated-views list below.
    const actions = card.createDiv({ cls: "tc-migration-actions" });
    const cta = actions.createEl("button", { text: tr("migration.cta"), cls: "mod-cta" });
    cta.dataset.action = "complete-migration";
    cta.addEventListener("click", () => {
      cta.disabled = true;
      void this.plugin.completeMigration();
    });

    // The concrete list of views that will migrate — builtin vs custom tagged.
    const viewsSection = card.createDiv({ cls: "tc-migration-views" });
    viewsSection.createEl("h3", {
      cls: "tc-migration-subhead",
      text: tr("migration.viewsTitle", { n: count }),
    });
    const list = viewsSection.createEl("ul", { cls: "tc-migration-view-list" });
    for (const view of this.plugin.migratedLegacyViews) {
      const item = list.createEl("li", { cls: "tc-migration-view-item" });
      item.createSpan({ cls: "tc-migration-view-dot" });
      item.createSpan({ cls: "tc-migration-view-name", text: view.name });
      item.createSpan({
        cls: `tc-migration-view-tag ${view.builtin ? "is-builtin" : "is-custom"}`,
        text: view.builtin ? tr("migration.viewsBuiltin") : tr("migration.viewsCustom"),
      });
    }

    card.createEl("p", { cls: "tc-migration-note", text: tr("migration.note") });

    window.setTimeout(() => cta.focus(), 10);
  }

  /**
   * One bento cell of the upgrade gate: a CSS-drawn illustration (`art`) plus a
   * title and one-line description. The illustration is built from plain divs so
   * it inherits theme accent colors and needs no SVG/asset.
   */
  private renderBentoCell(
    grid: HTMLElement,
    art: "layout" | "model" | "preset" | "ui",
    titleKey: Parameters<typeof tr>[0],
    descKey: Parameters<typeof tr>[0],
  ): void {
    const cell = grid.createDiv({ cls: `tc-bento-cell tc-bento-cell--${art}` });
    const figure = cell.createDiv({ cls: "tc-bento-art" });
    figure.dataset.art = art;
    if (art === "layout") {
      // A composable layout: one wide area stacked over a row of two areas.
      figure.createDiv({ cls: "tc-art-block is-wide" });
      const row = figure.createDiv({ cls: "tc-art-row" });
      row.createDiv({ cls: "tc-art-block" });
      row.createDiv({ cls: "tc-art-block" });
    } else if (art === "model") {
      // One shared model bridging GUI and CLI through a JSON DSL.
      figure.createSpan({ cls: "tc-art-chip", text: "GUI" });
      figure.createSpan({ cls: "tc-art-link" });
      figure.createSpan({ cls: "tc-art-chip is-dsl", text: "{ }" });
      figure.createSpan({ cls: "tc-art-link" });
      figure.createSpan({ cls: "tc-art-chip", text: "CLI" });
    } else if (art === "preset") {
      // A built-in tab duplicated into an editable preset.
      figure.createDiv({ cls: "tc-art-tab is-back" });
      const front = figure.createDiv({ cls: "tc-art-tab is-front" });
      front.createSpan({ cls: "tc-art-plus", text: "+" });
    } else {
      // A refreshed UI: a mini window mock with a sparkle.
      const win = figure.createDiv({ cls: "tc-art-window" });
      const bar = win.createDiv({ cls: "tc-art-winbar" });
      bar.createSpan({ cls: "tc-art-dot" });
      bar.createSpan({ cls: "tc-art-dot" });
      bar.createSpan({ cls: "tc-art-dot" });
      const body = win.createDiv({ cls: "tc-art-winrow" });
      body.createSpan({ cls: "tc-art-fill" });
      body.createSpan({ cls: "tc-art-fill is-muted" });
      figure.createSpan({ cls: "tc-art-sparkle", text: "✦" });
    }
    cell.createEl("h4", { cls: "tc-bento-title", text: tr(titleKey) });
    cell.createEl("p", { cls: "tc-bento-desc", text: tr(descKey) });
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
    const mobileLayout = this.contentEl.dataset.mobileLayout === "true";
    // VAL-GUI-005: when there are more than MAX_VISIBLE_TABS, overflow
    // tabs go into a "更多" button. Overflow tabs retain order, badges,
    // default behavior, and keyboard shortcuts.
    // Keyboard shortcuts ⌃1–⌃9 map to the first 9 visible tabs.
    //
    // US-117b / US-510: mobile may pan the tab strip horizontally, but it
    // must not expose desktop shortcut affordances.
    const MAX_VISIBLE_TABS = 9;
    const visibleTabs = tabs.slice(0, MAX_VISIBLE_TABS);
    const overflowTabs = tabs.slice(MAX_VISIBLE_TABS);

    for (const [index, view] of visibleTabs.entries()) {
      this.renderTabButton(bar, view, index, mobileLayout);
    }

    // Overflow "更多" button — first-class tab metadata
    if (overflowTabs.length > 0) {
      const moreBtn = bar.createDiv({ cls: "bt-tab bt-tab-more" });
      // data-tab-id anchors this as a first-class entry for e2e selectors
      moreBtn.dataset.queryTabId = "__overflow__";
      moreBtn.dataset.tabId = "__overflow__";
      // Aggregate metadata: show dirty/default if ANY overflow tab carries it
      if (overflowTabs.some((v) => this.isSavedViewDirty(v))) {
        moreBtn.dataset.queryTabDirty = "true";
      }
      if (overflowTabs.some((v) => this.plugin.settings.defaultSavedViewId === v.id)) {
        moreBtn.dataset.queryTabDefault = "true";
      }
      const label = moreBtn.createDiv({ cls: "bt-tab-label" });
      label.createSpan({ text: tr("savedViews.tabMore"), cls: "bt-tab-name" });
      if (overflowTabs.some((v) => this.isSavedViewDirty(v))) {
        label.createSpan({ text: "•", cls: "bt-tab-dirty-dot" });
      }
      // Show total count of overflow tabs plus their badges
      const overflowCount = overflowTabs.reduce((sum, v) => sum + this.countForSavedView(v), 0);
      if (overflowCount > 0) {
        moreBtn.createSpan({ text: String(overflowCount), cls: "bt-tab-count" });
      }
      moreBtn.title = overflowTabs.map((v) => v.name).join(", ");
      moreBtn.addEventListener("click", () => this.openOverflowTabsSheet(overflowTabs));
      moreBtn.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.openOverflowTabsSheet(overflowTabs);
      });
    }
  }

  private renderTabButton(bar: HTMLElement, view: QueryPreset, index: number, mobileLayout: boolean): void {
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
    if (!mobileLayout) btn.draggable = true;
    const label = btn.createDiv({ cls: "bt-tab-label" });
    label.createSpan({ text: view.name, cls: "bt-tab-name" });
    if (dirty) {
      label.createSpan({ text: "•", cls: "bt-tab-dirty-dot" });
    }
    const count = this.countForSavedView(view);
    if (count > 0) {
      btn.createSpan({ text: String(count), cls: "bt-tab-count" });
    }
    if (!mobileLayout && index < 9) {
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

    // UX-mobile §3.2: long-press on a tab opens the tab management sheet
    // on mobile (desktop uses right-click / contextmenu instead).
    if (isMobileMode()) {
      attachLongPress(btn, {
        durationMs: this.plugin.settings.mobileLongPressMs,
        moveThresholdPx: 4,
        onTrigger: () => this.openTabManagementSheet(view),
      });
    }

    if (mobileLayout) return;

    // ── Tab drag-to-reorder ──
    btn.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/tab-id", view.id);
      btn.addClass("bt-tab-dragging");
      // Let the bar know a tab drag is in progress
      bar.addClass("bt-tabbar-dragging");
    });
    btn.addEventListener("dragend", () => {
      btn.removeClass("bt-tab-dragging");
      bar.removeClass("bt-tabbar-dragging");
      // Clear all insertion indicators
      bar.findAll(".bt-tab").forEach((el) => {
        el.removeClass("bt-tab-drop-before", "bt-tab-drop-after");
      });
    });
    btn.addEventListener("dragover", (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;

      // Cross-tab drag dwell for task cards
      if (dt.types.includes("text/task-id")) {
        e.preventDefault();
        dt.dropEffect = "move";
        btn.addClass("drag-hover");
        this.dwellTracker.update(view.id, btn, this.state.savedViewId ?? "");
        return;
      }

      // Tab reorder
      if (dt.types.includes("text/tab-id")) {
        const draggedId = dt.getData("text/tab-id");
        if (draggedId === view.id) return; // can't drop on itself
        e.preventDefault();
        dt.dropEffect = "move";
        // Show insertion indicator based on cursor position
        const rect = btn.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        const isAfter = e.clientX > mid;
        // Clear all indicators first
        bar.findAll(".bt-tab").forEach((el) => {
          el.removeClass("bt-tab-drop-before", "bt-tab-drop-after");
        });
        btn.addClass(isAfter ? "bt-tab-drop-after" : "bt-tab-drop-before");
      }
    });
    btn.addEventListener("dragleave", (e) => {
      const dt = e.dataTransfer;
      if (dt?.types.includes("text/task-id")) {
        btn.removeClass("drag-hover");
        this.dwellTracker.reset();
      }
      if (dt?.types.includes("text/tab-id")) {
        btn.removeClass("bt-tab-drop-before", "bt-tab-drop-after");
      }
    });
    btn.addEventListener("drop", (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      if (dt.types.includes("text/tab-id")) {
        e.preventDefault();
        e.stopPropagation();
        const draggedId = dt.getData("text/tab-id");
        if (draggedId === view.id) return;
        const rect = btn.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        const isAfter = e.clientX > mid;
        const presets = this.plugin.settings.queryPresets;
        const targetIndex = presets.findIndex((p) => p.id === view.id);
        if (targetIndex === -1) return;
        // If dropping after, insert at targetIndex + 1; if before, at targetIndex
        const insertAt = isAfter ? targetIndex + 1 : targetIndex;
        void this.reorderQueryTab(draggedId, insertAt);
      }
    });
  }

  /**
   * VAL-GUI-005: overflow tabs are first-class Query Tabs rendered in a sheet.
   * Each entry carries data-tab-id, badge/dirty/default metadata, and full
   * UX-mobile §3.2: long-press a tab → bottom sheet with full management
   * actions: rename, copy, edit Query, set default, move L/R, hide, delete.
   * Mirrors the desktop right-click `openSavedViewMenu` but rendered as
   * large tap targets in a mobile-friendly sheet.
   */
  private openTabManagementSheet(view: QueryPreset): void {
    const sheet = new BottomSheet(this.app, {
      title: view.name,
      populate: (el) => {
        const actions = el.createDiv({ cls: "bt-sheet-actions" });

        const addBtn = (text: string, fn: () => void | Promise<void>) => {
          const b = actions.createEl("button", {
            cls: "bt-sheet-action",
            text,
          });
          b.addEventListener("click", () => {
            sheet.close();
            Promise.resolve(fn()).catch((err) =>
              new Notice(tr("notice.error", {
                msg: (err as Error).message,
              }), 4000),
            );
          });
        };

        const presets = this.plugin.settings.queryPresets;
        const idx = presets.findIndex((p) => p.id === view.id);

        addBtn(tr("savedViews.rename"), () => this.renameSavedView(view));
        addBtn(tr("savedViews.copy"), () => this.copySavedView(view));
        addBtn(tr("savedViews.editQuery"), () => this.openQueryControlsSheet());
        addBtn(tr("savedViews.setDefault"), () => this.setDefaultSavedView(view.id));

        if (idx > 0) {
          addBtn(tr("savedViews.moveLeft"), () => this.moveSavedView(view, -1));
        } else {
          actions.createEl("button", {
            cls: "bt-sheet-action bt-sheet-action-disabled",
            text: tr("savedViews.moveLeft"),
          });
        }

        if (idx >= 0 && idx < presets.length - 1) {
          addBtn(tr("savedViews.moveRight"), () => this.moveSavedView(view, 1));
        } else {
          actions.createEl("button", {
            cls: "bt-sheet-action bt-sheet-action-disabled",
            text: tr("savedViews.moveRight"),
          });
        }

        addBtn(
          view.hidden ? tr("savedViews.show") : tr("savedViews.hide"),
          () => this.toggleSavedViewHidden(view, !view.hidden),
        );

        if (!view.builtin) {
          addBtn(tr("savedViews.delete"), () => this.deleteSavedViewWithConfirm(view));
        }
      },
    });
    sheet.open();
  }

  /**
   * VAL-GUI-005: overflow tabs are first-class Query Tabs rendered in a sheet.
   * UX-mobile §3.1: "更多" opens a bottom sheet (not a menu) listing
   * overflow Query Tabs with order, badge, default status, and full
   * management actions (rename, copy, set default, move, hide, delete).
   */
  private openOverflowTabsSheet(overflowTabs: QueryPreset[]): void {
    const sheet = new BottomSheet(this.app, {
      title: tr("savedViews.tabMore"),
      populate: (el) => {
        const body = el.createDiv({ cls: "bt-overflow-tabs-sheet" });
        this.renderOverflowTabEntries(body, overflowTabs, () => sheet.close());
      },
    });
    sheet.open();
  }

  private renderOverflowTabEntries(
    parent: HTMLElement,
    overflowTabs: QueryPreset[],
    closeSheet: () => void,
  ): void {
    const container = parent;
    for (const view of overflowTabs) {
      const row = parent.createDiv({ cls: "bt-overflow-tab-row" });
      row.draggable = true;
      // First-class data attributes: same as visible tab buttons
      row.dataset.tabId = view.id;
      row.dataset.queryTabId = view.id;
      const dirty = this.isSavedViewDirty(view);
      if (dirty) row.dataset.queryTabDirty = "true";
      if (this.plugin.settings.defaultSavedViewId === view.id) row.dataset.queryTabDefault = "true";
      if (view.id === this.state.savedViewId) row.addClass("bt-overflow-tab-row-active");

      // ── Drag-to-reorder for overflow tab rows ──
      row.addEventListener("dragstart", (e) => {
        if (!e.dataTransfer) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/tab-id", view.id);
        row.addClass("bt-overflow-tab-row-dragging");
      });
      row.addEventListener("dragend", () => {
        row.removeClass("bt-overflow-tab-row-dragging");
        container.findAll(".bt-overflow-tab-row").forEach((el) => {
          el.removeClass("bt-overflow-tab-row-drop-before", "bt-overflow-tab-row-drop-after");
        });
      });
      row.addEventListener("dragover", (e) => {
        const dt = e.dataTransfer;
        if (!dt?.types.includes("text/tab-id")) return;
        const draggedId = dt.getData("text/tab-id");
        if (draggedId === view.id) return;
        e.preventDefault();
        dt.dropEffect = "move";
        const rect = row.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        const isAfter = e.clientY > mid;
        container.findAll(".bt-overflow-tab-row").forEach((el) => {
          el.removeClass("bt-overflow-tab-row-drop-before", "bt-overflow-tab-row-drop-after");
        });
        row.addClass(isAfter ? "bt-overflow-tab-row-drop-after" : "bt-overflow-tab-row-drop-before");
      });
      row.addEventListener("dragleave", (e) => {
        const dt = e.dataTransfer;
        if (dt?.types.includes("text/tab-id")) {
          row.removeClass("bt-overflow-tab-row-drop-before", "bt-overflow-tab-row-drop-after");
        }
      });
      row.addEventListener("drop", (e) => {
        const dt = e.dataTransfer;
        if (!dt?.types.includes("text/tab-id")) return;
        e.preventDefault();
        e.stopPropagation();
        const draggedId = dt.getData("text/tab-id");
        if (draggedId === view.id) return;
        const rect = row.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        const isAfter = e.clientY > mid;
        const presets = this.plugin.settings.queryPresets;
        const targetIndex = presets.findIndex((p) => p.id === view.id);
        if (targetIndex === -1) return;
        const insertAt = isAfter ? targetIndex + 1 : targetIndex;
        void this.reorderQueryTab(draggedId, insertAt).then(() => closeSheet());
      });

      // Main row: name, dirty dot, count
      const main = row.createDiv({ cls: "bt-overflow-tab-main" });
      const titleWrap = main.createDiv({ cls: "bt-overflow-tab-title" });
      titleWrap.createSpan({ text: view.name, cls: "bt-overflow-tab-name" });
      if (dirty) {
        titleWrap.createSpan({ text: "•", cls: "bt-tab-dirty-dot" });
      }
      const count = this.countForSavedView(view);
      if (count > 0) {
        main.createSpan({ text: String(count), cls: "bt-overflow-tab-count" });
      }

      // Badges: 当前 / 默认 / 已修改 / 已隐藏 / 预设
      const badges = this.savedViewBadges(view);
      if (badges.length > 0) {
        const badgeRow = main.createDiv({ cls: "bt-overflow-tab-badges" });
        for (const badge of badges) {
          badgeRow.createSpan({ cls: "bt-overflow-tab-badge", text: badge });
        }
      }

      // Click to activate: close sheet and switch to this tab
      row.addEventListener("click", () => {
        closeSheet();
        this.activateSavedView(view);
      });

      // Context menu with full management actions
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openSavedViewMenu(event, view);
      });

      // Quick action buttons for management
      const actions = row.createDiv({ cls: "bt-overflow-tab-actions" });
      const makeAction = (label: string, handler: () => void | Promise<void>) => {
        const btn = actions.createEl("button", { text: label, cls: "bt-overflow-tab-btn" });
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          Promise.resolve(handler()).then(() => {
            closeSheet();
          }).catch((error) =>
            new Notice(tr("notice.error", { msg: error instanceof Error ? error.message : String(error) }), 4000),
          );
        });
      };

      makeAction(tr("savedViews.rename"), () => this.renameSavedView(view));
      makeAction(tr("savedViews.copy"), () => this.copySavedView(view));
      makeAction(tr("savedViews.setDefault"), () => this.setDefaultSavedView(view.id));
      makeAction(view.hidden ? tr("savedViews.show") : tr("savedViews.hide"), () =>
        this.toggleSavedViewHidden(view, !view.hidden),
      );
      if (!view.builtin) {
        makeAction(tr("savedViews.delete"), () => this.deleteSavedViewWithConfirm(view));
      }
    }
  }

  // UX.md §3.0: the time-range selector belongs to the time-axis views
  // (week / month), not the global toolbar. On desktop it is rendered by the
  // week / month component itself (see renderWeek / renderMonth) so the
  // toolbar can collapse to a single row (search + filter chips). On mobile
  // the two-row rule (§6.2) keeps the date nav in the toolbar's first row.
  // `data-action="nav-*"` is the stable e2e selector regardless of where the
  // nav lives in the DOM.
  private renderRangeNav(parent: HTMLElement) {
    if (this.state.tab !== "week" && this.state.tab !== "month") return;
    const nav = parent.createDiv({ cls: "bt-nav" });
    const prev = nav.createEl("button", { text: "◀" });
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

  private renderToolbar(parent: HTMLElement) {
    const bar = parent.createDiv({ cls: "bt-toolbar" });
    const mainRow = bar.createDiv({ cls: "bt-toolbar-row bt-toolbar-main" });
    const mobileLayout = this.contentEl.dataset.mobileLayout === "true";
    // §3.0: with the date nav lowered into the week / month component, the
    // desktop toolbar collapses to a single row — search + filter chips live
    // together in mainRow instead of a separate sub-row.
    const subRow = mainRow;

    // Mobile keeps the date nav in the toolbar (§6.2 two-row rule). On desktop
    // it is owned by the week / month component itself (§3.0).
    if (mobileLayout) {
      this.renderRangeNav(mainRow);
    }

    if (!mobileLayout) {
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
    }

    if (mobileLayout) {
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
    // View type — 主内容 area 类型
    const active = this.activeSavedView();
    const primary = active.view ? this.primaryAreaType(active.view) : "list";
    if (primary !== "list") {
      parts.push(primary);
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
        cls: "bt-saved-view-save bt-saved-view-save--primary",
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
        cls: "bt-saved-view-save bt-saved-view-save--primary",
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
    return this.tabForSavedView(normalized, "list");
  }

  private activateSavedViewById(id: string): void {
    const view = this.plugin.settings.queryPresets.find((item) => item.id === id);
    if (!view) return;
    this.activateSavedView(view);
  }

  private activateSavedView(view: QueryPreset): void {
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

  private countForSavedView(view: QueryPreset): number {
    const normalized = normalizeQueryPreset(view);
    const tab = this.tabForSavedView(normalized, "list");
    const filter = this.getSavedViewFilter(normalized);
    const effectiveTasks = this.getEffectiveTasks();
    const today = todayISO();
    if (tab === "today") {
      const activeTodos = recomputeTopLevelInQuery(
        effectiveTasks.filter(filter).filter((task) => task.effectiveStatus === "todo"),
      );
      const topLevelTodos = activeTodos.filter((task) => task.isTopLevelInQuery);
      const overdueCount = topLevelTodos.filter((task) => task.effectiveDeadline && task.effectiveDeadline < today).length;
      const todayScheduled = topLevelTodos.filter((task) => task.effectiveScheduled === today).length;
      return overdueCount + todayScheduled;
    }
    if (tab === "week") {
      const weekStart = startOfWeek(today, this.plugin.settings.weekStartsOn);
      const weekEnd = addDays(weekStart, 6);
      const weekTasks = effectiveTasks.filter(filter).filter((task) => {
        const date = task.effectiveScheduled;
        return !!date && date >= weekStart && date <= weekEnd;
      });
      return countTopLevel(recomputeTopLevelInQuery(weekTasks));
    }
    if (tab === "month") {
      const monthStart = startOfMonth(today);
      const monthEnd = endOfMonth(today);
      const monthTasks = effectiveTasks.filter(filter).filter((task) => {
        const date = task.effectiveScheduled;
        return !!date && date >= monthStart && date <= monthEnd;
      });
      return countTopLevel(recomputeTopLevelInQuery(monthTasks));
    }
    if (tab === "completed") {
      const completedTasks = effectiveTasks.filter(filter).filter((task) => task.effectiveStatus === "done");
      return countTopLevel(recomputeTopLevelInQuery(completedTasks));
    }
    if (tab === "unscheduled") {
      const unscheduledTasks = effectiveTasks.filter(filter).filter(
        (task) => task.effectiveStatus === "todo" && !task.effectiveScheduled,
      );
      return countTopLevel(recomputeTopLevelInQuery(unscheduledTasks));
    }
    return countTopLevel(recomputeTopLevelInQuery(effectiveTasks.filter(filter)));
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
      row.draggable = true;
      const main = row.createDiv({ cls: "bt-manage-tab-main" });
      const title = main.createDiv({ cls: "bt-manage-tab-title", text: view.name });
      title.dataset.queryTabId = view.id;

      // ── Drag-to-reorder for manage tab rows ──
      row.addEventListener("dragstart", (e) => {
        if (!e.dataTransfer) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/tab-id", view.id);
        row.addClass("bt-manage-tab-row-dragging");
      });
      row.addEventListener("dragend", () => {
        row.removeClass("bt-manage-tab-row-dragging");
        rows.findAll(".bt-manage-tab-row").forEach((el) => {
          el.removeClass("bt-manage-tab-row-drop-before", "bt-manage-tab-row-drop-after");
        });
      });
      row.addEventListener("dragover", (e) => {
        const dt = e.dataTransfer;
        if (!dt?.types.includes("text/tab-id")) return;
        const draggedId = dt.getData("text/tab-id");
        if (draggedId === view.id) return;
        e.preventDefault();
        dt.dropEffect = "move";
        const rect = row.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        const isAfter = e.clientY > mid;
        rows.findAll(".bt-manage-tab-row").forEach((el) => {
          el.removeClass("bt-manage-tab-row-drop-before", "bt-manage-tab-row-drop-after");
        });
        row.addClass(isAfter ? "bt-manage-tab-row-drop-after" : "bt-manage-tab-row-drop-before");
      });
      row.addEventListener("dragleave", (e) => {
        const dt = e.dataTransfer;
        if (dt?.types.includes("text/tab-id")) {
          row.removeClass("bt-manage-tab-row-drop-before", "bt-manage-tab-row-drop-after");
        }
      });
      row.addEventListener("drop", (e) => {
        const dt = e.dataTransfer;
        if (!dt?.types.includes("text/tab-id")) return;
        e.preventDefault();
        e.stopPropagation();
        const draggedId = dt.getData("text/tab-id");
        if (draggedId === view.id) return;
        const rect = row.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        const isAfter = e.clientY > mid;
        const presets = this.plugin.settings.queryPresets;
        const targetIndex = presets.findIndex((p) => p.id === view.id);
        if (targetIndex === -1) return;
        const insertAt = isAfter ? targetIndex + 1 : targetIndex;
        void this.reorderQueryTab(draggedId, insertAt).then(rerender);
      });

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
      action(view.hidden ? tr("savedViews.show") : tr("savedViews.hide"), () => this.toggleSavedViewHidden(view, !view.hidden));
      if (view.builtin) action(tr("savedViews.restore"), () => this.restoreBuiltinSavedView(view));
      if (!view.builtin) {
        action(tr("savedViews.delete"), () => this.deleteSavedViewWithConfirm(view));
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

  private async reorderQueryTab(id: string, targetIndex: number): Promise<void> {
    this.plugin.settings.queryPresets = reorderQueryPresetById(this.plugin.settings.queryPresets, id, targetIndex);
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
   *
   * Delegates to the pure `executeDeleteQueryPresetFlow` helper so the
   * confirm / delete / undo logic is unit-testable without DOM.
   */
  async deleteSavedViewWithConfirm(view: QueryPreset): Promise<void> {
    const visible = this.visibleQueryTabs();
    if (visible.length <= 1 && visible[0]?.id === view.id) {
      new Notice(tr("notice.error", { msg: "至少保留一个可见 Tab。" }), 4000);
      return;
    }

    const flowCallbacks: QueryPresetDeleteFlowCallbacks = {
      confirm: async (viewName: string) => {
        const confirmed = await new Promise<boolean>((resolve) => {
          const modal = new BottomSheet(this.app, {
            title: tr("savedViews.deleteConfirmTitle"),
            populate: (el) => {
              el.createDiv({ cls: "bt-delete-confirm-body", text: tr("savedViews.deleteConfirmBody") });
              el.createDiv({ cls: "bt-delete-confirm-detail", text: `"${viewName}"` });
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
        return confirmed;
      },
      createUndoNotice: (viewName: string, undoLabel: string) => {
        const notice = new Notice("", 8000);
        notice.messageEl.empty();
        notice.messageEl.createSpan({ text: tr("notice.deleted", { name: viewName }) });

        const undoBtn = notice.messageEl.createSpan({
          text: `  ${undoLabel}`,
          cls: "bt-notice-undo",
        });

        let undone = false;
        return {
          onUndoClick: (handler: () => Promise<void>) => {
            undoBtn.addEventListener("click", () => {
              if (undone) return;
              undone = true;
              void handler();
            });
          },
          close: () => notice.hide(),
        };
      },
      showRestoredNotice: (viewName: string) => {
        new Notice(tr("notice.undoRestored", { name: viewName }), 3000);
      },
    };

    const result = await executeDeleteQueryPresetFlow(
      this.plugin.settings.queryPresets,
      view,
      this.plugin.settings.defaultSavedViewId,
      this.state.savedViewId,
      flowCallbacks,
    );

    if (!result.confirmed) return;

    // Compute post-delete state from pure functions
    const deleteState = computeDeleteQueryPresetState({
      result,
      visibleTabs: visible,
      view,
    });

    // Apply the deletion to plugin state
    this.plugin.settings.queryPresets = deleteState.presetsAfter;
    this.tabDrafts.delete(view.id);

    if (deleteState.newDefaultId !== null) {
      this.plugin.settings.defaultSavedViewId = deleteState.newDefaultId;
    }
    if (deleteState.shouldSwitchActive && deleteState.nextActiveView) {
      this.applySavedView(deleteState.nextActiveView);
    }

    await this.plugin.saveSettings();
    this.render();

    // Wire the undo handler to restore state
    result.undoNotice?.onUndoClick(async () => {
      result.undoNotice?.close();

      // Compute post-undo state from pure functions
      const undoState = computeUndoQueryPresetState({
        presets: this.plugin.settings.queryPresets,
        undoPlan: result.undoPlan!,
        wasDefault: result.wasDefault,
        wasActive: result.wasActive,
      });

      this.plugin.settings.queryPresets = undoState.presetsRestored;
      this.tabDrafts.delete(result.undoPlan!.snapshot.id);

      if (undoState.restoredDefaultId !== null) {
        this.plugin.settings.defaultSavedViewId = undoState.restoredDefaultId;
      }
      if (undoState.shouldRestoreActive && undoState.restoredView) {
        this.applySavedView(undoState.restoredView);
      }

      await this.plugin.saveSettings();
      this.render();
      new Notice(tr("notice.undoRestored", { name: result.undoPlan!.snapshot.name }), 3000);
    });
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
    const tagOptions = this.collectTagOptions();
    if (tagOptions.length === 0) {
      list.createDiv({ cls: "bt-tag-empty", text: tr("savedViews.tagEmpty") });
      return;
    }
    const rows: HTMLElement[] = [];
    for (const option of tagOptions) {
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
      view: { layout: { type: "list" } },
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
    const mobileLayout = this.contentEl.dataset.mobileLayout === "true";
    const bodyClass = mobileLayout ? "bt-mobile-query-sheet" : "bt-query-controls-sheet";
    const rerenderControls = () => {
      this.render();
      if (!body) return;
      body.empty();
      this.renderQueryControlsSheet(body, rerenderControls);
    };
    const sheet = new BottomSheet(this.app, {
      title: tr("savedViews.queryEditorTitle"),
      sheetClass: mobileLayout ? "task-center-query-sheet" : undefined,
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

    const intro = parent.createDiv({ cls: "bt-query-editor-intro" });
    intro.createDiv({ cls: "bt-query-editor-current", text: this.activeSavedView().name });
    this.renderFilterSummary(intro);

    // ── Filters ──────────────────────────────────────────
    const filtersSection = parent.createDiv({ cls: "bt-query-editor-section" });
    filtersSection.createDiv({ cls: "bt-query-editor-section-title", text: tr("savedViews.queryEditorFilters") });
    const filters = filtersSection.createDiv({ cls: "bt-saved-view-filters" });
    this.renderSavedViewsFilterControls(filters, rerenderControls);

    // ── View ─────────────────────────────────────────────
    const viewSection = parent.createDiv({ cls: "bt-query-editor-section" });
    viewSection.createDiv({ cls: "bt-query-editor-section-title", text: tr("savedViews.queryEditorView") });
    const viewCfg = this.currentQueryPresetViewConfig();
    const currentType = this.primaryAreaType(viewCfg);
    const viewRow = viewSection.createDiv({ cls: "bt-query-editor-view-row" });
    viewRow.createSpan({ text: tr("savedViews.queryEditorViewType") + ":", cls: "bt-query-editor-view-label" });
    const viewTypes: Array<{ value: AreaType; label: string }> = [
      { value: "list", label: tr("savedViews.viewList") },
      { value: "week", label: tr("savedViews.viewWeek") },
      { value: "month", label: tr("savedViews.viewMonth") },
      { value: "matrix", label: tr("savedViews.viewMatrix") },
    ];
    for (const vt of viewTypes) {
      const btn = viewRow.createEl("button", {
        text: vt.label,
        cls: "bt-query-editor-view-btn" + (currentType === vt.value ? " active" : ""),
      });
      btn.addEventListener("click", () => {
        const current = this.currentQueryPresetViewConfig();
        const next: QueryPresetViewConfig = { layout: this.buildLayoutForAreaType(vt.value, current) };
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

    const summaryList = summarySection.createDiv({ cls: "bt-query-editor-summary-list" });

    // Build the shared handler params once (they are stable per render).
    const buildSummaryDraftParams = (): QueryEditorSummaryDraftParams => {
      const active = this.activeSavedView();
      return {
        tabDrafts: this.tabDrafts,
        activePresetId: active.id,
        savedPreset: this.selectedSavedView(),
        getSnapshot: (existing) => this.currentQuerySnapshot(existing),
      };
    };

    // Helper: update a metric at index i within the draft and re-render.
    // Delegates to the testable production-path helper.
    const updateMetricInDraft = (i: number, patch: Partial<QueryPresetSummaryMetric>) => {
      const params = buildSummaryDraftParams();
      const draft = handleQueryEditorSummaryEdit(params, i, patch);
      this.applySavedView(draft);
      renderSummaryMetrics();
    };

    const renderSummaryMetrics = () => {
      summaryList.empty();
      const metrics = this.currentSavedViewSummary();
      for (let i = 0; i < metrics.length; i++) {
        const metric = metrics[i];
        const row = summaryList.createDiv({ cls: "bt-query-editor-summary-row" });
        row.dataset.summaryMetric = metric.type;

        // Metric type label (read-only — type is set on creation)
        const typeLabel = row.createSpan({ cls: "bt-query-editor-summary-type" });
        switch (metric.type) {
          case "count":
            typeLabel.setText(tr("savedViews.summaryMetricCount"));
            break;
          case "sum":
            typeLabel.setText(tr("savedViews.summaryMetricSum"));
            break;
          case "ratio":
            typeLabel.setText(tr("savedViews.summaryMetricRatio"));
            break;
          case "top_n":
            typeLabel.setText(tr("savedViews.summaryMetricTopN"));
            break;
          case "group_by":
            typeLabel.setText(tr("savedViews.summaryMetricGroupBy"));
            break;
        }

        // Editable fields per metric type
        if (metric.type === "sum") {
          const fieldInput = row.createEl("input", {
            type: "text",
            placeholder: "planned",
            cls: "bt-query-editor-summary-field-input",
          });
          fieldInput.value = metric.field ?? "";
          fieldInput.addEventListener("input", () => {
            updateMetricInDraft(i, { field: fieldInput.value.trim() || undefined });
          });
        }
        if (metric.type === "ratio") {
          const numInput = row.createEl("input", {
            type: "text",
            placeholder: "actual",
            cls: "bt-query-editor-summary-field-input",
          });
          numInput.value = metric.numerator ?? "";
          numInput.addEventListener("input", () => {
            updateMetricInDraft(i, { numerator: numInput.value.trim() || undefined });
          });
          const denInput = row.createEl("input", {
            type: "text",
            placeholder: "estimate",
            cls: "bt-query-editor-summary-field-input",
          });
          denInput.value = metric.denominator ?? "";
          denInput.addEventListener("input", () => {
            updateMetricInDraft(i, { denominator: denInput.value.trim() || undefined });
          });
        }
        if (metric.type === "top_n") {
          const byInput = row.createEl("input", {
            type: "text",
            placeholder: "tags",
            cls: "bt-query-editor-summary-field-input",
          });
          byInput.value = metric.by ?? "";
          byInput.addEventListener("input", () => {
            updateMetricInDraft(i, { by: byInput.value.trim() || undefined });
          });
          const limitInput = row.createEl("input", {
            type: "number",
            placeholder: "5",
            cls: "bt-query-editor-summary-field-input",
          });
          limitInput.value = metric.limit != null ? String(metric.limit) : "";
          limitInput.addEventListener("input", () => {
            const v = Number(limitInput.value);
            updateMetricInDraft(i, { limit: Number.isFinite(v) ? v : undefined });
          });
        }
        if (metric.type === "group_by") {
          const byInput = row.createEl("input", {
            type: "text",
            placeholder: "tags",
            cls: "bt-query-editor-summary-field-input",
          });
          byInput.value = metric.by ?? "";
          byInput.addEventListener("input", () => {
            updateMetricInDraft(i, { by: byInput.value.trim() || undefined });
          });
        }

        // Remove button
        const removeBtn = row.createEl("button", {
          text: tr("savedViews.summaryRemove"),
          cls: "bt-query-editor-summary-remove",
        });
        removeBtn.addEventListener("click", () => {
          const params = buildSummaryDraftParams();
          const draft = handleQueryEditorSummaryRemove(params, i);
          this.applySavedView(draft);
          renderSummaryMetrics();
        });
      }
    };
    renderSummaryMetrics();

    // Add metric controls
    const addRow = summarySection.createDiv({ cls: "bt-query-editor-summary-add-row" });
    const metricTypes: Array<{ value: QueryPresetSummaryMetric["type"]; label: string }> = [
      { value: "count", label: tr("savedViews.summaryMetricCount") },
      { value: "sum", label: tr("savedViews.summaryMetricSum") },
      { value: "ratio", label: tr("savedViews.summaryMetricRatio") },
      { value: "top_n", label: tr("savedViews.summaryMetricTopN") },
      { value: "group_by", label: tr("savedViews.summaryMetricGroupBy") },
    ];
    const typeSelect = addRow.createEl("select", { cls: "bt-query-editor-summary-type-select" });
    for (const mt of metricTypes) {
      const option = typeSelect.createEl("option", { text: mt.label });
      option.value = mt.value;
    }

    // Dynamic fields based on selected type
    const fieldsRow = addRow.createDiv({ cls: "bt-query-editor-summary-fields" });
    const updateMetricFields = () => {
      fieldsRow.empty();
      const selType = typeSelect.value as QueryPresetSummaryMetric["type"];
      if (selType === "sum" || selType === "top_n") {
        fieldsRow.createSpan({ text: tr("savedViews.summaryField") + ":", cls: "bt-query-editor-summary-field-label" });
        const fieldInput = fieldsRow.createEl("input", { type: "text", placeholder: "planned", cls: "bt-query-editor-summary-field-input" });
        fieldInput.dataset.summaryField = "field";
        if (selType === "top_n") {
          fieldsRow.createSpan({ text: tr("savedViews.summaryLimit") + ":", cls: "bt-query-editor-summary-field-label" });
          const limitInput = fieldsRow.createEl("input", { type: "number", placeholder: "5", cls: "bt-query-editor-summary-field-input" });
          limitInput.dataset.summaryField = "limit";
        }
      }
      if (selType === "ratio") {
        fieldsRow.createSpan({ text: tr("savedViews.summaryNumerator") + ":", cls: "bt-query-editor-summary-field-label" });
        const numInput = fieldsRow.createEl("input", { type: "text", placeholder: "actual", cls: "bt-query-editor-summary-field-input" });
        numInput.dataset.summaryField = "numerator";
        fieldsRow.createSpan({ text: tr("savedViews.summaryDenominator") + ":", cls: "bt-query-editor-summary-field-label" });
        const denInput = fieldsRow.createEl("input", { type: "text", placeholder: "estimate", cls: "bt-query-editor-summary-field-input" });
        denInput.dataset.summaryField = "denominator";
      }
      if (selType === "group_by") {
        fieldsRow.createSpan({ text: tr("savedViews.summaryBy") + ":", cls: "bt-query-editor-summary-field-label" });
        const byInput = fieldsRow.createEl("input", { type: "text", placeholder: "tags", cls: "bt-query-editor-summary-field-input" });
        byInput.dataset.summaryField = "by";
      }
    };
    typeSelect.addEventListener("change", updateMetricFields);
    updateMetricFields();

    const addBtn = addRow.createEl("button", {
      text: tr("savedViews.summaryAdd"),
      cls: "bt-query-editor-summary-add-btn",
    });
    addBtn.addEventListener("click", () => {
      const selType = typeSelect.value as QueryPresetSummaryMetric["type"];
      const newMetric: QueryPresetSummaryMetric = { type: selType };
      // Read field values
      const fieldEl = fieldsRow.querySelector<HTMLInputElement>('[data-summary-field="field"]');
      const limitEl = fieldsRow.querySelector<HTMLInputElement>('[data-summary-field="limit"]');
      const numEl = fieldsRow.querySelector<HTMLInputElement>('[data-summary-field="numerator"]');
      const denEl = fieldsRow.querySelector<HTMLInputElement>('[data-summary-field="denominator"]');
      const byEl = fieldsRow.querySelector<HTMLInputElement>('[data-summary-field="by"]');

      if (selType === "sum") {
        if (fieldEl?.value.trim()) newMetric.field = fieldEl.value.trim();
      }
      if (selType === "ratio") {
        if (numEl?.value.trim()) newMetric.numerator = numEl.value.trim();
        if (denEl?.value.trim()) newMetric.denominator = denEl.value.trim();
      }
      if (selType === "top_n") {
        if (fieldEl?.value.trim()) newMetric.by = fieldEl.value.trim();
        if (limitEl?.value && Number.isFinite(Number(limitEl.value))) {
          newMetric.limit = Number(limitEl.value);
        }
      }
      if (selType === "group_by") {
        if (byEl?.value.trim()) newMetric.by = byEl.value.trim();
      }

      const params = buildSummaryDraftParams();
      const draft = handleQueryEditorSummaryAdd(params, newMetric);
      this.applySavedView(draft);
      renderSummaryMetrics();
      // Clear inputs
      fieldsRow.querySelectorAll("input").forEach((el) => {
        el.value = "";
      });
    });

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
  private renderWeek(parent: HTMLElement) {
    // §3.0: desktop week component owns its own range nav (mobile keeps it in
    // the toolbar's first row per §6.2, so it is rendered there instead).
    if (this.contentEl.dataset.mobileLayout !== "true") {
      this.renderRangeNav(parent.createDiv({ cls: "bt-area-nav" }));
    }
    const today = todayISO();
    const weekStart = startOfWeek(this.state.anchorISO, this.plugin.settings.weekStartsOn);
    const days: string[] = [];
    for (let i = 0; i < 7; i++) days.push(addDays(weekStart, i));

    const filter = this.getTextFilter();
    const effectiveTasks = this.getEffectiveTasks();

    if (this.hasActiveFilters()) {
      const unfilteredCount = days.reduce(
        (sum, day) => sum + effectiveTasks.filter(
          (t) => t.effectiveScheduled === day && t.isTopLevelInQuery,
        ).length,
        0,
      );
      const filteredCount = days.reduce(
        (sum, day) => sum + effectiveTasks.filter(
          (t) => t.effectiveScheduled === day && t.isTopLevelInQuery,
        ).filter(filter).length,
        0,
      );
      if (unfilteredCount > 0 && filteredCount === 0) this.renderFilterEmptyState(parent);
    }

    const wrapper = parent.createDiv({ cls: "bt-week" });
    wrapper.dataset.view = "week";

    for (const day of days) {
      const dayTasks = effectiveTasks
        .filter((t) => t.effectiveScheduled === day)
        .filter(filter);
      // Recompute top-level after query filtering: children whose parent
      // was filtered out must appear as top-level cards rather than
      // being hidden behind a parent that isn't in the result.
      const dayTasksRecomputed = recomputeTopLevelInQuery(dayTasks);
      dayTasksRecomputed.sort((a, b) => {
        if (a.effectiveDeadline && b.effectiveDeadline) return a.effectiveDeadline.localeCompare(b.effectiveDeadline);
        if (a.effectiveDeadline) return -1;
        if (b.effectiveDeadline) return 1;
        return 0;
      });
      const topLevel = dayTasksRecomputed.filter((t) => t.isTopLevelInQuery);
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
      const stats = head.createSpan({
        text: this.columnStats(dayTasksRecomputed),
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
    // §3.0: desktop month component owns its own range nav (mobile keeps it in
    // the toolbar's first row per §6.2, so it is rendered there instead).
    if (this.contentEl.dataset.mobileLayout !== "true") {
      this.renderRangeNav(parent.createDiv({ cls: "bt-area-nav" }));
    }
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

    const effectiveTasks = this.getEffectiveTasks();
    const filter = this.getTextFilter();
    if (this.hasActiveFilters()) {
      const unfilteredCount = gridDays.reduce(
        (sum, day) => sum + effectiveTasks.filter(
          (t) => t.effectiveScheduled === day && t.isTopLevelInQuery,
        ).length,
        0,
      );
      const filteredCount = gridDays.reduce(
        (sum, day) => sum + effectiveTasks.filter(
          (t) => t.effectiveScheduled === day && t.isTopLevelInQuery,
        ).filter(filter).length,
        0,
      );
      if (unfilteredCount > 0 && filteredCount === 0) this.renderFilterEmptyState(wrapper);
    }

    const grid = wrapper.createDiv({ cls: "bt-month-grid" });
    const isMobileLayout = this.contentEl.dataset.mobileLayout === "true";
    let selectedDay = this.state.selectedMonthDay;
    if (!selectedDay || (selectedDay < first || selectedDay > last)) {
      selectedDay = today >= first && today <= last ? today : first;
    }
    let selectedDayTasks: EffectiveTask[] = [];
    for (const day of gridDays) {
      const dObj = fromISO(day);
      const isCurMonth = day >= first && day <= last;
      const cell = grid.createDiv({
        cls:
          "bt-month-cell" +
          (day === today ? " today" : "") +
          (isCurMonth ? "" : " other-month") +
          (isMobileLayout && day === selectedDay ? " selected" : ""),
      });
      // e2e drop-target selector — same contract as the week view.
      cell.dataset.date = day;
      const dayTasksAll = effectiveTasks
        .filter((t) => t.effectiveScheduled === day)
        .filter(filter);
      // Recompute top-level after query filtering so children whose
      // parent was filtered out become top-level cards in the cell.
      const dayTasksRecomputed = recomputeTopLevelInQuery(dayTasksAll);
      const dayTasks = dayTasksRecomputed.filter((t) => t.isTopLevelInQuery);
      if (day === selectedDay) selectedDayTasks = dayTasks;
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
        chip.dataset.taskStatus = t.effectiveStatus;
        chip.addClass(`bt-mini-card-${t.effectiveStatus}`);
        if (this.contentEl.dataset.mobileLayout !== "true") chip.draggable = true;
        chip.setText(t.title);
        if (t.effectiveDeadline && t.effectiveStatus === "todo") {
          const deadlineDays = daysBetween(today, t.effectiveDeadline);
          if (deadlineDays < 0) chip.addClass("overdue");
          else if (deadlineDays <= 3) chip.addClass("near-deadline");
        }
        this.wireCardEvents(chip, t);
      }
      if (dayTasks.length > 6) {
        list.createDiv({ text: `+${dayTasks.length - 6} more`, cls: "bt-mini-more" });
      }
      // US-504: mobile month tab is calendar-grid + per-day dot density;
      // tapping a day selects it and refreshes the inline day panel below
      // the calendar. The desktop path leaves the click as a no-op — chips
      // inside handle their own drag / select.
      // see USER_STORIES.md
      cell.addEventListener("click", (e) => {
        if (this.contentEl.dataset.mobileLayout !== "true") return;
        // Don't fire when the click bubbled from a chip — that's a select
        // intent, not "open the day".
        if ((e.target as HTMLElement).closest(".bt-mini-card")) return;
        this.state.selectedMonthDay = day;
        this.state.selectedTaskId = null;
        this.render();
      });
    }
    if (isMobileLayout) {
      this.renderMobileMonthDayPanel(wrapper, selectedDay, selectedDayTasks);
    }
  }

  private renderMobileMonthDayPanel(parent: HTMLElement, day: string, dayTasks: EffectiveTask[]): void {
    const panel = parent.createDiv({ cls: "bt-month-day-panel" });
    panel.dataset.date = day;

    const d = fromISO(day);
    const head = panel.createDiv({ cls: "bt-month-day-panel-head" });
    head.createSpan({
      cls: "bt-month-day-panel-title",
      text: tr("month.daySchedule", {
        date: `${weekdayLabel(d.getDay())} ${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      }),
    });
    head.createSpan({
      cls: "bt-month-day-panel-count",
      text: this.columnStats(dayTasks),
    });

    const list = panel.createDiv({ cls: "bt-month-day-panel-list" });
    if (dayTasks.length === 0) {
      list.createDiv({ cls: "bt-month-day-empty", text: tr("sheet.empty") });
      return;
    }
    for (const t of dayTasks) this.renderCard(list, t, day);
  }

  /**
   * Mobile-only: long-press a card → bottom sheet with task actions.
   * Mirrors the desktop right-click menu (UX-mobile.md §5.1 / US-506)
   * into a single thumb-reachable surface. Buttons call the same `api.*`
   * methods as the desktop UI; rendered as a flat list of large tap targets.
   */
  private openCardActionSheet(t: EffectiveTask): void {
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
        // UX-mobile §8.1: action sheet includes done, schedule today/tomorrow,
        // custom date, clear schedule, nest, edit tag, drop.
        btn(
          t.effectiveStatus === "done" ? tr("sheet.markUndone") : tr("sheet.done"),
          () => (t.effectiveStatus === "done" ? this.api.undone(t.id) : this.api.done(t.id)),
        );
        btn(tr("sheet.scheduleAt", { date: today }), () => this.api.schedule(t.id, today));
        btn(tr("sheet.scheduleAt", { date: tomorrow }), () => this.api.schedule(t.id, tomorrow));
        btn(tr("sheet.scheduleCustom"), async () => {
          // UX-mobile §8.2: 改期 opens a date picker with quick presets + calendar
          const date = await this.openDatePicker();
          if (date !== null) await this.api.schedule(t.id, date);
        });
        btn(tr("sheet.scheduleClear"), () => this.api.schedule(t.id, null));
        btn(tr("sheet.nest"), async () => {
          // UX-mobile §8.3: nest opens a parent picker bottom sheet
          const parentId = await this.openParentPickerForTask(t);
          if (parentId !== null) await this.nestFromMobile(t, parentId);
        });
        btn(tr("sheet.editTag"), async () => {
          // UX-mobile §8.1: edit tag opens a tag editor
          const edit = await this.openTagEditorForTask(t);
          if (edit !== null) await this.applyTagEditResult(t, edit);
        });
        btn(tr("sheet.editSource"), () => this.openSourceEditShell(t));
        btn(tr("sheet.drop"), () => this.api.drop(t.id));
      },
    });
    sheet.open();
  }

  /**
   * Mobile default card tap: task details first, source Markdown only by
   * explicit action. This keeps the touch path small while still preserving
   * US-168's source-edit capability.
   */
  private openMobileTaskDetailSheet(t: EffectiveTask): void {
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
      const date = await this.openDatePicker(t.effectiveScheduled ?? todayISO());
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
          const edit = await this.openTagEditorForTask(t);
          if (edit !== null) await this.applyTagEditResult(t, edit);
        });
        secondaryAction("nest", tr("sheet.nest"), async () => {
          const parentId = await this.openParentPickerForTask(t);
          if (parentId !== null) await this.nestFromMobile(t, parentId);
        });
        secondaryAction("source", tr("sheet.editSource"), () => this.openSourceEditShell(t));
      },
    });
    sheet.open();
  }

  /**
   * Mobile date picker: no typed YYYY-MM-DD input. Users pick from quick
   * dates or a touch calendar; persistence still writes ISO dates.
   */
  private openDatePicker(initialISO: string = todayISO()): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      let anchor = startOfMonth(initialISO);
      let body: HTMLElement;
      let sheet: BottomSheet | null = null;
      const finish = (iso: string | null) => {
        settled = true;
        resolve(iso);
        sheet?.close();
      };
      const render = () => {
        body.empty();
        const quick = body.createDiv({ cls: "bt-mobile-date-quick" });
        const today = todayISO();
        const quickDates = [
          today,
          addDays(today, 1),
          addDays(today, 2),
          addDays(today, 3),
          addDays(today, 4),
          addDays(today, 5),
          addDays(today, 6),
        ];
        for (const iso of quickDates) {
          const d = fromISO(iso);
          const label = iso === today
            ? tr("savedViews.dateToday")
            : iso === addDays(today, 1)
              ? tr("savedViews.dateTomorrow")
              : `${weekdayLabel(d.getDay())} ${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
          const btn = quick.createEl("button", { cls: "bt-mobile-date-quick-btn", text: label });
          btn.dataset.dateChoice = iso;
          if (iso === initialISO) btn.addClass("active");
          btn.addEventListener("click", () => finish(iso));
        }

        const calendar = body.createDiv({ cls: "bt-mobile-date-calendar" });
        const nav = calendar.createDiv({ cls: "bt-mobile-date-calendar-nav" });
        const prev = nav.createEl("button", { text: "‹", cls: "bt-date-month-nav" });
        nav.createSpan({ text: this.dateCalendarMonthLabelFor(anchor), cls: "bt-date-month-label" });
        const next = nav.createEl("button", { text: "›", cls: "bt-date-month-nav" });
        prev.addEventListener("click", () => {
          anchor = startOfMonth(shiftMonth(anchor, -1));
          render();
        });
        next.addEventListener("click", () => {
          anchor = startOfMonth(shiftMonth(anchor, 1));
          render();
        });

        const weekdays = calendar.createDiv({ cls: "bt-date-calendar-weekdays" });
        const weekStart = this.plugin.settings.weekStartsOn;
        for (let i = 0; i < 7; i++) {
          const day = (weekStart + i) % 7;
          weekdays.createSpan({ text: tr(WEEKDAY_KEYS[day]), cls: "bt-date-calendar-weekday" });
        }

        const monthStart = startOfMonth(anchor);
        const gridStart = startOfWeek(monthStart, weekStart);
        const grid = calendar.createDiv({ cls: "bt-date-calendar-grid" });
        for (let i = 0; i < 42; i++) {
          const iso = addDays(gridStart, i);
          const d = fromISO(iso);
          const cell = grid.createEl("button", { text: String(d.getDate()), cls: "bt-date-calendar-day" });
          cell.dataset.dateChoice = iso;
          if (startOfMonth(iso) !== monthStart) cell.addClass("other-month");
          if (iso === today) cell.addClass("today");
          if (iso === initialISO) cell.addClass("active");
          cell.addEventListener("click", () => finish(iso));
        }
      };

      sheet = new BottomSheet(this.app, {
        title: tr("sheet.scheduleCustom"),
        onClose: () => {
          if (!settled) resolve(null);
        },
        populate: (el) => {
          body = el.createDiv({ cls: "bt-mobile-date-sheet" });
          render();
        },
      });
      sheet.open();
    });
  }

  private dateCalendarMonthLabelFor(anchorISO: string): string {
    const d = fromISO(anchorISO);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
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
  private openParentPickerForTask(t: EffectiveTask): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      let selectedId: string | null = null;
      let sheetBody: HTMLElement;
      let candidateList: HTMLElement;
      let confirmButton: HTMLButtonElement;
      let sheet: BottomSheet | null = null;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
        sheet?.close();
      };

      const descendantIds = new Set<string>([t.id]);
      const collectDescendants = (task: ParsedTask) => {
        for (const line of task.childrenLines) {
          const child = this._taskIndex.get(`${task.path}:L${line + 1}`);
          if (!child || descendantIds.has(child.id)) continue;
          descendantIds.add(child.id);
          collectDescendants(child);
        }
      };
      const rootTask = this._taskIndex.get(t.id) ?? t;
      collectDescendants(rootTask);

      const effectiveById = new Map(this.getEffectiveTasks().map((task) => [task.id, task]));
      const visibleIds = new Set(
        Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-task-id]"))
          .map((el) => el.dataset.taskId)
          .filter((id): id is string => !!id),
      );
      const eligibleTasks = this.getEffectiveTasks()
        .filter((candidate) => {
          if (candidate.effectiveStatus === "done") return false;
          if (candidate.effectiveStatus === "dropped" || candidate.effectiveStatus === "cancelled") return false;
          return true;
        })
        .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
      const eligibleIds = new Set(eligibleTasks.map((candidate) => candidate.id));

      const matchesSearch = (candidate: EffectiveTask, q: string) => {
        if (!q) return true;
        const needle = q.toLowerCase();
        if (candidate.title.toLowerCase().includes(needle)) return true;
        if (candidate.path.toLowerCase().includes(needle)) return true;
        return candidate.tags.some((tag) => tag.toLowerCase().includes(needle));
      };

      const taskMetaParts = (candidate: EffectiveTask) => {
        const chips: string[] = [];
        if (candidate.effectiveScheduled) chips.push(`⏳ ${candidate.effectiveScheduled}`);
        const tags = taskDisplayTags(candidate.tags).slice(0, 2);
        chips.push(...tags);
        if (candidate.childrenLines.length > 0) {
          chips.push(tr("sheet.parentPickerChildren", { n: String(candidate.childrenLines.length) }));
        }
        return {
          source: `${compactPath(candidate.path)}:L${candidate.line + 1}`,
          chips,
        };
      };

      const renderCandidate = (parent: HTMLElement, candidate: EffectiveTask) => {
        const invalid = descendantIds.has(candidate.id);
        const row = parent.createEl("button", {
          cls: "bt-parent-candidate" + (invalid ? " is-disabled" : "") + (selectedId === candidate.id ? " is-selected" : ""),
        });
        row.dataset.parentCandidateId = candidate.id;
        row.type = "button";
        row.disabled = invalid;
        row.setAttr("aria-pressed", selectedId === candidate.id ? "true" : "false");
        row.createDiv({ cls: "bt-parent-candidate-title", text: candidate.title });
        const meta = row.createDiv({ cls: "bt-parent-candidate-meta" });
        if (invalid) {
          meta.createSpan({ cls: "bt-parent-candidate-invalid", text: tr("sheet.parentPickerInvalid") });
        } else {
          const parts = taskMetaParts(candidate);
          meta.createSpan({ cls: "bt-parent-candidate-source", text: parts.source });
          if (parts.chips.length > 0) {
            const chips = meta.createSpan({ cls: "bt-parent-candidate-chips" });
            for (const chipText of parts.chips) {
              chips.createSpan({ cls: "bt-parent-candidate-chip", text: chipText });
            }
          }
        }
        if (!invalid) {
          row.addEventListener("click", () => {
            selectedId = candidate.id;
            render();
          });
        }
      };

      const renderGroup = (title: string, candidates: EffectiveTask[]) => {
        if (candidates.length === 0) return;
        const group = candidateList.createDiv({ cls: "bt-parent-picker-group" });
        group.createDiv({ cls: "bt-parent-picker-group-title", text: title });
        for (const candidate of candidates.slice(0, 12)) renderCandidate(group, candidate);
      };

      const unique = (items: EffectiveTask[]) => {
        const seen = new Set<string>();
        const out: EffectiveTask[] = [];
        for (const item of items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          out.push(item);
        }
        return out;
      };

      const render = () => {
        const input = sheetBody.querySelector<HTMLInputElement>(".bt-parent-picker-search");
        const q = input?.value.trim() ?? "";
        candidateList.empty();
        if (q) {
          renderGroup(
            tr("sheet.parentPickerSearchResults"),
            eligibleTasks.filter((candidate) => matchesSearch(candidate, q)).slice(0, 50),
          );
        } else {
          const renderedIds = new Set<string>();
          const nextGroup = (candidates: EffectiveTask[]) => {
            const out = unique(candidates.filter((candidate) => eligibleIds.has(candidate.id) || descendantIds.has(candidate.id)))
              .filter((candidate) => !renderedIds.has(candidate.id));
            for (const candidate of out) renderedIds.add(candidate.id);
            return out;
          };
          renderGroup(
            tr("sheet.parentPickerCurrentView"),
            nextGroup(Array.from(visibleIds).map((id) => effectiveById.get(id)).filter((candidate): candidate is EffectiveTask => !!candidate)),
          );
          renderGroup(
            tr("sheet.parentPickerSameFile"),
            nextGroup(eligibleTasks.filter((candidate) => candidate.path === t.path)),
          );
        }

        if (candidateList.childElementCount === 0) {
          candidateList.createDiv({ cls: "bt-sheet-empty", text: tr("sheet.parentPickerEmpty") });
        }
        const selected = selectedId ? effectiveById.get(selectedId) : null;
        confirmButton.disabled = !selected;
        confirmButton.setText(
          selected
            ? tr("sheet.parentPickerConfirm", { title: selected.title })
            : tr("sheet.parentPickerNeedsSelection"),
        );
      };

      const pickerSheet = new BottomSheet(this.app, {
        title: tr("sheet.parentPickerTitle"),
        sheetClass: "task-center-parent-picker-sheet",
        onClose: () => finish(null),
        populate: (el) => {
          sheetBody = el.createDiv({ cls: "bt-parent-picker" });
          sheetBody.dataset.parentPicker = "true";
          sheetBody.createDiv({
            cls: "bt-parent-picker-subtitle",
            text: tr("sheet.parentPickerSubtitle", { title: t.title }),
          });

          const search = sheetBody.createEl("input", {
            type: "text",
            placeholder: tr("sheet.parentPickerSearch"),
            cls: "bt-tag-search bt-parent-picker-search",
          });

          candidateList = sheetBody.createDiv({ cls: "bt-parent-picker-list" });
          const footer = sheetBody.createDiv({ cls: "bt-parent-picker-footer" });
          footer.createDiv({ cls: "bt-parent-picker-effect", text: tr("sheet.parentPickerEffect") });
          confirmButton = footer.createEl("button", {
            cls: "bt-sheet-action bt-parent-picker-confirm",
            text: tr("sheet.parentPickerNeedsSelection"),
          });
          confirmButton.type = "button";
          confirmButton.dataset.parentConfirm = "true";
          confirmButton.disabled = true;
          confirmButton.addEventListener("click", () => finish(selectedId));

          search.addEventListener("input", render);
          render();
        },
      });
      sheet = pickerSheet;
      pickerSheet.open();
    });
  }

  private async applyTagEditResult(t: EffectiveTask, edit: TagEditResult): Promise<void> {
    for (const tag of edit.remove) await this.api.tag(t.id, tag, true);
    for (const tag of edit.add) await this.api.tag(t.id, tag);
  }

  /**
   * Mobile tag management sheet. It edits the tag set as a diff and lets
   * writer.ts keep Markdown mutation byte-local to the task line.
   */
  private openTagEditorForTask(t: EffectiveTask): Promise<TagEditResult | null> {
    return new Promise((resolve) => {
      const initialTags = taskDisplayTags(t.tags);
      const initialSet = new Set(initialTags);
      const current = new Set(initialTags);
      const suggestions = taskDisplayTags(
        this.getEffectiveTasks().flatMap((task) => taskDisplayTags(task.tags)),
      )
        .filter((tag) => !initialSet.has(tag))
        .slice(0, 16);
      let sheet: BottomSheet | null = null;
      let settled = false;
      const finish = (result: TagEditResult | null) => {
        if (settled) return;
        settled = true;
        sheet?.close();
        resolve(result);
      };

      sheet = new BottomSheet(this.app, {
        title: tr("sheet.editTag"),
        onClose: () => finish(null),
        populate: (el) => {
          const root = el.createDiv({ cls: "bt-mobile-tag-sheet" });
          const currentSection = root.createDiv({ cls: "bt-tag-editor-section" });
          currentSection.createDiv({ cls: "bt-tag-editor-label", text: tr("sheet.editTagCurrent") });
          const currentList = currentSection.createDiv({ cls: "bt-tag-chip-row" });

          const inputSection = root.createDiv({ cls: "bt-tag-editor-section" });
          inputSection.createDiv({ cls: "bt-tag-editor-label", text: tr("sheet.editTagAdd") });
          const inputRow = inputSection.createDiv({ cls: "bt-tag-editor-input-row" });
          const input = el.createEl("input", {
            type: "text",
            placeholder: "#tag",
            cls: "bt-tag-search bt-tag-editor-input",
          });
          inputRow.appendChild(input);
          const addBtn = inputRow.createEl("button", {
            cls: "bt-tag-editor-add",
            text: tr("sheet.editTagAddButton"),
          });

          const suggestionSection = root.createDiv({ cls: "bt-tag-editor-section" });
          suggestionSection.createDiv({ cls: "bt-tag-editor-label", text: tr("sheet.editTagSuggestions") });
          const suggestionList = suggestionSection.createDiv({ cls: "bt-tag-chip-row" });

          const footer = root.createDiv({ cls: "bt-tag-editor-footer" });
          const cancel = footer.createEl("button", {
            cls: "bt-tag-editor-cancel",
            text: tr("sheet.cancel"),
          });
          const save = footer.createEl("button", {
            cls: "bt-tag-editor-save",
            text: tr("sheet.save"),
          });

          const render = () => {
            currentList.empty();
            const currentTags = Array.from(current);
            if (currentTags.length === 0) {
              currentList.createDiv({ cls: "bt-tag-editor-empty", text: tr("sheet.editTagEmpty") });
            }
            for (const tag of currentTags) {
              const chip = currentList.createEl("button", {
                cls: "bt-tag-editor-chip bt-tag-editor-chip-active",
              });
              chip.dataset.tagChip = tag;
              chip.setAttr("aria-label", tr("sheet.editTagRemove", { tag }));
              chip.createSpan({ text: tag });
              chip.createSpan({ cls: "bt-tag-editor-chip-remove", text: "×" });
              chip.addEventListener("click", () => {
                current.delete(tag);
                render();
              });
            }

            suggestionList.empty();
            const available = suggestions.filter((tag) => !current.has(tag));
            if (available.length === 0) {
              suggestionList.createDiv({ cls: "bt-tag-editor-empty", text: tr("sheet.editTagNoSuggestions") });
            }
            for (const tag of available) {
              const chip = suggestionList.createEl("button", {
                cls: "bt-tag-editor-chip",
                text: tag,
              });
              chip.dataset.tagSuggestion = tag;
              chip.addEventListener("click", () => {
                current.add(tag);
                render();
              });
            }
          };

          const addInputTags = () => {
            const tags = parseEditorTags(input.value);
            if (tags.length === 0) return;
            for (const tag of tags) current.add(tag);
            input.value = "";
            render();
            input.focus();
          };

          addBtn.addEventListener("click", addInputTags);

          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) {
              e.preventDefault();
              addInputTags();
            } else if (e.key === "Escape") {
              finish(null);
            }
          });

          cancel.addEventListener("click", () => finish(null));
          save.addEventListener("click", () => {
            const next = new Set(current);
            const add = Array.from(next).filter((tag) => !initialSet.has(tag));
            const remove = Array.from(initialSet).filter((tag) => !next.has(tag));
            finish({ add, remove });
          });

          render();
          window.setTimeout(() => input.focus(), 100);

          sheet!.modalEl.addEventListener("click", (e) => {
            if (e.target === sheet!.modalEl) {
              finish(null);
            }
          });
        },
      });
      sheet.open();
    });
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
   * Matrix view rendering (US-103 / UX §6.5).
   *
   * Projects the filtered EffectiveTask[] through applyViewProjection with
   * a matrix view config, then renders a 2D grid of X-axis columns × Y-axis
   * rows. Each cell shows tasks matching both axis bucket conditions.
   * Unmatched tasks appear in a separate section below the grid.
   *
   * Uses the unified projection pipeline (EffectiveTask → filters → projection)
   * as required by VAL-CORE-008 and ARCHITECTURE.md §4.3.
   */
  private renderMatrix(parent: HTMLElement, mx: MatrixAreaConfig): void {
    const active = this.activeSavedView();

    // ── Projection pipeline ──
    const effectiveTasks = deriveEffectiveTasks(this.tasks);
    const weekStartsOn = this.plugin.settings.weekStartsOn;
    const filtered = Object.keys(active.filters).length > 0
      ? applyQueryFilters(effectiveTasks, active.filters, weekStartsOn)
      : effectiveTasks;
    const viewModel: MatrixViewModel = projectMatrixArea(filtered, mx, weekStartsOn);

    const wrapper = parent.createDiv({ cls: "bt-matrix" });
    wrapper.dataset.view = "matrix";

    if (viewModel.cells.length === 0 && viewModel.unmatched.length === 0) {
      if (this.hasActiveFilters()) {
        this.renderFilterEmptyState(wrapper);
      } else {
        wrapper.createDiv({ text: tr("matrix.empty"), cls: "bt-matrix-empty" });
      }
      return;
    }

    // UX-mobile §5.4: on mobile, render as a vertical bucket list instead of
    // a 2D grid. Each Y-axis bucket is a collapsible section showing
    // its X-axis sub-buckets, preserving axis/bucket names.
    const isMobile = this.contentEl.dataset.mobileLayout === "true";

    if (isMobile) {
      // ── Mobile: vertical bucket list ──
      const yBuckets = new Map<string, { title: string; cells: typeof viewModel.cells }>();
      for (const cell of viewModel.cells) {
        const b = yBuckets.get(cell.rowId);
        if (b) b.cells.push(cell);
        else yBuckets.set(cell.rowId, { title: cell.rowTitle, cells: [cell] });
      }

      for (const [rowId, bucket] of yBuckets) {
        const section = wrapper.createDiv({ cls: "bt-matrix-mobile-bucket" });
        section.dataset.matrixRow = rowId;

        const head = section.createDiv({ cls: "bt-matrix-mobile-bucket-head" });
        head.createSpan({ text: bucket.title, cls: "bt-matrix-mobile-bucket-title" });
        const count = bucket.cells.reduce((s, c) => s + c.tasks.length, 0);
        head.createSpan({
          text: String(count),
          cls: "bt-matrix-mobile-bucket-count",
        });

        const body = section.createDiv({ cls: "bt-matrix-mobile-bucket-body" });

        for (const cell of bucket.cells) {
          const subSection = body.createDiv({ cls: "bt-matrix-mobile-sub-bucket" });
          const subHead = subSection.createDiv({ cls: "bt-matrix-mobile-sub-head" });
          subHead.createSpan({ text: cell.colTitle, cls: "bt-matrix-mobile-sub-title" });
          subHead.createSpan({
            text: String(cell.tasks.length),
            cls: "bt-matrix-mobile-sub-count",
          });

          if (cell.tasks.length === 0) {
            subSection.createDiv({
              text: tr("matrix.empty"),
              cls: "bt-matrix-mobile-sub-empty",
            });
          } else {
            const cellList = subSection.createDiv({ cls: "bt-matrix-mobile-sub-list" });
            for (const task of cell.tasks) {
              this.renderCard(cellList, task);
            }
          }
        }

        // Toggle collapse on head tap
        head.addEventListener("click", () => {
          body.classList.toggle("collapsed");
        });
      }
    } else {
      // ── Desktop: 2D grid (existing behavior) ──
      // ── Header row: X-axis column titles ──
      if (viewModel.xAxis.buckets.length > 0) {
        const headerRow = wrapper.createDiv({ cls: "bt-matrix-header" });
        // Corner cell
        headerRow.createDiv({ cls: "bt-matrix-corner", text: viewModel.yAxis.title || viewModel.xAxis.title });
        for (const col of viewModel.xAxis.buckets) {
          headerRow.createDiv({ cls: "bt-matrix-col-head", text: col.title });
        }
      }

      // ── Grid rows: Y-axis buckets × X-axis buckets ──
      // Group cells by rowId to render one row per Y-axis bucket
      const grid = wrapper.createDiv({ cls: "bt-matrix-grid" });
      const rowMap = new Map<string, typeof viewModel.cells>();
      for (const cell of viewModel.cells) {
        const row = rowMap.get(cell.rowId);
        if (row) row.push(cell);
        else rowMap.set(cell.rowId, [cell]);
      }

      for (const rowCells of rowMap.values()) {
        const rowEl = grid.createDiv({ cls: "bt-matrix-row" });
        // Row label (Y-axis bucket title)
        rowEl.createDiv({ cls: "bt-matrix-row-label", text: rowCells[0]?.rowTitle ?? "" });

        // Row cells (one per X-axis bucket)
        for (const cell of rowCells) {
          const cellEl = rowEl.createDiv({ cls: "bt-matrix-cell" });
          cellEl.dataset.matrixRow = cell.rowId;
          cellEl.dataset.matrixCol = cell.colId;

          if (cell.tasks.length === 0) {
            cellEl.addClass("bt-matrix-cell-empty");
          } else {
            const cellList = cellEl.createDiv({ cls: "bt-matrix-cell-list" });
            for (const task of cell.tasks) {
              this.renderCard(cellList, task);
            }
          }
        }
      }
    }

    // ── Unmatched tasks ──
    if (viewModel.unmatched.length > 0) {
      const unmatchedSection = wrapper.createDiv({ cls: "bt-matrix-unmatched" });
      const unmatchedHead = unmatchedSection.createDiv({ cls: "bt-matrix-unmatched-head" });
      unmatchedHead.createSpan({
        text: tr("matrix.unmatched"),
        cls: "bt-matrix-unmatched-label",
      });
      unmatchedHead.createSpan({
        text: `(${viewModel.unmatched.length})`,
        cls: "bt-matrix-unmatched-count",
      });
      for (const task of viewModel.unmatched) {
        this.renderCard(unmatchedSection, task);
      }
    }
  }

  // ── View = area 布局树（ARCHITECTURE.md §1.3 / §4.3）──
  // 遍历 active view 的 layout：row / col 容器递归排列，叶子 area 派发到
  // 对应组件。没有 today / completed / unscheduled 专属渲染分支。
  private renderViewLayout(parent: HTMLElement): void {
    const active = this.activeSavedView();
    this.renderSummaryArea(parent, active);
    const layout: LayoutNode = active.view?.layout ?? { type: "list" };
    const root = parent.createDiv({ cls: "bt-view-root" });
    this.renderLayoutNode(root, layout);
  }

  // 通用 summary 区：顶层 summary 指标在标准位置渲染，对任何 view 都一样。
  // 取代过去 completed 视图里硬编码的统计面板。（US-303 / ARCHITECTURE §4.4）
  private renderSummaryArea(parent: HTMLElement, active: QueryPreset): void {
    const metrics = active.summary ?? [];
    if (metrics.length === 0) return;
    // Count over the same top-level cards the view shows, so summary count
    // matches the tab badge / footer (not double-counting nested subtasks).
    const filtered = recomputeTopLevelInQuery(this.getEffectiveTasks().filter(this.getTextFilter()))
      .filter((t) => t.isTopLevelInQuery);
    const items = computeSummary(filtered, metrics);
    if (items.length === 0) return;
    const bar = parent.createDiv({ cls: "bt-summary-bar" });
    bar.dataset.summary = "true";
    for (const item of items) {
      const chip = bar.createDiv({ cls: `bt-summary-chip bt-summary-${item.type}` });
      chip.createSpan({ text: this.summaryChipLabel(item), cls: "bt-summary-chip-text" });
    }
  }

  private summaryChipLabel(item: SummaryResultItem): string {
    switch (item.type) {
      case "count":
        return `${tr("savedViews.summaryMetricCount")} ${item.value}`;
      case "sum":
        return `${item.field} ${item.formatted ?? `${item.value}m`}`;
      case "ratio":
        return `${item.numerator}/${item.denominator} ${item.formatted ?? `${item.value}%`}`;
      case "top_n":
        return `${item.by}: ${item.items.map((row) => `${row.key} ${row.count}`).join(" · ") || "—"}`;
      case "group_by":
        return `${item.by}: ${item.groups.map((row) => `${row.key} ${row.count}`).join(" · ") || "—"}`;
    }
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
            && (c.type === "list" || c.type === "grid")
            && this.localizeBuiltinTitle(c.id, c.title) !== "",
        );
        if (hasTitledChild) box.addClass("bt-row-has-head");
      }
      for (const child of node.children) this.renderLayoutNode(box, child);
      return;
    }
    const areaEl = parent.createDiv({ cls: `bt-area bt-area-${node.type}` });
    if (node.weight) areaEl.style.flexGrow = String(node.weight);
    switch (node.type) {
      case "list":
        this.renderListArea(areaEl, node, false);
        break;
      case "grid":
        this.renderListArea(areaEl, node, true);
        break;
      case "week":
        this.renderWeek(areaEl);
        break;
      case "month":
        this.renderMonth(areaEl);
        break;
      case "matrix":
        this.renderMatrix(areaEl, node);
        break;
      case "drop":
        this.renderTrashZone(areaEl);
        break;
    }
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

  private localizeBuiltinTitle(id: string | undefined, fallback: string | undefined): string {
    if (id) {
      const key = TaskCenterView.BUILTIN_TITLE_KEYS[id];
      if (key) return tr(key as Parameters<typeof tr>[0]);
    }
    return fallback ?? "";
  }

  private renderListArea(parent: HTMLElement, area: ListAreaConfig | GridAreaConfig, grid: boolean): void {
    const filter = this.getTextFilter();
    const filtered = recomputeTopLevelInQuery(this.getEffectiveTasks().filter(filter));
    const model = projectListArea(filtered, area, this.plugin.settings.weekStartsOn);
    const cardsCls = grid ? "bt-list-grid" : "";

    if (area.onDrop?.clearScheduled) {
      parent.dataset.dropZone = "unscheduled-tray";
      this.makeDropZone(parent, null);
    } else if (area.onDrop?.setScheduled) {
      this.makeDropZone(parent, area.onDrop.setScheduled);
    }

    const areaTitle = this.localizeBuiltinTitle(area.id, area.title);
    if (areaTitle) {
      parent.addClass("bt-has-head");
      const total = model.sections.reduce((s, sec) => s + sec.tasks.filter((t) => t.isTopLevelInQuery).length, 0);
      parent.createDiv({ cls: "bt-list-area-head", text: `${areaTitle} (${total})` });
    }

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
          for (const task of sectionTasks) this.renderCard(sectionBody, task);
        }
      }
      if (totalVisible === 0 && !area.onDrop) {
        if (this.tasks.length > 0) this.renderFilterEmptyState(parent);
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
      if (this.tasks.length > 0) this.renderFilterEmptyState(wrap);
      else wrap.createDiv({ text: tr("filters.empty"), cls: "bt-empty" });
      return;
    }
    for (const task of list) this.renderCard(wrap, task);
  }

  private async refreshAfterAction(): Promise<void> {
    await this.plugin.cache.forFlush();
    await this.reloadTasks();
    this.render();
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
    t: EffectiveTask,
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
    if (t.effectiveDeadline && t.effectiveStatus === "todo") {
      const today = todayISO();
      const dd = daysBetween(today, t.effectiveDeadline);
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
    check.addClass(`bt-check-${t.effectiveStatus}`);
    check.setText(statusIcon(t.effectiveStatus));
    check.title = "Toggle done (space)";
    check.addEventListener("click", (e) => {
      void (async () => {
        e.stopPropagation();
        await this.runWithRemoveAnim(t.id, async () => {
          if (t.effectiveStatus === "done") await this.api.undone(t.id);
          else await this.api.done(t.id);
        });
      })();
    });

    const title = titleRow.createDiv({ cls: "bt-card-title", text: t.title });
    title.title = t.title; // tooltip for long titles
    if (t.effectiveStatus === "done") card.addClass("done");

    this.renderTaskTags(card, t.tags, "bt-card-tags");

    // Meta row
    const meta = card.createDiv({ cls: "bt-card-meta" });
    // task #43: route est/act labels through tr() so a CN session reads
    // "预估 30m / 实际 25m" instead of the raw English literals.
    if (t.estimate) meta.createSpan({ text: tr("meta.est", { dur: formatMinutes(t.estimate) }), cls: "bt-meta-est" });
    if (t.effectiveDeadline) meta.createSpan({ text: `📅${t.effectiveDeadline}`, cls: "bt-meta-deadline" });
    if (t.actual) meta.createSpan({ text: tr("meta.act", { dur: formatMinutes(t.actual) }), cls: "bt-meta-actual" });
    // US-150: hide the `⏳ {date}` badge when the card is rendered in a
    // column whose day already implies it. Otherwise (unscheduled pool /
    // completed view / etc.) the badge stays — date isn't implied by
    // position there, and the user needs to see when it was scheduled.
    if (t.effectiveScheduled && t.effectiveScheduled !== contextDate) {
      meta.createSpan({ text: `⏳${t.effectiveScheduled}`, cls: "bt-meta-sched" });
    }
    const path = meta.createSpan({ text: compactPath(t.path), cls: "bt-meta-path" });
    path.title = t.path;

    // Children expansion — uses the EffectiveTask tree's renderParentId
    // to determine which children render inline under this card.
    const effectiveTasksForChildren = this.getEffectiveTasks();
    const children = effectiveTasksForChildren.filter((e) => e.renderParentId === t.id);
    if (children.length > 0) {
      const expander = card.createDiv({ cls: "bt-card-children" });
      for (const c of children) this.renderSubcard(expander, c, t.effectiveScheduled);
    }

    this.wireCardEvents(card, t);
    // Mobile gestures still need the pointer controller; source/context
    // editing is now the single-click source shell on every platform.
    if (isMobileMode()) {
      // Unified mobile gesture controller (UX-mobile §13 #6): long-press,
      // scroll cancellation, and swipe share one state machine.
      //   US-506: hold N ms still → openCardActionSheet (action menu)
      //   US-507: no mobile drag/drop; movement routes to scroll/swipe.
      //   US-508: swipe ≥ 50% left → done; ≥ 50% right → drop. Visual
      //           feedback appears only after crossing the half-card threshold.
      //   US-510: swipe is opt-out via settings (platform-conditional UI).
      // see USER_STORIES.md
      const settings = this.plugin.settings;
      attachCardGestures(card, {
        longPressMs: settings.mobileLongPressMs,
        moveThresholdPx: 4,
        swipeThresholdRatio: 0.5,
        onLongPress: () => this.openCardActionSheet(t),
        onSwipeProgress: (el, direction, progress) => {
          if (direction === null || progress < 1) {
            delete el.dataset.swipeReady;
            delete el.dataset.swipeDirection;
            delete el.dataset.swipeLabel;
            return;
          }
          el.dataset.swipeReady = "true";
          el.dataset.swipeDirection = direction;
          el.dataset.swipeLabel = direction === "left" ? tr("sheet.done") : tr("sheet.drop");
        },
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
      if (kind === "done") {
        const r = await this.api.done(t.id);
        if (!r.unchanged) {
          this.undoStack.push({
            label: "swipe done",
            ops: [{ path: t.path, line: t.line, before: [r.before], after: [r.after] }],
          });
        }
      } else {
        const r = await this.api.drop(t.id);
        if (!r.unchanged) {
          // fix-m4-abandon-undo-cascade: record one UndoOp per affected
          // line (parent + cascaded children) so undo restores the
          // entire cascade atomically.
          const ops = (r.results ?? []).map((d) => ({
            path: d.path,
            line: d.line,
            before: [d.before],
            after: [d.after],
          }));
          this.undoStack.push({ label: "swipe drop", ops });
        }
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
    c: EffectiveTask,
    effectiveScheduled: string | null,
  ) {
    const subCard = container.createDiv({ cls: "bt-subcard" });
    subCard.dataset.taskId = c.id;
    if (this.contentEl.dataset.mobileLayout !== "true") subCard.draggable = true;
    if (this.state.selectedTaskId === c.id) subCard.addClass("selected");

    const check = subCard.createEl("button", { cls: "bt-sub-check", text: statusIcon(c.effectiveStatus) });
    check.type = "button";
    check.addClass(`bt-sub-check-${c.effectiveStatus}`);
    check.dataset.cardAction = "done";
    check.title = c.effectiveStatus === "done" ? tr("ctx.markTodo") : tr("ctx.markDone");
    check.setAttr("aria-label", check.title);
    const toggleInPlace = (e: Event) => {
      void (async () => {
        e.stopPropagation();
        try {
          if (c.effectiveStatus === "done") await this.api.undone(c.id);
          else await this.api.done(c.id);
          this.scheduleRefresh();
        } catch (err) {
          new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
          this.scheduleRefresh();
        }
      })();
    };
    check.addEventListener("click", toggleInPlace);

    const title = subCard.createDiv({ cls: "bt-subcard-title", text: c.title });
    title.dataset.cardAction = "open";
    title.title = c.title;

    // (Previous `bt-sub-sched` badge for cross-day subtasks removed —
    //  US-148 now surfaces such subtasks as standalone top-level cards
    //  on their own day, so the inline badge can never trigger. Subcards
    //  reaching this branch always share their parent's `⏳` or have
    //  none of their own; no badge needed in either case.)
    if (c.estimate) subCard.createDiv({ cls: "bt-sub-est", text: formatMinutes(c.estimate) });
    if (c.effectiveStatus === "done") subCard.addClass("done");
    // task #37: subcards are drag SOURCES but not nest drop targets. The
    // browser's hit-test lands on the deepest DOM node under the cursor, so
    // a drop visually aimed at the parent card's body would otherwise nest
    // under the subcard the cursor happened to be over. Letting the drop
    // event bubble up to the enclosing `.bt-card` makes the drop land where
    // the user expects (the parent). To explicitly nest under a subcard the
    // user can still drop onto its top-level card rendering on its own day
    // when it has its own ⏳.
    this.wireCardEvents(subCard, c, { acceptNestDrop: false });

    // Grandchildren — use the EffectiveTask tree's renderParentId to
    // determine which grandchildren render inline.
    const effectiveTasksForGrand = this.getEffectiveTasks();
    const grand = effectiveTasksForGrand.filter((e) => e.renderParentId === c.id);
    if (grand.length > 0) {
      if (Platform.isMobile) {
        // US-505: mobile collapses to 1 level.
        const total = this.countDescendants(c);
        const more = subCard.createDiv({ cls: "bt-subcard-more" });
        more.setText(`+${total}`);
        more.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openSubtreeSheet(c);
        });
      } else {
        const inheritedDown = c.effectiveScheduled ?? effectiveScheduled;
        const sub = container.createDiv({ cls: "bt-card-children" });
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
    t: EffectiveTask,
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
    // double-click source jumps with one primary card action. On mobile,
    // the primary action is a compact task detail sheet; editing source
    // Markdown is still available there as an explicit action.
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.contentEl.dataset.mobileLayout === "true") {
        this.openMobileTaskDetailSheet(t);
      } else {
        void this.openSourceEditShell(t);
      }
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
  private getTextFilter(): (t: EffectiveTask) => boolean {
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
      if (status !== "all" && !status.includes(t.effectiveStatus)) return false;
      return true;
    };
  }

  private getSavedViewFilter(view: QueryPreset): (t: EffectiveTask) => boolean {
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
      if (status !== "all" && !status.includes(t.effectiveStatus)) return false;
      return true;
    };
  }

  private hasTimeFilters(time: SavedViewTimeFilters): boolean {
    return Object.values(time).some((value) => !!value?.trim());
  }

  private taskMatchesTimeFilters(task: EffectiveTask, time: SavedViewTimeFilters): boolean {
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
      view: { layout: { type: "list" } },
      summary: [],
    });
  }

  private currentQuerySnapshot(existing?: QueryPreset | null, name?: string): QueryPreset {
    return computeQueryPresetSnapshot({
      existing,
      tabDrafts: this.tabDrafts,
      filterSearch: this.state.filter,
      filterTags: this.state.savedViewTag,
      filterTime: this.state.savedViewTime,
      filterStatus: this.state.savedViewStatus,
      fallbackView: () => this.currentQueryPresetViewConfig(),
      fallbackSummary: () => this.currentSavedViewSummary(),
      name: name ?? (existing ? undefined : this.suggestSavedViewName()),
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

  private currentSavedViewSummary(): QueryPresetSummaryMetric[] {
    // Read from the active saved QueryPreset's summary (draft or saved).
    // Draft always wins (even if empty); saved summary is used as-is.
    // Only fall through to legacy tab defaults when there's no saved view.
    const saved = this.selectedSavedView();
    if (saved) {
      const draft = this.tabDrafts.get(saved.id);
      if (draft) {
        return draft.summary ?? [];
      }
      // Use saved summary as-is — an empty array means "no summary"
      // was explicitly configured (or the builtin preset ships without one).
      return saved.summary ?? [];
    }
    return this.defaultSummaryForLegacyTab();
  }

  private defaultSummaryForLegacyTab(): QueryPresetSummaryMetric[] {
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

  // state.tab 现在只是「主内容 area 类型」的粗标签，用于日期导航与
  // lastTab 记忆。list 家族（today/todo/completed/unscheduled/dropped）
  // 统一映射成 "list"。
  private tabForSavedView(view: QueryPreset, fallback: TabKey): TabKey {
    const config = normalizeQueryPreset(view).view;
    const type = this.primaryAreaType(config);
    if (type === "week") return "week";
    if (type === "month") return "month";
    if (type === "matrix") return "matrix";
    if (type === "list") return "list";
    return fallback;
  }

  // 布局里第一个非 drop area 的类型（找不到则第一个 area，再退化 list）。
  private primaryAreaType(view: QueryPresetViewConfig): AreaType {
    const areas = collectAreas(view.layout);
    const content = areas.find((a) => a.type !== "drop");
    return (content ?? areas[0])?.type ?? "list";
  }

  // GUI view-type 切换：把布局换成「单个该类型 area」。matrix 复用已有
  // 配置，没有则给一个空脚手架供用户配置 bucket。
  private buildLayoutForAreaType(type: AreaType, current: QueryPresetViewConfig): LayoutNode {
    if (type === "matrix") {
      const existing = findAreaByType(current.layout, "matrix");
      if (existing) return existing;
      return {
        type: "matrix",
        x: { id: "x", title: "X", buckets: [] },
        y: { id: "y", title: "Y", buckets: [] },
        unmatched: "show",
        multiMatch: "first",
        showEmptyBuckets: true,
      };
    }
    return { type } as AreaConfig;
  }

  private refreshFilterControls(rerenderControls?: FilterControlsRerender): void {
    if (rerenderControls) rerenderControls();
    else this.render();
  }

  private handleFilterOutsidePointerDown(event: PointerEvent): void {
    if (!shouldCloseFilterPopoverOnPointerDown({
      isOpen: this.filterPopoverOpen !== null,
      isInsideFilterControls: isClickInsideFilterControls(event),
    })) return;
    this.filterPopoverOpen = null;
    this.pendingDateRangeStart = null;
    this.render();
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
  openContextMenu(e: MouseEvent, task: EffectiveTask) {
    const m = new Menu();
    m.addItem((i) =>
      i.setTitle(task.effectiveStatus === "done" ? tr("ctx.markTodo") : tr("ctx.markDone")).onClick(async () => {
        await this.runWithRemoveAnim(task.id, async () => {
          if (task.effectiveStatus === "done") await this.api.undone(task.id);
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
