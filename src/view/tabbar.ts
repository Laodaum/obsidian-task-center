// Tab 条渲染（标签按钮 + 拖拽重排 + dwell 切换 + 溢出「更多」+ 逐 tab 管理菜单），
// 从 TaskCenterView god class 抽出（ARCHITECTURE §7.9 TabBarPort / §7.14 step10）。
// 收 v: TaskCenterView——展示 tab 列表并把切换/重排/CRUD 派发到壳的草稿状态机与
// saved-view-actions；tab 脏标/徽标/计数为模块内部纯读。后续可收窄为 TabBarPort。

import { Menu, Notice, setIcon } from "obsidian";
import type { TaskCenterView } from "../view";
import type { QueryPreset } from "../types";
import { t as tr } from "../i18n";
import { BottomSheet } from "./bottom-sheet";
import { attachLongPress } from "./touch";
import { isMobileMode } from "../platform";
import { normalizeQueryPreset, sameQueryPresetContent } from "../saved-views";
import { countTopLevel, recomputeTopLevelInQuery } from "../task-tree";
import { todayISO, addDays, startOfWeek, startOfMonth, endOfMonth } from "../dates";
import {
  copySavedView,
  setDefaultSavedView,
  moveSavedView,
  reorderQueryTab,
  renameSavedView,
  toggleSavedViewHidden,
  deleteSavedViewWithConfirm,
  restoreBuiltinSavedView,
} from "./saved-view-actions";
import { openManageTabsSheet, openManageTabRowMenu } from "./manage-tabs";

