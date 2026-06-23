# Task Center Query DSL 参考

[English](en.md) · **中文**

Task Center 里每一个 Tab 都是一份 **Query DSL**（一个 `QueryPreset` 对象）。同一份 DSL 同时驱动：图形过滤、视图布局、顶部 summary、CLI 查询。在 Tab 上点「编辑 Query」就能看到并直接编辑这份 JSON。

> Markdown 是唯一事实源。DSL 只决定「怎么筛、怎么排、怎么摆」，任务数据本身永远在 vault 的 Markdown 行里。视图、summary、过滤都是从 Markdown 派生出来的结果。
>
> 本文是面向使用者的「怎么写」参考。需要逐字段的 TypeScript 类型定义，见 [`ARCHITECTURE.md` §1.3](../../ARCHITECTURE.md#13-querypreset)。

---

## 1. 一份 Preset 的三个分区

```jsonc
{
  "id": "preset-today",
  "name": "Today",
  "builtin": true,
  "hidden": false,

  "filters": { /* 整个视图的基础集合 */ },
  "view":    { "layout": { /* 布局树：怎么摆 */ } },
  "summary": [ /* 顶部统计指标 */ ]
}
```

| 分区 | 作用 |
| --- | --- |
| `filters` | 这个视图能看到的**基础任务集合**。下面每个 area 的 `when` 只会在它之上**进一步收窄**，不会放宽。 |
| `view.layout` | **布局树**：决定页面上摆哪些组件、怎么嵌套排列。 |
| `summary` | 顶部的统计指标（计数 / 求和 / 比率等），渲染在标准位置。 |

没有「视图类型」枚举，也没有 `preset` 判别字段。一个视图长什么样，**完全由 `view.layout` 这棵布局树决定**。

---

## 2. filters：先圈定基础集合

`filters` 描述「这个 Tab 默认看到哪些任务」。

```jsonc
"filters": {
  "search": "周报",                          // 标题/正文包含的文本
  "tags": { "values": ["重要"], "mode": "and" }, // 标签，mode = and | or
  "status": ["todo"],                        // todo | done | dropped；省略 = 全部
  "time": {
    "scheduled": "today",                    // ⏳ 排期
    "deadline":  "next-7-days",              // 📅 截止
    "completed": "week",                     // ✅ 完成时间
    "dropped":   "month",                    // 放弃时间
    "created":   "2026-01-01..2026-06-30"    // 创建时间
  }
}
```

### 日期词汇（DateToken）

`time.*` 的每个字段都接受下面这些 token：

| Token | 含义 |
| --- | --- |
| `all` | 不限制 |
| `today` / `tomorrow` | 今天 / 明天 |
| `week` / `next-week` | 本周 / 下周 |
| `month` | 本月 |
| `unscheduled` | **该字段为空**（如「没有排期」＝ `scheduled: "unscheduled"`） |
| `overdue` | 已逾期（仅 `deadline`） |
| `next-7-days` | 未来 7 天（仅 `deadline`） |
| `2026-06-23` | 某一天（`YYYY-MM-DD`） |
| `2026-06-01..2026-06-30` | 区间（`起..止`） |

> `unscheduled` 不是日期范围，它表示「这个时间字段是空的」。

---

## 3. view.layout：SwiftUI 式布局树

布局树由两种节点组成：

- **容器节点 Stack**：`row`（≈ HStack，横排）或 `col`（≈ VStack，竖排），用 `children` 嵌套子节点，可选 `weight` 控制伸缩比例。
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
"layout": { "type": "list" }
```

旧的「视图类型」现在升级成了「**area 类型**」：一个视图不再只有一种类型，而是可以自由组合多个 area —— 周视图 = `col[ 周网格, row[未排期, 放弃区] ]`，未排期 = `col[ 列表 ]`，你也可以 `row[ 工作列表, 个人列表 ]` 并排自定义。

---

## 4. Area 类型逐个看

### 4.1 list —— 任务列表

最常用的组件：在 `filters` 基础上再用 `when` 收窄，渲染一列任务卡。父子任务会自动嵌套。

![list 视图](../assets/dsl/todo.png)

```jsonc
{
  "type": "list",
  "when": { "tags": { "values": ["工作"], "mode": "and" } }, // 在基础集上再收窄
  "orderBy": ["deadline_risk", "created_desc"],
  "limit": 50,
  "emptyText": "暂无任务"
}
```

| 字段 | 说明 |
| --- | --- |
| `when` | 在 `filters` 之上**再收窄**的过滤（同 `QueryFilters` 结构）。图形过滤入口编辑的就是这个 `when`。 |
| `sections` | 把一个 list 内部按 `when` 再切成若干带标题的分组（见下）。 |
| `orderBy` | 排序，见 [§5.4](#54-orderby-排序) |
| `limit` | 最多显示多少条 |
| `emptyText` | 空集合时显示的文案 |

#### list + sections —— 一个列表内的多个分组

「今日」视图就是**一个** list，内部用 `sections` 分成逾期 / 今天 / 未排期三组。它和 TODO 是同一个组件，差别只在 DSL。

![今日视图 = list + sections](../assets/dsl/today.png)

```jsonc
{
  "type": "list",
  "sections": [
    { "id": "overdue", "title": "逾期",
      "when": { "time": { "deadline": "overdue" } },
      "orderBy": ["deadline_asc"], "limit": 3 },
    { "id": "today", "title": "今天",
      "when": { "time": { "scheduled": "today" } }, "limit": 3 },
    { "id": "unscheduled", "title": "未排期",
      "when": { "time": { "scheduled": "unscheduled", "deadline": "unscheduled" } },
      "orderBy": ["created_desc"], "limit": 3 }
  ]
}
```

### 4.2 grid —— 卡片网格

和 `list` 同字段、同投影，只是卡片以**响应式多列网格**排列。二维分类（四象限）用 `row`/`col` 嵌套多个带 `title` + `when` 的 grid 表达，**没有专门的 matrix 类型**。

![四象限 = row/col 嵌套 grid](../assets/dsl/quadrant.png)

```jsonc
"layout": {
  "dir": "col",
  "children": [
    { "dir": "row", "children": [
      { "type": "grid", "title": "重要 & 紧急",
        "when": { "tags": { "values": ["重要", "紧急"], "mode": "and" } } },
      { "type": "grid", "title": "重要 & 不紧急",
        "when": { "tags": { "values": ["重要", "不紧急"], "mode": "and" } } }
    ] },
    { "dir": "row", "children": [
      { "type": "grid", "title": "不重要 & 紧急",
        "when": { "tags": { "values": ["不重要", "紧急"], "mode": "and" } } },
      { "type": "grid", "title": "不重要 & 不紧急",
        "when": { "tags": { "values": ["不重要", "不紧急"], "mode": "and" } } }
    ] }
  ]
}
```

### 4.3 week —— 周网格

按周展示的日期网格。每个日格内部自排布局，并隐式带 `onDrop: { setScheduled: <当日> }` —— 把卡片拖进某一天即写入该天的排期。

![周视图 = col[ week, 未排期, 放弃区 ]](../assets/dsl/week.png)

```jsonc
{ "type": "week", "firstDayOfWeek": "monday" }   // monday | sunday
```

> 上图的完整布局见 [§6 周视图](#周视图)：周网格下面横排着「未排期」收纳格和「放弃区」。

### 4.4 month —— 月网格

按月展示的日期网格，用法同 `week`，多一个密度选项。

![月视图](../assets/dsl/month.png)

```jsonc
{ "type": "month", "firstDayOfWeek": "monday", "density": "cards" } // compact | cards
```

### 4.5 drop —— 纯动作落区

没有 query 的落区，只承接拖拽动作，`onDrop` 必填。「放弃区」就是一个 drop area。

```jsonc
{ "type": "drop", "title": "放弃区", "onDrop": { "setStatus": "dropped" } }
```

### 4.6 unknown —— 兜底

不被支持的 area `type`（笔误，或已删除的旧类型如 matrix）**不是错误**：会被归一化成 `unknown`，保留原始 JSON，视图层渲染「未知类型 + JSON」，不会让整份配置加载失败。

---

## 5. 机制

### 5.1 filters + when：分层收窄

`filters` 是整个视图的基础集合，每个 list/grid area、每个 section 的 `when` 都在它之上**再做交集**。

- 没有作用于整个 Tab 的「全局过滤运行时状态」。
- 每个 area 的过滤就是它**自己的 `when`**；图形过滤入口直接编辑该 area 的 `when`，与 DSL 直编是同一份数据。

### 5.2 onDrop：拖拽写操作

卡片被拖进某个 area 时执行的写操作，三种语义**互斥**：

| 字段 | 效果 |
| --- | --- |
| `setStatus: "dropped"` | 把任务标记为放弃（放弃区） |
| `setScheduled: <DateToken>` | 写排期（`week`/`month` 的日格隐式用当日） |
| `clearScheduled: true` | 清空被拖任务自己那行的 ⏳ 排期（未排期收纳格用） |

「改到明天」「清空排期」「放弃」是列表卡片和 drop area 的**通用能力**，不是某个视图的专属动作。

### 5.3 summary：顶部统计

`summary` 是一个指标数组，渲染在视图顶部。「已完成」视图用它统计实际耗时与「实际/预估」比率：

![已完成视图 = list + summary](../assets/dsl/completed.png)

```jsonc
"summary": [
  { "type": "sum",   "field": "actual", "format": "duration" },
  { "type": "ratio", "numerator": "actual", "denominator": "estimate", "format": "percent" }
]
```

支持的 `type`：`count`（计数）、`sum`（对 `field` 求和）、`ratio`（`numerator/denominator` 比率）、`top-n`、`group-by`（按 `by` 分组）。`format` 可选 `duration` / `percent` 等。

### 5.4 orderBy 排序

`orderBy` 接受一个 token 数组，按顺序作为多级排序键：

| Token | 含义 |
| --- | --- |
| `deadline_asc` / `deadline_desc` | 按截止日期升 / 降 |
| `scheduled_asc` / `scheduled_desc` | 按排期升 / 降 |
| `created_desc` / `created_asc` | 按创建时间 |
| `completed_desc` | 按完成时间（倒序） |
| `deadline_risk` | 按「截止风险」（越紧迫越靠前） |
| `priority_desc` | 按优先级 |
| `title_asc` | 按标题字母序 |

### 5.5 limit / emptyText

`limit` 限制单个 list/section 的最大条数；`emptyText` 自定义空集合时的提示文案。

---

## 6. 内置视图：完整范例

下面是内置视图的真实出厂 DSL，可直接当模板改。

### TODO

一个不分组的 `list`：

```jsonc
{ "filters": { "status": ["todo"] },
  "view": { "layout": { "type": "list" } }, "summary": [] }
```

### 未排期

`col[ list ]`，list 的 `when` 取「没有排期」：

```jsonc
{ "filters": { "status": ["todo"] },
  "view": { "layout": { "dir": "col", "children": [
    { "type": "list",
      "when": { "time": { "scheduled": "unscheduled" } },
      "orderBy": ["deadline_risk", "created_desc"] }
  ] } },
  "summary": [] }
```

### 周视图

`col[ week, row[ grid(未排期收纳), drop(放弃) ] ]`：

```jsonc
{ "filters": { "status": ["todo"] },
  "view": { "layout": { "dir": "col", "children": [
    { "type": "week" },
    { "dir": "row", "children": [
      { "type": "grid", "id": "unscheduled-tray", "title": "未排期",
        "when": { "time": { "scheduled": "unscheduled" } },
        "onDrop": { "clearScheduled": true } },
      { "type": "drop", "title": "放弃区",
        "onDrop": { "setStatus": "dropped" } }
    ] }
  ] } },
  "summary": [] }
```

### 已完成

`list` + 顶部 summary：

```jsonc
{ "filters": { "status": ["done"] },
  "view": { "layout": { "type": "list", "orderBy": ["completed_desc"] } },
  "summary": [
    { "type": "sum",   "field": "actual", "format": "duration" },
    { "type": "ratio", "numerator": "actual", "denominator": "estimate", "format": "percent" }
  ] }
```

---

## 7. 设计原则速记

1. **Markdown 是唯一事实源**，DSL 只是派生层。
2. **一个视图 = 一棵布局树**，没有视图类型枚举；渲染层不按 today / completed 等名字分支。
3. **过滤归属 area**：`filters` 是基础集，`when` 在其上收窄，没有全局过滤状态。
4. **动作是通用能力**：改排期 / 清排期 / 放弃由卡片和 drop area 提供，不绑定某个视图。
5. **未知类型不报错**：归一化成 `unknown` 兜底。

---

> 截图取自桌面端 Task Center；标签、分组标题等文案以各自 vault 的真实数据为准。
