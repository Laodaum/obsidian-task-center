---
name: obsidian-task-center
description: Read and write tasks in an Obsidian vault through the Task Center plugin's CLI. Use when the user wants to list, schedule, complete, abandon, nest, or add tasks — or when they want estimate-accuracy / review / agent-brief stats. Obsidian must be running with the `task-center` plugin enabled; all verbs are namespaced `obsidian task-center:<verb>`.
---

# Obsidian Task Center — CLI skill

This skill is the AI interface to the obsidian-task-center plugin. The plugin registers its verbs to Obsidian's native CLI (1.12.2+), so calls go `obsidian task-center:<verb> key=value …`.

Data stays inline markdown. Syntax:

```
- [ ] Title #2象限 📅 2026-05-15 ⏳ 2026-04-24 ➕ 2026-04-23 [estimate:: 90m] [actual:: 75m]
```

| Field | Encoding | Meaning |
|---|---|---|
| `⏳ YYYY-MM-DD` | scheduled | which day the user plans to do it |
| `📅 YYYY-MM-DD` | deadline | external hard deadline |
| `➕ YYYY-MM-DD` | created | when the task was added |
| `✅ YYYY-MM-DD` | completed | done stamp (written when `[x]`) |
| `❌ YYYY-MM-DD` | cancelled | dropped stamp (written when `[-]`) |
| `[estimate:: Nm]` | estimate | minutes planned |
| `[actual:: Nm]` | actual | minutes actually spent |
| `#1象限..#4象限` | quadrant | Covey quadrants (1=urgent+important, 2=not-urgent+important, 3=urgent, 4=neither) |

## When to use this skill

- "list today's tasks" / "what do I have scheduled" → `task-center:list`
- "show task details" / "pull the raw line" → `task-center:show`
- "schedule X" / "move X to tomorrow" → `task-center:schedule`
- "mark X done" / "I finished X" → `task-center:done`
- "drop X" / "abandon X" / "remove X" → `task-center:abandon`
- "nest X under Y" / "make X a subtask of Y" → `task-center:nest`
- "log time on X" / "I spent 45m on X" → `task-center:actual`
- "add a task" / "remind me to …" → `task-center:add`
- "how accurate were my estimates" / "weekly review" → `task-center:stats`
- "what should I do next" / "brief me on today" → `task-center:brief`
- "end-of-day review" / "what happened this week" → `task-center:review`

**Do not** use `Read`/`Write` directly on task files to mutate tasks — use the CLI so `vault.process` locking + parser conventions are respected. Reading files is fine when you want broader context (the task body, surrounding notes).

## Before calling any verb

Verify the plugin is loaded:

```bash
obsidian plugins:enabled | grep task-center
```

If missing, ask the user to enable it. If Obsidian isn't running, the CLI will auto-launch (first call incurs latency).

## Verbs

### `task-center:list [filters]`

Read-only. Returns tasks matching all filters. Every row starts with `<path>:L<line>` as the id — safe to pipe.

```
obsidian task-center:list scheduled=today
obsidian task-center:list scheduled=unscheduled tag='#2象限'
obsidian task-center:list done=2026-04-01..2026-04-30
obsidian task-center:list overdue
obsidian task-center:list status=todo search=示例
```

`scheduled=` / `done=` vocabulary:
- `today` / `tomorrow` / `yesterday`
- `week` (this week) / `next-week`
- `month` / `next-month`
- `unscheduled` (only meaningful with `scheduled=`)
- ISO `YYYY-MM-DD`
- range `YYYY-MM-DD..YYYY-MM-DD`

Other flags: `overdue`, `has-deadline`, `status=todo|done|dropped`, `tag=<comma-sep>` (supports `#*象限`), `parent=<id>`, `search=<text>`, `limit=N`, `format=text|json` (JSON gives a structured array with every field — prefer it when you plan to parse).

### `task-center:show ref=<id>`

Full single-task detail — scheduled/deadline/estimate/actual/created/completed/cancelled/parent/children/raw.

### `task-center:stats [days=N] [group=<prefix>]`

Rolling-window estimate accuracy + tag minutes breakdown. Default `days=7`. `group=象限` aggregates matching tags into a section (useful for Covey quadrants). Output includes:

- `sum actual / sum estimate` ratio (calibration signal)
- `per-task mean / σ` for ratio variance
- `within band 11/18 (61%)` share inside `[0.8, 1.25]`
- per-tag minutes with ASCII bar chart

Use this to **correct planning-fallacy** when suggesting estimates. If the 7-day `ratio` is 1.3, new estimates should be scaled up by that factor vs. the user's gut feel.

### `task-center:brief [today=YYYY-MM-DD] [limit=N] [format=text|json]`

Agent brief for near-term planning. Shows overdue / today / unscheduled candidate counts, sample tasks, and executable next-action commands such as `done`, `abandon`, `schedule_today`, `schedule_tomorrow`, and `actual +15m`.

Use this when the user asks what to do next or wants a compact status overview before planning.

