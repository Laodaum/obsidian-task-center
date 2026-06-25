import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

// Tag match mode (AND / OR): the segmented toggle appears once ≥2 tags are
// selected, defaults to AND (全部), and switching to OR (任一) persists into the
// area `when` — proven by the `active` class being re-derived from when.tags
// after the rerender (GUI → setAreaWhen → when.tags → areaTagMode → active).

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

async function hasActiveMode(mode: "and" | "or"): Promise<boolean> {
  const el = await $(`.bt-area-tag-mode-btn[data-tag-mode="${mode}"]`);
  if (!(await el.isExisting())) return false;
  return ((await el.getAttribute("class")) ?? "").includes("active");
}

describe("tag match mode (AND/OR) toggle", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  it("appears at ≥2 tags, defaults to AND, and switching to OR persists", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        `- [ ] Both task #alpha #beta ⏳ ${today}`,
        `- [ ] Alpha only #alpha ⏳ ${today}`,
        `- [ ] Beta only #beta ⏳ ${today}`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $("[data-saved-views], .task-center-view").waitForExist({ timeout: 5000 });

    // Open an area's filter editor.
    const areaEdit = await $('[data-action="edit-area"]');
    await areaEdit.waitForExist({ timeout: 5000 });
    await areaEdit.click();
    await $('[data-query-editor-scope="area"]').waitForExist({ timeout: 5000 });

    // The toggle is absent with no tags selected.
    await expect($(".bt-area-tag-mode")).not.toExist();

    // Open the tag select and pick two distinct tags.
    await $(".bt-area-tag-trigger").click();
    await $(".bt-area-tag-row").waitForExist({ timeout: 5000 });
    await $('.bt-area-tag-row[data-area-tag="#alpha"]').click();
    await $('.bt-area-tag-row[data-area-tag="#beta"]').click();

    // Segmented toggle appears and defaults to AND (全部).
    await $(".bt-area-tag-mode").waitForExist({ timeout: 5000 });
    await browser.waitUntil(async () => (await hasActiveMode("and")) && !(await hasActiveMode("or")), {
      timeout: 5000,
      timeoutMsg: "expected AND to be the default active mode",
    });

    // Switch to OR (任一); active state moves and survives the rerender.
    await $('.bt-area-tag-mode-btn[data-tag-mode="or"]').click();
    await browser.waitUntil(async () => (await hasActiveMode("or")) && !(await hasActiveMode("and")), {
      timeout: 5000,
      timeoutMsg: "expected OR to become the active mode after clicking 任一",
    });
  });
});
