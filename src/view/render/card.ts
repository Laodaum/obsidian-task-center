// 卡片渲染 + 手势/拖拽/嵌套，从 TaskCenterView god class 抽出
// （ARCHITECTURE §7.8 CardRenderPort / §7.14 step8）。收 v: TaskCenterView——
// 渲染卡片 DOM、子卡递归、移动端长按/滑动手势、桌面拖拽嵌套，行为派发到壳的
// 变更引擎（v.toggleDone / v.runWithRemoveAnim / v.scheduleRefresh / v.api …）。
// 导出 renderCard / wireCardEvents（calendar/list 渲染复用）；renderSubcard /
// swipeAction / openSubtreeSheet / statusIcon 为模块内部实现。后续可收窄为
// CardRenderPort + PresentationCtx。

import { Notice, Platform } from "obsidian";
import type { TaskCenterView } from "../../view";
import type { ParsedTask } from "../../types";
import type { EffectiveTask } from "../../task-tree";
import { t as tr } from "../../i18n";
import { todayISO, daysBetween } from "../../dates";
import { formatMinutes } from "../../parser";
import { isMobileMode } from "../../platform";
import { countDescendants } from "../../task-tree";
import { attachCardGestures } from "../touch";
import { BottomSheet } from "../bottom-sheet";
import { compactPath } from "../paths";
import { renderTaskTags } from "./card-bits";
import { openSourceEditShell } from "../source-actions";

function statusIcon(s: string): string {
  if (s === "done") return "✔";
  if (s === "dropped") return "✕";
  if (s === "in_progress") return "◐";
  return "○";
}

