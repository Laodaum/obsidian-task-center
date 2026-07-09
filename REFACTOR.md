# REFACTOR — Task Center 重构方案（提案）

> **状态：提案。** 本文是设计产出，不是已收敛的架构事实源。决策点（§8）拍板后，相应结论并入
> `ARCHITECTURE.md`，再按 `先文档后代码` 落实现与测试。
>
> **多 agent 约束：** 写作时 `src/view.ts` 有别的 agent 未提交在途改动（含 US-153 修复），
> `UX.md` 亦有他人在途改动。本文**不改这些文件**。所有行号基于 commit `e16565f`，并行下会漂移，
> 落地时按符号名重新定位。

---

## 0. TL;DR

- **CI 红的不是过滤算法**（纯逻辑层 521 单测 + `query-projection` 全绿），是 `view.ts` 那条只有 e2e
  兜底的 DOM/时序缝：一条产品 bug（US-153，**修复已在工作树未提交**）+ 两条测试迁移 bug（Modal sheet 时序/泄漏）。
- **文档没那么"错"**：`ARCHITECTURE.md` 的 §0 原则层基本正确，是**代码偏离了它**。真正过时的是 §2 模块树命名、§4.3 术语。
  → 重构基调是"让代码追上它自己大体正确的文档" + 小修文档，不是推倒重写。
- **核心一刀**：把 area 做成 `AreaSpec`（纯）+ `AreaView`（DOM）的 split-strategy + 全量注册表，
  **顺势**消掉两处 `switch(area.type)`、统一过滤/today、用窄 `AreaViewPorts` 切断对 god class 的依赖、
  用 `PresentationCtx` 把移动/桌面从"30 处内联 if"收成"一条注入的适配轴"。它们是**同一个内聚单元**，分开做会反复返工。

---

## 1. CI 红的真因（green-first 的输入）

typecheck / eslint / 521 单测全绿，**只挂 E2E**。三条失败：

| 失败 | 真因 | 类别 | 修法 |
|---|---|---|---|
| `board-basics:269` US-153 卡片完成后无 done class | committed HEAD 的 `toggleDone()` 漏等 cache 重解析就 render，linger 卡渲染旧 todo 态。**修复已在工作树未提交**（`view.ts:585+` 的 `await this.waitForCacheUpdate([t.path])`，是别人的在途改动） | 产品 bug，**已修待提交** | 协调让 owning agent 提交那一 hunk（不 clobber 别人在途文件） |
| `saved-views:126` / `mobile-filter-ui:176` area when(tag) 过滤后该消失的卡还在 | 过滤逻辑对（`query-projection.test.mjs:179` 绿）。经 sheet 编辑 `area.when` 走 `refreshFilterControls(rerenderControls)` → **只刷 sheet 控件、不刷看板**（`view.ts:4820-4822`）。**决策 E=要 live 刷新** → 这是**产品缺口**：看板该实时反映新 when 却没做。e2e 断言（sheet 开着时 `L2 not.toExist`）本来就对 | **产品缺口**（非测试错） | **改产品**：`setAreaWhen` 编辑后也 `this.render()` 刷看板（见 §8.2）。**在 view.ts，别人在途改动，阻塞中** |
| `saved-views:91/252` `.modal-bg` 拦截点击 | `resetSavedViewTestState`(`:46`) 只 detach leaves、不关 Modal；US-109h/z2 开了 sheet 不关，残留 `.modal-bg` 遮罩拦住下个用例首次点击 | 测试迁移 bug | 加 `afterEach` Escape 关掉所有 Modal（**与 D/E 无关，可独立修**） |

> 这三条迁移 spec 是 `e16565f` 才**首次进 CI 白名单**——之前从没真跑过。所以不是"突然坏"，是"第一次执行就暴露了没验证过的 sheet 时序假设"。

---

## 2. 文档 vs 代码审计

逐条对真实代码核验 `ARCHITECTURE.md`。结论：**§0 灵魂大体对，是代码违反它；真正过时的是 §2 树命名 / §4.3 术语。**

