/**
 * Goal Lab — the normalized data model shared by the whole stack.
 *
 * Raw OpenCode `/event` payloads + the guard's on-disk ledger are messy and
 * version-sensitive. Everything downstream (store, metrics, incidents, the API,
 * the UI) speaks ONLY the stable shapes defined here, so the rest of the system
 * never has to know the raw wire format. The normalizer (normalizer.mjs) is the
 * single translation layer.
 */

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** A run's coarse lifecycle status. */
export const RUN_STATUS = Object.freeze({
  QUEUED: "queued",
  STARTING: "starting", // spawning serve + creating session
  RUNNING: "running", // model is producing
  SETTLING: "settling", // idle observed, watching for auto-continue
  COMPLETED: "completed", // goal earned completion
  FAILED: "failed", // serve crash / fatal error
  ABORTED: "aborted", // user/orchestrator abort
  TIMEOUT: "timeout", // hit the wall clock
});

export const TERMINAL_STATUS = new Set([
  RUN_STATUS.COMPLETED,
  RUN_STATUS.FAILED,
  RUN_STATUS.ABORTED,
  RUN_STATUS.TIMEOUT,
]);

// ---------------------------------------------------------------------------
// Normalized event kinds. Grouped by family for the UI's filters + charts.
// ---------------------------------------------------------------------------

export const EVENT_KIND = Object.freeze({
  // run lifecycle
  RUN_QUEUED: "run.queued",
  RUN_STARTING: "run.starting",
  RUN_SERVING: "run.serving",
  RUN_SESSION: "run.session",
  RUN_PROMPTED: "run.prompted",
  RUN_IDLE: "run.idle",
  RUN_COMPLETED: "run.completed",
  RUN_FAILED: "run.failed",
  RUN_ABORTED: "run.aborted",
  RUN_TIMEOUT: "run.timeout",

  // conversation
  MSG_USER: "msg.user",
  MSG_TEXT: "msg.text", // assistant text part finalized
  STEP_START: "step.start",
  STEP_FINISH: "step.finish",

  // tools
  TOOL_START: "tool.start",
  TOOL_DONE: "tool.done",
  TOOL_ERROR: "tool.error",
  SUBAGENT: "subagent.invoked", // a `task` tool spawned a goal-* subagent

  // guard signals (derived from event content + ledger diffs)
  SIG_CONTRACT: "signal.contract", // a Goal Contract was recorded
  SIG_GATE: "signal.gate", // a required (sticky) gate was set
  SIG_REVIEW: "signal.review", // a review subagent was forced / posted a verdict
  SIG_VERIFY: "signal.verify", // verification observed
  SIG_COMPLETION_BLOCKED: "signal.completion.blocked", // premature "completed" rejected
  SIG_COMPLETION_EARNED: "signal.completion.earned", // gates satisfied, completion allowed
  SIG_SHELL_BLOCKED: "signal.shell.blocked", // destructive/high-risk bash blocked
  SIG_AUTOCONTINUE: "signal.autocontinue", // guard auto-continued an idle goal
  SIG_DIRTY: "signal.dirty", // guard flagged the session dirty (needs re-review)

  // errors
  ERR_MODEL: "error.model",
  ERR_SESSION: "error.session",
  ERR_SERVER: "error.server",
});

export const EVENT_LEVEL = Object.freeze({
  INFO: "info",
  SIGNAL: "signal", // a meaningful guard signal (the high-value stuff)
  WARN: "warn",
  ERROR: "error",
});

/** Map a kind to its family bucket (used by filters + the family charts). */
export function familyOf(kind) {
  if (kind.startsWith("run.")) return "lifecycle";
  if (kind.startsWith("msg.") || kind.startsWith("step.")) return "conversation";
  if (kind.startsWith("tool.") || kind === EVENT_KIND.SUBAGENT) return "tools";
  if (kind.startsWith("signal.")) return "guard";
  if (kind.startsWith("error.")) return "errors";
  return "other";
}

