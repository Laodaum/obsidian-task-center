# ARCHITECTURE

> 本文只描述 Task Center 如何支撑 [USER_STORIES.md](./USER_STORIES.md) 与 [UX.md](./UX.md)：数据模型、模块边界、读写路径、缓存、性能、测试与发布约束。
>
> 需求不在本文新增；实现不应绕过本文定义的对象模型。

## 0. 架构原则

1. **Markdown 是唯一事实源**：任务数据只存在于 vault 的 Markdown 行中；内存缓存、Query、summary、view 都是派生结果。（US-401）
2. **字节级写回**：改名、移动、嵌套、改期、完成、放弃都必须最小化改动目标行 / 目标块，保留未知 emoji、inline field、tag、block id、wikilink anchor 与用户原文。（US-407 / US-409）
3. **一份 Query DSL**：filters、view、summary、tab preset、GUI 可视化编辑、GUI DSL 直编、CLI query 管理共用同一份 schema 与校验。（US-109t / US-219）
4. **Tab 是持久 Query**：不存在独立持久化的“current query”。运行时只有 tab saved query、tab draft、effective query。（US-109u）
5. **View 不拥有业务集合**：list / grid / week / month 只消费 Query 结果并提供对应操作；TODO、今日、未排期、已完成等都是 QueryPreset。（US-100 / US-109k）
5a. **过滤归属 area，不是全局 live state**：没有一份作用于整个 tab 的全局过滤运行时状态。每个 `list`/`grid` area 的过滤就是它自己的 `when`；图形过滤入口直接编辑该 area 的 `when`（落进 tab draft），与 DSL 直编同一份数据。tab 级只有一个程序化应用的共享基础集 `preset.filters`。（US-109w / US-109x / US-109y / US-109z）
6. **GUI 与 CLI 共用业务层**：解析、筛选、summary、写回、嵌套、QueryPreset CRUD 都必须通过同一服务层，不允许 CLI 和 GUI 各自实现。（US-201~219）
7. **缓存是唯一读入口**：状态栏、看板、CLI 不直接扫 vault；所有任务读取经 TaskCache。（US-404）
8. **事件增量优先**：文件变更只重解析该文件；打开看板 / list / stats / hash disambiguation 才允许显式全量 ensure。（US-404）
9. **移动端不是降级桌面**：业务语义共用，交互适配层分离；移动端没有拖拽、dwell、hover、快捷键。（US-501 / US-507）
10. **可测试纯逻辑优先**：解析、Query、继承、summary、writer plan、CLI formatter 都应是无 DOM 纯逻辑。

## 1. 核心数据模型

### 1.1 ParsedTask

`ParsedTask` 表示 Markdown 中一行任务及其派生信息。

```ts
type TaskStatus = "todo" | "done" | "dropped" | "in_progress" | "cancelled" | "custom";

interface ParsedTask {
  id: string;              // stable id: "path:L42"，展示使用 1-based line
  path: string;
  line: number;            // 0-based
  hash: string;            // 标题 + 路径派生的短 hash，用于行号漂移找回

  rawLine: string;         // 原始整行
  rawTitle: string;        // checkbox 后完整内容
  indent: string;          // 空白 + callout prefix
  marker: "-" | "+" | "*";
  checkbox: string;

  status: TaskStatus;
  title: string;           // 去掉 Obsidian Tasks token / tag / inline field 后的标题
  tags: string[];          // 合法 hashtag，字面保留，含 #

  scheduled: string | null; // ⏳ 或 [scheduled:: YYYY-MM-DD]；两者都有时 ⏳ 优先
  deadline: string | null;  // 📅
  start: string | null;     // 🛫
  completed: string | null; // ✅
  dropped: string | null;   // ❌
  created: string | null;   // ➕
  recurrence: string | null;// 🔁 原样片段
  priority: string | null;  // 🔺⏫🔼🔽⏬ 原样片段

  inlineFields: Record<string, string[]>;
  durationFields: Record<string, number>; // 可解析为分钟的 inline field

  parentLine: number | null;
  childrenLines: number[];
  calloutDepth: number;

  mtime: number;
}
```

解析器必须忽略空标题任务，例如只有 `- [ ]` 的行不进入 Task Center。（US-107）

### 1.2 EffectiveTask

继承、终态、独立日期子任务属于派生层，不写入 `ParsedTask` 本身。

```ts
interface EffectiveTask extends ParsedTask {
  effectiveStatus: TaskStatus;
  effectiveScheduled: string | null;
  effectiveDeadline: string | null;
  effectiveCreated: string | null;
  terminalInheritedFrom: string | null; // ancestor id
  renderParentId: string | null;        // 当前 view 上是否嵌在父卡里
  isTopLevelInQuery: boolean;
}
```

`deriveEffectiveTasks(tasks)` 负责：

- 子任务继承父级未定义属性。（US-144）
- 父终态使未完成子任务继承完成 / 放弃状态。（US-145 / US-144a）
- 父可见时隐藏重复顶层子任务。（US-143）
- 子任务有不同 `⏳` 时拆成对应日期上下文的独立顶层卡。（US-148 / US-149）

### 1.3 QueryPreset

> 本节是 DSL 的 TypeScript 规格（架构事实源）。面向使用者、带配图与可运行示例的「怎么写」参考在 [`docs/dsl/zh.md`](docs/dsl/zh.md) / [`docs/dsl/en.md`](docs/dsl/en.md)；应用内「编辑 Query」的「DSL 文档」链接按 locale 指向对应语言页。

