import { setIcon } from "obsidian";
import { t as tr } from "../i18n";
import type { TaskFormatFlavor } from "../types";
import type TaskCenterPlugin from "../main";

// One CSS-drawn illustration per "what's new" tile. Kept self-contained here so
// the (sizeable) upgrade gate doesn't bloat view.ts.
type BentoArt = "layout" | "model" | "preset" | "ui" | "toolbar" | "done";
type RoadmapArt = "data" | "graph";
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

  // Flavor picker — let users choose dataview vs tasks-emoji format right inside
  // the migration gate, so they don't have to hunt for it in Settings afterwards.
  card.createEl("h3", { cls: "tc-migration-subhead", text: tr("migration.flavorTitle") });
  card.createEl("p", { cls: "tc-migration-lead", text: tr("migration.flavorDesc") });
  const flavorPicker = card.createDiv({ cls: "tc-flavor-picker" });
  renderFlavorCard(flavorPicker, "dataview", plugin);
  renderFlavorCard(flavorPicker, "tasks", plugin);

  // Heads-up for AI users: the query DSL shape changed in 1.0, so the CLI skill
  // must be updated or the agent keeps emitting the old flat DSL.
  const aiTip = card.createDiv({ cls: "tc-migration-aitip" });
  const aiIcon = aiTip.createSpan({ cls: "tc-migration-aitip-icon" });
  setIcon(aiIcon, "sparkles");
  const aiBody = aiTip.createDiv({ cls: "tc-migration-aitip-body" });
  aiBody.createEl("strong", { cls: "tc-migration-aitip-title", text: tr("migration.aiTipTitle") });
  aiBody.createEl("p", { cls: "tc-migration-aitip-desc", text: tr("migration.aiTipDesc") });
  aiBody.createEl("code", {
    cls: "tc-migration-aitip-code",
    // Shell command, not prose — sentence-case must not capitalize `npx` / the package name.
    // eslint-disable-next-line obsidianmd/ui/sentence-case
    text: "npx skills add CorrectRoadH/obsidian-task-center",
  });

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
  const roadmapItems: Array<{ art: RoadmapArt; title: TrKey; desc: TrKey }> = [
    { art: "data", title: "migration.roadmap1Title", desc: "migration.roadmap1Desc" },
    { art: "graph", title: "migration.roadmap2Title", desc: "migration.roadmap2Desc" },
  ];
  for (const r of roadmapItems) {
    const item = roadmapGrid.createDiv({ cls: "tc-roadmap-cell" });
    const figure = item.createDiv({ cls: `tc-roadmap-art tc-roadmap-art--${r.art}` });
    renderRoadmapArt(figure, r.art);
    const head = item.createDiv({ cls: "tc-roadmap-head" });
    head.createSpan({ cls: "tc-roadmap-title", text: tr(r.title) });
    head.createSpan({ cls: "tc-roadmap-tag", text: tr("migration.roadmapTag") });
    item.createEl("p", { cls: "tc-roadmap-desc", text: tr(r.desc) });
  }

  window.setTimeout(() => cta.focus(), 10);
}

/**
 * One flavor picker card: a CSS-drawn illustration of the format + title + label.
 * Clicking immediately writes `plugin.settings.taskFormatFlavor`; the CTA's
 * `completeMigration` persists it to disk alongside the migrated presets.
 */
