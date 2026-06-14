/** @jsxImportSource @opentui/solid */
/**
 * Goal Mode — experimental TUI sidebar banner.
 *
 * EXPERIMENTAL. This is a TUI plugin module (the companion to the server-side
 * goal-guard plugin). It renders the current goal as a short, shining-yellow
 * banner in the OpenCode sidebar, with a compact `passing/total gates ·
 * dirty/ready` status line, and updates as reviews land.
 *
 * It only does anything inside a TUI-plugin-capable OpenCode (one exposing
 * `api.slots.register`). On any older runtime, missing API, or render error it
 * silently no-ops — it can never break your TUI.
 *
 * Pairing: it reads the SAME on-disk snapshot the goal-guard server plugin
 * writes (see goal-guard/persistence.js), so the two stay in sync with no extra
 * IPC. The pure projection (`summary.sidebarView`) is shared with the server
 * plugin and unit-tested via goal-guard/sidebar-data.js; only the file read and
 * state-path computation are reimplemented here.
 *
 * Runtime constraints (mirrored from working OpenCode TUI plugins):
 *  - TUI plugin modules export `export default { id, tui }`.
 *  - The Bun TUI plugin runtime does NOT support top-level ESM imports of Node
 *    built-ins, so `node:fs`/`node:path`/`node:os`/`node:crypto` are `require()`d
 *    lazily inside functions. Top-level imports of regular packages (solid-js)
 *    and of our Node-built-in-free local modules are fine.
 *  - This file uses Solid/opentui JSX and is loaded only by OpenCode's (Bun) TUI
 *    runtime, which transpiles it; it is never imported by the Node test suite.
 */

import { createSignal, onCleanup, Show } from "solid-js";
import { sidebarView } from "./goal-guard/summary.js";
import { DEFAULT_CONFIG } from "./goal-guard/config.js";

const DEFAULT_COLOR = "#FFD700"; // shining yellow
const POLL_MS = 1500;

function resolveOptions(options, env) {
  const e = env || {};
  const enabledOpt = options?.sidebarBanner;
  const enabledEnv = e.GOAL_GUARD_SIDEBAR_BANNER;
  const disabled =
    enabledOpt === false || enabledEnv === "0" || enabledEnv === "false" || enabledEnv === "off";
  const color = options?.sidebarColor || e.GOAL_GUARD_SIDEBAR_COLOR || DEFAULT_COLOR;
  return { enabled: !disabled, color };
}

/**
 * Read the guard's persisted snapshot for a worktree. The state-path logic is
 * kept identical to goal-guard/persistence.js (stateBaseDir + projectKey); node
 * built-ins are required lazily to satisfy the TUI runtime.
 */
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
  const snapshot = readSnapshot(worktree);
  if (!snapshot) return null;
  const record = pickSession(snapshot, sessionId);
  if (!record) return null;
  try {
    return sidebarView(record, DEFAULT_CONFIG);
  } catch {
    return null;
  }
}

export const id = "goal-mode-sidebar";

/** @type {import("@opencode-ai/plugin/tui").TuiPlugin} */
export const tui = async (api, options) => {
  try {
    const { enabled, color } = resolveOptions(options, typeof process !== "undefined" ? process.env : {});
    if (!enabled) return;
    if (!api?.slots?.register) return; // runtime without the slot API → no-op.

    const worktree = api.state?.path?.worktree || api.state?.path?.directory;

    api.slots.register({
      order: 50,
      slots: {
        sidebar_content(_ctx, props) {
          const read = () => {
            try {
              return readModel(worktree, props?.session_id);
            } catch {
              return null;
            }
          };
          const [model, setModel] = createSignal(read());
          const timer = setInterval(() => setModel(read()), POLL_MS);
          onCleanup(() => clearInterval(timer));
          return (
            <Show when={model()}>
              <box flexDirection="column">
                <text fg={color}>
                  {"◆ "}
                  <b>GOAL</b>
                  {`  ${model().goal}`}
                </text>
                <text fg={color}>{model().status}</text>
              </box>
            </Show>
          );
        },
      },
    });
  } catch {
    /* TUI runtime missing or API drift — render nothing rather than crash. */
  }
};

export default { id, tui };
