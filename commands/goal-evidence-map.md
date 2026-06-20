---
description: Map Goal Contract acceptance criteria to recorded verification evidence and gaps.
agent: goal
---

## What this command gives you

`/goal-evidence-map` is the operator-facing shortcut for this workflow: map goal contract acceptance criteria to recorded verification evidence and gaps. Use it when you want the guard's state, evidence, or review workflow in a form that is explicit enough to act on immediately.

Produce a read-only evidence map for the current Goal Mode session. Do not edit files.

Call `goal_evidence_map` first and use its authoritative Goal Guard state,
including the Goal Contract, recorded evidence, dirty state, reviewer status, and
any user-provided context. Report unknown or missing details honestly instead of
inferring evidence that is not recorded.

Include:

- Acceptance criterion
- Recorded evidence covering it
- Reviewer status
- Verification command/result summary
- Status: covered, partially covered, missing, or stale
- Gap or risk
- Next required action

Additional context:

```text
$ARGUMENTS
```
