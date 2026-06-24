/**
 * Modal title layout — verifies that .modal-title in task-center modals is
 * left-aligned and does not overlap the close button.
 *
 * Regression for: title was right-aligned due to align-items:flex-end on
 * .task-center-bottom-sheet.modal (mobile CSS leaking into desktop layout).
 */
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

const VAULT = "test/e2e/vaults/simple";

describe("Task Center — modal title layout", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
    await browser.execute(() => {
      document.querySelectorAll(".modal-container").forEach((m) => m.remove());
    });
  });

  it("manage-tabs modal: title is left-aligned and not overlapping close button", async function () {
    // Open the manage tabs sheet via the plugin API.
    await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["task-center"];
      // Find the open TaskCenterView leaf and call openManageTabsSheet on it.
      const leaf = app.workspace.getLeavesOfType("task-center-view")[0];
      if (!leaf) return;
      const view = leaf.view as any;
      view.openManageTabsSheet?.();
    });

    // Wait for the modal to appear.
    await browser.waitUntil(
      () =>
        browser.execute(
          () => !!document.querySelector(".task-center-bottom-sheet .modal-title"),
        ),
      { timeout: 3000, interval: 100 },
    );

    // Check that the title element's right edge does not reach the close button.
    const result = await browser.execute(() => {
      const modal = document.querySelector(".task-center-bottom-sheet") as HTMLElement | null;
      const title = modal?.querySelector(".modal-title") as HTMLElement | null;
      const closeBtn = modal?.querySelector(".modal-close-button") as HTMLElement | null;
      if (!modal || !title || !closeBtn) return { ok: false, reason: "elements missing" };

      const titleRect = title.getBoundingClientRect();
      const closeBtnRect = closeBtn.getBoundingClientRect();

      // Title right edge should be clearly to the left of close button left edge.
      const gap = closeBtnRect.left - titleRect.right;
      // Title left edge should be near the modal left edge (left-aligned).
      const modalRect = modal.getBoundingClientRect();
      const leftOffset = titleRect.left - modalRect.left;

      return {
        ok: gap >= 0,
        gap,
        leftOffset,
        titleWidth: titleRect.width,
        modalWidth: modalRect.width,
        reason: gap < 0 ? `title overlaps close button by ${-gap}px` : "ok",
      };
    });

    expect(result.ok).toBe(true);
    // Title should be left-aligned — left offset should be close to the modal padding.
    expect(result.leftOffset).toBeLessThan(40);
  });
});
