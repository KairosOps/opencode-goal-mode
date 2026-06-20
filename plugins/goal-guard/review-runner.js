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
 * Reviewers are launched as subtasks on the **parent goal session** (the same
 * programmatic path OpenCode uses for `task` / command subtasks), not as separate
 * top-level sessions. **All required reviewers in a cycle launch in parallel** (one
 * batched subtask prompt); the guard polls them concurrently and records verdicts
 * once every reviewer in the batch has finished.
 *
 * One parallel pass over every required-but-not-fresh reviewer is ONE review cycle
 * (counted when the cycle-closing auditor's verdict is recorded after the batch).
 * A failing reviewer makes the agent fix the issue (an edit), which staleness-
 * invalidates the prior passes, so the next idle re-runs the cycle — exactly the loop:
 *     agent done → review → FAIL → fix → review → FAIL → fix → review → PASS.
 *
 * Reviewers are read-only subagents (edit: deny), so running them never advances
 * the goal's edit seq and their PASS verdicts stay fresh against the last real edit.
 *
 * Pure-ish + dependency-injected (client, sleep) so it is unit-testable with a mock
 * client and a fake clock.
 */

import { requiredGates, completionAllowed, gatePassedFresh } from "./gates.js";
import { recordVerdict, parseVerdict, textOf } from "./verdicts.js";
import { maybeClearDirtyOnFinalPass } from "./events.js";
import { CYCLE_CLOSING_AGENT, prettyAgentName } from "./agents.js";
import { shortGoalLabel } from "./summary.js";

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (r) => (r && r.data !== undefined ? r.data : r);

const RUNNING = new Set(["running", "pending", "executing", "in_progress"]);

/** Does this client expose the surface the programmatic runner needs? */
export function clientCanReview(client) {
  return Boolean(client?.session?.promptAsync);
}

/** Wrap the plugin client with HTTP fallbacks when `session.promptAsync` is missing
 * (seen in some headless `opencode serve` deployments where PluginInput.client is trimmed). */
export function ensureReviewClient(client, serverUrl) {
  if (clientCanReview(client)) return client;
  const base = serverUrl ? String(serverUrl).replace(/\/$/, "") : "";
  if (!base) return client;
  const promptAsync = async ({ path, body }) => {
    const id = path?.id;
    const res = await fetch(`${base}/session/${encodeURIComponent(id)}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(text || `prompt_async failed (${res.status})`);
      if (/SessionBusy|session busy|session is busy/i.test(text)) err.name = "SessionBusyError";
      throw err;
    }
    try {
      return await res.json();
    } catch {
      return {};
    }
  };
  const messages =
    client?.session?.messages ||
    (async ({ path }) => {
      const res = await fetch(`${base}/session/${encodeURIComponent(path.id)}/message`);
      if (!res.ok) return { data: [] };
      return res.json();
    });
  return { ...client, session: { ...(client?.session || {}), promptAsync, messages } };
}

export function isSessionBusyError(err) {
  const name = String(err?.name || "");
  const msg = String(err?.message || err || "");
  return name === "SessionBusyError" || /SessionBusy|session busy|session is busy/i.test(msg);
}

/** promptAsync rejects with SessionBusy while the host is still finishing idle — retry. */
async function promptSubtaskWithRetry(client, sessionID, body, { sleep, maxAttempts = 40, retryMs = 500 }) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await client.session.promptAsync({ path: { id: sessionID }, body });
      return;
    } catch (err) {
      lastErr = err;
      if (!isSessionBusyError(err) || attempt >= maxAttempts - 1) throw err;
      await sleep(retryMs * Math.min(attempt + 1, 6));
    }
  }
  throw lastErr;
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

function messageAgent(m) {
  return String(m?.info?.agent || m?.agent || "").trim();
}

function taskSubagent(part) {
  const input = part?.state?.input || {};
  return String(input.subagent_type || input.agent || "").trim();
}

function taskStillRunning(part) {
  const status = String(part?.state?.status || "").toLowerCase();
  return RUNNING.has(status);
}

/** Latest reviewer output from the goal session transcript (task tool + assistant text). */
export async function readReviewerOutput(client, sessionID, agent) {
  try {
    const msgs = unwrap(await client.session.messages({ path: { id: sessionID } }));
    let taskText = "";
    let assistantText = "";
    for (const m of Array.isArray(msgs) ? msgs : []) {
      const msgAgent = messageAgent(m);
      for (const part of m.parts || m.info?.parts || []) {
        if (part?.type === "tool" && part.tool === "task") {
          if (taskSubagent(part) !== agent) continue;
          if (taskStillRunning(part)) continue;
          const out = textOf(part.state);
          if (out) taskText = out;
        }
        if (part?.type === "text" && part.text && msgAgent === agent) {
          assistantText = part.text;
        }
      }
    }
    return taskText || assistantText;
  } catch {
    return "";
  }
}

/** @deprecated alias kept for tests */
export const readReviewerTaskOutput = readReviewerOutput;

function freshRecordedVerdict(state, agent, beforeSeq) {
  const v = state?.latestVerdict?.[agent];
  if (!v || (v.verdict !== "PASS" && v.verdict !== "FAIL")) return null;
  if ((v.seq || 0) <= beforeSeq) return null;
  if ((v.seq || 0) <= (state.lastEditSeq || 0)) return null;
  return v;
}

/** Launch every reviewer in one batched subtask prompt (parallel on the host). */
async function launchReviewBatch(client, sessionID, agents, state, model, { sleep, idleDeferMs }) {
  if (!agents.length) return;
  if (idleDeferMs > 0) await sleep(idleDeferMs);
  await promptSubtaskWithRetry(
    client,
    sessionID,
    {
      agent: "goal",
      ...(model ? { model } : {}),
      parts: agents.map((agent) => ({
        type: "subtask",
        agent,
        description: `${prettyAgentName(agent)} review`,
        prompt: reviewerPrompt(agent, state),
      })),
    },
    { sleep },
  );
}

/**
 * Poll until ONE reviewer finishes (output stabilizes) or the guard hook records
 * a fresh verdict — so an interim mid-stream verdict can't be latched.
 */
async function waitForReviewer(client, sessionID, agent, state, { timeoutMs, pollMs, sleep }) {
  const beforeSeq = state?.latestVerdict?.[agent]?.seq || 0;
  const start = Date.now();
  let prevText = null;
  let stable = "";
  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs);
    const hooked = freshRecordedVerdict(state, agent, beforeSeq);
    if (hooked) {
      return { agent, verdict: hooked.verdict, text: hooked.text || "", source: "hook" };
    }
    const text = await readReviewerOutput(client, sessionID, agent);
    if (text && text === prevText) {
      stable = text;
      break;
    }
    prevText = text;
  }
  const finalText = stable || prevText || "";
  const hooked = freshRecordedVerdict(state, agent, beforeSeq);
  if (hooked) {
    return { agent, verdict: hooked.verdict, text: hooked.text || finalText, source: "hook" };
  }
  return { agent, verdict: parseVerdict(finalText), text: finalText, source: "transcript" };
}

function applyReviewerResult(store, state, agent, { verdict, text, source, beforeSeq }) {
  const hooked = freshRecordedVerdict(state, agent, beforeSeq);
  if (hooked) {
    return hooked.verdict === "PASS" ? "passed" : "failed";
  }
  if (verdict) {
    if (source === "transcript") {
      recordVerdict(store, state, agent, verdict, text || `programmatic review (${agent}): Verdict: ${verdict}`);
    }
    return verdict === "PASS" ? "passed" : "failed";
  }
  return "failed";
}

/**
 * Run ONE review cycle: launch every required reviewer that is not currently
 * fresh-passing **in parallel**, wait for all to finish, record each verdict
 * (cycle-closing auditor last so one batch = one cycle), and report the outcome.
 *
 * @returns {{ ran: string[], passed: string[], failed: string[], completionAllowed: boolean, reviewCycles: number, findings: string[] }}
 */
export async function runReviewCycle(client, store, state, config, opts = {}) {
  const {
    sessionID,
    model = null,
    log = () => {},
    timeoutMs = 6 * 60 * 1000,
    pollMs = 2500,
    sleep = realSleep,
    idleDeferMs = 0,
  } = opts;
  if (!sessionID) {
    return { ran: [], passed: [], failed: [], findings: [], completionAllowed: completionAllowed(state, config), reviewCycles: state.reviewCycles };
  }
  const required = requiredGates(state, config);
  const toRun = required.filter((g) => !gatePassedFresh(state, g));
  if (!toRun.length) {
    return {
      ran: [],
      passed: [],
      failed: [],
      sessionBusy: false,
      findings: [],
      completionAllowed: completionAllowed(state, config),
      reviewCycles: state.reviewCycles,
    };
  }

  for (const agent of toRun) log(`launching reviewer subtask: ${agent}`);

  try {
    await launchReviewBatch(client, sessionID, toRun, state, model, { sleep, idleDeferMs });
  } catch (err) {
    if (isSessionBusyError(err)) {
      return {
        ran: [],
        passed: [],
        failed: [],
        sessionBusy: true,
        findings: [],
        completionAllowed: completionAllowed(state, config),
        reviewCycles: state.reviewCycles,
      };
    }
    return {
      ran: toRun,
      passed: [],
      failed: toRun,
      sessionBusy: false,
      findings: [],
      completionAllowed: completionAllowed(state, config),
      reviewCycles: state.reviewCycles,
    };
  }

  const waitOpts = { timeoutMs, pollMs, sleep };
  const outcomes = await Promise.all(toRun.map((agent) => waitForReviewer(client, sessionID, agent, state, waitOpts)));

  const ran = [];
  const passed = [];
  const failed = [];
  const beforeSeq = Object.fromEntries(toRun.map((agent) => [agent, state?.latestVerdict?.[agent]?.seq || 0]));
  const recordOrder = [...toRun.filter((a) => a !== CYCLE_CLOSING_AGENT), ...toRun.filter((a) => a === CYCLE_CLOSING_AGENT)];

  for (const agent of recordOrder) {
    const outcome = outcomes.find((o) => o.agent === agent);
    if (!outcome) continue;
    ran.push(agent);
    const bucket = applyReviewerResult(store, state, agent, { ...outcome, beforeSeq: beforeSeq[agent] });
    (bucket === "passed" ? passed : failed).push(agent);
  }

  maybeClearDirtyOnFinalPass(state, config);

  const findings = (state.reviewerMemory || [])
    .filter((m) => (m.status || "open") === "open")
    .slice(-8)
    .map((m) => `${prettyAgentName(m.agent)}: ${m.finding}`);

  return {
    ran,
    passed,
    failed,
    sessionBusy: false,
    findings,
    completionAllowed: completionAllowed(state, config),
    reviewCycles: state.reviewCycles,
  };
}