export function renderTabBar(v: TaskCenterView, parent: HTMLElement): void {
  const bar = parent.createDiv({ cls: "bt-tabbar" });
  const tabs = v.visibleQueryTabs();
  const mobileLayout = v.contentEl.dataset.mobileLayout === "true";
  // VAL-GUI-005 / US-109q / US-117a: overflow handling differs by regime:
  //  - Mobile: the strip pans horizontally and shows ALL tabs — no "更多"
  //    overflow button (US-117a: one compact strip that scrolls; no desktop
  //    affordances). CSS gives `.bt-tabbar` `overflow-x: auto` on mobile.
  //  - Desktop: width-driven. `fittedVisibleTabCount` (measured after layout,
  //    see scheduleTabOverflowMeasure) caps how many leading tabs fit so the
  //    bar never scrolls horizontally; the rest go into the "更多" button.
  // ⌃1–⌃9 map to the first 9 of `visibleQueryTabs()` regardless of the split.
  const visibleCount = mobileLayout
    ? tabs.length
    : (v.tabOverflow.fittedCount ?? tabs.length);
  const visibleTabs = tabs.slice(0, visibleCount);
  const overflowTabs = tabs.slice(visibleCount);

  for (const [index, view] of visibleTabs.entries()) {
    renderTabButton(v, bar, view, index, mobileLayout);
  }

  // Overflow "更多" button — first-class tab metadata
  if (overflowTabs.length > 0) {
    const moreBtn = bar.createDiv({ cls: "bt-tab bt-tab-more" });
    // data-tab-id anchors this as a first-class entry for e2e selectors
    moreBtn.dataset.queryTabId = "__overflow__";
    moreBtn.dataset.tabId = "__overflow__";
    // Aggregate metadata: show dirty/default if ANY overflow tab carries it
    if (overflowTabs.some((vw) => isSavedViewDirty(v, vw))) {
      moreBtn.dataset.queryTabDirty = "true";
    }
    if (overflowTabs.some((vw) => v.plugin.settings.defaultSavedViewId === vw.id)) {
      moreBtn.dataset.queryTabDefault = "true";
    }
    const label = moreBtn.createDiv({ cls: "bt-tab-label" });
    label.createSpan({ text: tr("savedViews.tabMore"), cls: "bt-tab-name" });
    if (overflowTabs.some((vw) => isSavedViewDirty(v, vw))) {
      label.createSpan({ text: "•", cls: "bt-tab-dirty-dot" });
    }
    // US-109q: the badge counts collapsed tabs ("还有 N 个 tab"), not the sum
    // of their task counts — per-tab task counts already show on each row.
    moreBtn.createSpan({ text: String(overflowTabs.length), cls: "bt-tab-count" });
    moreBtn.title = overflowTabs.map((vw) => vw.name).join(", ");

    // US-109q: desktop opens an in-place dropdown anchored under the "更多"
    // button; mobile keeps the bottom sheet (narrow screens can't host an
    // anchored popover — see UX.md §「Tab 过多」 / UX-mobile §3.1).
    if (mobileLayout) {
      moreBtn.addEventListener("click", () => openOverflowTabsSheet(v, overflowTabs));
      moreBtn.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openOverflowTabsSheet(v, overflowTabs);
      });
    } else {
      moreBtn.addClass("bt-tab-more-anchor");
      moreBtn.setAttr("aria-expanded", v.overflowTabsMenuOpen ? "true" : "false");
      const toggleMenu = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        v.overflowTabsMenuOpen = !v.overflowTabsMenuOpen;
        // Opening the overflow menu closes any open filter popover.
        v.filterPopoverOpen = null;
        v.render();
      };
      moreBtn.addEventListener("click", toggleMenu);
      moreBtn.addEventListener("contextmenu", toggleMenu);
      if (v.overflowTabsMenuOpen) {
        const menu = moreBtn.createDiv({ cls: "bt-overflow-tabs-menu" });
        // Stop clicks inside the menu chrome from bubbling to the toggle.
        menu.addEventListener("click", (e) => e.stopPropagation());
        renderOverflowTabEntries(v, menu, overflowTabs, () => {
          v.overflowTabsMenuOpen = false;
          v.render();
        }, { draggable: false });
      }
    }
  } else if (v.overflowTabsMenuOpen) {
    // Overflow collapsed away (e.g. a tab was hidden) — drop the stale flag.
    v.overflowTabsMenuOpen = false;
  }

  // DESIGN §5.0: tab-collection management belongs to the Tab Strip (the tabs'
  // home), not the per-query toolbar. Settings is app chrome — a standalone
  // gear in the top strip, not buried in a query action drawer.
  const tail = bar.createDiv({ cls: "bt-tabbar-tail" });
  const manageBtn = tail.createEl("button", { cls: "bt-tabbar-tail-btn" });
  setIcon(manageBtn, "list");
  manageBtn.setAttr("aria-label", tr("savedViews.manage"));
  manageBtn.dataset.action = "manage-query-tabs";
  manageBtn.addEventListener("click", () => openManageTabsSheet(v));
  const gearBtn = tail.createEl("button", { cls: "bt-tabbar-tail-btn" });
  setIcon(gearBtn, "settings");
  gearBtn.setAttr("aria-label", tr("toolbar.settings"));
  gearBtn.addEventListener("click", () => v.openPluginSettings());

  // US-109q: desktop width-driven overflow runs after layout — measure which
  // tabs actually fit and collapse the rest into "更多". Mobile pans instead.
  if (!mobileLayout) {
    v.tabOverflow.measure(bar);
  }
}

