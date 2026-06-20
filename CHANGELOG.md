# Changelog

## v0.6.6

### Fix: reviews always run before any guard continuation (strict idle cycle)

When the agent stopped thinking it was done, the idle handler could still inject a
generic "keep going" continuation before—or instead of—the programmatic review pass.
That violated the intended cycle: **stop → guard reviews → then either fix or Goal
Completed**.

- **Reviews first.** On idle with work outstanding, the guard now always runs the full
  programmatic review cycle before any continuation is sent to the goal agent. Reviewer
  subagents launch first; the goal agent is not nudged until after the cycle concludes.
- **`guardPrompt` / `emitGoalCompleted`.** Harness-driven continuations are prefixed
  `[Goal Guard]`, target the `goal` agent explicitly, and are distinct from the user's
  original prompt. After every required gate passes, `emitGoalCompleted` triggers the
  final turn whose output must be an earned `Goal Completed` with the accurate
  `Review cycles: N` line. A failing cycle sends a fix directive; the next idle starts
  a new review cycle.
- **Skip review when already complete.** Programmatic review is skipped when
  `completionAllowed` is already true (no redundant re-review on a clean stop).

Regression test asserts reviewers launch before any goal-agent continuation prompt.

## v0.6.5

### Fix: reviews now actually run programmatically (the agent is never told to run them)

The headline behavior — the guard launching the review subagents *itself* — was silently
falling back to nagging the **agent** to run the reviews via the task tool whenever a
model hadn't been captured from `chat.params`. In a live OpenCode TUI that's exactly what
happened: users saw a "make one task tool call whose subagent_type is …" directive instead
of the guard reviewing on its own.

- **Root cause.** The idle handler required a captured model before taking the programmatic
  path (`… && model && clientCanReview(…)`). But a launched reviewer session doesn't need
  one — it inherits the session's default model (`review-runner` only sets `model` when
  it's known). The model requirement is dropped; it's now passed through opportunistically
  when available and ignored when not, so the guard runs the reviewers itself whenever the
  host can drive sessions.
- **The agent is never told to call reviewers when `programmaticReview` is on.** The
  auto-continue "keep going" message is now mode-aware: with programmatic review on
  (default) it tells the agent the guard reviews automatically when it stops and to **not**
  call any reviewer itself; only with programmatic review disabled does it fall back to the
  explicit task-tool directive. (The system-prompt block already behaved this way.)
- The result is the intended single flow: the agent implements and verifies, stops, the
  guard runs one full review cycle on its own, and either re-prompts with blocking findings
  to fix or opens completion — repeating until done, with no manual reviewer calls.

Covered by a new integration test that drives an idle goal with **no captured model** and
asserts the guard still launches all required reviewers (345 tests).

## v0.6.4

### README rewritten as a confident product page

- The README now reads as a marketing-grade landing page: a centered hero with a sharp
  tagline and one-line install, the two signature demos (the `Goal Completed` →
  `Goal Not Completed` rewrite and a blocked `rm -rf`), benefit-led feature highlights, a
  bold stats row (93.3% / 0.2% / ~1µs), and a head-to-head comparison table vs Claude
  Code and Codex. Every claim remains verified against the code and the
  [comparison research](research/goal-mode-comparison.md) (the Codex row credits its
  sandbox-based command protection). Trimmed to ~265 lines. No behavior changes.

## v0.6.3

### README redesigned for first-time visitors + a code-driven-review polish

Docs:

- **README leads with value, then proof.** It now opens with a benefit-first hook and a
  plain-language "the problem" framing, followed by a **"see it in action"** section that
  shows the guard's two signature behaviors verbatim — the `Goal Completed` →
  `Goal Not Completed` rewrite and a blocked `rm -rf` — and a scannable "what you get"
  overview, before Install. Added a **Troubleshooting** section and an honest caveat that
  the idle-triggered auto-review may not fire live on models that stall mid-turn (the
  unconditional guarantees — completion rewriting, destructive-command blocking — always
  apply). Maintainer-only detail (dev loop, releasing, live E2E) now links to
  CONTRIBUTING.md, and the two README links that pointed at non-published paths
  (`tools/`, `.github/`) are absolute GitHub URLs so the npm page has no broken links.

