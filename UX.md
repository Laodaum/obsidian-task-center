# UX

> 本文只描述 Task Center 的界面对象、交互路径、状态反馈与验收边界。
>
> - 产品需求以 [USER_STORIES.md](./USER_STORIES.md) 为准。
> - 技术设计以 [ARCHITECTURE.md](./ARCHITECTURE.md) 为准。
> - 本文不新增需求；每个界面决策都必须能回溯到用户故事。

## 0. 设计原则

1. **Markdown 是唯一事实源**：界面显示和操作都围绕 vault 中的 `- [ ]` 任务行，不创建数据库，不创建 UI 私有任务格式。（US-401 / US-407）
2. **Query 是任务中心的核心对象**：用户看到的是保存下来的 Query Tab；搜索、标签、时间、状态、view、summary 都是在编辑同一份 Query DSL。（US-109t / US-109u）
3. **View 只改变呈现，不改变集合**：`list / grid / week / month` 是布局和操作方式，不是业务分类。（US-100 / US-109k）
4. **界面文案解释对象语义**：入口叫“编辑 Query”，不是泛化的“筛选”；未保存改动、更新、另存为、丢弃必须有不同含义。（US-109p4 / US-109c1）
5. **桌面和移动端语义一致，交互不同**：桌面可以拖拽和快捷键，移动端用 bottom sheet、swipe、动作 sheet 等显式路径。（US-501 / US-507）
6. **保留 Obsidian 体验**：视觉变量、字体、焦点、菜单、编辑器能力尽量使用 Obsidian 原生模式，不引入独立应用感。
7. **字面量不可被 UI 规范化**：用户写入 Markdown 的 tag、inline field、emoji、block id、wikilink anchor、标题文本都原样展示或保留；UI 本地化不改变用户数据。（US-409 / US-411）
8. **控件归属作用对象**：过滤、范围导航这类控件长在它真正作用的那个 area 上，不堆在全局工具栏。一个 tab 有多个 area 时，全局过滤无法回答"作用于谁"。（US-109w）
9. **DSL 能改的，UI 也能改**：`area.when`、布局、title 等在 Query DSL 里可编辑的东西，都必须有等价的图形入口就地编辑，不能只能进 DSL 直编。（US-109y）

## 1. 主界面信息架构

Task Center 主视图从上到下固定为六层对象：

```text
Task Center
├─ Header
│  ├─ 当前状态摘要 / 依赖警告
│  ├─ 状态栏信息入口
│  └─ Quick Add 入口
├─ Query Tab Strip
│  ├─ 已启用预设 tab
│  ├─ 用户自定义 tab
│  └─ 更多 / 隐藏 / 管理入口
├─ Query Toolbar（只剩 tab 级动作，无全局过滤）
│  ├─ 当前 Query 摘要
│  ├─ 编辑 Query
│  ├─ 更新当前 tab / 另存为新 tab / 丢弃改动
│  └─ + 新建（Quick Add）
├─ Summary Area
│  └─ 当前 Query 配置的统计指标
├─ View Body
│  ├─ list / grid（header 自带过滤入口，编辑该 area 的 when）
│  ├─ week / month（自带范围导航）
│  └─ …（row / col 嵌套多个 area）
└─ Context Actions
   ├─ 卡片菜单
   ├─ 桌面拖拽目标
   └─ 移动端动作 sheet
```

设置页只承载全局偏好和恢复动作，不作为日常 Query 编辑工作区。（US-109n2 / US-110 / US-111 / US-112）

## 2. Query Tab Strip

### 2.1 Tab 的对象语义

顶部每个 tab 都是一份保存下来的 `QueryPreset`。tab 有稳定 id；名称、排序、隐藏状态、默认 tab、快捷键目标都不能依赖显示名。（US-109m）

Tab 的运行时状态：

- `saved query`：已保存的 Query DSL。
- `draft`：挂在该 tab 下的未保存改动。
- `effective query`：当前渲染使用的 saved query + draft 合成结果。

界面不出现与 tab 平级的“当前 query / 无过滤”伪入口；恢复语义只表达为“丢弃当前 tab 的未保存改动”。（US-109s1）

### 2.2 默认预设 Tab

默认启用以下预设，全部可隐藏、重排、复制后修改：

| Tab | 视觉目标 | 默认 View | 关键行为 |
| --- | --- | --- | --- |
| 今日 | 回答“今天先做什么” | list + 三个 section | 逾期 / 今日安排 / 未排期推荐；支持“改到明天” |
| 本周 | 安排本周任务负载 | week | 7 天日期区 + 可选未排期 tray |
| 本月 | 查看月度分布 | month | 月历 + 可选未排期 tray |
| TODO | 查看所有待办 | list | 连续任务列表 |
| 未排期 | 处理缺少 `⏳` 的任务 | list | 未排期解释为空集合原因 |
| 已完成 | 复盘完成记录 | list | 按完成时间倒序，显示 summary |
| 已放弃 | 复盘放弃记录 | list | 与完成分开统计 |

“本周 / 本月”的未排期 tray 是日期 view 的可配置附加区域，不是第五种 view，也不改变日期区的集合语义。（US-109j / US-104）

### 2.3 Tab 管理交互

Tab 菜单至少包含：重命名、复制、编辑 Query、设为默认、隐藏、删除。删除只允许用户自定义 tab；预设 tab 只能隐藏并可在设置页恢复。Tab 排序通过拖拽完成，不提供左移 / 右移按钮。（US-109n / US-109l）

- 桌面：双击 label 可 inline rename，但菜单“重命名”必须存在；Enter 保存，Esc 取消；IME composition 期间 Enter 不提交。（US-109o / US-413）
- 移动端：长按或更多菜单打开 bottom sheet 管理。
- Tab 过多：多余 tab 进入“更多”，仍保留排序、badge、快捷键和默认 tab 语义。“更多”面板与下面的「管理 Tabs」用**同一套行 + `⋮` kebab** 版式：一行 = 名称 + 徽标 + 计数小药丸，点击行 = 切到该 tab，管理动作进 `⋮`。它以“快速切换溢出 tab”为主，不再为每个 tab 铺一排按钮。（US-109q）
- 隐藏不删除配置；删除自定义 tab 前提示“只删除这个视图，不删除任何任务”，并提供 toast undo。（US-109r）

