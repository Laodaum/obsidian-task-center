import { App, Modal, TextComponent } from "obsidian";
import { t as tr } from "../i18n";

export class SavedViewNameModal extends Modal {
  private value: string;
  private resolved = false;
  private resolve: (name: string | null) => void;

  constructor(app: App, initialValue: string, resolve: (name: string | null) => void) {
    super(app);
    this.value = initialValue;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("task-center-saved-view-name-modal");
    this.titleEl.setText(tr("savedViews.promptName"));

    const input = new TextComponent(contentEl);
    input.inputEl.dataset.savedViewNameInput = "true";
    input.inputEl.addClass("tc-full-width-input");
    input.setValue(this.value);
    input.onChange((value) => (this.value = value));
    input.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        this.commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });

    const actions = contentEl.createDiv({ cls: "task-center-saved-view-name-actions" });
    const cancel = actions.createEl("button", { text: tr("savedViews.cancel") });
    cancel.dataset.action = "cancel-saved-view-name";
    cancel.addEventListener("click", () => this.close());
    const save = actions.createEl("button", { text: tr("savedViews.confirmSave"), cls: "mod-cta" });
    save.dataset.action = "confirm-saved-view-name";
    save.addEventListener("click", () => this.commit());

    window.setTimeout(() => {
      input.inputEl.focus();
      input.inputEl.select();
    }, 10);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(null);
    }
  }

  private commit(): void {
    const name = this.value.trim();
    if (!name) return;
    this.resolved = true;
    this.resolve(name);
    this.close();
  }
}