```ts
type TaskStateFilter = "todo" | "done" | "dropped";

type DateToken =
  | "all"
  | "today"
  | "tomorrow"
  | "week"
  | "next-week"
  | "month"
  | "unscheduled"
  | `${number}-${number}-${number}`
  | `${string}..${string}`;

interface QueryFilters {
  search?: string;
  tags?: { values: string[]; mode: "and" | "or" };
  status?: TaskStateFilter[]; // undefined = 全部
  time?: {
    scheduled?: DateToken; // ⏳；unscheduled = is empty
    deadline?: DateToken | "overdue" | "next-7-days";
    completed?: DateToken;
    dropped?: DateToken;
    created?: DateToken;
  };
}

// ── View = SwiftUI 式布局树：row / col 容器嵌套 area 叶子组件 ──
// 没有单一 view 类型，也没有 preset 判别字段。一个 view 是一棵布局树：
// 容器节点 row（≈ HStack）/ col（≈ VStack）排列子节点，叶子节点是 area
// 组件。旧的「view 类型」升级成「area 类型」：一个 view 不再只有一种类型，
// 而是可以自由组建多个 area（周视图 = col[ 网格, tray ]；未排期 =
// col[ 列表, 放弃 ]；用户也能 row[ 工作列表, 个人列表 ] 并排自定义）。
// 根节点可以直接是单个 area，不必包壳（今日 = 一个 list area）。渲染层
// 递归遍历布局树，逐个 area 派发到对应组件，不存在 today / completed /
// unscheduled 等专属渲染分支。（US-720 / US-109k / US-109f）

type LayoutNode = Stack | Area;

interface Stack {
  dir: "row" | "col"; // row ≈ HStack，col ≈ VStack
  children: LayoutNode[];
  weight?: number;    // 在父容器里占的伸缩比例，默认 1
}

type Area = ListArea | GridArea | WeekArea | MonthArea | DropArea | UnknownArea;
// grid：与 list 同字段同投影，卡片以响应式多列网格排列；二维分类（四象限）
// 用 row/col 嵌套多个带 title 的 grid 表达，没有专门的 matrix 类型。

// 卡片被拖入某个 area 时的写操作；三种语义互斥。
interface DropEffect {
  setStatus?: "dropped";      // 放弃区
  setScheduled?: DateToken;   // 写排期（week / month 日格隐式用当日）
  clearScheduled?: true;      // tray：清空被拖任务自己行的 ⏳
}

interface AreaBase {
  type: Area["type"];
  title?: string;
  weight?: number; // 在父容器里占的伸缩比例，默认 1
  onDrop?: DropEffect;
}

// list：在 preset.filters 基础上再用 when 收窄，渲染一列任务卡。
// 可选 sections —— 一个 list 内部按 when 再分成若干带标题的分组。
// 今日 = 一个配了 3 个 section 的 list；TODO = 一个不分组的 list；
// 两者是同一个组件，看起来一样，只是 DSL 不同。
// 取代旧的 QuerySection 顶层概念与 QueryTray —— tray 也只是个 list area。
interface ListArea extends AreaBase {
  type: "list";
  when?: QueryFilters;
  sections?: QuerySection[];
  orderBy?: string[];
  limit?: number;
  emptyText?: string;
}

interface QuerySection {
  id: string;
  title: string;
  when: QueryFilters;
  orderBy?: string[];
  limit?: number;
  emptyText?: string;
}

// week / month：日期网格组件。日格内部自排布局，每个日格隐式
// onDrop:{ setScheduled: <当日> }。
interface WeekArea extends AreaBase {
  type: "week";
  firstDayOfWeek?: "monday" | "sunday";
}

interface MonthArea extends AreaBase {
  type: "month";
  firstDayOfWeek?: "monday" | "sunday";
  density?: "compact" | "cards";
}

// drop：纯动作落区，无 query；onDrop 必填。放弃区就是 drop area。
interface DropArea extends AreaBase {
  type: "drop";
  onDrop: DropEffect;
}

// unknown：归一化遇到不认识的 area.type（笔误，或已删除类型如旧 matrix）时
// 的兜底，保留原始类型与 JSON，视图层渲染「未知类型 + JSON」。
interface UnknownArea extends AreaBase {
  type: "unknown";
  rawType: string;
  raw: unknown;
}

interface QueryViewConfig {
  layout: LayoutNode; // 根节点：可以是 Stack，也可以直接是单个 area
}

interface QuerySummaryMetric {
  id: string;
  type: "count" | "sum" | "ratio" | "top-n" | "group-by";
  field?: string;
  numerator?: string;
  denominator?: string;
  by?: "tag" | string;
  limit?: number;
}

interface QueryPreset {
  id: string;
  name: string;
  builtin: boolean;
  hidden: boolean;
  filters: QueryFilters;     // 整个 view 的基础集合
  view: QueryViewConfig;     // area 布局树
  summary: QuerySummaryMetric[]; // 顶部 summary，标准位置渲染
}
```

Schema 约束：

- `filters / view / summary` 是一个对象的三个分区。`filters` 是 view 的基础集合，每个 list area / section 的 `when` 在此之上再收窄。
- 没有 view 类型枚举，也没有 `preset` 判别字段。view 行为完全由 `view.layout` 布局树决定，渲染层不得按 today / completed / unscheduled 等名字分支。（US-720 / US-109k）
- 内置 view 的布局：今日 = 一个含 3 个 section 的 `list`（与 TODO 同组件，差异只在 DSL）；未排期 = `col[ list, drop ]`；已完成 = `list` + 顶层 summary；周 / 月 = `col[ week|month, list(tray) ]`；四象限 = `col[ row[grid,grid], row[grid,grid] ]`（带 title + when 的 grid，没有专门 matrix 类型）。都是 area 组合，不是新 view 类型。（US-720 / US-103 / US-103a）
- 未排期 tray 是一个 `list` area，数据来源是它自己的 `when`，不改变同一布局里 week / month area 的集合。（US-109j）
- 「改到明天」「清空排期」「放弃」是列表卡片与 drop area 的通用能力，不是某个 preset 的专属动作。（US-103 / US-123）
- `unscheduled` 属于 `time.scheduled is empty`，不是日期范围 token。（US-109e）
- View 配置不能硬编码业务分类；area 的 title 和 when 条件都来自 DSL。（US-109f / US-103a）
- 不被支持的 area `type` 不是错误：归一化成 `unknown` area（保留原始 JSON），视图层渲染「未知类型 + JSON」。（US-103c）