**管理 Tabs 面板版式（桌面 / 移动一致）**：面板标题用简洁名词（“Query Tabs”），不冗余加“管理”。每个 tab 压成**一行**，不再为每个 tab 铺开 6-7 个按钮（按钮墙）：

```text
[+ 新建 Tab]  [恢复预设]
────────────────────────────
⠿  Today              预设      ⋮
⠿  Week          默认·预设      ⋮
⠿  我的工作          自定义      ⋮
```

- 行结构：拖拽手柄 `⠿` + 名称 + 徽标（默认 / 预设 / 当前 / 自定义）+ 右侧单个 kebab `⋮`。
- 点击行 = 打开该 tab；双击名称 = 重命名。
- kebab `⋮` 菜单（原生 Menu）：打开 / 编辑 Query DSL / 重命名 / 复制 / 设为默认 / 隐藏（显示）/ 恢复预设（仅预设）/ 删除（仅自定义）。
- 拖拽整行改排序，行为不变（沿用 `text/tab-id`）。
- 遵循 `DESIGN.md` §5.0 动作密度原则与 token 规范。

**Tab Strip 末尾控件**：Tab Strip 是 tab 集合的家，末尾放两个图标按钮——`管理 Tabs`（打开上面的管理面板）和 `设置`（应用 chrome，独立齿轮）。这两类动作不再放进 Query 工具栏（§3.0）。桌面与移动端一致。

### 2.4 未保存改动

当 filters / view / summary 有临时改动时：

- tab label 出现温和 dirty 标记。
- Toolbar 展示“更新当前 tab”“另存为新 tab”“丢弃改动”。
- 切换 tab 时，draft 保留在原 tab 上下文中，不静默丢弃。（US-109s）

保存动作只保留两个用户可理解的语义：

| 动作 | 出现条件 | 结果 |
| --- | --- | --- |
| 更新当前 tab | 当前 effective query 归属某 tab | 覆盖该 tab 的 saved query，id 不变 |
| 另存为新 tab | 当前 effective query 可被保存 | 创建新 tab 并绑定当前 effective query；有来源 tab 时不影响原 tab，无来源 tab 时就是首次保存 |

不再提供单独的“保存为 tab”。它和“另存为新 tab”的用户结果相同，拆开只会让用户被迫理解“这个 query 当前是否归属某 tab”的内部状态。

## 3. Query Toolbar 与编辑器

### 3.0 工具栏组成与组件自带控件

**核心原则：控件归属它真正作用的组件，不堆在全局工具栏。**（US-109w）

两类控件都遵循这一条：

- **时间范围选择器属于视图本身。** 它只在周 / 月这类有时间轴的视图里存在；列表 / 网格视图没有"上一周 / 下一月"的概念。范围导航跟着**组件（area）走**——周组件渲染并拥有自己的 `◀ 周 ▶`，月组件渲染并拥有自己的 `◀ 月 ▶`，切到列表 / 网格时随组件一起消失。
- **过滤（搜索 / 标签 / 排期 / 更多时间 / 状态）属于渲染任务的 area，不属于全局工具栏。** 一个 tab 可以有多个内容 area（四象限 = 4 格，工作/个人并排 = 2 个 list）。全局只有一个过滤入口时，"编辑它作用于下面哪个 area"无法回答。所以每个 `list`/`grid` area 自己拥有、自己渲染、自己管理过滤状态（US-109w / US-109x）。

由此，**顶部 Query 工具栏不再有任何过滤控件**（搜索框、标签 / 排期 / 更多时间 / 待办 chip 全部下沉到 area）。工具栏只剩 tab 级动作：`编辑 Query`、dirty 时的 `更新 / 另存为新 tab / 丢弃`、以及任务主按钮 `+ 新建`。垂直空间进一步省出。

tab 仍可保留一个**共享基础集** `preset.filters`，对所有 area 生效（让今日 / TODO 等内置单 area tab 行为不变），但它不再以全局 chip 形式出现，只能在 DSL / 编辑 Query 面板里改。（US-109z）

移动端的两行规则（日期导航独占一行）见 §6.2，仍然成立。

**动作区按对象归位（不是折叠进 `⋯` 抽屉）**：原来工具栏右侧把 5 个分属不同对象的按钮平铺（另存为新 tab / 编辑 Query DSL / 管理 Tabs / + 新建 / ⚙️）。折叠进一个 `⋯` 只是藏起来、语义没变好。按 `DESIGN.md` §5.0 把每个动作归到它作用的对象：

| 动作 | 作用对象 | 归处 |
| --- | --- | --- |
| `+ 新建`（Quick Add 任务） | 任务 | 工具栏主按钮，始终可见 |
| `更新` / `丢弃` | 当前 Query 草稿 | 工具栏，**仅 dirty 时出现**（§2.4） |
| `另存为新 tab` | 当前 Query 草稿 | 工具栏，**仅 dirty 时出现**（干净状态无需另存；复制干净 tab 走管理面板） |
| `编辑 Query` | 当前 Query | 工具栏常驻按钮，点开是含 DSL / 另存 / 重命名的编辑面板（§3.2） |
| `管理 Tabs` | tab **集合** | 移到 **Tab Strip 末尾**（tab 的家），不在 Query 工具栏 |
| `设置` | 整个应用 | 移到 **Tab Strip 末尾**的独立齿轮（应用 chrome），不在 Query 工具栏 |

结果：Query 工具栏右侧只剩当前-Query 动作 `[编辑 Query]`（dirty 时加 `[更新][另存为新 tab][丢弃]`）+ 任务主按钮 `[+ 新建]`，没有混装抽屉。`data-action`（`save-current-view` / `edit-current-view-dsl` / `manage-query-tabs`）保持真实按钮，e2e 契约不破。

### 3.1 Toolbar 摘要

Toolbar 摘要解释当前 Query 的 **tab 级**配置（共享基础集 `preset.filters`、view、summary），不再罗列各 area 的过滤——后者属于各 area 自己的过滤入口（§4.0）：

```text
基础集 状态:TODO · view:四象限 · summary:count
```

