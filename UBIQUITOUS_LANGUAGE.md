# Ubiquitous Language

> obsidian-task-center 的领域统一语言。一个概念**只用一个**规范名；旧名是要消除的别名。
> 本文是术语事实源——`USER_STORIES.md` / `UX.md` / `ARCHITECTURE.md` / 代码 / i18n / CSS / data-attr 都向它对齐。

## 看板配置（核心漂移区）

| 规范名 | 定义 | 要消除的别名 |
| --- | --- | --- |
| **QueryTab** | 用户保存的、可命名/排序/隐藏/删除的看板配置，在 UI 中呈现为一个 Tab；内含一棵 Area 布局 | `QueryPreset`、`SavedView`、"preset"、"saved view" |
| **builtin QueryTab** | 由插件种入的 QueryTab（今日/周/月/TODO/未排期/已完成/已放弃），可恢复——靠 `builtin: true` 标志区分，**不是单独类型** | `preset`（作为类型名）、"默认视图" |
| **Area** | QueryTab 布局里的一块区域，渲染一组被过滤的任务（list/grid/week/month）或一个落区（drop） | "section"、"pane" |
| **when** | 一个 Area 自己的过滤条件（per-area 查询）；过滤归属 Area，不存在全局 live filter（§0-5a） | "filter"（作 Area 级时） |
| **Layout** | QueryTab 内 Area 的排布（row/col 栈嵌套）| `tab.view` / `preset.view`（"view" 这层包装应去掉，直接 `tab.layout`） |
| **AreaType** | 一个 Area 的种类：`list / grid / week / month / drop / unknown` | `QueryViewType`（与 AreaType 重复，应合并） |

## 查询与过滤（QueryTab/Area 的子部件，**不**属于 Tab 本身）

| 规范名 | 定义 | 要消除的别名 |
| --- | --- | --- |
| **QueryFilters** | 一组过滤条件：search / tags / status / time | `QueryPresetFilters` |
| **QueryStatus** | 状态过滤取值：`todo / done / dropped`（`all` = 不限） | `SavedViewStatus` |
| **QueryTimeField** | 日期字段：`scheduled / deadline / completed / created` | `SavedViewTimeField` |
| **QueryTimeFilters** | 各日期字段的 token 集合 | `SavedViewTimeFilters` |
| **DateToken** | 一个日期过滤值：`today / week / overdue / YYYY-MM-DD / A..B` 等 | — |

## 任务

| 规范名 | 定义 | 要消除的别名 |
| --- | --- | --- |
| **Task** | Markdown 里一行任务（唯一事实源，§0 原则1） | — |
| **ParsedTask** | 解析后的一行任务 + 派生信息 | — |
| **EffectiveTask** | 继承/终态/独立日期子任务派生后的任务 | — |

## 渲染层（"view" 一词的唯一合法归属）

| 规范名 | 定义 | 要消除的别名 |
| --- | --- | --- |
| **Board** | 整个 Task Center 面板（Obsidian `ItemView`） | — |
| **TaskCenterView** | Board 的 `ItemView` 实现（渲染外壳，ARCHITECTURE §7.1） | — |
| **view（保留词）** | **仅**指渲染层（ItemView / 子模块渲染器）。**不得**再指 QueryTab、不得指 Area 类型、不得作 `tab.view.layout` 的包装 | — |

## 关系

- 一个 **Board** 同时持有多个 **QueryTab**，运行时只有一个 active。
- 一个 **QueryTab** 含一棵 **Layout**，Layout 由若干 **Area** 经 row/col 栈嵌套组成。
- 每个 list/grid/week/month **Area** 各自带一份 **when**（= 一组 **QueryFilters**）；过滤就发生在这里（§0-5a：没有 tab 级全局 filter）。
- 一个 **QueryTab** 要么是 **builtin** 要么是用户自建——这是它的**属性**，不是它的**类型**。
- **AreaType** 决定 Area 怎么投影/渲染；它与 `query/areas/` 的 AreaSpec 一一对应（ARCHITECTURE §7.13）。

## 标注的歧义（Flagged ambiguities）