### 1.4 TabState 与 Settings

```ts
interface RuntimeTabState {
  activeTabId: string;
  draftByTabId: Record<string, Partial<QueryPreset>>;
  viewCursorByTabId: Record<string, {
    weekStart?: string;
    month?: string;
    scrollTop?: number;
    expanded?: string[];
  }>;
}

interface PluginSettings {
  openBoardOnStartup: boolean;
  defaultTabId: string;
  firstDayOfWeek: "monday" | "sunday";
  forceMobileLayout: boolean;
  queryPresets: QueryPreset[];
  hiddenBuiltinTabIds: string[];
  lastActiveTabId?: string;
  stampCreatedByDefault: boolean;
  taskFormatFlavor: "tasks" | "dataview";
}
```

持久化设置必须兼容旧 `data.json` 字段；删除旧设置项时可忽略但不能导致启动失败。（US-118）

### 1.5 老数据迁移与升级闸门（US-414 / US-415）

新模型统一为 `QueryPreset`（嵌套 `filters` + `view.layout` 布局树）。两类旧结构需要迁移：

- 扁平 `SavedTaskView`：无嵌套 `filters`，顶层有 `search/tag/time/status`。
- 旧 DSL 的 `QueryPreset`：`filters` 已嵌套，但 `view` 仍是旧写法 `{type, preset, sections, tray, matrix}`、没有 `layout`。

实现：

- 检测：`isLegacyQueryPresetShape(obj)` —— 命中 `isLegacySavedTaskView(obj)`，或 `view` 是非空旧 DSL 形状（无 `layout` 且含 `type/preset/sections/tray/matrix` 任一）即判定为旧结构。
- 迁移：`migrateLegacySavedTaskView(obj) → QueryPreset`（纯函数）把扁平字段收进 `filters`；旧 DSL view 由下游 `ensureBuiltinQueryPresets → normalizeQueryPreset → normalizeQueryPresetView` 的 `migrateLegacyViewToLayout` 迁成 `layout`。坏字段按默认值降级，不抛错、不中断加载。
- 内置视图：迁移后的旧内置项（`preset-*` id）进入 `ensureBuiltinQueryPresets`——保留用户的 name/hidden/排序/filters/summary，view 布局刷新成最新出厂 JSON。自定义项（`sv-*`）整体迁移并追加在内置之后。
- 闸门与时机：`loadSettings` 在内存里完成迁移并把检测计数记到 `plugin.migratedLegacyCount`，但**不**自动写回。只要该计数 > 0，`TaskCenterView.render()` 早退渲染全屏升级闸门页，不渲染看板——确保看板渲染路径只面对一种数据结构。用户点击闸门确认后调用 `plugin.completeMigration()`：`saveSettings()` 持久化、清零计数、刷新所有打开的看板进入新版 UI。
- 幂等：确认写回后，下次加载检测不到旧结构、计数为 0、闸门不再出现。用户不确认就退出则不写回，下次仍展示闸门。
- 边界：迁移只改本地 `data.json`，不触碰任务 Markdown（US-403）。

## 2. 模块边界

建议结构：

```text
src/
├─ parser.ts              # Markdown / Obsidian Tasks 行解析，纯函数
├─ task-tree.ts           # 父子关系、继承、独立日期子任务，纯函数
├─ query/
│  ├─ schema.ts           # QueryPreset 类型、默认预设、版本迁移
│  ├─ validate.ts         # GUI / CLI 共用校验
│  ├─ normalize.ts        # DSL 规范化、默认值填充
│  ├─ filter.ts           # filterTasks
│  ├─ summary.ts          # computeSummary
│  └─ presets.ts          # builtin preset factory
├─ cache.ts               # TaskCache，唯一 vault 读缓存
├─ writer.ts              # 单行 / 块级写回与 undo op plan
├─ api.ts                 # TaskCenterApi，GUI / CLI 共用业务入口
├─ cli.ts                 # CLI 参数解析与输出格式化
├─ view/
│  ├─ task-center-view.ts # ItemView 外壳
│  ├─ tabs.ts             # tab strip / menus
│  ├─ query-editor.ts     # 可视化 + DSL 编辑
│  ├─ filters.ts          # filter popovers
│  ├─ summary.ts          # summary render
│  ├─ views/list.ts
│  ├─ views/week.ts
│  ├─ views/month.ts
│  ├─ card.ts
│  ├─ source-dialog.ts
│  ├─ dnd.ts
│  ├─ mobile-actions.ts
│  └─ undo.ts
├─ quickadd.ts
├─ status-bar.ts
├─ settings.ts
├─ deps.ts                # Daily Notes / task-format companion 依赖健康
├─ dates.ts
├─ i18n.ts
├─ styles.ts?             # 若需要 TS class 常量，不放颜色
└─ main.ts
```

### 2.1 依赖规则

| 模块 | 可以依赖 | 禁止依赖 |
| --- | --- | --- |
| parser | 标准库、Obsidian 类型定义 | App、DOM、cache、writer |
| task-tree | ParsedTask、日期工具 | DOM、App |
| query | ParsedTask / EffectiveTask、日期工具 | DOM、writer、view |
| cache | parser、Obsidian App/Vault/MetadataCache | view、writer、cli |
| writer | parser、dates、Obsidian Vault process | view、cache |
| api | cache、writer、query、task-tree、settings store | DOM |
| cli | api、formatter、i18n | view、DOM |
| view | api、i18n、Obsidian UI | parser 直接扫 vault |
| status-bar | api/cache readonly、deps、i18n | writer、view |
| settings | settings store、query presets、deps | task writer |

