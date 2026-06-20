---
description: Run a strict Goal Mode review cycle as a subtask.
agent: goal-reviewer
subtask: true
---

## What this command gives you

`/goal-review` is the operator-facing shortcut for this workflow: run a strict goal mode review cycle as a subtask. Use it when you want the guard's state, evidence, or review workflow in a form that is explicit enough to act on immediately.

Run a strict review cycle for the current Goal candidate completion.

Review package or instructions:

```text
$ARGUMENTS
```

Compare original prompt, Goal Contract, changed files, implementation, and verification. Return blocking findings, non-blocking findings, missing verification, prompt mismatch, and `Verdict: PASS` or `FAIL`.
