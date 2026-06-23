# DESIGN.md — Task Center 设计语言

这份文档统一插件所有界面的视觉语言。它不是新需求来源（需求看 `USER_STORIES.md`，交互看 `UX.md`），而是**所有 UI 落地时共享的一套设计 token 与组件规范**，用来消除"每个组件各写各的圆角、字号、颜色"导致的风格漂移。

## 0. 北极星

**升级闸门页（`tc-migration-*` / `tc-bento-*`）是当前的视觉样板。** 它代表我们想要的调性：

- 干净、克制、留白充足；信息分组清晰。
- 强调色（accent）只用在"主操作 / 选中 / 强调"上，不滥用实色填充。
- 圆角统一、描边轻、层级靠表面色而非粗边框。
- 图形用**点阵底纹 + 纯 CSS 几何块**表达，不用立体 emoji。

> 凡是新 UI 或改旧 UI，先问一句："放进闸门页旁边，违和吗？" 违和就回到本文档对齐。

判断一个界面是否"对齐"，看三点：圆角是否来自 token、强调色是否只出现在该强调的地方、图标是否是线性图标/CSS 图形而非彩色 emoji。

## 1. 一切走主题 token，禁止硬编码

插件必须在任意 Obsidian 主题 / 明暗模式下都成立，所以**颜色、圆角、字号、字重一律引用变量，不写魔法数字**。

### 1.1 颜色

| 用途 | Token | 说明 |
| --- | --- | --- |
| 主文字 | `var(--text-normal)` | 标题、正文 |
| 次要文字 | `var(--text-muted)` | 描述、副标题、标签 |
| 最弱文字 | `var(--text-faint)` | 计数、占位、辅助提示 |
| 强调色 | `var(--interactive-accent)` | 主按钮、选中、强调图形 |
| 强调色上的文字 | `var(--text-on-accent)` | 仅用于 accent 实底之上 |
| 强调文字色 | `var(--text-accent)` | 文字态强调（如"内置"标签） |
| 错误 | `var(--text-error)` / `var(--background-modifier-error)` | **不要用 `--color-red` 或 `rgba(255,0,0,…)`** |

强调色不要大面积实底填充。需要"染一层 accent"时用 **soft 混色**：

```css
background: color-mix(in srgb, var(--interactive-accent) 8%, var(--background-secondary));
```

### 1.2 表面与层级（elevation）

层级靠**表面色阶**表达，不靠粗描边或阴影。

| 层 | Token | 场景 |
| --- | --- | --- |
| 底板 | `var(--background-primary)` | 视图背景、示图底纹画布 |
| 卡片 / 容器 | `var(--background-secondary)` | bento 格、周列、放弃区、列表容器 |
| 悬浮 / chip | `var(--background-modifier-hover)` | 标签 chip、示图小块、tag pill |

### 1.3 描边与分隔

- 容器边框：`1px solid var(--background-modifier-border)`。**避免 2px 以上的粗边**（旧放弃区的 `2px dashed` 是欠债）。
- 分隔线：列表项之间用 `1px solid var(--background-modifier-border)`，不用整块背景区分。
- 拖放目标的"虚线"是允许的语义例外（见 §5.7），但颜色走 token。

### 1.4 圆角

只用三档，全部来自 Obsidian token，**不写 `6px` / `8px` / `12px`**：

| 档位 | Token | 用途 |
| --- | --- | --- |
| 小 | `var(--radius-s)` | chip、tag pill、小标记、示图内小块 |
| 中 | `var(--radius-m)` | 列表容器、列、月格、放弃区、示图画布 |
| 大 | `var(--radius-l)` | bento 卡片、主要面板 |
| 全圆 | `999px` | 徽标 / pill 标签 |

### 1.5 间距

采用 4 的倍数节奏：`4 / 6 / 8 / 12 / 16 / 20 / 24 / 28`。卡片内边距 16，区块之间 20–28，紧凑列表项 8–10。

### 1.6 字体

字号与字重一律走 token，**不写 `13px` / `11px` / `700`**：

| 用途 | Token |
| --- | --- |
| 卡片标题 | `var(--font-ui-medium)` + `var(--font-semibold)` |
| 正文 / 列表项 | 默认正文 / `var(--font-ui-small)` |
| 标签 / 计数 / 提示 | `var(--font-ui-smaller)` |
| 大标题（页面级） | `1.7em` 量级 + `var(--font-bold)` |
| 代码 / DSL | `var(--font-monospace)` |

不要出现小于 `--font-ui-smaller` 的正文。等宽只给真正的代码 / JSON DSL。

## 2. 图形与图标

### 2.1 禁止装饰性 emoji 出现在界面 chrome 里