| # | 文档 | 现实 | 判定 | 改谁 |
|---|---|---|---|---|
| D1 | §0 原则3：一份 Query DSL/校验共用（:11） | 过滤语义双写：`view.ts:113-156` 内联 `normalizeFilterTag/taskHasTag/taskMatchesText/taskMatchesTimeFilter` vs `query/filter.ts:92-157`，逐字重复 | 代码违反正确原则 | **改代码** |
| D2 | §4.2：`taskMatchesTimeToken` 唯一时间判定、`today` 可注入 | today 漂移：`view.ts:155` 传 3 参（默认 `todayISO()` 现取时钟）vs `query/filter.ts:154` 传 4 参显式 today；`projection.ts:71` 又 `anchorISO = todayISO()` 默认 | 代码 bug | **改代码** |
| D3 | §4.3:472：不存在 `getTextFilter` 式全局过滤 | `view.ts:4481/4501/4532` `getTextFilter/getSavedViewFilter/taskMatchesTimeFilters` 仍在，被 week/month/badge 用 | 代码违反正确原则（几乎点名） | **改代码** |
| D4 | §2 树：`query/{schema,validate,normalize,filter,summary,presets}`（:320-326） | `src/query/` 只有 `filter.ts`+`projection.ts`；其余全堆在 `saved-views.ts`(1261 行) | 代码未达正确目标 | **改代码** |
| D5 | §2.1：query 禁止反向依赖 view/上层（:361） | `query/filter.ts:19 import { normalizeSavedViewStatus } from "../saved-views"` —— query 下唯一向上出边 | 代码违反正确规则 | **改代码** |
| D6 | §2 树未列 `query/projection.ts`，§4.3 叫旧名 `applyViewProjection`（:471） | `projection.ts` 已存在且合理，导出 `projectArea/projectList/Week/Month` | 文档过时 | **改文档** |
| D7 | §2 view/ 树 `tabs/filters/summary/views/{list,week,month}/card/mobile-actions`（:332-344） | 实际 `view/`：`bottom-sheet/filter-popover/migration-gate/mobile-task-sheet/query-editor/touch/state/...`；外壳仍是根目录 `view.ts`；list/week/month/card 未抽出 | 一半未达、一半命名过时 | **两边都改** |
| D8 | §0-5a 保留 `preset.filters` 共享基础集（:14）；§4.3:472 又说无全局过滤 | 文档**自相矛盾** | 文档欠收敛 | **决策 D** |
| D9 | §13 无 view 层渲染/事件的单测要求 | `view.ts` 行为几乎全压 e2e；已抽 `view/dnd|undo|touch` 零单测 | 文档缺口 | **改文档（补 §13）** |

净结论：5 条改代码（D1/D2/D3/D4/D5）、2 条改文档命名（D6/D7）、2 条待拍板/补文档（D8/D9）。

---

## 3. 第一性原理目标架构

抛开旧文档，本插件本质只有三层（与 §0 原则 1/3/5/9 一致——说明原则层是对的）：

```
纯逻辑内核（无 DOM / 无 Obsidian / today 可注入 / 必须可单测；CLI+GUI 共用）
  parser → task-tree → query/{schema, normalize, validate, filter, projection, presets, areas/*}
                       layout-ops · time-filter · dates · grouping
  依赖只向下：projection→filter→schema；query 绝不依赖 view/writer/saved-views
        ▲ 共用同一内核 ▲
业务入口                         view 薄壳（DOM/手势）
  api(GUI/CLI共用) · cli          view/task-center-view.ts 外壳（只做 §7.1 七件事）
  cache · writer                  view/render/areas/* · editor/* · sheet/* · dnd · undo · touch
  query-preset-store ◄──持久化──  渲染器依赖窄 AreaViewPorts，不依赖 TaskCenterView
  （saved-views 更名后的薄适配）
```

三块归属：**(A) QueryPreset 域**全进 `query/`，CRUD 留薄 `query-preset-store.ts`（更名消灭 SavedView 旧术语）；
**(B) area/when 过滤**唯一入口 = `area.when`，经 capability 门控 + 统一 `applyQueryFilters` + per-type projection；
**(C) view 壳**只做编排，判定逻辑（done/linger/折叠）抽成纯 ViewModel 函数（让 US-153 类 bug 可单测）。

---

## 4. area 抽象（核心：split-strategy + 全量注册表）

### 4.1 现状：Strategy 只做了一半

`areas.ts` 已有正确雏形——`AreaHandler` 类层次把**能力**做成 Strategy
（`TaskAreaHandler`→`DateGridAreaHandler`，`filterable()/editable()/acceptsDrop()/icon/label`）。
但一个 type 的两个最重行为没收进来：

