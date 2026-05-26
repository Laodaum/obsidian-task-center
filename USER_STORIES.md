# 用户故事

> 本文是唯一产品需求来源。它只回答：用户是谁、在什么场景下要完成什么、为什么有价值、成功时界面应该让用户看见什么。
>
> 交互细节与视觉规格写入 [UX.md](./UX.md)；技术边界与模块设计写入 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 0. 产品一句话

Task Center 在 Obsidian 原生 Markdown 任务之上，提供一个可配置的任务中心：

- 普通用户用图形界面查看、筛选、排期、复盘任务。
- 高级用户把常用任务集合保存成 Query Tab。
- AI agent 通过稳定 CLI / Obsidian 命令读写同一批 Markdown 任务。

数据源永远是 Markdown 中的 `- [ ] 任务`。不创建数据库，不发明私有任务格式，不破坏 Obsidian Tasks / Dataview / 纯文本工具的兼容性。

## 1. 任务语法与兼容范围

### 1.1 基础任务

Task Center 识别 Obsidian Markdown 任务：

```md
- [ ] Task A ➕ 2026-04-24 ⏳ 2026-04-24
    - [x] Task C ✅ 2026-04-24
    - [ ] Task B
```

### 1.2 Obsidian Tasks 扩展字段

Task Center 必须兼容这些 Obsidian Tasks 约定：

- `➕` 创建于
- `⏳` 排期
- `📅` 截止
- `✅` 完成于
- `❌` 放弃于
- `🛫` 开始于
- `🔁` 循环任务
- `🔺⏫🔼🔽⏬` 优先级
- `[字段名:: 值]` inline field，例如 `[estimate:: 90m]`、`[actual:: 75m]`
- 合法 Obsidian hashtag，例如 `#project`

### 1.3 字节级保留

`US-407` 即使 UI 暂时不展示某些字段，改名、移动、嵌套、写回时也必须原样保留所有未知 emoji、inline field、tag、block id、wikilink anchor 与用户原文。

`US-409` 用户写在 Markdown 里的字面量绝不翻译、替换、规范化。UI 可以本地化，用户数据不可以。

`US-107` 空标题任务，例如只有 `- [ ]` 的行，应被忽略，不进入任务中心。

## 2. 用户与核心场景

### 2.1 普通 Obsidian 用户

用户已经在 Obsidian 里写任务，希望不用离开 Markdown，就能有一个看板式任务中心。

他们关心：

- 今天先做什么。
- 本周哪天排太满。
- 哪些任务还没排期。
- 哪些任务已经完成或放弃。
- 点开卡片时能回到原文直接编辑。

### 2.2 AI agent 用户

用户希望 Claude Code 这类 agent 能稳定读写任务，不靠解析花哨 UI。

agent 需要：

- 稳定任务 id。
- 可重复执行的写操作。
- 人和机器都容易读的 CLI 输出。
- 能查看和管理 Query Tab 的 DSL。

### 2.3 精力管理用户

用户希望复盘“计划花多久”和“实际花多久”，也希望按自己的方法组织优先级、项目、精力状态。

Task Center 不内置任何方法论。优先级、项目、能量、重要紧急等都只是用户自己的 tag / inline field / query 配置。

## 3. 产品模型

### 3.1 Query 是任务中心的核心对象

一个 Query 定义“看什么任务、怎么展示、怎么算汇总”：

- `filters`：决定哪些任务进入集合。
- `view`：决定这些任务如何摆放、分组、排序。
- `summary`：决定对当前集合计算哪些统计值。

`US-109t` Filter / View / Summary 必须属于同一份 Query DSL。图形界面只是 DSL 的可视化编辑器，不能另造一套状态模型。

### 3.2 Tab 是保存下来的 Query

顶部 Query Tab 不是固定页面名，而是一个可命名、可排序、可隐藏的 Query preset。

- `tab`：一个持久化 Query preset。
- `draft`：挂在当前 tab 上的未保存改动。
- `effective query`：已保存 query 加上 draft 后的当前生效结果。

`US-109u` 产品里没有独立的“当前 query”实体。用户总是在编辑某个 tab 的 query。

`US-109s1` 不允许出现“无过滤 / 当前 query”这类与 tab 平级的伪入口。需要恢复时，语义应是“丢弃当前 tab 的未保存改动”。

### 3.3 View 类型清单

`US-100` V1 只提供四种 view。View 回答的是“同一批任务应该怎样被用户看见和操作”，不是回答“任务属于什么业务分类”。

| View | 长什么样 | 主要用户问题 | 适合谁 |
| --- | --- | --- | --- |
| `list` 列表 | 一列连续任务卡，可按 section 分组 | “我现在有哪些任务 / 搜索结果 / 历史记录？” | 所有人；尤其是快速处理、搜索、复盘用户 |
| `week` 周视图 | 一周 7 天的日期列或日期行，每天放任务卡 | “这周哪天排太满？今天该做哪些？” | 每天安排任务、需要控制工作量的人 |
| `month` 月视图 | 月历日期格，每天显示任务分布 | “这个月任务分布如何？某天有什么安排？” | 做中长期计划、回看节奏的人 |
| `matrix` 矩阵 | 用户自定义二维格子，任务落入 bucket | “我想按自己的方法论分类和取舍任务” | 有自定义优先级、精力管理、项目方法的人 |

TODO、已完成、未排期、今日、搜索结果、工作、个人都不是 view 类型，而是 filters + view + summary 的组合。

`US-109k` View 不改变任务集合，只改变呈现方式、分组、排序和可用操作。

同一个 Query 可以换不同 view：例如 `状态 TODO + 排期本周` 可以用 week 看每天负载，也可以用 list 看连续清单；`状态完成 + 完成于本周` 可以用 list 复盘完成记录，也可以用 week 复盘每天完成分布。

## 4. 主界面信息架构

用户打开 Task Center 后，界面从上到下应当有清楚的对象层级：