彩色立体 emoji（`⏹` `❌` `⬜` `🗑` 等）在不同平台渲染不一致、和线性 UI 冲突，**不得用于按钮、图标、提示语**。emoji 只允许出现在**用户自己输入的任务内容**里。

替代方案，按优先级：

1. **Obsidian 线性图标**：`import { setIcon } from "obsidian"`，用 lucide 名称（如 `circle-slash`、`trash-2`、`inbox`、`calendar`）。图标继承 `currentColor`，天然跟随状态色。
2. **纯 CSS 几何图形**：像 bento 示图那样用 `div`/`span` + token 拼。
3. 文本符号（`+` 这类）：可接受，但要用 token 上色。

### 2.2 示图（illustration）

特性介绍 / 空状态的小图沿用 bento 范式：

- 画布：`var(--background-primary)` + 点阵底纹

  ```css
  background-image: radial-gradient(circle at 1px 1px, var(--background-modifier-border) 1px, transparent 0);
  background-size: 12px 12px;
  ```

- 图形块：accent 表示"主体/新"，`--text-faint` 表示"次要/旧"。
- 固定高度（bento 用 96px），保证一行多格对齐。

## 3. 状态语言（统一所有交互态）

| 状态 | 表达方式 |
| --- | --- |
| 默认 | 容器表面色 + 1px token 边框 |
| hover | 边框转 `var(--interactive-accent)`，可选 `transform: translateY(-1px)` |
| 选中 / 当前 | **soft 混色背景**（`color-mix(... accent 12% ...)`）即可，不要整块实色 accent 填充，也不要再叠加边框 / 指示条——背景色已足够区分 |
| 焦点（键盘） | accent 描边（`box-shadow: 0 0 0 2px ...` 或 border-color），不要只靠浏览器默认 outline |
| 拖拽中 | 全局加 `dragging-active`，有效落点边框转实线高亮（见 §5.7） |
| 空 | 居中弱文字 + 可选示图，padding 24 |
| 加载 | 居中弱文字，复用 `.bt-empty` / `.bt-loading` 容器 |
| 错误 | `var(--text-error)` 文本 / `var(--background-modifier-error)` 底，**不用裸红** |

"选中 / 当前"的标准范式（推广到周列、月格等区块）：**只用背景混色**，不叠加边框或指示条。

```css
.selected {
  background: color-mix(in srgb, var(--interactive-accent) 12%, var(--background-secondary));
}
.selected .title { color: var(--interactive-accent); }
```

例外：纯文字列表项（如任务卡 `.bt-card.selected`）背景混色偏弱时，可用**左侧** accent 竖条（`inset 2px 0 0`）辅助，但区块/格子（日列、月格）一律背景色，不加横条。

## 4. 与 Obsidian 兼容的硬约束

`test/source-health.test.mjs`（US-602）会强制以下规则，写样式时必须遵守：

- 不用 `!important`：用作用域 class 提高特异性来覆盖主题。
- 不用 `:has()`：会放大选择器失效范围。
- 不用多列（`column-width/gap/span`、`break-inside`）。
- 不用 `text-indent` 隐藏文字、不用 `text-decoration-color`。

所有规则都挂在 `.task-center-view`（或移动端 `[data-mobile-layout]`）作用域下，避免污染 vault 全局。

## 5. 组件规范

每个组件给出对应的 class 与对齐要点。"现状欠债"列在 §6。

### 5.0 动作密度与渐进式呈现

不要把一个区域里的所有操作都铺成等权重的按钮——那会变成 Word / OmniFocus 式的"按钮墙"，既挤又让用户分不清主次。规则：

- **一个区域只保留一个主操作**（accent 或语义最高的那个），其余收进 **溢出菜单（`⋯`）或行级 kebab（`⋮`）**。
- **重复结构用行 + kebab**：列表里每一项的操作不要逐个铺按钮，压成一行（名称 + 徽标 + 右侧 `⋮`），低频操作进 `⋮` 菜单。点击行 = 该项的主操作。
- 主操作可随状态变化（如有未保存改动时主操作是"更新"，否则是"+ 新建"）。
- 这是具体落地（哪些进主区、哪些进菜单）写在 `UX.md`；本文档只定原则与外观。

> e2e 选择器契约：若某操作被 e2e 依赖（带 `data-action`），收进溢出区时仍要保留真实带 `data-action` 的 `<button>`（用自定义 popover，而非 Obsidian `Menu`，因为 Menu item 不在受控 DOM 里）。无 e2e 依赖的行级 kebab 用原生 `Menu` 即可。

### 5.1 升级闸门 / Bento（样板，已对齐）

`tc-migration-card` / `tc-migration-bento` / `tc-bento-cell` / `tc-bento-art`。

