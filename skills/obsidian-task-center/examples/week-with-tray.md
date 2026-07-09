# 例：周视图 + 未排期托盘 + 放弃区

`dir:"col"` 顶部一个 `week` area，底部一行放 `grid` 托盘（未排期任务）+ `drop` 放弃区。拖动可改排期 / 放弃。

布局（易读版）：

```json
{
  "name": "工作周",
  "view": { "layout": {
    "dir": "col",
    "children": [
      { "type": "week", "when": { "tags": ["#work"], "status": ["todo"] } },
      { "dir": "row", "children": [
        { "type": "grid", "id": "unscheduled-tray", "title": "未排期",
          "when": { "time": { "scheduled": "unscheduled" }, "status": ["todo"] },
          "onDrop": { "clearScheduled": true } },
        { "type": "drop", "title": "放弃", "onDrop": { "setStatus": "dropped" } }
      ]}
    ]
  }}
}
```

更新到已有 tab：

```bash
obsidian task-center:query-update id=sv-alpha dsl='{"name":"工作周","view":{"layout":{"dir":"col","children":[{"type":"week","when":{"tags":["#work"],"status":["todo"]}},{"dir":"row","children":[{"type":"grid","id":"unscheduled-tray","title":"未排期","when":{"time":{"scheduled":"unscheduled"},"status":["todo"]},"onDrop":{"clearScheduled":true}},{"type":"drop","title":"放弃","onDrop":{"setStatus":"dropped"}}]}]}}}'
```

要点：
- `week` area 用 `firstDayOfWeek` 控制周首日（默认 monday）。
- 托盘用 `grid`（多列卡片）过滤 `scheduled:"unscheduled"`；`onDrop:{clearScheduled:true}` 表示拖进托盘即清掉排期。
- `drop` 是纯动作区，无查询；`onDrop:{setStatus:"dropped"}` 把拖入任务标为放弃。
- `onDrop` 三选一：`setStatus` / `setScheduled` / `clearScheduled`。
