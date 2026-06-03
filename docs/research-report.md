# Research Report: Goal Mode Hardening

## Sources Checked

- OpenCode agents, commands, permissions, plugins, and skills documentation.
- Claude Code subagents and hooks documentation.
- Codex CLI, Codex Web, subagents/review/sandbox concepts, and repository overview.

## Findings

Prompt-only Goal Mode is not enough. A strong mode needs separate context windows for exploration and reviews, explicit review handoffs, stale-review invalidation after edits, state preservation through compaction, safer permissions, and repeatable commands.

## Claude-Inspired Patterns

- Use subagents to protect main context from search logs and broad file reads.
- Give subagents narrow descriptions and narrow permissions.
- Keep orchestration in the main agent; subagents return summaries only.
- Use hooks/lifecycle events to enforce safety and preserve state.

## Codex-Inspired Patterns

- Run local code review through a separate agent before claiming completion.
- Use explicit approval/safety modes and sandbox thinking for risky operations.
- Treat review and verification as a repair loop, not a final paragraph.
- Track outcomes and repeated failures as part of an improvement loop.

## OpenCode Implementation Choices

- Agents are Markdown files in `agents/`.
- Commands are Markdown files in `commands/`.
- Guardrails live in a local plugin with OpenCode hooks.
- Tests validate the installable package without copying secrets.

## Remaining Platform Limits

- OpenCode plugins cannot fully prevent every possible final answer, but `experimental.text.complete` can inject blocking warnings when `Goal Completed` appears while the session is dirty.
- Review cycle state is runtime in-memory per OpenCode process; compaction preserves it in prompt context, but restart resets plugin memory.
