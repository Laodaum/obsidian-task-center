/**
 * US-724: saved views / custom filters.
 *
 * Stable DOM attributes:
 *   data-saved-views                  — saved-view filter toolbar
 *   data-saved-view-filter="tag"      — tag popover trigger (US-109d)
 *   data-saved-view-filter="time-scheduled" — scheduled range popover trigger (US-109e)
 *   data-saved-view-filter="status"   — status popover trigger (US-109h)
 *   data-action="save-current-view"   — save current filters button
 *   data-saved-view-select            — saved view popover trigger
 *   data-saved-view-option            — saved view menu item
 *   data-tag-option="#tag"            — tag checkbox row inside the popover
 *   data-time-option="scheduled:today" — scheduled condition row inside the popover
 *   data-status-option="todo"         — status condition row inside the popover
 *   data-saved-view-name-input        — saved-view naming modal input
 */
import { browser, expect, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import fs from "node:fs/promises";

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
    // @ts-expect-error — runtime plugin
    const plugin = (app as any).plugins.plugins["task-center"];
    // Clear saved views and reload settings so builtins are recreated
    // from defaults. This gives each test a clean preset slate.
    plugin.settings.savedViews = [];
    plugin.settings.lastSavedViewId = null;
    plugin.settings.lastTab = null;
    await plugin.saveSettings();
    // Reload triggers ensureBuiltinSavedViews internally
    await plugin.loadSettings();
    await plugin.saveSettings();
    // Detach any existing board leaves for a clean start
    await Promise.all(app.workspace.getLeavesOfType("task-center-board").map((leaf) => leaf.detach()));
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
}

