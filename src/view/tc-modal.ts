import { App, Modal } from "obsidian";

/**
 * Shared base for all Task Center modals (non-bottom-sheet).
 *
 * Centralises the `task-center-modal` class on modalEl so that any future
 * mobile height constraint or visual tweak applies to every modal at once,
 * without needing to touch each subclass.
 *
 * Usage: extend this class, implement `modalContentClass` and `populate()`.
 */
export abstract class TcBaseModal extends Modal {
  /** CSS class added to contentEl to scope subclass styles. */
  protected abstract readonly modalContentClass: string;

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("task-center-modal");
    this.contentEl.empty();
    this.contentEl.addClass(this.modalContentClass);
    this.populate();
  }

  /** Subclasses fill in their content here (called from onOpen). */
  protected abstract populate(): void;
}
