---
id: local.no-inset-left-border
title: 不用 inset box-shadow 模拟左侧 accent 竖条边框
language: css
level: error
tags: [local, css, ui]
---

# 不用 inset box-shadow 模拟左侧 accent 竖条边框

UI 中不应使用 `box-shadow: inset` 来模拟左侧 accent 竖条（作为选中/激活状态指示器）。
这种模式在视觉上会产生不统一的"边框感"，与设计规范冲突（`cards.css` 早有「No coloured
left spine」定论）。选中/激活状态应只用背景色高亮（`background: var(--background-modifier-hover)`
或 `color-mix(... var(--interactive-accent) N%, ...)` 软填充）表达。

匹配两种写法：3 数值 `inset Npx 0 0 <accent>` 与带 spread 的 4 数值 `inset Npx 0 0 0 <accent>`。

> 工具限制（务必知悉）：grit 0.1.1 的 tree-sitter-css 不支持 `:not()` 选择器，遇到
> `.a:not(.b){}` 会从该处起解析失败，导致其后规则**扫不到**。本仓 `mobile.css` /
> `tabs.css` / `area-layout.css` 大量用 `:not()`，所以这条规则在这些文件上是 best-effort、
> 可能漏报——它能可靠覆盖不含 `:not()` 的 CSS。左 spine 的最终防线仍是本规则 + 这段约定 +
> code review，写样式时不要图省事加左色条。

```grit
language css
or {
  `box-shadow: inset $offset 0 0 var(--interactive-accent)`,
  `box-shadow: inset $offset 0 0 0 var(--interactive-accent)`
}
```

## Bad

```css
.bt-manage-tab-row-active {
  background: var(--background-modifier-hover);
  box-shadow: inset 2px 0 0 var(--interactive-accent);
}
```

```css
/* 带 spread 的 4 数值形式同样是左 spine，照样禁止。 */
.bt-area-accordion-active > .bt-area-head {
  background: var(--background-modifier-hover);
  box-shadow: inset 3px 0 0 0 var(--interactive-accent);
}
```

## Good

```css
.bt-manage-tab-row-active {
  background: var(--background-modifier-hover);
}
```