- **投影** `projection.ts:73` `switch(area.type)`，且 `default → projectListArea`（:83）→ **新 type 被静默当 list**。
- **渲染** `view.ts:3457` `switch(node.type)` → `renderListArea/renderWeek/renderMonth`。
- 加上 `collectAreas/findAreaByType`（saved-views.ts）、per-type 校验、per-type 过滤控件 → **一个 week 的知识摊在 5 处**。

### 4.2 关键约束：不能"一个 type 一个全能类"

`projectArea` 被 CLI query-run 直接用（无 DOM），渲染只 GUI 用。把 `project()`+`render()` 塞进同一个类会污染纯核心、
破坏 GUI/CLI 共用、违反 §0 原则 10。**正确解法：一个 type 一个概念，按层拆成两组 strategy，注册表统一。**

### 4.3 接口

```ts
// ── 纯核心 src/query/areas/ ──（CLI+GUI 共用，可单测，无 DOM）
interface AreaProjectionCtx { weekStartsOn: 0|1; today: string; anchorISO: string } // today 显式注入，修 D2

interface AreaProjector<A extends AreaConfig = AreaConfig> {
  project(area: A, tasks: EffectiveTask[], ctx: AreaProjectionCtx): ViewModel; // tasks 已被 when 过滤
}
interface AreaSpec<A extends AreaConfig = AreaConfig> {
  readonly type: A["type"];
  readonly capabilities: AreaHandler;                 // 复用现有 areas.ts Strategy
  readonly projector: AreaProjector<A>;
  readonly validate: (node: unknown) => node is A;    // 收编 saved-views 的 per-type 校验
}
const AREA_SPECS: Record<AreaType | "unknown", AreaSpec> = { list, grid, week, month, drop, unknown };

// ── 视图层 src/view/render/areas/ ──（DOM，只 GUI 用）
interface AreaViewPorts {                              // 渲染器真正需要的窄回调，不是整个 TaskCenterView
  onCardAction(taskId: string, action: CardAction): void;
  onEditWhen(areaIndex: number, when: QueryPresetFilters): void;  // → setAreaWhen
  openSource(taskId: string): void;
}
interface AreaView<A extends AreaConfig = AreaConfig> {
  readonly type: A["type"];
  mount(host: HTMLElement, vm: ViewModel, area: A, ctx: PresentationCtx, ports: AreaViewPorts): AreaViewHandle;
}
const AREA_VIEWS: Record<AreaType | "unknown", AreaView> = { list, grid, week, month, drop, unknown };
```

### 4.4 壳循环里零 switch

```ts
for (const [i, area] of collectAreas(layout).entries()) {
  const spec = AREA_SPECS[area.type];
  const tasks = spec.capabilities.filterable()
    ? applyQueryFilters(all, (area as FilterableAreaConfig).when, ctx)  // 过滤统一于此，capability 门控
    : all;
  const vm = spec.projector.project(area, tasks, ctx);
  AREA_VIEWS[area.type].mount(host, vm, area, presentation, ports);
}
```

### 4.5 三目标各自落点

- **高内聚**：week 纯逻辑全在 `query/areas/week.ts`、DOM 全在 `view/render/areas/week.ts`。两个小文件，各一个修改理由。
- **低耦合**：壳依赖 `AreaSpec/AreaView` 接口+注册表（依赖倒置）；渲染器依赖窄 `AreaViewPorts`，**不再 `import type TaskCenterView`**（干掉报告点名的 inappropriate intimacy）；projector 只吃 `EffectiveTask[]+ctx`，可单测。
- **对扩展开放**：加 `timeline` = 改 union 一处 + 写两文件 + 注册两行。`Record<AreaType,…>` 让编译器在所有该处理处报红，**有控制地**逼你补全，而非 switch 的 `default` 静默吞掉。

### 4.6 一个取舍（决策 C）

- **闭合 union + 全量注册表（推荐）**：固定枚举、编译期穷尽、加 type 动 union 一处。安全、离现状最近。`unknown` 兜底已给前向兼容/round-trip（对应 §0 原则 2）。
- **运行时开放注册表**：`registerAreaType()`、type 开放字符串。只有要让**第三方插件**加 area 才值得——会丢编译期穷尽。当前不需要。