1. Header：当前任务中心状态、状态栏入口、Quick Add 入口。
2. Query Tab Strip：切换已保存的 Query。
3. Query Toolbar：展示当前 Query 摘要，并提供“编辑 Query”入口。
4. Summary Area：显示当前 Query 的统计。
5. View Body：按当前 view 展示任务卡。
6. Context Actions：卡片菜单、拖拽目标、移动端动作 sheet。

设置页只处理全局偏好，不承担日常 Query 编辑。

`US-109n2` 设置页不是 Query Tab 的主工作区。重命名、复制、更新、另存为、排序、隐藏、删除、编辑 Query 都应在主界面闭环。

## 5. Query Tab 故事

### 5.1 预设 Tab

`US-109j` 默认提供这些 Query Tab。它们只是出厂 preset，用户可以隐藏、重排、复制后修改。

| Tab | filters | view | summary |
| --- | --- | --- | --- |
| 今日 | `status: todo` | `list`，逾期 / 今日 / 未排期推荐三组 | 无 |
| 本周 | 主集合：`status: todo` + `scheduled: week`；排期 tray：`status: todo` + `scheduled is empty` | `week`，上方 7 天排期区 + 下方未排期 tray | 每天任务数 / 估时 |
| 本月 | 主集合：`status: todo` + `scheduled: month`；排期 tray：`status: todo` + `scheduled is empty` | `month`，上方月历排期区 + 下方未排期 tray | 每天任务数 / 估时 |
| TODO | `status: todo` | `list` | 无 |
| 未排期 | `status: todo` + `scheduled is empty` | `list` | 无 |
| 已完成 | `status: done` | `list`，按完成时间倒序 | count / actual sum / actual-estimate ratio |
| 已放弃 | `status: dropped` | `list`，按放弃时间倒序 | count |

“本周 / 本月”预设的核心用户任务是排期：用户从下方未排期 tray 挑任务，拖到上方某一天，系统写入该任务自己的 `⏳`。未排期 tray 是日期 view 的可配置附加区域，不是第五种 view，也不是把未排期任务硬塞进某个日期格。

实现必须能落成明确 DSL，不能靠显示名写业务分支。

### 5.2 Tab 管理

`US-109g` 用户可以添加、复制、重命名、排序、隐藏、删除自己的 Query Tab。用户 tab 与预设 tab 平级。

`US-109m` 每个 Query Tab 有稳定 id。重命名、重排、隐藏不改变 id。默认 tab、快捷键目标、最近打开 tab 都使用 id。

`US-109n` Tab 菜单至少包含：重命名、复制、编辑 Query、设为默认、隐藏、删除。删除只允许用户自定义 tab。Tab 排序通过拖拽完成，不提供左移/右移按钮。

`US-109q` Tab 过多时，多余 tab 收进“更多”。它们仍是一等 tab，排序、badge、默认 tab、快捷键顺序都按用户配置工作。

`US-109r` 隐藏 tab 不删除配置；删除自定义 tab 前必须说明“只删除这个视图，不删除任何任务”，并提供一次 toast undo。

`US-109l` 预设 tab 不能被永久删除。设置页提供“恢复默认 tabs”，只恢复系统预设，不删除用户 tab。

`US-109o` 重命名 tab 要顺手，但不能只靠双击。桌面双击 label 或菜单“重命名”进入 inline rename；移动端在 bottom sheet 中编辑。Enter 保存，Esc 取消；IME composition 期间 Enter 不提交。名称不能为空；复制 tab 时默认加“副本”等本地化后缀。

### 5.3 保存、更新、另存为

`US-109c` 当用户临时修改当前 tab 的 filters / view / summary 时，界面进入“有未保存改动”状态。

`US-109c1` 两个保存动作语义必须互斥：

- “更新当前 tab”：把当前 effective query 覆盖写回当前 tab，tab id 不变。
- “另存为新 tab”：把当前 effective query 保存成一个新的 tab，不影响原 tab；如果当前查询暂时没有归属 tab，它仍使用同一个动作名，只是不需要复制来源 tab。

产品不再区分“另存为新 tab”和“保存为 tab”。二者对用户结果都是“创建一个新 Query Tab”，拆成两个按钮只会暴露内部状态差异。

`US-109s` 未保存改动要有温和提示。切换 tab 时，draft 保留在原 tab 上下文里，不静默丢失。

## 6. Query 编辑器故事

### 6.1 入口与结构

`US-109p4` 默认入口叫“编辑 Query”，不是“过滤”“视图”或“Tabs”。

`US-109p5` 入口命名必须匹配对象语义。打开整份 query 编辑器时，应叫“编辑 Query / 编辑当前 Tab”。

`US-109p` Query 编辑面板包含三块：

- Filters：搜索、标签、状态、排期、更多时间字段。
- View：类型、section、axis、bucket、排序、空 bucket 显示等。
- Summary：count、sum、ratio、top-N、group-by 等。

`US-109n1` 从 tab 菜单进入“编辑 Query”时，看到的必须是这个 tab 自己的 query；面板内也能完成更新、另存为、重命名、复制、隐藏/删除、设默认等相关动作。

`US-109n3` 主界面必须让用户完成 Query Tab 的完整 CRUD：新建 / 另存为、打开 / 查看、更新 / 重命名 / 复制 / 排序 / 设默认 / 隐藏、删除自定义 tab / 恢复预设 tab。

### 6.2 可视化编辑与 DSL 直编

`US-109p1` 可视化编辑器与 DSL 序列化必须一一对应。UI 能点出的配置必须能保存；导入的配置必须能回显。

`US-109p2` 同一个 query 必须有两种编辑入口：可视化编辑和 DSL 直编。两者编辑同一个 tab draft。

`US-109p3` DSL 直编要校验、回显、可回退。报错时指出是 `filters`、`view` 还是 `summary` 的问题，且不破坏已保存版本。