任何模块若需要“所有任务”，必须通过 `TaskCenterApi.list()` 或 `TaskCache.ensureAll()` 间接获得，不能自行 `app.vault.getMarkdownFiles()`。

## 3. 读取与缓存

### 3.1 TaskCache 职责

```ts
interface FileEntry {
  path: string;
  mtime: number;
  hasTaskListItem: boolean;
  tasks: ParsedTask[];
}

class TaskCache {
  ensureFile(path: string): Promise<FileEntry>;
  ensureAll(options?: { signal?: AbortSignal }): Promise<ParsedTask[]>;
  flatten(): ParsedTask[];
  invalidateFile(path: string): void;
  removeFile(path: string): void;
  renameFile(oldPath: string, newPath: string): void;
  resolveRef(ref: TaskRef): Promise<ParsedTask>;
  onChanged(cb: (change: CacheChange) => void): () => void;
}
```

缓存维护：

- `byPath: Map<string, FileEntry>`。
- `byHash: Map<string, ParsedTask[]>`。
- `flattenCache: ParsedTask[] | null`，文件变更后标脏。
- `pendingParseByPath` 防止同一文件并发重复解析。

### 3.2 事件路径

```text
Obsidian vault/metadata event
  → TaskCache.invalidateFile(path)
  → 单文件解析完成
  → 更新 byPath / byHash / flattenCache
  → emit cache.changed(paths)
  → status-bar / open views / tests 订阅刷新
```

只有 `cache.ts` 订阅原始 vault / metadata 事件。view、status-bar、CLI 不订阅 `metadataCache.on("resolved")`，也不直接重扫。（US-404）

事件策略：

| 事件 | 处理 |
| --- | --- |
| modify | eager 重解析该文件 |
| create | 如果是 markdown，解析该文件 |
| delete | 移除该 path 的缓存与 hash 索引 |
| rename | 更新 path；必要时重解析新文件 |
| metadata changed | 只 invalidate 对应文件 |

### 3.3 全量 ensure 的边界

允许触发 `ensureAll()` 的路径：

- 用户打开看板且当前 query 需要全集。
- CLI `list` / `stats`。
- hash ref 解析且当前 hash 索引无法证明唯一。
- Query 编辑器需要候选 tag / field 统计。

不允许触发 `ensureAll()` 的路径：

- 插件 onload。
- 状态栏首次渲染。
- 单个写命令的 `path:Lnnn` ref。
- 每次 metadata resolved。

大 vault 启动时状态栏可以在缓存未全量化前显示部分计数；打开看板后全量化并变准确。这是避免“启用插件即卡住”的设计取舍。（US-404）

### 3.4 文件筛选与并发

`ensureAll()` 遍历 markdown 文件时，先看 `metadataCache.getFileCache(file)`：

- 已索引且明确没有 task list item：跳过。
- 未索引或未知：解析文件，不能当作无任务。
- 有 task list item：解析文件。

解析并发限制为固定池（默认 16 或 32，可根据测试调整）。单文件解析失败只记录 warning 和 stats，不让整个 vault 空白。

## 4. Query 执行管线

### 4.1 主流程

```text
TaskCache.flatten()
  → parse-level ParsedTask[]
  → deriveEffectiveTasks()
  → applyQueryFilters(preset.filters)        // tab 级共享基础集（程序化，无全局过滤 UI）
  → applyViewProjection(view)                // 每个 list/grid area 再用自己的 when 收窄
  → computeSummary(summary)
  → render surface / CLI format
```

过滤分两层、各有归属：

- **基础集 `preset.filters`**：`applyQueryFilters` 在投影前对全集生效，决定"这个 tab 整体看哪些任务"。它没有全局过滤 chip UI，只在 DSL / 编辑 Query 面板里改。
- **per-area `when`**：在 `applyViewProjection` 里，每个 `list`/`grid` area 用自己的 `when` 在基础集上再收窄。area header 的过滤入口编辑的就是这个 `when`，写进 tab draft（`draftByTabId`），与 DSL 直编同一份数据。
- **不存在第三层全局 live filter**：渲染层不再有 `getTextFilter()` 式的、读一份全局 tag/time/status/search 运行时状态再套在所有 area 上的逻辑。空状态由各 area 自己按 `when` 归因。（US-109w / US-109b1）

### 4.2 Filter 语义

`applyQueryFilters` 必须按用户故事实现：

- `search`：标题关键字匹配。
- `tags`：合法 hashtag，默认 AND。
- `status`：todo / done / dropped 多选；undefined 表示全部。
- `time.scheduled`：只看有效 `⏳`；`unscheduled` 表示有效排期为空。
- `time.deadline`：只看 `📅`；`overdue` 属于 deadline。
- `time.completed`：只看 `✅`。
- `time.dropped`：只看 `❌`。
- `time.created`：只看 `➕`。

所有日期比较都使用 ISO `YYYY-MM-DD` 规范化；显示层再按 locale 格式化。（US-411）

### 4.3 View Projection

View projection 不再筛选业务集合，只把 query 结果投影成渲染模型。它递归遍历 `view.layout`：容器节点（row / col）投影成 `StackModel`，叶子 area 各自投影成对应的 area model。

```ts
type LayoutModel = StackModel | AreaModel;

interface StackModel { kind: "stack"; dir: "row" | "col"; weight: number; children: LayoutModel[]; }

type AreaModel =
  | { kind: "area"; type: "list"; weight: number; sections: ListSectionModel[]; onDrop?: DropEffect }
  | { kind: "area"; type: "week"; weight: number; days: DayColumnModel[]; onDrop?: DropEffect }
  | { kind: "area"; type: "month"; weight: number; cells: MonthCellModel[]; onDrop?: DropEffect }
  | { kind: "area"; type: "drop"; weight: number; onDrop: DropEffect }
  | { kind: "area"; type: "unknown"; weight: number; rawType: string; raw: unknown };
```

