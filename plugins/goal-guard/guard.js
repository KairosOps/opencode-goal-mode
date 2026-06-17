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

import { resolveConfig } from "./config.js";
import { createStore, createState } from "./state.js";
import { createPersistence } from "./persistence.js";
import { createLogger } from "./logger.js";
import { analyzeCommand, looksLikeDestructiveBash, looksLikeMutatingBash, isVerification } from "./shell.js";
import { isPrimaryAgent, isReviewAgent, isGoalAgent, CYCLE_CLOSING_AGENT, prettyAgentName } from "./agents.js";
import { textOf, parseVerdict, recordVerdict } from "./verdicts.js";
import { completionAllowed, missingGates, refreshStickyGates } from "./gates.js";
import { evaluateCompletionClaim } from "./completion.js";
import { evaluateAutoContinue } from "./autocontinue.js";
import { summarizeState } from "./summary.js";
import { buildSystemInjection } from "./system.js";
import { markEdit, markVerification, markFileChanged, maybeClearDirtyOnFinalPass } from "./events.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizedSubagent(input) {
  if (!input) return undefined;
  const agent = String(input.agent || input.args?.subagent_type || "").trim();
  return agent || undefined;
}

function commandOf(input, output) {
  return String(output?.args?.command ?? input?.args?.command ?? "");
}

