/**
 * Per-session guard state and the store that owns it.
 *
 * Two correctness fixes versus the original design live here:
 *
 *  1. A monotonic `seq` counter (project-scoped) orders every state-changing
 *     event. Staleness ("is this review newer than the latest edit?") is
 *     decided by comparing seq numbers, not millisecond ISO strings, so two
 *     events in the same millisecond can never tie and a review can never be
 *     accepted as fresh against an edit it did not actually post-date.
 *
 *  2. The store is created PER PLUGIN INSTANCE (closure state), not as a module
 *     global, so concurrent OpenCode projects can no longer cross-contaminate
 *     each other's verdicts and dirty flags. Eviction is true LRU by last-touch
 *     time and PREFERS inactive sessions: an active session is only evicted when
 *     every tracked session is active and the cap is exceeded, in which case the
 *     least-recently-touched active one is dropped.
 */

/** @returns a fresh per-session state record. */
export function createState(nowIso) {
  const at = nowIso || new Date(0).toISOString();
  return {
    active: false,
    goalText: "",
    contract: null,
    stickyGates: [],
    dirty: false,
    dirtyReasons: [],
    changedFiles: [],
    reviewCycles: 0,
    lastEditSeq: 0,
    lastVerificationSeq: 0,
    lastReviewSeq: 0,
    lastEditAt: null,
    lastReviewAt: null,
    lastVerificationAt: null,
    verdicts: [],
    reviewerMemory: [],
    evidence: [],
    latestVerdict: {},
    currentAgent: undefined,
    completedBlocked: 0,
    completionRejections: [],
    verificationSeen: false,
    lastCompletionRejectAt: null,
    autoContinueCount: 0,
    autoContinueNoProgress: 0,
    lastAutoContinueSig: "",
    // How many programmatic review CYCLES the guard has run for this goal. Bounds the
    // review loop independently of reviewCycles (which only counts CONCLUDED
    // final-auditor verdicts) so a reviewer that never renders a verdict can't run away.
    reviewRunCount: 0,
    abortedAt: 0,
    createdAt: at,
    updatedAt: at,
    touchedAt: 0,
  };
}

const KNOWN_FIELDS = Object.keys(createState());

/**
 * Fields that belong to a SINGLE goal rather than the session. When a brand-new
 * goal starts in an existing session these are cleared (see resetGoalProgress);
 * the session-identity fields — `active`, `currentAgent`, `createdAt`, and the
 * store-managed `touched*` — are deliberately NOT in this list.
 */
const GOAL_PROGRESS_FIELDS = Object.freeze([
  "goalText", "contract", "stickyGates", "dirty", "dirtyReasons", "changedFiles",
  "reviewCycles", "lastEditSeq", "lastVerificationSeq", "lastReviewSeq",
  "lastEditAt", "lastReviewAt", "lastVerificationAt", "verdicts", "reviewerMemory",
  "evidence", "latestVerdict", "completedBlocked", "completionRejections",
  "verificationSeen", "lastCompletionRejectAt",
  "autoContinueCount", "autoContinueNoProgress", "lastAutoContinueSig", "reviewRunCount", "abortedAt",
]);

/**
 * Reset a session's per-GOAL progress IN PLACE, preserving its session identity
 * (the `active` flag, `currentAgent`, and `createdAt`).
 *
 * Used when a genuinely new goal is recorded in an existing session: without
 * this, the previous goal's contract, accumulated goal text, sticky gates,
 * verdicts, dirty flags, evidence, and review-cycle count all bled into the new
 * goal — so the TUI sidebar kept showing the old goal (and even its "completed"
 * status). Re-recording/refining the SAME goal must NOT call this.
 *
 * @param {object} state  The session state to mutate.
 * @param {string} [nowIso]  Timestamp used for `updatedAt`.
 * @returns {object} the same `state`, mutated.
 */
export function resetGoalProgress(state, nowIso) {
  if (!state || typeof state !== "object") return state;
  const fresh = createState(nowIso || state.createdAt);
  for (const field of GOAL_PROGRESS_FIELDS) state[field] = fresh[field];
  if (nowIso) state.updatedAt = nowIso;
  return state;
}