function renderTabButton(v: TaskCenterView, bar: HTMLElement, view: QueryPreset, index: number, mobileLayout: boolean): void {
  const active = view.id === v.state.savedViewId;
  const dirty = isSavedViewDirty(v, view);
  const badges = savedViewBadges(v, view);
  const btn = bar.createDiv({ cls: "bt-tab" + (active ? " active" : "") });
  const legacyTab = v.legacyTabForSavedView(view);
  if (legacyTab) btn.dataset.tab = legacyTab;
  btn.dataset.queryTabId = view.id;
  btn.dataset.tabId = view.id;
  if (dirty) btn.dataset.queryTabDirty = "true";
  if (v.plugin.settings.defaultSavedViewId === view.id) btn.dataset.queryTabDefault = "true";
  btn.title = badges.length > 0 ? `${view.name} · ${badges.join(" · ")}` : view.name;
  if (!mobileLayout) btn.draggable = true;
  const label = btn.createDiv({ cls: "bt-tab-label" });
  label.createSpan({ text: view.name, cls: "bt-tab-name" });
  if (dirty) {
    label.createSpan({ text: "•", cls: "bt-tab-dirty-dot" });
  }
  const count = countForSavedView(v, view);
  if (count > 0) {
    btn.createSpan({ text: String(count), cls: "bt-tab-count" });
  }
  if (!mobileLayout && index < 9) {
    btn.createSpan({ text: `⌃${index + 1}`, cls: "bt-hotkey" });
  }
  btn.addEventListener("click", () => v.activateSavedView(view));
  btn.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void renameSavedView(v, view);
  });
  btn.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openSavedViewMenu(v, event, view);
  });

  // UX-mobile §3.2: long-press on a tab opens the tab management sheet
  // on mobile (desktop uses right-click / contextmenu instead).
  if (isMobileMode()) {
    attachLongPress(btn, {
      durationMs: v.plugin.settings.mobileLongPressMs,
      moveThresholdPx: 4,
      onTrigger: () => openTabManagementSheet(v, view),
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
      v.dwellTracker.update(view.id, btn, v.state.savedViewId ?? "");
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
      v.dwellTracker.reset();
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
      const presets = v.plugin.settings.queryPresets;
      const targetIndex = presets.findIndex((p) => p.id === view.id);
      if (targetIndex === -1) return;
      // If dropping after, insert at targetIndex + 1; if before, at targetIndex
      const insertAt = isAfter ? targetIndex + 1 : targetIndex;
      void reorderQueryTab(v, draggedId, insertAt);
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
function openTabManagementSheet(v: TaskCenterView, view: QueryPreset): void {
  const sheet = new BottomSheet(v.app, {
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

      const presets = v.plugin.settings.queryPresets;
      const idx = presets.findIndex((p) => p.id === view.id);

      addBtn(tr("savedViews.rename"), () => renameSavedView(v, view));
      addBtn(tr("savedViews.copy"), () => copySavedView(v, view));
      addBtn(tr("savedViews.editQuery"), () => v.openQueryControlsSheet());
      addBtn(tr("savedViews.setDefault"), () => setDefaultSavedView(v, view.id));

      if (idx > 0) {
        addBtn(tr("savedViews.moveLeft"), () => moveSavedView(v, view, -1));
      } else {
        actions.createEl("button", {
          cls: "bt-sheet-action bt-sheet-action-disabled",
          text: tr("savedViews.moveLeft"),
        });
      }

      if (idx >= 0 && idx < presets.length - 1) {
        addBtn(tr("savedViews.moveRight"), () => moveSavedView(v, view, 1));
      } else {
        actions.createEl("button", {
          cls: "bt-sheet-action bt-sheet-action-disabled",
          text: tr("savedViews.moveRight"),
        });
      }

      addBtn(
        view.hidden ? tr("savedViews.show") : tr("savedViews.hide"),
        () => toggleSavedViewHidden(v, view, !view.hidden),
      );

      // US-109l: delete is available for builtin presets too (they re-appear
      // via 「恢复预设 Tabs」). Builtins additionally offer 「恢复预设」 to reset.
      if (view.builtin) {
        addBtn(tr("savedViews.restore"), () => restoreBuiltinSavedView(v, view));
      }
      addBtn(tr("savedViews.delete"), () => deleteSavedViewWithConfirm(v, view));
    },
  });
  sheet.open();
}

/**
 * VAL-GUI-005: overflow tabs are first-class Query Tabs. On mobile (narrow
 * screens) the "更多" entry opens a bottom sheet; desktop uses an in-place
 * dropdown anchored under the button (see renderTabBar). Both share
 * renderOverflowTabEntries, listing overflow Query Tabs with order, badge,
 * default status, and full management actions (rename, copy, set default,
 * move, hide, delete) — UX-mobile §3.1 / UX.md §「Tab 过多」.
 */
function openOverflowTabsSheet(v: TaskCenterView, overflowTabs: QueryPreset[]): void {
  const sheet = new BottomSheet(v.app, {
    title: tr("savedViews.tabMore"),
    populate: (el) => {
      const body = el.createDiv({ cls: "bt-overflow-tabs-sheet" });
      renderOverflowTabEntries(v, body, overflowTabs, () => sheet.close());
    },
  });
  sheet.open();
}

function renderOverflowTabEntries(
  v: TaskCenterView,
  parent: HTMLElement,
  overflowTabs: QueryPreset[],
  closeSheet: () => void,
  options?: { draggable?: boolean },
): void {
  // Drag-to-reorder only makes sense in the roomy bottom sheet; the narrow
  // desktop dropdown skips it (reorder lives in the Manage Tabs panel).
  const draggable = options?.draggable ?? true;
  const container = parent;
  for (const view of overflowTabs) {
    const row = parent.createDiv({ cls: "bt-overflow-tab-row" });
    row.draggable = draggable;
    // First-class data attributes: same as visible tab buttons
    row.dataset.tabId = view.id;
    row.dataset.queryTabId = view.id;
    const dirty = isSavedViewDirty(v, view);
    if (dirty) row.dataset.queryTabDirty = "true";
    if (v.plugin.settings.defaultSavedViewId === view.id) row.dataset.queryTabDefault = "true";
    if (view.id === v.state.savedViewId) row.addClass("bt-overflow-tab-row-active");

    // ── Drag-to-reorder for overflow tab rows (sheet only) ──
    if (draggable) {
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
      const presets = v.plugin.settings.queryPresets;
      const targetIndex = presets.findIndex((p) => p.id === view.id);
      if (targetIndex === -1) return;
      const insertAt = isAfter ? targetIndex + 1 : targetIndex;
      void reorderQueryTab(v, draggedId, insertAt).then(() => closeSheet());
    });
    }

    // DESIGN §5.0: same row + kebab pattern as the Manage Tabs panel —
    // name + badges + count inline, management collapsed into one ⋮ menu.
    // "更多" is primarily a quick switcher: click row = open the tab.
    const main = row.createDiv({ cls: "bt-overflow-tab-main" });
    main.createSpan({ text: view.name, cls: "bt-overflow-tab-name" });
    if (dirty) main.createSpan({ text: "•", cls: "bt-tab-dirty-dot" });
    for (const badge of savedViewBadges(v, view)) {
      main.createSpan({ cls: "bt-overflow-tab-badge", text: badge });
    }
    const count = countForSavedView(v, view);
    if (count > 0) {
      main.createSpan({ text: String(count), cls: "bt-overflow-tab-count" });
    }

    const runRowAction = (handler: () => void | Promise<void>) =>
      Promise.resolve(handler()).then(() => closeSheet()).catch((error) =>
        new Notice(tr("notice.error", { msg: error instanceof Error ? error.message : String(error) }), 4000),
      );

    // Click row = switch to this tab (and close the sheet).
    row.addEventListener("click", () => {
      closeSheet();
      v.activateSavedView(view);
    });
    // Right-click / kebab = the shared tab management menu (§5.0).
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openManageTabRowMenu(v, event, view, (handler) => { void runRowAction(handler); });
    });
    const kebab = row.createEl("button", { cls: "bt-overflow-tab-kebab" });
    setIcon(kebab, "more-vertical");
    kebab.setAttr("aria-label", tr("savedViews.more"));
    kebab.addEventListener("click", (e) => {
      e.stopPropagation();
      openManageTabRowMenu(v, e, view, (handler) => { void runRowAction(handler); });
    });
  }
}