export function renderCard(
  v: TaskCenterView,
  parent: HTMLElement,
  t: EffectiveTask,
  contextDate: string | null = null,
): void {
  const card = parent.createDiv({ cls: "bt-card" });
  card.dataset.taskId = t.id;
  if (v.contentEl.dataset.mobileLayout !== "true") card.draggable = true;
  if (v.state.selectedTaskId === t.id) card.addClass("selected");

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
      await v.toggleDone(t);
    })();
  });

  const title = titleRow.createDiv({ cls: "bt-card-title", text: t.title });
  title.title = t.title; // tooltip for long titles
  if (t.effectiveStatus === "done") card.addClass("done");
  // US-153: mark cards that are only still here because they were just
  // completed in this session, so the in-place re-render keeps them and e2e
  // can assert "it lingered". Plain done cards (e.g. in the Completed view)
  // are not flagged.
  if (v.justCompletedIds.has(t.id)) card.dataset.justCompleted = "true";

  renderTaskTags(card, t.tags, "bt-card-tags");

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
  const effectiveTasksForChildren = v.getEffectiveTasks();
  const children = effectiveTasksForChildren.filter((e) => e.renderParentId === t.id);
  if (children.length > 0) {
    const expander = card.createDiv({ cls: "bt-card-children" });
    for (const c of children) renderSubcard(v, expander, c, t.effectiveScheduled);
  }

  wireCardEvents(v, card, t);
  // Mobile gestures still need the pointer controller; source/context
  // editing is now the single-click source shell on every platform.
  if (isMobileMode()) {
    // Unified mobile gesture controller (UX-mobile §13 #6): long-press,
    // scroll cancellation, and swipe share one state machine.
    //   US-506: hold N ms still → openMobileTaskDetailSheet (same grouped
    //           sheet a tap opens; long-press is just a second way in, so
    //           there is no cryptic flat duplicate action menu anymore).
    //   US-507: no mobile drag/drop; movement routes to scroll/swipe.
    //   US-508: swipe ≥ 50% left → done; ≥ 50% right → drop. Visual
    //           feedback appears only after crossing the half-card threshold.
    //   US-510: swipe is opt-out via settings (platform-conditional UI).
    // see USER_STORIES.md
    const settings = v.plugin.settings;
    attachCardGestures(card, {
      longPressMs: settings.mobileLongPressMs,
      moveThresholdPx: 4,
      swipeThresholdRatio: 0.5,
      onLongPress: () => v.openMobileTaskDetailSheet(t),
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
        ? () => { void swipeAction(v, t, "done"); }
        : undefined,
      onSwipeRight: settings.mobileSwipeEnabled
        ? () => { void swipeAction(v, t, "drop"); }
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
async function swipeAction(v: TaskCenterView, t: ParsedTask, kind: "done" | "drop"): Promise<void> {
  try {
    if (kind === "done") {
      const r = await v.api.done(t.id);
      if (!r.unchanged) {
        v.undoStack.push({
          label: "swipe done",
          ops: [{ path: t.path, line: t.line, before: [r.before], after: [r.after] }],
        });
      }
    } else {
      const r = await v.api.drop(t.id);
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
        v.undoStack.push({ label: "swipe drop", ops });
      }
    }
    new Notice(kind === "done" ? "✓ Done" : tr("trash.dropped"), 1000);
  } catch (err) {
    new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
  }
  v.scheduleRefresh();
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
function renderSubcard(
  v: TaskCenterView,
  container: HTMLElement,
  c: EffectiveTask,
  effectiveScheduled: string | null,
): void {
  const subCard = container.createDiv({ cls: "bt-subcard" });
  subCard.dataset.taskId = c.id;
  if (v.contentEl.dataset.mobileLayout !== "true") subCard.draggable = true;
  if (v.state.selectedTaskId === c.id) subCard.addClass("selected");

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
        if (c.effectiveStatus === "done") await v.api.undone(c.id);
        else await v.api.done(c.id);
        v.scheduleRefresh();
      } catch (err) {
        new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
        v.scheduleRefresh();
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
  wireCardEvents(v, subCard, c, { acceptNestDrop: false });

  // Grandchildren — use the EffectiveTask tree's renderParentId to
  // determine which grandchildren render inline.
  const effectiveTasksForGrand = v.getEffectiveTasks();
  const grand = effectiveTasksForGrand.filter((e) => e.renderParentId === c.id);
  if (grand.length > 0) {
    if (Platform.isMobile) {
      // US-505: mobile collapses to 1 level.
      const total = countDescendants(c, v._taskIndex);
      const more = subCard.createDiv({ cls: "bt-subcard-more" });
      more.setText(`+${total}`);
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        openSubtreeSheet(v, c);
      });
    } else {
      const inheritedDown = c.effectiveScheduled ?? effectiveScheduled;
      const sub = container.createDiv({ cls: "bt-card-children" });
      for (const g of grand) renderSubcard(v, sub, g, inheritedDown);
    }
  }
}

/**
 * Mobile-only: open a bottom-sheet preview of a subtree. Each descendant
 * renders as one row, indented by depth. Used by the `+N` chip on
 * subcards (US-505 second sentence — visual collapse to 1 level, full
 * tree available on demand).
 */
function openSubtreeSheet(v: TaskCenterView, root: ParsedTask): void {
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
      const child = v._taskIndex.get(`${parent.path}:L${line + 1}`);
      if (!child) continue;
      rows.push({ task: child, depth });
      walk(child, depth + 1);
    }
  };
  walk(root, 0);

  const sheet = new BottomSheet(v.app, {
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
          v.state.selectedTaskId = task.id;
          v.render();
        });
      }
    },
  });
  sheet.open();
}

export function wireCardEvents(
  v: TaskCenterView,
  el: HTMLElement,
  t: EffectiveTask,
  opts: { acceptNestDrop?: boolean } = {},
): void {
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
    v.contentEl.addClass("dragging-active");
  });
  el.addEventListener("dragend", (e) => {
    e.stopPropagation();
    el.removeClass("dragging");
    v.contentEl.removeClass("dragging-active");
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
        const droppedTask = v.tasks.find((x) => x.id === droppedId);
        const awaitCachePaths = [t.path];
        if (droppedTask && droppedTask.path !== t.path) awaitCachePaths.push(droppedTask.path);
        try {
          await v.runWithRemoveAnim(droppedId, async () => {
            const r = await v.api.nest(droppedId, t.id);
            if (!r.unchanged) {
              if (r.undoOps && r.undoOps.length > 0) {
                v.undoStack.push({
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
          v.scheduleRefresh();
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
    if (v.contentEl.dataset.mobileLayout === "true") {
      v.openMobileTaskDetailSheet(t);
    } else {
      void openSourceEditShell(v, t);
    }
  });

  // Right-click context menu
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    v.openContextMenu(e, t);
  });
}