- **一物三名**：`QueryPreset`(252) / `SavedView`(110) / `QueryTab`(UI、data-attr) 指同一个概念。**规范名 = QueryTab**（匹配 UI 的 "Tab"、匹配 US-109u"Tab 是持久 Query"，避开下面两个坑）。
- **"Preset" 是误称**：preset 暗示"出厂固定/预设"，但这东西**用户能建、改名、排序、删**。"内置"应是 `builtin: true` 属性，不是类型名。这是一次没改完的 SavedView→QueryPreset 改名留下的——整体叫 QueryPreset，子字段却仍叫 `SavedView*`，名实自相矛盾。
- **"view" 被重载 3 义**：① `ItemView`/`TaskCenterView`（渲染层）② `preset.view.layout`（看板布局）③ `QueryViewType`（Area 类型，且与 `AreaType` 重复）。**裁决**：view 只保留 ①；② 去掉包装写成 `tab.layout`；③ 合并进 `AreaType`。
- **漂移焊进 5 个层面**，所以这不是一次 sed 能改的：① TS 标识符(~360) ② i18n key `savedViews.*`(254) + `settings.defaultSavedView.*` ③ CSS 类 `bt-saved-view-*` / `bt-*-preset` ④ data-attr `data-saved-views`（注意 `data-query-tab-id` 已是对的）⑤ **持久化字段 `settings.queryPresets`**（data.json 数据契约）。

## 按层 rename 计划（QueryPreset/SavedView → QueryTab）

不能盲 sed（会改坏 i18n key/CSS/data 契约）。按层、各自可独立提交、各自验证：

1. **类型与函数（TS 标识符）**：`QueryPreset*`→`QueryTab*`、`SavedView*`→ 按语义分流（看板级 `SavedViewId/Dirty/Name`→`QueryTab*`；过滤级 `SavedViewStatus/TimeField/TimeFilters`→`QueryStatus/QueryTimeField/QueryTimeFilters`）。**排除字符串字面量**（错误文案、i18n key、CSS、data-attr）。靠 typecheck + 全套单测兜底。
2. **`tab.view.layout` → `tab.layout`**：去掉 "view" 包装（含 `QueryPresetViewConfig`→并入 QueryTab）；`QueryViewType` 合并进 `AreaType`。
3. **持久化字段 `settings.queryPresets` → `settings.queryTabs`** + **data migration**：`loadSettings` 读 `data.queryTabs ?? data.queryPresets ?? []`（沿用既有 `migrateLegacy*` 模式，US-414/415），保证存量用户数据不丢。
4. **i18n key `savedViews.*` / `defaultSavedView.*` → `queryTabs.*` / `defaultQueryTab.*`**：i18n.ts 定义 + 所有 `tr("savedViews.x")` 调用同步改（可机械，靠 i18n 测试兜底）。
5. **CSS 类 `bt-saved-view-*` / `bt-*-preset` → `bt-query-tab-*`** + data-attr `data-saved-views`→`data-query-tab`：同步改 styles + e2e 选择器契约（§7.5：改 data-* 必须同步 e2e）。

每步绿了再下一步；rename 全部完成后，加一条 harness-lint 规则禁止新代码再用 `QueryPreset`/`SavedView`，防回流。

## 示例对话

> **Dev：** 用户在 Tab 条上新建一个 Tab，存的是 **QueryPreset** 还是 **QueryTab**？
>
> **领域专家：** 都别叫 Preset。它就是一个 **QueryTab**——用户自己建、自己命名、能拖着排序。"今日/本周"那几个只是 `builtin: true` 的 **QueryTab**，不是另一种东西。
>
> **Dev：** 那"今日"Tab 里的过滤逻辑放哪？放 Tab 上还是 Area 上？
>
> **领域专家：** 放 **Area** 的 **when** 上。一个 **QueryTab** 是一棵 **Layout**，里面每个 **Area** 各自带 when；没有 tab 级的全局 filter。
>
> **Dev：** 那 `preset.view.layout` 这个 "view" 是啥？
>
> **领域专家：** 那个 "view" 是历史错名——它就是 **QueryTab** 的 **Layout**，写成 `tab.layout`。"view" 这个词只留给渲染层（**TaskCenterView**），别再混用。
>
> **Dev：** 明白了——一个 **Board** 装多个 **QueryTab**，每个 QueryTab 一棵 Layout，Layout 里的 Area 各自 when。
