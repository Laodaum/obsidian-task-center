/**
 * US-117 / US-117a / US-109z2: mobile filtering.
 *
 * The phone首屏 toolbar must not dump the desktop filter controls (search box +
 * tag/date/status popovers) onto the view — those were removed with tab-level
 * filtering (US-109z2). Mobile keeps one compact "编辑 Query" entry, and actual
 * filtering happens per-area: the area head's 编辑区域 opens the Area panel as a
 * near-fullscreen sheet (`bt-mobile-query-sheet`) whose 本区过滤 edits that
 * area's `when` (UX §3.2.4).
 *
 * Stable DOM (see saved-views.e2e.ts for the shared area-filter contract):
 *   [data-mobile-layout="true"]               — forced mobile layout
 *   [data-mobile-action="filters"]            — single compact toolbar entry
 *   [data-action="edit-area"]                 — per-area filter entry on the head
 *   .task-center-bottom-sheet .bt-mobile-query-sheet[data-query-editor-scope="area"]
 *   [data-filter-section="area"] / [data-area-status] / [data-area-time-field]
 *   .bt-area-tag-trigger / [data-area-tag="#tag"]
 */
import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

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

async function resetSavedViewTestState() {
  await browser.executeObsidian(async ({ app }) => {
    await Promise.all(app.workspace.getLeavesOfType("task-center-board").map((leaf) => leaf.detach()));
  });
}

async function setMobileMode(value: boolean): Promise<void> {
  await browser.executeObsidian(async ({ app }, v: boolean) => {
    // @ts-expect-error — runtime plugin
    const plugin = (app as any).plugins.plugins["task-center"];
    if (typeof plugin.__setTestForceMobile === "function") {
      plugin.__setTestForceMobile(v);
    }
    plugin.settings.mobileForceLayout = v;
    plugin.settings.lastTab = "today";
    await plugin.saveSettings();
  }, value);
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
        // @ts-expect-error — runtime TFile
        const ref = app.metadataCache.on("changed", (file) => {
          if (file.path === p) {
            app.metadataCache.offref(ref);
            resolve();
          }
        });
        setTimeout(() => {
          app.metadataCache.offref(ref);
          resolve();
        }, 2000);
      });
    },
    path,
    body,
  );
}

describe("Task Center — mobile filter UI (US-117 / US-109z2)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
    await resetSavedViewTestState();
    await setMobileMode(true);
  });

  afterEach(async function () {
    await setMobileMode(false);
  });

  it("US-117a: mobile toolbar carries one compact entry, no desktop filter controls; filtering is per-area", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Mobile alpha fixture #alpha ⏳ ${today}\n- [ ] Mobile beta fixture #beta ⏳ ${today}\n`,
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    await $(".task-center-view[data-mobile-layout='true']").waitForExist({ timeout: 5000 });
    await $('[data-task-id="Tasks/Inbox.md:L1"]').waitForExist({ timeout: 5000 });

    // 首屏 toolbar: one compact entry, none of the removed desktop controls.
    await expect($("[data-mobile-action='filters']")).toExist();
    await expect($(".task-center-view .bt-toolbar .bt-search")).not.toExist();
    await expect($(".task-center-view .bt-toolbar [data-saved-view-filter='tag']")).not.toExist();
    await expect($(".task-center-view .bt-toolbar [data-saved-view-filter='status']")).not.toExist();

    // Toolbar must not overflow horizontally and the body/cards fill the width.
    const widthOk = await browser.execute(() => {
      const view = document.querySelector<HTMLElement>(".task-center-view");
      const toolbar = document.querySelector<HTMLElement>(".task-center-view .bt-toolbar-main");
      const body = document.querySelector<HTMLElement>(".task-center-view .bt-body");
      const card = document.querySelector<HTMLElement>(".task-center-view [data-task-id='Tasks/Inbox.md:L1']");
      if (!view || !toolbar || !body || !card) return false;
      const viewWidth = view.getBoundingClientRect().width;
      const toolbarWidth = toolbar.getBoundingClientRect().width;
      const bodyWidth = body.getBoundingClientRect().width;
      const cardWidth = card.getBoundingClientRect().width;
      const toolbarHasNoHorizontalOverflow = toolbar.scrollWidth <= Math.ceil(toolbarWidth) + 1;
      return toolbarHasNoHorizontalOverflow &&
        bodyWidth >= viewWidth * 0.9 &&
        cardWidth >= bodyWidth * 0.85;
    });
    expect(widthOk).toBe(true);

    // Tab strip scrolls horizontally, fixed height, no drag / hotkeys (US-117b).
    const tabbarShape = await browser.execute(() => {
      const tabbar = document.querySelector<HTMLElement>(".task-center-view .bt-tabbar");
      const tabs = Array.from(document.querySelectorAll<HTMLElement>(".task-center-view .bt-tabbar .bt-tab"));
      const oldWidth = tabbar?.style.width ?? "";
      if (tabbar) tabbar.style.width = "320px";
      const style = tabbar ? getComputedStyle(tabbar) : null;
      const shape = {
        hasMore: tabs.some((tab) => tab.dataset.queryTabId === "__overflow__"),
        hotkeyCount: document.querySelectorAll(".task-center-view .bt-tabbar .bt-hotkey").length,
        draggableCount: tabs.filter((tab) => tab.getAttribute("draggable") === "true").length,
        overflowX: style?.overflowX ?? "",
        overflowY: style?.overflowY ?? "",
        hasVerticalScroll: tabbar ? tabbar.scrollHeight > Math.ceil(tabbar.clientHeight) + 1 : true,
      };
      if (tabbar) tabbar.style.width = oldWidth;
      return shape;
    });
    expect(tabbarShape.hasMore).toBe(false);
    expect(tabbarShape.hotkeyCount).toBe(0);
    expect(tabbarShape.draggableCount).toBe(0);
    expect(tabbarShape.overflowX).toBe("auto");
    expect(tabbarShape.overflowY).toBe("hidden");
    expect(tabbarShape.hasVerticalScroll).toBe(false);

    // Per-area filtering: the area head 编辑区域 opens the Area panel as a
    // near-fullscreen mobile sheet whose 本区过滤 edits this area's `when`.
    await $("[data-action='edit-area']").waitForExist({ timeout: 5000 });
    await $("[data-action='edit-area']").click();
    await $(".task-center-bottom-sheet .bt-mobile-query-sheet[data-query-editor-scope='area']")
      .waitForExist({ timeout: 3000 });
    await expect($(".task-center-bottom-sheet [data-filter-section='area']")).toExist();
    await expect($(".task-center-bottom-sheet [data-area-status='all']")).toExist();
    await expect($(".task-center-bottom-sheet [data-area-time-field='scheduled']")).toExist();
    await expect($(".task-center-bottom-sheet .bt-area-tag-trigger")).toExist();

    // Setting the area tag filters the cards behind the sheet.
    await $(".task-center-bottom-sheet .bt-area-tag-trigger").click();
    await $(".task-center-bottom-sheet .bt-area-tag-list").waitForExist({ timeout: 3000 });
    await $(".task-center-bottom-sheet [data-area-tag='#alpha']").click();
    await expect($('[data-task-id="Tasks/Inbox.md:L1"]')).toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L2"]')).not.toExist();
  });
});
