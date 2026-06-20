---
description: Run the final Goal completion gate before any Goal Completed response.
agent: goal-final-auditor
subtask: true
---

## What this command gives you

`/goal-final` is the operator-facing shortcut for this workflow: run the final goal completion gate before any goal completed response. Use it when you want the guard's state, evidence, or review workflow in a form that is explicit enough to act on immediately.

Run the final Goal completion audit. Do not edit files.

Final candidate package:

```text
$ARGUMENTS
```

Return whether `Goal Completed` is allowed, missing gates, stale review risks, final answer risks, and `Verdict: PASS` or `FAIL`.
