# OpenCode Goal Mode

Strict Goal Mode for OpenCode: a primary `goal` mode, specialized subagents, slash commands, and a guard plugin that preserves review discipline across long sessions.

## Requirements

- Node.js 20.11 or newer.
- OpenCode configured to load local agents, commands, and plugins.

## What It Adds

- A primary `goal` agent that owns implementation but delegates research, discovery, verification planning, and reviews to subagents.
- Strict review agents for prompt compliance, diff review, verification, security, UX, operations, and final completion.
- Slash commands for `/goal`, `/goal-contract`, `/goal-review`, `/goal-status`, `/goal-repair`, and `/goal-final`.
- A `goal-guard` OpenCode plugin that tracks dirty sessions, review cycles, review verdicts, and injects goal state into compaction.
- Tests that validate agent frontmatter, command frontmatter, plugin behavior, install safety, and config compatibility.

## Install Globally

```bash
npm ci
npm run validate
npm run install:global
```

Restart OpenCode after installation. OpenCode loads agents, commands, and plugins at startup.

## Install Into One Project

```bash
npm ci
npm run validate
npm run install:local
```

This writes to `./.opencode` in the current project.

## Installer Options

```bash
node scripts/install.mjs --dry-run
node scripts/install.mjs --target /path/to/opencode-config
node scripts/install.mjs --global --force
```

The installer refuses to overwrite changed destination files unless `--force` is passed.

## Validation

```bash
npm test
npm run validate
npm run audit
npm run publish:check
```

`npm run validate` runs the test suite, checks the OpenCode package structure, verifies the guard plugin hooks, and performs an npm package dry run.

## npm Publishing

Install from npm after the first publish:

```bash
npm install -g opencode-goal-mode
opencode-goal-mode-install --global
```

Publishing is handled by `.github/workflows/publish.yml`.

Required repository secret:

- `NPM_TOKEN`: an npm automation token with publish rights for `opencode-goal-mode`.

Release flow:

```bash
npm version patch
git push --follow-tags
```

Create a GitHub Release from the pushed tag, for example `v0.1.1`. The publish workflow validates the package, checks that the tag matches `package.json`, verifies that the version is not already on npm, then runs:

```bash
npm publish --access public --provenance
```

Manual workflow dispatch defaults to `npm publish --dry-run`.

## Safety

This repository intentionally does not include auth files, session files, tokens, or personal OpenCode provider config. The installer copies only:

- `agents/*.md`
- `commands/*.md`
- `plugins/goal-guard.js`

The guard plugin blocks destructive shell commands, marks real file mutations dirty, avoids dirtying sessions for read-only inspection commands, preserves Goal state during compaction, and blocks premature `Goal Completed` responses when review gates are missing or stale.

## Goal Completion Contract

`Goal Completed` is allowed only when:

- All acceptance criteria are mapped to evidence.
- Required verification passed or is credibly accounted for.
- Latest edit is not newer than latest required review cycle.
- Required reviewers return `Verdict: PASS`.
- Final answer includes `Review cycles: N`.