Fix:

- **A clean programmatic review cycle now clears the dirty flag**, matching the
  agent-driven path (`maybeClearDirtyOnFinalPass`). Previously, after the guard reviewed
  its own work and every gate passed, completion opened but the sidebar/status could
  still read "re-verify / changes pending". A failing cycle still leaves the goal dirty.

## v0.6.2

### Deep cross-cutting bug hunt — 8 confirmed defects fixed

A deeper adversarial sweep across the whole completion path (review-loop lifecycle,
completion-marker parsing, shell classification, and contract recording) found and this
release fixes **eight** real defects. Every one was independently reproduced against the
real modules before fixing and now has a regression test (**343 tests pass**).

Review-loop lifecycle (the v0.6.0 code-driven reviews):

- **Mid-review edit staled fresh passes (medium).** A project-scoped `file.edited` that
  landed *during* a programmatic review run was attributed to the (idle) goal and bumped
  `lastEditSeq` into the middle of the verdict sequence, staling PASSes the review had
  just recorded — so completion was blocked despite every reviewer passing, and the agent
  was handed a self-contradictory "you MUST fix blocking issues / Failing reviewers:
  (empty)" directive. The agent does no work while it is being reviewed, so such edits are
  now suppressed for the duration of the run; the empty-failing-reviewers directive is
  also no longer emitted.
- **User cancel during a review run ignored (high).** Pressing stop mid-review set
  `abortedAt`, but the post-review continuation checked only the user-turn counter and
  re-prompted the goal anyway — fighting the stop button. The continuation is now
  suppressed when a cancel arrives during the review.
- **Review-cycle double-count (high).** When the cycle-closing `goal-final-auditor` was
  recorded twice for one round with no edit in between (e.g. the agent ran it via `task`
  *and* the guard ran it programmatically), `reviewCycles` inflated. A closing verdict now
  counts a new cycle only when the agent edited since the previous one.

Completion-marker parsing:

- **Invisible-character marker bypass (medium).** A premature `Goal Completed` prefixed
  with a zero-width / bidi / word-joiner code point (U+200B–U+200F, U+2060, U+FEFF,
  U+00AD) slipped past the marker unrewritten — `\s` does not cover those. They are now
  folded into the leading-prefix class.
- **Earlier "Review cycles" mention false-rejected a valid completion (low).** The
  claimed-cycles parser took the *first* `Review cycles: N` it found, so an earlier
  mention (a recap, a quoted example) was read as the claim and rejected a legitimate
  completion. It now reads the *last* (conclusion) line.

Shell classification:

- **Applet multiplexers hid destructive commands (high).** `busybox rm -rf …` /
  `toybox find . -delete` were invisible to the guard because the multiplexer was not a
  recognized wrapper. `busybox`/`toybox` are now unwrapped and the real applet classified.
- **`rsync --delete` mirror-wipe under-classified (medium).** A destination-mirroring
  `rsync -a --delete empty/ target/` irreversibly wipes `target` but was only flagged
  *mutating*. `rsync` with `--delete` / `--delete-*` / `--del` is now destructive; plain
  `rsync` stays mutating.

Contract recording:

- **Re-recording the SAME goal wiped review progress (high).** Formalizing an auto-seeded
  goal by re-wording its `original` (e.g. "Add a rate limiter to login" → "Add a
  configurable token-bucket rate limiter to the login endpoint") was treated as a brand-new
  goal under strict string-equality, resetting `reviewCycles` to 0 and silently disabling
  the next programmatic review. Reset now uses content-token similarity: a faithful
  restatement of the same goal preserves progress, while a genuinely different request
  still resets (keeping the un-reviewed-completion leak closed).

Docs:

- **All Markdown brought in sync with the code** (audited file-by-file against the source,
  then adversarially re-verified). Notable fixes: the README config table now lists all 24
  keys with correct defaults and documents the code-driven review model + `programmaticReview`;
  ARCHITECTURE's module/hook inventory matches `plugins/goal-guard/` (added `guard.js`,
  `autocontinue.js`, `review-runner.js`; corrected the entry-file description and the
  `@opencode-ai/plugin` version to 1.17.6); `agents/goal.md` and the reviewer agent docs now
  describe reviews as guard-launched rather than agent-invoked.