空状态按 area 归因（§4.0 / US-109b1）：不在全局 Toolbar 弹"清空筛选"。某个 area 空时由该 area 自己解释「本区无匹配任务」并提供「清空本区筛选」；整 tab 因基础集天然为空（如未排期 + 周 view）才在 view 层解释。（US-109b / US-104）

### 3.2 编辑 Query 面板（带 Tab）

入口统一叫“编辑 Query”或“编辑当前 Tab”。面板顶部是一排 **Tab**，下面只渲染当前 Tab 的内容，不再把四块从上往下铺成一长条（US-109p6）。四个固定 Tab：

1. **筛选（Filter）**：搜索、标签、状态、排期、更多时间字段。
2. **统计（Summary）**：count、sum、ratio、top-N、group-by。
3. **视图（View）**：类型、section、排序、未排期 tray、布局嵌套。
4. **DSL**：完整 Query DSL 直编（高级模式）。

**筛选 Tab 的对象语义（产品决策）**：面板里的「筛选」Tab 编辑的是 tab 级的**共享基础集 `preset.filters`**（对该 tab 所有 area 生效，让今日 / TODO 等内置单 area tab 不破），不是某个 area 的 `when`。per-area 的 `when` 收窄过滤仍由各 area header 上的过滤漏斗 popover 就地编辑（§4.0 / US-109w/x/y），两者是不同对象，互不取代。这样既给了基础集一个明确的图形入口，又不丢失 per-area 收窄能力。

**面板入口与默认 Tab**：

- 工具栏「编辑 Query」、tab 菜单「编辑 Query」、工具栏当前 Query 摘要：打开面板，默认落在筛选 Tab。
- summary 上的铅笔 / 「+ 添加指标」：打开同一面板，默认落在统计 Tab。
- area header 的过滤漏斗：主路径仍是 header 上就地展开的 popover（编辑该 area `when`），不被取代；面板筛选 Tab 是基础集 `preset.filters` 的图形入口，二者并存。

面板内必须能完成当前 tab 的更新、另存为、重命名、复制、隐藏 / 删除、设默认等相关动作，避免跳到设置页完成 CRUD（“保存与管理”动作区在所有 Tab 下方常驻，不属于任何单个 Tab）。（US-109n1 / US-109n3）

移动端 Query 编辑使用接近全屏的 bottom sheet，而不是居中弹窗。顶部放标题、当前 Query 摘要、Tab 条和关闭 affordance；Tab 条在窄屏可横向滚动或换行，不溢出。Filters 控件在移动端采用两列或单列自适应布局，不能把“标签 / 排期 / 更多时间 / 状态”渲染成占满半屏的四个巨型按钮。View 类型显示为本地化标签：列表、周、月。（US-117 / US-117e）

DSL 直编是独立 Tab，移动端要给它稳定高度和独立滚动空间；用户必须能应用 DSL、看到校验错误，并继续回到同一个 Query draft。（US-109p2 / US-109p3 / US-117e）

**稳定选择器契约**：面板根保留 `data-saved-views` / `data-query-editor`；Tab 条为 `data-query-editor-tabs`，每个 Tab 按钮带 `data-query-tab="filter|summary|view|dsl"`；DSL 输入框保留 `data-query-dsl-input`，统计字段保留 `data-summary-field`，summary 行保留 `data-summary-metric`。切换 Tab 不改变这些钩子的取值。

### 3.3 可视化编辑与 DSL 直编

同一面板提供两个入口：

- **可视化编辑**：默认模式，用控件编辑 DSL。
- **DSL 直编**：高级模式，编辑同一份 tab draft。

切换模式不切换对象。DSL 校验失败时，指出 `filters`、`view` 或 `summary` 的错误位置，不覆盖 saved query；校验成功后必须能回显到可视化控件。（US-109p1 / US-109p2 / US-109p3）

## 4. Filters 交互

Filter 只缩小当前任务集合，不写 Markdown，不改变任务状态。（US-109）

### 4.0 过滤入口归属 area（US-109w / US-109x / US-109y）

过滤入口长在**每个 `list`/`grid` area 自己的 header 上**，不在全局工具栏：

- area header 左侧是它的标题（带计数，`bt-list-area-head`），右侧是一个紧凑的**过滤入口**——一个漏斗 / `⛁` 图标按钮，激活时显示当前条件摘要（如 `#重要 +1 · 状态:TODO`）。
- 点开是同一套控件（搜索、标签、状态、排期、更多时间），但作用域是**这一个 area**。编辑它 = 编辑该 area 的 `when`（US-109x）。`when` 本来就是 DSL 可改的，所以这只是它的图形入口（US-109y：DSL 能改的 UI 也能改）。
- 改动进入当前 tab 草稿，dirty 标记出现；`更新` 写回该 area 的 `when`，`丢弃改动` 回退（§2.4）。
- 单 area tab（今日 / TODO / 已完成 / 未排期）只有一个内容 area，它的过滤入口在视觉上就近似过去的"工具栏过滤"，但对象明确是这个 area，不是含糊的全局。
- 一个 area 没有 `when` 条件时，过滤入口是未激活态（只有图标 / 占位文案）；有条件时高亮并显示摘要。
- `week`/`month` area 的自有控件是范围导航（§3.0），本身不做内容过滤，不挂这个过滤入口。

**空状态按 area 归因**（US-109b / US-109b1）：某个 area 因自己 `when` 没命中而空时，显示中性的「本区无匹配任务」；仅当该 area 有自己的 `when` 条件时，给一个「清空本区筛选」（只清这个 area 的 `when`）。绝不弹出会让用户去清空别处或全局的提示——四象限里 `#不重要` 两格为空是正常分区，不是过滤设错。

下面 §4.1–§4.5 描述各控件的交互细节，这些细节不变；变的只是它们挂在 area 的过滤入口里、写的是该 area 的 `when`。

### 4.1 搜索

搜索输入匹配任务标题关键字；`/` 聚焦当前 area 的搜索框。桌面在 area 过滤入口内展示；移动端收进该 area 过滤的 bottom sheet。（US-166 / US-117）

### 4.2 标签

“标签”按钮 + popover，不使用原生 `<select multiple>`。（US-109d）

