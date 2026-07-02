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
//     behavior; on mobile the handle also supports swipe-down-to-dismiss
//     (UX-mobile §8.1) and the sheet lifts above the soft keyboard.

import { App, Modal, Platform } from "obsidian";

/**
 * UX-mobile §13 #5 / US-509: when the soft keyboard pops up, the visual
 * viewport shrinks — measure the offset between the layout viewport
 * (`window.innerHeight`) and `visualViewport.height` and publish it as
 * `--tc-vv-offset` on `modalEl` so CSS can shift the sheet above the
 * keyboard. Listens on both `resize` (keyboard show/hide) and `scroll`
 * (visualViewport pan). Returns a detach function — visualViewport is a
 * global singleton, so failing to detach leaks one closure per open.
 *
 * Shared by every bottom sheet (task details, tag editor, parent picker,
 * query editor) and the Quick Add modal — keyboard avoidance is a property
 * of the sheet primitive, not of one consumer.
 */
export function installKeyboardAvoidance(modalEl: HTMLElement): () => void {
  if (typeof window.visualViewport === "undefined" || !window.visualViewport) {
    return () => undefined;
  }
  const vv = window.visualViewport;
  const apply = () => {
    const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    modalEl.style.setProperty("--tc-vv-offset", `${offset}px`);
  };
  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  return () => {
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
  };
}

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
  private detachKeyboardAvoidance: (() => void) | null = null;

  constructor(app: App, private readonly opts: BottomSheetOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, modalEl, containerEl } = this;
    modalEl.addClass("task-center-bottom-sheet");
    containerEl.addClass("task-center-bottom-sheet");
    if (this.opts.sheetClass) modalEl.addClass(this.opts.sheetClass);
    if (Platform.isMobile) modalEl.addClass("task-center-obsidian-mobile-sheet");
    contentEl.empty();
    contentEl.addClass("bt-sheet-content");

    if (Platform.isMobile) {
      const handle = contentEl.createDiv({ cls: "bt-sheet-handle" });
      handle.setAttr("aria-hidden", "true");
      this.wireSwipeDown(handle);
      this.wireSwipeDown(this.titleEl);
      // Sheets with inputs (tag editor, parent picker, query DSL) must not
      // hide the focused field / submit row under the keyboard (§0.4).
      this.detachKeyboardAvoidance = installKeyboardAvoidance(modalEl);
    }

    this.titleEl.setText(this.opts.title);

    this.opts.populate(contentEl);
  }

  /**
   * UX-mobile §8.1: swipe-down dismiss. The grab surface is the handle bar
   * and the title row — NOT the content area, whose vertical pans must keep
   * scrolling the sheet body. The sheet follows the finger (downward only)
   * and commits the close past a 72px pull; under it, it snaps back.
   */
  private wireSwipeDown(grabEl: HTMLElement): void {
    grabEl.addClass("bt-sheet-grab");
    grabEl.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const startY = e.clientY;
      const setDrag = (px: number) => {
        this.modalEl.setCssProps({ "--tc-sheet-drag": `${px}px` });
      };
      const onMove = (ev: PointerEvent) => {
        setDrag(Math.max(0, ev.clientY - startY));
      };
      const finish = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        setDrag(0);
        if (ev.clientY - startY > 72) this.close();
      };
      const cancel = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        setDrag(0);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
    });
  }

  onClose(): void {
    this.detachKeyboardAvoidance?.();
    this.detachKeyboardAvoidance = null;
    this.opts.onClose?.();
  }
}
