# Obsidian Task Center

[简体中文](https://github.com/CorrectRoadH/obsidian-task-center/blob/main/README.zh-CN.md) / [English](https://github.com/CorrectRoadH/obsidian-task-center/blob/main/README.md)

Task Center 是一个 Obsidian 插件，用日 / 周 / 月看板管理 markdown 任务。

任务仍然留在普通 markdown 里。不建数据库，不发明私有格式。

```markdown
- [ ] 准备发布 #work ⏳ 2026-05-15 📅 2026-05-20 [estimate:: 90m]
    - [ ] 写 release notes [estimate:: 30m]
- [x] 修完回归 ✅ 2026-04-28 [actual:: 45m]
```

![周视图拖拽演示](screenshots/week-drag.gif)

![月视图拖拽演示](screenshots/month-drag.gif)

## 安装

<a href="https://obsidian.md/plugins?id=task-center"><img src="assets/install-button.svg" alt="在 Obsidian 中安装" height="52"></a>

或在 **设置 → 第三方插件 → 浏览** 里搜索安装。

使用前需要：

1. 至少启用一个任务格式 companion：[Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) 或 [Dataview](https://github.com/blacksmithgu/obsidian-dataview)。
2. 启用 Obsidian 内置 **Daily Notes** 核心插件，并配置 "New file location"。Quick Add 会把新任务写入当天 Daily Note。

## 它解决什么

- 全页任务看板：今日、周、月、已完成、未排期。
- 拖拽改排期、变子任务、标记放弃。
- 父子任务卡片，支持排期和状态继承。
- Spotlight 风格 Quick Add，支持中英文自然语言日期。
- 用 `[estimate::]` / `[actual::]` 做估时复盘。
- 移动端布局、长按菜单、滑动动作。
- 面向 agent 的 `obsidian task-center:*` CLI。

## 快速开始

1. 继续在任意 markdown 文件里写普通 checkbox 任务。

   ```markdown
   - [ ] Review PR #work ⏳ today [estimate:: 30m]
   - [ ] Renew passport 📅 2026-05-30
   ```

2. 从 ribbon、命令面板或 `Ctrl/Cmd+Shift+T` 打开 Task Center。
3. 在看板里用 `Ctrl/Cmd+T` 打开 Quick Add。

   ```text
   Review beta feedback #work tomorrow [estimate:: 25m]
   处理发布清单 #3象限 周六 [estimate:: 45m]
   ```

`today`、`tomorrow`、`今天`、`周六` 这类自然语言日期会在写入前解析成 ISO 日期。

## 任务格式

Task Center 读取 Tasks emoji 和 Dataview inline fields 两种格式：

```markdown
- [ ] Tasks emoji ⏳ 2026-05-15 📅 2026-05-20 ➕ 2026-05-01
- [ ] Dataview [scheduled:: 2026-05-15] [due:: 2026-05-20] [created:: 2026-05-01]
```

写入格式由 **设置 → Task Center → 任务格式风味** 控制。

- **Tasks emoji** 写入 `⏳`、`📅`、`➕`、`✅`、`❌` 等字段。
- **Dataview inline fields** 写入 `[scheduled::]`、`[due::]`、`[created::]`、`[completion::]`、`[cancelled::]` 等字段。

拖拽改期、日期选择、Quick Add、CLI 写操作都会使用这个设置。同一行同一字段如果两种格式都存在，Task Center 以 Tasks emoji 为准。

估时复盘使用普通 inline fields：

```markdown
[estimate:: 90m] [estimate:: 1h30m] [actual:: 75m]
```

未知 inline field 和标签会保留。

## CLI

Task Center 注册到 Obsidian 原生 CLI：

```bash
obsidian task-center:list scheduled=today
obsidian task-center:show ref=Tasks/Inbox.md:L42
obsidian task-center:add text="Review launch checklist" tag='#work' scheduled=2026-05-15
obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=2026-05-16
obsidian task-center:done ref=Tasks/Inbox.md:L42 at=2026-04-28
obsidian task-center:review days=7 format=json
```

CLI 输出稳定、适合 grep：任务 id 使用 `path:Lnn`，写操作幂等，变更命令输出 `before` / `after`。

安装配套 AI skill：

```bash
npx skills add CorrectRoadH/obsidian-task-center
```

## 设置

| 设置 | 默认值 | 控制内容 |
| --- | --- | --- |
| 默认视图 | 周 | 打开看板时先显示哪个标签 |
| 每周开始日 | 周一 | 周视图和月历边界 |
| 启动时打开 | 关闭 | Obsidian 启动时是否自动打开看板 |
| 自动打创建日期 | 开启 | 新建任务是否写入创建日期 |
| 任务格式风味 | Tasks emoji | 写 Tasks emoji 还是 Dataview inline fields |
| 强制移动端布局 | 关闭 | 在宽屏上也使用手机布局 |

## License

MIT.
