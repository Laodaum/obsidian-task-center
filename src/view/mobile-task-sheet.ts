import { App } from "obsidian";
import { BottomSheet } from "./bottom-sheet";
import { t as tr } from "../i18n";
import { todayISO, fromISO, addDays, shiftMonth, startOfWeek, startOfMonth, pad } from "../dates";
import { WEEKDAY_KEYS } from "../weekday";

/**
 * Mobile task sheets — the pure-UI half of the touch interaction layer.
 *
 * These are deliberately decoupled from `TaskCenterView`: each opens a
 * BottomSheet, collects a choice, and resolves a plain value. They never call
 * the writer/api or refresh — the view orchestrates the mutation after the
 * promise settles. That keeps the picker logic testable and lets desktop and
 * mobile share the same value-producing contract (ARCHITECTURE.md §"纯逻辑 vs
 * 视图适配").
 */

export type TagEditResult = {
  add: string[];
  remove: string[];
};

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

function dateCalendarMonthLabel(anchorISO: string): string {
  const d = fromISO(anchorISO);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/**
 * Mobile date picker: no typed YYYY-MM-DD input. The quick row is intentionally
 * just 今天 / 明天 (the two high-frequency choices); every other date comes from
 * the touch calendar below — the old +2…+6 weekday chips just duplicated the
 * first calendar row and made the sheet noisy (UX-mobile §8.2). Persistence
 * still writes ISO dates. Resolves the chosen ISO, or null on cancel.
 */
export function openMobileDatePicker(
  app: App,
  opts: { initialISO?: string; weekStartsOn: 0 | 1 } = { weekStartsOn: 0 },
): Promise<string | null> {
  const initialISO = opts.initialISO ?? todayISO();
  const weekStart = opts.weekStartsOn;
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
      const today = todayISO();
      const quick = body.createDiv({ cls: "bt-mobile-date-quick" });
      const quickDates: Array<{ iso: string; label: string }> = [
        { iso: today, label: tr("savedViews.dateToday") },
        { iso: addDays(today, 1), label: tr("savedViews.dateTomorrow") },
      ];
      for (const { iso, label } of quickDates) {
        const btn = quick.createEl("button", { cls: "bt-mobile-date-quick-btn", text: label });
        btn.dataset.dateChoice = iso;
        if (iso === initialISO) btn.addClass("active");
        btn.addEventListener("click", () => finish(iso));
      }

      const calendar = body.createDiv({ cls: "bt-mobile-date-calendar" });
      const nav = calendar.createDiv({ cls: "bt-mobile-date-calendar-nav" });
      const prev = nav.createEl("button", { text: "‹", cls: "bt-date-month-nav" });
      nav.createSpan({ text: dateCalendarMonthLabel(anchor), cls: "bt-date-month-label" });
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

    sheet = new BottomSheet(app, {
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

/**
 * Mobile tag management sheet. It edits the tag set as a diff (add / remove)
 * and lets writer.ts keep the Markdown mutation byte-local to the task line.
 * `initialTags` is the task's current display tags; `suggestions` is the
 * already-deduped pool of other tags the view offers as one-tap adds.
 * Resolves the diff, or null on cancel.
 */
export function openMobileTagEditor(
  app: App,
  opts: { initialTags: string[]; suggestions: string[] },
): Promise<TagEditResult | null> {
  return new Promise((resolve) => {
    const initialSet = new Set(opts.initialTags);
    const current = new Set(opts.initialTags);
    const suggestions = opts.suggestions;
    let sheet: BottomSheet | null = null;
    let settled = false;
    const finish = (result: TagEditResult | null) => {
      if (settled) return;
      settled = true;
      sheet?.close();
      resolve(result);
    };

    sheet = new BottomSheet(app, {
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
