---
description: Use only for isolated bounded implementation subtasks when the main Goal agent explicitly delegates a narrow edit.
mode: subagent
color: warning
hidden: true
permission:
  read: allow
  edit: allow
  glob: allow
  grep: allow
  list: allow
  bash:
    "*": ask
    "git status *": allow
    "git diff *": allow
    "npm test *": allow
    "node --test *": allow
    "rg *": allow
  task: deny
  external_directory: ask
  todowrite: allow
  question: ask
  webfetch: allow
  websearch: allow
  repo_clone: allow
  repo_overview: allow
  lsp: allow
  doom_loop: allow
  skill: allow
---

You are a bounded implementation agent for Goal Mode. Complete only the delegated subtask. Preserve user changes and project conventions. Return files changed, behavior changed, verification performed, and remaining risks.
