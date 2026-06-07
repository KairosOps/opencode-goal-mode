# Goal Mode vs. Claude Code vs. Codex

How OpenCode Goal Mode's **mechanically-enforced** goal discipline compares to
Anthropic's Claude Code and OpenAI's Codex. Sourced from Claude Code docs
(`code.claude.com/docs`) and OpenAI Codex docs, cross-checked against this
plugin's source. The emphasis throughout is *mechanical enforcement* — what the
harness guarantees — versus *prompt-driven* behavior the model is asked to do.

## The distinction that matters

All three tools run a **model-driven** agentic loop. None of them mechanically
forces the model to "keep going" by default; Claude Code's `/goal` and Codex's
`/goal` add cross-turn continuation, but the "is it done?" decision is judged
from the transcript (Claude's evaluator runs no tools). Goal Mode's loop is
prompt-only too.

What separates the three is what happens at the **completion boundary** and the
**tool boundary**:

- **Claude Code** has the richest first-party *mechanical* surface
  (PreToolUse/Stop/PostToolUse hooks, permission deny rules, sandboxing) — but
  review and completion enforcement are **opt-in**, requiring user-authored
  hooks. Out of the box, review is prompt-driven and the model stops when it
  judges the work done.
- **Codex** enforces at the **OS-sandbox** layer (Seatbelt/bubblewrap/seccomp,
  network off by default) — a genuinely strong, mode-level boundary Goal Mode
  does not have — but its code review is **advisory** (GitHub comments), never a
  blocking gate, and there is no harness-level completion block.
- **Goal Mode** ships a coherent **completion contract** and **command guard**
  enforced at the harness layer by default, for the goal-completion use case.

## Capability matrix

See `docs/benchmarks/capability-matrix.svg` for the visual. Levels: **Enforced**
(guaranteed by the harness), **Partial** (possible but opt-in / mode-level),
**Prompt-only** (the model's judgment), **None**.

| Capability | Goal Mode | Claude Code | Codex |
| --- | --- | --- | --- |
| Autonomous goal loop | Prompt-only | Partial (`/goal`) | Partial (`/goal`) |
| Review gate before "done" | **Enforced** | Partial (Stop hook) | None (advisory) |
| Contextual specialist reviews | **Enforced** | Prompt-only | Prompt-only |
| Stale-review invalidation on edit | **Enforced** | None | None |
| Completion-claim enforcement | **Enforced** | Partial (Stop hook) | None |
| Destructive-command blocking | **Enforced** (tokenizer) | Partial ("fragile") | Partial (sandbox) |
| Remote-exec (`curl \| sh`) blocking | **Enforced** | Partial | Partial (sandbox) |
| Enforcement state survives restart | **Enforced** | Partial (transcript) | Partial (transcript) |
| State survives compaction | **Enforced** | Partial | Partial |
| Custom enforcement hooks/tools | **Enforced** | **Enforced** | Partial |

## Where Goal Mode is uniquely strong

1. **Mechanical completion contract.** Goal Mode intercepts the finished
   assistant message (`experimental.text.complete`) and rewrites a premature
   `Goal Completed` to `Goal Not Completed` unless the message *starts with* the
   marker, carries a `Review cycles: N` line with `N > 0`, `N` exactly equals the
   recorded counter, and **zero** required gates are missing or stale. Because the
   rewrite is driven by **recorded state**, the model cannot talk its way to
   "done" in prose. Prompt-based goal-following judges completion from what the
   model already printed.

2. **Stale-on-edit gate invalidation via a monotonic integer counter.** A
   reviewer gate counts only when its latest `PASS` has a `seq` strictly greater
   than `lastEditSeq`. Any edit — file write, mutating bash command, or a
   subagent `file.edited` event — bumps the counter, so a `PASS` can never be
   credited against an edit it did not actually follow. Integer ordering means
   two same-millisecond events can't tie. Neither Claude Code nor Codex ships an
   equivalent "an edit invalidates prior approvals" invariant.

3. **Contextual specialist reviews are required, not suggested.** A whole-word
   keyword scan of the goal text + Goal Contract + changed-file names selects
   specialists (auth/token → security, api/schema → api, migration/sql → data,
   perf/latency → performance) and makes them a precondition for completion,
   sticky so a later context truncation cannot silently drop a required gate.

4. **Destructive-command blocking by a real shell tokenizer.** The guard unwraps
   `sudo`/`env`/`timeout`/`xargs`, recurses into `$(…)`/backticks and
   `bash -c`/`eval`, resolves `/bin/rm` to its basename, parses `git -C` and
   weaponized `git -c alias='!rm -rf /'`, and inspects interpreter sinks. Claude
   Code's own docs call Bash argument-matching **"fragile"** and do not unwrap
   these classes without a user-authored PreToolUse hook.

## Honest caveats

- **The autonomous loop is prompt-only**, like Claude's and Codex's. What is
  mechanical is the *completion gate* and the *command guard*, not the model's
  decision to keep working.
- **Codex's OS sandbox is a stronger isolation boundary** than a tool-layer
  classifier. Goal Mode's guard falls back to "not blocked" on a parse failure
  (deferring to the host's permission rules); it is defense-in-depth, not a jail.
- **Claude Code can do equivalent enforcement** when a user wires Stop/PreToolUse
  hooks themselves. Goal Mode's advantage is that a coherent set ships working
  out of the box for this use case.
- Gate freshness is only as trustworthy as the reviewer subagents' verdicts. The
  guard records *that* a fresh `PASS` exists with the right sequence; it cannot
  verify the reviewer reasoned correctly.