> `drop` 的 `onDrop` 是**实例级**数据（tray 清 ⏳ vs 放弃区设 dropped），areas.ts 已正确留在 data 里。守住边界：**type 级行为进 strategy，实例级差异留 data。**

### 4.7 修订：AreaKind 是一个完整组件定义，render 是 View 的方法

上面的 `AreaSpec + AreaView` 方向是对的，但还不够优雅：它容易滑向三张并列表（projector / renderer / settings），让一个 area type 的概念被拆散。更好的表达是：**area type 是一个完整的 component definition；config 仍是纯 JSON；render 属于 view instance；settings 从 config spec 长出来。**

核心对象收敛为四个词：

| 对象 | 职责 | 约束 |
|---|---|---|
| `AreaConfig` | DSL 里的纯数据，可保存、迁移、CLI 读写 | 不能有方法，不能引用 DOM / Obsidian |
| `AreaKind` | 某个 area type 的定义：默认值、normalize、capabilities、project、settings、createView | 一个 type 一处注册，闭合 union 穷尽 |
| `AreaView` | 有生命周期的 DOM 视图对象，`render()` 是它的方法 | 只依赖窄 `AreaViewDeps`，不依赖整个 `TaskCenterView` |
| `AreaSettingsSpec` | 从 config 字段声明编辑器如何渲染设置 | editor 读 spec 自动生成表单，不手写 list/week/month 分支 |

建议接口：

```ts
interface AreaKind<C extends AreaConfig, VM> {
  readonly type: C["type"];
  readonly icon: string;
  readonly labelKey: string;

  defaults(): C;
  normalize(raw: unknown): C;
  capabilities(config: C): AreaCapabilities;

  project(config: C, tasks: EffectiveTask[], ctx: QueryCtx): VM;
  createView(deps: AreaViewDeps): AreaView<C, VM>;

  readonly settings: AreaSettingsSpec<C>;
}

interface AreaView<C extends AreaConfig, VM> {
  render(host: HTMLElement, props: AreaRenderProps<C, VM>): void;
  destroy?(): void;
}
```

`list` 不是一组散函数，而是一整个定义：

```ts
export const ListArea: AreaKind<ListAreaConfig, ListViewModel> = {
  type: "list",
  icon: "list",
  labelKey: "savedViews.viewList",

  defaults: () => ({
    type: "list",
    when: { status: ["todo"] },
    orderBy: ["scheduled_asc"],
  }),

  normalize: normalizeListArea,

  capabilities: () => ({
    rendersTasks: true,
    filterable: true,
    editable: true,
    acceptsDrop: false,
  }),

  project: projectListArea,
  createView: (deps) => new ListAreaView(deps),
  settings: listAreaSettings,
};
```

`render` 可以、也应该是 view 的成员方法：

```ts
class WeekAreaView implements AreaView<WeekAreaConfig, WeekViewModel> {
  constructor(private readonly deps: AreaViewDeps) {}

  render(host: HTMLElement, props: AreaRenderProps<WeekAreaConfig, WeekViewModel>): void {
    this.deps.renderAreaHead(host, props);
    // render week grid / day columns / drop targets
  }
}
```

注意边界：**不是把 `WeekAreaConfig` 变成 class，也不是让 DSL 对象长方法。** DSL 数据还是 `{ type:"week", when, firstDayOfWeek }`；行为挂在 `WeekArea` 这个 kind 上；DOM 生命周期挂在 `WeekAreaView` 上。

Settings 也不应再散落在 editor 里。TypeScript `interface` 运行时不存在，所以不能真的“从 interface 反射 UI”。可行做法是：用 `AreaSettingsSpec<C>` 作为运行时事实源，再用泛型 / `satisfies` 让它和 config 类型对齐。

```ts
interface WeekAreaConfig extends AreaBase<"week"> {
  when?: QueryPresetFilters;
  firstDayOfWeek?: "monday" | "sunday";
}

const weekAreaSettings = defineAreaSettings<WeekAreaConfig>({
  when: filterField(),
  firstDayOfWeek: selectField({
    labelKey: "settings.firstDayOfWeek",
    options: ["monday", "sunday"],
  }),
});
```

Area 面板因此只需要一条通用路径：

```ts
const kind = areaKinds.get(area.type);
renderSettingsForm(parent, kind.settings, area, onPatchArea);
```

`TaskCenterView` 的 area 循环也只剩编排：