- 容器：row / col 决定子节点横向 / 纵向排列，`weight` 决定伸缩比。
- List：先用 area `when` 在 `preset.filters` 上收窄，再按 `sections` 分组；无 sections 时一个默认 section 装全部。今日与 TODO 走同一条 list 投影，差异只在 DSL。
- Week：按有效 `scheduled` 落入 7 天；无有效 scheduled 不进日期区。移动端折叠状态只影响 day row body 可见性，不改变 day model。
- Month：按有效 `scheduled` 落入月历日期格；移动端只改变渲染密度，并把当前选中日期的任务列表作为月历下方内联 panel 渲染。
- Grid：与 List 同投影，只是渲染成响应式多列网格；四象限由 row/col 嵌套多个带 title + when 的 grid 组成。
- Drop：纯落区，无数据投影，只携带 `onDrop`。
- Unknown：不被支持的 area 类型，渲染「未知类型 + 原始 JSON」，不参与任务投影。

### 4.4 Summary

`computeSummary(tasks, metrics)` 对过滤后的集合计算：

- count。
- sum(field)：读取 `durationFields[field]` 或可解析的 inline field。
- ratio(numerator, denominator)。
- top-n(by)：tag 或用户字段。
- group-by(by)。

字段名是用户配置，不允许视图层硬编码 `estimate` / `actual` 分支；默认 preset 可以使用这些字段名作为配置值。（US-302 / US-303）

### 4.5 移动端布局适配层

View 层负责把同一份 Query / ViewModel 投射成桌面或移动端 DOM，不允许通过移动端分支改变任务集合、Query DSL 或写回语义。（US-109k / US-117）

移动端布局状态分两层：

- `data-mobile-layout="true"`：窄屏或用户强制移动布局，用于切换 tabs、toolbar、week/month/card/sheet 的移动端排版。
- `data-obsidian-mobile="true"`：真实 Obsidian Mobile 环境，用于额外预留 Obsidian 底部工具栏避让空间。窄屏桌面不能自动套用这层底部避让。

`BottomSheet` 是移动端复杂操作的共享 shell，但调用方可以传入语义 class，使 Query 编辑、父任务选择、日期选择、任务动作 sheet 使用不同高度和 footer 策略。sheet 只能承载视图适配和交互编排；筛选、summary、嵌套、写回仍调用既有 query / writer / api 路径。

父任务选择的候选数据来自已缓存的 EffectiveTask 集合和当前 DOM 可见任务 id。排序、搜索、禁用当前任务及后代都在 view 层完成；真正嵌套写回仍通过 `api.nest(childId, parentId)`。

## 5. 写路径

### 5.1 Writer 不变量

所有写操作走 `app.vault.process(file, mutate)`，保证单文件原子写。（US-403）

`writer.ts` 提供纯规划函数和执行函数：

- `setEmojiDate` / `clearEmojiDate`。
- `setCheckbox`。
- `addTag` / `removeTag`。
- `setInlineField`。
- `renameTaskLine`（CLI/API 用；GUI 标题编辑走源 Markdown 编辑层）。
- `planSameFileNest`。
- `planCrossFileNest`。
- `appendTaskToDailyNote`。
- `applyUndoOps`。

Writer 只修改目标 token：

- 改期只替换 / 插入 / 删除该行自己的 `⏳`。
- 清空排期只清空该行自己的 `⏳`，不改继承来源。
- 完成写 `[x]` 和 `✅ YYYY-MM-DD`。
- 放弃写 `[-]` 和 `❌ YYYY-MM-DD`。
- 同父级同日创建的子任务不重复写 `➕`。（US-146）

### 5.2 幂等与 before/after

每个写动词返回：

```ts
interface WriteResult {
  ok: true;
  unchanged: boolean;
  before: string[];
  after: string[];
  undoOps: UndoOp[];
}
```

如果目标状态已满足，返回 `unchanged: true`，不写文件；CLI 格式化为 `ok … unchanged`。（US-203 / US-204）

### 5.3 行号漂移与 ref 解析

```ts
type TaskRef =
  | { kind: "line"; path: string; line0: number }
  | { kind: "hash"; hash: string };
```

`resolveRef` 规则：

- `path:Lnnn`：先解析该文件并检查行号。
- 若行号不再是同一任务，尝试用 hash 找回；找回则返回 warn `out_of_date`。
- hash 多候选返回 `ambiguous_slug` + 候选列表，绝不猜。（US-208 / US-214）
- 找不到返回 `not_found`。

Writer 在 `vault.process` 内再次校验目标 rawLine，防止读取后被外部修改。

### 5.4 嵌套

GUI 拖拽嵌套与 CLI `nest ref=A under=B` 共用同一函数。（US-125 / US-228）

语义：

1. 解析被移动任务整棵子树。
2. 拒绝移动到自己或后代。（US-126）
3. 把子树物理移动到目标父任务所在位置。
4. 重新缩进为目标父级子任务。
5. 清空被移动 root 自己行的 `⏳`。
6. 保留所有子孙任务自己的 `⏳` / emoji / inline fields / tag / 原文。

跨文件没有真正事务。策略：先写 parent 文件，再写 child 文件。若第二步失败，宁可产生可见重复也不丢任务；返回 `nest_partial` 并提供可撤销 parent 插入的 undo op。

### 5.5 Quick Add 写入

Quick Add / CLI add 的默认路径由 Daily Notes 依赖解析：

```text
Daily Notes enabled + folder configured
  → today daily note path
  → append `- [ ] title ➕ YYYY-MM-DD [tokens...]`
```

Daily Notes 不可用时，add 失败并保留输入；不写 fallback 文件。（US-163 / US-701）

