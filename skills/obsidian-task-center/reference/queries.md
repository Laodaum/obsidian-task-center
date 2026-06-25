# Query Tabs / Preset DSL — 完整参考

> 🧭 **SSOT 是 `docs/dsl/zh.md`（英文 `docs/dsl/en.md`）**——DSL 的唯一权威来源在 obsidian-task-center 仓库的那两份文档。
> 本文件只是 skill 自带的**精简镜像**，方便离线/独立安装时手边有份速查；**任何与 `docs/dsl` 冲突的地方，以 `docs/dsl` 为准**。改 DSL 行为时先改 SSOT，再回头同步本文件。

> 决定要**建/改视图**、或要精确解释 `query-run` 输出时再读本文件。成品布局直接看同级 `../examples/`。
> 写 DSL 前的保命做法：先 `obsidian task-center:query-show id=preset-week`（周+托盘+drop）或 `id=preset-today`（分区列表），**照它返回的结构改，别凭记忆猜**。

Query Tab 是保存的 QueryPreset，与 GUI Query 编辑器同一套存储 / schema / 校验。始终用稳定 `id` 定位，不要用显示名。

## 读取动词

```
obsidian task-center:query-list [hidden=true] [format=json]
obsidian task-center:query-show id=preset-week
obsidian task-center:query-run  id=preset-today [view=list|week|month] [anchor=YYYY-MM-DD] [format=json]
```

- `query-list` 文本输出含 `id` / `name` / `builtin|custom` / `default` / `hidden|visible`。JSON：`[{ "id","name","builtin","hidden","default" }]`。
- `query-run` 默认用预设保存的 view；`view=` 临时覆盖**不回写**（非 list/week/month 报 `invalid_query`）；`anchor=` 是周/月游标，默认今天，非 `YYYY-MM-DD` 报 `invalid_date`。
- 周输出全部 7 天带计数；月文本只列有任务的日期格，JSON 含全部月格。
- 所有任务行带稳定 id（`Tasks/Inbox.md:L42`），可继续 pipe 给 `show` / `schedule` / `done` / `abandon`。

## DSL 形状（1.0+，是一棵 area 布局树）

预设 = `{ name, view: { layout: <node> } }`。

> ⚠️ **过滤只能写在每个 area 的 `when` 上。**
> - 写在预设**顶层**的 `filters`（tab 级）会被**静默忽略**——不报错、也不生效（1.0 废除 tab 级过滤）。
> - 旧的**扁平 SavedTaskView**（顶层 `search`/`tag`/`time`/`status`，无嵌套 `filters`）会被**直接拒绝**，报 `invalid_query`：`检测到旧版 SavedTaskView 扁平格式…`。
> - 旧 `view:{type, preset, sections, tray, matrix}` 形状会被**自动迁移**成 `layout` 树；非法的 `view.type` 报错。

`<node>` 是 **stack** 或 **area leaf**：

- **stack** — `{ "dir": "row" | "col", "children": [<node>, …], "weight"?: number }`。`col` ≈ VStack，`row` ≈ HStack；嵌套做二维布局（如四象限网格）。`children` 必须非空。
- **area leaf** 之一（公共可选字段：`id` / `title` / `weight` / `onDrop`）：
  - `{ "type":"list", "when"?:Filters, "orderBy"?:[string], "limit"?:number, "emptyText"?:string }`（无内部分组；多段列表用 `col` 叠多个 list）
  - `{ "type":"grid", …同 list… }` — 配置与投影同 `list`，卡片改为响应式多列网格（未排期托盘用）
  - `{ "type":"week" | "month", "when"?:Filters, "firstDayOfWeek"?:"monday"|"sunday" }` — `month` 另有 `"density":"compact"|"cards"`；week/month 的每个日期格本身就是改期放置目标
  - `{ "type":"drop", "onDrop":DropEffect, "title"?:string }` — 纯动作放置区，无查询；**必须**有 `onDrop`，否则报 `drop_requires_on_drop`

> 不被支持的 `type` 字符串**不报错**，会被归一化成 `unknown` area，由视图层渲染「未知类型 + 原始 JSON」。所以打错 `type` 不会失败，只会渲染成一块没用的未知区——拼写要核对。

### Filters（`when`）

```jsonc
{
  "search": "示例",                 // 自由文本，匹配标题 / 标签（大小写不敏感）
  "tags": ["#work", "#2象限"],      // 数组/逗号串=AND（须全含）；或 {values,mode:"and"|"or"} 选模式，OR=含任一
  "status": ["todo"],               // 见下；或 "all"
  "time": { "scheduled": "today", "deadline": "overdue" }
}
```

- **`status`** 合法值：`todo` / `done` / `dropped` / `in_progress` / `cancelled` / `custom`（数组，或单个字符串，或 `"all"`）。匹配的是终态继承后的 `effectiveStatus`。
- **`time`** 仅这 4 个字段会生效（其余键被静默剥除）：`scheduled` / `deadline` / `completed` / `created`。
- **`time` token**：
  - 通用（任意字段）：`today` · `tomorrow` · `week` · `next-week` · `month` · `unscheduled`（该字段为空）· `YYYY-MM-DD`（精确）· `FROM..TO`（区间）· `all`
  - **仅 `deadline`**：`overdue`（早于今天）· `next-7-days`
  - ⚠️ **没有 `yesterday` / `next-month`**——那是 `task-center:list` 动词的词汇，不是预设 `when` 的，写了不会匹配。

`onDrop`（drop area 必填；list/grid/任意 area 可选）— 三选一：`{ "setStatus":"dropped" }` · `{ "setScheduled":"<token>" }` · `{ "clearScheduled":true }`。

## 创建 / 修改

```bash
obsidian task-center:query-create dsl='…'      # 总是分配新 id，即使 DSL 里带 id（query-save 是其别名）
obsidian task-center:query-update id=… dsl='…' # 保留目标 id 与 builtin/custom 身份；校验失败则原预设不动
```

非法 DSL 报 `invalid_query` 并保持设置不变。成品 DSL 见 `../examples/`。

## 管理 / 规则

```
obsidian task-center:query-rename      id=sv-alpha name="深度工作"
obsidian task-center:query-copy        id=preset-week [name="我的本周"]   # 缺省名 = "<源名> Copy"
obsidian task-center:query-hide        id=preset-week hidden=true|false
obsidian task-center:query-delete      id=sv-alpha
obsidian task-center:query-set-default id=preset-week                     # 或 id=null 清默认
```

- 内置 tab 可隐藏/复制/重命名/更新/设默认；删除会被「墓碑」记录，不会在下次加载重新播种（GUI 可「恢复预设」找回）。
- 删自定义 tab 只删该保存视图，**绝不**删任务。
- 隐藏的 tab 不能设为默认（报 `invalid_query`）。
- 目标 id 不存在 → `query_not_found`。