- 头部：accent pill 徽标 + 大标题 + muted 引导句。
- What's New：**2×2 等大 bento 网格**，每格 = 示图 + 标题 + 一句话。窄屏（≤600px）单列。
- 主操作紧跟网格下方、居中加大，避免被下方长列表挤出视口。
- 迁移视图列表：圆角容器 + 每项 `accent 圆点 + 名称 + 内置/自定义 pill`。

### 5.2 Tab 栏

`bt-tabs` 等。当前 tab 用 §3 选中范式（底部 accent 指示条 + accent 文字），非选中走 muted。计数 / 快捷键徽标用 `--font-ui-smaller` + `--text-faint`，pill 用 `--radius-s` 或全圆。

### 5.3 工具栏过滤 chip

`标签 / 排期 / 更多时间 / 待办` 这排。统一为：`--background-modifier-hover` 底、`--radius-m`、`--font-ui-small`、1px token 边框；激活态走选中范式。各 chip 尺寸节奏一致（同 padding、同高度）。

### 5.4 周视图日列 `bt-week-col`

- 容器：`--background-secondary` + `var(--radius-m)`（**现状写死 6px**）。
- "今天 / 选中"：已是 soft 混色 + inset accent，**保留为全局选中范式的基准**。
- 头部字号走 `--font-ui-small` / `--font-ui-smaller`（**现状写死 13/11/10px**），字重走 `--font-semibold`（**现状 700**）。

### 5.5 月视图格

格子边框 1px token、圆角 `--radius-m`、当天/选中走选中范式（accent 描边或 soft 底）。格内任务 chip 见 §5.6。

### 5.6 任务卡片 chip

任务条用左侧 accent 竖条表示存在/强调，底色 `--background-secondary`，圆角 `--radius-s`，文字 `--text-normal`。选中加选中范式。`[[wiki link]]` 等内容样式不改写用户语义。

> 工具栏怎么排、时间范围选择器归谁——属于具体 UI / 信息架构决策，写在 `UX.md`（见"工具栏与组件自带导航"）。本文档只约束这些元素长什么样（chip/按钮的 token、状态）。

### 5.7 放弃区 / 拖放目标 `bt-trash`

这是当前**最不对齐**的组件，目标形态：

- 图标：用 `setIcon(el, "circle-slash")`（或等价 lucide），**不要 emoji `⏹`**。
- 文案：去掉提示语里的 `❌` 与 `[-]`，只留人类语义（如"拖到此处放弃"）；技术标记 `[-]` 属于实现细节，不进 UI 文案。
- 边框：默认 `1px solid var(--background-modifier-border)`；作为拖放目标可保留**虚线**作为"投放区"语义，但只在 `dragging-active` / `drop-hover` 时强调。
- 颜色：危险态用 `var(--text-error)` / `var(--background-modifier-error)`，**不用 `--color-red` 和 `rgba(255,0,0,…)`**。
- 圆角 `--radius-m`（**现状写死 8px**），字号走 token（**现状 28/12/10px**）。

## 6. 设计欠债清单（现状 → 目标）

逐条可执行，改一条勾一条。改动遵循"重构不改行为"：先有测试兜底，再调样式。

| # | 位置 | 现状 | 目标 |
| --- | --- | --- | --- |
| D1 | `renderTrashZone` (`view.ts`) | emoji 图标 `⏹` | `setIcon(..., "circle-slash")` 线性图标 |
| D2 | `trash.hint` (`i18n.ts`) | `拖到此处 → [-] ❌` | 纯语义文案，去掉 `[-]` 和 `❌`（中英都改） |
| D3 | `.bt-trash` (`styles.css`) | `--color-red` / `rgba(255,0,0,.08)` | `--text-error` / `--background-modifier-error` |
| D4 | `.bt-trash` | `2px dashed` + `border-radius: 8px` + `28/12/10px` | 1px token 边框、`--radius-m`、字号走 `--font-ui-*` |
| D5 | `.bt-week-col` | `border-radius: 6px`、`font-size: 13/11/10px`、`font-weight: 700` | `--radius-m`、`--font-ui-*`、`--font-semibold` |
| D6 | 全局选中态 | 各组件各写一套 | 统一到 §3 选中范式（soft 混色 + inset accent） |
| D7 | 工具栏 chip / tab | 尺寸与圆角不统一 | 对齐 §5.2 / §5.3 token |

新增组件不得再产生同类欠债：圆角/字号/颜色一律走 token，图标走 `setIcon` 或 CSS。

## 7. 落地流程

设计相关改动同样遵守仓库工作流：

1. 视觉改动若影响交互入口/状态，先回 `UX.md` 对齐。
2. 用本文档的 token / 范式实现，**不引入新魔法数字**。
3. `pnpm build` + 相关单测；CSS 受 `test/source-health.test.mjs` 约束。
4. UI 改动除测试通过，还要肉眼比对是否与闸门页同一调性。