## v0.6.1

### Hardening of the v0.6.0 code-driven review loop (adversarial hunt + live lab)

A deep adversarial hunt on the new review loop — plus a live lab run that reproduced it
— found and this release fixes four real defects in v0.6.0. Each has a regression test
(**335 tests pass**). The hunt also confirmed the loop is otherwise sound (idle
re-entrancy serialized, reviewer sessions never self-trigger a review, concurrent goals
isolated, single-cycle launches exact, normal FAIL→fix→PASS cycle counting correct).

- **Review-loop runaway (high).** The backstop counted `reviewCycles`, which only
  increments on a *concluded* `goal-final-auditor` verdict. A reviewer that never
  renders a `Verdict:` line (a stalling/terse model) — or a specialist gate that never
  passes while the auditor stays fresh — pinned that counter, so the cap never tripped
  and the loop ran to the auto-continue cap (~250 reviewer sessions) or, with that
  disabled, unbounded. Now bounded by a dedicated **`reviewRunCount`** (review *cycles
  run*), so the loop always stops at `maxReviewCycles` regardless of verdicts.
- **Verdict mis-parse → completion leak (critical).** A reviewer that concluded
  `Verdict: FAIL` but included a quoted example like `(a clean run ends with
  "Verdict: PASS")` was recorded **PASS** — `parseVerdict` took the last positional
  match. It now ignores a verdict enclosed in quotes/backticks on its line, so a real
  FAIL is never overridden by an example (genuine last-wins for an unquoted fixed PASS
  is preserved).
- **Mid-stream verdict latch (high).** The runner polled the reviewer's messages and
  latched the FIRST `Verdict:` it saw — an interim streaming `PASS` could win over the
  reviewer's final `FAIL`. It now waits for the reviewer's output to stabilize before
  reading the verdict.
- **Reviewer session leak (high).** If `promptAsync` threw after `session.create`
  succeeded, the created reviewer session was never aborted. Cleanup now runs in a
  `finally`.

## v0.6.0

### Code-driven review enforcement — the guard launches the reviewers itself

Until now the review gates depended on the *model* spawning the review subagents via
the task tool (nudged by the system prompt). Weak models skip it, so reviews never
run. **This release makes the guard CODE launch the required reviewers itself — 100%,
never dependent on the agent.**

When an active goal idles with work done and gates outstanding, the guard:
1. **programmatically launches** each required reviewer subagent (`client.session` →
   the `goal-*` reviewer agent), reads its `Verdict:` line, and records it — one full
   pass over the required reviewers (ending with the cycle-closing auditor) is **one
   review cycle**;
2. on any **FAIL**, feeds the blocking findings back to the agent to fix (the fix is an
   edit, which staleness-invalidates the prior passes), so the next idle re-reviews —
   exactly the loop *agent done → review → FAIL → fix → review → … → PASS*;
3. on **all PASS**, opens completion and tells the agent to finish with an accurate
   `Review cycles: N`.

The agent now just **implements and verifies**, then stops — the guard reviews. New
config: `programmaticReview` (default **on**; set false to fall back to nudging the
agent), `reviewTimeoutMs`, `reviewPollMs`, `maxReviewCycles` (backstop). If the host
client can't drive sessions, it degrades gracefully to the previous nudge behaviour.

**Review cycles are now recorded AND surfaced everywhere, always** — the TUI sidebar
shows the count *while running* (not only when done), a toast fires as each cycle
closes, and `goal_status` + the system-prompt block already carry it.

