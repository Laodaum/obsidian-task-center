---
id: local.no-inset-left-border
title: 不用 inset box-shadow 模拟左侧 accent 竖条边框
language: css
level: error
tags: [local, css, ui]
---

# 不用 inset box-shadow 模拟左侧 accent 竖条边框

UI 中不应使用 `box-shadow: inset` 来模拟左侧 accent 竖条（作为选中/激活状态指示器）。
这种模式在视觉上会产生不统一的"边框感"，与设计规范冲突。
选中/激活状态应只用背景色高亮（`background: var(--background-modifier-hover)`）表达。

```grit
language css
`box-shadow: inset $offset 0 0 var(--interactive-accent)`
```

## Bad

```css
.bt-manage-tab-row-active {
  background: var(--background-modifier-hover);
  box-shadow: inset 2px 0 0 var(--interactive-accent);
}
```

## Good

```css
.bt-manage-tab-row-active {
  background: var(--background-modifier-hover);
}
```
