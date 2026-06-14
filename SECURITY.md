# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories:
**[Report a vulnerability](https://github.com/devinoldenburg/opencode-goal-mode/security/advisories/new)**.

Do not open a public issue for a vulnerability. You can expect an initial
response within a few days.

## Scope

OpenCode Goal Mode is a defense-in-depth tool for an AI coding agent. The
`goal-guard` plugin blocks destructive and remote-execution shell commands using
a quote-aware tokenizer, but it is **not a sandbox**:

- The analyzer **fails open** on un-analyzable / highly dynamic commands,
  deferring to OpenCode's own permission rules. Treat it as a guardrail, not a
  jail.
- Gate freshness is only as trustworthy as the reviewer subagents' verdicts.
- The installer copies only `agents/*.md`, `commands/*.md`, and the `plugins/`
  tree — never auth files, tokens, sessions, or provider config.

Reports that meaningfully improve detection of destructive commands, or that
demonstrate a bypass of the completion/edit-staleness invariants, are especially
welcome.
