import { setIcon } from "obsidian";
import { t as tr } from "../i18n";
import type TaskCenterPlugin from "../main";

// One CSS-drawn illustration per "what's new" tile. Kept self-contained here so
// the (sizeable) upgrade gate doesn't bloat view.ts.
type BentoArt = "layout" | "model" | "preset" | "ui" | "toolbar" | "done";
type TrKey = Parameters<typeof tr>[0];

/**
 * US-415: full-view 1.0 upgrade gate. Rendered instead of the board when legacy
 * view data (flat SavedTaskView or old-DSL `view`) was detected at load. Shows a
 * bento of what's new + a roadmap, then a single confirm that persists the
 * already-in-memory-migrated data. Extracted from view.ts so the board renderer
 * stays focused and this screen can evolve on its own.
 */
export function renderMigrationGate(el: HTMLElement, plugin: TaskCenterPlugin): void {
  const count = plugin.migratedLegacyCount;
  const gate = el.createDiv({ cls: "tc-migration-gate" });
  gate.dataset.migratedCount = String(count);

  const card = gate.createDiv({ cls: "tc-migration-card" });

  const header = card.createDiv({ cls: "tc-migration-header" });
  header.createSpan({ cls: "tc-migration-badge", text: tr("migration.badge") });
  header.createEl("h2", { cls: "tc-migration-title", text: tr("migration.title") });
  header.createEl("p", { cls: "tc-migration-lead", text: tr("migration.lead", { n: count }) });
  // The confirm button sits below the (tall) bento + roadmap, so nudge the user
  // to scroll down rather than hunt for it.
  const scrollHint = header.createDiv({ cls: "tc-migration-scrollhint" });
  scrollHint.createSpan({ text: tr("migration.scrollHint") });
  scrollHint.createSpan({ cls: "tc-migration-scrollhint-arrow", text: "↓" });

  // What's new — a real bento: a 3-column grid where tiles span 1/2/3 columns.
  // Wide tiles (span ≥ 2) lay out horizontally (art left, text right) so they
  // read as banners, not half-empty boxes. Rows:
  //   [ layout(2) ][ model(1) ] · [ preset ][ toolbar ][ ui ] · [ done(3) ]
  card.createEl("h3", { cls: "tc-migration-subhead", text: tr("migration.whatsNewTitle") });
  const bento = card.createDiv({ cls: "tc-migration-bento" });
  const cells: Array<{ art: BentoArt; span: 1 | 2 | 3; title: TrKey; desc: TrKey }> = [
    { art: "layout", span: 2, title: "migration.feature1Title", desc: "migration.feature1Desc" },
    { art: "model", span: 1, title: "migration.feature2Title", desc: "migration.feature2Desc" },
    { art: "preset", span: 1, title: "migration.feature3Title", desc: "migration.feature3Desc" },
    { art: "toolbar", span: 1, title: "migration.feature5Title", desc: "migration.feature5Desc" },
    { art: "ui", span: 1, title: "migration.feature4Title", desc: "migration.feature4Desc" },
    { art: "done", span: 3, title: "migration.feature6Title", desc: "migration.feature6Desc" },
  ];
  for (const c of cells) renderBentoCell(bento, c.art, c.span, c.title, c.desc);

  // Primary action under What's New (still above the long views list).
  const actions = card.createDiv({ cls: "tc-migration-actions" });
  const cta = actions.createEl("button", { text: tr("migration.cta"), cls: "mod-cta" });
  cta.dataset.action = "complete-migration";
  cta.addEventListener("click", () => {
    cta.disabled = true;
    void plugin.completeMigration();
  });

  // The concrete list of views that will migrate — builtin vs custom tagged.
  const viewsSection = card.createDiv({ cls: "tc-migration-views" });
  viewsSection.createEl("h3", {
    cls: "tc-migration-subhead",
    text: tr("migration.viewsTitle", { n: count }),
  });
  const list = viewsSection.createEl("ul", { cls: "tc-migration-view-list" });
  for (const view of plugin.migratedLegacyViews) {
    const item = list.createEl("li", { cls: "tc-migration-view-item" });
    item.createSpan({ cls: "tc-migration-view-dot" });
    item.createSpan({ cls: "tc-migration-view-name", text: view.name });
    item.createSpan({
      cls: `tc-migration-view-tag ${view.builtin ? "is-builtin" : "is-custom"}`,
      text: view.builtin ? tr("migration.viewsBuiltin") : tr("migration.viewsCustom"),
    });
  }

  card.createEl("p", { cls: "tc-migration-note", text: tr("migration.note") });

  // Roadmap — rendered as bento tiles too (not a plain list), so "what's coming"
  // reads as part of the same visual language. Dashed "Planned" tag per tile.
  const roadmap = card.createDiv({ cls: "tc-migration-roadmap" });
  roadmap.createEl("h3", { cls: "tc-migration-subhead", text: tr("migration.roadmapTitle") });
  const roadmapGrid = roadmap.createDiv({ cls: "tc-migration-roadmap-bento" });
  const roadmapItems: Array<{ title: TrKey; desc: TrKey }> = [
    { title: "migration.roadmap1Title", desc: "migration.roadmap1Desc" },
    { title: "migration.roadmap2Title", desc: "migration.roadmap2Desc" },
  ];
  for (const r of roadmapItems) {
    const item = roadmapGrid.createDiv({ cls: "tc-roadmap-cell" });
    const head = item.createDiv({ cls: "tc-roadmap-head" });
    head.createSpan({ cls: "tc-roadmap-title", text: tr(r.title) });
    head.createSpan({ cls: "tc-roadmap-tag", text: tr("migration.roadmapTag") });
    item.createEl("p", { cls: "tc-roadmap-desc", text: tr(r.desc) });
  }

  window.setTimeout(() => cta.focus(), 10);
}

