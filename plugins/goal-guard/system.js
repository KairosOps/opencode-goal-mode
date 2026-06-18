/**
 * Builds the live Goal Guard state block injected into the system prompt via
 * `experimental.chat.system.transform`. This makes the guard's enforcement
 * legible to the model on every turn — it always knows the recorded review
 * cycle count, which gates are missing, and whether completion is currently
 * allowed — turning the guard from a silent blocker into an active steering
 * signal. Only emitted for active goal sessions.
 *
 * The steering is deliberately PRESCRIPTIVE (an ordered required sequence + the
 * exact `task` invocation for the next outstanding review). Weak/low-capability
 * models frequently stop early or never spawn the review subagents; spelling out
 * the exact next action — not just "reviews are required" — measurably raises the
 * chance the goal is actually driven to completion in fewer turns.
 */

import { statusReport } from "./summary.js";

function bullet(list) {
  return list.length ? list.join(", ") : "none";
}

/** A concrete, copyable task-tool invocation for the next outstanding reviewer. */
function exampleTaskCall(agent) {
  return `task(subagent_type: "${agent}", description: "${agent} review", prompt: "Review the latest changes against the goal and reply with a final \\"Verdict: PASS\\" or \\"Verdict: FAIL\\" line.")`;
}

export function buildSystemInjection(state, config) {
  if (!state || !state.active) return null;
  const r = statusReport(state, config);
  const lines = [];
  lines.push("## Goal Guard — live enforcement state");
  lines.push(
    "This block is injected by the goal-guard plugin and reflects authoritative, " +
      "tracked state. Treat it as ground truth over your own recollection. Do not stop " +
      "until completion is ALLOWED below — if you stop early the harness re-prompts you.",
  );

  // Goal Contract: recorded with criteria / auto-derived (needs criteria) / missing.
  const criteria = r.contract && r.contract.acceptanceCriteria ? r.contract.acceptanceCriteria.length : 0;
  if (criteria > 0) {
    lines.push(`- Goal Contract: ${criteria} acceptance criteria recorded.`);
  } else if (r.contract) {
    lines.push("- Goal Contract: auto-derived from your request. Call `goal_contract` to add explicit, checkable acceptance criteria.");
  } else {
    lines.push("- Goal Contract: not yet recorded. Call `goal_contract` FIRST to establish acceptance criteria.");
  }
  lines.push(`- Review cycles recorded: ${r.reviewCycles}.`);
  lines.push(`- Working tree dirty since last clean review: ${r.dirty ? "yes" : "no"}.`);
  lines.push(`- Verification observed: ${r.verificationSeen ? "yes" : "no"}.`);
  lines.push(`- Required review gates: ${bullet(r.requiredGates)}.`);
  lines.push(`- Gates still missing or stale: ${bullet(r.missingGates)}.`);

  if (r.missingGates.length && config.programmaticReview) {
    // Reviews are run BY THE GUARD CODE (not the agent). Tell the agent to do the
    // work and stop — it will be reviewed automatically and told what to fix.
    lines.push(
      `- The Goal Guard runs the required reviews AUTOMATICALLY (programmatically) when you stop — you do NOT ` +
        `invoke any reviewer yourself. Implement the goal and VERIFY it (run the code / run the tests, record ` +
        `evidence with goal_evidence), then stop. The guard will run these reviewers — ${bullet(r.missingGates)} — ` +
        `and, if anything is blocking, re-prompt you with exactly what to fix. Each full review pass is one review cycle.`,
    );
  } else if (r.missingGates.length) {
    const next = r.missingGates[0];
    lines.push(
      `- MANDATORY NEXT ACTION — run the outstanding reviews now using the task tool. For EACH missing gate ` +
        `(${bullet(r.missingGates)}) make ONE task tool call whose subagent_type is that exact ` +
        `reviewer id, then fix every blocking finding and re-run until each returns "Verdict: PASS". ` +
        `Start with: ${exampleTaskCall(next)}. These reviews are not optional and cannot be skipped — ` +
        `do this before any summary or completion claim.`,
    );
  } else if (!r.verificationSeen) {
    lines.push("- NEXT ACTION — you have not yet verified your work. Actually run it (execute the code / run the tests) and record it with `goal_evidence` before claiming completion.");
  }

  if (r.reviewerMemory.open.length) {
    lines.push(`- Open Reviewer Memory (unresolved findings — fix these): ${r.reviewerMemory.open.map((m) => `${m.agent}: ${m.finding}`).join(" | ")}.`);
  }
  lines.push(
    `- Completion is currently ${r.completionAllowed ? "ALLOWED" : "BLOCKED"}. ` +
      (r.completionAllowed
        ? `Finish now: answer with "${config.completionMarker}" on its own line and an accurate "Review cycles: ${r.reviewCycles}" line.`
        : `Do NOT claim "${config.completionMarker}" yet; resolve the items above and re-run review first.`),
  );
  return lines.join("\n");
}