任务格式读取固定兼容 Tasks emoji 与 Dataview bracket inline fields：日期字段映射为 `⏳`/`[scheduled::]`、`📅`/`[due::]`、`🛫`/`[start::]`、`➕`/`[created::]`、`✅`/`[completion::]`、`❌`/`[cancelled::]`，并读取 `🔁`/`[repeat::]` 与 priority emoji / `[priority::]`。若同一字段两种格式并存，Tasks emoji 是有效来源。写回由 `settings.taskFormatFlavor` 决定：`tasks` 写 emoji 字段，`dataview` 写 bracket inline fields。`setScheduled` / `setDeadline` / `markDone` / `markDropped` / `addTask` 是格式敏感写入入口；写入某一字段前必须清理该字段的另一种语法，清空排期则同时清理 `⏳` 与 `[scheduled::]`，避免读取优先级导致旧日期继续生效。（US-111 / US-407 / US-409）

`stamp-created=true|false` 由 CLI 单次参数覆盖全局默认。（US-213）

## 6. Undo

```ts
interface UndoOp {
  path: string;
  line: number;
  before: string[];
  after: string[];
}

interface UndoEntry {
  label: string;
  ops: UndoOp[];
}
```

Undo 栈：

- 只属于看板 UI；CLI 写不入栈。
- 深度 20。
- 关闭 leaf / 重启后清空。
- 应用撤销前对目标区域做内容比对：当前文件中的 `after` 必须仍在原位置；否则拒绝撤销并提示内容已外部修改。

`Ctrl/Cmd+Z` 只在当前 active leaf 是 TaskCenterView 且 undo 栈非空时拦截；其它情况下交给 Obsidian 编辑器处理，避免破坏笔记编辑撤销。（US-128）

## 7. GUI 架构

### 7.1 TaskCenterView

`TaskCenterView` 负责：

- 读取 active tab id 与 draft。
- 调用 `api.evaluateQuery(tabId)` 得到 view model + summary。
- 渲染 Header、Tab Strip、Toolbar、Summary、View Body。
- 路由卡片 click、context menu、drag、mobile actions。
- 维护 per-tab view cursor：weekStart、month、scroll、expanded、mobile selected month day。
- 暴露测试属性 `data-test-cache-version`。

不允许 View 直接解析 vault 或手写 writer mutation。

### 7.2 Query Editor

Query Editor 操作 `draftByTabId[activeTabId]`：

```text
visual controls → update draft → validate → effective query → render preview
DSL editor     → parse/validate → update same draft → controls rehydrate
```

保存动作：

- `updateCurrentTab(tabId)`：覆盖 saved query。
- `saveAsNewTab(effectiveQuery, sourceTabId?)`：创建新 id；`sourceTabId` 只用于复制来源元数据或默认命名，不改变用户语义。
- `discardDraft(tabId)`：删除 draft。

不实现单独的 `saveTab()` / `saveCurrentQuery()` 用户动作。无来源 query 的首次保存也调用 `saveAsNewTab`，因为用户结果同样是“创建一个新的 Query Tab”。所有动作走 `QueryPresetService`，CLI query 动词调用同一个 service。

### 7.3 Source Markdown 编辑层

点击卡片调用：

```text
TaskCenterView.openSourceEditor(taskId)
  → api.resolveTask(taskId)
  → SourceDialog.open(task.path, task.line)
  → 使用 Obsidian 编辑器能力定位任务行
  → 文件保存 / modify event
  → cache invalidate
  → view refresh 后保持原 tab / filter / scroll
```

SourceDialog 不实现自己的 Markdown parser/writer，不用 textarea 冒充完整编辑体验。若 Obsidian public API 无法安全嵌入原生 MarkdownView，必须记录降级边界并保留后续修复任务；不能把只读 preview 当完成。（US-168f）

桌面端 `SourceDialog` 可以通过临时 `WorkspaceLeaf` 承载真实 `MarkdownView`。移动端不复用该 overlay：`TaskCenterView.openSourceEditShell()` 在移动布局下调用 Obsidian 官方 `WorkspaceLeaf.openFile()` 打开源文件，并在 `MarkdownView.editor` 上设置 cursor / scrollIntoView 定位任务行。这样移动端的键盘、安全区、编辑滚动和返回行为都交给 Obsidian 原生编辑器处理。（US-168g / US-506）

桌面端 `SourceDialog` 的“打开（新标签页）”动作先保存并释放 overlay 内的临时 `MarkdownView`，再通过 `workspace.getLeaf("tab").openFile(file, { active: true, eState: { line } })` 打开 Obsidian 原生 Markdown 标签页，并复用同一套 cursor / scrollIntoView 定位逻辑。该动作不恢复 Task Center leaf 焦点，因为用户已明确选择离开浮层进入原文标签页。（US-168h）

移动端 tag 编辑是视图层的差异化输入面板：从 `EffectiveTask.tags` 和当前任务集合推导当前 / 候选 tag，保存时对比初始集合，依次调用 `TaskCenterApi.tag(id, tag)` 或 `TaskCenterApi.tag(id, tag, true)`。写回仍由 writer 做字节级最小修改，不在视图层解析整行 Markdown。（US-506b / US-409）

移动端父任务选择器是视图层的差异化选择面板：候选来自当前 `TaskCache` 派生出的任务集合，按当前视图、同文件和搜索结果分组展示。选择器只返回目标父任务 id，不直接改 Markdown；确认后仍调用 `TaskCenterApi.nest(childId, parentId)`，由 writer 共用桌面 / CLI 的嵌套 planner，保证跨文件移动、清空被移动 root 自己 `⏳`、保留子孙字段和 undo 操作一致。（US-507b / US-125 / US-228）

旧入口必须删除：hover popover、dblclick 打开源文件、右键打开源文件、卡片 inline title input。（US-168d / US-161）

### 7.4 DnD Controller

`view/dnd.ts` 只负责桌面拖拽状态机：

- drag start threshold。
- drop target hit test。
- tab dwell。
- 落点优先级。
- 调用 API 写动作。
- 入 undo 栈。
- 动画 class 编排。

移动端不加载拖拽行为；移动端动作由 `mobile-actions.ts` 调用同一 API。（US-501 / US-507）