`US-109f` View 配置不能硬编码业务。section、bucket、axis 名称和匹配条件都来自用户配置或可编辑预设。

## 7. Filter 组件故事

Filter 的目标是帮用户把全库任务缩小到当前要看的集合。Filter 不改 Markdown，不创建任务，不改变状态。

`US-109` Filter 支持搜索、tag、状态、排期、更多时间字段，并影响当前集合与 summary。

### 7.1 搜索

搜索框筛任务标题关键字。

`US-166` `/` 聚焦搜索输入框。

### 7.2 标签筛选

`US-108` Task Center 支持用户用任意合法 hashtag 扩展任务。应用层不允许硬编码任何 tag 名。

`US-109d` 标签控件是“标签”按钮 + popover：

- 未选时按钮显示“标签”。
- 选 1 个时显示该 tag。
- 选多个时显示“第一个 tag +N”。
- popover 顶部有搜索框。
- 选项来自当前 query 中除 tag 外的其它条件筛出的候选任务。
- 每个 tag 显示命中数。
- 已选 tag 即使命中数变 0，也保留到用户取消。
- 多选默认 AND 语义。
- 点击整行切换选中态。
- 不使用原生 `<select multiple>`。

### 7.3 状态筛选

`US-109h` 状态控件是“状态”按钮 + popover，选项固定为：

- 全部
- TODO
- 完成
- 放弃

点击“全部”清空状态条件。TODO / 完成 / 放弃允许多选。popover 保持打开，过滤立即生效。

### 7.4 排期筛选

`US-109e` 排期控件筛 `⏳ scheduled`，不是裸日期输入框。

组件形态：

- 按钮默认显示“排期”。
- popover 包含快捷范围和日历范围选择。
- 快捷范围：全部排期、今天、明天、本周、下周、本月。
- 日历支持开始日期与结束日期闭区间选择。
- 第二次点击早于第一次时，自动交换开始 / 结束。
- 有“清空排期范围”动作。
- 按钮摘要使用紧凑日期，例如 `04-08 - 04-23`。

排期 token：

- `all`
- `today`
- `tomorrow`
- `week`
- `next-week`
- `month`
- `YYYY-MM-DD`
- `FROM..TO`

`unscheduled` 表示缺少有效 `⏳`，属于 `time.scheduled is empty`，不是排期范围 token。

`overdue` 是 deadline 风险，不属于排期范围。

### 7.5 更多时间字段

`US-109i` 其它时间字段必须按用户问题单独命名：

- `⏳ 排期`：我打算什么时候做。
- `📅 截止`：什么快到期 / 已逾期。
- `✅ 完成于`：我什么时候完成了什么。
- `❌ 放弃于`：我什么时候放弃了什么。
- `➕ 创建于`：我什么时候捕捉 / 录入的。

主筛选栏默认只放“排期”。截止、完成于、放弃于、创建于放进“更多时间”。激活后按钮显示 `时间 +N`。

### 7.6 条件解释与空结果

`US-109a` 筛选栏不能只有一个含义不明的“筛选”下拉。每个控件必须说清自己筛什么。

`US-109b` 当前条件必须可解释，例如：

```text
tag:#alpha,#beta · 排期:本周 · 状态:TODO · view:周
```

空结果时必须说明原因：

- 筛选条件导致无结果。
- 当前 view 与 filter 组合天然为空。
- 全 vault 没有任务。

需要提供合适动作，例如“清空筛选”或“切换 view”。

`US-104` 未排期不是单独数据池。未排期 = `time.scheduled is empty`。如果用户保存 `未排期 + 周 view`，空状态必须解释“未排期任务没有 `⏳`，不会落入周日历”。

`US-117` 筛选栏、view 选择与 query tab 要能长期使用。桌面可直接展示高频 Query 工具；移动端首屏只保留“编辑 Query”入口，并在 bottom sheet 中编辑搜索、标签、排期、更多时间、状态。入口不能误命名成“过滤 / 视图”。

`US-117a` 移动端主界面不能出现横向溢出的桌面工具栏。搜索框、标签、排期、状态等密集控件必须收进“编辑 Query”bottom sheet；首屏 toolbar 只保留日期导航、编辑 Query 入口和必要的设置入口。周/月/list 内容区与卡片应占满可用宽度，不能因为 toolbar 横向滚动而让右侧内容被裁切。

`US-117b` 移动端 Query Tab 条可以左右滑动浏览 tab，但它不是纵向滚动区域。tab 条必须固定高度、隐藏纵向 overflow；在 tab 条上竖向滑动不能让 tab 自己上下滚动。移动端 tab 不显示桌面快捷键提示，也不提供拖拽排序 / dwell。

`US-117c` 在 Obsidian Mobile 中，Task Center 的底部内容和主要操作不能被 Obsidian 自带底部工具栏遮挡。用户在任务列表、未排期 tray、Query 编辑面板、父任务选择面板中，都必须能看清并点到最后一行内容和确认按钮。

`US-117d` 移动端周/月工具栏必须优先保证日期导航可读。上一周 / 下一周 / 回到本周、当前日期范围、编辑 Query、设置入口不能挤在同一条窄行里导致日期截断或按钮互相压缩；低频操作可以换行或收进面板。

`US-117e` 移动端 Query 编辑面板可以接近全屏，但不能看起来像被裁掉的大号桌面弹窗。它必须用移动端 sheet / 全屏式布局承载 Filters、View、Summary、DSL 和保存管理动作；每个区块要有明确层级，View 类型使用本地化标签。

`US-117f` 移动端父任务选择必须优先展示候选任务标题。来源文件、行号、排期、tag、子任务数属于次要信息，必须弱化并允许换行；确认按钮和“会清空当前任务自己的 ⏳”这类后果说明必须固定在可触达区域内，不能被底部工具栏遮挡。

## 8. View 故事

### 8.1 List View

