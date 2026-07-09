// QueryTab (saved-view) CRUD orchestration, extracted from the TaskCenterView
// god class (ARCHITECTURE §7.8). Each verb reads the tab list, calls a pure
// saved-views.ts helper, writes the list back, drops the draft, re-applies, and
// persists+rerenders. Takes `v: TaskCenterView` (the shell owns state/persist/
// render); a later pass can narrow this to SavedViewMutationPort.

import { Notice } from "obsidian";
import type { TaskCenterView } from "../view";
import type { QueryPreset } from "../types";
import { t as tr } from "../i18n";
import { BottomSheet } from "./bottom-sheet";
import { SavedViewNameModal } from "./saved-view-name-modal";
import {
  builtinSavedViewId,
  computeDeleteQueryPresetState,
  computeUndoQueryPresetState,
  createSavedViewId,
  deleteQueryPresetById,
  duplicateQueryPreset,
  executeDeleteQueryPresetFlow,
  type QueryPresetDeleteFlowCallbacks,
  moveQueryPresetById,
  normalizeQueryPreset,
  renameQueryPresetById,
  reorderQueryPresetById,
  restoreBuiltinQueryPresetById,
  restoreBuiltinQueryPresets,
  setQueryPresetHiddenById,
  suggestQueryPresetName,
  upsertQueryPreset,
} from "../saved-views";

export function suggestSavedViewName(v: TaskCenterView): string {
  return suggestQueryPresetName(
    { tags: v.state.savedViewTag, status: v.state.savedViewStatus },
    tr("savedViews.defaultName"),
  );
}

export function askSavedViewName(v: TaskCenterView, initialName = suggestSavedViewName(v)): Promise<string | null> {
  return new Promise((resolve) => {
    new SavedViewNameModal(v.app, initialName, resolve).open();
  });
}

export async function saveCurrentView(v: TaskCenterView, name: string): Promise<void> {
  const active = v.activeSavedView();
  const view = normalizeQueryPreset({
    ...v.currentQuerySnapshot(active, name),
    id: createSavedViewId(),
    builtin: false,
    hidden: false,
  });
  v.plugin.settings.queryPresets = upsertQueryPreset(v.plugin.settings.queryPresets, view);
  v.tabDrafts.delete(view.id);
  v.applySavedView(view);
  await v.plugin.saveSettings();
}

export async function createSavedViewFromCurrent(v: TaskCenterView): Promise<void> {
  const active = v.activeSavedView();
  const suggestedName = active.builtin ? suggestSavedViewName(v) : `${active.name} Copy`;
  const name = await askSavedViewName(v, suggestedName);
  if (!name?.trim()) return;
  await saveCurrentView(v, name.trim());
}

export async function copySavedView(v: TaskCenterView, view: QueryPreset): Promise<void> {
  const name = await askSavedViewName(v, `${view.name} Copy`);
  if (!name?.trim()) return;
  const copied = duplicateQueryPreset(v.plugin.settings.queryPresets, view.id, name.trim(), createSavedViewId);
  v.plugin.settings.queryPresets = upsertQueryPreset(v.plugin.settings.queryPresets, copied);
  v.tabDrafts.delete(copied.id);
  v.applySavedView(copied);
  await v.plugin.saveSettings();
  v.render();
}

export async function setDefaultSavedView(v: TaskCenterView, id: string): Promise<void> {
  const view = v.plugin.settings.queryPresets.find((item) => item.id === id);
  if (!view) return;
  if (view.hidden) {
    throw new Error("不能把已隐藏的 Tab 设为默认。");
  }
  v.plugin.settings.defaultSavedViewId = id;
  await v.plugin.saveSettings();
  v.render();
}

export async function moveSavedView(v: TaskCenterView, view: QueryPreset, direction: -1 | 1): Promise<void> {
  v.plugin.settings.queryPresets = moveQueryPresetById(v.plugin.settings.queryPresets, view.id, direction);
  await v.plugin.saveSettings();
  v.render();
}

export async function reorderQueryTab(v: TaskCenterView, id: string, targetIndex: number): Promise<void> {
  v.plugin.settings.queryPresets = reorderQueryPresetById(v.plugin.settings.queryPresets, id, targetIndex);
  await v.plugin.saveSettings();
  v.render();
}

export async function renameSavedView(v: TaskCenterView, view: QueryPreset): Promise<void> {
  const name = await askSavedViewName(v, view.name);
  if (!name?.trim()) return;
  v.plugin.settings.queryPresets = renameQueryPresetById(v.plugin.settings.queryPresets, view.id, name.trim());
  const renamed = v.plugin.settings.queryPresets.find((item) => item.id === view.id);
  if (renamed) v.applySavedView(renamed);
  await v.plugin.saveSettings();
  v.render();
}

export async function toggleSavedViewHidden(v: TaskCenterView, view: QueryPreset, hidden: boolean): Promise<void> {
  const visible = v.visibleQueryTabs();
  if (hidden && visible.length <= 1 && visible[0]?.id === view.id) {
    throw new Error("至少保留一个可见 Tab。");
  }
  v.plugin.settings.queryPresets = setQueryPresetHiddenById(v.plugin.settings.queryPresets, view.id, hidden);
  if (hidden) v.tabDrafts.delete(view.id);
  if (hidden && v.plugin.settings.defaultSavedViewId === view.id) {
    v.plugin.settings.defaultSavedViewId = v.visibleQueryTabs().find((item) => item.id !== view.id)?.id ?? null;
  }
  if (hidden && v.state.savedViewId === view.id) {
    const next = v.visibleQueryTabs().find((item) => item.id !== view.id);
    if (next) v.applySavedView(next);
  }
  await v.plugin.saveSettings();
  v.render();
}