- 未选显示“标签”。
- 选 1 个显示该 tag。
- 选多个显示“第一个 tag +N”。
- popover 顶部有搜索框。
- 候选来自当前 query 中除 tag 外的其它条件筛出的任务。
- 每个 tag 显示命中数。
- 已选 tag 即使命中数为 0，也保留到用户取消。
- 多选默认 AND 语义。
- 点击整行切换选中态。

应用层不硬编码任何 tag 名；tag 字面来自 Markdown。（US-108）

### 4.3 状态

“状态”按钮 + popover，选项固定为：全部、TODO、完成、放弃。（US-109h）

- 点击“全部”清空状态条件。
- TODO / 完成 / 放弃允许多选。
- popover 保持打开，选择立即生效。

完成和放弃是不同终态，统计和视觉不能混用。（US-305）

### 4.4 排期

“排期”只筛 `⏳ scheduled`。（US-109e）

Popover 包含：

- 快捷范围：全部排期、今天、明天、本周、下周、本月。
- 日历范围：开始 / 结束闭区间；第二次点早于第一次时自动交换。
- “清空排期范围”。

按钮摘要使用紧凑日期，例如 `04-08 - 04-23`。`unscheduled` 表示 `time.scheduled is empty`，不是范围 token；`overdue` 属于 deadline 风险，不进入排期范围。

### 4.5 更多时间

主栏默认只放排期；其它时间进入“更多时间”。（US-109i）

| 字段 | 用户问题 |
| --- | --- |
| `📅 截止` | 什么快到期 / 已逾期 |
| `✅ 完成于` | 我什么时候完成了什么 |
| `❌ 放弃于` | 我什么时候放弃了什么 |
| `➕ 创建于` | 我什么时候捕捉 / 录入的 |

激活后按钮显示 `时间 +N`。每个字段有自己的范围选择器和清空动作。

## 5. Summary Area

Summary 只计算当前 effective query 的集合，不另起数据源。（US-109 / US-303）

支持的视觉形式：

- count：任务数。
- sum：某 inline field 的时长合计。
- ratio：例如 `sum(actual)/sum(estimate)`。
- top-N：按 tag 或用户配置字段拆分。
- group-by：按用户配置字段聚合。

字段名来自用户配置。`estimate` / `actual` 只是默认约定，不是应用层硬编码方法论。（US-302）

## 6. View Body

### 6.1 List View

List 是一列连续任务卡，适合 TODO、已完成、已放弃、未排期、搜索结果、自定义 tag 等场景。（US-103）

结构：

```text
Query 摘要 / Summary
Section A
  Task Card
  Task Card
Section B
  Task Card
```

支持 section：不分段、按日期、按文件、按 tag bucket、按用户定义规则。默认排序：

- 活动任务：deadline 风险、`⏳`、创建时间。
- 已完成：完成时间倒序。
- 已放弃：放弃时间倒序。

主要操作：打开源 Markdown 编辑层、完成 / 放弃、改期到今天 / 明天 / 自定义日期 / 清空排期、桌面拖拽嵌套、移动端动作 sheet 嵌套。

### 6.2 Week View

Week 把当前 query 命中的任务按有效 `⏳ scheduled` 放入一周 7 天。（US-101）

桌面：7 个日期列。移动端：7 个可折叠日期 row，当前日默认展开。（US-503）

每个日期标题显示：

```text
星期 MM-DD · N tasks · XhYm
```

今日高亮；周一 / 周日为一周第一天影响列序、row 顺序和本周边界。（US-112 / US-116）

移动端 row header 必须把星期、日期、任务数和估时放在同一条可点击区域内。折叠态只显示 header；展开态显示任务卡列表；空日期展开后不出现大块空白区域。

移动端周 / 月工具栏分两行：日期导航独占一行，编辑 Query 与设置等低频入口在下一行。当前周/月范围必须完整可读；如果空间不足，优先压缩低频入口，不压缩日期范围。（US-117d）

可选未排期 tray 位于日期区下方，数据来源是独立 tray query，例如 `status: todo + scheduled is empty`。从 tray 拖到某天写入该任务自己的 `⏳`；从日期列拖回 tray 清空该任务自己行上的 `⏳`。如果有效排期来自父级继承，不能静默改父任务，必须提示用户编辑源 Markdown 或先移出父级。（US-122a）

### 6.3 Month View

Month 把当前 query 命中的任务按有效 `⏳ scheduled` 放入月历日期格。（US-102）

桌面：月历网格，日期格显示任务摘要或紧凑卡片；每个日期格是 drop target。（US-122）

移动端：日期格只显示日期数字和任务数圆点，点击后在月历下方内联显示该日排期列表，不打开 dialog / bottom sheet，不在格内画完整卡片。（US-504）

可选未排期 tray 位于月历下方，语义与 Week 一致。

### 6.4 二维分类（四象限）= 布局组合，不是单独 view（US-103a）

没有 Matrix view 类型。二维分类（如四象限）用 `row` / `col` 嵌套多个带标题的 `grid` area 表达：

- 一个 `col` 套两个 `row`，每个 `row` 两个 `grid`，即 2×2 四象限。
- 每个 `grid` 的 `title` 是象限名，`when` 决定哪些任务落进来（tag / inline field / 时间 / 状态）。
- area 有 `title` 就渲染成带计数的标题头（`bt-list-area-head`）。
- 没被任何格子 `when` 命中的任务，就是不出现——「未分组」由用户 `when` 决定，不是内置概念。

不内置“重要 / 紧急 / 等待 / 下一步”等方法论字面；这些只是用户写在 `title` / `when` 里的名字与条件。（US-301）

**未知 area 类型**：view 配置里写了不被支持的 `type`（笔误，或已删除的 `matrix`）时，该 area 渲染成「未知类型 + 原始 JSON」（`bt-unknown-area`），引导用户修正，而不是静默退化。（US-103c）

## 7. 今日预设 Query

今日是 `list` view 的预设配置，不是第五种 view。（US-720）

默认有三个 section，每组最多 3 个顶层 root task：

| Section | 条件 | 默认排序 |
| --- | --- | --- |
| 逾期 | `deadline < today` | deadline 风险优先 |
| 今日安排 | `scheduled == today` | 排期 / 创建顺序 |
| 未排期推荐 | `scheduled is empty` | deadline 风险 + 创建时间 |

