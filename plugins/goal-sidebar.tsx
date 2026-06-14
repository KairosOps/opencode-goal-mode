/** @jsxImportSource @opentui/solid */
/**
 * Goal Mode — TUI sidebar todo section.
 *
 * In Goal agent sessions this replaces the native-looking todo area with a
 * Goal-owned, evidence-aware todo section. Non-Goal sessions render nothing here
 * so Build and other modes keep OpenCode's normal todo section in the same slot.
 *
 * How OpenCode loads this: TUI plugins are listed in `~/.config/opencode/tui.json`
 * (NOT the plugins/ dir) and resolved via the package's `exports["./tui"]`. The
 * installer writes tui.json (`plugin: ["opencode-goal-mode"]`); package.json maps
 * `./tui` → this file; OpenCode supplies the `@opentui/solid` + `solid-js` runtime
 * (declared as peer deps). The pure projection (`summary.sidebarView`) is shared
 * with the server plugin and unit-tested via goal-guard/sidebar-data.js.
 *
 * Runtime notes: single `export default { id, tui }`; node built-ins are require()d
 * lazily (the Bun TUI runtime rejects top-level node: imports). Never imported by
 * the Node test suite.
 */

import { createSignal, onCleanup, For, Show } from "solid-js";
import { sidebarView, NO_GOAL } from "./goal-guard/summary.js";
import { DEFAULT_CONFIG } from "./goal-guard/config.js";

const DEFAULT_COLOR = "#FFD700"; // running — yellow
const DEFAULT_DONE = "#FF5555"; // done — red
const DEFAULT_MUTED = "#808080"; // no goal — grey
const POLL_MS = 1500;
const RAINBOW = ["#FF5555", "#FFAA00", "#FFFF55", "#55FF55", "#55FFFF", "#5599FF", "#FF55FF"];

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
    rainbowMs: Number(options?.sidebarRainbowMs ?? e.GOAL_GUARD_SIDEBAR_RAINBOW_MS ?? 4500),
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
    return null;
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
    const { enabled, color, doneColor, rainbowMs } = resolveOptions(options, typeof process !== "undefined" ? process.env : {});
    if (!enabled) return;
    if (!api?.slots?.register) return; // runtime without the slot API → no-op.

    const worktree = api.state?.path?.worktree || api.state?.path?.directory;

    let registered = false;
    const register = () => {
      if (registered) return;
      registered = true;
      api.slots.register({
        order: 50,
        slots: {
          sidebar_content(_ctx, props) {
            if (!props?.session_id) return undefined;
            const read = () => {
              try {
                return readModel(worktree, props?.session_id) || NO_GOAL;
              } catch {
                return NO_GOAL;
              }
            };
            const initial = read();
            if (initial.state === "none") return undefined;
            const [model, setModel] = createSignal(initial);
            const [rainbow, setRainbow] = createSignal((rainbowMs || 0) > 0);
            const timer = setInterval(() => setModel(read()), POLL_MS);
            const rainbowTimer = setTimeout(() => setRainbow(false), Math.max(0, rainbowMs || 0));
            onCleanup(() => clearInterval(timer));
            onCleanup(() => clearTimeout(rainbowTimer));
            const fg = () => (model().state === "done" ? doneColor : color);
            const lineColor = (index = 0) => (rainbow() && model().state === "running" ? RAINBOW[index % RAINBOW.length] : fg());
            // Goal sessions render a Goal-owned todo section; non-Goal sessions return undefined so native todos remain.
            return (
              <Show when={model().state !== "none"}>
                <box flexDirection="column" paddingTop={1}>
                  <text fg={lineColor(0)}>
                    <b>{model().todoTitle || "Goal todos"}</b>
                    {`  ${model().goal}`}
                  </text>
                  <text fg={lineColor(1)}>{`${model().gates} · ${model().status}`}</text>
                  <For each={model().todos || []}>
                    {(item, index) => <text fg={lineColor(index() + 2)}>{`${item.status === "done" ? "✓" : "□"} ${item.text}`}</text>}
                  </For>
                </box>
              </Show>
            );
          },
        },
      });
    };

    if (readModel(worktree).state !== "none") {
      register();
    } else {
      const registrationTimer = setInterval(() => {
        if (readModel(worktree).state !== "none") {
          clearInterval(registrationTimer);
          register();
        }
      }, POLL_MS);
    }
  } catch {
    /* TUI runtime missing or API drift — render nothing rather than crash. */
  }
};

export default { id, tui };
