# CI Test Matrix

Date: 2026-06-25

This document records the current test policy. As of 2026-06-25 the policy
changed: **the e2e gate runs the FULL spec suite, not a hand-picked whitelist.**
`pnpm run test:e2e:ci` is now `wdio run ./wdio.conf.mts` with no `--spec`
narrowing, so every `test/e2e/specs/**/*.e2e.ts` runs under
`OBSIDIAN_VERSIONS=latest/latest`. Flaky specs are **fixed, not quarantined**: a
`--spec` whitelist silently hides regressions in the excluded specs (the
original "tests too few" gap). `test/github-workflows.test.mjs` enforces that
the gate stays whitelist-free.

This is a deliberate trade: the full suite surfaces real cross-spec
contamination and environment fragility that the old 7-spec whitelist hid. The
backlog below tracks what must be driven to green; until it is, the gate can be
red for reasons unrelated to the change under test, so read the failure bucket
before assuming your diff broke something.

## Current Matrix

| Surface | Trigger | Checks | E2E coverage | Purpose |
| --- | --- | --- | --- | --- |
| Local quick check | Maintainer decides | Local e2e is blocked by `wdio-local-guard.mts`; run only explicit lightweight checks if requested | None | Protect the user's running Obsidian app. |
| `CI` | Pull request and `main` push | `pnpm install --frozen-lockfile`, typecheck, lint, unit, full e2e suite | The full `test/e2e/specs/**` suite with `OBSIDIAN_VERSIONS=latest/latest` | Merge confidence; same behavioral gate as release preflight. |
| `Release` | Strict semver tag, no `v` prefix | typecheck, lint, unit, full e2e suite, build, GitHub Release asset upload | The full `test/e2e/specs/**` suite with `OBSIDIAN_VERSIONS=latest/latest` | Hard release gate. A red e2e blocks publishing assets. |
| `CI Xvfb POC` | Manual dispatch or changes to `.github/workflows/ci-xvfb-poc.yml` only | install Xvfb/Electron deps, install deps, build | One non-timing-sensitive spec: `board-basics.e2e.ts` | Proves hosted Linux + Xvfb can boot and drive Obsidian without becoming a PR/release gate. |

## Full-suite stabilization backlog

First full-suite run (2026-06-25): 13/25 specs green. Failures bucket as:

1. **Cross-spec cache staleness (fixing).** `cli`, `drag`, `subtask`,
   `parent-child`, and the flavor `format-matrix` failed with
   `not_found: <path>:L1 is not a task line` or silent write timeouts. Root
   cause: their `writeAndWait` rewrote a shared path (`Tasks/Inbox.md`) without
   `plugin.cache.invalidateFile`, so `cache.resolveRef` returned a stale
   `path:Ln→hash`. Fix applied: every write helper now invalidates + flushes
   (the proven `dataview-format` / `_journeys` pattern). `render-children`
   already passed; left untouched.
2. **Concurrent feature WIP (not ours).** `area-filter` (`US-109d3` tag row
   cycles ignore→include→exclude) and `tag-match-mode` track the in-progress
   tag-exclude query feature (`src/query/`). These go green when that feature
   lands; do not "fix" them from the test side.
3. **Environment / mobile fragility (open).** `quickadd` screenshot wrote to a
   non-writable `/tmp` on the runner (EACCES) — fixed by skipping the dev-only
   artifact under `CI`. `mobile-coverage` / `mobile-entry` fail on mobile
   viewport emulation (`element click intercepted` by the status bar,
   `Browser.getWindowForTarget` unknown command, swipe gestures not firing) and
   `modal-title-layout` / `today-view` on render/timeout — these need
   per-spec investigation under the gate and are the remaining open work.

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
2. The gate already runs every spec (no whitelist). "Expansion" now means
   driving the stabilization backlog above to green — fix the flaky spec, never
   re-introduce a `--spec` subset to dodge it.
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
