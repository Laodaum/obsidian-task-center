# Obsidian Task Center

[English](./README.md)

Task Center 是一个 Obsidian 插件：在 Obsidian Tasks markdown 之上，增加今日 / 周 / 月任务看板、父子任务渲染、自然语言 Quick Add、移动端手势，以及方便 AI agent 使用的 CLI。

它不创建新数据库，也不发明新任务格式。任务仍然是 markdown：

```markdown
- [ ] 准备发布 #work ⏳ 2026-05-15 📅 2026-05-20 [estimate:: 90m]
    - [ ] 写 release notes [estimate:: 30m]
- [x] 修完回归 ✅ 2026-04-28 [actual:: 45m]
- [-] 放弃旧方案 ❌ 2026-04-28
```

<video src="screenshots/week-drag.mp4" controls muted></video>

<video src="screenshots/month-drag.mp4" controls muted></video>

![Month view](screenshots/month.png)

## 为什么用 Task Center

Obsidian Tasks 负责任务语法和查询模型。Task Center 继续使用这套基础，只补上纯笔记里不太顺手的工作表面：

| 需求 | Task Center 提供 |
| --- | --- |
| 安排一周任务 | 全页看板：今日、周、月、已完成、未排期 |
| 调整计划 | 拖到日期改排期，拖到卡片变子任务，拖到放弃区标记放弃 |
| 管理父子任务 | 递归父子卡片，支持排期 / 状态继承 |
| 快速捕捉 | Spotlight 风格 Quick Add，支持中英文自然语言日期 |
| 复盘估时 | 通过 `[estimate::]` / `[actual::]` 汇总计划与实际耗时 |
| 移动端使用 | 手机布局、长按菜单、滑动动作、避让软键盘 |
| 让 AI agent 帮忙 | 稳定的 `obsidian task-center:*` CLI，输出适合 grep 和自动化 |

## 安装

Task Center 还没有上架 Obsidian 官方 Community Plugins。上架前只推荐用 BRAT 安装：它直接从 GitHub Release 安装并检查更新。

### 前置条件

1. 安装并启用 [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks)。Task Center 读写兼容 Tasks 的 markdown，并把 Tasks 插件视为数据层伙伴。
2. 启用 Obsidian 内置 **Daily Notes** 核心插件，并配置 "New file location"。Quick Add 会把新任务写入当天 Daily Note；如果 Daily Notes 没启用或没配置，Task Center 会拒绝写入，而不是偷偷写到 inbox fallback。

### 用 BRAT 安装

1. 在 Obsidian 打开 **Settings -> Community plugins**。
2. 如果 Obsidian 提示 Restricted Mode，先关闭。
3. 点击 **Browse**，搜索 **BRAT**，安装 **Obsidian42 - BRAT** 并启用。
4. 打开 **Settings -> BRAT**。
5. 选择 **Add Beta Plugin**。
6. 粘贴这个仓库地址：

   ```text
   https://github.com/CorrectRoadH/obsidian-task-center
   ```

7. 等 BRAT 安装最新 release。
8. 回到 **Settings -> Community plugins**，启用 **Task Center**。

### AI Agent Skill
```bash
npx skills add CorrectRoadH/obsidian-task-center
```

## 视图

- **今日**：逾期、今日安排、未排期推荐三组，并提供快捷动作。
- **周**：七列看板，高亮今天，显示每日任务数与估时合计。
- **月**：日历网格，每天都是拖拽落点。
- **已完成**：按周分组的复盘时间线，展示估时与实际耗时。
- **未排期**：按 deadline 和创建顺序排序的任务池。

把卡片拖到某天会改 `⏳`。拖到另一张卡片上会变成子任务。拖到底部放弃区会标记 `[-] ❌`，不会删除源 markdown 行。

## 语法

Task Center 保留 Obsidian Tasks 元数据，例如 `⏳`、`📅`、`🛫`、`➕`、`✅`，并用 `[-] ❌ YYYY-MM-DD` 表示放弃任务。

估时和实际耗时使用 `[estimate:: 90m]`、`[estimate:: 1h30m]`、`[actual:: 75m]` 这类 inline field。标签和未知 inline field 会字节级保留。

## CLI

Task Center 注册到 Obsidian 原生 CLI，不提供额外 wrapper 脚本。

```bash
obsidian task-center:list scheduled=today
obsidian task-center:list scheduled=unscheduled tag='#work'
obsidian task-center:show ref=Tasks/Inbox.md:L42
obsidian task-center:add text="Review launch checklist" tag='#work' scheduled=2026-05-15
obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=2026-05-16
obsidian task-center:done ref=Tasks/Inbox.md:L42 at=2026-04-28
obsidian task-center:review days=7
obsidian task-center:review days=7 format=json
```

CLI 输出适合人和 agent 读：列表行有稳定 id，写操作幂等，变更命令输出 `before` / `after`。

安装配套 AI skill：

```bash
npx skills add CorrectRoadH/obsidian-task-center
```

## Crabbox

仓库已经带好本地 Crabbox 配置，默认走 Blacksmith Testbox 后端做远程验证：

```bash
crabbox warmup
crabbox run -- pnpm run typecheck
crabbox run -- pnpm run test:unit
crabbox run -- pnpm run test:e2e
```

默认配置在 `.crabbox.yaml`，预热 workflow 在 `.github/workflows/blacksmith-testbox.yml`。如果你的 Blacksmith 账号需要显式 org，先 `export CRABBOX_BLACKSMITH_ORG=<your-org>` 再执行 `crabbox warmup`。

## 开发

```bash
pnpm install --frozen-lockfile  # 安装依赖
pnpm run dev                     # 监听并自动重新构建
pnpm run build                   # 生产构建
pnpm run typecheck               # TypeScript 类型检查
pnpm run lint                    # ESLint（仅 src）
pnpm run test:unit               # 408 条单元测试（parser、writer、CLI、cache、query、i18n 等）
pnpm run test:e2e                # WDIO/Obsidian e2e（需要 Obsidian + WebDriverIO）
```

每次提交前的 preflight gate：

```bash
pnpm run typecheck && pnpm run lint && pnpm run test:unit && pnpm run build
```

## License

MIT.
