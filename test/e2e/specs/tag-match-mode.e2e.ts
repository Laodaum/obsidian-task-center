import { browser, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

// US-109d4: tag filtering is a single boolean expression. The tag popover has an
// expression input (live-validated) plus a tag list whose rows append `#tag` to
// the expression. This spec proves: a typed expression persists into the area
// `when`, clicking a tag appends it, and a syntax error flags inline.

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

describe("tag boolean expression (US-109d4)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  it("US-109d4: a typed expression persists; clicking a tag appends it; syntax errors flag", async function () {
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

    const areaEdit = await $('[data-action="edit-area"]');
    await areaEdit.waitForExist({ timeout: 5000 });
    await areaEdit.click();
    await $('[data-query-editor-scope="area"]').waitForExist({ timeout: 5000 });

    // Open the tag popover — the expression input is present.
    await $(".bt-area-tag-trigger").click();
    await $("[data-area-tag-expr]").waitForExist({ timeout: 5000 });

    // Type a valid expression and commit with Enter; it persists after the rerender.
    const input = await $("[data-area-tag-expr]");
    await input.setValue("#alpha and not #beta");
    await browser.keys("Enter");
    await browser.waitUntil(
      async () => (await $("[data-area-tag-expr]").getValue()) === "#alpha and not #beta",
      { timeout: 5000, timeoutMsg: "expected the committed expression to persist" },
    );

    // Clicking a tag row appends `#tag` to the expression (popover stays open).
    const betaRow = await $('.bt-area-tag-row[data-area-tag="#beta"]');
    if (await betaRow.isExisting()) {
      await betaRow.click();
      await browser.waitUntil(
        async () => /#beta\s*$/.test(await $("[data-area-tag-expr]").getValue()),
        { timeout: 5000, timeoutMsg: "expected clicking #beta to append it to the expression" },
      );
    }

    // An invalid expression flags an inline error.
    await (await $("[data-area-tag-expr]")).setValue("(#alpha or");
    await $(".bt-area-tag-expr-error.is-visible").waitForExist({ timeout: 5000 });
  });
});