### 7.5 DOM 选择器契约

E2E 和 UI 自动化依赖稳定 `data-*`，不依赖 CSS 类名或文案：

| 选择器 | 含义 |
| --- | --- |
| `[data-task-id="path:Lnnn"]` | 卡片或子任务行 |
| `[data-tab-id="<query-id>"]` | Query tab |
| `[data-date="YYYY-MM-DD"]` | week 列 / month 日期格 |
| `[data-view="list|grid|week|month|unknown"]` | view body |
| `[data-query-editor]` | Query 编辑器 |
| `[data-drop-zone="abandon"]` | 桌面放弃目标区 |
| `[data-drop-zone="unscheduled-tray"]` | 未排期 tray |
| `[data-card-action="open|done|drop|menu|reschedule-tomorrow"]` | 卡片动作 |
| `[data-parent-picker]` | 移动端父任务选择器 |
| `[data-parent-candidate-id="path:Lnnn"]` | 父任务候选行 |
| `[data-parent-confirm]` | 父任务选择确认按钮 |
| `[data-dep-warning="task-format-companion-missing|task-format-companion-disabled"]` | Tasks / Dataview companion 依赖警告 |
| `[data-test-cache-version="n"]` | cache 刷新版本 |

变更这些契约必须同步改 e2e。

## 8. CLI 架构

CLI 注册到 Obsidian CLI 命名空间，不提供独立二进制。（US-201）

根命令 `task-center` 只输出静态帮助文本，不读写 vault，不初始化额外状态。帮助文本必须覆盖任务动词、Query Tab 动词和 AI skill 安装命令。（US-201a / US-215）

### 8.1 Task 动词

Task 动词薄封装 `TaskCenterApi`：

- `list` / `stats`：显式 ensureAll。
- `done` / `drop` / `schedule` / `actual` / `nest`：按 ref 解析，单文件优先。
- `add`：走 Daily Notes append。
- `list parent=<id>`：resolve parent 后基于 task tree 输出子任务。（US-212）

输出格式由 `cli.ts` 统一处理，保证：

- 第一列稳定 id。
- 写操作 `ok / before / after`。
- 幂等 unchanged 仍为 ok。
- 错误 `error <code>` + 一句人话。

### 8.2 Query 动词

QueryPreset 动词调用 `QueryPresetService`：

- `query-list`：列出 id、name、builtin、hidden、default。
- `query-show id=<id>`：输出完整 DSL。
- `query-run id=<id> [view=list|week|month] [anchor=YYYY-MM-DD]`：执行 QueryPreset filters，计算 summary，并按 view projection 输出结果；`view` 把本次展示临时替换成「单个该类型 area」的布局，不写回 preset。
- `query-create`：读取 DSL 创建 tab。
- `query-update id=<id>`：校验后覆盖。
- `query-rename` / `query-copy` / `query-hide` / `query-delete` / `query-set-default`。

删除自定义 tab 不删除任务；预设 tab 不允许永久删除，只允许隐藏 / 恢复。（US-216~219）

### 8.3 错误码

固定英文错误码至少包含：

```ts
type ErrorCode =
  | "not_found"
  | "ambiguous_slug"
  | "out_of_date"
  | "invalid_date"
  | "invalid_query"
  | "write_conflict"
  | "daily_notes_missing"
  | "daily_notes_folder_missing"
  | "invalid_nest"
  | "nest_partial";
```

错误码不翻译；后接人话跟随 Obsidian 语言。（US-211 / US-412）

## 9. 依赖健康

`deps.ts` 负责检测：

- Daily Notes 核心插件启用状态。
- Daily Notes folder 配置。
- task-format companion 安装 / 启用状态：Tasks 或 Dataview 任意一个启用即健康。

检测结果提供给：

- Header / 状态栏警告。
- Quick Add submit guard。
- CLI add guard。
- 设置页说明。

配置变化后，依赖状态自动刷新，不要求重启。（US-701c）

## 10. i18n 与日期

### 10.1 i18n

`i18n.ts` 提供：

```ts
t(key: string, vars?: Record<string, string | number>): string;
getLocale(): "zh-CN" | "en" | string;
onLocaleChanged(cb: () => void): () => void;
```

切换语言只触发 UI 重渲染，不重扫 vault；`ParsedTask` 不依赖 locale。（US-408）

禁止翻译：

- 用户 Markdown 字面。
- hashtag。
- inline field 字段名。
- Obsidian Tasks emoji 字段。
- CLI error code。

允许翻译：UI 文案、toast、设置项、错误人话、默认预设显示名。

### 10.2 日期

`dates.ts` 负责：

- ISO 写回：永远 `YYYY-MM-DD`。（US-411）
- locale 显示。
- 周一 / 周日起始日。
- token 解析：`today / tomorrow / yesterday / week / next-week / month / next-month / YYYY-MM-DD / FROM..TO`。
- 中文自然语言：今天、明天、昨天、周一至周日、本周、下周、本月、下月。（US-410）

无法识别日期时返回“无日期”，不猜测。

### 10.3 IME Guard

所有 Enter 提交输入框必须使用统一 helper：

```ts
function shouldSubmitEnter(e: KeyboardEvent): boolean {
  return e.key === "Enter" && !e.isComposing && e.keyCode !== 229;
}
```

适用：tab rename、Quick Add、DSL editor save、搜索 / filter 需要 Enter 的场景。（US-413）

## 11. 性能预算

| 场景 | 预算 | 策略 |
| --- | --- | --- |
| 插件 onload | 不触发全量扫描 | 创建空 cache，状态栏被动刷新 |
| 首次打开看板 | ≤ 1.5s 目标；超时显示 skeleton / 进度 | metadata 快速跳过 + 限并发解析 |
| 二次打开看板 | ≤ 200ms | flatten cache 命中 |
| 单文件修改后刷新 | ≤ 1s | 单文件 invalidate + debounce render |
| 桌面拖拽落定反馈 | ≤ 100ms 感知反馈 | 先视觉反馈，写入后 cache 刷新确认 |
| 移动端输入搜索 | debounce ≥100ms | 避免每键全量 render |