`US-103` 列表 view 把当前 query 命中的任务渲染为一列连续任务卡。它是最通用、最容易理解的 view，适合 TODO、已完成、已放弃、未排期、搜索结果、自定义 tag 等场景。

它长这样：

- 上方是当前 query 摘要与 summary。
- 主体是一列任务卡。
- 任务卡可以被 section 标题分隔。
- 每个 section 可以有自己的空状态、排序和数量限制。

它服务的用户问题：

- 普通用户想快速扫一遍“现在有什么要处理”。
- 用户搜索后想看到匹配任务，而不是被迫进入日历。
- 用户复盘已完成 / 已放弃任务时，想按时间倒序阅读历史。
- 用户查看未排期任务时，想知道下一件最该挑起来的任务。

列表 view 支持 `sections`：

- 不分段
- 按日期分段
- 按文件分段
- 按 tag bucket 分段
- 按用户定义规则分段

默认排序：

- 活动任务：先按 deadline 风险，再按 `⏳`，再按新加入时间。
- 已完成：按完成时间倒序。
- 已放弃：按放弃时间倒序。

列表 view 提供的主要操作：

- 打开任务源 Markdown 编辑层。
- 勾选完成 / 放弃。
- 改期到今天、明天、自定义日期或清空排期。
- 在桌面端拖拽嵌套；在移动端通过动作 sheet 嵌套。

### 8.2 Week View

`US-101` 周 view 把当前 query 命中的任务按有效 `⏳ scheduled` 放入一周 7 天。

它长这样：

- 桌面端是 7 个日期列。
- 移动端是 7 个可折叠日期行。
- 每天都有日期标题、今日高亮、任务数与估时合计。
- 移动端日期行折叠时只显示 header；展开时只在有任务时撑开卡片列表，空日期不能留下大块空白。
- 任务卡放在对应日期下。
- 当 query / preset 开启排期 tray 时，日期区下方出现“未排期”区域，显示可拖入本周的任务。

用户需要看到：

- 今日高亮。
- 每天有哪些任务。
- 哪天任务太多。
- 上一周 / 下一周切换。

桌面是 7 个日期列；移动端是 7 个日期 row。两者的日期归属、任务计数、估时合计、改期结果必须一致。

`US-116` 每天显示 `N tasks · XhYm`。桌面显示在日期列顶部；移动端显示在 row header。

`US-112` 周一 / 周日为一周第一天会影响周 view 列序、移动端 row 顺序与本周边界。

它服务的用户问题：

- 普通用户想知道“这周哪天塞太满”。
- 用户想把未排期任务安排到本周某一天。
- 做精力管理的人想比较每天计划估时。
- 用户拖拽排期时，需要把任务直观移动到某一天。
- 用户复盘时，也可以用 week 看完成 / 放弃任务在一周内的分布。

周 view 提供的主要操作：

- 上一周 / 下一周切换。
- 桌面拖拽任务到日期列改 `⏳`。
- 桌面从未排期 tray 往上拖到某天，给任务写入该天 `⏳`。
- 桌面从日期列拖回未排期 tray，清空该任务自己这一行的 `⏳`。
- 桌面拖拽到另一张任务卡上做嵌套。
- 移动端不拖拽，改期和嵌套走动作 sheet。

周 view 的边界：

- 只按有效 `⏳ scheduled` 归组，不暗含 TODO 状态。
- 没有有效 `⏳` 的任务不会出现在日期列里，除非它继承了父任务排期。
- 未排期 tray 是附加区域，数据来源是单独的 tray query，例如 `status: todo + scheduled is empty`；它不改变周日期区的集合语义。
- 用户自定义 week query 时，可以选择显示或隐藏未排期 tray，也可以配置 tray 的 filter 与排序。
- `本周` 是 filter，不是 view；任何 query 只要 view 选 week，都用同一套周布局。

### 8.3 Month View

`US-102` 月 view 把当前 query 命中的任务按有效 `⏳ scheduled` 放入月历日期格。用户可以切换上月 / 下月。

它长这样：

- 主体是一个月历网格。
- 每个日期格显示日期数字与当天任务概览。
- 桌面端日期格里可以显示紧凑任务卡或任务摘要。
- 移动端日期格只显示任务数圆点，点击后在月历下方显示该日排期，不打开遮挡月历的弹窗。
- 当 query / preset 开启排期 tray 时，月历下方出现“未排期”区域，显示可拖入本月的任务。

`US-504` 移动端月 view 显示“日历 + 数字 + 任务数圆点”，点击日期格后在月历下方内联显示该日排期列表，不打开 dialog / bottom sheet，不在格内画卡片。

它服务的用户问题：

- 用户想看一个月内任务分布，而不是只看这一周。
- 用户想提前发现某些日期堆了太多任务。
- 用户想把未排期任务安排到这个月的某一天。
- 用户想回看某月完成 / 放弃任务分布。
- 用户想从月历上点进某一天处理任务。

月 view 提供的主要操作：

- 上月 / 下月切换。
- 桌面拖拽任务到日期格改 `⏳`。
- 桌面从未排期 tray 往上拖到某个日期格，给任务写入该日 `⏳`。
- 桌面从日期格拖回未排期 tray，清空该任务自己这一行的 `⏳`。
- 点击日期查看该日任务。
- 任务卡仍可打开源 Markdown 编辑层。

月 view 的边界：

- 只按有效 `⏳ scheduled` 落到日期格。
- 未排期 tray 是附加区域，数据来源是单独的 tray query，例如 `status: todo + scheduled is empty`；它不改变月历日期格的集合语义。
- 用户自定义 month query 时，可以选择显示或隐藏未排期 tray，也可以配置 tray 的 filter 与排序。
- 月 view 不等于“本月 tab”；`本月` 只是一个默认 filter。
- 移动端不在日期格里塞完整卡片，避免小屏拥挤。

### 8.4 Matrix View

`US-103a` 矩阵 view 把任务放进用户配置的二维矩阵。

