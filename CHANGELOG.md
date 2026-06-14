# Changelog

## v0.3.1

- Sidebar: when a task is running but no goal is set, show a clean grey `No goal`
  (nothing else) instead of a blank/absent banner. New `sidebarMutedColor` option
  (`GOAL_GUARD_SIDEBAR_MUTED_COLOR`, default `#808080`).
- `summary.sidebarView` now always returns a model (`{ hasGoal: false }` vs
  `{ hasGoal: true, … }`) so the sidebar renders unconditionally.
- Add a headless visual test (`npm run test:visual`, `tools/visual-test/`) that
  renders the real component with @opentui/solid and asserts text + exact colours
  + bold attributes across goal / no-goal / ready / custom-colour / truncation /
  disabled / no-API / resize scenarios. Excluded from the npm package and CI.
- Hardened the sidebar projection against malformed/partial persisted state.

## v0.3.0

- Honest benchmarks: add an EXTERNAL corpus of 704 real third-party commands from
  tldr-pages (`benchmarks/external.mjs`, `npm run bench:external`) as the headline
  detection/false-positive measure (93.3% vs 53.8% legacy; ~0% real false
  positives). Reframe the curated 71-command set and 9 completion cases as
  regression *fixtures*, not measured accuracy, and reword the README/charts to
  stop overclaiming.
- Stronger guard: block `mkfs.<fstype>` variants, `srm`, and `mkswap`
  (genuine destructive commands the external corpus exposed as misses).
- Deeper TUI embedding: toast on each review verdict (PASS/FAIL) and once when the
  last required gate clears (`toastOnReview`); `goal_status` now surfaces the goal.
- Experimental TUI sidebar banner (`plugins/goal-sidebar.js`): the active goal in
  shining yellow with a live gate-status line, paired with the guard via persisted
  state. No-ops on any runtime without the TUI slot API. New options
  `sidebarBanner` / `sidebarColor` (`GOAL_GUARD_SIDEBAR_*`).
- Tighter `/goal` flow that seeds the Goal Contract via the `goal_contract` tool.

## v0.2.4

- Add Reviewer Memory for unresolved/resolved reviewer findings across cycles.
- Add a False Completion Dataset and Benchmark Truthfulness Score for completion-claim enforcement.

## v0.2.3

- Add `/goal-evidence-map` to map acceptance criteria to recorded verification evidence, gaps, and next actions.

## v0.2.2

- Refresh source-backed research notes for OpenCode plugin/runtime facts and the Claude Code/Codex comparison.
- Regenerate benchmark results and charts from the current shell-guard corpus.
- Scope benchmark and safety claims to avoid overclaiming beyond the tested bypass corpus.
- Align release documentation with the `NPM_TOKEN`-based publish workflow.
