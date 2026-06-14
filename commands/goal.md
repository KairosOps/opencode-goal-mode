---
description: Start a strict Goal Mode workflow with contract, subagent discovery, implementation, verification, and mandatory review cycles.
agent: goal
---

Start Goal Mode for this request:

```text
$ARGUMENTS
```

Run this sequence:

1. **Seed the contract first.** Call the `goal_contract` tool with the original
   request, explicit/inferred requirements, non-goals, and concrete acceptance
   criteria. This activates enforcement, fixes the required specialist review
   gates, and lights up the goal banner in the sidebar. Ask only essential
   clarifying questions before recording it.
2. Delegate discovery and research to subagents; implement in the main agent.
3. Verify, and record each verification with the `goal_evidence` tool so it maps
   to your acceptance criteria.
4. Run the required review cycles. Consult `goal_status` / `goal_evidence_map`
   for the authoritative list of missing or stale gates rather than relying on
   memory.
5. Only finish with `Goal Completed` (plus an accurate `Review cycles: N` line)
   once every required gate has a fresh PASS — the guard will rewrite a premature
   claim to `Goal Not Completed`.