**Completion-integrity leaks closed (found by an adversarial completion-flow hunt and
each re-verified + regression-tested):**
- A premature `Goal Completed` wrapped as a markdown checkbox (`- [x] Goal Completed`),
  in quotes/parens/brackets, or HTML tags (`<b>…</b>`, `<h2>…</h2>`) **leaked past the
  rewrite** — the marker detector now tolerates all of these (still start-anchored, so
  a mid-sentence mention is not policed).
- `perl -i` / `ruby -i` in-place edits (incl. `-i.bak`, bundled `-pi`) were not marked
  mutating, so they didn't invalidate prior reviews — now they do (uppercase `-I`
  include paths are not over-flagged).
- A new goal authored over an **auto-seeded** contract inherited the previous goal's
  passed gates → instant un-reviewed completion. `goal_contract` now resets per-goal
  progress whenever the request differs from the recorded contract (auto-seeded too).

**331 tests pass** (new: programmatic review-runner unit + hook-level integration
proving the guard launches the reviewers and runs the FAIL→fix→PASS cycle).

## v0.5.2

### Shell-guard adversarial hardening — real bypasses closed

A deep adversarial battery (try-hard-to-slip-a-destructive-command-past-the-guard,
plus an over-block guard corpus, plus a live end-to-end block confirmed against a
fresh install) surfaced four **real** gaps in the destructive-command analyzer. All
are now blocked, with **zero new false-positives** (every fix has a regression test;
**317 tests pass**):

- **Perl/Ruby `system()` / `exec()` / `popen()` shell-outs were not detected.** Only
  Python's `os.system(...)` was caught; bare-call forms (`perl -e 'system("rm -rf /")'`,
  `ruby -e 'exec("rm -rf x")'`) slipped through. They are now classified destructive.
  A method call like `platform.system()` / `obj.exec()` is deliberately NOT over-blocked
  (matched only when the call is not preceded by a `.` or word char).
- **A truncating redirect onto a raw block device or a system path is now destructive**
  (`cat x > /dev/sda`, `echo x > /etc/passwd`). Ordinary file redirects — including
  append, `/tmp`, and home paths — remain mutating-not-destructive.
- **`git stash clear` / `git stash drop`** (irreversible stash loss) are now destructive;
  `pop` / `apply` / `list` are unaffected.
