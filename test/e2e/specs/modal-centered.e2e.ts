import { browser, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import assert from "node:assert/strict";

// Regression guard: the Query editor is a BottomSheet whose bottom-anchoring CSS
// (`.modal-container.task-center-bottom-sheet { align-items: flex-end }`) had no
// `.is-mobile` guard, so on DESKTOP it stuck to the viewport bottom and got cut
// off instead of centering (see the "编辑当前视图" off-screen bug). The existing
// area-filter / saved-views e2e only asserted *content* elements, never the
// modal's *geometry*, so the regression shipped. This asserts the geometry.

const VAULT = "test/e2e/vaults/simple";

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function forFlush() {
  await browser.executeObsidian(async ({ app }) => {
    // @ts-expect-error — runtime plugin
    await (app as any).plugins.plugins["task-center"].__forFlush();
  });
}

async function writeAndWait(path: string, body: string) {
  await browser.executeObsidian(
    async ({ app }, p: string, content: string) => {
      let f = app.vault.getAbstractFileByPath(p);
      if (!f) {
        const folder = p.split("/").slice(0, -1).join("/");
        if (folder) await app.vault.createFolder(folder).catch(() => undefined);
        f = await app.vault.create(p, content);
      } else {
        // @ts-expect-error — runtime TFile
        await app.vault.modify(f, content);
      }
      await new Promise<void>((resolve) => {
        // @ts-expect-error — runtime metadataCache
        const ref = app.metadataCache.on("changed", (file) => {
          if (file.path === p) {
            app.metadataCache.offref(ref);
            resolve();
          }
        });
        window.setTimeout(resolve, 1500);
      });
    },
    path,
    body,
  );
}

describe("Query editor modal centering (desktop)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  it("is vertically centered, not anchored to / cut off at the viewport bottom", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      [`- [ ] Alpha task #alpha ⏳ ${today}`, `- [ ] Beta task #beta ⏳ ${today}`].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $("[data-saved-views], .task-center-view").waitForExist({ timeout: 5000 });

    // Open the Query editor sheet (the shared `.task-center-bottom-sheet` modal).
    const areaEdit = await $('[data-action="edit-area"]');
    await areaEdit.waitForExist({ timeout: 5000 });
    await areaEdit.click();
    await $(".task-center-bottom-sheet.modal").waitForExist({ timeout: 5000 });

    const geo = await browser.execute(() => {
      const el = document.querySelector(".task-center-bottom-sheet.modal");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
    });

    assert.ok(geo, "modal element not found");
    // A centered modal leaves a real gap below it; a bottom-anchored sheet sits
    // flush against (gap ≈ 0) or overflows (bottom > vh) the viewport bottom.
    assert.ok(
      geo.bottom <= geo.vh + 1,
      `modal is cut off at the bottom: bottom=${Math.round(geo.bottom)} vh=${geo.vh}`,
    );
    assert.ok(
      geo.vh - geo.bottom > 24,
      `modal is anchored to the viewport bottom (gap below = ${Math.round(geo.vh - geo.bottom)}px); expected it centered`,
    );
  });
});
