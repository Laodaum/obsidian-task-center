# 例：简单列表 / 分区列表

## 最简单：单个 list area

过滤 todo + 标签，一条命令：

```bash
obsidian task-center:query-create dsl='{"name":"工作","view":{"layout":{"type":"list","when":{"tags":["#work"],"status":["todo"]}}}}'
```

## 分区列表：一个 area 里用 sections 命名分组

如"逾期 / 今天 / 本周其余"三段。`sections` 仅 `list`/`grid` 可用，每段有自己的 `when`（也可有 `orderBy` / `limit` / `emptyText`）。

```json
{
  "name": "今日聚焦",
  "view": { "layout": {
    "type": "list",
    "when": { "status": ["todo"] },
    "sections": [
      { "id": "overdue", "title": "逾期",     "when": { "time": { "deadline": "overdue" } } },
      { "id": "today",   "title": "今天",     "when": { "time": { "scheduled": "today" } } },
      { "id": "week",    "title": "本周其余", "when": { "time": { "scheduled": "week" } } }
    ]
  }}
}
```

创建：

```bash
obsidian task-center:query-create dsl='{"name":"今日聚焦","view":{"layout":{"type":"list","when":{"status":["todo"]},"sections":[{"id":"overdue","title":"逾期","when":{"time":{"deadline":"overdue"}}},{"id":"today","title":"今天","when":{"time":{"scheduled":"today"}}},{"id":"week","title":"本周其余","when":{"time":{"scheduled":"week"}}}]}}}'
```

要点：area 顶层 `when` 是该区总过滤，各 `section.when` 在其内再细分。内置 `preset-today` 就是这种分区列表，可 `query-show id=preset-today` 照抄。