- **`crontab -r`** (removes the user's entire crontab) is now destructive; `crontab -l`
  is unaffected.

Known, deliberately-unchanged fail-open cases (undecidable by static analysis; the host's
own permission rules still apply): variable-indirected (`X=rm; $X -rf /`) and `$IFS`-split
command names, and truncating a home dotfile via `>` (indistinguishable from a normal
output redirect). These mirror the existing documented `git checkout <file>` heuristic gap.

## v0.5.1

### Verification / maintenance — fresh-install confirmed working for new users

**No runtime change to the plugin** since v0.5.0 — this release adds a repeatable
fresh-install verification and confirms the published package works end-to-end for a
brand-new user on a clean system.

A new harness (`npm run test:fresh-install`, `tools/e2e/fresh-install.mjs`) packs the
exact npm tarball, installs it with the shipped installer into an **isolated home**,
and asserts:

- every shipped component lands — the `goal` primary agent, all `goal-*` reviewers
  (≥20), the commands, the multi-file guard plugin, the version-matched manifest, and
  the `tui.json` sidebar registration;
- the installed guard plugin module imports cleanly;
- a real `opencode serve` rooted at that isolated home **registers the `goal` agent and
  the `goal-*` reviewers** (the exact path `/goal` exercises — guarding against an
  "agent goal not found" regression), and the installed files survive server startup.

Verified live against a clean install + a free OpenCode Zen model: the guard engages,
records the Goal Contract (with acceptance criteria), fires contextual review gates,
captures review verdicts, and observes verification — exactly as a new user expects.
The full unit/integration suite (312 tests) and `npm run ci` remain green.

## v0.5.0

### Weak-model robustness + a goal-mode observatory

This release is driven by a new internal stress-testing tool (**Goal Lab**) that runs
many Goal Mode agents at once against real `opencode serve` instances and real free
OpenCode Zen models, captures every event and the guard's on-disk ledger, and
auto-investigates failures. **Honest finding first:** the lab surfaced **no new
correctness defects** — destructive-command blocking, premature-completion rewriting,
and review forcing all held. What it did show is where *low-capability / rate-limited*
models under-perform: they often skip `goal_contract` and stop without spawning the
required reviewers. The changes below harden the plugin against exactly that, without
weakening any enforcement guarantee. **312 tests pass (6 new regression tests).**

**Determinism / robustness (the shipped plugin changes):**
- **Auto-anchored Goal Contract.** An active goal whose model never calls
  `goal_contract` now gets a baseline contract auto-derived from the user's own
  request, so the TUI sidebar and the injected objective are live from turn one and
  contextual review gates engage regardless of model capability. It is strictly
  additive (enforcement already engaged from the active goal agent) and never fires
  for Build/Plan/non-goal sessions. `acceptanceCriteria` is intentionally left empty so
  the system prompt keeps nudging the model to enrich it.
- **`goal_contract` upgrades an auto-anchored contract in place.** Authoring the real
  contract over an auto-derived one is treated as an upgrade, not a new goal, so it no
  longer wipes accumulated review progress (gates/verdicts/evidence).
- **Prescriptive in-prompt steering.** The injected enforcement block and the
  auto-continue message now spell out the *exact* next action — a copyable `task` tool
  invocation naming the first outstanding reviewer (`subagent_type: "…"`), plus a
  contract-first directive when none is recorded — instead of only stating that reviews
  are required. This measurably helps weak models drive a goal to completion in fewer
  turns.

**Tooling (not published to npm — `tools/lab/`, git only):**
- **Goal Lab** — a dependency-light browser observatory (Node `http` + SSE + vanilla
  ESM, Cloudflare/Kumo-styled): a live list of agent runs, per-task Temporal-style
  event history, run tree, completion-gate stepper, orchestration graph, guard ledger,
  and auto-classified incidents with suggested plugin fixes. `node tools/lab/server/index.mjs`.
  Full per-task data is available on disk (JSONL) and via `GET /api/runs/:id/data` for
  debugging; see `tools/lab/README.md`.

## v0.4.13

### Verification / maintenance release

- **No code, agent, or command changes since v0.4.12** — runtime behaviour is identical.
- Re-verified end to end against a real OpenCode server + a free OpenCode Zen model:
  the full unit/integration suite (306 tests) passes; the live E2E passes 9/9 (required
  reviews forced, destructive commands blocked, Build sessions isolated, and a user
  cancel honored across 5/5 trials); and a clean-room install of the **published** npm
  tarball confirms the shipped `files` are complete, the installer runs from the
  published artifact, and all v0.4.12 fixes are present in the installed plugin.

## v0.4.12

### Deep audit hardening — closes real enforcement & RCE bypasses

A deep, adversarially-verified audit of the whole plugin found and this release fixes
the following **real** defects (every fix has a regression test; 306 tests pass):

**Enforcement integrity (high):**
- **Completion gate could be bypassed by the marker's own format.** A premature
  `` `Goal Completed` `` in a code span (the exact form the goal agent is taught to
  emit), or prefixed by an emoji / list number (`✅ Goal Completed`, `1. Goal Completed`),
  slipped past the gate unrewritten. The detector/rewriter now tolerate any leading mix
  of backticks, markdown, emoji, and ordered-list markers — while still ignoring a
  mid-sentence mention.

**Shell guard — remote-code-execution holes closed (high/medium):**
- `… | base64 -d | sh` (and other decoders: base32/xxd/openssl/tr/gunzip…) piped into a
  shell are now flagged; a network fetcher behind the decoder still trips `networkExec`.
- `curl … | python|node|perl|ruby|php` (interpreters reading their program from stdin)
  is now detected as remote execution.
- `bash <(curl …)` process-substitution RCE and `eval "$(…)"` / `sh -c "$(…)"`
  substitution-as-code are now analyzed instead of dropped.
- **False positive fixed:** `git restore --staged <file>` (index-only unstage) is no
  longer blocked as destructive; `git restore` of the worktree still is.

**Correctness & robustness (medium/low):**
- The shipped `/goal-review` and `/goal-final` slash commands now run from a non-goal
  session (they were wrongly blocked by the subagent restriction); model-emitted poach
  attempts from a non-goal agent stay blocked.
- `file.edited` is attributed to the single in-flight goal session instead of broadcast
  to every active goal, so concurrent goals in one worktree are no longer cross-dirtied
  or given each other's required gates.
- Auto-continue: overlapping idles are fully coalesced (no duplicate continuations or
  double-advanced backstop counters); a goal→build switch and a user-cancel clear are
  now persisted durably; clock-skew/future-dated cancel flags fail safe; the internal
  per-session sidecar maps are pruned on eviction (no unbounded growth).
- The TUI sidebar now evaluates completion with the server's **resolved** config
  (persisted in the snapshot), so a non-default `contextualGates` can't make it show a
  finished goal as perpetually running.
- The stuck-`dirty` case (final auditor passing before the last other gate) is fixed.

**Config:** `completionMarker`/`blockedMarker` are now settable via environment
(`GOAL_GUARD_COMPLETION_MARKER`/`_BLOCKED_MARKER`); integer options reject decimals/
scientific notation instead of silently truncating; empty/blank string options are
ignored (never inject an empty marker); README documents `abortGraceMs`.

No change to the documented agent/command behaviour; runtime enforcement is stricter
and safer.

## v0.4.11

### A user cancel is now honored — auto-continue never fights the stop button

- **Fixed:** cancelling a goal turn (the OpenCode stop/escape) no longer triggers an
  automatic continuation. Previously the cancel still left the session idle, so
  auto-continue re-prompted it — the task could not actually be stopped. The guard now
  detects the cancel programmatically (the `MessageAbortedError` the cancel emits) and
  suppresses the continuation; it sends **no** prompt. Auto-continue resumes normally
  only when *you* start the next turn.
- **Robust by construction, not by luck.** The cancel's error and idle events can reach
  the plugin in either order, and one cancel emits more than one idle — both are handled:
  a short, configurable grace (`abortGraceMs`, default 1200ms) lets a near-simultaneous
  cancel be observed regardless of delivery order, the cancel suppresses *every* idle in
  the window (not just the first), overlapping idles are coalesced into a single decision
  (no double prompts or skewed backstop counters), and a new user turn that starts during
  the grace cleanly supersedes any stale continuation. Clock-skew and persisted-flag edge
  cases fail safe (toward honoring the cancel).
- A subtle, informative toast ("turn cancelled — not auto-continuing") confirms the guard
  saw your cancel.
- Verified live against a real OpenCode server + free Zen model (cancel honored across
  repeated trials, normal auto-continue unaffected), plus new unit/integration tests and a
  dedicated live E2E cancel scenario.

## v0.4.10

### Live end-to-end test suite (development tooling)

- Added `npm run test:e2e`: a live end-to-end suite that drives **real** goal
  sessions against a real OpenCode server and a free OpenCode Zen model, asserting
  the guard's behaviour as it happens — a Goal Contract is recorded, the required
  reviews are actually forced to run (all five review subagents), no un-earned
  `Goal Completed` slips through, a destructive `rm -rf` is blocked mid-run, and a
  Build session never becomes a goal nor invokes `goal-*` subagents.
- It boots a dedicated, isolated `opencode serve` per scenario (its own throwaway
  git project) and observes the run over the OpenCode HTTP API
  (`session.promptAsync` + the `/event` stream — the same flow the live TUI uses),
  so nothing leaks into your working tree.
- **Scope:** this release is development tooling and documentation only. The suite
  is not shipped in the npm package and not run in CI, and there are **no changes
  to the plugin, agents, or commands** — runtime behaviour is identical to v0.4.9.

## v0.4.9

### Required reviews are now programmatically forced

- The required reviews are no longer just *required* — they are *forced*. While any
  review gate is outstanding, BOTH the per-turn system-prompt injection AND every
  auto-continue now issue an explicit, non-optional directive naming the exact
  missing review subagents and commanding the agent to invoke each via the task tool
  immediately (one task call per reviewer) and re-run until each returns
  `Verdict: PASS` — before any summary or completion claim.
- Together with the completion gate (cannot finish without the reviews) and
  auto-continue (cannot stop while incomplete), this makes skipping the reviews
  effectively impossible: the goal cannot complete, the agent cannot stop, and every
  turn/continuation drives the outstanding reviews to actually run.

## v0.4.8

### Never stop before the goal is complete (auto-continue)

- A goal session that goes **idle while the goal is still incomplete** is now
  automatically continued: the guard sends the agent a "do not stop — here's what's
  left" message (via `session.promptAsync`) so it keeps working until the goal is
  actually done. Previously the agent could stop on an unfinished goal (e.g. a
  failing or missing `goal-final-auditor` gate) and just sit idle — it now picks
  itself back up and resumes, naming the outstanding gates/changes.
- **Safe by construction.** Two backstops prevent any runaway: a hard per-session
  cap (`maxAutoContinue`, default 50) and a no-progress circuit-breaker that pauses
  auto-continue (with a clear toast/log) if the agent stops making progress, so it
  can never loop forever or burn tokens endlessly. Disable with `autoContinue`.
- Verified that `session.promptAsync` starts a fresh turn against a live OpenCode
  server, and that the decision logic continues incomplete goals, stops on complete
  ones, ignores Build/non-goal sessions, and honors both backstops.

## v0.4.7

### Sidebar / goal state

- **Fixed: starting a new goal — or switching goals — in the same session left the
  sidebar stuck on the old goal.** Recording a new goal via `goal_contract` replaced
  the contract but kept the previous goal's accumulated goal text, sticky review
  gates, verdicts, dirty flags, evidence, and review-cycle count. So the new goal
  inherited the old goal's gate status (even a stale "completed · N review cycles")
  and, when no fresh contract had been recorded yet, its title — the section just
  kept showing the old goal and never updated. A genuinely new goal (a different
  original request) now resets that per-goal progress while keeping the session
  active, so the sidebar reflects the new goal immediately. Re-recording or refining
  the *same* goal still preserves its review progress.
- Regression tests cover both directions: a new goal no longer inherits the prior
  goal's completed gates/cycles/goal-text, and refining the same goal keeps its
  progress.

## v0.4.6

### Sidebar

- **Removed the random rainbow effect that played on load.** When a goal first
  appeared, the Goal todo section briefly cycled its header lines and todos through
  rainbow colours before settling into the lifecycle colours. It was a flashy
  load-time animation that served no purpose — unnecessary and useless for
  productivity — so it is gone. The section now renders its settled per-line
  colours from the very first frame: a yellow `GOAL` label, a white goal title, a
  cyan gate count, and an orange lifecycle status (all red when done). The
  colouring is unchanged; only the random rainbow flash on load is removed.
- Removed the now-defunct `sidebarRainbowMs` option and its
  `GOAL_GUARD_SIDEBAR_RAINBOW_MS` environment variable.
- Verified via the headless sidebar visual harness (`npm run test:visual`): the
  `GOAL` label renders yellow, the title white, the gate count cyan, and the
  status orange from the first frame, with no rainbow phase.

## v0.4.5

### Install experience

- Verified every documented install path end-to-end in clean Linux containers and
  on macOS: the one-command global install, the auto-update `postinstall`,
  `npm install -g` on its own, the `opencode-goal-mode-install` alias,
  `npx … --global`, the `npx` project install (`./.opencode`), `--dry-run`,
  `--uninstall`, and the from-source `npm ci && npm run install:global`.
- The installer now prints clear next steps after installing (restart OpenCode, pick
  the `goal` agent or run `/goal …`) and an explicit "nothing was written" line on
  `--dry-run`.
- Docs: corrected the `npx` note — OpenCode loads the TUI sidebar from its own
  plugin cache (fetched from npm), so the sidebar works after an `npx … --global`
  install too, not only a global npm install.

## v0.4.4

### Sidebar todos and gates stay correct and up to date

- **Acceptance-criterion todos now check off.** They were matched against the
  *display-clipped* criterion text, so any criterion longer than the sidebar width
  never showed as done even with exact matching evidence. Matching now uses the full
  criterion text (clipping is display-only). Verified live in the OpenCode TUI.
- **The Goal section refreshes promptly.** It now updates on OpenCode activity
  events (`message.part.updated`, …) — the same mechanism the reference TUI plugin
  uses — in addition to the polling fallback, and forces a repaint on each refresh,
  so gates and todos track the goal's real state as reviewers pass and evidence is
  recorded instead of going stale.

### Docs

- The README preview is now a real TUI screenshot (`docs/sidebar-preview.png`).

## v0.4.3

### Build mode no longer behaves like a goal

- Switching a session from the `goal` agent to Build (or any non-goal agent) now
  **deactivates** it: `state.active` tracks the current agent (`isPrimaryAgent`),
  instead of latching `true` forever. The sidebar also gates on the session's live
  current agent (its latest message), so when you switch to Build the Goal section
  disappears and OpenCode's native todos return — and a Build session can no longer
  invoke the `goal-*` subagents or have its completion claims policed.
- Goal **worker** subagents (e.g. `goal-implementer`) are no longer activated by
  their own edits, so Goal completion enforcement is never injected into a worker's
  prompt. Bookkeeping runs only for active goal sessions and review subagents.

### `npm install -g` now updates everything, automatically

- A global-install `postinstall` runs the installer for you — it copies the
  components into `~/.config/opencode`, registers the Goal sidebar, and clears
  OpenCode's stale plugin cache — so `npm install -g opencode-goal-mode` **alone**
  fully installs or upgrades Goal Mode and the new version actually loads on the
  next restart. It runs only for global installs, never for repo/dev/dependency
  installs, and never fails the npm install (it prints a hint if it can't finish).

### Fixes

- **CI green again:** the headless visual test no longer requires
  `@opentui/solid/jsx-dev-runtime` (the CI visual job was failing).
- Hardened `gatePassedFresh` against partial/legacy snapshots so the TUI never
  silently fails to render an active goal.
- Compaction context is only added for active goal sessions (no stray Goal state in
  a Build session's compaction summary).
- Docs: corrected the sidebar description (separate gate/status lines; the label is
  `GOAL`, not "Goal todos").

## v0.4.2

### The sidebar Goal section now actually renders in the live TUI

- **Root-cause fix.** The `sidebar_content` slot bailed at mount with
  `return undefined` whenever no goal existed *yet* — but the goal is normally set
  *after* the sidebar mounts, so the polling component never started and the Goal
  section never appeared. The slot now **always mounts a reactive, polling
  component** and reveals the section (via `<Show>`) the moment the goal is
  recorded. Verified by driving the real OpenCode TUI in a PTY.
- **Stale plugin cache.** OpenCode caches TUI plugins under
  `~/.cache/opencode/packages/<name>@<spec>/` and never re-checks npm, so upgrades
  kept loading the *old* sidebar build. The installer now clears that cache on
  install and uninstall, so a restart picks up the installed version.
- The first-display rainbow now triggers when the goal first appears (not at
  mount, when there may be no goal yet).
- The sidebar resolves state under both the worktree and directory path keys, so a
  path-key mismatch can't hide an active goal.

### Sidebar layout

- The gate count and the lifecycle status are now on **separate lines**, each in
  its own colour (GOAL = yellow, title = white, gates = cyan, status = orange).

### Native todos are replaced in goal mode

- The `goal` agent no longer uses the native `todowrite` tool (it is disabled in
  Goal Mode). Because OpenCode renders native todos as their own sidebar slot, the
  only way to replace them is to stop producing them — so in a goal session the
  native todo list stays empty and the structured Goal-owned section is what shows.
  Build and every other mode keep their native todos.

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
