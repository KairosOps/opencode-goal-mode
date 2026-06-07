/**
 * Goal Guard — OpenCode plugin entry point.
 *
 * This thin module wires the focused modules under `goal-guard/` into the
 * OpenCode plugin hooks. All real logic (shell analysis, gating, verdicts,
 * persistence, completion enforcement) lives in those modules and is unit
 * tested in isolation; the entry is just orchestration.
 *
 * Design notes (verified against @opencode-ai/plugin@1.15.13 source):
 *  - State is created PER PLUGIN INSTANCE (no module globals), so concurrent
 *    projects cannot cross-contaminate, and is persisted to the XDG state dir
 *    so it survives OpenCode restarts.
 *  - Destructive bash is blocked by THROWING in `tool.execute.before` (the
 *    `permission.ask` hook is dormant in this version and cannot be relied on).
 *  - `chat.message` captures the goal text that drives contextual review gates;
 *    `file.edited` events catch edits made inside subagent child sessions.
 *  - `experimental.chat.system.transform` injects live gate state into the
 *    prompt; custom `goal_*` tools give the model structured control.
 */

import { resolveConfig } from "./goal-guard/config.js";
import { createStore, createState } from "./goal-guard/state.js";
import { createPersistence } from "./goal-guard/persistence.js";
import { createLogger } from "./goal-guard/logger.js";
import { analyzeCommand, looksLikeDestructiveBash, looksLikeMutatingBash, isVerification } from "./goal-guard/shell.js";
import { isGoalAgent, isReviewAgent, CYCLE_CLOSING_AGENT } from "./goal-guard/agents.js";
import { textOf, parseVerdict, recordVerdict } from "./goal-guard/verdicts.js";
import { completionAllowed, missingGates } from "./goal-guard/gates.js";
import { evaluateCompletionClaim } from "./goal-guard/completion.js";
import { summarizeState } from "./goal-guard/summary.js";
import { buildSystemInjection } from "./goal-guard/system.js";
import { markEdit, markVerification, markFileChanged, maybeClearDirtyOnFinalPass } from "./goal-guard/events.js";

function normalizedSubagent(input) {
  if (!input) return undefined;
  const agent = String(input.agent || input.args?.subagent_type || "").trim();
  return agent || undefined;
}

function commandOf(input, output) {
  return String(output?.args?.command ?? input?.args?.command ?? "");
}

function partsText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && (p.type === "text" || typeof p.text === "string"))
    .map((p) => p.text || "")
    .join(" ")
    .trim();
}

/**
 * Build a guard instance. Exposed for tests; the default export wraps it.
 *
 * @param {object} input  PluginInput ({ client, directory, worktree, ... }).
 * @param {object} options  Plugin options (2nd factory arg).
 * @param {object} overrides  Test seams: { config, store, persistence, env, clock, setTimer, clearTimer }.
 */
