# Changelog

## v0.4.1

### Restructured Goal sidebar todo section

- The sidebar Goal section is now a proper stacked, multi-colour layout instead of
  one run of text: a bold **`GOAL`** label on its own line (yellow while running,
  red when done), then the goal title, then a `passing/total gates · status` line —
  each line in its own highlight colour (GOAL yellow, title white, status cyan) so
  they never blend together. It opens with a first-display per-line rainbow, then
  settles.
- Removed the noisy `· changes pending` suffix from the status line; pending work
  now surfaces as a structured todo row instead.
- Better, more structured todos: one row per acceptance criterion (✓ when fresh
  evidence covers it), a re-verify row when the tree changed, and one row per
  still-missing review gate by friendly name (e.g. "Pass Security Reviewer").
- In a goal session the section takes over the sidebar `sidebar_content` slot;
  because OpenCode renders the native todo list as that slot's fallback, it
  replaces the native list on builds that use replace/single-winner slot mode and
  sits alongside it otherwise. Non-goal and no-goal sessions render nothing, so
  the native todo list stays in place.

### Build mode is never treated as a goal

- Hardened the guard so a Build/Plan/custom session never accumulates goal state.
  `tool.execute.after` bookkeeping (dirty flag, edits, verification, verdicts) now
  runs only for active Goal sessions (and goal-namespace subagent sessions for
  verdict capture). Destructive-command blocking still applies in every mode.

### Installer

- `--global` now resolves the home directory via `$HOME` and falls back to the OS
  home dir, so it works in shells/containers where `$HOME` is unset.
- Verified the full install → idempotent re-run → conflict-protection → uninstall
  lifecycle end-to-end on macOS (Node 24) and in clean Linux containers (Apple
  `container`, Node 20 and Node 24) using the real `npm install -g <tarball>` path.
- Moved **Install** to the top of the README and documented dry-run/uninstall.

## v0.4.0

### Goal-only subagents

- The `goal-*` specialist subagents are now mechanically locked to Goal Mode.
  OpenCode resolves subagents globally, so a Build, Plan, or custom agent could
  previously invoke a Goal reviewer directly. The guard now blocks any `task` call
  targeting a `goal-*` subagent unless it comes from an active Goal session, and a
  poach attempt never turns the calling session into a Goal. General-purpose
  subagents (`explore`/`general`/`scout`) are unaffected. New `restrictSubagents` /
  `GOAL_GUARD_RESTRICT_SUBAGENTS` option (default on) toggles it.

### Per-session sidebar isolation (not global)

- The TUI Goal todo section is now strictly per-session. Both the live component
  (`goal-sidebar.tsx`) and the Node-testable projection (`sidebar-data.js`) resolve
  state by the exact `props.session_id` and only when that session is an active Goal
  session — the "most-recently-touched active session" global fallback is gone in
  both. A Build (or any non-Goal) session in the same worktree can no longer inherit
  a sibling session's goal.
- The slot now always registers and decides per-session inside the render (matching
  the canonical OpenCode TUI-plugin pattern) instead of conditionally registering.
- Added node + headless-visual coverage proving two active goals in one worktree
  each render only their own goal.

### Goal-mode-only tools

- Every `goal_*` tool is Goal-mode-only: non-Goal/Build sessions get a clear refusal
  instead of any Goal status, evidence map, memory, contract, evidence, or reset.

### Documentation & visuals (accuracy pass)

- Corrected the sidebar wording from "replaces the native todo area" to "adds a
  Goal-owned todo section" (the slot contributes content; it does not replace native
  todos), and removed the stale "waits to register the slot" description.
- Regenerated the README hero image (`docs/sidebar-demo.svg`) to match what actually
  renders: a bold `Goal todos` label (no orb), the first-display per-line rainbow,
  the running/done colour states, and the native-todo-stays behavior. The old image
  showed a removed `◆ GOAL` orb and a removed grey "No goal" state.
- Made the benchmark "remaining misses" description accurate (all are plain `rm`
  without `-r`/`-f`, intentionally permitted) and documented Goal-only subagents and
  `restrictSubagents` in the README config table and ARCHITECTURE hook table.

## v0.3.11

- Fixed Goal sidebar/status isolation so an explicit Build or other non-Goal
  session never falls back to another active Goal session in the same worktree.
- Blocked mutating `goal_*` tools from activating Goal Guard state in non-Goal
  sessions; read-only tools remain strictly scoped to the current session.
- Added regression coverage for mixed Goal/Build persisted snapshots, session-scoped
  status/evidence/memory reads, and Build-mode tool calls.

## v0.3.10

