/**
 * Read-only projection of persisted guard state for the TUI sidebar banner.
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
import { sidebarView } from "./summary.js";

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
 * Choose which session's goal to show: the most-recently-touched ACTIVE session
 * (optionally preferring an explicit sessionId when it is present and active).
 */
export function pickSession(snapshot, sessionId) {
  if (!snapshot || !Array.isArray(snapshot.sessions)) return null;
  const records = snapshot.sessions
    .filter((e) => Array.isArray(e) && e.length === 2)
    .map(([key, st]) => [key, normalize(st)]);
  if (sessionId) {
    const direct = records.find(([key, st]) => key === sessionId && st.active);
    if (direct) return direct[1];
  }
  const active = records.filter(([, st]) => st.active);
  if (active.length === 0) return null;
  active.sort((a, b) => (b[1].touchedAt || 0) - (a[1].touchedAt || 0));
  return active[0][1];
}

/**
 * Build the sidebar banner model for a worktree, or null if there is nothing to
 * show. Returns { goal, status, allowed, … } (see summary.sidebarView).
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
    return null; // no state yet, or unreadable — show nothing.
  }
  const record = pickSession(snapshot, sessionId);
  if (!record) return null;
  return sidebarView(record, config);
}
