/**
 * Configuration resolution for the guard.
 *
 * Precedence (lowest → highest): built-in defaults < environment variables <
 * the plugin `options` object passed from opencode.json's `["spec", {…}]`
 * form. This lets the guard be tuned per project without code changes, while
 * still working with zero configuration when auto-discovered.
 */

export const DEFAULT_CONFIG = Object.freeze({
  /** Block destructive shell commands before execution (throw in tool.execute.before). */
  blockDestructive: true,
  /** Also block remote-code-execution pipelines (curl | sh). */
  blockNetworkExec: true,
  /** Rewrite premature `Goal Completed` claims in experimental.text.complete. */
  enforceCompletion: true,
  /** Auto-continue an active goal when the session goes idle but the goal is not yet
   * complete, so the agent never stops before the goal is actually done. */
  autoContinue: true,
  /** Hard cap on automatic continuations per goal session (backstop against runaway). */
  maxAutoContinue: 50,
  /** Programmatically LAUNCH the required review subagents from the guard code (do not
   * rely on the model to call the task tool). When an active goal idles with work done
   * and gates outstanding, the guard runs each reviewer itself, records the verdicts,
   * and feeds blocking findings back to the agent — so reviews ALWAYS run, 100%. */
  programmaticReview: true,
  /** Per-reviewer wall-clock cap (ms) for a programmatic review run. */
  reviewTimeoutMs: 6 * 60 * 1000,
  /** Poll cadence (ms) while waiting for a launched reviewer to render its verdict. */
  reviewPollMs: 2500,
  /** Delay (ms) after session.idle before launching reviewer subtasks — lets the host
   * finish the idle transition so promptAsync is not rejected as SessionBusy. */
  reviewIdleDeferMs: 1500,
  /** Backoff (ms) between automatic retries when session.idle fires before the host accepts prompts. */
  reviewIdleRetryMs: 2500,
  /** Max automatic idle-review retries before surfacing a manual-review pause. */
  maxReviewIdleRetries: 10,
  /** Hard cap on programmatic review CYCLES per goal (backstop against a reviewer that
   * never passes). On reaching it, the guard pauses and asks the human to step in. */
  maxReviewCycles: 12,
  /** Grace delay (ms) before an idle goal auto-continues, so a near-simultaneous user
   * cancel (session.error → MessageAbortedError) is observed first and the continuation
   * is suppressed — regardless of hook delivery order. It must comfortably exceed the
   * worst-case error/idle hook-delivery skew; the default has a wide margin. Lowering
   * it only reduces auto-continue latency; setting it to 0 removes the grace entirely,
   * which weakens cancel detection when the idle is delivered before the error. */
  abortGraceMs: 1200,
  /** Inject a live Goal Guard state block into the system prompt. */
  injectSystemState: true,
  /** Persist guard state to disk so it survives OpenCode restarts. */
  persist: true,
  /** Require the contextual specialist gates derived from goal text / changed files. */
  contextualGates: true,
  /** Block non-Goal agents from invoking the goal-* subagents via the task tool. */
  restrictSubagents: true,
  /** Maximum tracked sessions before LRU eviction. */
  maxSessions: 200,
  /** Idle TTL (ms) after which a session's state may be dropped. 0 disables TTL. */
  sessionTtlMs: 24 * 60 * 60 * 1000,
  /** Emit a TUI toast when completion is blocked. */
  toastOnBlock: true,
  /** Emit a TUI toast when a review gate records a PASS/FAIL, and when completion unlocks. */
  toastOnReview: true,
  /** Show the experimental goal todo section in the TUI sidebar (TUI-plugin-capable OpenCode only). */
  sidebarBanner: true,
  /** Foreground colour (hex) for the GOAL label of a running goal in the sidebar. */
  sidebarColor: "#FFD700",
  /** Foreground colour (hex) for a completed goal in the sidebar (running → done turns yellow → red). */
  sidebarDoneColor: "#FF5555",
  /** Reserved muted foreground colour for no-goal projections. */
  sidebarMutedColor: "#808080",
  /** Phrase that, at the start of an assistant message, claims completion. */
  completionMarker: "Goal Completed",
  /** Replacement marker when completion is blocked. */
  blockedMarker: "Goal Not Completed",
});

function coerceBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

function coerceInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const s = String(value).trim();
  // Accept only a plain non-negative integer. Reject decimals ("1.9") and scientific
  // notation ("1e3") rather than silently truncating them via parseInt.
  if (!/^\+?\d+$/.test(s)) return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Coerce a string config value, treating empty/blank as "unset" (use the fallback).
 * Prevents an empty marker/colour from being interpolated downstream. */
function coerceStr(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const s = String(value);
  return s.trim() === "" ? fallback : s;
}

