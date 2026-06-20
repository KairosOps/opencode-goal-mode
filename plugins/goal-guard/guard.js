/**
 * Goal Guard — OpenCode plugin entry point.
 *
 * This thin module wires the focused modules under `goal-guard/` into the
 * OpenCode plugin hooks. All real logic (shell analysis, gating, verdicts,
 * persistence, completion enforcement) lives in those modules and is unit
 * tested in isolation; the entry is just orchestration.
 *
 * Design notes (verified against the @opencode-ai/plugin hook surface, peer range
 * >=1.15.0, pinned in devDependencies to 1.17.6):
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
import { createLogger, isSyntheticUserTurn } from "./logger.js";
import { analyzeCommand, looksLikeDestructiveBash, looksLikeMutatingBash, isVerification } from "./shell.js";
import { isPrimaryAgent, isReviewAgent, isGoalAgent, goalSessionActiveForAgent, CYCLE_CLOSING_AGENT, prettyAgentName } from "./agents.js";
import { textOf, parseVerdict, recordVerdict } from "./verdicts.js";
import { completionAllowed, missingGates, refreshStickyGates } from "./gates.js";
import { evaluateCompletionClaim } from "./completion.js";
import { evaluateAutoContinue } from "./autocontinue.js";
import { summarizeState } from "./summary.js";
import { buildSystemInjection } from "./system.js";
import { markEdit, markVerification, markFileChanged, maybeClearDirtyOnFinalPass, maybeAutoSeedContract } from "./events.js";
import { runReviewCycle, clientCanReview, ensureReviewClient, isSessionBusyError } from "./review-runner.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EDIT_TOOLS = new Set(["write", "edit", "apply_patch", "patch", "str_replace", "create_file"]);

function isEditTool(tool) {
  return EDIT_TOOLS.has(String(tool || ""));
}

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
  const reviewClient = overrides.reviewClient || input.client;

  // In-memory only (never persisted): coalesce overlapping idle decisions, detect a
  // user turn that starts DURING the grace sleep, and attribute project-scoped
  // file.edited events to the goal session whose turn is actually in flight. Keeping
  // these out of the store means a crash/restart can never wedge auto-continue, and
  // they are pruned with the session via the store's onEvict so they never leak.
  const decidingIdle = new Set(); // sessionIDs currently inside an idle decision
  const reviewingSessions = new Set(); // sessionIDs currently inside a programmatic review run
  const idleReviewRetries = new Map(); // sessionID -> retry count for SessionBusy deferrals
  const idleReviewTimers = new Map(); // sessionID -> scheduled retry timer
  const userTurnSeq = new Map(); // sessionID -> monotonic counter, ++ per real user turn
  const bumpUserTurn = (sid) => userTurnSeq.set(sid, (userTurnSeq.get(sid) || 0) + 1);
  const sessionModel = new Map(); // sessionID -> { providerID, modelID } of the goal's model, so the
  // guard can launch the review subagents on the SAME model the agent is using.
  let lastActiveGoalSession = null; // sessionID of the most-recent active goal turn

  /** Capture the goal session's model so programmatic reviews use the same one. */
  const captureModel = (sid, model) => {
    if (!sid || !model) return;
    const providerID = model.providerID || model.provider?.id || model.provider;
    const modelID = model.modelID || model.id || model.model;
    if (providerID && modelID) sessionModel.set(String(sid).trim(), { providerID, modelID });
  };

  const store =
    overrides.store ||
    createStore({
      maxSessions: config.maxSessions,
      ttlMs: config.sessionTtlMs,
      clock: overrides.clock,
      onEvict: (key) => {
        userTurnSeq.delete(key);
        decidingIdle.delete(key);
        reviewingSessions.delete(key);
        sessionModel.delete(key);
        idleReviewRetries.delete(key);
        const t = idleReviewTimers.get(key);
        if (t) {
          clearTimeout(t);
          idleReviewTimers.delete(key);
        }
        if (lastActiveGoalSession === key) lastActiveGoalSession = null;
      },
    });
  const logger = createLogger(reviewClient, config);
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

  // Persist the resolved config alongside the sessions so the TUI sidebar (which reads
  // only the on-disk snapshot) evaluates completion with the SAME config the server
  // used — otherwise a non-default `contextualGates` would make the sidebar disagree
  // with the server (e.g. show a finished goal as perpetually running). restore()
  // ignores the extra top-level key, so this is backward/forward compatible.
  const snapshotFn = () => {
    const snap = store.snapshot();
    snap.config = config;
    return snap;
  };
  const persist = () => persistence.save(snapshotFn);

  const syncIdle = overrides.syncIdle === true;
  const scheduleFn = overrides.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimerFn = overrides.clearTimer || clearTimeout;

  const scheduleIdleReviewRetry = (sessionID) => {
    if (idleReviewTimers.has(sessionID)) return false;
    const attempt = (idleReviewRetries.get(sessionID) || 0) + 1;
    if (attempt > config.maxReviewIdleRetries) {
      idleReviewRetries.delete(sessionID);
      return false;
    }
    idleReviewRetries.set(sessionID, attempt);
    const timer = scheduleFn(() => {
      idleReviewTimers.delete(sessionID);
      decidingIdle.add(sessionID);
      void resolveIdleSession(sessionID).catch((err) => {
        logger.warn("Goal idle review retry failed", { sessionID, error: String(err?.message || err) });
      });
    }, Math.max(config.reviewIdleRetryMs, 1));
    idleReviewTimers.set(sessionID, timer);
    return true;
  };

  /** Async idle resolution — must NOT run inline inside the `event` hook (see session.idle). */
  async function resolveIdleSession(sessionID) {
    try {
      const state = store.stateFor(sessionID);
      if (state.active && config.autoContinue && config.abortGraceMs > 0 && !state.abortedAt) {
        const turnAtStart = userTurnSeq.get(sessionID) || 0;
        await sleep(config.abortGraceMs);
        if ((userTurnSeq.get(sessionID) || 0) !== turnAtStart) return;
      }
      const model = sessionModel.get(sessionID);
      const hasWork =
        state.dirty ||
        (state.lastEditSeq || 0) > 0 ||
        state.verificationSeen ||
        (Array.isArray(state.evidence) && state.evidence.length > 0) ||
        (Array.isArray(state.changedFiles) && state.changedFiles.length > 0);
      const goalSession =
        state.active ||
        Boolean(state.contract) ||
        goalSessionActiveForAgent("goal", state);
      const outstandingGates = missingGates(state, config).length;
      const anchoredContract = Boolean(state.contract) && !state.contract?.auto;
      const canProgrammaticReview =
        config.programmaticReview &&
        goalSession &&
        (hasWork || (anchoredContract && outstandingGates > 0)) &&
        clientCanReview(reviewClient) &&
        !completionAllowed(state, config);

      const decision = evaluateAutoContinue(state, config);
      persistence.flush(snapshotFn);

      if (decision.cancelled) {
        await logger.info("Goal auto-continue suppressed: user cancelled the turn", { sessionID });
      } else if (state.abortedAt) {
        await logger.info("Goal auto-continue suppressed: user cancelled the turn", { sessionID });
      } else if (canProgrammaticReview) {
        if ((state.reviewRunCount || 0) >= config.maxReviewCycles) {
          await logger.warn(`Goal paused: reached maxReviewCycles=${config.maxReviewCycles} review runs`, { state: summarizeState(state, config) });
          await logger.toast(`Goal Mode paused (${config.maxReviewCycles} review cycles) — review manually`, "warning");
        } else {
          await logger.toast(`Goal: running required reviews…`, "info");
          const turnBeforeReview = userTurnSeq.get(sessionID) || 0;
          let res = null;
          reviewingSessions.add(sessionID);
          try {
            if (config.reviewIdleDeferMs > 0) await sleep(config.reviewIdleDeferMs);
            res = await runReviewCycle(reviewClient, store, state, config, {
              sessionID,
              model,
              log: (m) => logger.info(m, { sessionID }),
              timeoutMs: config.reviewTimeoutMs,
              pollMs: config.reviewPollMs,
              idleDeferMs: 0,
              sleep: overrides.reviewSleep || undefined,
            });
          } catch (err) {
            await logger.warn("Programmatic review run failed", { error: String(err?.message || err) });
            if (isSessionBusyError(err) && scheduleIdleReviewRetry(sessionID)) {
              await logger.info("Session still busy — scheduling programmatic review retry", { sessionID });
              return;
            }
          } finally {
            reviewingSessions.delete(sessionID);
          }
          if (res?.sessionBusy && scheduleIdleReviewRetry(sessionID)) {
            await logger.info("Session still busy — scheduling programmatic review retry", { sessionID });
            return;
          }
          idleReviewRetries.delete(sessionID);
          if (res?.ran?.length) {
            state.reviewRunCount = (state.reviewRunCount || 0) + 1;
            await logger.toast(`Goal: running required reviews (cycle ${state.reviewRunCount})…`, "info");
          }
          persistence.flush(snapshotFn);
          if ((userTurnSeq.get(sessionID) || 0) !== turnBeforeReview) {
            /* user resumed during review — do not override */
          } else if (state.abortedAt) {
            await logger.info("Goal auto-continue suppressed: user cancelled during the review run", { sessionID });
          } else if (res && res.completionAllowed) {
            await logger.toast(`All required reviews PASSED — ${res.reviewCycles} review cycle${res.reviewCycles === 1 ? "" : "s"}`, "success");
            await logger.emitGoalCompleted(sessionID, res.reviewCycles, model);
          } else if (res && res.failed.length) {
            const findings = res.findings.length ? ` Blocking findings: ${res.findings.join(" | ")}.` : "";
            await logger.toast(`Review cycle ${res.reviewCycles}: ${res.failed.map(prettyAgentName).join(", ") || "issues found"} → fix & re-review`, "warning");
            await logger.guardPrompt(
              sessionID,
              `Review cycle #${res.reviewCycles} found blocking issues — fix them now, then stop.${findings} ` +
                `Failing reviewers: ${res.failed.join(", ")}. Do NOT claim completion; the guard will re-run every required review on the next idle.`,
              model,
            );
          } else {
            await logger.guardPrompt(
              sessionID,
              "Programmatic review did not finish cleanly. Fix any outstanding issues, verify your work, and stop — the guard will re-run the required reviews automatically.",
              model,
            );
          }
        }
      } else if (decision.stopReason) {
        await logger.warn(`Goal Guard paused auto-continue: ${decision.stopReason}`, { state: summarizeState(state, config) });
        await logger.toast(`Goal Mode paused (${decision.stopReason}); review and continue manually`, "warning");
      } else if (decision.continue) {
        await logger.toast("Goal not complete — continuing automatically", "info");
        await logger.guardPrompt(sessionID, decision.message, model);
      } else if (state.dirty && state.active) {
        await logger.warn("Goal session idle while dirty or review-stale", { state: summarizeState(state, config) });
      }
    } finally {
      decidingIdle.delete(sessionID);
    }
  }

  const hooks = {
    async "chat.message"(inp, out) {
      try {
        if (!inp?.sessionID) return;
        // Harness continuations (guardPrompt) use synthetic parts — never treat
        // them as a real user turn (no bumpUserTurn, no goal-text capture).
        if (isSyntheticUserTurn(out?.parts)) {
          captureModel(inp.sessionID, inp.model);
          return;
        }
        const state = store.stateFor(inp.sessionID);
        // A genuine new user turn is starting. Mark it (so a continuation decision
        // mid-grace can detect it was superseded) and clear any pending cancel so the
        // guard resumes normal "never stop incomplete" behaviour. The clear is made
        // durable (the SET is persisted, so the CLEAR must be too — otherwise a
        // restart within the suppression window would wrongly keep suppressing).
        bumpUserTurn(inp.sessionID);
        captureModel(inp.sessionID, inp.model);
        if (state.abortedAt) {
          state.abortedAt = 0;
          // Durable clear — matches the flushed SET, so a restart can't wedge suppression.
          persistence.flush(snapshotFn);
        }
        // `active` reflects whether this session is CURRENTLY a Goal session. Switching
        // the session's agent to Build (or anything non-goal) must deactivate it, or
        // the sidebar/guard would keep treating an explicit Build session as a goal.
        // Persist the flip so the on-disk snapshot (the sidebar's fallback) is correct.
        if (inp.agent) {
          const next = goalSessionActiveForAgent(inp.agent, state);
          if (state.active !== next) {
            state.active = next;
            persist();
          }
        }
        if (state.active) lastActiveGoalSession = inp.sessionID;
        const text = partsText(out?.parts);
        if (text && state.active) {
          // Accumulate goal text (bounded) so contextual gates can be derived.
          state.goalText = `${state.goalText} ${text}`.trim().slice(-8000);
          // Resolve contextual gates eagerly into the sticky set so truncating
          // the rolling buffer later cannot drop an already-required gate.
          refreshStickyGates(state);
          // Anchor a baseline Goal Contract if the model hasn't recorded one. Weak
          // models often skip goal_contract; this keeps the sidebar/objective live and
          // gives the model something to steer by. No-op once a contract exists.
          maybeAutoSeedContract(store, state);
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
        captureModel(normalized, inp.model);
        // NOTE: do NOT clear abortedAt here. chat.params fires on every LLM call
        // (including intra-turn/aux requests), not only on a genuine new user turn,
        // so clearing here could drop a legitimate pending cancel. The cancel is
        // cleared in chat.message (a real user message) instead.
        // Track the current mode: a session is active (a goal) only while its agent
        // is the goal primary. Switching to Build/Plan/etc. deactivates it so the
        // Goal sidebar and enforcement stop treating it as a goal. Persist the flip so
        // the on-disk snapshot (the sidebar's fallback) reflects a goal→build switch.
        if (inp.agent) {
          const next = goalSessionActiveForAgent(inp.agent, state);
          if (state.active !== next) {
            state.active = next;
            persist();
          }
        }
        if (state.active) lastActiveGoalSession = normalized;
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
          // The shipped /goal-review and /goal-final slash commands run a reviewer as a
          // subtask from the user's (possibly non-goal) session — that is a legitimate,
          // user-initiated goal-* invocation, so allow it. Model-emitted task calls carry
          // no `command`, so the poach case a non-goal agent calling a reviewer stays blocked.
          const cmd = String(out?.args?.command ?? inp?.args?.command ?? "").trim();
          const fromGoalCommand = cmd === "goal-review" || cmd === "goal-final";
          if (!callerIsGoal && !fromGoalCommand) {
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
        if (isEditTool(tool) && !isReviewing) {
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

        // Try to clear `dirty` after ANY recorded verdict, not only the cycle-closing
        // agent's: if goal-final-auditor passed earlier but another required gate was
        // the last to clear, dirty would otherwise stay stuck true (wedging the sidebar
        // / system prompt as forever-incomplete). maybeClearDirtyOnFinalPass still only
        // clears when the final auditor has a FRESH pass and completion is allowed.
        if (recordedAgent) {
          maybeClearDirtyOnFinalPass(state, config);
        }

        // Surface review progress in the TUI: a toast per recorded verdict, and a
        // single celebratory toast the moment the last required gate clears.
        if (recordedAgent && recordedVerdict && config.toastOnReview) {
          logger.toast(`${prettyAgentName(recordedAgent)} → ${recordedVerdict}`, recordedVerdict === "PASS" ? "success" : "warning");
          // A review CYCLE closes when the cycle-closing auditor renders a verdict.
          // Surface the running cycle count in the TUI so it is always visible — not
          // just at completion (it is also in the sidebar, goal_status, and prompt).
          if (recordedAgent === CYCLE_CLOSING_AGENT) {
            logger.toast(`Goal: review cycle ${state.reviewCycles} ${recordedVerdict === "PASS" ? "complete" : "failed — fixing & re-reviewing"}`, recordedVerdict === "PASS" ? "info" : "warning");
          }
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
          // The event is project-scoped and carries no sessionID. Attribute it to the
          // ONE goal session whose turn is currently in flight (a subagent's child-
          // session edit happens during its parent goal's turn) — NOT to every active
          // session. Broadcasting would cross-dirty independent concurrent goals in the
          // same worktree and, worse, pull a foreign file's contextual reviewers into
          // their required-gate set. We mark only the changed file (dirtying that goal);
          // contextual gates are refreshed solely from a session's OWN edits, via
          // tool.execute.after — never from another session's file.
          const target = lastActiveGoalSession && store.sessions.get(lastActiveGoalSession);
          // While a goal is mid-review the agent is IDLE — it does no work during the
          // programmatic review run. Any project-scoped file.edited that lands in that
          // window is background noise (a watcher, a reviewer touching the tree, a build
          // artifact), NOT the agent's goal edit. Dirtying the goal here bumps lastEditSeq
          // into the MIDDLE of the verdict sequence and stales the fresh PASSes the review
          // just recorded — a wasted cycle plus a contradictory "fix nonexistent issues"
          // directive. Suppress attribution while that session is reviewing.
          if (target && target.active && !reviewingSessions.has(lastActiveGoalSession)) {
            markFileChanged(store, target, file);
            persist();
          }
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
              persistence.flush(snapshotFn);
              await logger.toast("Goal Mode: turn cancelled — not auto-continuing", "info");
            }
          }
          return;
        }
        if (event.type === "session.idle" && event.properties?.sessionID) {
          const sessionID = event.properties.sessionID;
          const idleState = store.stateFor(sessionID);
          idleState.lastIdleEventAt = store.nowIso();
          persist();
          if (decidingIdle.has(sessionID)) return;
          decidingIdle.add(sessionID);
          // NEVER await promptAsync / runReviewCycle inside this hook synchronously:
          // OpenCode is still finishing the idle transition and cannot process nested
          // session prompts until we return. Blocking here deadlocks programmatic
          // subtask reviewers (0 cycles, no subagent activity in live usage).
          if (syncIdle) {
            await resolveIdleSession(sessionID);
          } else {
            void resolveIdleSession(sessionID).catch((err) => {
              logger.warn("Goal idle handler failed", { sessionID, error: String(err?.message || err) });
            });
          }
        }
      } catch {
        /* ignore */
      }
    },

    async dispose() {
      try {
        persistence.flush(snapshotFn);
      } catch {
        /* ignore */
      }
    },
  };

  return { hooks, store, config, persistence, logger, persist };
}