```ts
const kind = areaKinds.get(area.type);
const config = kind.normalize(area);
const model = kind.project(config, tasks, queryCtx);
const view = kind.createView(areaViewDeps);

view.render(host, {
  area: config,
  model,
  areaIndex,
  presentation,
});
```

#### 4.7.1 为什么这比 split projector / renderer 更好

- **概念内聚更强**：新增一个 `timeline` area 时，开发者打开 `areas/timeline.ts` 就能看到 default / normalize / capability / projection / settings / view 入口，不用在 5 个目录里找注册点。
- **render 的归属更自然**：`render()` 属于 `AreaView` 实例，能持有局部 DOM 状态和 cleanup；同时不污染纯 `AreaConfig`。
- **settings 不再复制类型知识**：字段能不能编辑、用什么控件编辑，由 `AreaSettingsSpec` 声明；`query-editor.ts` 不再知道 week 有 `firstDayOfWeek`、month 有 `density`。
- **`TaskCenterView` 变薄**：外壳只算 `QueryCtx` / `PresentationCtx` / ports，然后把 area 交给 kind/view；不再拥有 `renderWeek`、`renderMonth`、`renderListArea`、`renderAreaAppearance` 里的类型分支。
- **测试点更准**：`kind.project()` 纯单测；`settings` 可测“字段生成 patch”；`AreaView.render()` 可用窄 DOM fixture 测，不必启动整个 Obsidian view。

#### 4.7.2 预期代码量变化

这是重构，不是删功能；总行数不会线性下降，但**高风险集中区会明显缩小**。

当前粗略基线：

- `src/view.ts`：约 3790 行。
- `src/saved-views.ts`：约 1248 行。
- area 相关渲染 / 过滤 / 编辑 / drop / 移动端分支散在 `view.ts`、`query-editor.ts`、`projection.ts`、`saved-views.ts`。

保守估计：

| 项 | 变化 |
|---|---|
| `TaskCenterView` | 减少约 700-1000 行，主要移走 `renderListArea` / `renderWeek` / `renderMonth` / area head / area settings / per-type switch |
| `query-editor.ts` | 减少约 80-150 行 per-area 表单分支，改为 settings spec 驱动 |
| `saved-views.ts` | 后续拆 `normalize/validate/presets` 后减少约 500-800 行；area per-type 校验转进 kind |
| 新增 `areas/*` / `view/render/areas/*` | 增加约 600-900 行小文件 |
| 净行数 | 可能只减少约 300-700 行；真正收益是 god class 缩小、重复判断减少、改动定位更短 |

更重要的“少代码”不是总行数，而是**少写同一种分支**。现在加一个 area type 需要碰：

1. `types.ts` union / config。
2. `saved-views.ts` normalize / validate。
3. `query/projection.ts` switch。
4. `view.ts` render switch。
5. `query-editor.ts` 设置 UI。
6. icon / label / capability。
7. 移动端差异和 drop 行为。

目标结构下变成：

1. 写一个 `AreaKind` 文件。
2. 写一个 `AreaView` 文件。
3. 在闭合注册表加一行。
4. 补 projector / settings / render 测试。

从“7 个散点 + 容易漏”降到“2 个文件 + 1 个注册点”。这比净删几百行更有价值。

#### 4.7.3 继承只放在 View 层的窄公共行为

不要把 area kind 做成深继承树。推荐：

- `BaseTaskAreaView`：公共 header、empty state、card list。
- `CalendarAreaView`：week/month 共享日期格、drop target、日期统计。
- `ListAreaView` / `GridAreaView` / `WeekAreaView` / `MonthAreaView`：具体布局。

也就是说：**kind 用组合，view 可少量继承。** 继承只服务 DOM 复用，不参与 DSL 数据模型。

---

## 5. 移动端 / 桌面端 UI

### 5.1 现状：三套信号、两条正交轴、内联 ~30 次

| 信号 | 真正含义 | 问题 |
|---|---|---|
| `isMobileMode()`（platform.ts，= `Platform.isMobile \|\| __testForceMobile`） | **输入模态**：触摸设备 | 对的，有测试缝 |
| 裸 `Platform.isMobile`（view.ts:4198/4879/4906、quickadd、bottom-sheet.ts:43） | 同上，但**绕过测试钩子** | e2e force-mobile **测不到这些路径** |
| `contentEl.dataset.mobileLayout === "true"`（= `narrow \|\| force`，view.ts:408） | **布局宽度**：窄视口（≠触摸设备） | **stringly-typed**，view.ts 内比对 15+ 次 |

