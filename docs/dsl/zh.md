# Task Center Query DSL 参考

[English](en.md) · **中文**

Task Center 里每一个 Tab 都是一份 **Query DSL**（一个 `QueryPreset` 对象）。同一份 DSL 同时驱动：图形过滤、视图布局、CLI 查询。在 Tab 上点「编辑 Query」就能看到并直接编辑这份 JSON。

> 本文是 DSL 的 **SSOT（唯一权威来源）**。其它地方（README、skill、AI 提示）若与本文冲突，以本文为准；改 DSL 行为时先改这里。
>
> Markdown 是唯一事实源。DSL 只决定「怎么筛、怎么排、怎么摆」，任务数据本身永远在 vault 的 Markdown 行里。视图、过滤都是从 Markdown 派生出来的结果。
>
> 需要逐字段的 TypeScript 类型定义，见 [`ARCHITECTURE.md` §1.3](../../ARCHITECTURE.md#13-querypreset)；运行时形状以 `src/types.ts` 的 `QueryPreset` 为准。

---

## 1. 一份 Preset 的结构

```jsonc
{
  "id": "preset-today",
  "name": "Today",
  "builtin": true,
  "hidden": false,
  "view": { "layout": { /* 布局树：怎么摆、每块各自筛什么 */ } }
}
```

| 字段 | 作用 |
| --- | --- |
| `id` / `name` | 稳定 id（定位用它，别用显示名）/ 显示名 |
| `builtin` / `hidden` | 是否内置 / 是否在 Tab 栏隐藏 |
| `view.layout` | **布局树**：决定页面上摆哪些组件、怎么嵌套，以及**每个组件各自筛什么**。 |

> ⚠️ 一个 Preset **只有身份 + 一棵 `view.layout`**。**没有** tab 级 `filters`，**没有** `summary`，**没有**「视图类型」枚举——这些在 1.0（US-109z2）已移除。
> - 过滤**只存在于每个 area 自己的 `when`** 上（见 §2）。写在顶层的 `filters` 会被**静默忽略**，不报错也不生效。
> - 旧的扁平形状（顶层 `search`/`tag`/`time`/`status`，无嵌套结构）会被**直接拒绝**，报 `invalid_query`。
> - 旧 `view: {type, preset, sections, tray, matrix}` 形状会被**自动迁移**成 `{ layout }` 树。

一个视图长什么样，**完全由 `view.layout` 这棵布局树决定**。

---

## 2. 过滤：每个 area 自己的 `when`

没有「整个 Tab 的基础集合」。每个 list / grid / week / month area 都带**自己的 `when`**，它就是这块区域的全部过滤。GUI 的过滤面板编辑的就是这个 `when`，与你在 JSON 里手写完全等价。

```jsonc
"when": {
  "search": "周报",                          // 标题/标签包含的文本（大小写不敏感）
  "tags": ["重要", "紧急"],                   // 标签数组（或逗号分隔串）；自动补 #；AND（须全含）
  "status": ["todo"],                        // 见下；省略 = 全部
  "time": {
    "scheduled": "today",                    // ⏳ 排期
    "deadline":  "next-7-days",              // 📅 截止
    "completed": "week",                     // ✅ 完成时间
    "created":   "2026-01-01..2026-06-30"    // ➕ 创建时间
  }
}
```

各条件之间是 **AND**：任务要进入这块区域，必须同时满足 `when` 里每一项。

### status

`todo` / `done` / `dropped`（数组，或单个字符串，或 `"all"`；省略 = 全部）。匹配的是终态继承后的 `effectiveStatus`。

> 解析器还接受 `in_progress` / `cancelled` / `custom`，但 GUI 过滤面板只暴露上面三个常用值。

### tags

标签过滤是一个**布尔表达式**，canonical 形态是 `{ "expr": "…" }`（US-109d4）。

- 语法：`#标签`、`and`、`or`、`not`、括号 `( )`；关键字大小写不敏感；优先级 `not` > `and` > `or`；`#` 可省略。
- 例：`"tags": { "expr": "(#a or #b) and not #c" }` —— 含 a 或 b、且不含 c。
- 匹配：解析表达式后对每个任务的标签求值。语法错误 → 该 area **不做标签过滤**（fail-open），不静默丢任务。
- **向后兼容**：旧写法都会在归一化时**自动迁移**成等价 `{ expr }`，求值层只认表达式：
  - 裸数组 `["#a","#b"]` 或逗号串 `"a,b"` → `"#a and #b"`
  - `{ "values":["#a","#b"], "mode":"or" }` → `"#a or #b"`
  - `{ "values":["#a"], "exclude":["#c"] }` → `"#a and not #c"`
- 图形面板：标签 popover 有表达式输入框（实时校验、带示例）+ 标签列表，点列表里的标签会把 `#tag` 追加进表达式。

### time —— 字段与日期词汇

`time` 支持 4 个字段：`scheduled` / `deadline` / `completed` / `created`。每个字段取一个 DateToken：

| Token | 含义 |
| --- | --- |
| `all` | 不限制 |
| `today` / `tomorrow` | 今天 / 明天 |
| `week` / `next-week` | 本周 / 下周 |
| `month` | 本月 |
| `unscheduled` | **该字段为空**（如「没有排期」＝ `scheduled: "unscheduled"`） |
| `overdue` | 已逾期（**仅 `deadline`**） |
| `next-7-days` | 未来 7 天（**仅 `deadline`**） |
| `2026-06-23` | 某一天（`YYYY-MM-DD`） |
| `2026-06-01..2026-06-30` | 区间（`起..止`，任一端可空） |

> - `unscheduled` 不是日期范围，它表示「这个时间字段是空的」。
> - **没有 `yesterday` / `next-month`**——那是 `task-center:list` CLI 动词的词汇，不是 `when` 的，写了不会匹配。

---

## 3. view.layout：SwiftUI 式布局树

布局树由两种节点组成：

- **容器节点 Stack**：`row`（≈ HStack，横排）或 `col`（≈ VStack，竖排），用 `children` 嵌套子节点，可选 `weight` 控制伸缩比例。`children` 必须非空。
- **叶子节点 Area**：真正渲染内容的组件（`list` / `grid` / `week` / `month` / `drop`）。

```jsonc
"layout": {
  "dir": "col",                 // col = 竖排；row = 横排
  "children": [
    { "type": "week" },         // 叶子：周网格
    { "type": "list", "weight": 1 }  // 叶子：列表，占 1 份伸缩
  ]
}
```

根节点既可以是 Stack，也可以**直接是一个 area**（不必包壳）。例如 TODO 视图的根就是单个 `list`：

```jsonc
"layout": { "type": "list", "when": { "status": ["todo"] } }
```

旧的「视图类型」现在升级成了「**area 类型**」：一个视图不再只有一种类型，而是可以自由组合多个 area —— 周视图 = `col[ 周网格, row[未排期, 放弃区] ]`，未排期 = `col[ 列表 ]`，你也可以 `row[ 工作列表, 个人列表 ]` 并排自定义。

---

## 4. Area 类型逐个看

每个 area 的公共可选字段：`id`（稳定标识）、`title`（标题）、`weight`（伸缩比例）、`onDrop`（拖入写操作，见 §5.2）。

### 4.1 list —— 任务列表

最常用的组件：用 `when` 筛出一列任务卡。父子任务会自动嵌套。

![list 视图](../assets/dsl/todo.png)

```jsonc
{
  "type": "list",
  "when": { "tags": ["工作"] },        // 这块区域的过滤（QueryFilters 结构，见 §2）
  "orderBy": ["deadline_risk", "created_desc"],
  "limit": 50,
  "emptyText": "暂无任务"
}
```

| 字段 | 说明 |
| --- | --- |
| `when` | 这块区域的过滤（`QueryFilters` 结构，见 §2）。图形过滤入口编辑的就是这个 `when`。 |
| `orderBy` | 排序，见 [§5.3](#53-orderby-排序) |
| `limit` | 最多显示多少条 |
| `emptyText` | 空集合时显示的文案 |

#### 多段列表 —— 用 col 叠多个 list

`list` 没有内部分组。要像「今日」那样把列表分成逾期 / 今天 / 未排期三段，就用 `col` 容器叠 3 个 `list` area，每个 area 自带完整 `when`、各自 filter 自己。它和 TODO 是同一个组件，差别只在布局树（见 §6「今日」的完整 DSL）。没有「一个 list 内部再分组」这回事——共享的过滤直接在每块的 `when` 里各写一遍。

### 4.2 grid —— 卡片网格

和 `list` 同字段、同投影，只是卡片以**响应式多列网格**排列。二维分类（四象限）用 `row`/`col` 嵌套多个带 `title` + `when` 的 grid 表达，**没有专门的 matrix 类型**。每个 grid 的 `when` 用「同时含两个标签」（AND）来圈一格：

![四象限 = row/col 嵌套 grid](../assets/dsl/quadrant.png)

```jsonc
"layout": {
  "dir": "col",
  "children": [
    { "dir": "row", "children": [
      { "type": "grid", "title": "重要 & 紧急",   "when": { "tags": ["重要", "紧急"] } },
      { "type": "grid", "title": "重要 & 不紧急", "when": { "tags": ["重要", "不紧急"] } }
    ] },
    { "dir": "row", "children": [
      { "type": "grid", "title": "不重要 & 紧急",   "when": { "tags": ["不重要", "紧急"] } },
      { "type": "grid", "title": "不重要 & 不紧急", "when": { "tags": ["不重要", "不紧急"] } }
    ] }
  ]
}
```

### 4.3 week —— 周网格

按周展示的日期网格。每个日格内部自排布局，并隐式带 `onDrop: { setScheduled: <当日> }` —— 把卡片拖进某一天即写入该天的排期。`when` 决定这张周网格里显示哪些任务。

![周视图 = col[ week, 未排期, 放弃区 ]](../assets/dsl/week.png)

```jsonc
{ "type": "week", "when": { "status": ["todo"] }, "firstDayOfWeek": "monday" }   // monday | sunday
```

> 上图的完整布局见 [§6 周视图](#周视图)：周网格下面横排着「未排期」收纳格和「放弃区」。

### 4.4 month —— 月网格

按月展示的日期网格，用法同 `week`，多一个密度选项。

![月视图](../assets/dsl/month.png)

```jsonc
{ "type": "month", "when": { "status": ["todo"] }, "firstDayOfWeek": "monday", "density": "cards" } // compact | cards
```

### 4.5 drop —— 纯动作落区

没有 query 的落区，只承接拖拽动作，`onDrop` 必填（缺了报 `drop_requires_on_drop`）。「放弃区」就是一个 drop area。

```jsonc
{ "type": "drop", "title": "放弃区", "onDrop": { "setStatus": "dropped" } }
```

### 4.6 unknown —— 兜底

不被支持的 area `type`（笔误，或已删除的旧类型如 matrix）**不是错误**：会被归一化成 `unknown`，保留原始 JSON，视图层渲染「未知类型 + JSON」，不会让整份配置加载失败。所以 `type` 拼错不会报错，只会渲染成一块没用的未知区——拼写要核对。

---

## 5. 机制

### 5.1 过滤只属于 area

每个 list/grid/week/month area 的过滤，就是它**自己的 `when`**，互不影响。

- 没有作用于整个 Tab 的「基础集合 / 全局过滤」。要让整个 Tab 都只看 `todo`，就在每个 area 的 `when` 里各写一遍 `status: ["todo"]`（内置视图就是这么做的）。
- 图形过滤入口直接编辑该 area 的 `when`，与 DSL 直编是同一份数据。

### 5.2 onDrop：拖拽写操作

卡片被拖进某个 area 时执行的写操作，三种语义**互斥**：

| 字段 | 效果 |
| --- | --- |
| `setStatus: "dropped"` | 把任务标记为放弃（放弃区） |
| `setScheduled: <DateToken>` | 写排期（`week`/`month` 的日格隐式用当日） |
| `clearScheduled: true` | 清空被拖任务自己那行的 ⏳ 排期（未排期收纳格用） |

drop area 必须有 `onDrop`；list/grid 等任意 area 也可选挂 `onDrop`。「改到明天」「清空排期」「放弃」是卡片和 drop area 的**通用能力**，不绑定某个视图。

### 5.3 orderBy 排序

`orderBy` 接受一个 token 数组，按顺序作为多级排序键：

| Token | 含义 |
| --- | --- |
| `deadline_asc` / `deadline_desc` | 按截止日期升 / 降 |
| `scheduled_asc` / `scheduled_desc` | 按排期升 / 降 |
| `created_desc` | 按创建时间（倒序） |
| `completed_desc` | 按完成时间（倒序） |
| `deadline_risk` | 按「截止风险」（越紧迫越靠前） |
| `priority_desc` | 按优先级 |
| `title_asc` / `title_desc` | 按标题字母序 |

> 表里没列的 token（如 `created_asc`）不被支持，会被忽略。

### 5.4 limit / emptyText

`limit` 限制单个 list 的最大条数；`emptyText` 自定义空集合时的提示文案。

---

## 6. 内置视图：完整范例

下面是 7 个内置视图的**真实出厂 DSL**（取自 `src/builtin-views/*.json`），可直接当模板改。注意它们都**没有** tab 级 `filters`，状态等过滤一律落在各 area 的 `when` 上。

### TODO

一个不分组的 `list`，过滤落在 area 的 `when`：

```jsonc
{ "view": { "layout": { "type": "list", "when": { "status": ["todo"] } } } }
```

### 今日

**col** 叠 3 个 list（逾期 / 今天 / 未排期），每个 list 自带 `when`、各自 filter 自己（`todo` 写进每块的 `when`）：

```jsonc
{ "view": { "layout": {
  "dir": "col",
  "children": [
    { "type": "list", "id": "overdue", "title": "Overdue",
      "when": { "status": ["todo"], "time": { "deadline": "overdue" } },
      "orderBy": ["deadline_asc"], "limit": 3 },
    { "type": "list", "id": "today", "title": "Today",
      "when": { "status": ["todo"], "time": { "scheduled": "today" } }, "limit": 3 },
    { "type": "list", "id": "unscheduled-rec", "title": "Unscheduled",
      "when": { "status": ["todo"], "time": { "scheduled": "unscheduled", "deadline": "unscheduled" } },
      "orderBy": ["created_desc"], "limit": 3 }
  ]
} } }
```

### 未排期

`col[ list ]`，list 的 `when` 取「没有排期且 todo」：

```jsonc
{ "view": { "layout": { "dir": "col", "children": [
  { "type": "list",
    "when": { "time": { "scheduled": "unscheduled" }, "status": ["todo"] },
    "orderBy": ["deadline_risk", "created_desc"] }
] } } }
```

### 周视图

`col[ week, row[ grid(未排期收纳), drop(放弃) ] ]`，每块各自带 `when`：

```jsonc
{ "view": { "layout": { "dir": "col", "children": [
  { "type": "week", "when": { "status": ["todo"] } },
  { "dir": "row", "children": [
    { "type": "grid", "id": "unscheduled-tray", "title": "Unscheduled",
      "when": { "time": { "scheduled": "unscheduled" }, "status": ["todo"] },
      "onDrop": { "clearScheduled": true } },
    { "type": "drop", "title": "Drop",
      "onDrop": { "setStatus": "dropped" } }
  ] }
] } } }
```

### 月视图

同周视图，把顶部换成 `month`：

```jsonc
{ "view": { "layout": { "dir": "col", "children": [
  { "type": "month", "when": { "status": ["todo"] } },
  { "dir": "row", "children": [
    { "type": "grid", "id": "unscheduled-tray", "title": "Unscheduled",
      "when": { "time": { "scheduled": "unscheduled" }, "status": ["todo"] },
      "onDrop": { "clearScheduled": true } },
    { "type": "drop", "title": "Drop", "onDrop": { "setStatus": "dropped" } }
  ] }
] } } }
```

### 已完成

`list`，按完成时间倒序：

```jsonc
{ "view": { "layout": {
  "type": "list",
  "when": { "status": ["done"] },
  "orderBy": ["completed_desc"]
} } }
```

### 已放弃

`list`，过滤 `dropped`：

```jsonc
{ "view": { "layout": { "type": "list", "when": { "status": ["dropped"] } } } }
```

---

## 7. 图形编辑 ↔ DSL ↔ CLI（同一份 schema）

图形过滤入口、「编辑 Query」直编 JSON、CLI 查询管理，三者共用同一份 DSL 与校验：在界面上点过滤器改的就是某个 area 的 `when`，和你在这份 JSON 里手写完全等价。CLI 侧用 `obsidian task-center:query-*` 读写同一份 preset（`query-show` / `query-run` / `query-create` / `query-update` …）。

> 🖼️ **配图 TODO** —— 并排展示「图形过滤弹窗」与对应的 `when` JSON 片段，标出二者一一对应。

---

## 8. 设计原则速记

1. **Markdown 是唯一事实源**，DSL 只是派生层。
2. **一个视图 = 一棵布局树**，没有视图类型枚举；渲染层不按 today / completed 等名字分支。
3. **过滤只属于 area**：每个 area 的 `when` 就是它的全部过滤，没有 tab 级基础集、没有全局过滤状态。
4. **动作是通用能力**：改排期 / 清排期 / 放弃由卡片和 drop area 提供，不绑定某个视图。
5. **未知类型不报错**：归一化成 `unknown` 兜底。
6. **没有 `summary`**：顶部统计已移除；估时/复盘类统计走 `task-center:stats` / `review` CLI。

---

> 截图取自桌面端 Task Center；标签、分组标题等文案以各自 vault 的真实数据为准。
