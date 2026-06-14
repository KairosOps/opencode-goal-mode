# Architecture

OpenCode Goal Mode is three cooperating layers installed into an OpenCode
configuration directory:

1. **Agents** (`agents/*.md`) — a primary `goal` agent plus specialist
   subagents (researchers, mappers, planners, and a matrix of strict review
   gates). Each is a Markdown file: YAML frontmatter (mode, permissions, color,
   temperature) over a system-prompt body.
2. **Commands** (`commands/*.md`) — slash commands (`/goal`, `/goal-contract`,
   `/goal-review`, `/goal-evidence-map`, `/goal-status`, `/goal-repair`,
   `/goal-final`) that bind a prompt template to an agent, some forced to run as
   subtasks.
3. **The `goal-guard` plugin** (`plugins/goal-guard.js` + `plugins/goal-guard/`)
   — a runtime guard that enforces review discipline, blocks destructive shell
   commands, preserves state across compaction and restarts, and exposes
   first-class `goal_*` tools.
4. **An experimental TUI companion** (`plugins/goal-sidebar.tsx`) — a separate
   `{ tui }` plugin module that renders Goal sessions as a Goal-owned sidebar
   todo section. It is *paired* with the server plugin purely through the on-disk state
   snapshot (no extra IPC) and no-ops on any runtime without the slot API.

This document focuses on the plugin, where the engineering lives.

## Why a plugin at all

A prompt alone cannot guarantee discipline across a long session: the model can
forget the Goal Contract after compaction, claim completion without running the
required reviews, or run a destructive command. The plugin closes those gaps
using OpenCode's hook system as enforcement points that the model cannot talk
its way around.

## Module layout

The entry file `plugins/goal-guard.js` is deliberately thin — it wires hooks to
modules and contains no business logic. OpenCode's plugin discovery glob is
`{plugin,plugins}/*.{ts,js}` (a single level), so the helper modules under
`plugins/goal-guard/` are imported relatively but are **not** themselves loaded
as plugins. Each module is independently unit-tested.

| Module | Responsibility |
| --- | --- |
| `goal-guard.js` | Hook wiring, state-mutation orchestration, tool registration. |
| `goal-guard/shell.js` | Quote-aware shell tokenizer + command classifier. |
| `goal-guard/agents.js` | Canonical agent sets, base gates, contextual-gate keyword map. |
| `goal-guard/config.js` | Config resolution (defaults < env vars < plugin options). |
| `goal-guard/state.js` | Per-session state records + the store (monotonic seq, LRU, persistence hooks). |
| `goal-guard/persistence.js` | Atomic, debounced JSON persistence under the XDG state dir. |
| `goal-guard/verdicts.js` | Verdict extraction (last-wins, anchored), recording, and Reviewer Memory updates. |
| `goal-guard/gates.js` | Required-gate computation and freshness. |
| `goal-guard/completion.js` | `Goal Completed` claim evaluation. |
| `goal-guard/events.js` | Shared edit/verification/evidence mutators. |
| `goal-guard/summary.js` | State summaries, status reports, and evidence-map projections. |
| `goal-guard/system.js` | Live state block injected into the system prompt. |
| `goal-guard/summary.js` | Status/evidence projections, the short goal label, and the sidebar view. |
| `goal-guard/tools.js` | The `goal_status` / `goal_evidence_map` / `goal_reviewer_memory` / `goal_contract` / `goal_evidence` / `goal_reset` tools. |
| `goal-guard/sidebar-data.js` | Pure reader that projects the persisted snapshot into the sidebar todo model. |
| `goal-guard/logger.js` | Best-effort logging/toasts over the OpenCode client. |

## Hooks used

Verified against `@opencode-ai/plugin@1.15.13` source.

| Hook | Purpose in the guard |
| --- | --- |
| `chat.message` | Capture the user's goal text (drives contextual review gates). |
| `chat.params` | Track the current agent; activate goal sessions. |
| `experimental.chat.system.transform` | Inject the live Goal Guard state block. |
| `tool.execute.before` | Block destructive / remote-exec bash by throwing. |
| `tool.execute.after` | Record edits, verification, mutations, and review verdicts. |
| `experimental.text.complete` | Rewrite premature `Goal Completed` claims. |
| `experimental.session.compacting` | Preserve guard state across compaction. |
| `event` | Track `file.edited` (subagent edits), flush state on `session.idle`. |
| `tool` | Register the custom `goal_*` tools. |
| `dispose` | Flush persisted state. |

