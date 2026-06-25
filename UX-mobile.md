# UX — Mobile

> 本文是 [UX.md](./UX.md) 的移动端 delta，只写移动端不同或需要额外约束的部分。
>
> 移动端仍以 [USER_STORIES.md](./USER_STORIES.md) 为需求来源；共享对象模型、Query DSL、Task Card 语义、父子继承、CLI 桌面语义、i18n 边界全部沿用 UX.md。

## 0. 移动端原则

1. **触屏不是缩水版鼠标**：移动端没有 hover、右键、拖拽、drop target、跨 tab dwell、键盘快捷键；同一语义走 tap、swipe、long-press、bottom sheet。（US-501 / US-507）
2. **首屏只保留高频对象**：当前 Query Tab、状态摘要、编辑 Query、Quick Add、当前 view 内容；搜索、标签、排期、更多时间、状态、view、summary 配置统一进“编辑 Query”bottom sheet。（US-117）
3. **可触达优先**：常用动作放在屏幕下半区或 bottom sheet 内；触控目标高度不低于 44px。（US-502）
4. **软键盘是布局约束**：Quick Add 与源 Markdown 编辑层必须避让软键盘，不遮挡提交、关闭、输入区域。（US-168g / US-509）
5. **平台文案分支**：移动端不显示 `Ctrl`、右键、拖拽、hover 等桌面提示。（US-510）

## 1. 移动端表面

| Surface | 移动端形态 | 说明 |
| --- | --- | --- |
| Task Center 主视图 | 全屏 WorkspaceLeaf | Obsidian Mobile 内占满当前 leaf |
| Header 状态 | 嵌入主视图 header | 替代桌面状态栏，显示 `📋 N today · ⚠ M overdue`（US-106） |
| Query Tab Strip | 横向滚动 tab 条 + 更多 | tab 是 QueryPreset，不是固定页面名（US-109g / US-109q） |
| Query 编辑 | bottom sheet | 入口必须叫“编辑 Query”或等价对象名（US-109p4 / US-117） |
| Quick Add | bottom sheet | 唯一新增主路径；写入 Daily Note（US-169 / US-509） |
| 卡片动作 | long-press action sheet / swipe | 替代右键、hover、拖拽（US-506~508） |
| CLI | 不在移动端露出 | Obsidian Mobile 不支持 CLI；AI skill 指引只在设置页作为帮助信息（US-501 / US-215） |

移动端不渲染桌面放弃 drop zone，不渲染拖拽目标，不提供跨 tab dwell 进度。

## 2. 主界面布局

```text
┌──────────────────────────────────────┐
│ Task Center        📋 3 · ⚠ 1        │  Header
├──────────────────────────────────────┤
│ [今日][本周][本月][TODO][更多]       │  Query Tab Strip
├──────────────────────────────────────┤
│ 当前 Query 摘要        [编辑 Query]  │  Query Toolbar
├──────────────────────────────────────┤
│ count / sum / ratio / top-N          │  Summary Area（按需出现）
├──────────────────────────────────────┤
│                                      │
│ 当前 view body                       │
│ list / week / month / matrix         │
│                                      │
├──────────────────────────────────────┤
│                          [+]         │  Quick Add FAB / bottom button
└──────────────────────────────────────┘
```

规则：

- Tab 条横向滚动；过多 tab 收进“更多”，仍是完整 Query Tab，不降级为菜单项。（US-109q）
- Tab badge 显示实际渲染顶层卡数；不显示桌面快捷键编号。（US-105 / US-510）
- Header 嵌入 `📋 N today · ⚠ M overdue`；点击不需要再“打开看板”，因为用户已经在看板内。（US-106）
- Toolbar 首屏只放当前 Query 摘要与“编辑 Query”；不把搜索、标签、排期、状态按钮铺满首屏。（US-117）
- Quick Add 入口可为右下 FAB 或底部按钮，但不能与系统 Home indicator / Obsidian 底栏冲突。
- 屏幕 `< 600px` 使用移动布局；`≥ 600px` 使用桌面布局；用户可强制保持移动布局。（US-502）

