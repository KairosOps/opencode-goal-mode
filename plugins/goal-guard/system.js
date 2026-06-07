/**
 * Builds the live Goal Guard state block injected into the system prompt via
 * `experimental.chat.system.transform`. This makes the guard's enforcement
 * legible to the model on every turn — it always knows the recorded review
 * cycle count, which gates are missing, and whether completion is currently
 * allowed — turning the guard from a silent blocker into an active steering
 * signal. Only emitted for active goal sessions.
 */

import { statusReport } from "./summary.js";

function bullet(list) {
  return list.length ? list.join(", ") : "none";
}

export function buildSystemInjection(state, config) {
  if (!state || !state.active) return null;
  const r = statusReport(state, config);
  const lines = [];
  lines.push("## Goal Guard — live enforcement state");
  lines.push(
    "This block is injected by the goal-guard plugin and reflects authoritative, " +
      "tracked state. Treat it as ground truth over your own recollection.",
  );

  if (r.contract && r.contract.acceptanceCriteria && r.contract.acceptanceCriteria.length) {
    lines.push(`- Goal Contract: ${r.contract.acceptanceCriteria.length} acceptance criteria recorded.`);
  } else {
    lines.push("- Goal Contract: not yet recorded. Call `goal_contract` to establish acceptance criteria.");
  }
  lines.push(`- Review cycles recorded: ${r.reviewCycles}.`);
  lines.push(`- Working tree dirty since last clean review: ${r.dirty ? "yes" : "no"}.`);
  lines.push(`- Verification observed: ${r.verificationSeen ? "yes" : "no"}.`);
  lines.push(`- Required review gates: ${bullet(r.requiredGates)}.`);
  lines.push(`- Gates still missing or stale: ${bullet(r.missingGates)}.`);
  if (r.reviewerMemory.open.length) {
    lines.push(`- Open Reviewer Memory: ${r.reviewerMemory.open.map((m) => `${m.agent}: ${m.finding}`).join(" | ")}.`);
  }
  lines.push(
    `- Completion is currently ${r.completionAllowed ? "ALLOWED" : "BLOCKED"}. ` +
      (r.completionAllowed
        ? `You may answer with "${config.completionMarker}" and an accurate "Review cycles: ${r.reviewCycles}" line.`
        : `Do NOT claim "${config.completionMarker}" yet; resolve the missing gates and re-run review first.`),
  );
  return lines.join("\n");
}