`permission.ask` is intentionally **not** used: in 1.15.13 it is declared in the
type but never triggered by the runtime, so destructive blocking is done by
throwing in `tool.execute.before` (the throw surfaces to the model as the tool's
error result).

## State model

State is created **per plugin instance** (a closure), not a module global, so
two OpenCode projects can never cross-contaminate each other's verdicts or dirty
flags. Within an instance, state is keyed by session id.

Every state-changing event draws from a single **monotonic `seq` counter** owned
by the store. Review freshness ("is this PASS newer than the latest edit?") is
decided by comparing seq numbers, not millisecond ISO timestamps — so two events
in the same millisecond cannot tie, and a review can never be accepted as fresh
against an edit it did not actually follow. Edits invalidate prior reviews;
re-running verification does not.

A session record tracks: active flag, captured goal text, the Goal Contract,
dirty flag and reasons, changed files, review-cycle count, the last edit/review/
verification seq and timestamps, the verdict log and per-agent latest verdict,
recorded evidence, Reviewer Memory, and completion-rejection history.

Reviewer Memory stores bounded summaries of blocking reviewer findings. A fresh
FAIL opens or refreshes a finding for that reviewer; a fresh PASS from the same
reviewer marks its open findings resolved. The memory is injected into status and
system context so recurring review issues survive long sessions and restarts.

### Persistence

OpenCode exposes no key/value store to plugins and discards in-memory plugin
state on restart. `persistence.js` writes the store snapshot as JSON under
`$XDG_STATE_HOME/opencode/goal-guard/<sha256(worktree)>.json`, atomically (temp
file + rename) and debounced. On load the store rehydrates and the seq counter
is restored so ordering stays monotonic across restarts. A read-only or sandboxed
filesystem degrades to pure in-memory operation rather than failing a tool call.

## Shell command analysis

`shell.js` replaces boundary-anchored regexes (which were trivially bypassed)
with a real lexer. It respects single/double quotes and backslash escapes,
recurses into `$( … )` / backtick substitutions, `eval`, and `-c` strings,
unwraps `sudo`/`env`/`xargs`/`timeout`/`nice`, resolves `/bin/rm` to `rm`, and
classifies each *simple* command by its resolved binary into four independent
signals:

- **destructive** — irreversible loss (`rm -rf`, `git reset --hard`, `dd of=/dev`,
  `curl | sh`, interpreter `os.remove`, …); blocked before execution.
- **mutating** — writes to the tree (`npm install`, `tee`, `> file`, `git commit`);
  marks the session dirty.
- **verification** — test/build/lint/typecheck commands; counts as evidence.
- **networkExec** — piping untrusted network output into a shell.

This catches the documented bypass corpus (`$(rm -rf /)`, `bash -c "rm -rf /"`,
`git -C /r reset --hard`, env-prefixes, newlines, interpreter deletions) while
clearing false positives such as `git checkout -b feature` and quoted text like
`echo "rm -rf /"`.

## Gating and completion

`gates.js` derives the required review gates from a fixed base set plus
contextual specialists selected by whole-word keyword matches against the goal
text, the recorded Goal Contract, and the set of changed files (so a goal about
"auth tokens" requires the security reviewer; "capital city" does not pull in the
api reviewer). A gate is satisfied only when its latest verdict is `PASS` with a
seq newer than the last edit.

`completion.js` evaluates a finished message that claims `Goal Completed`. Only
active goal sessions are policed. The claim is rewritten to `Goal Not Completed`
— with the specific missing gates appended — when the `Review cycles: N` line is
absent, no cycle was recorded, the claimed N does not match the recorded count,
or any required gate is missing/stale.

## Custom tools

The `tool` hook registers six tools (names are verbatim object keys):

- `goal_contract` — record the Goal Contract; activates enforcement and fixes the
  required specialist gates.