### `task-center:review [today=YYYY-MM-DD] [days=N] [limit=N] [format=text|json]`

End-of-day / weekly retrospective summary. Reports today and rolling-week windows: done, abandoned, delayed-open tasks, estimate-vs-actual totals, grouping summaries, and sample task ids.

Use this for shutdown reviews, weekly reviews, and "what actually happened?" questions. Prefer text output for user-facing summaries; use `format=json` only when you need to parse it.

### Write verbs (idempotent, safe to retry)

All write verbs return `ok <id>` with a `before / after` diff, or `unchanged` if already in the target state.

```
obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=2026-04-25
obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=null       # clear ⏳

obsidian task-center:deadline ref=… date=2026-05-15
obsidian task-center:deadline ref=… date=null

obsidian task-center:estimate ref=… minutes=90m         # set [estimate::]
obsidian task-center:estimate ref=… minutes=null        # clear
obsidian task-center:actual   ref=… minutes=45m         # set [actual::]
obsidian task-center:actual   ref=… minutes=+15m        # additive

obsidian task-center:done   ref=… [at=YYYY-MM-DD]       # [x] + ✅
obsidian task-center:undone ref=…                        # reverse a done
obsidian task-center:abandon ref=…                       # [-] + ❌, cascades to todo children
obsidian task-center:drop   ref=…                        # deprecated alias for abandon

obsidian task-center:tag    ref=… tag='#基建'            # add
obsidian task-center:tag    ref=… tag='#基建' remove     # remove

obsidian task-center:nest   ref=… under=…                # make ref a subtask of under

obsidian task-center:add text="处理示例任务" tag='#3象限' scheduled=2026-04-26 [to=<path>] [deadline=…] [estimate=30m] [parent=<id>]
```

`task-center:add` target priority: explicit `to=` → parent's file (if `parent=` given) → today's Daily Note. There is no inbox fallback: when neither `to=` nor `parent=` is supplied, the Daily Notes core plugin must be enabled and configured or the command fails with `daily_notes_unavailable`. Default stamps `➕ today` unless `stamp-created=false`.

`abandon` / `drop` cascades to todo descendants only. Already completed / abandoned / cancelled descendants keep their historical stamps. To abandon just one line, pass a leaf task.

### Error shape

Errors go to stderr as:

```
error  <code>
    <human message>
```

Common codes: `task_not_found`, `ambiguous_slug`, `invalid_date`, `daily_notes_unavailable`, `invalid_nest`, `nest_partial`.

Recover by:
- `task_not_found` → re-run `task-center:list` to get fresh ids
- `ambiguous_slug` → the error message lists candidate ids; pick one
- `invalid_date` → convert to `YYYY-MM-DD`
- `daily_notes_unavailable` → enable/configure Daily Notes, or pass `to=<path>`
- `invalid_nest` / `nest_partial` → inspect the named source/target tasks before retrying

## Recommended workflows

### End-of-day wrap-up

1. `obsidian task-center:list done=today` → collect what got done.
2. `toggl entry list --since today` → cross-reference actual time per task.
3. For each completed task: `obsidian task-center:actual ref=… minutes=Nm` to record real time.
4. `obsidian task-center:review days=7` → read today's / week's completion, abandonment, delay, and estimate summary.
5. `obsidian task-center:stats days=7 group=象限` → read calibration.
6. `obsidian task-center:brief` or `obsidian task-center:list scheduled=unscheduled` + `obsidian task-center:list scheduled=tomorrow` → candidate pool.
7. Pick tomorrow's set (≤1 big, ≤2 small based on user's self-declared capacity), deadline-first, quadrant-2-first.
8. `obsidian task-center:schedule ref=… date=<tomorrow>` per chosen task; use `add` for anything new.

### Quick capture

User says "don't forget to X". Default to today's daily note:

```
obsidian task-center:add text="X"
```

Only set `scheduled=` / `deadline=` / `tag=` if the user specified them.

### Backfill completions

User says "I finished Y yesterday": `obsidian task-center:done ref=<id> at=<yesterday>`.

## Output contract

- Every list row starts with `<path>:L<line>` — pipe-friendly.
- Monetary / time values: minutes, no conversion. Format with `formatMinutes` convention (`90m`, `1h30m`).
- Writes print `before / after` — use this to confirm the mutation was what you intended.
- Stats output is ASCII-bar-charted; do not JSON-ify it before showing the user.
- `brief` and `review` default to greppable text; use `format=json` only for downstream parsing.

## Do not

- Do not edit task files directly with `Read` + `Write`; use the CLI so parser + locking invariants hold.
- Do not try to install a wrapper shell script called `obsidian-task-center`; the plugin uses Obsidian's native CLI.
- Do not call `obsidian task` / `obsidian tasks` (those are built-in, read-only) when you mean `task-center:…`.
- Do not stamp `✅` / `❌` / `➕` manually with `Edit` — let the plugin do it via `done` / `abandon` / `add`.