export async function deleteSavedView(v: TaskCenterView, view: QueryPreset): Promise<void> {
  const visible = v.visibleQueryTabs();
  if (visible.length <= 1 && visible[0]?.id === view.id) {
    throw new Error("至少保留一个可见 Tab。");
  }
  v.plugin.settings.queryPresets = deleteQueryPresetById(v.plugin.settings.queryPresets, view.id);
  v.tabDrafts.delete(view.id);
  if (v.plugin.settings.defaultSavedViewId === view.id) {
    v.plugin.settings.defaultSavedViewId = v.visibleQueryTabs()[0]?.id ?? null;
  }
  if (v.state.savedViewId === view.id) {
    const next = v.visibleQueryTabs()[0];
    if (next) v.applySavedView(next);
  }
  await v.plugin.saveSettings();
  v.render();
}

/**
 * VAL-GUI-004: delete a custom tab with confirmation + toast undo. Delegates to
 * the pure `executeDeleteQueryPresetFlow` so the confirm/delete/undo logic stays
 * unit-testable without DOM.
 */
export async function deleteSavedViewWithConfirm(v: TaskCenterView, view: QueryPreset): Promise<void> {
  const visible = v.visibleQueryTabs();
  if (visible.length <= 1 && visible[0]?.id === view.id) {
    new Notice(tr("notice.error", { msg: "至少保留一个可见 Tab。" }), 4000);
    return;
  }

  const flowCallbacks: QueryPresetDeleteFlowCallbacks = {
    confirm: async (viewName: string) => {
      const confirmed = await new Promise<boolean>((resolve) => {
        const modal = new BottomSheet(v.app, {
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
      const undoBtn = notice.messageEl.createSpan({ text: `  ${undoLabel}`, cls: "bt-notice-undo" });
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
    v.plugin.settings.queryPresets,
    view,
    v.plugin.settings.defaultSavedViewId,
    v.state.savedViewId,
    flowCallbacks,
  );
  if (!result.confirmed) return;

  const deleteState = computeDeleteQueryPresetState({ result, visibleTabs: visible, view });
  v.plugin.settings.queryPresets = deleteState.presetsAfter;
  v.tabDrafts.delete(view.id);
  // US-109l: tombstone a deleted builtin so it is not re-seeded on next load.
  if (view.builtin && !v.plugin.settings.deletedBuiltinIds.includes(view.id)) {
    v.plugin.settings.deletedBuiltinIds = [...v.plugin.settings.deletedBuiltinIds, view.id];
  }
  if (deleteState.newDefaultId !== null) {
    v.plugin.settings.defaultSavedViewId = deleteState.newDefaultId;
  }
  if (deleteState.shouldSwitchActive && deleteState.nextActiveView) {
    v.applySavedView(deleteState.nextActiveView);
  }
  await v.plugin.saveSettings();
  v.render();

  result.undoNotice?.onUndoClick(async () => {
    result.undoNotice?.close();
    const undoState = computeUndoQueryPresetState({
      presets: v.plugin.settings.queryPresets,
      undoPlan: result.undoPlan!,
      wasDefault: result.wasDefault,
      wasActive: result.wasActive,
    });
    v.plugin.settings.queryPresets = undoState.presetsRestored;
    v.tabDrafts.delete(result.undoPlan!.snapshot.id);
    // US-109l: undoing a builtin delete lifts its tombstone.
    if (view.builtin) {
      v.plugin.settings.deletedBuiltinIds = v.plugin.settings.deletedBuiltinIds.filter((id) => id !== view.id);
    }
    if (undoState.restoredDefaultId !== null) {
      v.plugin.settings.defaultSavedViewId = undoState.restoredDefaultId;
    }
    if (undoState.shouldRestoreActive && undoState.restoredView) {
      v.applySavedView(undoState.restoredView);
    }
    await v.plugin.saveSettings();
    v.render();
    new Notice(tr("notice.undoRestored", { name: result.undoPlan!.snapshot.name }), 3000);
  });
}

export async function restoreBuiltinSavedView(v: TaskCenterView, view: QueryPreset): Promise<void> {
  v.plugin.settings.queryPresets = restoreBuiltinQueryPresetById(
    v.plugin.settings.queryPresets,
    view.id,
    v.savedViewLabels(),
    v.plugin.settings.deletedBuiltinIds,
  );
  // US-109l: restoring a builtin (incl. a previously-deleted one) lifts its tombstone.
  v.plugin.settings.deletedBuiltinIds = v.plugin.settings.deletedBuiltinIds.filter((id) => id !== view.id);
  v.tabDrafts.delete(view.id);
  const restored = v.plugin.settings.queryPresets.find((item) => item.id === view.id);
  if (restored && v.state.savedViewId === view.id) {
    v.applySavedView(restored);
  }
  await v.plugin.saveSettings();
  v.render();
}

export async function restoreAllBuiltinSavedViews(v: TaskCenterView): Promise<void> {
  v.plugin.settings.queryPresets = restoreBuiltinQueryPresets(v.plugin.settings.queryPresets, v.savedViewLabels());
  for (const id of [
    builtinSavedViewId("today"),
    builtinSavedViewId("week"),
    builtinSavedViewId("month"),
    builtinSavedViewId("completed"),
    builtinSavedViewId("unscheduled"),
  ]) {
    v.tabDrafts.delete(id);
  }
  const active = v.plugin.settings.queryPresets.find((item) => item.id === v.state.savedViewId);
  if (active) {
    v.applySavedView(active);
  }
  await v.plugin.saveSettings();
  v.render();
}
