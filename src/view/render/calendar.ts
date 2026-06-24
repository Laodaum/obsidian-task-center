// 周/月日历渲染（桌面 + 移动分叉），从 TaskCenterView god class 抽出
// （ARCHITECTURE §7.7 CalendarRenderPort / §7.14 step9）。收 v: TaskCenterView——
// 网格数学走纯函数 calendar-grid，卡片走 card.ts，区域头/导航/空态/drop zone 仍
// 复用壳的渲染 helper（renderAreaHead / renderRangeNav / makeDropZone …）。
// 导出 renderWeek / renderMonth（area projector 调）；renderMobileMonthDayPanel
// 为模块内部。后续可收窄为 CalendarRenderPort + PresentationCtx。

import type { TaskCenterView } from "../../view";
import type { EffectiveTask } from "../../task-tree";
import type { WeekAreaConfig, MonthAreaConfig } from "../../types";
import { t as tr } from "../../i18n";
import { todayISO, fromISO, addDays, daysBetween, pad } from "../../dates";
import { weekdayLabel } from "../../weekday";
import { recomputeTopLevelInQuery } from "../../task-tree";
import { columnStats, buildWeekDays, buildMonthGrid } from "./calendar-grid";
import { renderCard, wireCardEvents } from "./card";

export function renderWeek(
  v: TaskCenterView,
  parent: HTMLElement,
  area: WeekAreaConfig,
  areaIndex: number,
): void {
  // US-109p9: shared area head (title + 日期导航 + 编辑 entry) — one row, same
  // component as list/grid. §3.0: desktop owns the range nav inside this head;
  // mobile keeps the nav in the toolbar's first row (§6.2), so head has none.
  const rawTitle = v.localizeBuiltinTitle(area.id, area.title);
  const desktop = v.contentEl.dataset.mobileLayout !== "true";
  v.renderAreaHead(parent, areaIndex, area, {
    title: rawTitle,
    renderNav: desktop ? (host) => v.renderRangeNav(host) : undefined,
  });
  const today = todayISO();
  const days = buildWeekDays(v.state.anchorISO, v.plugin.settings.weekStartsOn);

  const filter = v.getTextFilter();
  const effectiveTasks = v.scopeTasksToArea(v.getEffectiveTasks(), area.when);

  if (v.hasActiveFilters()) {
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
    if (unfilteredCount > 0 && filteredCount === 0) v.renderFilterEmptyState(parent);
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
    const isExpanded = v.state.expandedDays.has(day);
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
        if (v.state.expandedDays.has(day)) v.state.expandedDays.delete(day);
        else v.state.expandedDays.add(day);
        v.render();
      });
    }
    const d = fromISO(day);
    head.createSpan({
      text: weekdayLabel(d.getDay()),
      cls: "bt-week-dow",
    });
    head.createSpan({ text: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, cls: "bt-week-date" });
    const stats = head.createSpan({
      text: columnStats(dayTasksRecomputed),
      cls: "bt-week-stats",
    });
    stats.title = "Scheduled estimate (hours)";

    const list = col.createDiv({ cls: "bt-week-list" });
    // Drop handler on the COLUMN (which carries `data-date`), not the
    // inner list. The column is the published e2e drop target; if the
    // handler lives on a child the synthesized drop event from
    // `simulateDrag()` never reaches it.
    v.makeDropZone(col, day);
    for (const t of topLevel) {
      renderCard(v, list, t, day);
    }
  }
}

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
export function renderMonth(
  v: TaskCenterView,
  parent: HTMLElement,
  area: MonthAreaConfig,
  areaIndex: number,
): void {
  // US-109p9: shared area head (title + 日期导航 + 编辑 entry) — one row.
  const rawTitle = v.localizeBuiltinTitle(area.id, area.title);
  const desktop = v.contentEl.dataset.mobileLayout !== "true";
  v.renderAreaHead(parent, areaIndex, area, {
    title: rawTitle,
    renderNav: desktop ? (host) => v.renderRangeNav(host) : undefined,
  });
  const today = todayISO();
  const { first, last, gridStart, gridDays } = buildMonthGrid(
    v.state.anchorISO,
    v.plugin.settings.weekStartsOn,
  );

  const wrapper = parent.createDiv({ cls: "bt-month" });
  wrapper.dataset.view = "month";
  // DOW header
  const header = wrapper.createDiv({ cls: "bt-month-header" });
  for (let i = 0; i < 7; i++) {
    const d = fromISO(addDays(gridStart, i));
    header.createDiv({ text: weekdayLabel(d.getDay()), cls: "bt-month-dow" });
  }

  const effectiveTasks = v.scopeTasksToArea(v.getEffectiveTasks(), area.when);
  const filter = v.getTextFilter();
  if (v.hasActiveFilters()) {
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
    if (unfilteredCount > 0 && filteredCount === 0) v.renderFilterEmptyState(wrapper);
  }

  const grid = wrapper.createDiv({ cls: "bt-month-grid" });
  const isMobileLayout = v.contentEl.dataset.mobileLayout === "true";
  let selectedDay = v.state.selectedMonthDay;
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
    v.makeDropZone(cell, day);
    for (const t of dayTasks.slice(0, 6)) {
      const chip = list.createDiv({ cls: "bt-mini-card" });
      chip.dataset.taskId = t.id;
      chip.dataset.taskStatus = t.effectiveStatus;
      chip.addClass(`bt-mini-card-${t.effectiveStatus}`);
      if (v.contentEl.dataset.mobileLayout !== "true") chip.draggable = true;
      chip.setText(t.title);
      if (t.effectiveDeadline && t.effectiveStatus === "todo") {
        const deadlineDays = daysBetween(today, t.effectiveDeadline);
        if (deadlineDays < 0) chip.addClass("overdue");
        else if (deadlineDays <= 3) chip.addClass("near-deadline");
      }
      wireCardEvents(v, chip, t);
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
      if (v.contentEl.dataset.mobileLayout !== "true") return;
      // Don't fire when the click bubbled from a chip — that's a select
      // intent, not "open the day".
      if ((e.target as HTMLElement).closest(".bt-mini-card")) return;
      v.state.selectedMonthDay = day;
      v.state.selectedTaskId = null;
      v.render();
    });
  }
  if (isMobileLayout) {
    renderMobileMonthDayPanel(v, wrapper, selectedDay, selectedDayTasks);
  }
}

function renderMobileMonthDayPanel(
  v: TaskCenterView,
  parent: HTMLElement,
  day: string,
  dayTasks: EffectiveTask[],
): void {
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
    text: columnStats(dayTasks),
  });

  const list = panel.createDiv({ cls: "bt-month-day-panel-list" });
  if (dayTasks.length === 0) {
    list.createDiv({ cls: "bt-month-day-empty", text: tr("sheet.empty") });
    return;
  }
  for (const t of dayTasks) renderCard(v, list, t, day);
}
