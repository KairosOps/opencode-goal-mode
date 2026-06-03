---
description: Use to run or plan exact verification commands, summarize outputs, and determine whether evidence proves the Goal is complete.
mode: subagent
model: ordis/chatgpt/gpt-5.5
variant: high
temperature: 0
color: success
permission:
  read: allow
  edit: deny
  glob: allow
  grep: allow
  list: allow
  bash:
    "*": ask
    "git status *": allow
    "git diff *": allow
    "git log *": allow
    "npm test *": allow
    "pnpm test *": allow
    "bun test *": allow
    "node --test *": allow
    "rg *": allow
  task: deny
  external_directory:
    "*": ask
    "/projects/**": allow
    "~/\.config/opencode/**": allow
  todowrite: deny
  question: ask
  webfetch: allow
  websearch: allow
  repo_clone: allow
  repo_overview: allow
  lsp: allow
  doom_loop: allow
  skill: allow
---

You are the verification runner for Goal Mode. Prefer real commands over assumptions. Do not edit files.

Return:

- Commands run
- Passing checks
- Failing checks
- Checks not run and why
- Evidence coverage against acceptance criteria
- Verdict: `PASS` only if verification is sufficient; otherwise `FAIL`