function isSavedViewDirty(v: TaskCenterView, view: QueryPreset): boolean {
  const normalized = normalizeQueryPreset(view);
  if (v.isViewCurrentlyActive(normalized)) {
    return v.isSelectedSavedViewDirty(normalized);
  }
  const draft = v.tabDrafts.get(normalized.id);
  return !!draft && !sameQueryPresetContent(draft, normalized);
}

function savedViewBadges(v: TaskCenterView, view: QueryPreset): string[] {
  const badges: string[] = [];
  if (v.isViewCurrentlyActive(view)) badges.push(tr("savedViews.currentBadge"));
  if (v.plugin.settings.defaultSavedViewId === view.id) badges.push(tr("savedViews.defaultBadge"));
  if (isSavedViewDirty(v, view)) badges.push(tr("savedViews.dirtyBadge"));
  if (view.hidden) badges.push(tr("savedViews.hiddenBadge"));
  if (view.builtin) badges.push(tr("savedViews.presetBadge"));
  return badges;
}

function countForSavedView(v: TaskCenterView, view: QueryPreset): number {
  const normalized = normalizeQueryPreset(view);
  // Badge = top-level cards the tab renders (US-105). The set is decided by
  // the primary area's own `when` (via getSavedViewFilter) — no per-tab-name
  // special cases. Date views (week/month) only render cards that fall in the
  // current period, so the count is scoped to it; everything else is a plain
  // top-level count of the filtered set. (The old `today`/`completed`/
  // `unscheduled` branches were dead code — tabForSavedView only ever returns
  // week/month/list.)
  const tab = v.tabForSavedView(normalized, "list");
  const filter = v.getSavedViewFilter(normalized);
  const filtered = v.getEffectiveTasks().filter(filter);
  const today = todayISO();
  if (tab === "week" || tab === "month") {
    const start = tab === "week" ? startOfWeek(today, v.plugin.settings.weekStartsOn) : startOfMonth(today);
    const end = tab === "week" ? addDays(start, 6) : endOfMonth(today);
    const inRange = filtered.filter((task) => {
      const date = task.effectiveScheduled;
      return !!date && date >= start && date <= end;
    });
    return countTopLevel(recomputeTopLevelInQuery(inRange));
  }
  return countTopLevel(recomputeTopLevelInQuery(filtered));
}