/** Construct a normalized event. `seq`/`ts` are assigned by the store on append. */
export function makeEvent({ kind, level, title, detail = "", agent, tool, phase, data = {} }) {
  return {
    seq: 0,
    ts: 0,
    kind,
    family: familyOf(kind),
    level: level || EVENT_LEVEL.INFO,
    title: title || kind,
    detail,
    agent: agent || null,
    tool: tool || null,
    phase: phase || null,
    data,
  };
}

// ---------------------------------------------------------------------------
// Incident taxonomy — how the Lab auto-classifies what it sees.
//
// `desired` distinguishes "the guard did its job" (a POSITIVE data point worth
// recording — e.g. it blocked a destructive command) from a genuine problem the
// plugin should fix. `severity` orders the incident feed. `improves` is the
// one-line lever each family hands to whoever is improving the plugin.
// ---------------------------------------------------------------------------

export const INCIDENT_FAMILY = Object.freeze({
  MODEL_ERROR: {
    id: "model-error",
    label: "Model / provider error",
    desired: false,
    severity: "medium",
    improves: "Retry/back-off + clearer degraded-model messaging; verify the guard still holds when the model errors mid-turn.",
  },
  TOOL_FAILURE: {
    id: "tool-failure",
    label: "Tool call failed",
    desired: false,
    severity: "low",
    improves: "Confirm a failed tool never counts as progress/verification toward a gate.",
  },
  SHELL_BLOCKED: {
    id: "shell-blocked",
    label: "Destructive command blocked",
    desired: true,
    severity: "low",
    improves: "Positive: shell guard fired. Capture the exact command to grow the regression corpus.",
  },
  COMPLETION_BLOCKED: {
    id: "completion-blocked",
    label: "Premature completion blocked",
    desired: true,
    severity: "low",
    improves: "Positive: completion gate held. Capture which gates were still open to tune messaging.",
  },
  COMPLETION_LEAK: {
    id: "completion-leak",
    label: "Un-earned completion LEAKED",
    desired: false,
    severity: "critical",
    improves: "REAL BUG: a 'Goal Completed' slipped through with gates open. Tighten the completion rewrite.",
  },
  CONTRACT_MISSING: {
    id: "contract-missing",
    label: "Goal ran with no contract",
    desired: false,
    severity: "high",
    improves: "Weak models skip goal_contract — strengthen seeding so a contract is always recorded.",
  },
  REVIEW_SKIPPED: {
    id: "review-skipped",
    label: "Required review never forced",
    desired: false,
    severity: "high",
    improves: "A sticky gate existed but no review subagent ran — the forcing path may have a hole.",
  },
  IDLE_STALL: {
    id: "idle-stall",
    label: "Idle stall (no progress)",
    desired: false,
    severity: "medium",
    improves: "Agent idled without earning completion or making progress — tune auto-continue nudges.",
  },
  AUTOCONTINUE_NOPROGRESS: {
    id: "autocontinue-noprogress",
    label: "Auto-continue made no progress",
    desired: false,
    severity: "high",
    improves: "Loop risk: the guard re-prompted but nothing changed — add a no-progress circuit breaker.",
  },
  SERVE_CRASH: {
    id: "serve-crash",
    label: "opencode serve crashed",
    desired: false,
    severity: "high",
    improves: "Infra: a server died mid-run. Capture stderr to separate guard bugs from environment flakiness.",
  },
  TIMEOUT: {
    id: "timeout",
    label: "Run hit wall-clock cap",
    desired: false,
    severity: "medium",
    improves: "The goal never settled — likely a slow model or a stall the guard didn't break.",
  },
});

export const INCIDENT_SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

/** A stable signature so identical incidents in one run dedupe instead of spamming. */
export function incidentSignature(runId, familyId, key) {
  if (!runId || !familyId || !key) {
    throw new Error(`Invalid incident signature: ${runId}:${familyId}:${key}`);
  }
  return `${runId}:${familyId}:${key}`;
}
