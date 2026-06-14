/**
 * Read-only projection of persisted guard state for the TUI sidebar todo section.
 *
 * The sidebar plugin runs in OpenCode's TUI process, separate from the server
 * plugin that owns the live store. The two are paired through the same on-disk
 * snapshot the server plugin already writes (persistence.js). This module reads
 * that snapshot and projects the active session's goal into a compact banner
 * model. It is pure and synchronous (a cheap file read), so it is unit-testable
 * without a TUI runtime.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateBaseDir, projectKey } from "./persistence.js";
import { DEFAULT_CONFIG } from "./config.js";
import { sidebarView, NO_GOAL } from "./summary.js";

/** Absolute path of the guard's state file for a given worktree. */
export function sidebarStateFile(worktree, env = process.env) {
  return join(stateBaseDir(env), `${projectKey(worktree)}.json`);
}

/** Defensive normalisation so a partial/legacy record never throws in projection. */
function normalize(record) {
  const st = record && typeof record === "object" ? record : {};
  if (!Array.isArray(st.stickyGates)) st.stickyGates = [];
  if (!Array.isArray(st.changedFiles)) st.changedFiles = [];
  if (!st.latestVerdict || typeof st.latestVerdict !== "object") st.latestVerdict = {};
  return st;
}

/**
 * Resolve the guard state for EXACTLY this session id, and only when it is an
 * active Goal session. There is deliberately NO "most-recently-touched" global
 * fallback: a Build or other session in the same worktree must never inherit a
 * Goal from a sibling session. This mirrors goal-sidebar.tsx's pickSession so the
 * Node-testable projection and the real TUI component behave identically.
 */
export function pickSession(snapshot, sessionId) {
  if (!snapshot || !Array.isArray(snapshot.sessions) || !sessionId) return null;
  for (const entry of snapshot.sessions) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, st] = entry;
    if (key === sessionId && st && typeof st === "object" && st.active) return normalize(st);
  }
  return null;
}

/**
 * Build the sidebar todo model for a worktree. ALWAYS returns an object: `state:
 * "none"` when there is no Goal session (render nothing and keep native todos), otherwise
 * `state: "running"|"done", goal, status, todos, …` (see summary.sidebarView).
 *
 * @param {object} opts
 * @param {string} opts.worktree   Project worktree root (same key the guard uses).
 * @param {string} [opts.sessionId]
 * @param {object} [opts.config]
 * @param {Record<string,string|undefined>} [opts.env]
 */
export function readSidebarModel({ worktree, sessionId, config = DEFAULT_CONFIG, env = process.env } = {}) {
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(sidebarStateFile(worktree, env), "utf8"));
  } catch {
    return NO_GOAL; // no state yet, or unreadable.
  }
  const record = pickSession(snapshot, sessionId);
  if (!record) return NO_GOAL;
  return sidebarView(record, config);
}
