# 例：四象限视图（Covey）

2×2 网格：外层 `dir:"col"` 套两个 `dir:"row"`，每个 row 放两个 `list` area，按 `#1象限..#4象限` 过滤。象限编码见 SKILL.md 表（1=紧急且重要，2=重要不紧急，3=紧急不重要，4=都不是）。

布局（易读版）：

```json
{
  "name": "四象限",
  "view": { "layout": {
    "dir": "col",
    "children": [
      { "dir": "row", "children": [
        { "type": "list", "title": "① 紧急且重要", "when": { "tags": ["#1象限"], "status": ["todo"] } },
        { "type": "list", "title": "② 重要不紧急", "when": { "tags": ["#2象限"], "status": ["todo"] } }
      ]},
      { "dir": "row", "children": [
        { "type": "list", "title": "③ 紧急不重要",  "when": { "tags": ["#3象限"], "status": ["todo"] } },
        { "type": "list", "title": "④ 都不是",      "when": { "tags": ["#4象限"], "status": ["todo"] } }
      ]}
    ]
  }}
}
```

创建：

```bash
obsidian task-center:query-create dsl='{"name":"四象限","view":{"layout":{"dir":"col","children":[{"dir":"row","children":[{"type":"list","title":"① 紧急且重要","when":{"tags":["#1象限"],"status":["todo"]}},{"type":"list","title":"② 重要不紧急","when":{"tags":["#2象限"],"status":["todo"]}}]},{"dir":"row","children":[{"type":"list","title":"③ 紧急不重要","when":{"tags":["#3象限"],"status":["todo"]}},{"type":"list","title":"④ 都不是","when":{"tags":["#4象限"],"status":["todo"]}}]}]}}}'
```

要点：
- 二维网格靠**嵌套 stack**：外层 `col`，内层 `row`。
- 每格独立 `when`，互不影响。
- 想让"未排期"任务能拖进某象限？把对应 `list` 换成 `grid` 并加 `onDrop`（见 `week-with-tray.md`）。
