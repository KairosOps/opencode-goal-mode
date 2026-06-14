# Contributing

Thanks for helping improve OpenCode Goal Mode!

## Development

```bash
npm ci
npm test            # node --test (unit + integration)
npm run validate    # tests + structural validation + publish:check + pack dry-run
npm run bench       # regenerate benchmark results + charts
```

Optional (TUI sidebar visual test — needs [Bun](https://bun.sh)):

```bash
npm install --no-save @opentui/solid@0.4.1 @opentui/core@0.4.1 solid-js@1.9.12
npm run test:visual
```

## Ground rules

- **Keep benchmarks honest.** The headline accuracy number comes from the
  external, third-party corpus (`benchmarks/external.mjs`). The curated sets in
  `benchmarks/corpus.mjs` / `completion-corpus.mjs` are *regression fixtures* —
  never present their 100%/0% as measured accuracy. See
  [research/benchmarks.md](research/benchmarks.md).
- **Only `goal` is user-selectable.** Every other agent must stay
  `mode: subagent` (the validator enforces this) so specialists are only invoked
  by the Goal agent, never picked by the user.
- **Don't break the guard's fail-safes.** Hooks must never throw into a turn; the
  shell analyzer fails open on un-analyzable input.
- Add a unit test for any behavioral change; `npm run validate` must pass.

## Pull requests

1. Branch from `main`.
2. Make the change with tests and a `CHANGELOG.md` entry under a new
   `## vX.Y.Z` heading.
3. Open a PR. CI runs the validate matrix (Node 20.11 → 24) and `npm audit`.

## Releasing (maintainers)

```bash
npm version patch        # bumps package.json + lockfile and tags vX.Y.Z
git push --follow-tags   # the Release workflow publishes to npm + creates the GitHub Release
```

The release body is taken from the matching `CHANGELOG.md` section, so keep it
up to date.
