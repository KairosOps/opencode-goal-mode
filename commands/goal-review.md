---
description: Run a strict Goal Mode review cycle as a subtask.
agent: goal-reviewer
subtask: true
---

Run a strict review cycle for the current Goal candidate completion.

Review package or instructions:

```text
$ARGUMENTS
```

Compare original prompt, Goal Contract, changed files, implementation, and verification. Return blocking findings, non-blocking findings, missing verification, prompt mismatch, and `Verdict: PASS` or `FAIL`.