矩阵只知道 axis / bucket，不知道业务含义。

它长这样：

- 主体是二维表格。
- 横轴和纵轴由用户命名。
- 每个格子是一个 bucket，里面放匹配任务卡。
- 没命中任何格子的任务进入“未分组”区。

用户可以配置：

- 横轴名称。
- 纵轴名称。
- bucket 名称。
- 每个 bucket 匹配哪些 tag / inline field / 时间 / 状态条件。
- 未命中任务进入“未分组”。
- 同一任务命中多个格子时，默认放入第一个匹配格；用户可选择允许重复显示。

它服务的用户问题：

- 用户想按自己的优先级方法取舍任务。
- 用户想用“重要 / 紧急”“精力高 / 精力低”“工作 / 个人”等自定义维度看任务。
- 用户想把 tag、inline field、状态或时间条件映射成自己的格子。

矩阵 view 提供的主要操作：

- 打开任务源 Markdown 编辑层。
- 在格子内处理完成 / 放弃 / 改期。
- 调整 axis、bucket、匹配条件和排序。
- 查看未分组任务，补充 tag / field 或调整 bucket 条件。

矩阵 view 的边界：

- 应用层不能硬编码任何方法论字面量。
- “重要”“紧急”“等待”“下一步”等都只是用户配置里的显示名。
- 矩阵不改变任务集合，只改变任务被分到哪些格子里。

## 9. 今日预设 Query

`US-720` 今日预设 Query 回答“今天先做什么”。它使用列表 view + 三个可编辑 section，不是独立 view 类型，也不是固定方法论。

### 9.1 入口

`US-720a` 默认有“今日” Query Tab。点击后出现今日容器。用户可以复制它并改成自己的“今天工作”“今天个人”等 tab。

### 9.2 三组默认列表

`US-720b` 今日预设默认有三个 section，每组最多 3 个顶层 root task：

- 逾期：deadline < today。
- 今日安排：scheduled == today。
- 未排期推荐：scheduled is empty，按 deadline 风险和创建时间排序。

这些 section 是可编辑 view 配置，不是硬编码的唯一今日方法论。

### 9.3 今日卡片动作

`US-720c` 今日卡片有“改到明天”动作。点击后写入 `⏳ <tomorrow>`，任务从今日默认 section 移走。

### 9.4 空状态

`US-720d` 三组均无任务时，今日容器展示“今天没有可执行任务”一类空状态，而不是空白页面。

`US-720e` 今日面板首屏要有稳定视觉中心；有任务时 sections 不贴顶堆在第一行。

## 10. Task Card 与父子任务

### 10.1 卡片基本展示

`US-151` 顶层 Task Card 必须在标题下方显示任务 Markdown 中写的 tag。重复 tag 只显示一次。

`US-115` 截止已过的卡显 overdue 风险；3 天内截止显 near-deadline 风险。

`US-150` 顶层卡的 `⏳` badge 只在当前渲染上下文未隐含其排期日时显示：

- 周 view 的日期列内隐藏。
- 月 view 的日期格内隐藏。
- 历史复盘 query 中显示。
- 未排期 query 不显示。

`US-105` Tab badge 数 = 切到该 tab 后实际渲染的顶层卡数。父可见时嵌入父卡的子任务不单独计数。

### 10.2 父子任务继承

`US-142` 子任务在卡里递归显示所有层级。

`US-143` 父任务可见时，子任务不作为独立顶层卡重复出现。

`US-144` 子任务未定义的属性继承父任务。有效 `⏳` = 自己写了就用自己的；自己没写就向父级递归继承；一路都没有才是未排期。

`US-145` 完成或放弃父任务，等于自动完成 / 放弃整条分支。已完成子任务作为历史保留。

`US-144a` 在已完成 / 已放弃父任务下面新增未完成子任务时，界面必须明确表现它继承父级终态。不能让用户误以为它是新的活动任务。

`US-146` 和父级同一天创建的子任务，不重复写 `➕ 创建日期`。

`US-147` 改父级时，子任务的 tag、估时、实际耗时、emoji、inline fields 不变。

### 10.3 独立日期子任务

`US-148` 同一执行上下文一起显示，独立日期拆出去。

如果父任务排到 A：

- 子任务没有自己的 `⏳`：显示在父卡内。
- 子任务自己的 `⏳` 也是 A：显示在父卡内。
- 子任务自己的 `⏳` 是 B：在 B 对应的 query / view 日期上下文中作为独立顶层卡。

`US-149` 子任务 `⏳` badge 规则：

- 父子都有相同 `⏳`：不显示。
- 父子有不同 `⏳`：独立子卡显示 `⏳ MM-DD`。
- 父无 `⏳` / 子有 `⏳`：子任务作为独立顶层卡。
- 子无 `⏳` / 父有 `⏳`：子继承父，不显示 badge。

### 10.4 子任务交互

`US-141` 卡片不提供 `+ 子任务` inline 输入。新增、删除、编辑子任务统一通过源 Markdown 编辑层完成。

`US-162` GUI 不再有 Task Card 内 `+ 子任务` 或子子任务 inline 创建器。CLI / API 可以保留 parent 写入能力给 agent / 自动化使用，但不作为卡片 UI 主路径。

`US-142a` 子任务行需要 hover、独立状态操作与低噪音拖拽体验：

- hover 行体时显示轻量反馈。
- hover checkbox 时显示可点击反馈。
- 点击 checkbox 只切换该子任务状态。
- 点击标题 / 行体打开源 Markdown 编辑层并定位到该子任务。
- 桌面子任务行可拖拽，但默认不长期显示 grab。
- 子任务行不是嵌套 drop target。
- 移动端子任务不拖拽，走动作 sheet。

## 11. 编辑、新建与快捷操作

### 11.1 源 Markdown 编辑层