卡片提供“改到明天”动作，写入 `⏳ <tomorrow>` 后任务从默认今日 section 移走。（US-720c）

三组均空时展示“今天没有可执行任务”类空状态；有任务时 sections 不贴顶，首屏有稳定视觉中心。（US-720d / US-720e）

### 7.1 移动端底部安全区

Obsidian Mobile 底部工具栏会覆盖 WebView 底部区域。Task Center 在真实移动端必须额外预留底部可视与可触达空间，适用范围包括：

- View Body 最后一张任务卡、未排期 tray 和空状态。
- 底部移动端操作条。
- Query 编辑、任务操作、父任务选择、日期选择等 bottom sheet。
- sheet 内的 sticky footer 和确认按钮。

窄屏桌面或强制移动布局不等于真实 Obsidian Mobile；只有真实移动端需要为 Obsidian 底部工具栏增加额外避让。所有移动端主操作按钮至少保持 44px 触控高度，并且不能被系统安全区或 Obsidian 工具栏遮住。（US-117c）

### 7.2 父任务选择

移动端“设为子任务”打开父任务选择 sheet。（US-506 / US-117f）

候选项信息层级：

1. 第一行：父任务标题，最多两行，允许长中文自然换行。
2. 第二行：来源文件与行号，弱化显示。
3. 第三行：排期、tag、子任务数等辅助 chip，可换行。

同文件、当前视图、搜索结果分组只帮助用户缩小范围，不改变候选任务语义。不能选择当前任务或它的后代；禁用原因显示在候选项内。确认区固定在 sheet 底部，说明“会清空当前任务自己的 ⏳，并继承父任务排期”，再放确认按钮。（US-117f）

## 8. Task Card 与父子任务

### 8.1 卡片内容

顶层卡片展示：

```text
[checkbox] 标题                         状态/排期 badge
#tag #tag
estimate/actual/deadline 等 meta
  [checkbox] 子任务
    [checkbox] 孙任务
```

规则：

- 顶层卡标题下显示 Markdown 中写的 tag，重复 tag 只显示一次。（US-151）
- 截止已过显示 overdue 风险；3 天内截止显示 near-deadline 风险。（US-115）
- `⏳` badge 只在当前上下文未隐含其排期日时显示：周日期列 / 月日期格内隐藏，历史复盘中显示，未排期 query 不显示。（US-150）
- Tab badge 数 = 切到该 tab 后实际渲染的顶层卡数；父可见时嵌入父卡的子任务不单独计数。（US-105）

#### 8.1.1 完成态视觉（US-152）

已完成卡片的视觉表达统一为「变色 + ✔」，不再使用贯穿删除线：

- 状态图标：左侧 checkbox 位显示 ✔（`statusIcon("done")`）。
- 标题 / 日期 / meta：用降低对比度的 muted 文字色表达"已完成"，**不**对标题、日期或整卡加 `text-decoration: line-through`。
- 整卡：可适度降低不透明度（约 0.7），但必须保证 ✔、标题、排期 / 截止日期仍清晰可读，不能糊成一团。
- 适用范围：主卡 `.bt-card.done`、子卡 `.bt-subcard.done`、周/月小卡 `.bt-mini-card-done` 统一这套表达；三者都去掉删除线。
- 放弃态（✕）等其它终态的现有视觉不受影响。

#### 8.1.2 刚切换状态的卡片停留与延迟消失（US-153）

在一个会按状态过滤的 view 里点 ✔ 切换任务状态时——**无论是 todo→done（在只看 todo 的今日 / TODO / 未排期等里），还是 done→todo（在只看 done 的已完成视图里）**：

- 卡片**不**播放"淡出移除"动画、**不**立即从列表消失；它当场原地变成切换后的显示态（done 走 §8.1.1 的"变色 + ✔"；todo 走普通态），停在原位。
- 这张卡仍可交互：再次点 ✔ 切回、单击查看原文、移动端滑动等。**两个方向对称**——不会出现"完成不消失、取消完成却立刻消失"的别扭。
- 这些"刚切换"的卡片只在用户**重新进入该 view**时才按正常过滤规则消失。重新进入包括：切到别的 tab 再切回、整页重新加载（onOpen）、外部数据变化触发的整表刷新（cache changed → scheduleRefresh）。
- 该"停留豁免"只对本 view 会话内、由用户点 ✔ 而刚切换状态的任务生效；放弃（✕）等其它状态仍按原有"淡出移除"行为处理（US-127）。
- e2e / 渲染契约：处于豁免停留态的卡片带与其当前状态匹配的 `bt-check-${status}`（done 时还带 `done` class），并额外打 `data-just-completed="true"` 标记，便于断言"它还在列表里"。

### 8.2 父子呈现与继承

- 子任务在卡内递归显示所有层级。（US-142）
- 父任务可见时，子任务不作为独立顶层卡重复出现。（US-143）
- 子任务未定义的属性继承父任务；有效 `⏳` 从自己向父级递归查找。（US-144）
- 完成 / 放弃父任务等于整条分支继承终态；已完成子任务作为历史保留。（US-145）
- 已完成 / 已放弃父任务下新增未完成子任务时，界面必须表现它继承父级终态，避免误认为新活动任务。（US-144a）
- 改父级时，子任务自己的 tag、估时、实际耗时、emoji、inline fields 不变。（US-147）

### 8.3 独立日期子任务

如果父任务排到 A：

- 子无 `⏳`：显示在父卡内。
- 子自己的 `⏳` 也是 A：显示在父卡内。
- 子自己的 `⏳` 是 B：在 B 对应 query / view 日期上下文中作为独立顶层卡。（US-148）

子任务 badge 规则按 US-149 执行：父子同日不显示，父子不同日独立子卡显示 `⏳ MM-DD`。

### 8.4 子任务交互

卡片不提供 `+ 子任务` inline 输入；新增、删除、编辑子任务统一通过源 Markdown 编辑层。（US-141 / US-162）

子任务行：

