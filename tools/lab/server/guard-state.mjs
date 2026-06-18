/**
 * Goal Lab — reader for the guard's own on-disk ledger.
 *
 * The single richest source of "why did the plugin do that" lives in the guard's
 * persisted state (contract, sticky gates, verdicts, completionRejections,
 * dirtyReasons, auto-continue counters). We point every spawned server at a
 * Lab-scoped `XDG_STATE_HOME`, then read that exact file per run. We reuse the
 * plugin's OWN persistence helpers so the path math can never drift from the code
 * under test.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateBaseDir, projectKey } from "../../../plugins/goal-guard/persistence.js";
import { STATE_HOME } from "./config.mjs";

const ENV = { XDG_STATE_HOME: STATE_HOME };

/** Absolute path of the guard ledger for a run's isolated project. */
export function guardStateFile(cwd) {
  return join(stateBaseDir(ENV), `${projectKey(cwd)}.json`);
}

/**
 * Read the guard record for a run. Prefers the exact session id; falls back to
 * the most-recently-touched record that actually carries a contract (each Lab
 * project hosts exactly one goal session, so this is unambiguous in practice).
 * Returns null when nothing is on disk yet.
 */
export function readGuardState(cwd, sessionId) {
  let snap;
  try {
    snap = JSON.parse(readFileSync(guardStateFile(cwd), "utf8"));
  } catch {
    return null;
  }
  const entries = Array.isArray(snap?.sessions) ? snap.sessions : [];
  const records = entries
    .map((e) => (Array.isArray(e) && e.length === 2 ? { key: e[0], st: e[1] } : null))
    .filter((r) => r && r.st && typeof r.st === "object");

  if (sessionId) {
    const exact = records.find((r) => r.key === sessionId);
    if (exact) return exact.st;
  }
  const withContract = records
    .filter((r) => r.st.contract || r.st.active)
    .sort((a, b) => (b.st.touchedAt || 0) - (a.st.touchedAt || 0));
  return withContract[0]?.st || records[0]?.st || null;
}

/**
 * Diff two guard snapshots into the meaningful transitions the Lab cares about.
 * Returns an array of `{ kind, ...payload }` describing what newly happened
 * (contract recorded, gate added, verdict posted, completion rejected, etc.).
 */
export function diffGuard(prev, next) {
  const out = [];
  if (!next) return out;
  const p = prev || {};

  if (!p.contract && next.contract) {
    out.push({ kind: "contract", title: next.contract.title, gates: next.contract.gates || next.stickyGates || [] });
  }
  const pg = new Set(p.stickyGates || []);
  for (const g of next.stickyGates || []) if (!pg.has(g)) out.push({ kind: "gate", gate: g });

  if ((next.verdicts || []).length > (p.verdicts || []).length) {
    const fresh = (next.verdicts || []).slice((p.verdicts || []).length);
    for (const v of fresh) out.push({ kind: "verdict", verdict: v });
  }
  if ((next.completionRejections || []).length > (p.completionRejections || []).length) {
    const fresh = (next.completionRejections || []).slice((p.completionRejections || []).length);
    for (const r of fresh) out.push({ kind: "completion-rejection", rejection: r });
  }
  if ((next.completedBlocked || 0) > (p.completedBlocked || 0)) {
    out.push({ kind: "completed-blocked", count: next.completedBlocked });
  }
  if ((next.dirtyReasons || []).length > (p.dirtyReasons || []).length) {
    const fresh = (next.dirtyReasons || []).slice((p.dirtyReasons || []).length);
    for (const r of fresh) out.push({ kind: "dirty", reason: r });
  }
  if ((next.autoContinueCount || 0) > (p.autoContinueCount || 0)) {
    out.push({ kind: "autocontinue", count: next.autoContinueCount, noProgress: next.autoContinueNoProgress || 0 });
  }
  if ((next.reviewCycles || 0) > (p.reviewCycles || 0)) {
    out.push({ kind: "review-cycle", count: next.reviewCycles });
  }
  return out;
}
