/** @jsxImportSource @opentui/solid */
/**
 * Goal Mode — TUI sidebar todo section.
 *
 * In Goal agent sessions this renders a Goal-owned, evidence-aware todo section
 * into the sidebar_content slot (GOAL label, goal title, gate/status line, and
 * structured todo rows). OpenCode renders the native todo list as that slot's
 * fallback, so in replace/single-winner slot mode this REPLACES the native todos
 * while a goal is active; rendering nothing (non-Goal or no-goal sessions) brings
 * the native todos back. The section is strictly per-session: it is keyed by
 * props.session_id, so a Build session in the same worktree never inherits
 * another session's goal.
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

const DEFAULT_COLOR = "#FFD700"; // running — GOAL label, yellow
const DEFAULT_DONE = "#FF5555"; // done — red
const DEFAULT_MUTED = "#808080"; // pending todo rows — grey
const TITLE_COLOR = "#FFFFFF"; // goal title line (running) — bright, distinct from the yellow GOAL label
const META_COLOR = "#8BE9FD"; // gates line (running) — cyan accent
const STATUS_COLOR = "#FFB86C"; // status line (running) — orange, distinct from the cyan gates line
const TODO_DONE_COLOR = "#50FA7B"; // ✓ done todo rows — green
const POLL_MS = 1500;
const GOAL_AGENT = "goal"; // the primary Goal agent id (mirrors agents.js PRIMARY_AGENT)

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

/**
 * Resolve the guard state for EXACTLY this session id, and only when it is an
 * active Goal session. There is deliberately NO "most-recently-touched" global
 * fallback: a Build or other session in the same worktree must never inherit a
 * Goal from a sibling session. (Mirrors the reference OpenCode TUI plugin's
 * explicit per-session rule — do not fall back to the latest state.)
 */
function pickSession(snapshot, sessionId) {
  if (!snapshot || !Array.isArray(snapshot.sessions) || !sessionId) return null;
  for (const entry of snapshot.sessions) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, st] = entry;
    if (key === sessionId && st && typeof st === "object" && st.active) return st;
  }
  return null;
}

/**
 * Resolve the sidebar model for a session, trying each candidate worktree key in
 * turn. The guard persists keyed by `worktree || directory`; the TUI may surface
 * either path, so we try both (worktree first) rather than risk a key mismatch
 * that would hide an active goal and leave the native todos showing.
 */
function readModel(worktrees, sessionId) {
  const keys = (Array.isArray(worktrees) ? worktrees : [worktrees]).filter(Boolean);
  for (const wt of keys) {
    try {
      const snapshot = readSnapshot(wt);
      if (!snapshot) continue;
      const record = pickSession(snapshot, sessionId);
      if (!record) continue;
      // Evaluate completion with the SAME config the server resolved (persisted in the
      // snapshot), so a non-default `contextualGates` can't make the sidebar disagree
      // with the server. Fall back to defaults for older snapshots without `config`.
      const cfg = snapshot.config && typeof snapshot.config === "object" ? { ...DEFAULT_CONFIG, ...snapshot.config } : DEFAULT_CONFIG;
      const view = sidebarView(record, cfg);
      if (view && view.state !== "none") return view;
    } catch {
      /* try the next candidate */
    }
  }
  return NO_GOAL;
}

const id = "goal-mode-sidebar";

