/** @jsxImportSource @opentui/solid */
/**
 * Goal Mode — TUI sidebar goal banner.
 *
 * This is a TUI plugin module (companion to the server-side goal-guard plugin).
 * It renders, in the sidebar's content area, the current goal with generated
 * status text and a colour that tracks the goal's lifecycle:
 *   - RUNNING (goal set, in progress)        → yellow
 *   - DONE    (all required gates pass, clean) → red
 *   - NONE    (a task is running, no goal set) → grey "No goal available"
 *
 * IMPORTANT — how OpenCode loads this: TUI plugins are NOT loaded from the
 * regular `plugin` array / plugins dir (that is server plugins). They are listed
 * in `~/.config/opencode/tui.json`:
 *     { "$schema": "https://opencode.ai/tui.json", "plugin": ["opencode-goal-mode"] }
 * The installer writes that automatically. OpenCode then loads this module
 * (the package `main`) and provides the `@opentui/solid` + `solid-js` runtime
 * (declared here as peer deps), so its slot shares OpenCode's renderer.
 *
 * Runtime constraints (from working OpenCode TUI plugins):
 *  - the module exports a single `export default { id, tui }`;
 *  - the Bun TUI runtime does not support top-level ESM imports of Node built-ins,
 *    so node:fs/path/os/crypto are require()d lazily inside functions;
 *  - it is never imported by the Node test suite (the pure projection it uses,
 *    summary.sidebarView, is tested via goal-guard/sidebar-data.js).
 */

import { createSignal, onCleanup, Show } from "solid-js";
import { sidebarView, NO_GOAL } from "./goal-guard/summary.js";
import { DEFAULT_CONFIG } from "./goal-guard/config.js";

const DEFAULT_COLOR = "#FFD700"; // shining yellow — running
const DEFAULT_DONE = "#FF5555"; // red — completed
const DEFAULT_MUTED = "#808080"; // grey — no goal
const POLL_MS = 1500;

function resolveOptions(options, env) {
  const e = env || {};
  const enabledOpt = options?.sidebarBanner;
  const enabledEnv = e.GOAL_GUARD_SIDEBAR_BANNER;
  const disabled =
    enabledOpt === false || enabledEnv === "0" || enabledEnv === "false" || enabledEnv === "off";
  return {
    enabled: !disabled,
    color: options?.sidebarColor || e.GOAL_GUARD_SIDEBAR_COLOR || DEFAULT_COLOR,
    doneColor: options?.sidebarDoneColor || e.GOAL_GUARD_SIDEBAR_DONE_COLOR || DEFAULT_DONE,
    muted: options?.sidebarMutedColor || e.GOAL_GUARD_SIDEBAR_MUTED_COLOR || DEFAULT_MUTED,
  };
}

/** Read the guard's persisted snapshot for a worktree (path logic mirrors persistence.js). */
function readSnapshot(worktree) {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const crypto = require("node:crypto");
    const xdg = process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.trim();
    const base = xdg || path.join(os.homedir(), ".local", "state");
    const key = crypto.createHash("sha256").update(String(worktree || "default")).digest("hex").slice(0, 16);
    const file = path.join(base, "opencode", "goal-guard", `${key}.json`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Most-recently-touched active session, preferring an explicit active sessionId. */
function pickSession(snapshot, sessionId) {
  if (!snapshot || !Array.isArray(snapshot.sessions)) return null;
  const records = snapshot.sessions
    .filter((e) => Array.isArray(e) && e.length === 2)
    .map(([key, st]) => [key, st && typeof st === "object" ? st : {}]);
  if (sessionId) {
    const direct = records.find(([key, st]) => key === sessionId && st.active);
    if (direct) return direct[1];
  }
  const active = records.filter(([, st]) => st.active);
  if (active.length === 0) return null;
  active.sort((a, b) => (b[1].touchedAt || 0) - (a[1].touchedAt || 0));
  return active[0][1];
}

function readModel(worktree, sessionId) {
  try {
    const snapshot = readSnapshot(worktree);
    if (!snapshot) return NO_GOAL;
    const record = pickSession(snapshot, sessionId);
    if (!record) return NO_GOAL;
    return sidebarView(record, DEFAULT_CONFIG);
  } catch {
    return NO_GOAL;
  }
}

const id = "goal-mode-sidebar";

/** @type {import("@opencode-ai/plugin/tui").TuiPlugin} */
const tui = async (api, options) => {
  try {
    const { enabled, color, doneColor, muted } = resolveOptions(options, typeof process !== "undefined" ? process.env : {});
    if (!enabled) return;
    if (!api?.slots?.register) return; // runtime without the slot API → no-op.

    const worktree = api.state?.path?.worktree || api.state?.path?.directory;

    api.slots.register({
      order: 50,
      slots: {
        sidebar_content(_ctx, props) {
          const read = () => {
            try {
              return readModel(worktree, props?.session_id) || NO_GOAL;
            } catch {
              return NO_GOAL;
            }
          };
          const [model, setModel] = createSignal(read());
          const timer = setInterval(() => setModel(read()), POLL_MS);
          onCleanup(() => clearInterval(timer));
          const fg = () => (model().state === "done" ? doneColor : color);
          // Always render: grey "No goal available" when none, else the goal in
          // yellow (running) / red (done) with generated status text.
          return (
            <box flexDirection="column" paddingTop={1}>
              <Show
                when={model().state !== "none"}
                fallback={<text fg={muted}>No goal available</text>}
              >
                <text fg={fg()}>
                  {model().state === "done" ? "✓ " : "◆ "}
                  <b>GOAL</b>
                  {`  ${model().goal}`}
                </text>
                <text fg={fg()}>{model().detail}</text>
              </Show>
            </box>
          );
        },
      },
    });
  } catch {
    /* TUI runtime missing or API drift — render nothing rather than crash. */
  }
};

export default { id, tui };