`US-168` 点击 Task Card 进入源 Markdown 编辑能力，并定位到 `task.path:task.line`。用户可以直接编辑该任务、子任务和上下文。桌面端在当前 Task Center 上方打开源 Markdown 编辑层；移动端从详情 / 操作 sheet 的“编辑原文”显式动作进入 Obsidian 原生 Markdown 编辑器，并定位到任务行。

这个入口取代：

- hover 上下文预览。
- 双击跳源文件。
- 右键打开源文件。
- 卡片标题 inline input。

`US-168a` 普通卡片、Today 卡片、搜索结果卡片都走同一源 Markdown 能力；移动端卡片单击先进入任务详情，不直接进入原文。

`US-168b` 编辑并保存后，文件落盘，任务中心刷新。

`US-168c` 单击卡片不能只选中；选中态只能作为视觉反馈。

`US-168d` 旧 hover popover、卡片双击打开源文件、右键菜单打开源文件对应实现必须删除。同一能力统一由源 Markdown 编辑层承担。

`US-168e` 桌面端 Esc、右上关闭、点击遮罩都能关闭编辑层，并回到原 tab / filter / scroll 状态。移动端使用 Obsidian 原生导航返回 Task Center。

`US-168f` 视觉验收必须提供桌面与移动证据，证明它不是整屏 textarea / preview markdown 的开发者工具感，而是可用的 Obsidian-style 编辑体验。

`US-168g` 移动端不在 Task Center 内嵌完整 Markdown 编辑浮层，不用 textarea 或自制 preview 冒充编辑器；必须调用 Obsidian 官方 workspace / MarkdownView 编辑能力打开源文件、定位任务行，并交给 Obsidian 原生编辑器处理键盘、安全区和滚动。

`US-168h` 桌面编辑层内提供“打开（新标签页）”入口，用 Obsidian 原生 Markdown 标签页打开并定位到同一任务行。它是用户主动选择，不能取代桌面默认当前页编辑层；移动端该入口本身就是原生打开原文。

`US-161` 标题改名不再走卡片 inline input。用户在源 Markdown 编辑层改原文。

### 11.2 Quick Add

`US-169` 新增任务主路径只有 Quick Add / 移动端 bottom sheet，不再散落多个小入口。

新增体验必须支持：

- 快速连续输入。
- 自然语言日期。
- tag chip。
- 写入路径预览。
- 失败时不丢失输入。
- 提交成功后保持可继续添加下一条。
- 移动端软键盘不被无谓收起。

`US-167` Quick Add 是 Spotlight 风格紧凑命令面板：

- 单行 input。
- 右侧 inline parse hint。
- quick chips。
- footer 显示实际写入路径与 Esc。
- 桌面约 540×240px。
- 移动端为 bottom sheet。

`US-163` 新建任务只能写入当天 Daily Note 文件尾：`- [ ] 任务名 ➕ 创建日期`。没有可用 Daily Note 时，新建失败并提示配置 Daily Notes。不允许写入 inbox / fallback 文件。

### 11.3 卡片菜单与快捷键

`US-164` 右键卡片弹菜单，包含：切完成、安排到今天 / 明天、清空日期、编辑 tag、放弃。打开源文件不作为右键主动作。

`US-166` 全局快捷键：

- `Ctrl/Cmd+1~9` 切换顶部可见前 9 个 tab。
- `/` 聚焦搜索输入框。

`US-128` `Ctrl/Cmd+Z` 撤销最近 20 步拖拽 / 改期 / 重命名。

## 12. 桌面拖拽故事

### 12.1 拖拽改期

`US-121` 桌面 week view 中，把卡拖到某天日期目标，写入或替换该任务自己的 `⏳`。

日期目标包括：

- 日期列头。
- 日期列空白处。
- 卡片之间的列内空隙。

拖回原本同一天是 no-op，不写文件、不弹 toast、不进 undo。

`US-122` 桌面 month view 中，每个日期格都可以作为改期目标。

`US-114` 桌面拖拽过程中，悬停在另一个 tab 上一会儿，应自动切换到那个 Query Tab；如果目标 tab 的 view 提供明确日期目标，松手即可跨 query 改期。移动端不提供拖拽 / dwell，走显式动作路径。

`US-122a` 当 week / month view 开启未排期 tray 时，tray 是明确 drop target。把已排期任务拖回 tray，清空被拖任务自己这一行的 `⏳`；若任务的有效排期来自父级继承而不是自己这一行，拖回 tray 不能静默改父任务，必须提示用户先移出父任务或编辑源 Markdown。把未排期 tray 中的任务拖到日期目标，写入目标日期 `⏳`。移动端等价操作是动作 sheet 中的“清空排期 / 安排到某天”。

### 12.2 拖拽放弃

`US-123` 桌面把卡拖进底部固定“放弃”目标区，标成放弃，不从磁盘删除。UI 不使用垃圾桶 / 删除心智。

`US-124` 放弃父任务时，未完成子任务继承放弃状态，已完成子任务不变。

### 12.3 拖拽嵌套

`US-125` 桌面把一张卡拖到另一张卡上，它变成目标卡的子任务。跨文件也允许。完成后 toast 说明，并提供 undo。

嵌套语义：

- 物理移动被操作 task 到目标父任务所在位置。
- 清空被移动任务自己这一行的 `⏳`。
- 让它继承目标父级的有效 `⏳`。
- 其它子孙任务自己的 `⏳` / emoji / inline fields 保留。

`US-126` 不能把任务拖到自己或自己的后代上。

### 12.4 落点优先级与动画

`US-126a` 桌面拖拽落点优先级固定：

1. 非法目标：自己 / 后代。
2. 放弃目标区。
3. 未排期 tray：清空被拖任务自己这一行的 `⏳`。
4. 任务卡本体：嵌套。
5. 日期目标：改期。
6. 其它位置：无操作。

`US-127` 卡片从当前位置消失时，应淡出并让邻居平滑上移。原地 no-op 不放动画。

## 13. 移动端故事