## 3. Query Tab 移动端管理

### 3.1 切换与更多

- 横向滑动 tab strip 切换可见 tab。
- “更多”打开 bottom sheet，列出溢出的 Query Tab；badge、默认 tab、隐藏状态与桌面一致。点击行 = 切到该 tab，管理动作进 `⋮`。（US-109q）
  - 移动端有意保留 sheet 形态（不用桌面的锚定下拉）：窄屏放不下锚定浮层，且与移动端整体 bottom sheet 心智一致。桌面同一入口改为就地下拉浮层（见 UX.md §「Tab 过多」）。
  - 溢出 tab 的重排不在“更多”里做；排序入口在「管理 Tabs」面板。
- 不显示 `Ctrl/Cmd+1~9` 提示。（US-510）

### 3.2 Tab 菜单

长按 tab 或点击 tab 更多按钮打开 bottom sheet，包含：重命名、复制、编辑 Query、设为默认、左移、右移、隐藏、删除。（US-109n / US-109o）

- 重命名在 bottom sheet 中编辑；Enter 保存时必须守卫 IME composition。（US-413）
- 删除自定义 tab 前提示“只删除这个视图，不删除任何任务”，并提供 toast undo。（US-109r）
- 预设 tab 不能永久删除，只能隐藏；恢复预设在设置页。（US-109l）

### 3.3 未保存改动

移动端用 tab label 的 dirty 标记 + Query toolbar 提示表达未保存改动。编辑 Query sheet 底部固定动作：

- 更新当前 tab。
- 另存为新 tab。
- 丢弃改动。

不提供单独“保存为 tab”；首次保存和复制保存都使用“另存为新 tab”。（US-109c1）

## 4. 编辑 Query Bottom Sheet

入口名固定为“编辑 Query / 编辑当前 Tab”，不能叫“筛选”或“视图”。（US-109p4 / US-109p5）

Sheet 结构：

```text
编辑 Query
├─ Filters
│  ├─ 搜索
│  ├─ 标签
│  ├─ 排期
│  ├─ 更多时间
│  └─ 状态
├─ View
│  ├─ list / week / month / matrix
│  ├─ tray / axis / bucket / sort
│  └─ 空 bucket / 未分组设置
├─ Summary
│  ├─ count / sum / ratio / top-N / group-by
│  └─ 字段选择
└─ DSL
   ├─ 直编
   ├─ 校验错误
   └─ 回退
```

移动端交互：

- Sheet 默认高度约 80% 视口，可拖到全高；内容内部滚动。
- Filters 用分组列表进入二级 sheet，避免首层过长。
- 标签仍是搜索 + 自绘 checkbox 列表，不使用原生 `<select multiple>`。（US-109d）
- 排期 / 更多时间使用移动日历范围选择器；`unscheduled` 仍是 `scheduled is empty`，不是范围。（US-109e）
- 状态 popover 在移动端表现为 checkbox 列表 sheet，支持多选并立即预览。（US-109h）
- DSL 校验失败时在 DSL 区域内展示错误，不覆盖 saved query。（US-109p3）

## 5. 移动端 View 规格

### 5.1 List View

List 移动端为单列满宽卡片列表。（US-103）多段（如今日）是布局树里并列的多个 list area，各自一段，不是一个 list 内部的分组。

适用：今日、TODO、未排期、已完成、已放弃、搜索结果、自定义 tab。

- 今日预设是 col 叠三个 list 区：逾期 / 今日安排 / 未排期推荐，每个区自带 `when`。（US-720）
- “改到明天”是卡片动作按钮或 action sheet 项，写入 `⏳ <tomorrow>`。（US-720c）
- 三组均空时空状态视觉居中，不贴顶。（US-720d / US-720e）

### 5.2 Week View

