# Obsidian Task Center

[简体中文](./README.zh-CN.md)

Task Center is an Obsidian plugin that adds a daily/weekly/monthly task board, parent-child task rendering, natural-language Quick Add, mobile gestures, and an AI-friendly CLI on top of Obsidian Tasks markdown.

It does not create a new database or task format. Your source of truth stays in markdown:

```markdown
- [ ] Plan the launch #work ⏳ 2026-05-15 📅 2026-05-20 [estimate:: 90m]
    - [ ] Draft release notes [estimate:: 30m]
- [x] Ship the fix ✅ 2026-04-28 [actual:: 45m]
- [-] Retired idea ❌ 2026-04-28
```

<video src="screenshots/week-drag.mp4" controls muted></video>

<video src="screenshots/month-drag.mp4" controls muted></video>

![Month view](screenshots/month.png)

## Why Task Center

Obsidian Tasks owns the task syntax and query model. Task Center keeps that foundation and adds the working surfaces that are awkward to build in a note:

| Need | Task Center adds |
| --- | --- |
| Plan the week | A full-tab board with Today, Week, Month, Completed, and Unscheduled views |
| Move work around | Drag tasks between dates, nest under another task, or abandon without deleting markdown |
| Handle task trees | Recursive parent-child cards with inherited schedule/status semantics |
| Capture quickly | Spotlight-style Quick Add with English and Chinese date parsing |
| Review estimates | Estimate vs actual summaries via inline fields such as `[estimate::]` and `[actual::]` |
| Use mobile | Phone layout, long-press menus, swipe actions, and keyboard-safe Quick Add |
| Let an AI agent help | Stable `obsidian task-center:*` CLI verbs with greppable output |

## Install

Task Center is not yet listed in Obsidian's Community Plugins browser. Until it is, install it with BRAT so releases and updates come from GitHub.

### Prerequisites

1. Install and enable [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks). Task Center reads and writes Tasks-compatible markdown and expects the Tasks plugin to remain the data-layer companion.
2. Enable Obsidian's built-in **Daily Notes** core plugin and set its "New file location". Quick Add writes new tasks to today's Daily Note and refuses to fall back to an inbox when Daily Notes is missing or misconfigured.

### Install with BRAT

1. In Obsidian, open **Settings -> Community plugins**.
2. Turn off Restricted Mode if Obsidian asks you to.
3. Click **Browse**, search for **BRAT**, install **Obsidian42 - BRAT**, and enable it.
4. Open **Settings -> BRAT**.
5. Choose **Add Beta Plugin**.
6. Paste this repository URL:

   ```text
   https://github.com/CorrectRoadH/obsidian-task-center
   ```

7. Let BRAT install the latest release.
8. Return to **Settings -> Community plugins** and enable **Task Center**.

### Mobile install

Task Center is mobile-capable (`isDesktopOnly: false`). Install it on desktop with BRAT, sync plugins with Obsidian Sync, then enable **Task Center** in Obsidian Mobile.

## Quick Start

1. Write or keep using normal Tasks-style checkboxes in any markdown file.
2. Add schedule, deadline, estimate, and actual-time metadata only when useful:

   ```markdown
   - [ ] Review PR #work ⏳ today [estimate:: 30m]
   - [ ] Renew passport 📅 2026-05-30
   ```

3. Open Task Center from the ribbon icon, command palette, or `Ctrl/Cmd+Shift+T`.

4. Use **Quick Add** with `Ctrl/Cmd+T` inside the board:

   ```text
   Review beta feedback #work tomorrow [estimate:: 25m]
   处理发布清单 #3象限 周六 [estimate:: 45m]
   ```

Natural-language dates such as `today`, `tomorrow`, `今天`, and `周六` are resolved to ISO dates before writing markdown.

## Views

- **Today**: overdue, scheduled-today, and unscheduled-recommendation groups with quick actions.
- **Week**: seven columns, today highlighted, with per-day task counts and estimate totals.
- **Month**: calendar grid with date drop zones.
- **Completed**: review timeline grouped by week with estimate-vs-actual summaries.
- **Unscheduled**: task pool sorted by deadline and creation order.

Drag a card to a date to change `⏳`. Drop it onto another card to nest it. Drop it on the abandon target to mark it `[-] ❌` instead of deleting the source line.

## Syntax

Task Center preserves Obsidian Tasks metadata such as `⏳`, `📅`, `🛫`, `➕`, and `✅`, and uses `[-] ❌ YYYY-MM-DD` for abandoned tasks.

Estimate and actual-time summaries use inline fields such as `[estimate:: 90m]`, `[estimate:: 1h30m]`, and `[actual:: 75m]`. Tags and unknown inline fields are preserved byte-for-byte.

## CLI

Task Center registers verbs with Obsidian's native CLI. There is no separate wrapper script.

```bash
obsidian task-center:list scheduled=today
obsidian task-center:list scheduled=unscheduled tag='#work'
obsidian task-center:show ref=Tasks/Inbox.md:L42
obsidian task-center:add text="Review launch checklist" tag='#work' scheduled=2026-05-15
obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=2026-05-16
obsidian task-center:done ref=Tasks/Inbox.md:L42 at=2026-04-28
obsidian task-center:review days=7
obsidian task-center:review days=7 format=json
```

CLI output is greppable and agent-friendly: list rows start with stable ids, writes are idempotent, and mutations print `before` / `after` lines.

To install the companion AI skill:

```bash
npx skills add CorrectRoadH/obsidian-task-center
```

## Crabbox

This repository includes repo-local Crabbox onboarding for remote verification on Blacksmith Testboxes.

```bash
crabbox warmup
crabbox run -- pnpm run typecheck
crabbox run -- pnpm run test:unit
crabbox run -- pnpm run test:e2e
```

The default repo config lives in `.crabbox.yaml` and points at `.github/workflows/blacksmith-testbox.yml`. If your Blacksmith account needs an explicit org, export `CRABBOX_BLACKSMITH_ORG` before `crabbox warmup`.

## Settings

| Setting | Default | What it controls |
| --- | --- | --- |
| Default view | Week | Which tab opens first |
| Week starts on | Monday | Week and calendar boundaries |
| Open Task Center on startup | Off | Whether the board opens with the vault |
| Stamp created date | On | Whether new tasks get `➕ YYYY-MM-DD` |
| Force mobile layout | Off | Use the phone layout on wider screens |

## Development

```bash
pnpm install --frozen-lockfile  # install dependencies
pnpm run dev                     # watch & rebuild on change
pnpm run build                   # production build
pnpm run typecheck               # TypeScript type checking
pnpm run lint                    # ESLint (src only)
pnpm run test:unit               # 408 unit tests (parser, writer, CLI, cache, query, i18n, …)
pnpm run test:e2e                # WDIO/Obsidian e2e (requires Obsidian + WebDriverIO)
```

Preflight gate before every commit:

```bash
pnpm run typecheck && pnpm run lint && pnpm run test:unit && pnpm run build
```

## License

MIT.