/** Rebuild a state object from persisted JSON, dropping unknown fields. */
function reviveState(raw) {
  const base = createState();
  if (!raw || typeof raw !== "object") return base;
  for (const field of KNOWN_FIELDS) {
    if (raw[field] !== undefined) base[field] = raw[field];
  }
  // Defensive normalisation of array/object shapes.
  for (const arrField of ["dirtyReasons", "changedFiles", "verdicts", "reviewerMemory", "evidence", "completionRejections"]) {
    if (!Array.isArray(base[arrField])) base[arrField] = [];
  }
  if (!base.latestVerdict || typeof base.latestVerdict !== "object") base.latestVerdict = {};
  return base;
}

/**
 * Create a guard store.
 *
 * @param {object} opts
 * @param {number} [opts.maxSessions=200]
 * @param {number} [opts.ttlMs=0]  Idle TTL in ms (0 disables).
 * @param {() => number} [opts.clock]  Monotonic-ish wall clock for touch/TTL.
 * @param {(key: string) => void} [opts.onEvict]  Called with the session key whenever a
 *   session is dropped (TTL/LRU/restore-trim), so callers can prune any out-of-store
 *   per-session sidecars (e.g. in-memory maps) and never leak them.
 */
export function createStore({ maxSessions = 200, ttlMs = 0, clock = () => Date.now(), onEvict } = {}) {
  const sessions = new Map();
  let seq = 0;
  let touchCounter = 0;

  const nowIso = () => new Date(clock()).toISOString();
  const nextSeq = () => (seq += 1);
  const drop = (key) => {
    sessions.delete(key);
    if (onEvict) {
      try {
        onEvict(key);
      } catch {
        /* a sidecar-prune failure must never break eviction */
      }
    }
  };

  function evictIfNeeded() {
    // Drop TTL-expired idle sessions first.
    if (ttlMs > 0) {
      const cutoff = clock() - ttlMs;
      for (const [key, st] of sessions) {
        if (st.touchedWall !== undefined && st.touchedWall < cutoff && !st.active) {
          drop(key);
        }
      }
    }
    while (sessions.size >= maxSessions) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [key, st] of sessions) {
        // Prefer evicting inactive sessions; only evict active ones if nothing else.
        const rank = (st.active ? Number.MAX_SAFE_INTEGER / 2 : 0) + (st.touchedAt || 0);
        if (rank < oldest) {
          oldest = rank;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      drop(oldestKey);
    }
  }

  function touch(st) {
    st.touchedAt = (touchCounter += 1);
    st.touchedWall = clock();
  }

  function stateFor(sessionID) {
    const key = String(sessionID || "default").trim() || "default";
    let st = sessions.get(key);
    if (!st) {
      evictIfNeeded();
      st = createState(nowIso());
      sessions.set(key, st);
    }
    touch(st);
    return st;
  }

  function snapshot() {
    return {
      version: 1,
      seq,
      touchCounter,
      sessions: Array.from(sessions.entries()).map(([key, st]) => [key, st]),
    };
  }

  function restore(data) {
    if (!data || typeof data !== "object") return;
    if (Number.isFinite(data.seq)) seq = Math.max(seq, data.seq);
    if (Number.isFinite(data.touchCounter)) touchCounter = Math.max(touchCounter, data.touchCounter);
    if (Array.isArray(data.sessions)) {
      const wall = clock();
      for (const entry of data.sessions) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [key, raw] = entry;
        const st = reviveState(raw);
        // Seed a wall time so restored sessions are subject to TTL eviction
        // (otherwise undefined touchedWall makes them immortal).
        if (st.touchedWall === undefined) st.touchedWall = wall;
        sessions.set(String(key), st);
      }
    }
    // Restoring a snapshot must respect the configured cap, or a persisted
    // oversized store would exceed maxSessions forever (and a later add could
    // evict a live active session in one burst).
    while (sessions.size > maxSessions) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [key, st] of sessions) {
        const rank = (st.active ? Number.MAX_SAFE_INTEGER / 2 : 0) + (st.touchedAt || 0);
        if (rank < oldest) {
          oldest = rank;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      drop(oldestKey);
    }
  }

  return {
    sessions,
    stateFor,
    nowIso,
    nextSeq,
    seqValue: () => seq,
    snapshot,
    restore,
    size: () => sessions.size,
    clear: () => sessions.clear(),
  };
}