/**
 * One bento cell: a CSS-drawn illustration (`art`) + title + one-line desc.
 * `span` (1/2/3) sets the column span; span ≥ 2 tiles lay out horizontally.
 */
function renderBentoCell(grid: HTMLElement, art: BentoArt, span: 1 | 2 | 3, titleKey: TrKey, descKey: TrKey): void {
  const wideCls = span >= 2 ? " tc-bento-cell--wide" : " tc-bento-cell--square";
  const cell = grid.createDiv({ cls: `tc-bento-cell tc-bento-cell--${art} tc-bento-cell--span${span}${wideCls}` });
  const figure = cell.createDiv({ cls: "tc-bento-art" });
  figure.dataset.art = art;
  if (art === "layout") {
    // A composable layout: one wide area stacked over a row of two areas.
    figure.createDiv({ cls: "tc-art-block is-wide" });
    const row = figure.createDiv({ cls: "tc-art-row" });
    row.createDiv({ cls: "tc-art-block" });
    row.createDiv({ cls: "tc-art-block" });
  } else if (art === "toolbar") {
    // One shared edit entry per area: a header row with a title + edit button.
    const head = figure.createDiv({ cls: "tc-art-head" });
    head.createSpan({ cls: "tc-art-headtitle" });
    const editBtn = head.createSpan({ cls: "tc-art-editbtn" });
    setIcon(editBtn, "sliders-horizontal");
    figure.createDiv({ cls: "tc-art-headline" });
    figure.createDiv({ cls: "tc-art-headline is-short" });
  } else if (art === "done") {
    // A done card: stays in place, recolored with a check instead of vanishing.
    const doneCard = figure.createDiv({ cls: "tc-art-donecard" });
    const check = doneCard.createSpan({ cls: "tc-art-check" });
    setIcon(check, "check");
    doneCard.createSpan({ cls: "tc-art-donetext" });
  } else if (art === "model") {
    // One shared model bridging GUI and CLI through a JSON DSL.
    figure.createSpan({ cls: "tc-art-chip", text: "GUI" });
    figure.createSpan({ cls: "tc-art-link" });
    figure.createSpan({ cls: "tc-art-chip is-dsl", text: "{ }" });
    figure.createSpan({ cls: "tc-art-link" });
    figure.createSpan({ cls: "tc-art-chip", text: "CLI" });
  } else if (art === "preset") {
    // A built-in tab duplicated into an editable preset.
    figure.createDiv({ cls: "tc-art-tab is-back" });
    const front = figure.createDiv({ cls: "tc-art-tab is-front" });
    front.createSpan({ cls: "tc-art-plus", text: "+" });
  } else {
    // A refreshed UI: a mini window mock with a sparkle.
    const win = figure.createDiv({ cls: "tc-art-window" });
    const bar = win.createDiv({ cls: "tc-art-winbar" });
    bar.createSpan({ cls: "tc-art-dot" });
    bar.createSpan({ cls: "tc-art-dot" });
    bar.createSpan({ cls: "tc-art-dot" });
    const body = win.createDiv({ cls: "tc-art-winrow" });
    body.createSpan({ cls: "tc-art-fill" });
    body.createSpan({ cls: "tc-art-fill is-muted" });
    figure.createSpan({ cls: "tc-art-sparkle", text: "✦" });
  }
  const text = cell.createDiv({ cls: "tc-bento-text" });
  text.createEl("h4", { cls: "tc-bento-title", text: tr(titleKey) });
  text.createEl("p", { cls: "tc-bento-desc", text: tr(descKey) });
}