- `goal_evidence` — log a verification command + result into the ledger.
- `goal_evidence_map` — return the acceptance-criteria evidence map with reviewer status and next actions.
- `goal_reviewer_memory` — return open and recently resolved reviewer findings.
- `goal_status` — return the authoritative gate/dirty/completion status.
- `goal_reset` — clear the session's goal state (requires `confirm: true`).

The `@opencode-ai/plugin` import they need is isolated to `tools.js` and loaded
via a guarded dynamic import, so if the host cannot resolve it the core guard
hooks still load.

## TUI companion (experimental)

`plugins/goal-sidebar.tsx` is a TUI plugin module — default-exporting `{ id, tui }`
— distinct from the server plugin. It waits until the persisted state contains an
active Goal session, then registers a `sidebar_content` slot via
`api.slots.register({ slots: { sidebar_content } })` and renders the short goal
label, gate/status line, and structured Goal todos derived from acceptance
criteria, evidence freshness, dirty state, and missing gates. It starts with a
brief rainbow foreground effect, then returns to the configured running colour
(`#FFD700` by default). When there is no active Goal session it does not register
the slot, so Build and other modes keep OpenCode's native todo section in place.

It is *paired* with the server plugin only through the persisted state file:
`sidebar-data.js` recomputes the same `stateBaseDir`/`projectKey` path the guard
writes to and projects the active session via `summary.sidebarView`. That keeps
the pure projection logic Node-testable (`tests/sidebar.test.mjs`) even though the
JSX renderer itself can only run inside OpenCode's (Bun) TUI runtime. Everything
in the `tui` entry is wrapped so a missing slot API, missing JSX runtime, or read
error degrades to rendering nothing — it can never break the TUI. The server plugin
also emits review-verdict and completion-unlock toasts (`toastOnReview`) so review
progress is visible even without the banner.

The JSX renderer is verified headlessly with `@opentui/solid`'s `testRender` in
`tools/visual-test/sidebar-visual.jsx` (`npm run test:visual`, needs Bun + the
OpenTUI stack): it asserts the rendered text, the exact foreground colours, and
the bold attribute for Goal todo / done / native-todo-preserved states. That tool is excluded from
the npm package and from `node --test`/CI.

## Configuration

`config.js` merges, in increasing precedence: built-in defaults, environment
variables (`GOAL_GUARD_*`), and the plugin `options` object passed via the
`["./plugins/goal-guard.js", { … }]` form in `opencode.json`. Toggles cover
destructive blocking, network-exec blocking, completion enforcement, system-state
injection, persistence, contextual gates, session cache size/TTL, and toasts.

## Installer

`scripts/install.mjs` recursively copies `agents/`, `commands/`, and `plugins/`
(including the nested module directory) into the target config dir, and records a
manifest of the file hashes it wrote. On upgrade it distinguishes files it owns
(safe to replace) from files the user has customized (a conflict requiring
`--force`), prunes files from prior versions that no longer ship, and supports
`--uninstall` (which leaves locally-modified files in place).

## Testing

`node --test` runs the suite:

- `tests/shell.test.mjs` — the analyzer against the bypass and false-positive corpora.
- `tests/plugin.test.mjs` — hook behavior, gating, verdicts, completion, tools, isolation.
- `tests/truthfulness-benchmark.test.mjs` — false-completion corpus and truthfulness scoring.
- `tests/state.test.mjs` — store, seq ordering, eviction, persistence round-trips.
- `tests/sidebar.test.mjs` — short goal label, sidebar projection, snapshot reader, new destructive bins.
- `tests/toast.test.mjs` — review-verdict and completion-unlock toasts.
- `tests/agents.test.mjs` / `tests/commands.test.mjs` — frontmatter and contracts.
- `tests/install.test.mjs` — recursive copy, manifest upgrades, uninstall.

The shell guard's headline accuracy is measured on an external, third-party
corpus (`benchmarks/external.mjs` over `external-corpus.json`), not on the curated
fixtures — see [research/benchmarks.md](research/benchmarks.md).

`npm run validate` runs the tests, the structural config validator, the publish
readiness check, and an `npm pack --dry-run`.
