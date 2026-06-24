// 顶部查询工具条渲染，从 TaskCenterView god class 抽出（ARCHITECTURE §7.14
// step10 之二）。收 v: TaskCenterView——桌面收成单行（当前 query 动作 + 添加），
// 移动端两行（日期导航 + 编辑 Query 入口）。当前 query 动作复用壳仍 public 的
// renderSavedViewsActionControls；范围导航走壳 renderRangeNav。

import type { TaskCenterView } from "../view";
import { t as tr } from "../i18n";
import { openQuickAdd } from "./source-actions";

export function renderToolbar(v: TaskCenterView, parent: HTMLElement): void {
  const bar = parent.createDiv({ cls: "bt-toolbar" });
  const mainRow = bar.createDiv({ cls: "bt-toolbar-row bt-toolbar-main" });
  const mobileLayout = v.contentEl.dataset.mobileLayout === "true";
  // §3.0: with the date nav lowered into the week / month component, the
  // desktop toolbar collapses to a single row — search + filter chips live
  // together in mainRow instead of a separate sub-row.
  const subRow = mainRow;

  // Mobile keeps the date nav in the toolbar (§6.2 two-row rule). On desktop
  // it is owned by the week / month component itself (§3.0).
  if (mobileLayout) {
    v.renderRangeNav(mainRow);
  }

  // US-109w/US-109z: the global filter (search box + tag/schedule/time/status
  // chips) is gone from the toolbar — filtering belongs to each list/grid area
  // (renderAreaFilter). The shared base `preset.filters` is still applied
  // programmatically and editable via the Query editor, not via a global chip.

  if (mobileLayout) {
    const mobileFilters = mainRow.createEl("button", {
      text: tr("savedViews.editQuery"),
      cls: "bt-mobile-filter-btn",
    });
    mobileFilters.dataset.mobileAction = "filters";
    mobileFilters.addEventListener("click", () => v.openQueryControlsSheet());
  } else {
    renderSavedViewsToolbar(v, subRow);
  }

  const utility = mainRow.createDiv({ cls: "bt-toolbar-utility" });

  // US-163: toolbar `+` opens Quick Add, which writes the new line to
  // today's daily-note tail (the only entry point — see writer.addTask
  // resolution order). Default scheduled = unset; user adds ⏳ inline
  // via Quick Add tokens or schedules later via drag.
  // see USER_STORIES.md
  const add = utility.createEl("button", { text: tr("toolbar.add") });
  add.addClass("bt-add-btn");
  add.addEventListener("click", () => openQuickAdd(v));
  // Settings moved out of the query toolbar to the Tab Strip gear (DESIGN §5.0).
}

function renderSavedViewsToolbar(v: TaskCenterView, parent: HTMLElement, rerenderControls?: () => void): void {
  const wrap = parent.createDiv({ cls: "bt-saved-views" });
  wrap.dataset.savedViews = "true";

  const actions = wrap.createDiv({ cls: "bt-saved-view-actions" });

  // US-109z: no global filter chips in the toolbar anymore — only current-query
  // actions. Filter controls live per-area (renderAreaFilter) and in the Query
  // editor / mobile sheet (which still call renderSavedViewsFilterControls for
  // the shared base `preset.filters`).
  // DESIGN §5.0: query toolbar only carries current-query actions. Tab
  // management lives on the Tab Strip; settings is app chrome (gear there).
  v.renderSavedViewsActionControls(actions, rerenderControls, {
    includeSaveAs: true,
    contextualSaveAs: true,
    includeDsl: true,
    includeManage: false,
  });
}
