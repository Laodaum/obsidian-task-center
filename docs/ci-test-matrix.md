# CI Test Matrix

Date: 2026-06-25

This document records the current test split. As of 2026-06-25, PR/main CI and
the release pre-flight gate both run the full unit suite plus the stable
WebDriverIO specs that protect the board entry path, the source Markdown editor
path, the drag write-path, and the task-format flavor contract (both the
Dataview diagonal and the full write×content matrix). The wider historical e2e
suite remains available for investigation, but is not yet stable enough to be a
release gate.

## Current Matrix

The stable e2e gate (run by `pnpm run test:e2e:ci`, identical for PR/main and
release preflight) currently covers these specs with `OBSIDIAN_VERSIONS=latest/latest`:

- `board-basics.e2e.ts` — board entry, blank-title filter, overdue/near markers, status bar
- `source-edit-dialog.e2e.ts` — US-168 source Markdown edit shell
- `dataview-format.e2e.ts` — US-111 Dataview journeys (diagonal: setting=dataview, content=dataview)
- `format-matrix.e2e.ts` — US-111 full flavor matrix (write setting × on-disk content, incl. off-diagonal read parity and cross-format mutation)
- `drag.e2e.ts` — US-121/122a/123 drag reschedule / unschedule / abandon, plus nest edges
- `saved-views.e2e.ts`, `mobile-filter-ui.e2e.ts`, `modal-centered.e2e.ts`, `tag-match-mode.e2e.ts`

| Surface | Trigger | Checks | E2E coverage | Purpose |
| --- | --- | --- | --- | --- |
| Local quick check | Maintainer decides | Local e2e is blocked by `wdio-local-guard.mts`; run only explicit lightweight checks if requested | None | Protect the user's running Obsidian app. |
| `CI` | Pull request and `main` push | `pnpm install --frozen-lockfile`, typecheck, lint, unit, stable e2e gate | The stable gate spec list above with `OBSIDIAN_VERSIONS=latest/latest` | Merge confidence for normal code changes; same behavioral gate as release preflight. |
| `Release` | Strict semver tag, no `v` prefix | typecheck, lint, unit, stable e2e gate, build, GitHub Release asset upload | The stable gate spec list above with `OBSIDIAN_VERSIONS=latest/latest` | Hard release gate. A red e2e blocks publishing assets. |
| `CI Xvfb POC` | Manual dispatch or changes to `.github/workflows/ci-xvfb-poc.yml` only | install Xvfb/Electron deps, install deps, build | One non-timing-sensitive spec: `board-basics.e2e.ts` | Proves hosted Linux + Xvfb can boot and drive Obsidian without becoming a PR/release gate. |

## Existing Decisions

- Task #48 changed the WDIO default to `WDIO_MAX_INSTANCES=1`. This is the
  baseline for avoiding shared-vault interference in e2e.
- Task #52 proved `ubuntu-latest` + Xvfb can boot Obsidian and drive a minimal
  WDIO spec. That POC remains intentionally narrow.
- Local WDIO is forbidden: `wdio.conf.mts` throws unless `GITHUB_ACTIONS=true`.
  Use GitHub Actions for e2e evidence.
- PR/main CI and Release preflight intentionally run the same behavioral gate:
  typecheck, lint, unit, then stable e2e coverage for board basics and source
  editing. The source-edit spec is included because US-168h regressions can pass
  unit tests while failing in Obsidian's real Markdown leaf state handoff.
- Release tags are strict semver without a `v` prefix. Tag pushes repeat the
  full pre-flight gate before publishing assets.
- The task-format flavor is a 2D contract, not a diagonal. `taskFormatFlavor`
  is a WRITE-only setting (`src/writer.ts` branches on it); READING is
  flavor-agnostic (`src/parser.ts` reads `⏳` then falls back to `[scheduled::]`).
  `format-matrix.e2e.ts` therefore drives `(write setting) × (on-disk content)`:
  off-diagonal read parity (a user's pre-existing emoji content must render
  under a dataview setting and vice versa) and cross-format mutation (touching a
  foreign-format field rewrites it in the setting's flavor while untouched tags
  survive, per US-147). `dataview-format.e2e.ts` only covered the dataview
  diagonal; the matrix spec generalizes it without removing it.

## Test isolation & parallelism (Task #48 follow-up)

`obsidianPage.resetVault` only rewrites regular vault files — it does NOT reset
`.obsidian` config or plugin settings (per wdio-obsidian-service docs). So a spec
that flips `taskFormatFlavor` via `saveSettings()` leaks that setting into later
specs in the same worker. `format-matrix.e2e.ts` is self-isolating:
`_journeys.resetForWriteFlavor()` pairs the vault reset with an explicit setting
write in every `beforeEach`, and an `after` hook restores the `tasks` default so
sibling specs see a clean baseline. New flavor-sensitive specs MUST follow this
pattern rather than relying on `resetVault` alone.

This settings-leak fix is the missing half of safe parallelism. The service
already copies the vault per worker (`reloadObsidian` default `copy: true`), so
vault FILES are isolated across workers; the remaining shared state was plugin
settings inside `.obsidian`. With per-spec setting resets in place, raising
`WDIO_MAX_INSTANCES` above 1 is safe for the flavor specs. The gate still pins
`WDIO_MAX_INSTANCES=1` until a maintainer collects multi-run flake evidence on a
parallel gate run; only then should the default be bumped.

## Date-fixture audit (week-boundary determinism)

Specs that derive fixtures from the real clock can flake when a tag is cut on a
week boundary. Shared helpers in `test/e2e/specs/_journeys.ts` centralize the
safe forms:

- `todayISO()` / `offsetISO(n)` — raw clock; `offsetISO` may cross week/month.
- `inWeekNeighbor()` — guaranteed same visible week as today (steps back on
  Sunday, forward otherwise). Drag/reschedule journeys MUST use this for their
  day-column target instead of `offsetISO(1)`.

Current raw-clock usage to migrate as specs are touched (not a blocking gate):

- `today-view.e2e.ts` — `tomorrowISO()` = raw `+1` day; crosses the week on
  Saturday/Sunday. Candidate for `inWeekNeighbor()` before gate promotion.
- `parent-child.e2e.ts`, `render-children.e2e.ts` — local `inWeekNeighbor`
  copies; fold into the shared helper when next edited.

A fully deterministic clock would require an injectable `now` in `src/dates.ts`
(and the scattered `new Date()` call sites in writer/api/quickadd). That is a
larger architectural change tracked separately; the helper audit above is the
cheap mitigation that removes the common week-boundary flake.

## Recommended Expansion Plan

1. Keep `CI` and `Release` preflight aligned; if one gate adds or removes a
   required check, mirror it in the other workflow in the same PR.
2. Promote additional e2e specs one at a time after they are made deterministic
   under `OBSIDIAN_VERSIONS=latest/latest`.
3. Keep `CI Xvfb POC` narrow unless a follow-up task explicitly promotes it to
   a required signal.
4. Add an Actions summary artifact for e2e failures: failed spec name,
   screenshot path, Obsidian version, and retry instructions.
5. Add a date-fixture helper audit for specs that depend on "today" or week
   navigation, so tag releases do not fail because stale dates crossed a week.

## Follow-Up Task Splits

- Add an Actions summary artifact for e2e failures: failed spec name,
  screenshot path, Obsidian version, and retry instructions.
- Add a date-fixture helper audit for specs that depend on "today" or week
  navigation, so tag releases do not fail because stale dates crossed a week.
