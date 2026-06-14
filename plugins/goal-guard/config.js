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
  /** Inject a live Goal Guard state block into the system prompt. */
  injectSystemState: true,
  /** Persist guard state to disk so it survives OpenCode restarts. */
  persist: true,
  /** Require the contextual specialist gates derived from goal text / changed files. */
  contextualGates: true,
  /** Maximum tracked sessions before LRU eviction. */
  maxSessions: 200,
  /** Idle TTL (ms) after which a session's state may be dropped. 0 disables TTL. */
  sessionTtlMs: 24 * 60 * 60 * 1000,
  /** Emit a TUI toast when completion is blocked. */
  toastOnBlock: true,
  /** Emit a TUI toast when a review gate records a PASS/FAIL, and when completion unlocks. */
  toastOnReview: true,
  /** Show the experimental yellow goal banner in the TUI sidebar (TUI-plugin-capable OpenCode only). */
  sidebarBanner: true,
  /** Foreground colour (hex) for the sidebar goal banner. */
  sidebarColor: "#FFD700",
  /** Foreground colour (hex) for a completed goal in the sidebar (running → done turns yellow → red). */
  sidebarDoneColor: "#FF5555",
  /** Foreground colour (hex) for the muted "No goal available" sidebar line. */
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
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function fromEnv(env) {
  const out = {};
  const map = {
    GOAL_GUARD_BLOCK_DESTRUCTIVE: ["blockDestructive", coerceBool],
    GOAL_GUARD_BLOCK_NETWORK_EXEC: ["blockNetworkExec", coerceBool],
    GOAL_GUARD_ENFORCE_COMPLETION: ["enforceCompletion", coerceBool],
    GOAL_GUARD_INJECT_SYSTEM_STATE: ["injectSystemState", coerceBool],
    GOAL_GUARD_PERSIST: ["persist", coerceBool],
    GOAL_GUARD_CONTEXTUAL_GATES: ["contextualGates", coerceBool],
    GOAL_GUARD_MAX_SESSIONS: ["maxSessions", coerceInt],
    GOAL_GUARD_SESSION_TTL_MS: ["sessionTtlMs", coerceInt],
    GOAL_GUARD_TOAST_ON_BLOCK: ["toastOnBlock", coerceBool],
    GOAL_GUARD_TOAST_ON_REVIEW: ["toastOnReview", coerceBool],
    GOAL_GUARD_SIDEBAR_BANNER: ["sidebarBanner", coerceBool],
    GOAL_GUARD_SIDEBAR_COLOR: ["sidebarColor", (v) => (v == null ? undefined : String(v))],
    GOAL_GUARD_SIDEBAR_DONE_COLOR: ["sidebarDoneColor", (v) => (v == null ? undefined : String(v))],
    GOAL_GUARD_SIDEBAR_MUTED_COLOR: ["sidebarMutedColor", (v) => (v == null ? undefined : String(v))],
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
    else merged[key] = opts[key];
  }
  return Object.freeze(merged);
}
