# OpenCode Goal Mode

**Your OpenCode agent can't claim it's done until the reviews actually pass — and it can't run a destructive shell command by accident.**

Goal Mode is a strict primary `goal` agent plus a `goal-guard` plugin that enforces
delivery discipline at the **harness layer**, not with prompt wishes. The model is
mechanically blocked from answering `Goal Completed` until every required review gate
has a *fresh* PASS, and irreversible shell commands (`rm -rf`, `git reset --hard`,
`curl | sh`, …) are blocked before they execute.

[![npm version](https://img.shields.io/npm/v/opencode-goal-mode?color=2da44e&label=npm)](https://www.npmjs.com/package/opencode-goal-mode)
[![npm downloads](https://img.shields.io/npm/dm/opencode-goal-mode?color=2da44e)](https://www.npmjs.com/package/opencode-goal-mode)
[![CI](https://github.com/devinoldenburg/opencode-goal-mode/actions/workflows/ci.yml/badge.svg)](https://github.com/devinoldenburg/opencode-goal-mode/actions/workflows/ci.yml)
[![Release](https://github.com/devinoldenburg/opencode-goal-mode/actions/workflows/publish.yml/badge.svg)](https://github.com/devinoldenburg/opencode-goal-mode/actions/workflows/publish.yml)
[![license](https://img.shields.io/npm/l/opencode-goal-mode?color=2da44e)](LICENSE)
[![node](https://img.shields.io/node/v/opencode-goal-mode?color=2da44e)](package.json)

**The problem.** Coding agents declare success prematurely — and occasionally run a
command that eats your work. "Please review yourself and don't stop until it's done" is
just a prompt; a confident-enough model talks right past it. Goal Mode makes both
guarantees *mechanical* instead of hoping the model complies.

**[See it in action](#see-it-in-action) · [What you get](#what-you-get) · [Install](#install) · [Quick start](#quick-start) · [Why it's different](#why-its-different) · [Benchmarks](#benchmarks-honest-edition) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Architecture](ARCHITECTURE.md)**

## See it in action

When the agent claims completion before the gates pass, the guard intercepts the
finished message and rewrites it:

```diff
- Goal Completed
+ Goal Not Completed
+
+ Goal Guard blocked completion: required review gates are missing or stale
+ (goal-security-reviewer, goal-final-auditor). State: active=true; dirty=true;
+ reviewCycles=1; missingGates=goal-security-reviewer goal-final-auditor
```

When the agent reaches for an irreversible command, the guard throws *before* it runs:

```text
$ rm -rf build
✕ Goal Guard blocked a destructive or high-risk bash command
  (rm with recursive force deletion). Use a safer, reversible command
  or ask the user to confirm.
```

![OpenCode Goal Mode sidebar preview](docs/sidebar-preview.png)

<sub>↑ In a goal session, the Goal plugin takes over the sidebar todo section with a
structured, evidence-aware Goal todo list — a bold `GOAL` label, then the goal title,
gate progress, and per-acceptance/gate todo rows, each on its own line in its own
colour. Build and every other mode keep OpenCode's native todo section — see
[TUI integration](#tui-integration).</sub>

## What you get

- **Completion you can trust.** The model cannot answer `Goal Completed` until every
  required reviewer has a fresh `Verdict: PASS` and the claimed `Review cycles: N`
  matches the recorded counter. A premature claim is rewritten to `Goal Not Completed`
  with the exact missing gates.
- **Reviews that always run.** When a goal goes idle with work done and gates
  outstanding, the guard *itself* launches the required reviewer subagents, records each
  verdict, and loops *fix → review* until they pass — it never depends on the model
  remembering to review (toggle: `programmaticReview`).
- **Edits invalidate stale approvals.** A gate counts only when its PASS is newer (by a
  monotonic integer sequence) than the last edit, so any change forces the relevant
  reviews to re-run before completion can reopen.
- **Destructive commands blocked by a real shell tokenizer**, not a regex — it catches
  `$(rm …)`, `bash -c "…"`, `/bin/rm`, `busybox rm -rf`, `git -C … reset --hard`, and
  `curl | sh` without false-positiving `git checkout -b`.
- **Specialist reviews auto-selected.** Security, API, data, performance, tests, UX,
  ops, docs, and quality gates become required automatically from the goal text,
  contract, and changed files — not left to the model's discretion.
- **Never stops early.** An idle-but-incomplete goal is automatically continued (told
  exactly what's left), with a hard cap and a no-progress circuit-breaker as backstops.
- **A live Goal todo in the TUI sidebar** (experimental) — gate progress and
  per-criterion todos, derived from real guard state.

## Install

**One command.** Needs [Node](https://nodejs.org) 20.11+ and a working
[OpenCode](https://opencode.ai). Works on macOS and Linux:

```bash
npm install -g opencode-goal-mode && opencode-goal-mode --global
```

Then **restart OpenCode**. That's the whole install — it copies the Goal agent, review
subagents, slash commands, and guard plugin into `~/.config/opencode`, and merge-safely
registers the Goal todo sidebar in `~/.config/opencode/tui.json`. In the agent picker
you'll see only the **`goal`** agent; reviewers are subagents it drives automatically.
The install is **idempotent** (re-run it to upgrade in place), never touches files
you've edited, and `--uninstall` removes exactly what it added. Goal Mode inherits your
existing OpenCode model/provider.

<details>
<summary>Other ways to install</summary>

```bash
# Preview first, then install (no writes on --dry-run)
opencode-goal-mode --global --dry-run

# One-off with npx (no global package needed; OpenCode still loads the TUI sidebar —
# it resolves that from its own plugin cache, not the global install)
npx opencode-goal-mode --global

# Into a single project (writes ./.opencode, including ./.opencode/tui.json)
npx opencode-goal-mode

# Clean removal of everything it installed (incl. its tui.json entry)
opencode-goal-mode --global --uninstall

# From source
git clone https://github.com/devinoldenburg/opencode-goal-mode
cd opencode-goal-mode && npm ci && npm run install:global
```

`--global` writes to `~/.config/opencode`; no flag writes to `./.opencode`; `--target`
writes to exactly the directory you pass. Use a project install only when you want Goal
Mode scoped to one repo and your OpenCode build reads project `.opencode` config
(including `.opencode/tui.json`). See [Installer options](#installer-options).
</details>

## Quick start

```bash
# 1. Install (see above), then restart OpenCode and verify it loaded — you should see
#    ONLY `goal (primary)`, with every specialist as a (subagent):
opencode agent list | grep goal
```

2. In OpenCode, start a goal:

   ```
   /goal add rate limiting to the login endpoint and prove it works
   ```

   The `goal` agent writes a contract, delegates research to subagents, implements,
   and verifies — then stops. The guard runs the required reviews itself and **cannot**
   let it answer `Goal Completed` until they pass. Try a destructive command mid-session
   (e.g. `rm -rf build`) and watch it get blocked.

That's it. Everything below is detail. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
design and [research/](research/) for the platform reference, comparison, and threat
model.

## Why it's different

Most "goal mode" / agentic setups are **prompt-only**: the model is *asked* to review
its work and to keep going until done. Goal Mode adds a guard plugin that makes that
discipline **mechanical at the harness layer** — the model cannot declare
`Goal Completed` until the required reviews actually passed, and it is blocked from the
benchmarked destructive-command bypasses a regex guard would miss.

![Mechanically-enforced goal discipline vs. Claude Code and Codex](docs/benchmarks/capability-matrix.svg)

Compared to Claude Code and OpenAI Codex (full analysis, with citations and honest
caveats, in [research/goal-mode-comparison.md](research/goal-mode-comparison.md)) —
claims below are scoped to the public docs reviewed there:

- **It mechanically blocks a premature completion claim by default.** Goal Mode
  intercepts the finished message and rewrites `Goal Completed` → `Goal Not Completed`
  unless every required reviewer gate has a *fresh* PASS and the claimed
  `Review cycles: N` matches the recorded counter. Of the three, it is the only one that
  does this out of the box — Claude Code can do it only via a user-authored Stop hook;
  Codex's code review is advisory.
- **An edit automatically invalidates prior approvals.** A reviewer gate counts only
  when its PASS is newer (by a monotonic integer sequence) than the last edit. The
  public Claude Code and Codex docs reviewed do not describe this stale-review invariant.
- **Required specialist reviews are auto-selected and enforced** (security, api, data,
  performance …) from the goal text, contract, and changed files — not left to the
  model's discretion.
- **Destructive commands are blocked by a real shell tokenizer**, not a regex. Claude
  Code's own docs call Bash argument-matching *"fragile"*.

### Benchmarks (honest edition)

The headline number is measured on commands **the analyzer was never fitted to**: 704
real example commands from [tldr-pages](https://github.com/tldr-pages/tldr)
(common/linux/osx), authored by hundreds of contributors who have never seen this guard.
Ground-truth labels come from a deliberately simple, analyzer-*independent* rule (see
[build-external-corpus.mjs](benchmarks/build-external-corpus.mjs)). Reproduce with
`npm run bench` or `node benchmarks/external.mjs`.

![Guard accuracy on real third-party commands](docs/benchmarks/external-scorecard.svg)

| On 704 real third-party commands | Legacy regex guard | Goal Mode analyzer |
| --- | --- | --- |
| Destructive-command detection | 53.8% | **93.3%** |
| False positives on safe commands | 0.2% | **0.2%** |

Honest caveats, because the point of this rewrite was to stop overclaiming:

- The 7 remaining "misses" are all plain `rm` invocations without `-r`/`-f` (single- or
  multi-target, a few with `-i`/`-v`/`-d`), which the guard **intentionally permits**:
  bare `rm` is extremely common, so the guard marks it dirty but lets the host's own
  `rm *` permission decide, while still blocking the irreversible forms (`rm -r`/`rm -f`,
  wildcard/root, `$(rm …)`, `bash -c`, `/bin/rm`, interpreters, etc.). Under a strict
  every-`rm`-is-destructive labeling those count against it.
- The single counted false positive (`git filter-repo …`) actually *is* a
  history-rewriting command, so the real-world false-positive rate is effectively zero.
  `node benchmarks/external.mjs --json` lists every miss and false positive so you can
  audit the disagreements yourself.

Two **curated fixture sets** also ship — and they are explicitly *fixtures*, not an
unbiased benchmark. They define the patterns the analyzer must catch and guard against
regressions, so they pass by construction; do not read the 100%/0% there as measured
accuracy:

- `benchmarks/corpus.mjs` — 71 destructive patterns (incl. `$(…)`, `bash -c`, `sudo -u`,
  `/bin/rm`, `git -C … reset --hard`, `curl | sh`, interpreter deletes) and their safe
  look-alikes (`git checkout -b`, `echo "rm -rf /"`).
- `benchmarks/completion-corpus.mjs` — 9 completion-claim policy cases (missing
  review-cycle line, stale review after edit, missing contextual gate, inactive session,
  custom marker). `npm run bench:truthfulness` prints them.

The analysis costs ~1µs per command (hundreds of thousands of classifications per
second) — negligible for a per-tool-call guard:

![Per-command analysis latency](docs/benchmarks/latency.svg)

## How it works

Goal Mode is a **plugin pair**:

- **`goal-guard`** (server-side) owns all enforcement — shell analysis, completion
  rewriting, contextual gating, the code-driven review loop, reviewer memory, and
  persistence — and writes its state to disk.
- **`goal-sidebar.tsx`** (experimental TUI plugin) reads that same state to render the
  live Goal todo section.

The guard hooks the OpenCode plugin surface: it inspects each bash command before
execution (`tool.execute.before`), tracks real file mutations, rewrites a premature
completion claim (`experimental.text.complete`), injects live guard state into the
system prompt, and — on `session.idle` — runs the required reviews and continues an
incomplete goal. See [ARCHITECTURE.md](ARCHITECTURE.md) for the module-by-module design.

> **Honest caveat (matching the benchmarks).** The auto-review and never-stop-early
> behaviors trigger on `session.idle`. A model that stalls mid-turn without emitting an
> idle event (some free models do) may not auto-review *live*; the unconditional
> guarantees — completion rewriting and destructive-command blocking — do not depend on
> idle and always apply.

### What it adds

- A primary `goal` agent that owns implementation but delegates research, discovery, and
  verification planning to subagents. **`goal` is the only user-selectable agent** —
  every specialist is a `mode: subagent` the user never picks directly, and the guard
  blocks any other agent from invoking them. Required reviewers are launched by the
  guard itself, and surface with friendly names (e.g. "Security Reviewer").
- Strict review gates for prompt compliance, diff review, verification, security, UX,
  operations, data, API, performance, tests, docs, quality, and a final audit.
- Slash commands: `/goal`, `/goal-contract`, `/goal-review`, `/goal-evidence-map`,
  `/goal-status`, `/goal-repair`, `/goal-final`.
- Reviewer Memory (blocking findings carried across cycles), disk persistence, live
  state injection, TUI toasts on each verdict, and six custom tools (see below).
- A test suite validating the analyzer, plugin hooks, state store, install safety, and
  config compatibility.

## TUI integration

In a `goal` session with a goal set, the Goal plugin renders its own structured todo
section into the sidebar's `sidebar_content` slot — each line in its own colour so it
never reads as one run of text:

- a bold **`GOAL`** label (yellow while running, red when done);
- the short goal title;
- the gate count `passing/total gates`;
- the lifecycle status — `in progress`, or `completed · N review cycles`;
- structured todo rows from real guard state: one per acceptance criterion (✓ when fresh
  evidence covers it), a re-verify row when the tree changed, and one row per
  still-missing review gate by friendly name (e.g. "Pass Security Reviewer").

Build and every non-Goal mode (and a Goal session before a goal is set) render nothing
here, so OpenCode's native todo section stays put. The section is scoped to the session
that owns the goal. Toggle/recolour with `sidebarBanner`, `sidebarColor`,
`sidebarDoneColor`, `sidebarMutedColor`, or the `GOAL_GUARD_SIDEBAR_*` env vars.

<details>
<summary>How the sidebar loads (and why an upgrade just needs a restart)</summary>

TUI plugins are **not** loaded from the `plugins/` dir; OpenCode loads them from
`tui.json`. With `--global`, the installer writes `~/.config/opencode/tui.json` for you
(merge-safe):

```json
{ "$schema": "https://opencode.ai/tui.json", "plugin": ["opencode-goal-mode"] }
```

OpenCode installs the referenced package into its own plugin cache
(`~/.cache/opencode/packages/`) and provides the `@opentui/solid` + `solid-js` runtime
to it. It does **not** re-check that cache for newer versions, so the installer clears
the cached copy on install/uninstall — that's why an upgrade needs only a restart to
load the new sidebar. Because the Goal agent does its own todo tracking (native
`todowrite` is disabled in Goal Mode), the Goal section replaces — rather than sits
beside — the native todo list while a goal is active, on builds that render
`sidebar_content` in single-winner mode. The visual harness renders the component
headlessly in [the visual test](https://github.com/devinoldenburg/opencode-goal-mode/blob/main/tools/visual-test/README.md)
(`npm run test:visual`); the enforcement core is a separate server plugin and works
regardless of the sidebar.
</details>

## Configuration

The guard works with **zero configuration**. To tune it, add options in `opencode.json`:

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
| `autoContinue` / `GOAL_GUARD_AUTO_CONTINUE` | `true` | Auto-continue an idle goal that isn't complete yet, so it never stops early. |
| `maxAutoContinue` / `GOAL_GUARD_MAX_AUTO_CONTINUE` | `50` | Hard cap on automatic continuations per goal session. |
| `programmaticReview` / `GOAL_GUARD_PROGRAMMATIC_REVIEW` | `true` | Have the guard launch the required reviewer subagents itself on idle, instead of relying on the model to call the task tool. |
| `reviewTimeoutMs` / `GOAL_GUARD_REVIEW_TIMEOUT_MS` | `360000` | Per-reviewer wall-clock cap (ms) for a programmatic review run. |
| `reviewPollMs` / `GOAL_GUARD_REVIEW_POLL_MS` | `2500` | Poll cadence (ms) while waiting for a launched reviewer to render its verdict. |
| `maxReviewCycles` / `GOAL_GUARD_MAX_REVIEW_CYCLES` | `12` | Hard cap on programmatic review cycles per goal; on reaching it, the guard pauses for you. |
| `abortGraceMs` / `GOAL_GUARD_ABORT_GRACE_MS` | `1200` | Grace (ms) before an idle goal auto-continues, so a user cancel is honored regardless of event order. Lowering it only cuts latency; `0` removes the grace and weakens cancel detection. |
| `injectSystemState` / `GOAL_GUARD_INJECT_SYSTEM_STATE` | `true` | Inject live state into the prompt. |
| `persist` / `GOAL_GUARD_PERSIST` | `true` | Persist state under the XDG state dir. |
| `contextualGates` / `GOAL_GUARD_CONTEXTUAL_GATES` | `true` | Require specialist gates by goal keywords. |
| `restrictSubagents` / `GOAL_GUARD_RESTRICT_SUBAGENTS` | `true` | Block non-Goal agents from invoking the `goal-*` subagents via the task tool. |
| `maxSessions` / `GOAL_GUARD_MAX_SESSIONS` | `200` | Session cache size. |
| `sessionTtlMs` / `GOAL_GUARD_SESSION_TTL_MS` | `86400000` | Idle session TTL. |
| `toastOnBlock` / `GOAL_GUARD_TOAST_ON_BLOCK` | `true` | Toast when something is blocked. |
| `toastOnReview` / `GOAL_GUARD_TOAST_ON_REVIEW` | `true` | Toast on each review verdict and when completion unlocks. |
| `sidebarBanner` / `GOAL_GUARD_SIDEBAR_BANNER` | `true` | Show the experimental Goal todo section in the TUI sidebar. |
| `sidebarColor` / `GOAL_GUARD_SIDEBAR_COLOR` | `#FFD700` | Colour of the GOAL label for a **running** goal. |
| `sidebarDoneColor` / `GOAL_GUARD_SIDEBAR_DONE_COLOR` | `#FF5555` | Colour of a **done** goal in the sidebar (red). |
| `sidebarMutedColor` / `GOAL_GUARD_SIDEBAR_MUTED_COLOR` | `#808080` | Reserved muted colour for no-goal projections. |
| `completionMarker` / `GOAL_GUARD_COMPLETION_MARKER` | `Goal Completed` | Phrase that, at the start of an assistant message, claims completion. |
| `blockedMarker` / `GOAL_GUARD_BLOCKED_MARKER` | `Goal Not Completed` | Replacement marker written when a completion claim is blocked. |

### Custom tools

The plugin registers six tools the model can call directly:

- `goal_contract` — record the Goal Contract (requirements, non-goals, acceptance
  criteria). Activates enforcement and fixes the required gates.
- `goal_evidence` — record a verification command and result.
- `goal_evidence_map` — return the acceptance-criteria evidence map with reviewer
  status, gaps, and next actions (backed by persisted state, not transcript memory; also
  available as `/goal-evidence-map`).
- `goal_reviewer_memory` — return unresolved and recently resolved reviewer findings.
- `goal_status` — return the authoritative gate/dirty/completion status.
- `goal_reset` — clear the session's goal state (requires `confirm: true`).

### Installer options

```bash
npm install -g opencode-goal-mode && opencode-goal-mode --global
npx opencode-goal-mode --global --dry-run
opencode-goal-mode-install --global --uninstall
node scripts/install.mjs --target /path/to/opencode-config
node scripts/install.mjs --global --force
```

In every target the installer copies only `agents/`, `commands/`, and `plugins/`, writes
`.goal-mode-manifest.json`, and merge-safely adds `opencode-goal-mode` to `tui.json`. On
upgrade it replaces files it owns but refuses to clobber files you've modified unless
`--force` is passed. `--uninstall` removes only owned files and its own `tui.json` entry.

## Troubleshooting

- **`opencode agent list` doesn't show `goal`.** The agents didn't install to a config
  dir OpenCode reads. Re-run `opencode-goal-mode --global` and restart OpenCode; confirm
  the files landed in `~/.config/opencode/agents/`.
- **The sidebar Goal todo section doesn't appear.** TUI plugins load from `tui.json`,
  not `plugins/`. Confirm `~/.config/opencode/tui.json` lists `opencode-goal-mode`, then
  **fully restart** OpenCode (the plugin cache is only re-read on restart). The sidebar
  is experimental and only renders inside a Goal session that has a goal set — never on
  the home screen or in Build mode. Enforcement works regardless of the sidebar.
- **Reviews didn't run automatically.** The code-driven review fires on `session.idle`.
  Some free models stall mid-turn without emitting idle, so the auto-review may not run
  live on them; `/goal-review` and `/goal-final` run a cycle on demand, and the
  completion guard still blocks an un-earned `Goal Completed` either way.
- **A safe command was blocked.** Run `node benchmarks/external.mjs --json` to see how
  the analyzer classifies commands, or set `blockDestructive: false` for that project.
  Please also [open an issue](https://github.com/devinoldenburg/opencode-goal-mode/issues)
  with the command.

## Requirements

- Node.js 20.11 or newer.
- OpenCode configured to load local agents, commands, and plugins. The package is tested
  against `@opencode-ai/plugin` 1.17.6 and declares compatibility with the 1.15+ plugin
  hook surface used here; newer OpenCode builds that change plugin or TUI slot APIs may
  need a package update.
- A working OpenCode provider/model — Goal Mode does not configure API keys or choose a
  model for you. Agents don't pin a model, so they inherit your OpenCode default; add a
  `model:` line to an agent's frontmatter in your installed copy to override one.

## Safety

The installer copies only `agents/*.md`, `commands/*.md`, and the `plugins/` tree —
never auth files, session files, tokens, or personal provider config.

The guard blocks destructive shell commands, marks real file mutations dirty, keeps
read-only inspection from dirtying the session, preserves goal state during compaction
and across restarts, and blocks premature `Goal Completed` responses when review gates
are missing or stale. It is **not** a sandbox and fails open on un-analyzable input —
see [SECURITY.md](SECURITY.md) for the threat model and reporting channel.

## Goal Completion Contract

`Goal Completed` is allowed only when:

- All acceptance criteria are mapped to evidence.
- Required verification passed or is credibly accounted for.
- No edit is newer than the latest required review cycle.
- Required reviewers return `Verdict: PASS`.
- The final answer includes an accurate `Review cycles: N`.

## Contributing & security

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, the
"keep benchmarks honest" ground rules, and the maintainer release process. Found a
vulnerability? Please use the private channel in [SECURITY.md](SECURITY.md) rather than a
public issue. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Full version history is in [CHANGELOG.md](CHANGELOG.md).

Releases are fully automated and **version-synced**: one pushed `vX.Y.Z` tag runs the CI
gate, then publishes to npm *and* creates the matching GitHub Release (notes from the
CHANGELOG). The pipeline is in
[`.github/workflows/publish.yml`](https://github.com/devinoldenburg/opencode-goal-mode/blob/main/.github/workflows/publish.yml).

## License

[MIT](LICENSE)
