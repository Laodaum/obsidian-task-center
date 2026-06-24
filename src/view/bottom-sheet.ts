// Mobile bottom-sheet primitive.
//
// UX-mobile.md uses bottom sheets for long-press actions, task details,
// Quick Add, and tap-only date picking. Month day selection is rendered
// inline in the view, not with this primitive.
//
// Implementation notes:
//   - Uses Obsidian's `Modal` for backdrop / open / close lifecycle, then
//     restyles the modal element to anchor at the bottom (CSS in
//     `task-center-bottom-sheet` block in styles.css).
//   - `Modal.contentEl` is where consumers should append rows. The shell
//     adds the title and (optional) handle bar; otherwise leaves layout
//     to the consumer.
//   - Backdrop tap and Escape close the sheet via the inherited Modal
//     behavior.

import { App, Modal, Platform } from "obsidian";

export interface BottomSheetOptions {
  /** Heading rendered at the top of the sheet. */
  title: string;
  /** Optional semantic class for layout variants. */
  sheetClass?: string;
  /**
   * Called once on open, after the title is in the DOM. Append your rows
   * to `contentEl`. Anything you wire here is torn down when the user
   * dismisses the sheet.
   */
  populate: (contentEl: HTMLElement) => void;
  /** Optional close hook, useful for promise-based pickers. */
  onClose?: () => void;
}

export class BottomSheet extends Modal {
  constructor(app: App, private readonly opts: BottomSheetOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("task-center-bottom-sheet");
    if (this.opts.sheetClass) modalEl.addClass(this.opts.sheetClass);
    if (Platform.isMobile) modalEl.addClass("task-center-obsidian-mobile-sheet");
    contentEl.empty();
    contentEl.addClass("bt-sheet-content");

    if (Platform.isMobile) {
      const handle = contentEl.createDiv({ cls: "bt-sheet-handle" });
      handle.setAttr("aria-hidden", "true");
    }

    contentEl.createEl("h3", { cls: "bt-sheet-title", text: this.opts.title });

    this.opts.populate(contentEl);
  }

  onClose(): void {
    this.opts.onClose?.();
  }
}