describe("US-724 saved views / custom filters", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
    await resetSavedViewTestState();
  });

  it("US-109d/e/f: filters visible cards by tags/date/status and saves/restores the view", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        `- [ ] Fixture alpha beta today #alpha #beta #1象限 ⏳ ${today}`,
        `- [ ] Fixture alpha today #alpha #1象限 ⏳ ${today}`,
        `- [ ] Fixture gamma today #gamma #1象限 ⏳ ${today}`,
        `- [x] Fixture alpha done #alpha #1象限 ✅ ${today}`,
        `- [ ] Fixture alpha other group #alpha #2象限 ⏳ ${today}`,
        `- [ ] Fixture alpha later #alpha #1象限 ⏳ 2099-01-01`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();

    await $('[data-saved-views]').waitForExist({ timeout: 5000 });

    const tagShape = await browser.execute(() => {
      const el = document.querySelector("[data-saved-view-filter='tag']");
      return { tagName: el?.tagName, aria: el?.getAttribute("aria-haspopup") };
    });
    expect(tagShape).toEqual({ tagName: "BUTTON", aria: "listbox" });

    const dateShape = await browser.execute(() => {
      const el = document.querySelector("[data-saved-view-filter='time-scheduled']");
      return { tagName: el?.tagName, aria: el?.getAttribute("aria-haspopup") };
    });
    expect(dateShape).toEqual({ tagName: "BUTTON", aria: "listbox" });

    const statusShape = await browser.execute(() => {
      const el = document.querySelector("[data-saved-view-filter='status']");
      return { tagName: el?.tagName, aria: el?.getAttribute("aria-haspopup") };
    });
    expect(statusShape).toEqual({ tagName: "BUTTON", aria: "listbox" });

    await $('[data-saved-view-filter="tag"]').click();
    await $('[data-tag-option="#alpha"]').click();
    await expect($('[data-tag-option="#alpha"]')).toHaveAttribute("aria-checked", "true");
    await $('[data-tag-option="#beta"]').click();
    await $('[data-saved-view-filter="time-scheduled"]').click();
    await $('[data-time-option="scheduled:today"]').click();
    await $('[data-saved-view-filter="status"]').click();
    await $('[data-status-option="todo"]').click();
    await $('[data-saved-view-filter="tag"]').click();
    await $('[data-tag-option="#1象限"]').click();
    // Close the tag popover so it doesn't cover the save button below
    await $('[data-saved-view-filter="tag"]').click();

    await expect($('[data-task-id="Tasks/Inbox.md:L1"]')).toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L2"]')).not.toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L3"]')).not.toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L4"]')).not.toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L5"]')).not.toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L6"]')).not.toExist();

    await $('[data-action="save-current-view"]').click();
    await $('[data-saved-view-name-input]').setValue("Alpha Today");
    await $('[data-action="confirm-saved-view-name"]').click();
    await forFlush();

    // Change filters away, then restore through the saved-view dropdown.
    await $('[data-saved-view-filter="tag"]').click();
    await $('[data-tag-clear]').click();
    await $('[data-tag-option="#gamma"]').click();
    await expect($('[data-action="update-current-view"]')).toExist();
    await $('[data-saved-view-select]').click();
    await $('[data-saved-view-option="Alpha Today"]').click();

    await expect($('[data-task-id="Tasks/Inbox.md:L1"]')).toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L2"]')).not.toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L6"]')).not.toExist();

    const saved = await browser.executeObsidian(async ({ app }) => {
      // @ts-expect-error — runtime plugin
      return (app as any).plugins.plugins["task-center"].settings.savedViews;
    });
    expect(JSON.stringify(saved)).toContain("Alpha Today");
  });

  it("US-109h: status popover includes all first and supports multi-select filters", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        `- [ ] Fixture status todo #status-multi ⏳ ${today}`,
        `- [x] Fixture status done #status-multi ✅ ${today}`,
        `- [ ] Fixture status later #status-multi ⏳ 2099-01-01`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $('[data-saved-views]').waitForExist({ timeout: 5000 });

    // The today builtin defaults to status=["todo"]. Click "all" first
    // so the test starts from "show everything"; setStatusFilter keeps
    // the popover open so the DOM assertions below can proceed.
    await $('[data-saved-view-filter="status"]').click();
    await $('[data-status-option="all"]').click();

    const statusPopoverWidth = await browser.execute(() => {
      const popover = document.querySelector<HTMLElement>(".bt-status-popover");
      return Math.round(popover?.getBoundingClientRect().width ?? 0);
    });
    expect(statusPopoverWidth).toBeLessThanOrEqual(112);
    await fs.writeFile("/tmp/task-center-status-popover-compact.png", Buffer.from(await browser.takeScreenshot(), "base64"));
    const statusOptions = await browser.execute(() =>
      Array.from(document.querySelectorAll("[data-status-option]")).map((el) => ({
        value: (el as HTMLElement).dataset.statusOption,
        role: el.getAttribute("role"),
        checked: el.getAttribute("aria-checked"),
      })),
    );
    expect(statusOptions).toEqual([
      { value: "all", role: "checkbox", checked: "true" },
      { value: "todo", role: "checkbox", checked: "false" },
      { value: "done", role: "checkbox", checked: "false" },
      { value: "dropped", role: "checkbox", checked: "false" },
    ]);

    await $('[data-status-option="todo"]').click();
    await expect($('[data-task-id="Tasks/Inbox.md:L1"]')).toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L2"]')).not.toExist();

    await $('[data-status-option="done"]').click();
    await expect($('[data-status-option="todo"]')).toHaveAttribute("aria-checked", "true");
    await expect($('[data-status-option="done"]')).toHaveAttribute("aria-checked", "true");
    await expect($('[data-task-id="Tasks/Inbox.md:L1"]')).toExist();
    await expect($('[data-task-id="Tasks/Inbox.md:L2"]')).toExist();

    await $('[data-action="save-current-view"]').click();
    await $('[data-saved-view-name-input]').setValue("Todo Or Done");
    await $('[data-action="confirm-saved-view-name"]').click();
    await forFlush();
    const savedJson = await browser.executeObsidian(async ({ app }) => {
      // @ts-expect-error — runtime plugin
      return JSON.stringify((app as any).plugins.plugins["task-center"].settings.savedViews);
    });
    expect(savedJson).toContain('"status":["todo","done"]');
  });

  it("US-109e: clicking outside the filter popover closes it", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Fixture outside click target #outside-click ⏳ ${today}\n`,
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $('[data-saved-views]').waitForExist({ timeout: 5000 });

    await $('[data-saved-view-filter="time-scheduled"]').click();
    await $(".bt-date-popover").waitForExist({ timeout: 3000 });

    const datePresetWidth = await browser.execute(() => {
      const presets = document.querySelector<HTMLElement>(".bt-date-presets");
      return Math.round(presets?.getBoundingClientRect().width ?? 0);
    });
    expect(datePresetWidth).toBeLessThanOrEqual(170);
    await fs.writeFile("/tmp/task-center-date-popover-compact.png", Buffer.from(await browser.takeScreenshot(), "base64"));

    const outsideClick = await browser.execute(() => {
      const view = document.querySelector<HTMLElement>(".task-center-view");
      const popover = document.querySelector<HTMLElement>(".bt-date-popover");
      const body = document.querySelector<HTMLElement>(".task-center-view .bt-body");
      if (!view || !popover || !body) return { clicked: false, insideToolbar: true };
      const bodyRect = body.getBoundingClientRect();
      const x = Math.floor(bodyRect.left + 12);
      const y = Math.floor(bodyRect.top + 12);
      const target = document.elementFromPoint(x, y) as HTMLElement | null;
      const clickTarget = target?.closest(".bt-filter-popover") ? body : target ?? view;
      clickTarget.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, clientX: x, clientY: y }));
      clickTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, clientX: x, clientY: y }));
      return {
        clicked: true,
        insideToolbar: !!clickTarget.closest("[data-saved-views]"),
      };
    });
    expect(outsideClick).toEqual({ clicked: true, insideToolbar: false });
    await expect($(".bt-date-popover")).not.toExist();
  });

  it("US-109c: updates the selected saved view instead of prompting for a new name", async function () {
    const today = todayISO();
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        `- [ ] Fixture alpha today #alpha ⏳ ${today}`,
        `- [ ] Fixture gamma today #gamma ⏳ ${today}`,
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $('[data-saved-views]').waitForExist({ timeout: 5000 });

    await $('[data-saved-view-filter="tag"]').click();
    await $('[data-tag-option="#alpha"]').click();
    // Close the tag popover so it doesn't cover the save button below
    await $('[data-saved-view-filter="tag"]').click();
    await $('[data-action="save-current-view"]').click();
    await $('[data-saved-view-name-input]').setValue("Focus");
    await $('[data-action="confirm-saved-view-name"]').click();
    await forFlush();

    await $('[data-saved-view-filter="tag"]').click();
    await $('[data-tag-clear]').click();
    await $('[data-tag-option="#gamma"]').click();
    // Close the tag popover so it doesn't cover the update button below
    await $('[data-saved-view-filter="tag"]').click();
    await $('[data-action="update-current-view"]').click();
    await forFlush();

    await expect($('[data-saved-view-name-input]')).not.toExist();
    const savedJson = await browser.executeObsidian(async ({ app }) => {
      // @ts-expect-error — runtime plugin
      return JSON.stringify((app as any).plugins.plugins["task-center"].settings.savedViews);
    });
    expect(savedJson).toContain('"name":"Focus"');
    expect(savedJson).toContain('"tag":"#gamma"');
    expect(savedJson).not.toContain('"tag":"#alpha"');
  });

  it("US-109d: tag picker excludes block refs and prose-polluted pseudo tags", async function () {
    await writeAndWait(
      "Tasks/Inbox.md",
      [
        "- [ ] Fixture option source #计划 #安全 [[Spec#Heading]] #^624c3648-bca7-4ee2",
        "- [ ] Fixture punctuation source #第一象限、#第二象限 等。并通过`advance` #示例工具箱",
      ].join("\n") + "\n",
    );

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $('[data-saved-views]').waitForExist({ timeout: 5000 });
    await $('[data-saved-view-filter="tag"]').click();

    const spacing = await browser.execute(() => {
      const list = document.querySelector<HTMLElement>(".bt-tag-options");
      if (!list) return { rowGap: 0 };
      return { rowGap: Number.parseFloat(getComputedStyle(list).rowGap) || 0 };
    });
    expect(spacing.rowGap).toBeGreaterThanOrEqual(4);
    await fs.writeFile("/tmp/task-center-tag-gap.png", Buffer.from(await browser.takeScreenshot(), "base64"));

    const options = await browser.execute(() =>
      Array.from(document.querySelectorAll("[data-tag-option]")).map((el) => ({
        value: (el as HTMLElement).dataset.tagOption,
        text: el.textContent,
      })),
    );

    expect(options.map((o) => o.value)).toContain("#计划");
    expect(options.map((o) => o.value)).toContain("#安全");
    expect(options.map((o) => o.value)).toContain("#第一象限");
    expect(options.map((o) => o.value)).toContain("#第二象限");
    expect(options.map((o) => o.value)).toContain("#示例工具箱");
    expect(JSON.stringify(options)).not.toContain("#^624c3648");
    expect(JSON.stringify(options)).not.toContain("并通过");
    expect(JSON.stringify(options)).not.toContain("[[Spec#Heading");
  });

  // US-109q: desktop "更多" overflow tabs open an in-place dropdown anchored
  // under the button (not a bottom sheet / modal). Clicking a row switches to
  // that tab and closes; outside click and Esc close it; the toggle re-opens.
  it("US-109q: 更多 opens an in-place dropdown that switches tab and closes", async function () {
    // Seed 12 custom presets with long names so the desktop tab bar overflows
    // by WIDTH (US-109q is width-driven, no fixed count cap) regardless of the
    // CI window size — no realistic panel fits 12 long-named tabs on one row.
    await browser.executeObsidian(async ({ app }) => {
      // @ts-expect-error — runtime plugin
      const plugin = (app as any).plugins.plugins["task-center"];
      const mk = (n: number) => ({
        id: `ovf-${n}`,
        name: `这是一个比较长的溢出测试视图名称${n}`,
        builtin: false,
        hidden: false,
        filters: {},
        view: { layout: { type: "list" } },
        summary: [],
      });
      plugin.settings.queryPresets = Array.from({ length: 12 }, (_, i) => mk(i + 1));
      plugin.settings.defaultSavedViewId = "ovf-1";
      await plugin.saveSettings();
      await Promise.all(
        app.workspace.getLeavesOfType("task-center-board").map((leaf) => leaf.detach()),
      );
    });

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $('[data-tab-id="__overflow__"]').waitForExist({ timeout: 5000 });

    // 1. Click 更多 → an in-place dropdown appears anchored under the button,
    //    and it is NOT a bottom sheet / modal.
    await $('[data-tab-id="__overflow__"]').click();
    await $('.bt-overflow-tabs-menu').waitForExist({ timeout: 2000 });
    const openShape = await browser.execute(() => {
      const menu = document.querySelector<HTMLElement>(".bt-overflow-tabs-menu");
      const anchor = document.querySelector<HTMLElement>(".bt-tab-more");
      const cs = menu ? getComputedStyle(menu) : null;
      return {
        nestedUnderMore: !!menu && !!anchor && anchor.contains(menu),
        position: cs?.position ?? "",
        rowCount: document.querySelectorAll(".bt-overflow-tabs-menu .bt-overflow-tab-row").length,
        draggableRows: document.querySelectorAll(
          '.bt-overflow-tabs-menu .bt-overflow-tab-row[draggable="true"]',
        ).length,
        isBottomSheet: !!document.querySelector(".task-center-bottom-sheet .bt-overflow-tabs-sheet"),
        firstRowTabId: document
          .querySelector<HTMLElement>(".bt-overflow-tabs-menu .bt-overflow-tab-row")
          ?.dataset.queryTabId,
      };
    });
    expect(openShape.nestedUnderMore).toBe(true);
    expect(openShape.position).toBe("absolute");
    expect(openShape.rowCount).toBeGreaterThan(0);
    // No drag-to-reorder inside the narrow dropdown.
    expect(openShape.draggableRows).toBe(0);
    expect(openShape.isBottomSheet).toBe(false);

    // 2. Clicking a row switches to that tab and closes the dropdown.
    const targetId = openShape.firstRowTabId;
    await $(`.bt-overflow-tabs-menu .bt-overflow-tab-row[data-query-tab-id="${targetId}"]`).click();
    await browser.waitUntil(
      async () => !(await $('.bt-overflow-tabs-menu').isExisting()),
      { timeout: 2000 },
    );
    const activeId = await browser.executeObsidian(({ app }) => {
      const leaf = app.workspace.getLeavesOfType("task-center-board")[0];
      return (leaf?.view as any)?.state?.savedViewId as string | undefined;
    });
    expect(activeId).toBe(targetId);

    // 3. Re-open, then an outside click closes it.
    await $('[data-tab-id="__overflow__"]').click();
    await $('.bt-overflow-tabs-menu').waitForExist({ timeout: 2000 });
    await browser.execute(() => {
      document.querySelector<HTMLElement>(".task-center-view")?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, composed: true }),
      );
    });
    await browser.waitUntil(
      async () => !(await $('.bt-overflow-tabs-menu').isExisting()),
      { timeout: 2000 },
    );

    // 4. Re-open, then Esc closes it.
    await $('[data-tab-id="__overflow__"]').click();
    await $('.bt-overflow-tabs-menu').waitForExist({ timeout: 2000 });
    await browser.keys(["Escape"]);
    await browser.waitUntil(
      async () => !(await $('.bt-overflow-tabs-menu').isExisting()),
      { timeout: 2000 },
    );
  });
});