核心病：**"触摸模态"与"窄布局"是两条正交轴**，被三套信号混用、内联散落在 god class ~30 处——直接违反 §0 原则 9"交互适配层**分离**"。这是 Divergent Change + Shotgun Surgery 现场。

### 5.2 目标：两轴收成一个注入的 `PresentationCtx`，适配层独立

```ts
interface PresentationCtx {
  modality: "touch" | "pointer";   // 取代 isMobileMode()/裸 Platform.isMobile，单一来源（底层走测试钩子）
  width: "narrow" | "wide";        // 取代 dataset.mobileLayout 字符串
}
```

- 外壳**算一次** `PresentationCtx`、**注入**给渲染器/适配器，渲染器不再读 dataset 字符串。
- **交互能力按模态门控、不内联**：拖拽/dwell/hover/快捷键 ∈ `pointer`；long-press/swipe/bottom-sheet ∈ `touch`（正是 §0-9 清单）。做成 `PointerInteractions`/`TouchInteractions` 适配器，壳按 `ctx.modality` 装一个，而非每个 `renderCard` 里 `if (Platform.isMobile)`。
- **sheet vs popover**：`query-editor.ts:56` 已按 `mobileLayout` 选 class——是对的雏形，推广成统一收 `ctx.width`。
- 顺带修**裸 `Platform.isMobile` 的测试盲区**：全部收口到 `ctx.modality`，e2e force-mobile 才覆盖到 view.ts:4198/4879/4906。

### 5.3 与 area 抽象组合

`AreaView.mount(host, vm, area, ctx, ports)` 里 `ctx: PresentationCtx`。于是 `week` AreaView 内部按 `ctx.width`
选桌面 7 列 vs 窄屏单日（现 view.ts:2661/2880 的 `desktop`/`isMobileLayout` 分叉**收进 week 一个文件**）；
卡片交互由壳按 `ctx.modality` 经 `ports` 传入——移动端真正成"适配层"而非"god class 里的 if"。

---

## 6. 一起解决的技术债（同一个捆绑单元）

area 抽象不孤立。只做注册表、不动下面这些，渲染器还黏在 god class、过滤还双写——**必须一起**：

| 必须一起改 | 绑定理由 |
|---|---|
| 两处 `switch(area.type)`（projection.ts:73 / view.ts:3457）+ 静默 `default→list` | 就是 area 抽象要替换的东西 |
| 过滤双写 + today 漂移（view.ts:113-156、`getTextFilter/getSavedViewFilter`、projection.ts:71/187） | 新模型过滤是"capability 门控 + 统一 `applyQueryFilters` + per-type projection"，趁此删 view 捷径、today 改注入 |
| renderer/query-editor 依赖具体 `TaskCenterView`（query-editor.ts:32） | AreaView 必须依赖窄 `AreaViewPorts` 才能脱离 god class，否则抽了白抽 |
| per-type 校验散在 saved-views.ts | 收进 `AreaSpec.validate`，与 type 同住 |
| 移动/桌面信号混乱（§5） | AreaView 就是分叉发生地，必须和 `PresentationCtx` 一起设计 |

**可推迟、别混进来**：`saved-views.ts → query-preset-store` 更名 + CRUD 拆分（QueryPreset 域，正交）；
sort 的 `switch`（projection.ts:118）做成 strategy map（锦上添花）。

**最小"一起改"集合** = 注册表 + 过滤统一/today注入 + Ports 接口 + `PresentationCtx`。四者是一个内聚单元 = 重构 **Phase 2 第一刀**（每个 area type 仍可逐个迁、各自 commit）。

---

## 7. 分阶段路线图（红 CI 上不做大重构）

> 每步：补 characterization 单测 → 搬一组逻辑/改 import → 测试仍绿 = 一次小 commit。
> 禁用 reset/rebase/amend/checkout/restore/stash/clean，回退靠新 commit；只 `git add` 自己改的文件，绝不 `-A`。

