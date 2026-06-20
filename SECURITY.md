# Security Policy

Goal Mode is security-conscious software for an inherently risky job: letting an
AI coding agent run tools in a real repository. Its guardrails are designed to
reduce common failures, not to replace sandboxing, least-privilege credentials,
or careful review of generated code.

## Security promise

- Completion claims are checked against recorded gate state instead of model confidence.
- Destructive shell patterns are analyzed with tokenization rather than raw regex matching.
- Installer writes are limited to Goal Mode agents, commands, plugins, sidebar config, and its manifest.
- Vulnerability reports are handled privately first so bypasses can be fixed responsibly.

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
- The installer copies `agents/*.md`, `commands/*.md`, and the `plugins/` tree,
  merge-registers the sidebar in `tui.json`, and writes a manifest — never auth
  files, tokens, sessions, or provider config.

Reports that meaningfully improve detection of destructive commands, or that
demonstrate a bypass of the completion/edit-staleness invariants, are especially
welcome.