渲染约束：

- 父子查找使用 Map，不在 render 热路径中 `Array.find` 全表扫描。
- DataTransfer types 用 `.contains()`，不 `Array.from(...).includes()`。
- 移动端卡片设置 `touch-action: pan-y`。
- 移动端首屏不挂载桌面搜索输入和筛选控件；Query 编辑 bottom sheet 复用同一套 filter controls，避免双份状态。
- 移动端 toolbar、body、week row、card 的布局必须基于父容器宽度收缩，不依赖横向滚动承载主路径控件。
- 移动端 Query tab strip 是例外的横向 pan 区：设置横向 overflow、固定高度、隐藏纵向 overflow，并禁用 tab 拖拽 / dwell / 快捷键提示。
- 列表容器设置 `overscroll-behavior: contain`。
- CSS 禁止 `transition: all`。
- reduced motion 下动画时长 ≤ 50ms 但保留状态变化。

## 12. 样式架构

`styles.css` 只使用 Obsidian CSS 变量和插件自定义语义变量；不写硬编码颜色。

允许来源：

- `--background-primary` / `--background-secondary` / `--background-secondary-alt`
- `--background-modifier-border` / `--background-modifier-hover`
- `--interactive-accent`
- `--color-red` / `--color-yellow` / `--color-green`
- `--text-normal` / `--text-muted` / `--text-faint`
- `--shadow-s` / `--shadow-l`

TS 不写 inline 常量颜色。动画时长通过 CSS custom properties 管理，统一响应 `prefers-reduced-motion`。

## 13. 测试策略

### 13.1 单元测试

必须覆盖纯逻辑：

- parser：Obsidian Tasks 字段、tag、inline field、callout、空标题任务忽略。
- writer：字节级保留、emoji date、checkbox、inline field、tag、嵌套 plan、undo ops。
- task-tree：继承、父终态、独立日期子任务、顶层去重。
- query：filter、date token、view projection、summary、布局归一化（含 unknown area）。
- dates：中英自然语言日期、周起始日、ISO 写回。
- cli formatter：ok / unchanged / before-after / error code。
- i18n：用户字面不翻译。

### 13.2 集成测试

使用 fake App / fake Vault 覆盖：

- cache ensureAll 跳过无任务文件。
- 单文件 invalidate 只重解析目标文件。
- 写动作后 cache changed 时序。
- Quick Add Daily Notes guard。
- QueryPresetService GUI / CLI 共用 CRUD。
- 跨文件 nest 部分失败和 undo。
- path ref 不触发 ensureAll；hash disambiguation 可触发 ensureAll。

### 13.3 E2E

E2E 覆盖 UX 主路径：

- Query Tab CRUD、更多、隐藏、恢复、默认 tab。
- Query 编辑器可视化 / DSL 往返。
- 今日三组、改到明天、空状态。
- Week / Month 未排期 tray 改期与清空。
- List / Grid 配置渲染。
- 源 Markdown 编辑层定位、编辑、保存、刷新。
- Quick Add 成功 / Daily Notes 失败保留输入。
- 桌面拖拽改期、放弃、嵌套、非法目标、跨 tab dwell、undo。
- 移动端 week row、month inline day panel、swipe、任务详情 sheet、长按 action sheet、点选式日期 sheet、父任务选择器。
- CLI task 与 query 动词。
- i18n 热切换。

E2E 等待 cache 刷新时使用 `data-test-cache-version`，不使用固定 sleep。

## 14. 发布与 CI

发版要求来自 US-601~605：

- 严格 semver tag，不带 `v`，不带 pre-release。
- pre-flight gate：typecheck、lint、unit test、e2e。
- 每次发版更新 `versions.json`。
- Release body 从 PR / issue 标题按 conventional 前缀分组生成，可手动覆写。
- Release asset 挂 `main.js`、`manifest.json`、`styles.css`；禁止 build 产物 commit 回 main。
- Release job 在上传 asset 前为 `main.js`、`manifest.json`、`styles.css` 生成 GitHub artifact attestation；workflow 需要 `id-token: write` 与 `attestations: write` 权限。

CI 额外建议检查：

- 非 cache 模块不直接 `getMarkdownFiles()` 全量扫。
- 无 `metadataCache.on("resolved")` 新订阅。
- 视图 / 业务路径无硬编码示例 tag 或方法论字面。
- CSS 无硬编码颜色、无 `transition: all`。
- i18n 字符串不包含示例 hashtag / inline field 语法。

## 15. 实现不变量清单

每次实现或重构至少检查：

- [ ] Markdown 任务格式兼容 Obsidian Tasks 字段。
- [ ] 空标题任务不进入 Task Center。
- [ ] 未识别 token 字节级保留。
- [ ] Query filters / view / summary 共用同一 DSL。
- [ ] GUI Query 编辑器与 CLI Query 动词共用 schema 与校验。
- [ ] 没有独立持久化 current query。
- [ ] View 没有硬编码 TODO / 今日 / 未排期等业务分支；这些来自 QueryPreset。
- [ ] 未排期是 `time.scheduled is empty`，不是任务池。
- [ ] Week / Month tray 是 view 附加区，不污染主日期区集合。
- [ ] GUI / CLI 嵌套语义一致。
- [ ] 移动端不暴露拖拽 / hover / 快捷键。
- [ ] Daily Notes 不可用时不写 fallback。
- [ ] CLI error code 恒英文。
- [ ] 日期写回恒 ISO。
- [ ] Enter 提交守卫 IME composition。
- [ ] 所有写路径走 `vault.process`。
- [ ] 读路径走 TaskCache，不直接扫 vault。