Week 移动端是 7 行折叠面板，不是 7 列。（US-503）

```text
今天 05-04 · 3 tasks · 2h30m   [展开]
  Task Card
周二 05-05 · 1 task · 25m       [折叠]
...
```

规则：

- 当前日默认展开，其它日期默认折叠。
- Row 顺序遵循周一 / 周日起始日设置。（US-112）
- Row header 显示 `星期 MM-DD · N tasks · XhYm`。（US-116）
- Row body 不是 drop zone；改期走 action sheet → 日期选择器。（US-507）
- 上一周 / 今天 / 下一周用可点击按钮，不依赖键盘。

如果 Query view 开启未排期 tray，移动端在 week rows 下方显示可折叠“未排期”区：

- 数据来源是 tray query。
- 卡片单列满宽。
- 安排到某天通过卡片 action sheet 选择日期。
- 清空排期通过 action sheet；若有效排期来自父级继承，提示编辑源 Markdown 或先移出父级。（US-122a）

### 5.3 Month View

Month 移动端显示“月历 + 日期数字 + 任务数圆点”。（US-504）

- 日期格不渲染完整卡片。
- 点击日期格打开该日任务 list bottom sheet。
- 该日 sheet 中卡片仍使用通用移动卡片和 action sheet。
- 日期格不是 drop target。
- 上月 / 今天 / 下月用可点击按钮。

如果 Query view 开启未排期 tray，tray 位于月历下方，行为同 Week。

### 5.4 Matrix View

Matrix 移动端不强塞二维大表。默认展示为按行轴分组的纵向 bucket 列表：

```text
纵轴 Bucket A
  横轴 Bucket 1
    Task Card
  横轴 Bucket 2
    Empty / Task Card
纵轴 Bucket B
...
未分组
```

规则：

- 保留 axis / bucket 语义和用户命名。（US-103a）
- 每个 bucket 可折叠。
- 未分组区可折叠。
- 允许用户切换“紧凑矩阵预览”，但默认必须可读、可触达。

## 6. 移动端 Task Card

移动端卡片紧凑显示。（US-505）

```text
┌────────────────────────────────────┐
│ [ ] 任务标题              ⏳ 05-05 │
│ #tag · 90m/75m · 📅 05-10          │
│   [ ] 子任务（只显 1 层）           │
│   +3 更多子任务                    │
└────────────────────────────────────┘
```

差异：

- meta 与 tag 合并为一行；空间不足按 tag、用户配置时长字段、deadline 风险顺序保留，其余截断。
- 子任务默认只显示 1 层；更多层级用 `+N` 打开完整子树 bottom sheet。
- 单击卡片打开任务详情 bottom sheet；单击子任务行打开对应子任务详情。源 Markdown 只能从详情或动作 sheet 的“编辑原文”显式进入。（US-168 / US-506 / US-142a）
- 长按卡片打开动作 sheet，不进入 drag mode。（US-506）
- 卡片不是 draggable，不显示 grab / drop target 视觉。（US-501 / US-505）
- overdue / near-deadline 仍有左侧风险条，并配文字 / badge 辅助，不只依赖颜色。（US-115）

## 7. 源 Markdown 编辑层

移动端从任务详情或动作 sheet 的“编辑原文”进入 Obsidian 原生 Markdown 编辑器；单击卡片默认打开任务详情，不直接跳原文。（US-168 / US-506）

移动端额外约束：

- 默认不遮蔽整个任务中心超过必要范围；可用 bottom sheet / panel 形态。
- 内容区可滚动，高度有上限。
- 软键盘弹出时，输入行、关闭按钮、保存状态不可被遮挡。
- Esc 不可用时必须提供可触达关闭按钮和遮罩关闭。
- “在原文中打开/定位”作为显式次级入口保留。（US-168h）

## 8. 移动端动作 Sheet

### 8.1 长按菜单

长按卡片 ≥ 500ms 且未滚动时弹 action sheet。（US-506）