function openSavedViewMenu(v: TaskCenterView, event: MouseEvent, view: QueryPreset): void {
  const normalized = normalizeQueryPreset(view);
  const menu = new Menu();
  menu.addItem((item) =>
    item.setTitle(tr("savedViews.copy")).onClick(() => {
      void copySavedView(v, normalized);
    }),
  );
  menu.addItem((item) =>
    item.setTitle(tr("savedViews.editDsl")).onClick(() => {
      v.activateSavedView(normalized);
      v.openQueryControlsSheet({ scope: "tab" });
    }),
  );
  menu.addItem((item) =>
    item.setTitle(tr("savedViews.rename")).onClick(() => {
      void renameSavedView(v, normalized);
    }),
  );
  menu.addItem((item) =>
    item.setTitle(tr("savedViews.setDefault")).onClick(() => {
      void setDefaultSavedView(v, normalized.id);
    }),
  );
  menu.addItem((item) =>
    item.setTitle(normalized.hidden ? tr("savedViews.show") : tr("savedViews.hide")).onClick(() => {
      void toggleSavedViewHidden(v, normalized, !normalized.hidden);
    }),
  );
  // US-109l: builtins keep 「恢复预设」 (reset to factory) and are now also
  // deletable; custom tabs just delete.
  if (normalized.builtin) {
    menu.addItem((item) =>
      item.setTitle(tr("savedViews.restore")).setIcon("rotate-ccw").onClick(() => {
        void restoreBuiltinSavedView(v, normalized);
      }),
    );
  }
  menu.addItem((item) =>
    item.setTitle(tr("savedViews.delete")).onClick(() => {
      void deleteSavedViewWithConfirm(v, normalized);
    }),
  );
  menu.showAtMouseEvent(event);
}
