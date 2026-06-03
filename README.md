# OpenCode Goal Mode

Strict Goal Mode for OpenCode: a primary `goal` mode, specialized subagents, slash commands, and a guard plugin that preserves review discipline across long sessions.

## What It Adds

- A primary `goal` agent that owns implementation but delegates research, discovery, verification planning, and reviews to subagents.
- Strict review agents for prompt compliance, diff review, verification, security, UX, operations, and final completion.
- Slash commands for `/goal`, `/goal-contract`, `/goal-review`, `/goal-status`, `/goal-repair`, and `/goal-final`.
- A `goal-guard` OpenCode plugin that tracks dirty sessions, review cycles, review verdicts, and injects goal state into compaction.
- Tests that validate agent frontmatter, command frontmatter, plugin behavior, install safety, and config compatibility.

## Install Globally

```bash
npm install
npm run validate
npm run install:global
```

Restart OpenCode after installation. OpenCode loads agents, commands, and plugins at startup.

## Safety

This repository intentionally does not include auth files, session files, tokens, or personal OpenCode provider config. The installer copies only:

- `agents/*.md`
- `commands/*.md`
- `plugins/goal-guard.js`

## Goal Completion Contract

`Goal Completed` is allowed only when:

- All acceptance criteria are mapped to evidence.
- Required verification passed or is credibly accounted for.
- Latest edit is not newer than latest required review cycle.
- Required reviewers return `Verdict: PASS`.
- Final answer includes `Review cycles: N`.
