import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { t as tr } from "./i18n";
import type TaskCenterPlugin from "./main";
import { restoreBuiltinQueryPresets, visibleQueryPresets } from "./saved-views";

const SKILL_INSTALL_COMMAND = "npx skills add CorrectRoadH/obsidian-task-center";

export class TaskCenterSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: TaskCenterPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName(tr("settings.header")).setHeading();

    // US-118: removed legacy Inbox path / grouping tag settings. Quick Add
    // writes only to Obsidian Daily Notes; tags are ordinary markdown data
    // surfaced through filters and saved views.

    // Grouped into clear sections (Query tabs / General / Task writing / Mobile
    // / CLI) so the page reads as related clusters instead of one flat list.
    new Setting(containerEl).setName(tr("settings.groupTabs")).setHeading();

    new Setting(containerEl)
      .setName(tr("settings.defaultSavedView.name"))
      .setDesc(tr("settings.defaultSavedView.desc"))
      .addDropdown((dd) => {
        dd.addOption("", tr("settings.defaultSavedView.none"));
        for (const view of visibleQueryPresets(this.plugin.settings.queryPresets)) {
          dd.addOption(view.id, view.name);
        }
        return dd
          .setValue(this.plugin.settings.defaultSavedViewId ?? "")
          .onChange(async (v) => {
            this.plugin.settings.defaultSavedViewId = v || null;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(tr("settings.restoreBuiltins.name"))
      .setDesc(tr("settings.restoreBuiltins.desc"))
      .addButton((btn) =>
        btn
          .setButtonText(tr("settings.restoreBuiltins.action"))
          .onClick(async () => {
            this.plugin.settings.queryPresets = restoreBuiltinQueryPresets(this.plugin.settings.queryPresets, {
              today: tr("tab.today"),
              week: tr("tab.week"),
              month: tr("tab.month"),
              todo: tr("tab.todo"),
              completed: tr("tab.completed"),
              dropped: tr("tab.dropped"),
              unscheduled: tr("tab.unscheduled"),
              horizon: tr("tab.horizon"),
            });
            // US-109l: 恢复预设 Tabs 清空墓碑，把所有被永久删除的内建一次找回。
            this.plugin.settings.deletedBuiltinIds = [];
            const visible = visibleQueryPresets(this.plugin.settings.queryPresets);
            if (
              this.plugin.settings.defaultSavedViewId
              && !visible.some((view) => view.id === this.plugin.settings.defaultSavedViewId)
            ) {
              this.plugin.settings.defaultSavedViewId = visible[0]?.id ?? null;
            }
            if (
              this.plugin.settings.lastSavedViewId
              && !visible.some((view) => view.id === this.plugin.settings.lastSavedViewId)
            ) {
              this.plugin.settings.lastSavedViewId = visible[0]?.id ?? null;
            }
            await this.plugin.saveSettings();
            await this.plugin.refreshOpenViews();
            this.display();
            new Notice(tr("settings.restoreBuiltins.name"));
          }),
      );

    new Setting(containerEl)
      .setName(tr("settings.manageTabs.name"))
      .setDesc(tr("settings.manageTabs.desc"))
      .addButton((btn) =>
        btn
          .setButtonText(tr("settings.manageTabs.action"))
          .onClick(async () => {
            await this.plugin.openManageTabs();
          }),
      );

    new Setting(containerEl).setName(tr("settings.groupGeneral")).setHeading();

    new Setting(containerEl)
      .setName(tr("settings.weekStart.name"))
      .setDesc(tr("settings.weekStart.desc"))
      .addDropdown((dd) =>
        dd
          .addOption("1", tr("settings.weekStart.mon"))
          .addOption("0", tr("settings.weekStart.sun"))
          .setValue(this.plugin.settings.weekStartsOn.toString())
          .onChange(async (v) => {
            this.plugin.settings.weekStartsOn = v === "0" ? 0 : 1;
            await this.plugin.saveSettings();
          }),
      );

    // US-110: "open board on startup" toggle. Default off — the board
    // costs a vault scan on first open and we don't want to slow Obsidian
    // launch unless the user opted in. Wired in main.ts:onload via the
    // `app.workspace.onLayoutReady → activateView` callback.
    // see USER_STORIES.md
    new Setting(containerEl)
      .setName(tr("settings.openOnStartup.name"))
      .setDesc(tr("settings.openOnStartup.desc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.openOnStartup).onChange(async (v) => {
          this.plugin.settings.openOnStartup = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName(tr("settings.groupWriting")).setHeading();

    new Setting(containerEl)
      .setName(tr("settings.stampCreated.name"))
      .setDesc(tr("settings.stampCreated.desc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.stampCreated).onChange(async (v) => {
          this.plugin.settings.stampCreated = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(tr("settings.taskFormatFlavor.name"))
      .setDesc(tr("settings.taskFormatFlavor.desc"))
      .addDropdown((dd) =>
        dd
          .addOption("tasks", tr("settings.taskFormatFlavor.tasks"))
          .addOption("dataview", tr("settings.taskFormatFlavor.dataview"))
          .setValue(this.plugin.settings.taskFormatFlavor)
          .onChange(async (value) => {
            this.plugin.settings.taskFormatFlavor = value === "dataview" ? "dataview" : "tasks";
            await this.plugin.saveSettings();
            await this.plugin.refreshOpenViews();
          }),
      );

    // US-510: mobile-specific settings. Always rendered so cross-device
    // syncs (desktop user configuring their phone behaviour) work; the
    // values are no-ops on desktop. Heading is shown unconditionally.
    // The mobileForceLayout toggle below also implements US-502 (force
    // narrow layout regardless of viewport width).
    // see USER_STORIES.md
    {
      new Setting(containerEl).setName(tr("settings.mobileHeader")).setHeading();

      new Setting(containerEl)
        .setName(tr("settings.mobileForceLayout.name"))
        .setDesc(tr("settings.mobileForceLayout.desc"))
        .addToggle((tg) =>
          tg.setValue(this.plugin.settings.mobileForceLayout).onChange(async (v) => {
            this.plugin.settings.mobileForceLayout = v;
            await this.plugin.saveSettings();
            // Tell the open board (if any) to re-evaluate its layout class
            // immediately, no leaf reopen required.
            this.plugin.refreshOpenViews().catch(() => {/* ignore */});
          }),
        );
    }

    const skillInstall = new Setting(containerEl)
      .setName(tr("settings.skillInstall.name"))
      .setDesc(tr("settings.skillInstall.desc"));
    skillInstall.settingEl.dataset.skillInstall = "true";
    skillInstall.descEl.empty();
    skillInstall.descEl.createSpan({ text: tr("settings.skillInstall.desc") });
    skillInstall.descEl.createEl("code", {
      text: SKILL_INSTALL_COMMAND,
      cls: "task-center-settings-command",
    });

    new Setting(containerEl).setName(tr("settings.cliHeader")).setHeading();
    const cliHelp = containerEl.createDiv({ cls: "setting-item-description" });
    cliHelp.createEl("p", { text: tr("settings.cliHelp") });
    const pre = cliHelp.createEl("pre");
    pre.setText(
      [
        "obsidian task-center:list scheduled=today",
        "obsidian task-center:list scheduled=unscheduled tag='#tag'",
        "obsidian task-center:query-list format=json",
        "obsidian task-center:query-show id=preset-week",
        "obsidian task-center:query-run id=preset-today view=week anchor=2026-05-04",
        "obsidian task-center:query-save dsl='{\"name\":\"工作\",\"view\":{\"layout\":{\"type\":\"list\",\"when\":{\"tags\":[\"#work\"]}}}}'",
        "obsidian task-center:query-update id=sv-alpha dsl='{\"name\":\"工作周\",\"view\":{\"layout\":{\"type\":\"week\",\"when\":{\"status\":[\"todo\"]}}}}'",
        "obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=2026-04-25",
        "obsidian task-center:done ref=Tasks/Inbox.md:L42 at=2026-04-23",
        "obsidian task-center:add text=\"处理示例任务\" tag=\"#tag\" scheduled=2026-04-26",
        "obsidian task-center:stats days=7 group=象限",
      ].join("\n"),
    );
    cliHelp.createEl("p", { text: tr("settings.cliAiNote") });
  }
}
