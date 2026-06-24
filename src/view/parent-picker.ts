// 父任务选择器（BottomSheet）：从 TaskCenterView god class 抽出
// （ARCHITECTURE §7.10 TaskActionsPort / §7.14 step7）。收 v: TaskCenterView——
// 读 task index / 有效任务 / 已渲染可见集，弹出 sheet 让用户挑一个合法父任务，
// resolve 选中 id 或 null（取消）。纯交互、无持久化；后续可收窄为 TaskActionsPort。

import type { TaskCenterView } from "../view";
import type { EffectiveTask } from "../task-tree";
import type { ParsedTask } from "../types";
import { t as tr } from "../i18n";
import { taskDisplayTags } from "../tags";
import { BottomSheet } from "./bottom-sheet";
import { compactPath } from "./paths";

export function openParentPickerForTask(v: TaskCenterView, t: EffectiveTask): Promise<string | null> {
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
        const child = v._taskIndex.get(`${task.path}:L${line + 1}`);
        if (!child || descendantIds.has(child.id)) continue;
        descendantIds.add(child.id);
        collectDescendants(child);
      }
    };
    const rootTask = v._taskIndex.get(t.id) ?? t;
    collectDescendants(rootTask);

    const effectiveById = new Map(v.getEffectiveTasks().map((task) => [task.id, task]));
    const visibleIds = new Set(
      Array.from(v.contentEl.querySelectorAll<HTMLElement>("[data-task-id]"))
        .map((el) => el.dataset.taskId)
        .filter((id): id is string => !!id),
    );
    const eligibleTasks = v.getEffectiveTasks()
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

    const pickerSheet = new BottomSheet(v.app, {
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
