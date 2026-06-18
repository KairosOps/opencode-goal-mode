/**
 * Code-driven review enforcement — the plugin LAUNCHES the reviewers itself.
 *
 * The original design relied on the model to spawn review subagents via the `task`
 * tool (nudged by the system prompt + auto-continue). Weak models skip it, so the
 * gates never run. This module removes that dependency entirely: when an active
 * goal has done work and is not yet complete, the GUARD CODE programmatically runs
 * each required reviewer subagent, reads its `Verdict:` line, and records it — so
 * the reviews ALWAYS run, 100%, regardless of the agent.
 *
 * One full pass over the required-but-not-fresh reviewers (ending with the
 * cycle-closing auditor) is ONE review cycle. A failing reviewer makes the agent
 * fix the issue (an edit), which staleness-invalidates the prior passes, so the
 * next idle re-runs the cycle — exactly the loop:
 *     agent done → review → FAIL → fix → review → FAIL → fix → review → PASS.
 *
 * Reviewers are read-only subagents (edit: deny), so running them never advances
 * the goal's edit seq and their PASS verdicts stay fresh against the last real edit.
 *
 * Pure-ish + dependency-injected (client, sleep) so it is unit-testable with a mock
 * client and a fake clock.
 */

import { requiredGates, completionAllowed, gatePassedFresh } from "./gates.js";
import { recordVerdict, parseVerdict } from "./verdicts.js";
import { CYCLE_CLOSING_AGENT, prettyAgentName } from "./agents.js";
import { shortGoalLabel } from "./summary.js";

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (r) => (r && r.data !== undefined ? r.data : r);

/** Does this client expose the surface the programmatic runner needs? */
export function clientCanReview(client) {
  return Boolean(client?.session?.create && client?.session?.promptAsync && client?.session?.messages);
}

/** The instruction handed to a programmatically-launched reviewer subagent. */
export function reviewerPrompt(agent, state) {
  const goal = shortGoalLabel(state, 200) || String(state?.goalText || "").slice(0, 200) || "the user's goal";
  const criteria = Array.isArray(state?.contract?.acceptanceCriteria) ? state.contract.acceptanceCriteria : [];
  const lines = [
    `You are the ${prettyAgentName(agent)}. Review the CURRENT working-tree changes for this autonomous goal — you were launched automatically by the Goal Guard, not by the agent.`,
    `GOAL: ${goal}`,
  ];
  if (criteria.length) lines.push(`ACCEPTANCE CRITERIA:\n${criteria.map((c) => `- ${c}`).join("\n")}`);
  lines.push(
    "Run `git diff` and `git status`, inspect the changed files, and judge strictly within your specialty. " +
      "List any BLOCKING findings concisely, then end your reply with EXACTLY one final line: " +
      '`Verdict: PASS` (no blocking issues) or `Verdict: FAIL` (blocking issues remain).',
  );
  return lines.join("\n\n");
}

/** Latest assistant text from a session's message list (defensive across shapes). */
async function readAssistantText(client, sessionID) {
  try {
    const msgs = unwrap(await client.session.messages({ path: { id: sessionID } }));
    let text = "";
    for (const m of Array.isArray(msgs) ? msgs : []) {
      const info = m.info || m;
      if (info.role !== "assistant") continue;
      for (const part of m.parts || info.parts || []) if (part?.type === "text" && part.text) text = part.text;
    }
    return text;
  } catch {
    return "";
  }
}

/**
 * Launch ONE reviewer subagent and return its verdict ("PASS"|"FAIL"|null).
 * Polls until the reviewer FINISHES streaming (its text stabilizes), then parses the
 * final verdict — so an interim mid-stream verdict can't be latched. The reviewer
 * session is always aborted afterward (even if prompting threw).
 */
async function runReviewer(client, agent, state, model, { timeoutMs, pollMs, sleep }) {
  let sessionID = null;
  try {
    const created = unwrap(await client.session.create({ body: { title: `goal-review:${agent}` } }));
    sessionID = created?.id;
    if (!sessionID) return { verdict: null, text: "" };
    await client.session.promptAsync({
      path: { id: sessionID },
      body: { agent, ...(model ? { model } : {}), parts: [{ type: "text", text: reviewerPrompt(agent, state) }] },
    });
    const start = Date.now();
    let prevText = null;
    let stable = "";
    while (Date.now() - start < timeoutMs) {
      await sleep(pollMs);
      const text = await readAssistantText(client, sessionID);
      // Trust a verdict only once the reviewer has FINISHED: the assistant text must be
      // non-empty AND unchanged since the previous poll. Parsing mid-stream could latch
      // an interim "Verdict: PASS" the reviewer later revises to FAIL.
      if (text && text === prevText) {
        stable = text;
        break;
      }
      prevText = text;
    }
    const finalText = stable || prevText || "";
    return { verdict: parseVerdict(finalText), text: finalText };
  } catch (err) {
    return { verdict: null, text: "", error: String(err?.message || err) };
  } finally {
    // Always clean up the reviewer session — even if promptAsync threw after create.
    if (sessionID) {
      try {
        await client.session.abort({ path: { id: sessionID } });
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Run ONE review cycle: launch every required reviewer that is not currently
 * fresh-passing (cycle-closing auditor last), record each verdict, and report the
 * outcome. Records verdicts via the shared recordVerdict so review-cycle counting,
 * reviewer memory, and gate freshness all update exactly as the task-path does.
 *
 * @returns {{ ran: string[], passed: string[], failed: string[], completionAllowed: boolean, reviewCycles: number, findings: string[] }}
 */
export async function runReviewCycle(client, store, state, config, opts = {}) {
  const { model = null, log = () => {}, timeoutMs = 6 * 60 * 1000, pollMs = 2500, sleep = realSleep } = opts;
  const required = requiredGates(state, config);
  // Run only gates that are not already fresh-passing; cycle-closing auditor LAST so
  // a cycle closes cleanly once the specialist gates are green.
  const toRun = required.filter((g) => !gatePassedFresh(state, g));
  toRun.sort((a, b) => (a === CYCLE_CLOSING_AGENT ? 1 : 0) - (b === CYCLE_CLOSING_AGENT ? 1 : 0));

  const ran = [];
  const passed = [];
  const failed = [];
  for (const agent of toRun) {
    log(`launching reviewer: ${agent}`);
    const { verdict } = await runReviewer(client, agent, state, model, { timeoutMs, pollMs, sleep });
    ran.push(agent);
    if (verdict) {
      recordVerdict(store, state, agent, verdict, `programmatic review (${agent}): Verdict: ${verdict}`);
      (verdict === "PASS" ? passed : failed).push(agent);
    } else {
      // No conclusive verdict — treat as not-passed (the gate stays open). Fail-closed.
      failed.push(agent);
    }
  }

  const findings = (state.reviewerMemory || [])
    .filter((m) => (m.status || "open") === "open")
    .slice(-8)
    .map((m) => `${prettyAgentName(m.agent)}: ${m.finding}`);

  return {
    ran,
    passed,
    failed,
    findings,
    completionAllowed: completionAllowed(state, config),
    reviewCycles: state.reviewCycles,
  };
}