function renderFlavorCard(picker: HTMLElement, flavor: TaskFormatFlavor, plugin: TaskCenterPlugin): void {
  const isSelected = plugin.settings.taskFormatFlavor === flavor;
  const card = picker.createDiv({
    cls: `tc-flavor-card${isSelected ? " is-selected" : ""}`,
  });
  card.dataset.flavor = flavor;
  card.tabIndex = 0;
  card.setAttribute("role", "button");

  const art = card.createDiv({ cls: "tc-flavor-art" });
  // Direct children — same pattern as working .tc-bento-art cells.
  art.createSpan({ cls: "tc-flav-check" });
  art.createSpan({ cls: "tc-flav-stub" });
  if (flavor === "dataview") {
    art.createEl("code", { cls: "tc-flav-tag", text: "[scheduled::]" });
    art.createEl("code", { cls: "tc-flav-tag", text: "[due::]" });
  } else {
    const h = art.createSpan({ cls: "tc-flav-icon" });
    setIcon(h, "hourglass");
    art.createEl("code", { cls: "tc-flav-datestr", text: "2026-06-24" });
    const c = art.createSpan({ cls: "tc-flav-icon" });
    setIcon(c, "calendar");
    art.createEl("code", { cls: "tc-flav-datestr", text: "2026-12-31" });
  }

  const text = card.createDiv({ cls: "tc-flavor-text" });
  text.createEl("h4", {
    cls: "tc-flavor-title",
    text: tr(flavor === "dataview" ? "migration.flavorDataviewTitle" : "migration.flavorTasksTitle"),
  });
  text.createEl("p", {
    cls: "tc-flavor-label",
    text: tr(flavor === "dataview" ? "settings.taskFormatFlavor.dataview" : "settings.taskFormatFlavor.tasks"),
  });

  card.addEventListener("click", () => {
    picker.querySelectorAll<HTMLElement>(".tc-flavor-card").forEach((c) => c.classList.remove("is-selected"));
    card.classList.add("is-selected");
    plugin.settings.taskFormatFlavor = flavor;
  });
  card.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      card.click();
    }
  });
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
    // A composable layout: a mini board — a wide list area over two stacked areas.
    const wide = figure.createDiv({ cls: "tc-art-area is-wide" });
    wide.createSpan({ cls: "tc-art-area-bar" });
    wide.createSpan({ cls: "tc-art-area-line" });
    const row = figure.createDiv({ cls: "tc-art-row" });
    for (let i = 0; i < 2; i++) {
      const area = row.createDiv({ cls: "tc-art-area" });
      area.createSpan({ cls: "tc-art-area-bar" });
      area.createSpan({ cls: "tc-art-area-line" });
    }
  } else if (art === "toolbar") {
    // One edit entry per area: the old scattered icons (filter / rename / tag)
    // collapse into a single edit button that opens one panel — before → after.
    const before = figure.createDiv({ cls: "tc-art-ba is-before" });
    const beforeHead = before.createDiv({ cls: "tc-art-ba-head" });
    for (const icon of ["filter", "pencil", "tag"]) {
      const chip = beforeHead.createSpan({ cls: "tc-art-ba-icon" });
      setIcon(chip, icon);
    }
    before.createSpan({ cls: "tc-art-ba-line" });
    figure.createSpan({ cls: "tc-art-ba-arrow", text: "→" });
    const after = figure.createDiv({ cls: "tc-art-ba is-after" });
    const afterHead = after.createDiv({ cls: "tc-art-ba-head" });
    afterHead.createSpan({ cls: "tc-art-ba-line is-grow" });
    const editBtn = afterHead.createSpan({ cls: "tc-art-editbtn" });
    setIcon(editBtn, "sliders-horizontal");
    const panel = after.createDiv({ cls: "tc-art-ba-panel" });
    for (let i = 0; i < 3; i++) panel.createSpan({ cls: "tc-art-ba-seg" });
  } else if (art === "done") {
    // Done cards linger in place: a list of rows, the top one checked + dimmed.
    for (let i = 0; i < 3; i++) {
      const task = figure.createDiv({ cls: `tc-art-task${i === 0 ? " is-done" : ""}` });
      const check = task.createSpan({ cls: "tc-art-task-check" });
      if (i === 0) setIcon(check, "check");
      task.createSpan({ cls: "tc-art-task-line" });
    }
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

/**
 * Roadmap illustration — same primitives as the bento, but "planned": dashed and
 * desaturated so it reads as coming-soon, not shipped.
 */
function renderRoadmapArt(figure: HTMLElement, kind: RoadmapArt): void {
  if (kind === "data") {
    // A composable data area: a stat tile, a mini bar chart, a ratio ring.
    const stat = figure.createDiv({ cls: "tc-rart-tile tc-rart-stat" });
    stat.createSpan({ cls: "tc-rart-num" });
    stat.createSpan({ cls: "tc-rart-cap" });
    const chart = figure.createDiv({ cls: "tc-rart-tile tc-rart-chart" });
    for (let i = 0; i < 4; i++) chart.createSpan({ cls: "tc-rart-bar" });
    figure.createDiv({ cls: "tc-rart-tile tc-rart-ring" });
  } else {
    // Graphical layout editing: a nested block tree with a drag handle.
    const outer = figure.createDiv({ cls: "tc-rart-node is-outer" });
    const handle = outer.createSpan({ cls: "tc-rart-handle" });
    setIcon(handle, "grip-vertical");
    const row = outer.createDiv({ cls: "tc-rart-node-row" });
    row.createDiv({ cls: "tc-rart-node is-inner" });
    row.createDiv({ cls: "tc-rart-node is-inner" });
  }
}