export function createGuard(input = {}, options = {}, overrides = {}) {
  const config = overrides.config || resolveConfig(options, overrides.env);
  const store =
    overrides.store ||
    createStore({ maxSessions: config.maxSessions, ttlMs: config.sessionTtlMs, clock: overrides.clock });
  const logger = createLogger(input.client);
  const persistence =
    overrides.persistence ||
    createPersistence({
      worktree: input.worktree || input.directory,
      enabled: config.persist,
      env: overrides.env,
      setTimer: overrides.setTimer,
      clearTimer: overrides.clearTimer,
    });

  // Rehydrate any prior state for this project.
  try {
    const data = persistence.load();
    if (data) store.restore(data);
  } catch {
    /* ignore corrupt state */
  }

  const persist = () => persistence.save(() => store.snapshot());

  /** Find the most-recently-touched active session (to attribute project-wide edits). */
  function activeSession() {
    let best = null;
    let bestTouch = -1;
    for (const st of store.sessions.values()) {
      if (st.active && (st.touchedAt || 0) > bestTouch) {
        bestTouch = st.touchedAt || 0;
        best = st;
      }
    }
    return best;
  }

  const hooks = {
    async "chat.message"(inp, out) {
      try {
        if (!inp?.sessionID) return;
        const state = store.stateFor(inp.sessionID);
        if (isGoalAgent(inp.agent)) state.active = true;
        const text = partsText(out?.parts);
        if (text && state.active) {
          // Accumulate goal text (bounded) so contextual gates can be derived.
          state.goalText = `${state.goalText} ${text}`.trim().slice(-8000);
          persist();
        }
      } catch {
        /* never break a turn */
      }
    },

    async "chat.params"(inp) {
      try {
        if (!inp?.sessionID || typeof inp.sessionID !== "string") return;
        const normalized = inp.sessionID.trim();
        if (!normalized) return;
        const state = store.stateFor(normalized);
        state.currentAgent = inp.agent;
        if (isGoalAgent(inp.agent)) state.active = true;
      } catch {
        /* ignore */
      }
    },

    async "experimental.chat.system.transform"(inp, out) {
      try {
        if (!config.injectSystemState) return;
        if (!inp?.sessionID || !out || !Array.isArray(out.system)) return;
        const state = store.stateFor(inp.sessionID);
        const block = buildSystemInjection(state, config);
        if (block) out.system.push(block);
      } catch {
        /* ignore */
      }
    },

    async "tool.execute.before"(inp, out) {
      const state = store.stateFor(inp?.sessionID);
      if (inp?.tool === "bash") {
        const command = commandOf(inp, out);
        const analysis = analyzeCommand(command);
        const blockDestructive = config.blockDestructive && analysis.destructive;
        const blockNetwork = config.blockNetworkExec && analysis.networkExec;
        if (blockDestructive || blockNetwork) {
          state.active = true;
          state.dirtyReasons.push(`blocked risky bash: ${analysis.reasons.join("; ") || "destructive"}`);
          if (config.toastOnBlock) logger.toast("Goal Guard blocked a destructive command", "error");
          persist();
          throw new Error(
            `Goal Guard blocked a destructive or high-risk bash command (${analysis.reasons.join("; ") || "destructive"}). ` +
              "Use a safer, reversible command or ask the user to confirm.",
          );
        }
      }
    },

    async "tool.execute.after"(inp, out) {
      try {
        const state = store.stateFor(inp?.sessionID);
        const tool = inp?.tool;
        const isReviewing = isReviewAgent(state.currentAgent);

        if (tool === "write" || tool === "edit" || tool === "apply_patch") {
          markEdit(store, state, `${tool} at ${store.nowIso()}`);
        }

        if (tool === "bash") {
          const command = String(inp?.args?.command || "");
          const analysis = analyzeCommand(command);
          if (analysis.verification && !isReviewing) {
            markVerification(store, state);
          }
          if ((analysis.destructive || analysis.mutating) && !isReviewing) {
            markEdit(store, state, `bash mutation: ${analysis.reasons.join("; ") || "mutation"}`);
          }
        }

        // Verdict capture: task path (subagent reviewers) and agent path (the
        // reviewer's own session). The two never apply to the same call because
        // they are split by tool type, so no double counting.
        let recordedAgent = null;
        if (tool === "task") {
          const sub = normalizedSubagent(inp);
          if (isReviewAgent(sub)) {
            const verdict = parseVerdict(textOf(out));
            if (verdict) {
              recordVerdict(store, state, sub, verdict);
              recordedAgent = sub;
            }
          }
        } else if (isReviewAgent(state.currentAgent)) {
          const verdict = parseVerdict(textOf(out));
          if (verdict) {
            recordVerdict(store, state, state.currentAgent, verdict);
            recordedAgent = state.currentAgent;
          }
        }

        if (recordedAgent === CYCLE_CLOSING_AGENT) {
          maybeClearDirtyOnFinalPass(state, config);
        }
        persist();
      } catch {
        /* never break a turn */
      }
    },

    async "experimental.text.complete"(inp, out) {
      try {
        if (!config.enforceCompletion) return;
        if (!inp?.sessionID || !out || typeof out.text !== "string") return;
        const state = store.stateFor(inp.sessionID);
        const decision = evaluateCompletionClaim(state, config, out.text);
        if (decision.blocked) {
          state.completedBlocked += 1;
          state.lastCompletionRejectAt = store.nowIso();
          state.completionRejections.push({ at: state.lastCompletionRejectAt, reason: decision.reason });
          out.text = decision.replacement;
          if (config.toastOnBlock) logger.toast(`Goal Guard blocked premature completion: ${decision.reason}`, "warning");
          persist();
        }
      } catch {
        /* ignore */
      }
    },

    async "experimental.session.compacting"(inp, out) {
      try {
        if (!inp?.sessionID || !out || !Array.isArray(out.context)) return;
        const state = store.stateFor(inp.sessionID);
        out.context.push(
          `Goal Guard state: ${summarizeState(state, config)}. Preserve Goal Contract, Verification Ledger, ` +
            `Review Ledger, review cycle count, dirty state, and open findings across compaction.`,
        );
      } catch {
        /* ignore */
      }
    },

    async event({ event } = {}) {
      try {
        if (!event) return;
        if (event.type === "file.edited") {
          const file = event.properties?.file || event.properties?.path || event.properties?.filename;
          const target = activeSession();
          if (target && file) {
            markFileChanged(store, target, file);
            persist();
          }
          return;
        }
        if (event.type === "session.idle" && event.properties?.sessionID) {
          const state = store.stateFor(event.properties.sessionID);
          persistence.flush(() => store.snapshot());
          if (state.dirty) {
            await logger.warn("Goal session idle while dirty or review-stale", { state: summarizeState(state, config) });
          }
        }
      } catch {
        /* ignore */
      }
    },

    async dispose() {
      try {
        persistence.flush(() => store.snapshot());
      } catch {
        /* ignore */
      }
    },
  };

  return { hooks, store, config, persistence, logger, persist };
}

/** OpenCode plugin factory (default export). */
export async function GoalGuardPlugin(input, options) {
  const guard = createGuard(input || {}, options || {});
  // Register custom goal_* tools, isolated so a resolution failure of
  // @opencode-ai/plugin cannot prevent the core guard hooks from loading.
  try {
    const { createGoalTools } = await import("./goal-guard/tools.js");
    guard.hooks.tool = createGoalTools({ store: guard.store, config: guard.config, persist: guard.persist });
  } catch {
    /* tools are optional */
  }
  return guard.hooks;
}

export default GoalGuardPlugin;

/** Stable test surface. */
export const __test = {
  createGuard,
  createStore,
  createState,
  resolveConfig,
  analyzeCommand,
  looksLikeDestructiveBash,
  looksLikeMutatingBash,
  isVerification,
  summarizeState,
  completionAllowed,
  missingGates,
};
