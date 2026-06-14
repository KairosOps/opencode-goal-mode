# Sidebar visual test

`sidebar-visual.jsx` renders the **real** experimental TUI sidebar component
(`plugins/goal-sidebar.tsx`) headlessly with `@opentui/solid`'s `testRender`,
prints each frame, and asserts both the text and the exact foreground
colours / bold attributes from the renderer's span buffer. It is how the
sidebar is visually verified without a live OpenCode TUI.

It is separate from `npm test` because OpenTUI is a runtime peer provided by
OpenCode. Run it locally with `npm run test:visual`; the GitHub CI workflow also
runs it in a Bun/OpenTUI job. The harness itself is not published to npm.

## Run it

Requires [Bun](https://bun.sh) and the OpenTUI stack. From the repo root:

```bash
npm install --no-save @opentui/solid@0.4.1 @opentui/core@0.4.1 solid-js@1.9.12
npm run test:visual
```

If the OpenTUI stack is not installed, the script prints `SKIP` and exits 0.

## What it checks

- Goal set → first-display rainbow text, a bold `Goal todos` label, and a
  `passing/total gates · status` line (no "No goal").
- A running task with **no goal** → the Goal slot returns no content, so OpenCode's
  native todo section can remain in place.
- No guard state at all → no Goal content is rendered (never crashes or shows a stale goal).
- All gates pass + clean tree → `completed · N review cycles` in the status line.
- Custom colour via the `sidebarColor` option.
- Long goals are truncated with an ellipsis.
- Disabled via `sidebarBanner:false` → nothing registers.
- A runtime without `api.slots.register` → no-op, no throw.
- Narrow terminal resize still renders.