移动端遵循桌面语义，但不用桌面交互硬套触屏。

`US-501` 移动端不支持 CLI、键盘快捷键、拖拽、dwell、hover。不可用功能不应在移动端露出。

`US-502` 屏幕 ≥ 600px 走桌面布局，< 600px 走移动布局；用户可强制保持移动布局。触控目标高度不低于 44px。

`US-503` 移动端 week view 是 7 行折叠面板。当前日默认展开。row header 显示 `星期 MM-DD · N tasks · XhYm`；折叠态只占 header 高度，展开态只随任务卡内容撑高，空日期不保留大块空白。

`US-505` 移动端卡片紧凑显示：meta 行合并，子任务默认显 1 层，更多层级用 bottom sheet 展示。卡片不是 draggable。

`US-506` 长按卡片 ≥ 500ms 且未滚动时，弹移动端操作 sheet。单击卡片在移动端打开任务详情 bottom sheet；源 Markdown 编辑层只能由详情或操作 sheet 中的“编辑原文”显式进入。

`US-506a` 移动端任务详情 bottom sheet 是卡片的默认入口，展示标题、来源、排期、截止、标签与关键动作。常用动作必须能在详情中完成：完成 / 取消完成、排期 / 改期、清空排期、放弃、编辑 tag、嵌套、编辑原文。它不能默认把用户带到整块 Markdown 编辑界面。

`US-506b` 移动端编辑 tag 不是单个裸输入框。用户必须能在同一个 bottom sheet 中看到当前 tag、点按删除已有 tag、点按候选 tag 添加、手动输入新 tag，并用明确的保存 / 取消结束；触控目标不低于 44px，软键盘弹出时操作区仍可用。

`US-507` 移动端不提供任务拖拽，必须提供显式等价路径：

- 改期：任务详情或动作 sheet → 点选式日期选择器。
- 放弃：右滑或动作 sheet。
- 嵌套：任务详情或动作 sheet → 父任务选择器。

`US-507a` 移动端排期 / 改期不能要求用户手动输入 `YYYY-MM-DD`。日期选择必须是 bottom sheet 中的快捷日期与日历点选；写回仍使用 ISO `⏳ YYYY-MM-DD`，但输入过程是触控选择。

`US-507b` 移动端父任务选择器不能只是“搜索框 + 长文本列表 + 点一下立即提交”。用户需要先确认自己正在把哪个任务移到哪个父任务下面。选择器必须：

- 默认显示推荐父任务候选，不强制先输入搜索。
- 候选按上下文分组，例如当前视图、同文件、最近上下文或搜索结果。
- 每个候选显示任务标题、来源路径 / 行号、关键 meta，并在标题过长时保持可读。
- 自己和后代候选不可提交，并说明“不能设为自己的子任务”。
- 点候选只进入选中态；用户通过明确确认按钮提交。
- 提交前说明嵌套结果：被移动任务会清空自己的 `⏳`，并继承目标父任务的有效排期。
- 提交后提供 toast undo。

移动端嵌套语义与桌面 US-125 / CLI US-228 完全一致。

`US-508` 左滑卡片 = 完成，右滑卡片 = 放弃。阈值为 50% 卡宽。未过半时不显示操作反馈也不提交；滑过半时显示明确动作提示，手指退回阈值内再松手则取消；提交后提供 1 秒 toast undo。

`US-509` Quick Add 在移动端是 bottom sheet，软键盘弹出时自动避让。

`US-510` UI 文案要按平台分支。移动端不显示桌面快捷键 / 鼠标操作说明。

## 14. 设置页故事

设置页只放全局偏好、默认值、恢复动作、依赖提示。不放日常 Query 编辑。

`US-110` 设置“启动时自动开看板”，默认关。

`US-111` 设置“默认 tab”，候选来自当前启用的预设 tab 与用户自定义 tab。

`US-112` 设置“周一 / 周日为一周第一天”。

`US-118` 设置页只保留仍有用户故事支撑的项。删除旧设置项时，旧 `data.json` 字段可以被忽略，但不能导致插件启动失败。

`US-215` 设置页提供 AI skill 安装指引，展示可复制命令：

```text
npx skills add CorrectRoadH/obsidian-task-center
```

该入口只是帮助，不在移动端制造不可用 CLI 功能。

## 15. 空状态、状态栏与依赖健康

### 15.1 空状态与状态栏

`US-113` vault 一条任务都没有时，看板显示空状态引导“没有任务，按 + 添加”，不能空白。

`US-106` 状态栏一直显示 `📋 N today · ⚠ M overdue`，点击打开看板。移动端该信息嵌入 board header。

`US-405` 关闭看板时记住当前 query tab，下次打开停在同一个。

### 15.2 Daily Notes 依赖

`US-701` 插件写入路径依赖 Obsidian 内置 Daily Notes。新建任务只能写入当天 Daily Note；Daily Notes 不可用时必须阻止新建并给出可操作提示，不允许写入 inbox / fallback 文件。

`US-701a` Daily Notes 未启用时，状态栏或持久 Notice 提示“Daily Notes 插件未启用，无法新建任务”，并提供设置入口。Quick Add / add 命令失败并保留输入。

`US-701b` Daily Notes 启用但未设置文件夹时，提示“Daily Notes 未设置文件夹，无法新建任务”，并提供设置入口。

`US-701c` 配置修复后，警告自动消失，无需重启 Obsidian。

### 15.3 Obsidian Tasks 依赖

`US-701d` Tasks 社区插件未安装时，状态栏展示 `data-dep-warning="tasks-missing"`。

`US-701e` Tasks 已安装但禁用时，状态栏展示 `data-dep-warning="tasks-disabled"`。

`US-701f` Tasks 正常启用时，不显示 tasks 相关警告。

## 16. CLI / AI Agent 故事

### 16.1 任务读写

`US-201` 注册命令到 Obsidian CLI，不另写独立 CLI。

