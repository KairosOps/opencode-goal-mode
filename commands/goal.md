---
description: Start a strict Goal Mode workflow with contract, subagent discovery, implementation, verification, and mandatory review cycles.
agent: goal
---

Start Goal Mode for this request:

```text
$ARGUMENTS
```

Run this sequence:

1. **Seed the contract first.** Call the `goal_contract` tool with a concise
   `title` (≤8 words, what the user ultimately wants — like a session title for
   the objective), the original request, explicit/inferred requirements,
   non-goals, and concrete acceptance criteria. This activates enforcement, fixes
   the required specialist review gates, and shows the `title` live in the sidebar
   goal banner. Record assumptions in the contract when the request is ambiguous —
   do not use the Questions tool (it is disabled on the goal agent).
2. Delegate discovery and research to subagents; implement in the main agent.
3. Verify, and record each verification with the `goal_evidence` tool so it maps
   to your acceptance criteria.
4. **Stop when implementation and verification are done.** The guard runs required
   review cycles programmatically on idle. Use `goal_status` / `goal_evidence_map`
   for the authoritative list of missing or stale gates; fix any blocking findings
   the guard returns.
5. Only finish with `Goal Completed` (plus an accurate `Review cycles: N` line)
   once every required gate has a fresh PASS — the guard will rewrite a premature
   claim to `Goal Not Completed`.