```text
切完成
安排到今天
安排到明天
改期...
清空排期
设为子任务...
编辑 tag
放弃
```

- 外部点击 / 下滑关闭。
- 手指移动超过滚动 / swipe 阈值时取消 long-press。
- 菜单不包含桌面专属说明。

### 8.2 改期

`改期...` 打开日期选择器：

- 快捷项：今天、明天、本周、下周、本月。
- 月历选择单日或范围；卡片改期写入单日 `⏳`。
- 清空排期只清空该任务自己行的 `⏳`。
- 有父级继承排期且自身无 `⏳` 时，清空动作 disabled，并解释原因。（US-122a）

### 8.3 嵌套

`设为子任务...` 打开父任务选择器：

- 标题为“选择父任务”，副标题说明被移动任务。
- 默认不聚焦搜索框，先展示候选分组；搜索只是缩小候选，不是唯一入口。
- 候选分组至少包含当前视图、同文件；有搜索词时显示搜索结果分组。
- 候选任务行显示标题、来源路径 / 行号、`⏳`、tag、子任务数等简短上下文，长标题最多两行。
- 自己和后代 disabled，并解释“不能设为自己的子任务”。（US-126）
- 点候选只选中；底部固定确认按钮提交，并说明“将清空当前任务自己的 `⏳`，然后继承父任务排期”。
- 确认后调用与桌面 / CLI 相同嵌套语义：跨文件移动、清空被移动 root 自己 `⏳`、保留子孙字段、toast undo。（US-125 / US-228 / US-507b）

### 8.4 Swipe

- 左滑卡片 = 完成。
- 右滑卡片 = 放弃。
- 阈值 50% 卡宽；未过半不显示确认反馈，退回阈值内松手取消。
- 触发后 1 秒 toast undo。（US-508）
- 不做 swipe-to-delete。

## 9. Quick Add Bottom Sheet

Quick Add 是移动端唯一新增入口。（US-169 / US-509）

结构：

```text
[单行 input                                      → ⏳ 05-05]
[Today] [Tomorrow] [周六] [下周] [#recent]
↵ Daily/2026-05-04.md
```

要求：

- 打开 sheet 后 input 聚焦，软键盘出现。
- 使用 `visualViewport` 或等价能力避让软键盘。
- 失败时不清空输入。
- 提交成功后保持 sheet 打开，可继续添加下一条。
- Daily Notes 不可用时阻止提交并显示可操作提示，不写 fallback。（US-701）
- 自然语言日期支持中英；无法识别时保持未排期，不猜。（US-410）

## 10. 设置页移动端差异

设置项沿用 UX.md，只强调：

- “强制移动布局”是移动端 / 大屏分屏可用的布局偏好；默认关。（US-502）
- AI skill 安装指引可以显示在设置页，但不能在移动端制造不可用 CLI 按钮或暗示可执行。（US-215 / US-501）
- Query Tab 日常 CRUD 不在设置页，仍在主界面 tab 菜单 / Query 编辑器完成。（US-109n2）

## 11. 空状态、错误态、加载态

- 全 vault 无任务：空状态按钮打开 Quick Add bottom sheet。（US-113）
- 当前 Query 无结果：解释当前条件，并提供“编辑 Query / 清空筛选”。（US-109b）
- 未排期 + week/month 日期区为空：解释未排期任务没有 `⏳`，不会落入日期 row / 日期格；可提示打开 tray 或切 list。（US-104）
- 加载骨架：week 显示 7 个 row skeleton；month 显示月历 skeleton；list 显示卡片 skeleton。
- 错误 toast 从底部出现，但必须避让 Quick Add 按钮、bottom sheet、系统安全区。

## 12. i18n 与文案

移动端沿用 UX.md 的 i18n 规则，并额外要求：（US-510）

- 不显示桌面快捷键、鼠标、右键、拖拽、hover 文案。
- 同一动作按平台渲染不同提示，例如桌面“右键卡片”，移动端“长按卡片”。
- 用户 tag、inline field、emoji、标题字面不翻译。

