/**
 * US-711 / US-512: mobile explicit entry points (task #62)
 *
 * Mobile users should not have to discover desktop-only commands before
 * Task Center feels usable. The mobile layout exposes a Quick Add entry (the
 * toolbar `+`, US-512) and a first-use empty state that does not mention
 * desktop shortcuts. There is no bottom action bar — unscheduled tasks live in
 * the area accordion (US-511), not a sticky bottom button.
 */
import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

const VAULT = "test/e2e/vaults/simple";

async function forFlush() {
  await browser.executeObsidian(async ({ app }) => {
    // @ts-expect-error — runtime plugin
    await (app as any).plugins.plugins["task-center"].__forFlush();
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

describe("Task Center — mobile explicit entry points (US-711)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
    await setMobileMode(true);
  });

  afterEach(async function () {
    await setMobileMode(false);
  });

  it("US-711/US-512: mobile exposes Quick Add via the toolbar +, a first-use empty state, and no bottom action bar", async function () {
    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    await $(".task-center-view[data-mobile-layout='true']").waitForExist({
      timeout: 5000,
    });

    const empty = $(".bt-onboarding[data-mobile-empty-state='true']");
    await expect(empty).toExist();
    expect(await empty.getText()).not.toContain("Cmd/Ctrl");
    await expect($("[data-mobile-action='empty-quick-add']")).toExist();

    // US-512: new-task entry is the toolbar `+` (Quick Add) — the only mobile
    // creation path (US-169). The bottom action bar is gone.
    await expect($(".bt-toolbar .bt-add-btn")).toExist();
    await expect($("[data-mobile-entry='true']")).not.toExist();
    await expect($(".bt-mobile-action-bar")).not.toExist();
    await expect($(".bt-mobile-trash[data-drop-zone='abandon']")).not.toExist();

    await browser.execute(() => {
      document.querySelector<HTMLElement>(".bt-toolbar .bt-add-btn")?.click();
    });
    await $(".task-center-bottom-sheet").waitForExist({
      timeout: 3000,
      timeoutMsg: "US-512: toolbar + did not open the Quick Add bottom sheet",
    });
    await browser.execute(() => {
      document.querySelector<HTMLElement>(".modal-close-button")?.click();
    });
  });
});
