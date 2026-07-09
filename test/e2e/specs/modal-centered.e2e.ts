import { browser, $ } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import assert from "node:assert/strict";

// Why the existing filter journeys (saved-views / area-filter / mobile-filter-ui)
// never caught this: they open the same `.task-center-bottom-sheet` modal but
// interact via the DOM (wdio scrolls to + clicks elements regardless of visual
// clipping) and assert DOM/data outcomes — never the modal's GEOMETRY. So when
// the modal bottom-anchored on desktop (cut off) and then collapsed its content
// to the title sliver (clipping the 另存为新 tab / 管理 Tabs row), every journey
// still passed. This spec opens the exact reported "编辑当前视图" (scope:tab)
// modal and asserts it is centered, on-screen, and its content is not collapsed
// or clipped.
//
// TODO(test-quality): the broader gap remains — the filter/edit-view USER
// JOURNEYS (saved-views.e2e / area-filter.e2e / mobile-filter-ui.e2e) still only
// assert clickability + data, never visual layout. Consider a shared
// "assert modal usable" geometry helper invoked from those journeys so a future
// visual regression fails the journey that exercises it, not only this spec.

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
          if (file.path === p) { app.metadataCache.offref(ref); resolve(); }
        });
        window.setTimeout(resolve, 1500);
      });
    },
    path,
    body,
  );
}

describe("Query editor modal — centered & content visible (desktop)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });
  afterEach(async function () {
    for (let i = 0; i < 5 && (await $(".modal-bg").isExisting()); i++) {
      await browser.keys(["Escape"]);
      await $(".modal-bg").waitForExist({ reverse: true, timeout: 1000 }).catch(() => undefined);
    }
  });

  it("the 编辑当前视图 (scope:tab) modal is centered, on-screen, and its content is not collapsed/clipped", async function () {
    const today = todayISO();
    await writeAndWait("Tasks/Inbox.md", `- [ ] Fixture alpha #alpha ⏳ ${today}\n`);

    await browser.executeObsidianCommand("task-center:open");
    await forFlush();
    await $("[data-saved-views], .task-center-view").waitForExist({ timeout: 5000 });

    // Open the exact reported modal — the tab-level Query editor ("编辑当前视图").
    await browser.executeObsidian(({ app }) => {
      const leaf = app.workspace.getLeavesOfType("task-center-board")[0];
      // @ts-expect-error — runtime view method
      leaf?.view?.openQueryControlsSheet?.({ scope: "tab" });
    });
    await $(".task-center-bottom-sheet.modal .modal-content").waitForExist({ timeout: 5000 });

    const m = await browser.execute(() => {
      const box = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
      };
      const modal = document.querySelector(".task-center-bottom-sheet.modal");
      const content = modal?.querySelector(".modal-content") ?? null;
      const btns = Array.from(content?.querySelectorAll("button") ?? []);
      const firstBtn = btns[0] ?? null;
      return {
        vh: window.innerHeight,
        vw: window.innerWidth,
        modal: box(modal),
        content: box(content),
        firstBtn: box(firstBtn),
        firstBtnText: (firstBtn?.textContent ?? "").trim(),
        btnCount: btns.length,
      };
    });

    assert.ok(m.modal && m.content, "modal / modal-content not found");

    // 1. Horizontally centered — catches the original off-screen bottom-RIGHT bug.
    const cx = (m.modal.left + m.modal.right) / 2;
    assert.ok(
      cx > m.vw * 0.25 && cx < m.vw * 0.75,
      `modal not horizontally centered (center-x=${Math.round(cx)}, vw=${m.vw})`,
    );
    // 2. Fully on-screen vertically — not cut off at top or bottom.
    assert.ok(
      m.modal.top >= -1 && m.modal.bottom <= m.vh + 1,
      `modal not fully on-screen: top=${Math.round(m.modal.top)} bottom=${Math.round(m.modal.bottom)} vh=${m.vh}`,
    );
    // 3. Content not collapsed to the title sliver (the second bug).
    assert.ok(m.content.h > 80, `modal content collapsed (height=${Math.round(m.content.h)}px)`);
    // 4. The top toolbar button (另存为新 tab) is rendered and fully visible — not clipped.
    assert.ok(m.btnCount > 0 && m.firstBtn, "no toolbar buttons rendered in the modal");
    assert.ok(
      m.firstBtn.top >= m.content.top - 1 && m.firstBtn.bottom <= m.vh + 1,
      `top toolbar button "${m.firstBtnText}" is clipped: ` +
        `btn[top=${Math.round(m.firstBtn.top)} bottom=${Math.round(m.firstBtn.bottom)}] ` +
        `content.top=${Math.round(m.content.top)} vh=${m.vh}`,
    );
  });
});
