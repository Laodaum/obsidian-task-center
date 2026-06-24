import { App, Modal } from "obsidian";
import { t as tr, getLocale } from "../i18n";
import { parseQueryDsl } from "../saved-views";

export type QueryDslSubmitMode = "update" | "saveAs";

// User-facing Query DSL reference, one file per language so each locale lands on
// its own page. See docs/dsl/{zh,en}.md (TS schema stays in ARCHITECTURE.md §1.3).
const DSL_DOCS_URL_BY_LOCALE: Record<string, string> = {
  zh: "https://github.com/CorrectRoadH/obsidian-task-center/blob/main/docs/dsl/zh.md",
  en: "https://github.com/CorrectRoadH/obsidian-task-center/blob/main/docs/dsl/en.md",
};
const dslDocsUrl = (): string => DSL_DOCS_URL_BY_LOCALE[getLocale()] ?? DSL_DOCS_URL_BY_LOCALE.en;

interface DslValidation {
  ok: boolean;
  message: string;
}

export class QueryDslModal extends Modal {
  private value: string;
  private readonly hasExisting: boolean;
  private readonly onSubmit: (mode: QueryDslSubmitMode, text: string) => Promise<void>;
  private statusEl: HTMLElement | null = null;
  private saveButtons: HTMLButtonElement[] = [];

  constructor(
    app: App,
    initialValue: string,
    hasExisting: boolean,
    onSubmit: (mode: QueryDslSubmitMode, text: string) => Promise<void>,
  ) {
    super(app);
    this.value = initialValue;
    this.hasExisting = hasExisting;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("task-center-modal");
    contentEl.empty();
    contentEl.addClass("task-center-query-dsl-modal");

    this.titleEl.setText(tr("savedViews.dslTitle"));
    const docs = this.titleEl.createEl("a", {
      text: tr("savedViews.dslDocs"),
      cls: "tc-dsl-docs",
      href: dslDocsUrl(),
    });
    docs.setAttr("target", "_blank");
    docs.setAttr("rel", "noopener");

    contentEl.createEl("p", { text: tr("savedViews.dslHelp"), cls: "setting-item-description" });

    const textarea = contentEl.createEl("textarea", { cls: "tc-full-width-input" });
    textarea.rows = 18;
    textarea.value = this.value;
    textarea.dataset.queryDslInput = "true";
    textarea.addEventListener("input", () => {
      this.value = textarea.value;
      this.revalidate();
    });
    textarea.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        void this.commit(this.hasExisting ? "update" : "saveAs");
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });

    // Live validation status (also surfaces submit errors).
    this.statusEl = contentEl.createDiv({ cls: "tc-dsl-status" });
    this.statusEl.dataset.dslStatus = "true";

    const actions = contentEl.createDiv({ cls: "task-center-saved-view-name-actions" });
    const cancel = actions.createEl("button", { text: tr("savedViews.cancel") });
    cancel.addEventListener("click", () => this.close());
    this.saveButtons = [];
    if (this.hasExisting) {
      const update = actions.createEl("button", { text: tr("savedViews.update"), cls: "mod-cta" });
      update.dataset.action = "update-current-view-dsl";
      update.addEventListener("click", () => void this.commit("update"));
      this.saveButtons.push(update);
    }
    const saveAs = actions.createEl("button", {
      text: tr("savedViews.save"),
      cls: this.hasExisting ? "" : "mod-cta",
    });
    saveAs.dataset.action = "save-current-view-dsl";
    saveAs.addEventListener("click", () => void this.commit("saveAs"));
    this.saveButtons.push(saveAs);

    this.revalidate();

    window.setTimeout(() => {
      textarea.focus();
      textarea.select();
    }, 10);
  }

  // Validate against the exact same path as save (parseQueryDsl), so live
  // feedback matches what writing would actually do.
  private validate(text: string): DslValidation {
    try {
      parseQueryDsl(text);
      return { ok: true, message: "" };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private revalidate(): void {
    const result = this.validate(this.value);
    if (this.statusEl) {
      this.statusEl.setText(result.ok ? `✓ ${tr("savedViews.dslValid")}` : `✗ ${result.message}`);
      this.statusEl.toggleClass("is-valid", result.ok);
      this.statusEl.toggleClass("is-invalid", !result.ok);
    }
    for (const button of this.saveButtons) {
      button.disabled = !result.ok;
      button.toggleClass("is-disabled", !result.ok);
    }
  }

  private async commit(mode: QueryDslSubmitMode): Promise<void> {
    // Block save when invalid (also guards the Cmd/Ctrl+Enter shortcut).
    const result = this.validate(this.value);
    if (!result.ok) {
      this.revalidate();
      return;
    }
    try {
      await this.onSubmit(mode, this.value);
      this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.statusEl) {
        this.statusEl.setText(`✗ ${message}`);
        this.statusEl.toggleClass("is-valid", false);
        this.statusEl.toggleClass("is-invalid", true);
      }
    }
  }
}