- Clarified the recommended install command to use a persistent global npm install
  before running the installer, so OpenCode can resolve the TUI package on future
  starts. `npx` remains documented for temporary installs/server-side checks.
- Added the missing historical `v0.3.8` changelog section. `v0.3.8` reached npm,
  but its GitHub Release workflow failed while generating release notes, so it was
  superseded by `v0.3.9`.

## v0.3.9

- Installer docs and `--help` now put the one-command `npx opencode-goal-mode --global`
  flow first, clarify global vs project targets, and document the merge-safe
  `tui.json` registration/uninstall behavior.
- The TUI companion now renders a Goal-owned, structured todo section only for
  active Goal sessions, with a first-display rainbow effect before returning to
  normal lifecycle colours. Non-Goal modes render nothing from the Goal plugin so
  OpenCode's native todo section remains in place.
- Destructive-command blocking no longer activates Goal enforcement for Build or
  other non-Goal sessions, preventing non-Goal tasks from being classified as goals.

## v0.3.8

- Superseded release: npm publish succeeded, but the GitHub Release workflow failed
  because the changelog section was still named `Unreleased`. The same functional
  changes shipped correctly in `v0.3.9` with matching npm and GitHub releases.

## v0.3.7

- **FIX: the sidebar now actually loads.** OpenCode loads a TUI plugin via the
  package's `exports["./tui"]` subpath (verified against the OpenCode binary), and
  ours had no `exports`, so it silently never loaded. The package now maps
  `"./tui"` (and `main`) to `plugins/goal-sidebar.tsx`, and the entry is shipped as
  `.tsx` so OpenCode transpiles it. Confirmed working in a real OpenCode 1.17.6 TUI.
- **Sidebar layout, as requested:** three stacked lines — `GOAL  <title>`, then the
  gate count (`n/m gates`), then the status (`in progress` / `… · changes pending`
  / `completed · k review cycles`). The leading orb (◆) is removed.
- **AI-generated goal title:** `goal_contract` takes a short `title` the Goal agent
  writes (the objective, like a session title); the sidebar shows it, falling back
  to the raw goal text until titled.
- **One-command install:** `npx opencode-goal-mode --global` (new `opencode-goal-mode`
  bin alias). The installer registers the sidebar in `tui.json` (merge-safe) and
  `--uninstall` removes that entry too. Install instructions moved to the top of the
  README.
- Colours configurable: `sidebarColor` (running), `sidebarDoneColor` (done),
  `sidebarMutedColor` (no goal).

## v0.3.6

- **FIX: the sidebar never loaded.** TUI plugins are loaded from
  `~/.config/opencode/tui.json` — NOT the `plugins/` dir (that is server plugins
  only). The installer never created tui.json, so OpenCode never loaded the
  sidebar (it only showed the session title + context). The installer now
  registers the sidebar in `tui.json` (`plugin: ["opencode-goal-mode"]`,
  merge-safe), and the package `main` points at the TUI plugin so OpenCode loads
  it with its `@opentui/solid` runtime. Confirmed OpenCode reads tui.json.
- **Sidebar behaviour, as requested:** under the sidebar's content/"context"
  area it now shows the goal with generated status text, colour-coded by
  lifecycle: **yellow** while the goal is running, **red** when it is done (all
  required gates pass, tree clean), and **grey "No goal available"** when a task
  is running with no goal set. New `sidebarDoneColor` option
  (`GOAL_GUARD_SIDEBAR_DONE_COLOR`, default `#FF5555`).
- `summary.sidebarView` now returns `{ state: "none"|"running"|"done", goal,
  detail }`; the headless visual test renders and asserts all three states (text
  + exact colours), 18/18.

## v0.3.5

- Verified the package against the **current** OpenCode plugin API
  (`@opencode-ai/plugin@1.17.6`, matching OpenCode 1.17.6, now the dev pin): all
  guard hooks (`chat.message`/`params`, `tool.execute.before`/`after`,
  `experimental.chat.system.transform`/`text.complete`/`session.compacting`)
  exist; the guard plugin loads with zero errors; and in a real OpenCode the
  agent list shows `goal` as the only user-selectable agent with 26 subagents and
  reviewer `edit`/`task: deny` applied. The enforcement core is unchanged and
  fully intact.
- Declared `@opentui/solid`, `solid-js`, `@opencode-ai/plugin` as **optional**
  peer dependencies (the TUI runtime the sidebar uses).
- Docs: stated the sidebar's verification status honestly — the experimental TUI
  banner is verified to load and to render in a real headless OpenTUI test, but
  its live in-session render depends on your OpenCode build's file-based
  TUI-plugin support; it never errors and never affects the enforcement core.

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
