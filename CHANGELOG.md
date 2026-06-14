# Changelog

## v0.3.4

Critical fixes found by testing against a real OpenCode (1.17.6) install — the
prior releases did not actually work end-to-end.

- **FIX: the guard plugin did not load.** OpenCode loads *every* export of a
  plugin file as a plugin factory, so `goal-guard.js` exporting a test helper and
  extra factories made OpenCode fail with `Plugin export is not a function` — the
  entire enforcement layer was silently dead. The entry now exports **only** the
  default plugin; the factory and test surface moved to
  `plugins/goal-guard/guard.js` (nested, so OpenCode does not load it directly).
- **FIX: 14 of 27 agents had invalid YAML frontmatter** (an invalid `\.` escape in
  `external_directory` globs, and an unquoted `: ` in one description). OpenCode
  silently dropped those agents to `mode: all` with **no permissions applied** —
  they became user-selectable and the review gates' `edit: deny` / `task: deny`
  were ignored. Fixed; verified in OpenCode that `goal` is the only `primary`
  agent and all 26 specialists are `subagent` with their deny-permissions applied.
- **Hardened the validator** so this can't regress: it now parses each agent's
  frontmatter as real YAML (not regex), enforces reviewer `edit`/`task: deny` from
  parsed values, and asserts the plugin entry exports only a default function.
- `goal-sidebar.js` now `export default { id, tui }` only (the supported TUI
  plugin shape), matching working OpenCode TUI plugins.
- README: a "Quick start" (install → verify → use) at the top.

## v0.3.3

- Release notes: the GitHub Release body is now generated from the matching
  `CHANGELOG.md` section (`scripts/release-notes.mjs`), so releases always ship
  real notes instead of an empty auto-summary.
- Richer repository: README badges (npm version/downloads, CI, release, license,
  node), a quick-links bar, and a terminal-style sidebar demo
  (`docs/sidebar-demo.svg`); a descriptive repo summary and topics; and
  community health files (CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, issue and PR
  templates).
- Stronger npm discoverability: expanded `keywords` (opencode-plugin,
  opencode-tui-plugin, guardrails, review-gates, completion-enforcement, …).

## v0.3.2

- Only the `goal` agent is user-selectable. The structural validator now requires
  every other agent to be `mode: subagent` (no `all`/extra `primary`), so the
  specialist reviewers can only be invoked by the Goal agent via the task tool,
  never picked by the user.
- Friendlier subagent names in the TUI: review-verdict toasts now read
  "Security Reviewer → PASS" / "API Reviewer → PASS" instead of raw hyphenated ids
  (`prettyAgentName` drops the `goal-` prefix, de-hyphenates, keeps acronyms).
- Release pipeline: a single `vX.Y.Z` tag push now publishes to npm AND creates
  the matching GitHub Release (versions stay in sync). `publish:check` fails the
  release if the tag does not match `package.json` or the version already exists.
- README: npm-first install instructions and a documented release flow.

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
