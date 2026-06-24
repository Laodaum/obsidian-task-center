// "管理 Tabs" 面板（BottomSheet）的渲染与逐行 kebab 菜单，从 TaskCenterView
// god class 抽出（ARCHITECTURE §7.9 / §7.14 step6）。收 v: TaskCenterView——
// 行的 CRUD 走第 5 步的 saved-view-actions，shell 仍持 render / activate /
// query 编辑入口；后续一步可收窄为 SavedViewPanelPort。

import { Notice, Menu, setIcon } from "obsidian";
import type { TaskCenterView } from "../view";
import type { QueryPreset } from "../types";
import { t as tr } from "../i18n";
import { BottomSheet } from "./bottom-sheet";
import { normalizeQueryPreset } from "../saved-views";
import {
  createSavedViewFromCurrent,
  copySavedView,
  setDefaultSavedView,
  reorderQueryTab,
  renameSavedView,
  toggleSavedViewHidden,
  deleteSavedViewWithConfirm,
  restoreBuiltinSavedView,
  restoreAllBuiltinSavedViews,
} from "./saved-view-actions";

export function openManageTabsSheet(v: TaskCenterView): void {
  let body: HTMLElement;
  let sheet: BottomSheet;
  const rerender = () => {
    v.render();
    if (!body) return;
    body.empty();
    renderManageTabsSheet(v, body, rerender, () => sheet.close());
  };
  sheet = new BottomSheet(v.app, {
    title: tr("savedViews.manageTitle"),
    populate: (el) => {
      body = el.createDiv({ cls: "bt-manage-tabs-sheet" });
      renderManageTabsSheet(v, body, rerender, () => sheet.close());
    },
  });
  sheet.open();
}

export function renderManageTabsSheet(
  v: TaskCenterView,
  parent: HTMLElement,
  rerender: () => void,
  closeSheet: () => void,
): void {
  const topActions = parent.createDiv({ cls: "bt-manage-tabs-actions" });
  const create = topActions.createEl("button", {
    text: tr("savedViews.create"),
    cls: "bt-manage-tab-btn",
  });
  create.addEventListener("click", () => {
    void createSavedViewFromCurrent(v).then(rerender).catch((error) =>
      new Notice(tr("notice.error", { msg: error instanceof Error ? error.message : String(error) }), 4000),
    );
  });
  const restoreDefaults = topActions.createEl("button", {
    text: tr("savedViews.restoreDefaultTabs"),
    cls: "bt-manage-tab-btn",
  });
  restoreDefaults.addEventListener("click", () => {
    void restoreAllBuiltinSavedViews(v).then(rerender).catch((error) =>
      new Notice(tr("notice.error", { msg: error instanceof Error ? error.message : String(error) }), 4000),
    );
  });

  const rows = parent.createDiv({ cls: "bt-manage-tabs-list" });
  for (const view of v.plugin.settings.queryPresets.map((item) => normalizeQueryPreset(item))) {
    const row = rows.createDiv({ cls: "bt-manage-tab-row" });
    row.draggable = true;
    const handle = row.createSpan({ cls: "bt-manage-tab-handle", text: "⠿" });
    handle.setAttr("aria-hidden", "true");
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
      const presets = v.plugin.settings.queryPresets;
      const targetIndex = presets.findIndex((p) => p.id === view.id);
      if (targetIndex === -1) return;
      const insertAt = isAfter ? targetIndex + 1 : targetIndex;
      void reorderQueryTab(v, draggedId, insertAt).then(rerender);
    });

    // UX §2.3: 当前 tab 靠整行高亮表达，不再用「当前」文字徽标。
    if (v.isViewCurrentlyActive(view)) row.addClass("bt-manage-tab-row-active");

    // 状态标记降噪：只保留「已隐藏」「预设」文字徽标。当前 tab 靠整行高亮表达；
    // 「默认」「未保存」不在面板列表里展示（信息量低、看着杂），改由 ⋮ 菜单承载。
    const meta = main.createDiv({ cls: "bt-manage-tab-meta" });
    if (view.hidden) {
      meta.createSpan({ cls: "bt-manage-tab-badge", text: tr("savedViews.hiddenBadge") });
    }
    if (view.builtin) {
      meta.createSpan({ cls: "bt-manage-tab-badge bt-manage-tab-badge-preset", text: tr("savedViews.presetBadge") });
    }

    const runRowAction = (handler: () => void | Promise<void>) =>
      Promise.resolve(handler()).then(rerender).catch((error) =>
        new Notice(tr("notice.error", { msg: error instanceof Error ? error.message : String(error) }), 4000),
      );

    // UX §2.3: 点击行 = 切到该 tab 并关闭面板（跳转语义）。单击即关闭，故面板内不再
    // 支持双击重命名（第一击就关了面板，与之冲突）；重命名走行尾 kebab (⋮) 菜单。
    main.addEventListener("click", () => {
      closeSheet();
      v.activateSavedView(view);
    });

    const kebab = row.createEl("button", { cls: "bt-manage-tab-kebab" });
    setIcon(kebab, "more-vertical");
    kebab.setAttr("aria-label", tr("savedViews.more"));
    kebab.addEventListener("click", (e) => {
      e.stopPropagation();
      openManageTabRowMenu(v, e, view, (handler) => { void runRowAction(handler); });
    });
  }
}

/**
 * DESIGN §5.0: per-row kebab menu for the Manage Tabs panel. Collapses the
 * former flat button row (open / edit DSL / rename / copy / set default /
 * hide / restore / delete) into one native Menu. `run` wraps each handler so
 * the panel re-renders after the action.
 */
export function openManageTabRowMenu(
  v: TaskCenterView,
  event: MouseEvent,
  view: QueryPreset,
  run: (handler: () => void | Promise<void>) => void,
): void {
  const menu = new Menu();
  menu.addItem((i) => i.setTitle(tr("savedViews.open")).setIcon("folder-open")
    .onClick(() => run(() => v.activateSavedView(view))));
  menu.addItem((i) => i.setTitle(tr("savedViews.editDsl")).setIcon("code")
    .onClick(() => run(() => { v.activateSavedView(view); v.openQueryControlsSheet({ scope: "tab" }); })));
  menu.addItem((i) => i.setTitle(tr("savedViews.rename")).setIcon("pencil")
    .onClick(() => run(() => renameSavedView(v, view))));
  menu.addItem((i) => i.setTitle(tr("savedViews.copy")).setIcon("copy")
    .onClick(() => run(() => copySavedView(v, view))));
  menu.addItem((i) => i.setTitle(tr("savedViews.setDefault")).setIcon("star")
    .onClick(() => run(() => setDefaultSavedView(v, view.id))));
  menu.addItem((i) => i.setTitle(view.hidden ? tr("savedViews.show") : tr("savedViews.hide"))
    .setIcon(view.hidden ? "eye" : "eye-off")
    .onClick(() => run(() => toggleSavedViewHidden(v, view, !view.hidden))));
  if (view.builtin) {
    menu.addItem((i) => i.setTitle(tr("savedViews.restore")).setIcon("rotate-ccw")
      .onClick(() => run(() => restoreBuiltinSavedView(v, view))));
  }
  // US-109l: delete is available for builtin presets too (tombstoned so they
  // stay gone; recoverable via 「恢复预设」 / 「恢复预设 Tabs」).
  menu.addItem((i) => i.setTitle(tr("savedViews.delete")).setIcon("trash-2")
    .onClick(() => run(() => deleteSavedViewWithConfirm(v, view))));
  menu.showAtMouseEvent(event);
}