/** @type {import("@opencode-ai/plugin/tui").TuiPlugin} */
const tui = async (api, options) => {
  try {
    const { enabled, color, doneColor, muted } = resolveOptions(options, typeof process !== "undefined" ? process.env : {});
    if (!enabled) return;
    if (!api?.slots?.register) return; // runtime without the slot API → no-op.

    // The guard keys persisted state by worktree (falling back to directory).
    // Surface both so a path-key mismatch can't hide an active goal.
    const worktrees = [api.state?.path?.worktree, api.state?.path?.directory];

    api.slots.register({
        order: 50,
        slots: {
          sidebar_content(_ctx, props) {
            if (!props?.session_id) return undefined;
            // The session's CURRENT agent, from its latest message (mirrors the
            // reference OpenCode TUI plugin). This is the authoritative, immediate
            // signal of whether the session is in Goal mode right now — so when the
            // user switches to Build (or any non-goal agent) the Goal section vanishes
            // and OpenCode's native todos return, without waiting for persisted state.
            const currentAgent = () => {
              try {
                const msgs = api?.state?.session?.messages?.(props.session_id);
                if (Array.isArray(msgs)) {
                  for (let i = msgs.length - 1; i >= 0; i--) {
                    const a = msgs[i] && msgs[i].agent;
                    if (a) return String(a).toLowerCase();
                  }
                }
              } catch {
                /* messages API unavailable — fall back to persisted goal state */
              }
              return undefined;
            };
            const read = () => {
              try {
                const agent = currentAgent();
                // Render only in Goal mode. "goal" and its `goal-*` subagents count as
                // Goal mode (so the section doesn't flicker out while reviewers run);
                // any other primary agent (build/plan/custom) renders nothing here.
                const goalMode = !agent || agent === GOAL_AGENT || agent.startsWith(`${GOAL_AGENT}-`);
                if (!goalMode) return NO_GOAL;
                return readModel(worktrees, props?.session_id) || NO_GOAL;
              } catch {
                return NO_GOAL;
              }
            };
            // ALWAYS mount a reactive, polling component — do NOT bail when there is
            // no goal yet. The goal is normally recorded AFTER the sidebar mounts
            // (the user opens the session, then states the goal), so the slot must
            // keep polling and let <Show> reveal the section when the goal appears.
            // Returning undefined at mount (the old behavior) meant the poll never
            // ran and the Goal section never showed even once a goal existed.
            const first = read();
            // equals:false → every refresh re-notifies, so a changed snapshot always
            // repaints (gates/todos stay live even when the new object compares equal).
            const [model, setModel] = createSignal(first, { equals: false });
            const refresh = () => setModel(read());
            // Refresh on OpenCode activity. Tool calls (verdicts, evidence, edits)
            // change the gates/todos and emit message-part events, so subscribing here
            // keeps the section up to date promptly — this is the mechanism the
            // reference OpenCode TUI plugin uses. The interval is a fallback for any
            // quiet period or runtime where the event bus is unavailable.
            const offs = [];
            try {
              const bus = api && api.event;
              if (bus && typeof bus.on === "function") {
                for (const ev of ["message.part.updated", "message.updated", "session.idle"]) {
                  try {
                    const off = bus.on(ev, refresh);
                    if (typeof off === "function") offs.push(off);
                  } catch {
                    /* unknown event type on this OpenCode build — skip it */
                  }
                }
              }
            } catch {
              /* no event bus — rely on the interval */
            }
            const timer = setInterval(refresh, POLL_MS);
            onCleanup(() => clearInterval(timer));
            onCleanup(() => {
              for (const off of offs) {
                try {
                  off();
                } catch {
                  /* ignore */
                }
              }
            });
            // Per-line colour. When done, every line is red; while running each
            // header line gets its OWN highlight colour so the GOAL label, the goal
            // title, the gate count, and the status never read as one block of text.
            const lineColor = (kind) => {
              if (model().state === "done") return doneColor;
              if (kind === "label") return color; // GOAL — yellow
              if (kind === "title") return TITLE_COLOR; // goal title — bright white
              if (kind === "gates") return META_COLOR; // gate count — cyan
              return STATUS_COLOR; // lifecycle status — orange
            };
            const todoColor = (item) => {
              if (item.status === "done") return TODO_DONE_COLOR;
              return model().state === "done" ? doneColor : muted;
            };
            // Goal sessions render a Goal-owned todo section — GOAL label, goal title,
            // gate count, lifecycle status, then structured todos — EACH on its own
            // line in its own colour. Non-Goal / no-goal sessions returned undefined
            // above, so the native todo section shows instead.
            return (
              <Show when={model().state !== "none"}>
                <box flexDirection="column" paddingTop={1}>
                  <text fg={lineColor("label")}><b>{model().label || "GOAL"}</b></text>
                  <text fg={lineColor("title")}>{model().goal}</text>
                  <text fg={lineColor("gates")}>{model().gates}</text>
                  <text fg={lineColor("status")}>{model().status}</text>
                  <For each={model().todos || []}>
                    {(item) => <text fg={todoColor(item)}>{`${item.status === "done" ? "✓" : "□"} ${item.text}`}</text>}
                  </For>
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
