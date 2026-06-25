/**
 * US-111 (extended): the task format flavor is a 2D contract, not a diagonal.
 *
 *   - WRITE setting  (`taskFormatFlavor` ∈ tasks | dataview) decides the shape
 *     of any field this plugin emits.
 *   - READ / on-disk CONTENT (emoji | dataview) is whatever the user already
 *     typed, and must always parse — independent of the write setting.
 *
 * `dataview-format.e2e.ts` only covered the diagonal (setting=dataview,
 * content=dataview). This spec drives the full matrix and the cross-format
 * mutation behavior so a user's *pre-existing* content keeps working after the
 * setting changes:
 *
 *   Group 1 — Read parity: every (setting × content) combo renders on the board,
 *             including the off-diagonal (emoji content under a dataview setting
 *             and vice versa).
 *   Group 2 — Write parity: api.add / schedule / done / drop emit the setting's
 *             flavor and never the foreign markers.
 *   Group 3 — Mutation converts foreign content to the setting's flavor, while
 *             untouched co-fields (tags) survive line-scoped (US-147).
 *
 * Assertions inspect markdown content so the contract stays format-level,
 * independent of visual styling. Self-isolating: each test resets the vault
 * files AND the write flavor (see _journeys.resetForWriteFlavor).
 */
import { expect, $ } from "@wdio/globals";
import {
  FLAVORS,
  otherFlavor,
  todayISO,
  readFile,
  writeAndWait,
  forFlush,
  openBoardWeekView,
  callApi,
  resetForWriteFlavor,
  setWriteFlavor,
} from "./_journeys.js";

const PATH = "Tasks/Inbox.md";
const CARD = `[data-task-id="${PATH}:L1"]`;

describe("Task Center — task format matrix (US-111)", function () {
  // Leave the shared vault on the default write flavor for sibling specs in the
  // same worker — resetVault never touches plugin settings, so we must.
  after(async function () {
    await setWriteFlavor("tasks");
  });

  // ---- Group 1: read parity (every setting renders every content) ----------
  for (const setting of FLAVORS) {
    for (const content of FLAVORS) {
      const offDiagonal = setting.name !== content.name;
      it(`US-111 read: setting=${setting.name} renders ${content.name} content${offDiagonal ? " (off-diagonal)" : ""}`, async function () {
        await resetForWriteFlavor(setting.setting);
        const today = todayISO();
        await writeAndWait(PATH, `- [ ] Render ${content.name} ${content.scheduled(today)}\n`);

        await openBoardWeekView();

        await $(`.task-center-view ${CARD}`).waitForExist({
          timeout: 5000,
          timeoutMsg: `${content.name} content did not render under setting=${setting.name}`,
        });
      });
    }
  }

  // ---- Group 2: write parity (mutations emit the setting's flavor) ----------
  for (const setting of FLAVORS) {
    const foreign = otherFlavor(setting);

    it(`US-111 write: setting=${setting.name} — add stamps scheduled+created in ${setting.name}`, async function () {
      await resetForWriteFlavor(setting.setting);
      await callApi((api) =>
        api.add({
          text: "Add stamp task",
          to: PATH,
          scheduled: "2099-12-31",
          stampCreated: true,
        }),
      );

      const content = await readFile(PATH);
      await expect(content).toContain("- [ ] Add stamp task");
      await expect(content).toMatch(setting.scheduledRe);
      await expect(content).toContain(setting.scheduled("2099-12-31"));
      await expect(content).toMatch(setting.createdRe);
      await expect(content).not.toMatch(foreign.scheduledRe);
      await expect(content).not.toMatch(foreign.createdRe);
    });

    it(`US-111 write: setting=${setting.name} — schedule / done / drop emit ${setting.name} fields`, async function () {
      await resetForWriteFlavor(setting.setting);
      const today = todayISO();
      await writeAndWait(
        PATH,
        `- [ ] Schedule task ${setting.scheduled(today)}\n` +
          `- [ ] Done task ${setting.scheduled(today)}\n` +
          `- [ ] Drop task ${setting.scheduled(today)}\n`,
      );
      await forFlush();

      const scheduled = await callApi((api) => api.schedule(`${PATH}:L1`, "2099-12-31"));
      await expect(scheduled.after).toContain(setting.scheduled("2099-12-31"));
      await expect(scheduled.after).not.toMatch(foreign.scheduledRe);

      await forFlush();
      const done = await callApi((api) => api.done(`${PATH}:L2`));
      await expect(done.after).toContain("[x]");
      await expect(done.after).toMatch(setting.completionRe);
      await expect(done.after).not.toMatch(foreign.completionRe);

      await forFlush();
      const dropped = await callApi((api) => api.drop(`${PATH}:L3`));
      await expect(dropped.after).toContain("[-]");
      await expect(dropped.after).toMatch(setting.cancelledRe);
      await expect(dropped.after).not.toMatch(foreign.cancelledRe);
    });
  }

  // ---- Group 3: mutating foreign content converts it to the setting flavor --
  for (const setting of FLAVORS) {
    const foreign = otherFlavor(setting);

    it(`US-111 mutate: setting=${setting.name} rewrites ${foreign.name} scheduled to ${setting.name}, keeps tags`, async function () {
      await resetForWriteFlavor(setting.setting);
      const today = todayISO();
      // The on-disk task is in the FOREIGN format (a user's pre-existing content)
      // plus a tag that must survive the line-scoped mutation (US-147).
      await writeAndWait(PATH, `- [ ] Foreign task #keep ${foreign.scheduled(today)}\n`);
      await forFlush();

      const res = await callApi((api) => api.schedule(`${PATH}:L1`, "2099-12-31"));

      await expect(res.after).toContain(setting.scheduled("2099-12-31"));
      await expect(res.after).not.toMatch(foreign.scheduledRe);
      await expect(res.after).toContain("#keep");

      const content = await readFile(PATH);
      await expect(content).toContain(setting.scheduled("2099-12-31"));
      await expect(content).not.toMatch(foreign.scheduledRe);
      await expect(content).toContain("#keep");
    });
  }
});
