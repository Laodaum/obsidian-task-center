import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

// US-109z2: the area filter editor (per-area `when`). Guards the click-to-open
// tag select and the time-field controls — regressions here previously shipped
// because there was no e2e exercising the editor's interactions.

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

describe("US-109z2 area filter editor", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  it("opens the Area panel filter, the tag select toggles, and time fields are progressive", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        `- [ ] Alpha task #alpha ⏳ ${today}`,
        `- [ ] Beta task #beta ⏳ ${today}`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $("[data-saved-views], .task-center-view").waitForExist({ timeout: 5000 });

    // Open an area's editor from its head → Area panel, filter tab.
    const areaEdit = await $('[data-action="edit-area"]');
    await areaEdit.waitForExist({ timeout: 5000 });
    await areaEdit.click();

    await $('[data-query-editor-scope="area"]').waitForExist({ timeout: 5000 });
    // Filter tab renders the area `when` controls.
    await expect($('[data-filter-section="area"]')).toExist();
    // Scheduled (primary) shows by default; secondary fields are progressive.
    await expect($('[data-area-time-field="scheduled"]')).toExist();
    await expect($('[data-area-time-field="deadline"]')).not.toExist();
    await expect($('[data-action="add-time-field"][data-time-field="deadline"]')).toExist();

    // The tag select is collapsed until clicked (no list yet).
    await expect($(".bt-area-tag-list")).not.toExist();
    await $(".bt-area-tag-trigger").click();
    await expect($(".bt-area-tag-list")).toExist();
    await expect($(".bt-area-tag-row")).toExist();

    // Adding a date field reveals it.
    await $('[data-action="add-time-field"][data-time-field="deadline"]').click();
    await expect($('[data-area-time-field="deadline"]')).toExist();
  });
});