function fromEnv(env) {
  const out = {};
  const map = {
    GOAL_GUARD_BLOCK_DESTRUCTIVE: ["blockDestructive", coerceBool],
    GOAL_GUARD_BLOCK_NETWORK_EXEC: ["blockNetworkExec", coerceBool],
    GOAL_GUARD_ENFORCE_COMPLETION: ["enforceCompletion", coerceBool],
    GOAL_GUARD_AUTO_CONTINUE: ["autoContinue", coerceBool],
    GOAL_GUARD_MAX_AUTO_CONTINUE: ["maxAutoContinue", coerceInt],
    GOAL_GUARD_PROGRAMMATIC_REVIEW: ["programmaticReview", coerceBool],
    GOAL_GUARD_REVIEW_TIMEOUT_MS: ["reviewTimeoutMs", coerceInt],
    GOAL_GUARD_REVIEW_POLL_MS: ["reviewPollMs", coerceInt],
    GOAL_GUARD_REVIEW_IDLE_DEFER_MS: ["reviewIdleDeferMs", coerceInt],
    GOAL_GUARD_REVIEW_IDLE_RETRY_MS: ["reviewIdleRetryMs", coerceInt],
    GOAL_GUARD_MAX_REVIEW_IDLE_RETRIES: ["maxReviewIdleRetries", coerceInt],
    GOAL_GUARD_MAX_REVIEW_CYCLES: ["maxReviewCycles", coerceInt],
    GOAL_GUARD_ABORT_GRACE_MS: ["abortGraceMs", coerceInt],
    GOAL_GUARD_INJECT_SYSTEM_STATE: ["injectSystemState", coerceBool],
    GOAL_GUARD_PERSIST: ["persist", coerceBool],
    GOAL_GUARD_CONTEXTUAL_GATES: ["contextualGates", coerceBool],
    GOAL_GUARD_RESTRICT_SUBAGENTS: ["restrictSubagents", coerceBool],
    GOAL_GUARD_MAX_SESSIONS: ["maxSessions", coerceInt],
    GOAL_GUARD_SESSION_TTL_MS: ["sessionTtlMs", coerceInt],
    GOAL_GUARD_TOAST_ON_BLOCK: ["toastOnBlock", coerceBool],
    GOAL_GUARD_TOAST_ON_REVIEW: ["toastOnReview", coerceBool],
    GOAL_GUARD_SIDEBAR_BANNER: ["sidebarBanner", coerceBool],
    GOAL_GUARD_SIDEBAR_COLOR: ["sidebarColor", coerceStr],
    GOAL_GUARD_SIDEBAR_DONE_COLOR: ["sidebarDoneColor", coerceStr],
    GOAL_GUARD_SIDEBAR_MUTED_COLOR: ["sidebarMutedColor", coerceStr],
    GOAL_GUARD_COMPLETION_MARKER: ["completionMarker", coerceStr],
    GOAL_GUARD_BLOCKED_MARKER: ["blockedMarker", coerceStr],
  };
  for (const [key, [field, coerce]] of Object.entries(map)) {
    if (env[key] !== undefined) out[field] = coerce(env[key], DEFAULT_CONFIG[field]);
  }
  return out;
}

/**
 * @param {Record<string, unknown>|undefined} options Plugin options (2nd factory arg).
 * @param {Record<string, string|undefined>} [env] Environment (defaults to process.env).
 * @returns {typeof DEFAULT_CONFIG}
 */
export function resolveConfig(options, env = process.env) {
  const envConfig = fromEnv(env || {});
  const opts = options && typeof options === "object" ? options : {};
  const merged = { ...DEFAULT_CONFIG, ...envConfig };

  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (opts[key] === undefined) continue;
    const def = DEFAULT_CONFIG[key];
    if (typeof def === "boolean") merged[key] = coerceBool(opts[key], merged[key]);
    else if (typeof def === "number") merged[key] = coerceInt(opts[key], merged[key]);
    else merged[key] = coerceStr(opts[key], merged[key]); // string keys: ignore empty/blank, never inject ""
  }
  // maxSessions must hold at least the goal session AND its reviewer child sessions.
  // A value of 0 (or negative) made the store's eviction loop (while (size >=
  // maxSessions)) always true, so every stateFor for a different sessionID evicted
  // the current one — concurrent goal+reviewer state bounced and neither persisted.
  // Reject the degenerate value and fall back to the default. (createStore also
  // floors the effective cap at 1 as a defence-in-depth backstop.)
  if (!Number.isFinite(merged.maxSessions) || merged.maxSessions < 1) merged.maxSessions = DEFAULT_CONFIG.maxSessions;
  return Object.freeze(merged);
}
