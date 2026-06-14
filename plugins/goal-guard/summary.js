/**
 * Human-readable summaries of guard state, used in compaction context, block
 * messages, and the `goal_status` tool. Kept pure and dependency-light.
 */

import { requiredGates, missingGates, gatePassedFresh } from "./gates.js";

/**
 * A short, single-line human label for the current goal — preferring the
 * recorded Goal Contract's original request, falling back to the captured goal
 * text. Collapses whitespace and truncates to `max` chars for compact display
 * (status reports, the TUI sidebar banner).
 */
export function shortGoalLabel(state, max = 80) {
  const raw = String(state?.contract?.original || state?.goalText || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  // Prefer the first sentence/clause if it is reasonably short.
  const firstSentence = raw.split(/(?<=[.!?])\s/)[0];
  const base = firstSentence.length > 0 && firstSentence.length <= max ? firstSentence : raw;
  if (base.length <= max) return base;
  return `${base.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Compact projection for the TUI sidebar banner: the short goal label, a
 * one-line gate/dirty status, and whether completion is currently allowed.
 * Returns null when there is no active goal worth showing.
 */
export function sidebarView(state, config) {
  if (!state || !state.active) return null;
  const goal = shortGoalLabel(state);
  if (!goal) return null;
  const required = requiredGates(state, config);
  const missing = missingGates(state, config);
  const passing = required.length - missing.length;
  const allowed = required.length > 0 && missing.length === 0 && !state.dirty;
  const status = `${passing}/${required.length} gates` + (state.dirty ? " · dirty" : "") + (allowed ? " · ready" : "");
  return { goal, status, allowed, reviewCycles: state.reviewCycles, passing, required: required.length, dirty: Boolean(state.dirty) };
}

export function summarizeState(state, config) {
  const verdictSummary =
    state.verdicts
      .slice(-8)
      .map((v) => `${v.agent}:${v.verdict}`)
      .join(", ") || "none";
  return [
    `active=${Boolean(state.active)}`,
    `dirty=${Boolean(state.dirty)}`,
    `reviewCycles=${state.reviewCycles}`,
    `lastEditSeq=${state.lastEditSeq || 0}`,
    `lastReviewSeq=${state.lastReviewSeq || 0}`,
    `recentVerdicts=${verdictSummary}`,
    `openReviewerMemory=${reviewerMemoryReport(state).open.length}`,
    `missingGates=${missingGates(state, config).join(" ") || "none"}`,
    `dirtyReasons=${state.dirtyReasons.slice(-5).join(" | ") || "none"}`,
  ].join("; ");
}

export function reviewerMemoryReport(state) {
  const memory = Array.isArray(state.reviewerMemory) ? state.reviewerMemory : [];
  const shape = (item) => ({
    agent: item.agent,
    finding: item.finding,
    severity: item.severity || "blocking",
    status: item.status || "open",
    count: item.count || 1,
    firstAt: item.firstAt || null,
    lastAt: item.lastAt || null,
    resolvedAt: item.resolvedAt || null,
    fresh: Number(item.lastSeq || 0) > Number(state.lastEditSeq || 0),
  });
  return {
    open: memory.filter((item) => (item.status || "open") === "open").slice(-20).map(shape),
    resolved: memory.filter((item) => item.status === "resolved").slice(-20).map(shape),
    total: memory.length,
  };
}

/** Structured status object for the goal_status tool / diagnostics. */
export function statusReport(state, config) {
  const required = requiredGates(state, config);
  const missing = missingGates(state, config);
  return {
    active: Boolean(state.active),
    goal: shortGoalLabel(state),
    dirty: Boolean(state.dirty),
    reviewCycles: state.reviewCycles,
    requiredGates: required,
    passingGates: required.filter((g) => !missing.includes(g)),
    missingGates: missing,
    verificationSeen: Boolean(state.verificationSeen),
    lastEditAt: state.lastEditAt,
    lastReviewAt: state.lastReviewAt,
    lastVerificationAt: state.lastVerificationAt,
    evidenceCount: state.evidence.length,
    reviewerMemory: reviewerMemoryReport(state),
    changedFiles: state.changedFiles.slice(-50),
    contract: state.contract,
    completionAllowed: Boolean(state.active) && missing.length === 0,
  };
}

function evidenceMatchesCriterion(entry, criterion) {
  const criteria = Array.isArray(entry.criteria) ? entry.criteria : [];
  return criteria.some((c) => String(c).trim().toLowerCase() === String(criterion).trim().toLowerCase());
}

function evidenceFresh(entry, state) {
  const lastEditSeq = Number(state.lastEditSeq || 0);
  if (!entry.seq) return lastEditSeq === 0;
  return Number(entry.seq) > lastEditSeq;
}

function criterionStatus(entries, state, missing) {
  if (entries.length === 0) return "missing";
  if (!entries.some((entry) => evidenceFresh(entry, state))) return "stale";
  if (missing.length > 0 || state.dirty) return "partially covered";
  return "covered";
}

/** Structured Requirement/Acceptance Criteria -> Evidence -> Reviewer -> Status map. */
export function evidenceMapReport(state, config) {
  const required = requiredGates(state, config);
  const missing = missingGates(state, config);
  const reviewers = required.map((agent) => {
    const latest = state.latestVerdict[agent] || null;
    return {
      agent,
      verdict: latest?.verdict || "missing",
      at: latest?.at || null,
      fresh: gatePassedFresh(state, agent),
    };
  });
  const criteria = Array.isArray(state.contract?.acceptanceCriteria) ? state.contract.acceptanceCriteria : [];
  const items = criteria.map((criterion) => {
    const entries = state.evidence.filter((entry) => evidenceMatchesCriterion(entry, criterion));
    const status = criterionStatus(entries, state, missing);
    const memory = reviewerMemoryReport(state).open.filter((item) => item.finding.toLowerCase().includes(String(criterion).trim().toLowerCase()));
    return {
      criterion,
      status,
      evidence: entries.map((entry) => ({
        command: entry.command,
        result: entry.result,
        at: entry.at,
        seq: entry.seq || null,
        fresh: evidenceFresh(entry, state),
      })),
      reviewers,
      reviewerMemory: memory,
      gap:
        status === "missing"
          ? "No recorded evidence references this acceptance criterion."
          : status === "stale"
            ? "Recorded evidence is older than the latest edit."
            : missing.length > 0
              ? `Missing or stale reviewer gates: ${missing.join(", ")}.`
              : state.dirty
                ? "Session is dirty; rerun reviews after the latest change."
                : "None recorded.",
      nextAction:
        status === "covered"
          ? "No action required for this criterion."
          : status === "missing"
            ? "Run verification and record it with goal_evidence, including this criterion."
            : status === "stale"
              ? "Rerun verification after the latest edit and record fresh evidence."
              : "Complete missing/stale reviewer gates after verification.",
    };
  });
  return {
    active: Boolean(state.active),
    dirty: Boolean(state.dirty),
    lastEditAt: state.lastEditAt,
    requiredGates: required,
    missingGates: missing,
    reviewers,
    unmappedEvidence: state.evidence
      .filter((entry) => !criteria.some((criterion) => evidenceMatchesCriterion(entry, criterion)))
      .map((entry) => ({ command: entry.command, result: entry.result, criteria: entry.criteria || [], at: entry.at, seq: entry.seq || null })),
    criteria: items,
  };
}
