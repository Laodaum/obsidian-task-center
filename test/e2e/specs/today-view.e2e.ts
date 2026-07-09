/**
 * US-720: Today execution view (task #63)
 *
 * The existing board does not have a "today" focused entry point that
 * aggregates overdue, today, and unscheduled-recommendation in one place.
 * US-720 adds a dedicated today tab/view with quick actions.
 *
 * Stable DOM attributes (contract with implementation):
 *   data-tab="today"             — today tab button
 *   data-view="today"            — today view container
 *   data-today-group="overdue"   — overdue section
 *   data-today-group="today"     — today's tasks section
 *   data-today-group="unscheduled-rec" — unscheduled recommendation
 *   data-action="reschedule-tomorrow"  — reschedule button per card
 *   [data-empty-state="area"]    — per-area empty state (US-720d2)
 */
import { browser, expect, $, $$ } from "@wdio/globals";
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
          if (file.path === p) { app.metadataCache.offref(ref); resolve(); }
        });
        setTimeout(() => { app.metadataCache.offref(ref); resolve(); }, 2000);
      });
    },
    path,
    body,
  );
  await browser.executeObsidian(async ({ app }, p: string) => {
    // @ts-expect-error — runtime plugin test hook
    await app.plugins.plugins["task-center"].cache.invalidateFile(p);
    // @ts-expect-error — runtime plugin test hook
    await app.plugins.plugins["task-center"].__forFlush();
  }, path);
}

async function resetTaskCacheForTest() {
  await browser.executeObsidian(async ({ app }) => {
    // resetVault() mutates the fixture below Obsidian and may not emit delete
    // events for files created by earlier specs. Clear the runtime cache so
    // this spec's "empty vault" assertion is based on the current fixture.
    // @ts-expect-error — runtime plugin test hook
    const cache = app.plugins.plugins["task-center"].cache as any;
    cache.byPath?.clear?.();
    cache.byHash?.clear?.();
    cache.pending?.clear?.();
    cache.allLoaded = false;
    cache.allLoadingPromise = null;
    // @ts-expect-error — runtime plugin test hook
    const plugin = app.plugins.plugins["task-center"];
    await plugin.refreshOpenViews();
    await plugin.__forFlush();
  });
}

describe("US-720 today execution view (task #63)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  // US-720a: today tab entry point must exist in the board.
  it("US-720a: today tab entry point exists in the board", async function () {
    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    await expect($(".task-center-view")).toExist();
    await expect($('[data-tab="today"]')).toExist();
  });

  // US-720b: Today is col[ list×3 ] (逾期 / 今日 / 未排期) — three list areas,
  // each with its own head. Fixture: 1 overdue, 1 today, 1 unscheduled task.
  it("US-720b: today view renders three list areas", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        `- [ ] Overdue task 📅 2020-01-01`,
        `- [ ] Today task ⏳ ${today}`,
        `- [ ] Unscheduled task`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    const todayTab = $('[data-tab="today"]');
    await todayTab.waitForExist({ timeout: 5000 });
    await todayTab.click();

    await $('[data-view="today"]').waitForExist({ timeout: 3000 });
    await $('[data-view="today"] .bt-area-list').waitForExist({ timeout: 3000 });
    const areas = await $$('[data-view="today"] .bt-area.bt-area-list');
    expect(areas.length).toBe(3);
    const heads = await $$('[data-view="today"] .bt-area-head-title');
    expect(heads.length).toBe(3);
  });

  // US-720d2: when all three Today groups are empty, each list area shows its OWN
  // empty state — no single collapsed/centered view-level empty state swallows the
  // three areas. The future task keeps the vault non-empty (all-empty, not onboarding).
  it("US-720d2: each Today group shows its own empty state when all are empty", async function () {
    await writeAndWait("Tasks/Inbox.md", "- [ ] Future task ⏳ 2099-01-01\n");
    await resetTaskCacheForTest();

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    const todayTab = $('[data-tab="today"]');
    await todayTab.waitForExist({ timeout: 5000 });
    await todayTab.click();

    // No more collapsed view-level empty state; each area renders its own.
    await $('[data-view="today"] [data-empty-state="area"]').waitForExist({ timeout: 5000 });
    await expect($('[data-today-empty]')).not.toExist();
    const perAreaEmpties = await $$('[data-view="today"] .bt-area-list [data-empty-state="area"]');
    expect(perAreaEmpties.length).toBe(3);
  });
});