- hover 行体有轻量反馈。
- hover checkbox 有可点击反馈。
- 点击 checkbox 只切换该子任务状态。
- 点击标题 / 行体打开源 Markdown 编辑层并定位到该子任务。
- 桌面子任务行可拖拽，但不长期显示 grab；子任务行不是嵌套 drop target。
- 移动端子任务不拖拽，走动作 sheet。（US-142a）

## 9. 源 Markdown 编辑层

点击普通卡片、今日卡片、搜索结果卡片都进入同一个源 Markdown 编辑能力，并定位到 `task.path:task.line`。（US-168 / US-168a）

该入口取代：hover 上下文预览、双击跳源文件、右键打开源文件、卡片标题 inline input。（US-168d / US-161）

体验要求：

- 桌面端编辑层覆盖在当前 Task Center 上方，背景保持原 tab / filter / scroll 状态。
- 内容是任务所在文件的原文 Markdown，可直接编辑当前任务、子任务和上下文。
- 保存后文件落盘，看板刷新。（US-168b）
- 单击卡片不能只选中；选中态只能作为视觉反馈。（US-168c）
- 桌面端 Esc、右上关闭、点击遮罩都关闭编辑层并回到原状态。（US-168e）
- 桌面编辑层内在“关闭”左侧提供“打开（新标签页）”入口，点击后关闭当前编辑层，在 Obsidian 原生 Markdown 新标签页中打开并定位到同一任务行；这不是桌面默认路径。（US-168h）
- 移动端从任务详情 / 操作 sheet 的“编辑原文”进入 Obsidian 原生 Markdown 编辑器，不在 Task Center 内展示整篇 Markdown 浮层；进入后应定位到任务行，由 Obsidian 原生编辑器处理键盘、安全区和滚动。（US-168g / US-506）
- 移动端首屏 toolbar 不展示搜索框或桌面筛选控件；这些控件统一进入“编辑 Query”bottom sheet。toolbar 自身不得横向滚动或裁切按钮文案，view body 和卡片应贴合可用宽度。（US-117 / US-117a）
- 移动端 Query Tab 条可以左右滑动浏览 tab；它必须固定高度并隐藏纵向 overflow，不得出现 tab 自身上下滚动。移动端 tab 不显示快捷键提示，不提供拖拽排序 / dwell。（US-117b / US-501 / US-510）

视觉验收必须证明它不是整屏 textarea / preview markdown 的开发者工具感，而是可用的 Obsidian-style 编辑体验。（US-168f）

## 10. Quick Add

新增任务主路径只有 Quick Add；移动端形态是 bottom sheet。（US-169 / US-509）

桌面是 Spotlight 风格紧凑命令面板：（US-167）

```text
处理示例任务 #project 明天 [estimate:: 25m]     → ⏳ 05-05
[Today] [Tomorrow] [周六] [下周] [#recent]
↵ Daily/2026-05-04.md                                      Esc
```

要求：

- 单行 input。
- 右侧 inline parse hint。
- quick chips。
- footer 显示实际写入路径与 Esc。
- 支持快速连续输入。
- 支持中英自然语言日期；无法识别时不假设日期，任务保持未排期。（US-410）
- 支持 tag chip 与写入路径预览。
- 失败时不丢输入，成功后保持可继续添加下一条。
- 移动端软键盘不被无谓收起。

新建任务只能写入当天 Daily Note 文件尾：`- [ ] 任务名 ➕ 创建日期`。没有可用 Daily Note 时失败并提示配置 Daily Notes，不写入 inbox / fallback 文件。（US-163 / US-701）

## 10.1 任务格式风味偏好

设置页提供“任务格式风味”选项，默认值为 Tasks。（US-111）

- 读取侧同时兼容 Tasks emoji 与 Dataview bracket inline fields。
- 同一字段两种格式都存在时，界面以 Tasks emoji 为准。
- 偏好为 Tasks 时，Quick Add、拖拽改期、日期选择、完成、放弃和 CLI 写 `⏳/📅/➕/✅/❌` 等 emoji 字段。
- 偏好为 Dataview 时，同一批写操作写 `[scheduled::]`、`[due::]`、`[created::]`、`[completion::]`、`[cancelled::]`。
- 写入某一字段会清理该字段的另一种语法，避免一行任务保留两个互相冲突的日期；清空排期会同时移除 `⏳` 与 `[scheduled::]`。

## 11. 卡片菜单、快捷键与 Undo

### 11.1 卡片菜单

右键卡片菜单包含：（US-164）

```text
切完成
安排到今天
安排到明天
清空日期
编辑 tag
放弃
```

“打开源文件”不作为右键主动作；打开 / 编辑统一通过单击卡片进入源 Markdown 编辑层。