## 13. 性能与手势约束

移动端性能预算：

| 场景 | 预算 |
| --- | --- |
| 首次打开看板 | 目标 ≤ 2.5s，超时显示骨架 / 进度 |
| 搜索输入 | debounce ≥100ms |
| action sheet 确认后视觉反馈 | ≤150ms |
| swipe 判定 | ≤50ms |
| 未打开看板 | 不触发全量扫描，插件感觉不存在 |

实现约束：

- 使用 CSS media query 和设置项决定布局，不用 user agent 猜测。
- 手势使用 PointerEvent 统一管理 tap / long-press / swipe / scroll 仲裁。
- long-press 与 swipe 互斥；发生滚动即取消 long-press。
- 卡片使用 `touch-action: pan-y`。
- 滚动容器使用 `overscroll-behavior: contain`。
- bottom sheet 软键盘避让使用 `visualViewport.height` 或平台可靠等价能力。
- reduced motion 下动画降到 ≤50ms，但保留状态变化。

## 14. 移动端验收 Checklist

### 布局

- [ ] `< 600px` 走移动布局；`≥ 600px` 走桌面布局；设置可强制移动布局。（US-502）
- [ ] Header 显示 `📋 N today · ⚠ M overdue`。（US-106）
- [ ] Tab strip 横向滚动，更多 tab 在“更多”sheet 中仍保留 badge / 排序 / 默认语义。（US-109q）
- [ ] 首屏只有“编辑 Query”，没有铺满搜索 / 标签 / 排期 / 状态按钮。（US-117）

### Query / Tab

- [ ] Tab 长按菜单支持重命名、复制、编辑 Query、设默认、移动、隐藏、删除自定义 tab。（US-109n）
- [ ] 编辑 Query sheet 支持 Filters / View / Summary / DSL，并能校验回显。（US-109p）
- [ ] 未保存改动可更新当前 tab、另存为新 tab、丢弃；没有单独“保存为 tab”。（US-109c1）

### Views

- [ ] Week 为 7 行折叠面板，今日默认展开，row header 显示 `N tasks · XhYm`。（US-503 / US-116）
- [ ] Month 为日期数字 + 任务数圆点；点击日期只更新月历下方的当天排期区域，不弹 dialog / bottom sheet。（US-504）
- [ ] List / 今日 / 未排期 / 已完成 / 已放弃都是单列可读卡片列表。
- [ ] Matrix 默认纵向 bucket 列表，保留 axis / bucket 语义。（US-103a）
- [ ] Week / Month tray 如启用，显示为下方可折叠未排期区，动作 sheet 安排日期。（US-122a）

### 卡片 / 动作

- [ ] 单击卡片打开任务详情 bottom sheet；编辑原文只从详情或动作 sheet 的显式动作进入。（US-168 / US-506）
- [ ] 卡片不可拖拽；没有 drop target、放弃拖入区、跨 tab dwell。（US-501 / US-507）
- [ ] 改期、清空排期、放弃、嵌套都有显式动作路径。（US-507）
- [ ] 左滑完成、右滑放弃，阈值 50%，1 秒 undo。（US-508）
- [ ] 子任务默认 1 层，`+N` 可打开完整树。（US-505）

### Quick Add / 输入

- [ ] Quick Add bottom sheet 避让软键盘，失败不丢输入，成功后可继续添加。（US-169 / US-509）
- [ ] Daily Notes 不可用时不写 fallback，并给出可操作提示。（US-701）
- [ ] Enter 提交输入守卫 IME composition。（US-413）

### 文案 / 性能

- [ ] 移动端不出现 `Ctrl`、右键、拖拽、hover 等桌面说明。（US-510）
- [ ] zh/en 实时切换，用户数据字面不变。（US-408 / US-409）
- [ ] 未打开看板不全量扫 vault；首次打开超时有骨架 / 进度。（US-404）
