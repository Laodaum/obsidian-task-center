# Task Center Query DSL Reference

**English** · [中文](zh.md)

Every Tab in Task Center is a **Query DSL** (a single `QueryPreset` object). The same DSL drives all of: the graphical filters, the view layout, and CLI queries. Click **Edit Query** on any Tab to see and edit this JSON directly.

> This is the **SSOT (single source of truth)** for the DSL. If anything else (README, the skill, AI prompts) disagrees with this document, this document wins; change the DSL behaviour here first.
>
> Markdown is the single source of truth for data. The DSL only decides *how to filter, sort, and arrange* — the task data itself always lives in the Markdown lines of your vault. Views and filters are all derived from Markdown.
>
> For the field-by-field TypeScript types, see [`ARCHITECTURE.md` §1.3](../../ARCHITECTURE.md#13-querypreset); the runtime shape is whatever `QueryPreset` in `src/types.ts` says.

---

## 1. The shape of a preset

```jsonc
{
  "id": "preset-today",
  "name": "Today",
  "builtin": true,
  "hidden": false,
  "view": { "layout": { /* the layout tree: how to arrange, and what each block filters */ } }
}
```

| Field | Role |
| --- | --- |
| `id` / `name` | Stable id (locate by this, not the display name) / display name |
| `builtin` / `hidden` | Whether it's built-in / hidden from the Tab bar |
| `view.layout` | The **layout tree**: which components to show, how they nest, and **what each component filters**. |

> ⚠️ A preset is **identity + one `view.layout`, nothing more**. There is **no** tab-level `filters`, **no** `summary`, and **no** "view type" enum — all removed in 1.0 (US-109z2).
> - Filtering lives **only on each area's own `when`** (see §2). A `filters` written at the top level is **silently ignored** — no error, no effect.
> - The old flat shape (top-level `search`/`tag`/`time`/`status`) is **rejected outright** with `invalid_query`.
> - The old `view: {type, preset, sections, tray, matrix}` shape is **auto-migrated** into a `{ layout }` tree.

What a view looks like is **decided entirely by the `view.layout` tree**.

---

## 2. Filtering: each area's own `when`

There is no "base set for the whole Tab". Every list / grid / week / month area carries its **own `when`**, which is that block's entire filter. The graphical filter UI edits exactly this `when`; it is the same data as editing the DSL by hand.

```jsonc
"when": {
  "search": "report",                          // text in title / tags (case-insensitive)
  "tags": ["important", "urgent"],             // array (or comma string); auto-prefixed #; AND (must contain all)
  "status": ["todo"],                          // see below; omit = all
  "time": {
    "scheduled": "today",                      // ⏳ scheduled
    "deadline":  "next-7-days",                // 📅 deadline
    "completed": "week",                       // ✅ completed
    "created":   "2026-01-01..2026-06-30"      // ➕ created
  }
}
```

All conditions are **AND-ed**: to enter this block a task must satisfy every key in `when`.

### status

`todo` / `done` / `dropped` (an array, a single string, or `"all"`; omit = all). Matched against the terminal-inheritance-resolved `effectiveStatus`.

> The parser also accepts `in_progress` / `cancelled` / `custom`, but the graphical filter UI only exposes the three common values above.

### tags

Tag filtering is a **boolean expression**; the canonical form is `{ "expr": "…" }` (US-109d4).

- Syntax: `#tag`, `and`, `or`, `not`, parentheses `( )`; keywords are case-insensitive; precedence `not` > `and` > `or`; the `#` is optional.
- Example: `"tags": { "expr": "(#a or #b) and not #c" }` — has a or b, and not c.
- Match: the expression is parsed and evaluated against each task's tags. A syntax error → the area applies **no** tag filter (fail-open); tasks are never silently dropped.
- **Back-compat**: older shapes are **auto-migrated** to an equivalent `{ expr }` at normalize time; the evaluator only reads the expression:
  - bare array `["#a","#b"]` or comma string `"a,b"` → `"#a and #b"`
  - `{ "values":["#a","#b"], "mode":"or" }` → `"#a or #b"`
  - `{ "values":["#a"], "exclude":["#c"] }` → `"#a and not #c"`
- Graphical panel: the tag popover has an expression input (live-validated, with an example) plus a tag list; clicking a tag appends `#tag` to the expression.

### time — fields and date vocabulary

`time` supports 4 fields: `scheduled` / `deadline` / `completed` / `created`. Each takes one DateToken:

| Token | Meaning |
| --- | --- |
| `all` | no restriction |
| `today` / `tomorrow` | today / tomorrow |
| `week` / `next-week` | this week / next week |
| `month` | this month |
| `unscheduled` | **this field is empty** (e.g. "no scheduled date" = `scheduled: "unscheduled"`) |
| `overdue` | overdue (**`deadline` only**) |
| `next-7-days` | next 7 days (**`deadline` only**) |
| `2026-06-23` | a single day (`YYYY-MM-DD`) |
| `2026-06-01..2026-06-30` | a range (`from..to`, either end may be empty) |

> - `unscheduled` is not a date range — it means "this time field is empty".
> - There is **no `yesterday` / `next-month`** — those belong to the `task-center:list` CLI verb, not to `when`, and won't match here.

---

## 3. view.layout: a SwiftUI-style layout tree

The layout tree is made of two kinds of node:

- **Container node (Stack)**: `row` (≈ HStack) or `col` (≈ VStack), nesting children via `children`, with optional `weight` for the flex ratio. `children` must be non-empty.
- **Leaf node (Area)**: the components that actually render content (`list` / `grid` / `week` / `month` / `drop`).

```jsonc
"layout": {
  "dir": "col",                 // col = vertical; row = horizontal
  "children": [
    { "type": "week" },         // leaf: week grid
    { "type": "list", "weight": 1 }  // leaf: list, takes 1 flex unit
  ]
}
```

The root can be a Stack, or **a single area directly** (no wrapper needed). For example, the TODO view's root is just one `list`:

```jsonc
"layout": { "type": "list", "when": { "status": ["todo"] } }
```

The old "view types" are now **area types**: a view is no longer limited to one type — you freely compose multiple areas. Week = `col[ week-grid, row[unscheduled, drop] ]`, Unscheduled = `col[ list ]`, and you can build your own `row[ work-list, personal-list ]` side by side.

---

## 4. The area types, one by one

Common optional fields on every area: `id` (stable identifier), `title`, `weight` (flex ratio), `onDrop` (drag-in write, see §5.2).

### 4.1 list — task list

The workhorse: filters with `when` and renders a column of task cards. Parent/child tasks nest automatically.

![list view](../assets/dsl/todo.png)

```jsonc
{
  "type": "list",
  "when": { "tags": ["work"] },        // this block's filter (QueryFilters shape, see §2)
  "orderBy": ["deadline_risk", "created_desc"],
  "limit": 50,
  "emptyText": "No tasks"
}
```

| Field | Description |
| --- | --- |
| `when` | This block's filter (same `QueryFilters` shape, see §2). The graphical filter UI edits exactly this `when`. |
| `orderBy` | Sorting, see [§5.3](#53-orderby-sorting) |
| `limit` | Maximum number of cards |
| `emptyText` | Text shown when the set is empty |

#### Multi-segment lists — stack lists with col

A `list` has no internal grouping. To split a list into segments like "Today" does (Overdue / Today / Unscheduled), use a `col` container stacking 3 `list` areas, each carrying its own full `when` and filtering itself. It is the same component as TODO — the only difference is the layout tree (see the full Today DSL in §6). There is no "groups inside one list" — a shared filter is simply written into each block's `when`.

### 4.2 grid — card grid

Same fields and projection as `list`, but cards are arranged in a **responsive multi-column grid**. Two-dimensional classification (the four quadrants) is expressed by nesting several `grid`s — each with a `title` + `when` — inside `row`/`col`. There is **no dedicated matrix type**. Each grid's `when` uses "contains both tags" (AND) to carve out one cell:

![Four quadrants = grids nested in row/col](../assets/dsl/quadrant.png)

```jsonc
"layout": {
  "dir": "col",
  "children": [
    { "dir": "row", "children": [
      { "type": "grid", "title": "Important & Urgent",     "when": { "tags": ["important", "urgent"] } },
      { "type": "grid", "title": "Important & Not urgent", "when": { "tags": ["important", "not-urgent"] } }
    ] },
    { "dir": "row", "children": [
      { "type": "grid", "title": "Not important & Urgent",     "when": { "tags": ["not-important", "urgent"] } },
      { "type": "grid", "title": "Not important & Not urgent", "when": { "tags": ["not-important", "not-urgent"] } }
    ] }
  ]
}
```

### 4.3 week — week grid

A date grid laid out by week. Each day cell arranges its own content and implicitly carries `onDrop: { setScheduled: <that day> }` — dragging a card onto a day writes that day as its scheduled date. `when` decides which tasks appear in the week grid.

![Week view = col[ week, unscheduled, drop ]](../assets/dsl/week.png)

```jsonc
{ "type": "week", "when": { "status": ["todo"] }, "firstDayOfWeek": "monday" }   // monday | sunday
```

> See the full layout in [§6 Week](#week): below the week grid sits a row with an "Unscheduled" tray and a "Drop" zone.

### 4.4 month — month grid

A date grid laid out by month. Same usage as `week`, plus a density option.

![Month view](../assets/dsl/month.png)

```jsonc
{ "type": "month", "when": { "status": ["todo"] }, "firstDayOfWeek": "monday", "density": "cards" } // compact | cards
```

### 4.5 drop — pure action drop zone

A drop zone with no query — it only accepts drag actions, so `onDrop` is required (missing it raises `drop_requires_on_drop`). The "Drop" zone is just a drop area.

```jsonc
{ "type": "drop", "title": "Drop", "onDrop": { "setStatus": "dropped" } }
```

### 4.6 unknown — the fallback

An unsupported area `type` (a typo, or a removed legacy type such as the old matrix) is **not an error**: it is normalized to `unknown`, the original JSON is preserved, and the view renders "unknown type + JSON" instead of failing to load the whole config. So a misspelled `type` won't fail — it just renders as a useless unknown block; double-check the spelling.

---

## 5. Mechanisms

### 5.1 Filtering belongs to the area

Each list/grid/week/month area filters only via its **own `when`**, independent of the others.

- There is no "base set / global filter" for the whole Tab. To make a whole Tab show only `todo`, write `status: ["todo"]` in each area's `when` (that's exactly what the built-in views do).
- The graphical filter UI edits that area's `when` directly — it is the same data as editing the DSL.

### 5.2 onDrop: write on drag

The write performed when a card is dropped onto an area. The three semantics are **mutually exclusive**:

| Field | Effect |
| --- | --- |
| `setStatus: "dropped"` | mark the task as dropped (the Drop zone) |
| `setScheduled: <DateToken>` | write a scheduled date (`week`/`month` day cells implicitly use that day) |
| `clearScheduled: true` | clear the ⏳ scheduled date on the dragged task's own line (the unscheduled tray) |

A drop area must have `onDrop`; any other area (list/grid/…) may optionally carry one too. "Reschedule to tomorrow", "clear schedule", and "drop" are **general capabilities** of cards and drop areas — not actions tied to any one view.

### 5.3 orderBy sorting

`orderBy` takes an array of tokens applied in order as multi-level sort keys:

| Token | Meaning |
| --- | --- |
| `deadline_asc` / `deadline_desc` | by deadline, ascending / descending |
| `scheduled_asc` / `scheduled_desc` | by scheduled date |
| `created_desc` | by created time (newest first) |
| `completed_desc` | by completed time (newest first) |
| `deadline_risk` | by "deadline risk" (most urgent first) |
| `priority_desc` | by priority |
| `title_asc` / `title_desc` | alphabetically by title |

> Tokens not in this table (e.g. `created_asc`) are unsupported and silently ignored.

### 5.4 limit / emptyText

`limit` caps the number of cards in a single list; `emptyText` customizes the message shown when the set is empty.

---

## 6. Built-in views: complete examples

These are the **real factory DSLs** of the 7 built-in views (from `src/builtin-views/*.json`) — copy and tweak them as templates. Note they all have **no** tab-level `filters`; status and other filters always live on each area's `when`.

### TODO

A single ungrouped `list`, filtered on the area's `when`:

```jsonc
{ "view": { "layout": { "type": "list", "when": { "status": ["todo"] } } } }
```

### Today

**col** stacking 3 lists (Overdue / Today / Unscheduled); each list carries its own `when` and filters itself (`todo` is written into every block's `when`):

```jsonc
{ "view": { "layout": {
  "dir": "col",
  "children": [
    { "type": "list", "id": "overdue", "title": "Overdue",
      "when": { "status": ["todo"], "time": { "deadline": "overdue" } },
      "orderBy": ["deadline_asc"], "limit": 3 },
    { "type": "list", "id": "today", "title": "Today",
      "when": { "status": ["todo"], "time": { "scheduled": "today" } }, "limit": 3 },
    { "type": "list", "id": "unscheduled-rec", "title": "Unscheduled",
      "when": { "status": ["todo"], "time": { "scheduled": "unscheduled", "deadline": "unscheduled" } },
      "orderBy": ["created_desc"], "limit": 3 }
  ]
} } }
```

### Unscheduled

`col[ list ]`, where the list's `when` selects "no scheduled date AND todo":

```jsonc
{ "view": { "layout": { "dir": "col", "children": [
  { "type": "list",
    "when": { "time": { "scheduled": "unscheduled" }, "status": ["todo"] },
    "orderBy": ["deadline_risk", "created_desc"] }
] } } }
```

### Week

`col[ week, row[ grid(unscheduled tray), drop ] ]`, each block carrying its own `when`:

```jsonc
{ "view": { "layout": { "dir": "col", "children": [
  { "type": "week", "when": { "status": ["todo"] } },
  { "dir": "row", "children": [
    { "type": "grid", "id": "unscheduled-tray", "title": "Unscheduled",
      "when": { "time": { "scheduled": "unscheduled" }, "status": ["todo"] },
      "onDrop": { "clearScheduled": true } },
    { "type": "drop", "title": "Drop",
      "onDrop": { "setStatus": "dropped" } }
  ] }
] } } }
```

### Month

Same as Week, with `month` on top instead:

```jsonc
{ "view": { "layout": { "dir": "col", "children": [
  { "type": "month", "when": { "status": ["todo"] } },
  { "dir": "row", "children": [
    { "type": "grid", "id": "unscheduled-tray", "title": "Unscheduled",
      "when": { "time": { "scheduled": "unscheduled" }, "status": ["todo"] },
      "onDrop": { "clearScheduled": true } },
    { "type": "drop", "title": "Drop", "onDrop": { "setStatus": "dropped" } }
  ] }
] } } }
```

### Completed

A `list`, newest-completed first:

```jsonc
{ "view": { "layout": {
  "type": "list",
  "when": { "status": ["done"] },
  "orderBy": ["completed_desc"]
} } }
```

### Dropped

A `list`, filtered on `dropped`:

```jsonc
{ "view": { "layout": { "type": "list", "when": { "status": ["dropped"] } } } }
```

---

## 7. Graphical editing ↔ DSL ↔ CLI (one shared schema)

The graphical filter UI, editing the JSON directly via "Edit Query", and managing queries from the CLI all share the same DSL and validation: changing a filter in the UI edits some area's `when`, which is exactly equivalent to writing it by hand in this JSON. On the CLI side, `obsidian task-center:query-*` reads/writes the same preset (`query-show` / `query-run` / `query-create` / `query-update` …).

> 🖼️ **Figure TODO** — show the graphical filter popover next to the corresponding `when` JSON snippet, with the one-to-one mapping called out.

---

## 8. Design principles in brief

1. **Markdown is the single source of truth**; the DSL is only a derived layer.
2. **One view = one layout tree**; no view-type enum, and the renderer never branches on names like today / completed.
3. **Filtering belongs to the area**: each area's `when` is its entire filter — no tab-level base set, no global filter state.
4. **Actions are general capabilities**: reschedule / clear-schedule / drop are provided by cards and drop areas, not bound to a view.
5. **Unknown types don't error**: they normalize to an `unknown` fallback.
6. **No `summary`**: top-of-view metrics were removed; estimate/retro stats live in the `task-center:stats` / `review` CLI.

---

> Screenshots are from the desktop Task Center; tag names, group titles, and other text reflect each vault's real data.