### 11.2 快捷键

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl/Cmd+1~9` | 切换顶部可见前 9 个 tab |
| `/` | 聚焦搜索输入框 |
| `Ctrl/Cmd+Z` | 撤销最近 20 步拖拽 / 改期 / 重命名等看板动作 |

移动端不显示桌面快捷键说明。（US-166 / US-510）

### 11.3 Undo

Undo 覆盖最近 20 步拖拽、改期、重命名等看板写操作。（US-128）

如果文件已被外部修改导致撤销不安全，toast 说明并停止撤销，不猜测合并。

## 12. 桌面拖拽

移动端不提供拖拽、dwell、hover；本节仅桌面。（US-501）

### 12.1 改期

Week：拖到日期列头、列空白处、卡片间隙，都写入或替换该任务自己的 `⏳`。（US-121）

Month：每个日期格都是改期目标。（US-122）

拖回原本同一天是 no-op，不写文件、不 toast、不进 undo。

### 12.2 跨 Tab dwell

拖拽时悬停另一个 tab 一段时间自动切换到该 Query Tab；如果目标 view 提供明确日期目标，松手即可跨 query 改期。（US-114）

### 12.3 未排期 Tray

当 week / month 开启未排期 tray：

- 已排期任务拖回 tray：清空被拖任务自己行的 `⏳`。
- 从 tray 拖到日期目标：写入目标日期 `⏳`。
- 若有效排期来自父级继承，不能静默改父任务。（US-122a）

### 12.4 放弃

拖到底部固定“放弃”目标区，标成放弃，不删除文件，不使用垃圾桶 / 删除心智。（US-123）

放弃父任务时，未完成子任务继承放弃，已完成子任务不变。（US-124）

### 12.5 嵌套

拖到另一张卡上，被拖任务变成目标卡的子任务；跨文件允许。（US-125）

语义：

- 物理移动被操作 task 到目标父任务所在位置。
- 清空被移动任务自己这一行的 `⏳`。
- 让它继承目标父级有效 `⏳`。
- 其它子孙任务自己的 `⏳` / emoji / inline fields 保留。

不能拖到自己或自己的后代上。（US-126）

### 12.6 落点优先级与动画

落点优先级：（US-126a）

1. 非法目标：自己 / 后代。
2. 放弃目标区。
3. 未排期 tray。
4. 任务卡本体。
5. 日期目标。
6. 其它位置：无操作。

卡片从当前位置消失时，淡出并让邻居平滑上移；原地 no-op 不放动画。（US-127）

## 13. 移动端

移动端 breakpoint：屏幕 `< 600px` 走移动布局；`≥ 600px` 走桌面布局；用户可强制保持移动布局。触控目标高度不低于 44px。（US-502）

移动端不支持 CLI、键盘快捷键、拖拽、dwell、hover；不可用功能不露出。（US-501）

移动端 Query Tab 条支持横向 pan 浏览较多 tab；纵向滚动属于页面内容，不属于 tab 条自身。（US-117b）

等价路径：

- 改期：任务详情或动作 sheet → bottom sheet 日期选择器。
- 放弃：右滑或动作 sheet。
- 嵌套：任务详情或动作 sheet → 父任务选择器。
- 完成：左滑卡片，过 50% 卡宽才显示“完成”确认反馈；退回阈值内松手取消，提交后 1 秒 toast undo。
- 放弃：右滑卡片，过 50% 卡宽才显示“放弃”确认反馈；退回阈值内松手取消，提交后 1 秒 toast undo。（US-507 / US-508）

Week 移动端是 7 行折叠面板；当前日默认展开；row header 显示 `星期 MM-DD · N tasks · XhYm`；折叠态不能出现任务列表空白，展开态只随实际卡片内容撑高。（US-503）

Month 移动端是“日历 + 数字 + 任务数圆点 + 下方当天排期”。点击日期格只更新下方当天排期区域，不弹 dialog / bottom sheet。（US-504）

卡片紧凑显示：meta 行合并，子任务默认显 1 层，更多层级用 bottom sheet 展示。单击卡片打开任务详情 bottom sheet；长按 ≥ 500ms 且未滚动时弹更多操作 sheet；“编辑原文”是详情 / 操作 sheet 里的显式动作，不是移动端默认点击行为。（US-505 / US-506 / US-506a）

移动端任务详情 bottom sheet：

- 顶部显示任务标题与来源 `path:Lnn`。
- 用紧凑 meta 行展示 `⏳`、`📅`、estimate / actual 与 tag。
- 主动作区提供完成 / 取消完成、排期 / 改期、清空排期、放弃。
- 更多动作提供编辑 tag、设为子任务、编辑原文。

移动端编辑 tag bottom sheet：

- 显示当前 tag chip；每个 chip 有删除触控区。
- 显示当前任务集合中的候选 tag chip；点按即加入当前任务。
- 支持输入新 tag，但输入框不能是唯一操作路径；Enter 只加入 tag，不直接关闭 sheet。
- 底部固定保存 / 取消动作；软键盘弹出时仍能看到或滚动到主要操作。
- 保存时按增删差异写回，保持 Markdown 中其它 token 原样。（US-506b / US-409）

移动端日期选择 bottom sheet：

- 不出现裸日期输入框。
- 顶部提供今天、明天、后天、本周后续日期等快捷按钮。
- 下方是月份日历；点某一天立即写回该日期。
- 月份可前后切换；写回格式仍是 ISO，但用户不需要键入 ISO。（US-507a / US-411）

移动端父任务选择 bottom sheet：

- 标题为“选择父任务”，副标题说明“把当前任务移动到父任务下”。
- 顶部显示当前被移动任务的短标题与来源，避免用户忘记操作对象。
- 默认展示候选分组，不自动聚焦搜索框；搜索只是缩小候选，不是唯一入口。
- 候选行至少显示标题、来源路径 / 行号、`⏳` / tag / 子任务数等简短上下文；长标题最多两行。
- 当前任务和它的后代显示为 disabled，并解释不能选。
- 点候选只选中；底部固定确认按钮写明目标父任务，例如“设为「复盘」的子任务”。
- 确认区说明提交后会清空被移动任务自己的 `⏳`，并继承父任务有效排期。（US-507b / US-125）

## 14. 设置页

设置页只放全局偏好、默认值、恢复动作、依赖提示。（US-118）

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 启动时自动开看板 | 关 | US-110 |
| 默认 tab | 当前启用 tab 中的一个 | 引用 tab id，不引用名称；US-111 |
| 一周第一天 | 周一 | 影响 week view 与本周边界；US-112 |
| 恢复默认 tabs | 手动动作 | 只恢复系统预设，不删除用户 tab；US-109l |
| AI skill 安装指引 | 文本命令 | `npx skills add CorrectRoadH/obsidian-task-center`；US-215 |

设置页不提供日常 tab 重命名、复制、编辑 Query、排序、隐藏、删除等主工作流。

## 15. 空状态、依赖健康与状态栏

### 15.1 空状态

- 全 vault 没有任务：显示引导“没有任务，按 + 添加”，不能空白。（US-113）
- 某个 `list`/`grid` area 无结果：在**该 area 内部**显示中性的「本区无匹配任务」；仅当该 area 有自己的 `when` 时给「清空本区筛选」（只清这个 area）。不弹全局"清空筛选"。（US-109w / US-109b1）
- `未排期 + week/month view`：解释“未排期任务没有 `⏳`，不会落入日期区”，并提供切到 list 或显示 tray 的动作。（US-104 / US-109b）

### 15.2 状态栏

状态栏一直显示：

```text
📋 N today · ⚠ M overdue
```

点击打开看板；移动端信息嵌入 board header。关闭看板后记住当前 query tab，下次打开停在同一个。（US-106 / US-405）

### 15.3 依赖健康

Daily Notes：

- 未启用：提示“Daily Notes 插件未启用，无法新建任务”，Quick Add / add 命令失败并保留输入。（US-701a）
- 启用但未设置文件夹：提示“Daily Notes 未设置文件夹，无法新建任务”。（US-701b）
- 配置修复后警告自动消失，无需重启。（US-701c）

任务格式 companion：

- Tasks 与 Dataview 都未安装：状态栏展示 `data-dep-warning="task-format-companion-missing"`。（US-701d）
- Tasks 或 Dataview 至少安装了一个但两者都未启用：展示 `data-dep-warning="task-format-companion-disabled"`。（US-701e）
- Tasks 或 Dataview 任意一个正常启用：不显示任务格式 companion 警告。（US-701f）

### 15.4 升级闸门页（全屏）

老用户从 0.8.27 及更早升级、且 `data.json` 里检测到任意旧结构视图时，看板**不直接渲染**，整个 view 先展示一个全屏的升级闸门页。（US-414 / US-415）

旧结构包含两类，任一命中即触发：

- 扁平 `SavedTaskView`（顶层 `search` / `tag` / `time` / `status`）。
- 旧 DSL 的 `QueryPreset`：`filters` 已嵌套，但 `view` 仍是旧写法 `{type, preset, sections, tray, matrix}` 而非新的 `{layout}` 树。

闸门页要点：

- 全屏遮住 tab 栏、工具栏、看板主体；不在残留旧数据的看板之上浮层。理由：保证看板渲染路径只面对一种数据结构，不必同时兼容新旧两种写法。
- 版式为单列卡片，自上而下四段：
  1. 头部——一个 accent 徽标（“升级”）+ 标题“Task Center 已升级”+ 引导句：本版重构了存储方式，下面 N 个视图会**自动迁移**，确认后继续。
  2. 新版变化（What's New）采用 **2×2 Bento 网格**：每个新能力是等大的一格，每格自带一张用纯 CSS 画的小示图，让变化一眼看懂。四格：
     - 可组合布局——示图为「一个宽区域叠一行两个区域」的布局块。
     - 统一查询模型——示图为 `GUI ⇄ { } ⇄ CLI` 三个 chip。
     - 可编辑预设——示图为「一个内置 Tab 被复制成带 ＋ 的预设」。
     - 界面焕新——示图为「带闪光 ✦ 的迷你窗口」，提示看板 / 过滤 / 编辑面板的 UI 重做。
  3. 主按钮“升级并进入看板”紧跟在 Bento 网格下方、居中加大，保证不滚动也能看到，避免被下方较长的视图列表挤出视口。点击后执行迁移并写回 `data.json`、清除闸门、渲染新版看板；按钮按下即禁用，避免重复触发。
  4. 将自动迁移的视图列表——逐条列出本次检测到的旧视图（标题 + `内置` / `自定义` 标签），让用户清楚到底动了哪些视图。名称优先取迁移后的预设名（保留用户重命名），扁平旧视图无名时回退占位名。
  5. 说明——内置视图（重命名 / 隐藏 / 排序）与自定义视图都会**自动迁移并保留**，只改本地配置、不动任务文件。
- 一次性：迁移写回后，下次加载检测不到旧结构，不再出现闸门。若用户没点按钮就关掉 Obsidian，则没有写回，下次仍展示闸门。
- 新用户与已在新结构上的用户永不触发。文案跟随 Obsidian 语言（US-402）。

## 16. CLI / AI Agent UX

CLI 注册到 Obsidian CLI，不提供独立二进制。（US-201）

`obsidian task-center` 是帮助入口，输出可直接复制的命令索引，包含任务读写、Query Tab 管理和 `npx skills add CorrectRoadH/obsidian-task-center`。（US-201a / US-215）

### 16.1 任务读写输出

- `list` 每行第一列是稳定 id，例如 `path:L42` 或 hash。（US-202）
- 写操作幂等；重复完成已完成任务返回 `ok … unchanged`。（US-203）
- 写操作返回 `before / after` 两行 diff。（US-204）
- 输出 human-readable 且 AI 友好，不强制 JSON。（US-205）
- `list parent=<id>` 能筛出某父任务所有子任务。（US-212）

错误格式：

```text
error <code>
<一句人话>
```

code 是固定英文短码；人话跟随语言。（US-211 / US-412）

### 16.2 Query Preset 管理

CLI 能列出、查看、创建、更新、重命名、复制、隐藏、删除、设默认 query tab。目标使用稳定 id；DSL schema 与 GUI 共用。（US-216 / US-217 / US-218 / US-219）

CLI 还要能执行某个 query tab 并按 view 输出结果。（US-220）

- `query-run id=<tab-id>`：按 preset 自己的 view 输出。
- `query-run id=<tab-id> view=list|week|month`：只临时改展示 view，不写回 DSL。
- `week` 输出 7 个日期组；空日也显示计数，便于看负载。
- `month` 默认只输出有任务的日期，避免整月空格噪音；JSON 仍包含完整 cells。
- 所有任务行第一列保留稳定 id，方便继续调用 `show / schedule / done / abandon`。

## 17. 国际化与可达性

### 17.1 i18n

UI 字符串跟随 Obsidian 当前语言实时切换；用户数据不翻译。（US-402 / US-408 / US-409）

- 日期显示跟随 locale。
- 写回文件永远是 ISO `YYYY-MM-DD`。（US-411）
- Quick Add / CLI 自然语言日期至少支持中英两套词汇。（US-410）

### 17.2 可达性

- 所有可点元素可键盘到达。
- 焦点必须可见，不能 `outline:none`。
- 拖拽能力必须有非鼠标等价路径。
- 颜色不能是唯一风险信号；overdue / near-deadline 要有文字或 badge 辅助。
- 支持 `prefers-reduced-motion`，缩短动画但保留状态反馈。

## 18. 视觉约束

- 颜色、字体、阴影、圆角优先使用 Obsidian CSS 变量。
- 不引入第三方 UI 库、图标库、动画库。
- 动效短且服务定位：hover、drag、tab 切换、toast、卡片移除。
- 移动端避免把桌面密集控件硬塞到首屏；首屏保留当前 tab、摘要、编辑 Query、Quick Add 和 view 内容。
