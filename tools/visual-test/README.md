# Sidebar visual test

`sidebar-visual.jsx` renders the **real** experimental TUI sidebar component
(`plugins/goal-sidebar.js`) headlessly with `@opentui/solid`'s `testRender`,
prints each frame, and asserts both the text and the exact foreground
colours / bold attributes from the renderer's span buffer. It is how the
sidebar is visually verified without a live OpenCode TUI.

It is **not** part of `npm test` / CI (OpenTUI is a runtime peer provided by
OpenCode, not a package dependency) and is **not** published to npm.

## Run it

Requires [Bun](https://bun.sh) and the OpenTUI stack. From the repo root:

```bash
npm install --no-save @opentui/solid@0.4.1 @opentui/core@0.4.1 solid-js@1.9.12
npm run test:visual
```

If the OpenTUI stack is not installed, the script prints `SKIP` and exits 0.

## What it checks

- Goal set → goal text in shining yellow, a bold `GOAL` label, and a
  `passing/total gates` status line (no "No goal").
- A running task with **no goal** → a clean grey `No goal`, nothing else.
- No guard state at all → the same grey `No goal` fallback (never blank/crash).
- All gates pass + clean tree → `· ready` in the status line.
- Custom colour via the `sidebarColor` option.
- Long goals are truncated with an ellipsis.
- Disabled via `sidebarBanner:false` → nothing registers.
- A runtime without `api.slots.register` → no-op, no throw.
- Narrow terminal resize still renders.
