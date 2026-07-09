# 例：简单列表 / 多段列表

## 最简单：单个 list area

过滤 todo + 标签，一条命令：

```bash
obsidian task-center:query-create dsl='{"name":"工作","view":{"layout":{"type":"list","when":{"tags":["#work"],"status":["todo"]}}}}'
```

## 多段列表：col 叠多个 list area

如"逾期 / 今天 / 本周其余"三段。`list` 没有内部分组，要分段就用 `col` 容器叠多个 `list`，每个 list 自带完整 `when`、各自 filter 自己（共享条件如 `status: todo` 在每块里各写一遍；每块也可有 `orderBy` / `limit` / `emptyText`）。

```json
{
  "name": "今日聚焦",
  "view": { "layout": {
    "dir": "col",
    "children": [
      { "type": "list", "id": "overdue", "title": "逾期",     "when": { "status": ["todo"], "time": { "deadline": "overdue" } } },
      { "type": "list", "id": "today",   "title": "今天",     "when": { "status": ["todo"], "time": { "scheduled": "today" } } },
      { "type": "list", "id": "week",    "title": "本周其余", "when": { "status": ["todo"], "time": { "scheduled": "week" } } }
    ]
  }}
}
```

创建：

```bash
obsidian task-center:query-create dsl='{"name":"今日聚焦","view":{"layout":{"dir":"col","children":[{"type":"list","id":"overdue","title":"逾期","when":{"status":["todo"],"time":{"deadline":"overdue"}}},{"type":"list","id":"today","title":"今天","when":{"status":["todo"],"time":{"scheduled":"today"}}},{"type":"list","id":"week","title":"本周其余","when":{"status":["todo"],"time":{"scheduled":"week"}}}]}}}'
```

要点：每个 list area 自己 filter 自己，没有"一个 list 内部再分组"这回事。内置 `preset-today` 就是这种多段列表（col 叠 3 个 list），可 `query-show id=preset-today` 照抄。