/** The subagent a `task` call targets (args live on the output in tool.execute.before). */
function taskTarget(input, output) {
  return String(output?.args?.subagent_type ?? input?.args?.subagent_type ?? output?.args?.agent ?? input?.args?.agent ?? "").trim();
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

  // In-memory only (never persisted): coalesce overlapping idle decisions and detect
  // a user turn that starts DURING the grace sleep. Keeping these out of the store
  // means a crash/restart can never wedge auto-continue on a stale "deciding" flag.
  const decidingIdle = new Set(); // sessionIDs currently inside a grace-decision
  const userTurnSeq = new Map(); // sessionID -> monotonic counter, ++ per real user turn
  const bumpUserTurn = (sid) => userTurnSeq.set(sid, (userTurnSeq.get(sid) || 0) + 1);

  const hooks = {
    async "chat.message"(inp, out) {
      try {
        if (!inp?.sessionID) return;
        const state = store.stateFor(inp.sessionID);
        // A genuine new user turn is starting. Mark it (so a continuation decision
        // mid-grace can detect it was superseded) and clear any pending cancel so the
        // guard resumes normal "never stop incomplete" behaviour. The clear is made
        // durable (the SET is persisted, so the CLEAR must be too — otherwise a
        // restart within the suppression window would wrongly keep suppressing).
        bumpUserTurn(inp.sessionID);
        if (state.abortedAt) {
          state.abortedAt = 0;
          persist();
        }
        // `active` reflects whether this session is CURRENTLY a Goal session. Switching
        // the session's agent to Build (or anything non-goal) must deactivate it, or
        // the sidebar/guard would keep treating an explicit Build session as a goal.
        if (inp.agent) state.active = isPrimaryAgent(inp.agent);
        const text = partsText(out?.parts);
        if (text && state.active) {
          // Accumulate goal text (bounded) so contextual gates can be derived.
          state.goalText = `${state.goalText} ${text}`.trim().slice(-8000);
          // Resolve contextual gates eagerly into the sticky set so truncating
          // the rolling buffer later cannot drop an already-required gate.
          refreshStickyGates(state);
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
        // NOTE: do NOT clear abortedAt here. chat.params fires on every LLM call
        // (including intra-turn/aux requests), not only on a genuine new user turn,
        // so clearing here could drop a legitimate pending cancel. The cancel is
        // cleared in chat.message (a real user message) instead.
        // Track the current mode: a session is active (a goal) only while its agent
        // is the goal primary. Switching to Build/Plan/etc. deactivates it so the
        // Goal sidebar and enforcement stop treating it as a goal.
        if (inp.agent) state.active = isPrimaryAgent(inp.agent);
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

      // The goal-* subagents belong to Goal Mode. OpenCode resolves subagents
      // globally, so without this a Build/Plan/custom agent could invoke a Goal
      // reviewer directly. Only a Goal session (the `goal` primary, or a session
      // the guard has already marked active) may spawn them. Non-goal targets
      // (explore/general/scout) are never restricted.
      if (inp?.tool === "task" && config.restrictSubagents) {
        const target = taskTarget(inp, out);
        if (target && isGoalAgent(target)) {
          const caller = state.currentAgent;
          const callerIsGoal = isPrimaryAgent(caller) || state.active;
          if (!callerIsGoal) {
            state.dirtyReasons.push(`blocked non-Goal invocation of subagent ${target}`);
            if (config.toastOnBlock) logger.toast(`Goal Guard blocked ${prettyAgentName(target)} (Goal-only subagent)`, "error");
            persist();
            throw new Error(
              `Goal Guard: "${target}" is a Goal Mode subagent and can only be invoked by the Goal agent. ` +
                `The "${caller || "current"}" agent cannot call it — start with /goal or switch to the goal agent.`,
            );
          }
        }
      }

      if (inp?.tool === "bash") {
        const command = commandOf(inp, out);
        const analysis = analyzeCommand(command);
        const blockDestructive = config.blockDestructive && analysis.destructive;
        const blockNetwork = config.blockNetworkExec && analysis.networkExec;
        if (blockDestructive || blockNetwork) {
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
        // Goal bookkeeping runs only for an active Goal session, or for a REVIEW
        // subagent's own child session (so the agent-path can capture its verdict).
        // It must NOT run for a Build/Plan/custom session, nor for a non-review goal
        // WORKER child session (e.g. goal-implementer/goal-explorer) — otherwise that
        // worker's edits would mark it dirty and activate it, leaking goal completion
        // enforcement into a worker's prompt. Destructive-command blocking lives in
        // tool.execute.before and still applies in every mode.
        if (!state.active && !isReviewAgent(state.currentAgent)) return;
        const tool = inp?.tool;
        const isReviewing = isReviewAgent(state.currentAgent);

        // Edits dirty the session (a read-only reviewer never edits, but guard
        // symmetrically with the bash path so review-time writes don't dirty it).
        if ((tool === "write" || tool === "edit" || tool === "apply_patch") && !isReviewing) {
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

        // Verdict capture. The PRIMARY mechanism is the task path: when the goal
        // agent spawns a reviewer via the task tool, the parent session sees the
        // subagent's result here and the verdict is recorded against the parent
        // goal — correct cross-session attribution. The agent path is a fallback
        // for a reviewer's verdict surfacing in its own session's tool output; it
        // records against that same session (never another), so it can neither
        // mis-credit a sibling session nor break the parent goal, which the task
        // path already covers. Split by tool type so the two never double-count.
        const wasAllowed = completionAllowed(state, config);
        let recordedAgent = null;
        let recordedVerdict = null;
        if (tool === "task") {
          const sub = normalizedSubagent(inp);
          if (isReviewAgent(sub)) {
            const text = textOf(out);
            const verdict = parseVerdict(text);
            if (verdict) {
              recordVerdict(store, state, sub, verdict, text);
              recordedAgent = sub;
              recordedVerdict = verdict;
            }
          }
        } else if (isReviewAgent(state.currentAgent)) {
          const text = textOf(out);
          const verdict = parseVerdict(text);
          if (verdict) {
            recordVerdict(store, state, state.currentAgent, verdict, text);
            recordedAgent = state.currentAgent;
            recordedVerdict = verdict;
          }
        }

        if (recordedAgent === CYCLE_CLOSING_AGENT) {
          maybeClearDirtyOnFinalPass(state, config);
        }

        // Surface review progress in the TUI: a toast per recorded verdict, and a
        // single celebratory toast the moment the last required gate clears.
        if (recordedAgent && recordedVerdict && config.toastOnReview) {
          logger.toast(`${prettyAgentName(recordedAgent)} → ${recordedVerdict}`, recordedVerdict === "PASS" ? "success" : "warning");
          if (!wasAllowed && completionAllowed(state, config)) {
            logger.toast("All required gates passed — completion unlocked", "success");
          }
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
        if (!state.active) return; // only preserve goal state for active Goal sessions
        out.context.push(
          `Goal Guard state: ${summarizeState(state, config)}. Preserve Goal Contract, Verification Ledger, ` +
            `Review Ledger, Reviewer Memory, review cycle count, dirty state, and open findings across compaction.`,
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
          if (!file) return;
          // The event is project-scoped and carries no sessionID, so attribute
          // it to every active goal session in this project (a subagent edit in
          // a child session must still dirty the goal it serves).
          let touched = false;
          for (const st of store.sessions.values()) {
            if (st.active) {
              markFileChanged(store, st, file);
              refreshStickyGates(st);
              touched = true;
            }
          }
          if (touched) persist();
          return;
        }
        if (event.type === "session.error") {
          // A user cancel surfaces as a MessageAbortedError on the session. Flag it
          // so the `session.idle` that immediately follows does NOT auto-continue —
          // the user explicitly stopped, so we send no prompt. (session.error is
          // emitted just before session.idle, verified live.)
          const err = event.properties?.error;
          const sid = event.properties?.sessionID;
          if (sid && err && /abort/i.test(String(err.name || ""))) {
            const key = String(sid).trim();
            const st = key && store.sessions.get(key);
            if (st && st.active) {
              st.abortedAt = Date.now();
              persistence.flush(() => store.snapshot());
              await logger.toast("Goal Mode: turn cancelled — not auto-continuing", "info");
            }
          }
          return;
        }
        if (event.type === "session.idle" && event.properties?.sessionID) {
          const sessionID = event.properties.sessionID;
          const state = store.stateFor(sessionID);
          // Honor a near-simultaneous user cancel regardless of hook delivery order: a
          // cancel emits session.error(MessageAbortedError) and session.idle within
          // milliseconds of each other, but the plugin is not guaranteed to receive
          // the error first. An active goal therefore waits a short grace before
          // deciding, so the abort flag (set by the session.error branch) is visible
          // and the continuation is suppressed. No abort pending → decide immediately.
          if (state.active && config.autoContinue && config.abortGraceMs > 0 && !state.abortedAt) {
            // A single cancel (and bursty idles in general) can emit MORE THAN ONE
            // session.idle. Coalesce: only ONE grace-decision runs per session at a
            // time, so overlapping idles can't each fire a continuation or double-
            // advance the cap / no-progress counters.
            if (decidingIdle.has(sessionID)) return;
            decidingIdle.add(sessionID);
            const turnAtStart = userTurnSeq.get(sessionID) || 0;
            try {
              await sleep(config.abortGraceMs);
            } finally {
              decidingIdle.delete(sessionID);
            }
            // If the user started a NEW turn during the grace (resume, or a fresh
            // prompt), that turn owns the session now — do not inject a stale
            // "keep going" over it.
            if ((userTurnSeq.get(sessionID) || 0) !== turnAtStart) return;
          }
          // Never stop an active goal before it is actually complete: if the session
          // went idle with the goal still incomplete, send the agent onward. Backstops
          // (hard cap + no-progress breaker) live in evaluateAutoContinue so this can
          // never loop forever.
          const decision = evaluateAutoContinue(state, config);
          persistence.flush(() => store.snapshot());
          if (decision.continue) {
            await logger.toast("Goal not complete — continuing automatically", "info");
            await logger.continueSession(sessionID, decision.message);
          } else if (decision.cancelled) {
            // User cancelled this turn — honor it. Send NO prompt; just record it.
            await logger.info("Goal auto-continue suppressed: user cancelled the turn", { sessionID });
          } else if (decision.stopReason) {
            await logger.warn(`Goal Guard paused auto-continue: ${decision.stopReason}`, { state: summarizeState(state, config) });
            await logger.toast(`Goal Mode paused (${decision.stopReason}); review and continue manually`, "warning");
          } else if (state.dirty) {
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
    const { createGoalTools } = await import("./tools.js");
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