### Phase 0「先转绿 + 立缝」（不需先改文档）
1. **[别人在途，view.ts]** 协调提交 US-153 的 `await waitForCacheUpdate`（不 clobber）→ green `board-basics:269`。**US-153**
2. **[纯测试，我现在能做]** `saved-views.e2e.ts` 加 `afterEach` Escape 关所有 Modal → green `.modal-bg` 拦截（`:91/:252`）。**与 D/E 无关，唯一不阻塞项**
3. **[产品，view.ts，决策 E=刷新，阻塞中]** `setAreaWhen` 编辑后 `this.render()` 刷看板 → green `saved-views:126`/`mobile-filter-ui:176`（e2e 断言不改，见 §8.2）。**US-109x/z2/117a**
4. **[纯函数单测，先红]** `query-filter-today.test.mjs` 固定 today，证明 D2 漂移；再删 view.ts 内联 matcher、统一调 `query/filter.ts`、today 单一注入（view.ts 部分阻塞中）。**原则3 / D1 / D2**

> **Phase 0 当前唯一不阻塞的是步骤 2**；步骤 1/3/4 都动 `view.ts`（别人在途）。CI 转绿的关键路径 = 别人的 view.ts 落地（US-153 + live 刷新）。

### Phase 1「Query 内核归位」（先收敛 §2 树 + 建术语表）
- 按叶子顺序把 `saved-views.ts` 拆成 `query/{schema,normalize,validate,presets}` + 薄 `query-preset-store.ts`；
  `query/filter.ts:19` 改 import `./schema`，**依赖箭头反转**（D5）；统一术语。靠 `saved-views.test.mjs`(2041 行) 兜底，先补盲区再搬。

### Phase 2「area 抽象 + view 瘦身」（先收敛 §2 view 树 / §7 / §13）
- **第一刀（§6 捆绑单元）**：建 `AreaSpec`/`AreaView` 注册表，把 projection/render 的 switch 逐 type 迁入；
  过滤统一 + today 注入；`AreaViewPorts` 切断 god class 依赖；`PresentationCtx` 收编移动/桌面分叉。
- 每个 area type 一个 commit（先补 projector 纯单测——这就是过去缺的 view 层测试缝）。
- 其后：抽 `cardViewModel`（救 US-153 出 e2e）、父子树遍历、draft 快照；最后外壳改名 `view/task-center-view.ts`（动文件名风险最高，放最后且确认无人在途）。

---

## 8. 决策点（需维护者拍板）

| # | 决策 | 建议 |
|---|---|---|
| **A 术语统一** | `QueryPreset`(域)/`Query Tab`(仅 UI 文案)/消灭 `SavedView` | 采纳，建 `UBIQUITOUS_LANGUAGE.md`，Phase 1 前定稿 |
| **B §2 模块树重写** | query 子树 + view `render/editor/sheet/*` + `query-preset-store.ts` 更名 | 采纳第 3/4 节命名 |
| **C area 注册表开放度** | 闭合 union + 全量注册表 vs 运行时开放注册表 | **闭合（推荐）**，除非要第三方 area；A/B/C 待定 |
| **D `preset.filters` 去留** | §0-5a 留、§4.3 说没有，文档自相矛盾 | ✅ **已定：删。唯一过滤源 = `area.when`**（2026-06-24）→ 见 §8.1 涟漪 |
| **E area-when 编辑是否 live 刷看板** | 现状：sheet 路径不刷、关闭才刷；非 sheet 路径实时刷——不一致 | ✅ **已定：要 live 刷新**（2026-06-24）→ 见 §8.2 |

### 8.1 决策 D（删 `preset.filters`）的涟漪 —— 互锁，作为一个单元改

删掉 tab 级共享基础集后，**唯一过滤源是每个 area 的 `when`**。连带改动（互相依赖，须一起设计/落地）：