/** Subscribe to the server event stream so session.idle is handled even when the
 * plugin `event` hook is not invoked (observed in some headless serve deployments). */
async function startSessionIdleWatcher(baseUrl, hooks) {
  const { createOpencodeClient } = await import("@opencode-ai/sdk");
  const client = createOpencodeClient({ baseUrl: String(baseUrl) });
  const sub = await client.event.subscribe();
  const stream = sub.stream || sub;
  for await (const ev of stream) {
    if (ev?.type === "session.idle" && ev.properties?.sessionID) {
      await hooks.event({ event: ev });
    }
  }
}

/** OpenCode plugin factory (default export). */
export async function GoalGuardPlugin(input, options) {
  let reviewClient = ensureReviewClient(input?.client, input?.serverUrl);
  if (!clientCanReview(reviewClient) && input?.serverUrl) {
    try {
      const { createOpencodeClient } = await import("@opencode-ai/sdk");
      const fallback = createOpencodeClient({ baseUrl: String(input.serverUrl) });
      reviewClient = ensureReviewClient(fallback, input.serverUrl);
    } catch {
      /* fall back to the HTTP-wrapped plugin client */
    }
  }
  const guard = createGuard(input || {}, options || {}, { reviewClient });

  if (input?.serverUrl) {
    void startSessionIdleWatcher(String(input.serverUrl), guard.hooks).catch(() => {});
  }
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
