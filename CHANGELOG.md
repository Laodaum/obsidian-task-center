# Changelog

## Unreleased

## 0.8.7 — 2026-05-13

- CLI: add `obsidian task-center` as a root help command covering task verbs, Query Tab verbs, and the companion AI skill install command.
- Tests: lock the full native Obsidian CLI registration surface so future releases cannot accidentally ship only a partial command set.

## 0.8.5 — 2026-05-13

- Release: remove the platform name from the plugin description to satisfy community plugin directory validation.

## 0.8.4 — 2026-05-09

- Performance: reduce repeated QueryPreset matrix bucket filtering and speed up week/month date placement.

## 0.8.3 — 2026-05-08

- CLI: add `query-run` to execute a Query Tab preset and render list/week/month/matrix output, with optional temporary view override.
- CLI: `query-list` now reports whether each Query Tab is builtin or custom in both text and JSON output.
- Skill: document Query Tab listing, DSL inspection, create/update, rename/copy/hide/delete/default workflows for agents.

## 0.7.5 — 2026-04-29

- Saved-view filters: close open popovers on outside click, add spacing between tag rows, and tighten status/date popover sizing so compact dialogs do not leave large empty areas.
- Mobile: replace touch drag/drop with explicit Unscheduled and Quick Add entries; task abandon stays available through swipe/action flows instead of a mobile drop target.

## 0.7.1 — 2026-04-28

- Adjust release description to satisfy Obsidian community-plugin validation.

## 0.7.0 — 2026-04-28

- Prepare community plugin submission: rename the Obsidian plugin ID from `obsidian-task-center` to `task-center`, add the MIT license file, and sync install docs/tests with the new ID.

## 0.6.2 — 2026-04-28

- Fix saved filter views so editing filters while a saved view is selected keeps that view selected and updates it in place via an “Update” action.

## 0.6.1 — 2026-04-28

- Fix filters to match US-109: tag is a multi-select, date is a condition select, and the toolbar search placeholder is explicit instead of a generic filter label.

## 0.6.0 — 2026-04-28

- CLI: add `task-center:abandon` as the preferred verb for `[-] ❌`. `task-center:drop` is kept as a deprecated alias (same behavior, output text unchanged for backward compat).
- GUI: every card has an inline `+ 子任务` / `+ subtask` affordance — click to add a child without keyboard shortcuts; subtask inherits the parent's `⏳`.
- GUI: card-removal actions (drag to trash / different day, mark done, abandon, date prompt, ←/→ shift, Space, Delete) now fade + collapse via Web Animations API so neighbours slide up smoothly. No-op moves skip the animation.
- GUI + CLI: drag a card onto another card to nest it as a subtask. Works **cross-file** (insert into target file, then delete from source). New CLI verb `task-center:nest ref=X under=Y`. Cycles and self-drops are rejected. No undo for nest — use git or Obsidian file history.

## 0.1.0 — 2026-04-23

Initial release. Energy-aware Task Center + CLI on top of Obsidian Tasks syntax.

### GUI

- Full-tab Task Center with 4 views: Week / Month / Completed / Unscheduled.
- Drag-and-drop to schedule tasks between days; drag to the sticky trash bin to mark `[-] ❌ today`; drop cascades to todo subtasks (done subtasks preserved).
- Click card title → inline rename; Enter commits, Escape reverts. All metadata preserved (tags, emojis, `[estimate::]`, `[actual::]`, `^blockrefs`, `🔁` recurrence, `🔺⏫🔼🔽⏬` priority).
- Keyboard shortcuts on a selected card: `1–4` quadrant, `←/→` day, `D` date prompt, `Space` done, `E`/`Enter` open source, `Delete` drop, `Ctrl/Cmd+Z` undo (20-deep stack for drag / arrow / rename mutations). `/` focuses search. `Ctrl+1–4` switches tabs. `Ctrl+T` quick add. `⌘/Ctrl+Shift+T` opens Task Center.
- Quick Add modal with natural-language dates (today / tomorrow / 明天 / 周六 / Mon / YYYY-MM-DD).
- Masonry unscheduled pool sorted by deadline (urgent first), then by created date desc.
- Week columns sorted by deadline within each day.
- Completed tab: 7-day stats header (accuracy ratio + top-4 tag minutes), collapsible per-week groups (past weeks default collapsed).
- Ancestor terminal propagation — when a task / bullet is `[x]` / `[-]` / `#dropped`, all descendants are hidden from active views.
- Subtasks deduped at top level when parent is visible; subtask cards badge their `⏳` when different from parent's.
- Empty-state onboarding when vault has no tasks.
- Status bar widget: `📋 N today · ⚠ M overdue`; click opens Task Center.
- Tab bar shows active-todo counts as badges.
- Tasks nested inside Obsidian callouts (`> - [ ] ...`) are first-class.
- i18n auto-detect (zh / en) via `localStorage.language`.

### CLI (Obsidian native `registerCliHandler`, requires 1.12.2+)

12 colon-grouped verbs under `task-center:…`:

- Read: `list` (filters: `scheduled/done/overdue/has-deadline/status/tag/parent/search/limit/format`), `show`, `stats` (days/group/from/to/format).
- Write (idempotent, returns `before/after` diff): `schedule`, `deadline`, `actual` (supports `+Nm` additive), `estimate`, `done` (with optional `at=`), `undone`, `drop` (cascades), `tag` (add / `remove`), `add` (with `to/tag/scheduled/deadline/estimate/parent/stamp-created`).
- `format=json` on `list` and `stats` returns structured data for AI/scripts.

### Data model

- Inline markdown tasks; fully aligned with `obsidian-tasks-group/obsidian-tasks` conventions.
- `➕ YYYY-MM-DD` created, `⏳` scheduled, `📅` deadline, `🛫` start, `✅` done, `❌` cancelled, `🔁` recurrence, priority glyphs, `[estimate:: 90m]`, `[actual:: 75m]`.
- Task IDs: `<path>:L<line>` (primary) + 12-char title hash (fallback).
- Writes via `Vault.process` (atomic); reads via `MetadataCache.listItems` (fast-skip of task-less files).

### Infrastructure

- TypeScript 5.3, esbuild 0.21, Obsidian 1.5 types.
- Zero runtime dependencies beyond Obsidian itself.
- `README.md`, `SKILL.md` (AI-agent contract), `versions.json`.
- `npm run dev` (esbuild watch), `npm run build` (production), `npm run typecheck`.
- Recommended install during development: `ln -s $(pwd) <vault>/.obsidian/plugins/task-center`, then `obsidian plugin:reload id=task-center`.

### Known limitations

- Sub-task drag to another day changes `⏳` in place rather than creating a `[[parent]] > child` wikilink entry on the target day (spec left this as a design choice).
- Settings changes don't hot-reload into open Task Center views; close and reopen Task Center after changing week-start, etc.
- `window.prompt` is disabled in Electron; all date entry goes through the `DatePromptModal`.
