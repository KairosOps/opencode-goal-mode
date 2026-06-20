# Research

These papers are the proof behind the pitch. They keep the marketing honest by
showing the sources, measurements, caveats, and threat models that shaped Goal
Mode's guardrails.

Background research that informs the Goal Mode design. These are working
references, kept so the rationale behind the plugin is auditable and the
platform facts are recoverable. They are shipped as reference docs so README
links resolve in the npm package, but they are not runtime files.

| Document | What it covers |
| --- | --- |
| [opencode-plugin-platform.md](opencode-plugin-platform.md) | Verified OpenCode plugin-runtime facts (hooks, discovery, permissions, tools) from `@opencode-ai/plugin@1.15.13` source. The runtime reference the plugin was built against; it now tests against `@opencode-ai/plugin` 1.17.6. |
| [goal-mode-comparison.md](goal-mode-comparison.md) | How Goal Mode's mechanical enforcement compares to Claude Code and OpenAI Codex, with citations and honest caveats. |
| [shell-hardening.md](shell-hardening.md) | The shell-analyzer threat model: the bypass classes the old regex guard missed and how the tokenizer closes each. |
| [benchmarks.md](benchmarks.md) | Benchmark methodology and results (shell guard accuracy plus completion truthfulness). Reproduce charts with `npm run bench` and JSON with `npm run bench:truthfulness`. |

Every non-obvious platform claim in these documents was verified against the
`@opencode-ai/plugin` type definitions and/or the `sst/opencode` source at tag
`v1.15.13`. The plugin's installed devDependency has since moved to
`@opencode-ai/plugin` 1.17.6, with peer compatibility declared as `>=1.15.0`.
Where a fact is version-specific (e.g. the dormant `permission.ask` hook) it is
called out as such.