`US-201a` `obsidian task-center` 作为根帮助入口，列出任务读写、Query Tab 管理和 AI skill 安装命令，避免用户只输入 namespace 时得到 “Command not found”。

`US-202` `list` 每行第一列是稳定 id，例如 `path:L42` 或 hash。

`US-203` 写操作重复执行结果相同。对已完成任务再跑 `done` 返回 `ok … unchanged`。

`US-204` 每次写都返回 `before / after` 两行 diff。

`US-205` `list` 和 `stats` 输出必须 human-readable，同时对 AI 友好；不强制 JSON。

`US-206` `stats days=N` 显示估时 vs 实际耗时比率，以及 top tag 分钟数。

`US-207` CLI 排期词：`today / tomorrow / week / next-week / month / YYYY-MM-DD / FROM..TO`。`unscheduled` 只表示缺少有效 `⏳`。

`US-208` 行号失效时按标题 hash 找回任务；hash 撞了返回候选，不猜。

`US-209` 支持增量改时间，例如 `actual minutes=+30m`。

`US-210` 文档要给出“典型一天收尾 / 快速捕捉 / 补记完成”三种工作流。

`US-211` 报错两行：`error <code>` + 一句人话。code 是短而固定的英文集合。

`US-212` `list parent=<id>` 能筛出某父任务的所有子任务。

`US-213` `add` 支持 `stamp-created=true|false`。

`US-214` hash 撞到多条任务时，返回 `ambiguous_slug` + 候选列表，绝不猜。

`US-228` `nest ref=A under=B` 能跨文件把 A 变成 B 的子任务，语义与 GUI US-125 一致。

### 16.2 Query Preset 管理

`US-216` CLI 能列出 query tabs / presets，并查看某个 preset 的完整 DSL。

`US-217` CLI 能创建和更新 query preset DSL。它与 GUI 的保存 / 更新使用同一份存储。

`US-218` CLI 能重命名、复制、隐藏、删除、设默认 query tab。目标必须使用稳定 id。

`US-219` CLI 与 GUI 共用同一份 DSL schema 与校验规则。

`US-220` CLI 能按某个 query tab / preset 的 DSL 执行查询，并按该 preset 的 view 展示结果。用户或 AI 可以查看 `preset-today` 的默认 list，也可以临时指定 `view=week` 或 `view=month`，用同一份 filters 看周 / 月分布。CLI 展示必须保留稳定任务 id，week 按 7 天分组，month 按日期分组，list 按 section / 任务树分组；JSON 输出要暴露 view model，方便代理继续处理。

## 17. 精力管理故事

`US-301` 用户可以按自己的优先级方法管理任务。Task Center 只提供 tag / inline field / query / matrix / summary 这些通用能力，不内置方法论。

`US-302` 用户可以记录估时与实际耗时。默认约定是 `[estimate:: 90m]` 与 `[actual:: 75m]`，支持 `Nh / NhMm / Nm`。用户也可以换成自己的字段名。

`US-303` 用户可以配置 summary preset，看最近 7 天估得准不准，例如 `sum(actual)/sum(estimate)`、误差带命中数、按 tag 拆分 top N。

`US-304` 历史周默认折叠，本周展开，避免过去数据挤出当前周。

`US-305` 放弃与完成分开统计。`[-] ❌` 是放弃，不混入完成计数。

## 18. 跨角色共同约束

`US-401` 只用 Markdown，不建数据库，不用自定义格式。

`US-402` UI 中英自动切换，跟随 Obsidian 语言。

`US-403` 写操作必须原子化，崩溃不能写坏文件。

`US-404` 读操作跳过没有任务的文件，大 vault 打开看板不卡。

`US-406` Obsidian callout 里的任务视同一等公民，例如 `> - [ ] ...` 与多层 `>>`。

`US-408` UI 字符串随 Obsidian 当前语言实时重渲染。

`US-410` Quick Add / CLI 自然语言日期至少支持中英：今天、明天、昨天、周一至周日、本周、下周、本月、下月，以及 today、tomorrow、yesterday、Mon-Sun、week、next-week、month、next-month。无法识别时不假设日期，任务保持未排期。

`US-411` 日期显示跟随 locale；写回文件永远是 ISO `YYYY-MM-DD`。

`US-412` CLI 错误码恒为英文短码；后接的人话跟随语言。

`US-413` 所有支持 Enter 提交的输入框必须守卫 IME composition。`e.isComposing === true` 或 `e.keyCode === 229` 时，Enter 不触发提交、不关闭 modal、不写文件。

## 19. 发版与分发

`US-601` 维护者推送严格 semver tag 后自动构建并创建 GitHub Release。tag 格式为 `1.5.0`，不带 `v`，不带 pre-release。

`US-602` 发版前必须通过 pre-flight gate：typecheck、lint、unit test、e2e。失败则不发版。

`US-603` 每次发版同步更新 `versions.json`，声明插件版本需要的 Obsidian min version。

`US-604` Release body 自动从 PR 标题和 closed issue 标题生成，按 conventional commit 前缀分组；维护者可手动覆写。

`US-605` 每个 GitHub Release 挂 `main.js`、`manifest.json`、`styles.css` 三个独立 asset。禁止把 build 产物 commit 回 main。

`US-606` 每个 GitHub Release 的标准 asset 必须由 release workflow 生成 GitHub artifact attestation。维护者和用户能够用 GitHub CLI 验证 `main.js`、`manifest.json`、`styles.css` 的来源和完整性；缺少 attestation 时 release gate 视为不完整。

## 20. 故事变更规则

1. 新故事取下一个空编号，写入对应章节。
2. 修改验收预期时直接改故事正文。
3. 作废故事直接删除，不保留僵尸条目。
4. commit message 使用中文 conventional：`<type>(<scope>): <description>`。
5. 涉及故事编号的实现、测试、PR 描述应能回溯到对应 `US-XXX`。