1. **数据模型 + normalize/迁移**：现有 QueryPreset 的 `preset.filters` 字段移除；存量预设里 `filters` 的语义**下沉到 primary（或各）area 的 `when`**。内置 **今日 / TODO** 这类单 area tab 现在把 `status: todo` 放在 `preset.filters` 里（见 ARCHITECTURE §4.3:517「先用 area when 在 preset.filters 上收窄」），删后必须把该 `status` **写进 primary area 的 `when`**。这是一次 schema 版本迁移（`migrateLegacy*` 家族扩展），靠 `saved-views.test.mjs` 的迁移用例兜底。
2. **US-153 豁免接线**（ARCHITECTURE §4.2.1:495）：`justCompletedIds` 现在「同时喂 tab 级 `preset.filters`（`getTextFilter`）与 per-area `when`」。删 `preset.filters` 后，**只喂 per-area `when` 一条**（`projectListArea` / `applyQueryFilters` 的 `exemptStatusIds`）；`getTextFilter` 整条捷径随之删除（与 D1/D3 合并完成）。CLI / summary / badge 一律不传豁免，不受影响。
3. **要同步改的 ARCHITECTURE 条款**（收敛后一次性改，别 piecemeal）：§0 原则 5a:14（去掉「tab 级只有一个 `preset.filters` 共享基础集」整句，与 §4.3:472 一致）、§4.2.1:495（豁免只喂 area.when）、§4.3:517（List 投影不再「在 preset.filters 上收窄」，直接用 area.when）。
4. **归属阶段**：属 **Phase 1（normalize/迁移）+ Phase 2 第一刀（删 view 捷径）**，不是 Phase 0。先有迁移与单测，再删字段。

### 8.2 决策 E（area-when 编辑 live 刷看板）的后果 —— 翻转 Phase 0 步骤 3

- 现有 e2e 断言（sheet 开着时 `L2 not.toExist`）**本来就是对的**（`.not.toExist()` 查 DOM 存在性，不受 `.modal-bg` 遮挡影响）。红是**产品没 live 刷新**，不是测试错。
- **修法（产品，在 view.ts）**：`setAreaWhen` 写入 draft 后，除了刷 sheet 控件，**还要刷看板**——即把 `refreshFilterControls`（view.ts:4820-4822 的 `if(rerenderControls) … else this.render()`）改成 area-when 编辑时**两者都做**：`rerenderControls?.()`（sheet）+ `this.render()`（board）。sheet 是独立 Obsidian Modal，`this.render()` 重渲 contentEl 不会关掉它。
- **注意**：search 文本框是输入控件，每次 keystroke 重渲看板可能丢焦点——这条要么 search 走 commit-on-blur/debounce，要么只对 tag/time/status（点击型）live 刷、search 维持提交时刷。落地时按此处理，别让光标跳。
- **阻塞**：此修改在 `view.ts`（别人在途改动），我**不能碰**；须等其 view.ts 落地或由该 agent 实现。e2e 断言**不改**（去掉原"移到 Escape 后"的计划）。

> A / B / C 仍待你拍（术语、§2 树命名、注册表开放度）；它们挡在 Phase 1/2 前面，不挡 Phase 0。

---

## 9. 多 agent 执行约束

- `view.ts` / `UX.md` 现有他人在途改动，**全程不碰**；US-153 那一 hunk 让其 owner 提交。
- 每步独立小 commit、各自可回退（新 commit 反向改，不用任何 git 还原命令）。
- 提交前 `git status` + `git diff` 确认只含自己 hunk；只 `git add` 明确改过的文件。
- Phase 2 多个候选都动 view.ts：在不同行段、物理不冲突，但行号会漂——按符号名重新定位。外壳改名放最绝最后。

---

## 附. 证据索引（commit e16565f）

- god class：`src/view.ts`（5066 行）；area 渲染 switch `:3457`；内联 matcher `:113-156`；过滤捷径 `:4481-4540`；`refreshFilterControls` `:4820-4822`；移动分叉 ~30 处（`:408` `dataset.mobileLayout`、裸 `Platform.isMobile` `:4198/4879/4906`）
- area 能力 Strategy：`src/areas.ts`（已存在，待补 projector/view）
- area 数据模型：`src/types.ts:185-259`（`AreaType` union / `AreaConfig`）
- 投影 switch + today 默认：`src/query/projection.ts:67-86`
- 反向依赖：`src/query/filter.ts:19`
- QueryPreset god module：`src/saved-views.ts`（1261 行，待拆+更名）
- 平台信号：`src/platform.ts`（`isMobileMode`）
- 正确的目标文档：`ARCHITECTURE.md` §0:7-19 / §2:312-353 / §2.1:355-370 / §4.3:471-472 / §7.1
- 单测缝范本：`test/taskcenterview-delete-undo.test.mjs`
- e2e 失败现场：`test/e2e/specs/saved-views.e2e.ts`（:46 teardown / :88 openFirstAreaFilter / :126 早断言 / :130 Escape）、`board-basics.e2e.ts:269`、`mobile-filter-ui.e2e.ts:176`
