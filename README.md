# OpenCode Goal Mode

[![npm version](https://img.shields.io/npm/v/opencode-goal-mode?color=2da44e&label=npm)](https://www.npmjs.com/package/opencode-goal-mode)
[![npm downloads](https://img.shields.io/npm/dm/opencode-goal-mode?color=2da44e)](https://www.npmjs.com/package/opencode-goal-mode)
[![CI](https://github.com/devinoldenburg/opencode-goal-mode/actions/workflows/ci.yml/badge.svg)](https://github.com/devinoldenburg/opencode-goal-mode/actions/workflows/ci.yml)
[![Release](https://github.com/devinoldenburg/opencode-goal-mode/actions/workflows/publish.yml/badge.svg)](https://github.com/devinoldenburg/opencode-goal-mode/actions/workflows/publish.yml)
[![license](https://img.shields.io/npm/l/opencode-goal-mode?color=2da44e)](LICENSE)
[![node](https://img.shields.io/node/v/opencode-goal-mode?color=2da44e)](package.json)

Strict Goal Mode for OpenCode: a primary `goal` agent, a matrix of specialized
review subagents, slash commands, and a `goal-guard` plugin that enforces review
discipline, blocks destructive shell commands, and preserves goal state across
compaction **and** restarts.

```bash
npm install -g opencode-goal-mode && opencode-goal-mode-install --global
```

![OpenCode Goal Mode sidebar banner](docs/sidebar-demo.svg)

**[Quick start](#quick-start) · [Install](#install) · [Why it's different](#why-its-different) · [Benchmarks](#benchmarks-honest-edition) · [TUI integration](#tui-integration) · [Configuration](#configuration) · [Releasing](#releasing) · [Architecture](ARCHITECTURE.md)**

## Quick start

```bash
# 1. Install (needs Node 20.11+ and OpenCode)
npm install -g opencode-goal-mode
opencode-goal-mode-install --global

# 2. Restart OpenCode, then verify it loaded — you should see ONLY `goal (primary)`,
#    with every specialist as a (subagent):
opencode agent list | grep goal
```

3. In OpenCode, start a goal:

   ```
   /goal add rate limiting to the login endpoint and prove it works
   ```

   The `goal` agent writes a contract, delegates research/review to subagents, and
   **cannot** answer `Goal Completed` until every required review gate passes — the
   guard rewrites a premature claim to `Goal Not Completed`. Try a destructive
   command mid-session (e.g. `rm -rf build`) and watch it get blocked. The active
   goal shows in the sidebar in yellow.

That's it. Everything below is detail.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [research/](research/)
for the platform reference, comparison, and threat model.

## Why it's different

Most "goal mode" / agentic setups are **prompt-only**: the model is *asked* to
review its work and to keep going until done. Goal Mode adds a guard plugin that
makes that discipline **mechanical at the harness layer** — the model cannot
declare `Goal Completed` until the required reviews actually passed, and it
is blocked from the benchmarked destructive-command bypasses that a regex guard
would miss.

![Mechanically-enforced goal discipline vs. Claude Code and Codex](docs/benchmarks/capability-matrix.svg)

Compared to Claude Code and OpenAI Codex (full analysis, with citations and
honest caveats, in [research/goal-mode-comparison.md](research/goal-mode-comparison.md)):

- **It is the only one of the three that mechanically blocks a premature
  completion claim by default.** Goal Mode intercepts the finished message and
  rewrites `Goal Completed` → `Goal Not Completed` unless every required reviewer
  gate has a *fresh* PASS and the claimed `Review cycles: N` matches the recorded
  counter. Claude Code can do this only via a user-authored Stop hook; Codex's
  code review is advisory.
- **An edit automatically invalidates prior approvals.** A reviewer gate counts
  only when its PASS is newer (by a monotonic integer sequence) than the last
  edit — so any change forces the relevant reviews to re-run. The public Claude
  Code and Codex docs reviewed do not describe this stale-review invariant.
- **Required specialist reviews are auto-selected and enforced** (security, api,
  data, performance …) from the goal text, contract, and changed files — not left
  to the model's discretion.
- **Destructive commands are blocked by a real shell tokenizer**, not a regex.
  Claude Code's own docs call Bash argument-matching *"fragile"*.

### Benchmarks (honest edition)

The headline number is measured on commands **the analyzer was never fitted to**:
704 real example commands from [tldr-pages](https://github.com/tldr-pages/tldr)
(common/linux/osx), authored by hundreds of contributors who have never seen
this guard. Ground-truth labels come from a deliberately simple, analyzer-*independent*
rule (see [build-external-corpus.mjs](benchmarks/build-external-corpus.mjs)).
Reproduce with `npm run bench` or `node benchmarks/external.mjs`.

![Guard accuracy on real third-party commands](docs/benchmarks/external-scorecard.svg)

| On 704 real third-party commands | Legacy regex guard | Goal Mode analyzer |
| --- | --- | --- |
| Destructive-command detection | 53.8% | **93.3%** |
| False positives on safe commands | 0.2% | **0.2%** |

Honest caveats, because the point of this rewrite was to stop overclaiming:

- The ~7 remaining "misses" are almost all un-flagged single-target `rm <file>`,
  which the guard **intentionally permits** (plain `rm` is common and the guard
  blocks `rm -r`/`rm -f`, `$(rm …)`, `bash -c`, interpreters, etc.). Under a
  strict every-`rm`-is-destructive labeling those count against it.
- The single counted false positive (`git filter-repo …`) actually *is* a
  history-rewriting command, so the real-world false-positive rate is effectively
  zero. `node benchmarks/external.mjs --json` lists every miss and false positive
  so you can audit the disagreements yourself.

Two **curated fixture sets** also ship — and they are explicitly *fixtures*, not
an unbiased benchmark. They define the patterns the analyzer must catch and guard
against regressions, so they pass by construction; do not read the 100%/0% there
as measured accuracy:

- `benchmarks/corpus.mjs` — 71 destructive patterns (incl. `$(…)`, `bash -c`,
  `sudo -u`, `/bin/rm`, `git -C … reset --hard`, `curl | sh`, interpreter
  deletes) and their safe look-alikes (`git checkout -b`, `echo "rm -rf /"`).
- `benchmarks/completion-corpus.mjs` — 9 completion-claim policy cases (missing
  review-cycle line, stale review after edit, missing contextual gate, inactive
  session, custom marker). `npm run bench:truthfulness` prints them.

The analysis costs ~1µs per command (hundreds of thousands of classifications per
second) — negligible for a per-tool-call guard:

![Per-command analysis latency](docs/benchmarks/latency.svg)

## Requirements

- Node.js 20.11 or newer.
- OpenCode configured to load local agents, commands, and plugins.

## What it adds

- A primary `goal` agent that owns implementation but delegates research,
  discovery, verification planning, and reviews to subagents. **`goal` is the only
  user-selectable agent** — every specialist (security, diff, verifier, …) is a
  `mode: subagent` that the Goal agent invokes via the task tool; the user never
  picks one directly. They surface with friendly names (e.g. "Security Reviewer",
  "API Reviewer") rather than raw ids.
- Strict review gates for prompt compliance, diff review, verification, security,
  UX, operations, data, API, performance, tests, docs, quality, and final audit.
- Slash commands: `/goal`, `/goal-contract`, `/goal-review`,
  `/goal-evidence-map`, `/goal-status`, `/goal-repair`, `/goal-final`.
- The `goal-guard` plugin:
  - **Quote-aware shell analysis** that blocks destructive and remote-exec
    commands (including ones that evade naive regexes — `$(rm -rf …)`,
    `bash -c "…"`, `/bin/rm`, `git -C … reset --hard`, `curl | sh`) without
    false-positiving harmless commands like `git checkout -b`.
  - **Completion enforcement**: a premature `Goal Completed` is rewritten to
    `Goal Not Completed` with the exact missing review gates.
  - **Contextual gating**: the goal text and changed files determine which
    specialist reviewers are required.
  - **Reviewer Memory**: blocking reviewer findings are carried across cycles,
    surfaced in status/system context, and marked resolved by fresh PASS verdicts.
  - **Disk persistence**: review ledgers and Reviewer Memory survive OpenCode restarts.
  - **Custom tools**: `goal_contract`, `goal_evidence`, `goal_evidence_map`,
    `goal_reviewer_memory`, `goal_status`, `goal_reset`.
  - **Live state injection** into the system prompt so the model always knows
    what the guard requires.
  - **TUI toasts**: a toast on each review verdict (PASS/FAIL), with the
    reviewer's friendly name, and a single "completion unlocked" toast the moment
    the last required gate clears.
- An **experimental** companion TUI plugin (`plugins/goal-sidebar.js`) that shows
  the active goal as a shining-yellow banner in the sidebar with a compact gate
  status line. See [TUI integration](#tui-integration).
- A test suite validating the analyzer, plugin hooks, state store, install
  safety, and config compatibility.

## TUI integration

Goal Mode is a **plugin pair**: the server-side `goal-guard` plugin owns
enforcement and writes its state to disk, and an experimental TUI plugin
(`plugins/goal-sidebar.js`) reads that same state to render a live banner.

- **Sidebar goal banner (experimental).** The current goal renders in shining
  yellow in the sidebar (`sidebar_content` slot), with a `passing/total gates ·
  dirty/ready` status line, and updates as reviews land. When a task is running
  but **no goal is set**, it shows a clean grey `No goal` and nothing else. It
  requires a TUI-plugin-capable OpenCode (one exposing `api.slots.register`); on
  any older runtime it silently no-ops, so it can never break your TUI. Set
  `sidebarBanner: false` (or `GOAL_GUARD_SIDEBAR_BANNER=0`) to disable,
  `sidebarColor` to recolour the goal, or `sidebarMutedColor` for the "No goal"
  line. It is rendered-and-asserted headlessly by the
  [visual test](tools/visual-test/README.md) (`npm run test:visual`); still worth
  a glance in your own TUI.
- **Toasts.** Review verdicts and completion-unlock events surface as toasts
  (`toastOnReview`), and blocked destructive commands / premature completions
  toast as before (`toastOnBlock`).

## Install

### From npm (recommended)

```bash
npm install -g opencode-goal-mode
opencode-goal-mode-install --global    # installs into ~/.config/opencode
```

Then restart OpenCode (it loads agents, commands, and plugins at startup). In the
agent picker you will see **only the `goal` agent** — the specialist reviewers are
subagents the Goal agent drives for you; they are never selectable by the user.

Install into a single project instead of globally:

```bash
npm install -D opencode-goal-mode
npx opencode-goal-mode-install         # writes to ./.opencode
```

Upgrade later by re-running the same install command after `npm install -g
opencode-goal-mode@latest`; the installer replaces only the files it owns and
leaves your local edits alone (see [Installer options](#installer-options)).

### From source

```bash
git clone https://github.com/devinoldenburg/opencode-goal-mode
cd opencode-goal-mode
npm ci
npm run validate
npm run install:global                 # or: npm run install:local
```

## Installer options

```bash
node scripts/install.mjs --dry-run
node scripts/install.mjs --target /path/to/opencode-config
node scripts/install.mjs --global --force
node scripts/install.mjs --global --uninstall
```

The installer records a manifest of the files it writes. On upgrade it replaces
files it owns but refuses to clobber files you have locally modified unless
`--force` is passed. `--uninstall` removes only the files it installed and leaves
your local edits in place.

## Configuration

The guard works with zero configuration. To tune it, add options in
`opencode.json`:

```jsonc
{
  "plugin": [
    ["./plugins/goal-guard.js", { "blockDestructive": true, "contextualGates": true }]
  ]
}
```

Or via environment variables (`GOAL_GUARD_*`):

| Option / env | Default | Effect |
| --- | --- | --- |
| `blockDestructive` / `GOAL_GUARD_BLOCK_DESTRUCTIVE` | `true` | Block destructive bash before execution. |
| `blockNetworkExec` / `GOAL_GUARD_BLOCK_NETWORK_EXEC` | `true` | Block `curl \| sh`-style remote execution. |
| `enforceCompletion` / `GOAL_GUARD_ENFORCE_COMPLETION` | `true` | Rewrite premature `Goal Completed`. |
| `injectSystemState` / `GOAL_GUARD_INJECT_SYSTEM_STATE` | `true` | Inject live state into the prompt. |
| `persist` / `GOAL_GUARD_PERSIST` | `true` | Persist state under the XDG state dir. |
| `contextualGates` / `GOAL_GUARD_CONTEXTUAL_GATES` | `true` | Require specialist gates by goal keywords. |
| `maxSessions` / `GOAL_GUARD_MAX_SESSIONS` | `200` | Session cache size. |
| `sessionTtlMs` / `GOAL_GUARD_SESSION_TTL_MS` | `86400000` | Idle session TTL. |
| `toastOnBlock` / `GOAL_GUARD_TOAST_ON_BLOCK` | `true` | Toast when something is blocked. |
| `toastOnReview` / `GOAL_GUARD_TOAST_ON_REVIEW` | `true` | Toast on each review verdict and when completion unlocks. |
| `sidebarBanner` / `GOAL_GUARD_SIDEBAR_BANNER` | `true` | Show the experimental yellow goal banner in the TUI sidebar. |
| `sidebarColor` / `GOAL_GUARD_SIDEBAR_COLOR` | `#FFD700` | Foreground colour of the sidebar goal banner. |
| `sidebarMutedColor` / `GOAL_GUARD_SIDEBAR_MUTED_COLOR` | `#808080` | Colour of the muted "No goal" line when no goal is set. |

## Custom tools

The plugin registers six tools the model can call directly:

- `goal_contract` — record the Goal Contract (requirements, non-goals,
  acceptance criteria). Activates enforcement and fixes the required gates.
- `goal_evidence` — record a verification command and result.
- `goal_evidence_map` — return the acceptance-criteria evidence map with
  reviewer status, gaps, and next actions.
- `goal_reviewer_memory` — return unresolved and recently resolved reviewer findings.
- `goal_status` — return the authoritative gate/dirty/completion status.
- `goal_reset` — clear the session's goal state (requires `confirm: true`).

Use `/goal-evidence-map` when you need a read-only matrix of each acceptance
criterion against recorded evidence, reviewer status, gaps, and the next
required action. The command is backed by the `goal_evidence_map` tool, so it
uses persisted Goal Guard state rather than relying on transcript memory.

## Validation

```bash
npm test
npm run validate
npm run audit
npm run publish:check
```

`npm run validate` runs the test suite, the structural config validator, the
publish readiness check, and an `npm pack --dry-run`.

## Models

Agents do not pin a provider-specific model, so they inherit the model OpenCode
is configured to use. To give a particular agent a specific model, add a
`model:` (and optional `variant:`) line to that agent's frontmatter in your
installed copy.

## Safety

The installer copies only `agents/*.md`, `commands/*.md`, and the `plugins/`
tree — never auth files, session files, tokens, or personal provider config.

The guard blocks destructive shell commands, marks real file mutations dirty,
keeps read-only inspection from dirtying the session, preserves goal state during
compaction and across restarts, and blocks premature `Goal Completed` responses
when review gates are missing or stale.

## Releasing

Releases are fully automated and **version-synced**: one pushed tag publishes to
npm *and* creates the matching GitHub Release. The pipeline lives in
[`.github/workflows/publish.yml`](.github/workflows/publish.yml) (Node 24).

```bash
npm version patch        # bumps package.json + package-lock.json and creates the vX.Y.Z tag
git push --follow-tags   # pushes main + the tag → the Release workflow runs
```

On a `vX.Y.Z` tag push the workflow:

1. installs and runs the full CI gate (`npm run ci` — tests, audit, structural
   validation, `npm pack --dry-run`);
2. runs `npm run publish:check`, which **fails if the tag does not match
   `package.json`** or if that version already exists on npm;
3. publishes with `npm publish --access public` using the `NPM_TOKEN` repository
   secret;
4. creates the GitHub Release for the tag with auto-generated notes.

So the git tag, the `package.json` version, the npm version, and the GitHub
Release version are always identical. A manual `workflow_dispatch` is available
and defaults to a safe `npm publish --dry-run`.

**One-time setup:** add a publish-scoped npm token as the `NPM_TOKEN` repository
secret (`gh secret set NPM_TOKEN`). Treat that token as sensitive — never commit
it.

## Goal Completion Contract

`Goal Completed` is allowed only when:

- All acceptance criteria are mapped to evidence.
- Required verification passed or is credibly accounted for.
- No edit is newer than the latest required review cycle.
- Required reviewers return `Verdict: PASS`.
- The final answer includes an accurate `Review cycles: N`.
