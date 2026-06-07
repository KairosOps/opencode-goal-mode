# Research

Background research that informs the Goal Mode design. These are working
references, kept so the rationale behind the plugin is auditable and the
platform facts are recoverable. They are shipped as reference docs so README
links resolve in the npm package, but they are not runtime files.

| Document | What it covers |
| --- | --- |
| [opencode-plugin-platform.md](opencode-plugin-platform.md) | Verified OpenCode plugin-runtime facts (hooks, discovery, permissions, tools) from `@opencode-ai/plugin@1.15.13` source. The pinned runtime reference the plugin is built against. |
| [goal-mode-comparison.md](goal-mode-comparison.md) | How Goal Mode's mechanical enforcement compares to Claude Code and OpenAI Codex, with citations and honest caveats. |
| [shell-hardening.md](shell-hardening.md) | The shell-analyzer threat model: the bypass classes the old regex guard missed and how the tokenizer closes each. |
| [benchmarks.md](benchmarks.md) | Benchmark methodology and results (detection rate, false positives, latency). Reproduce with `npm run bench`. |

Every non-obvious platform claim in these documents was verified against the
installed `@opencode-ai/plugin` type definitions and/or the `sst/opencode`
source at tag `v1.15.13`. Where a fact is version-specific (e.g. the dormant
`permission.ask` hook) it is called out as such.
