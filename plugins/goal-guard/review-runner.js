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
 * top-level sessions.
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

function isSessionBusyError(err) {
  const name = String(err?.name || "");
  const msg = String(err?.message || err || "");
  return name === "SessionBusyError" || /SessionBusy|session busy|session is busy/i.test(msg);
}

/** promptAsync rejects with SessionBusy while the host is still finishing idle — retry. */
async function promptSubtaskWithRetry(client, sessionID, body, { sleep, maxAttempts = 16, retryMs = 400 }) {
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

/**
 * Launch ONE reviewer subagent as a subtask on the goal session and return its verdict.
 * Polls until the reviewer FINISHES streaming (output stabilizes) or the guard hook
 * records a fresh verdict via tool.execute.after — so an interim mid-stream verdict
 * can't be latched.
 */
async function runReviewer(client, sessionID, agent, state, model, { timeoutMs, pollMs, sleep, idleDeferMs }) {
  const beforeSeq = state?.latestVerdict?.[agent]?.seq || 0;
  try {
    if (idleDeferMs > 0) await sleep(idleDeferMs);
    await promptSubtaskWithRetry(
      client,
      sessionID,
      {
        agent: "goal",
        ...(model ? { model } : {}),
        noReply: true,
        parts: [
          {
            type: "subtask",
            agent,
            description: `${prettyAgentName(agent)} review`,
            prompt: reviewerPrompt(agent, state),
          },
        ],
      },
      { sleep },
    );
    const start = Date.now();
    let prevText = null;
    let stable = "";
    while (Date.now() - start < timeoutMs) {
      await sleep(pollMs);
      const hooked = freshRecordedVerdict(state, agent, beforeSeq);
      if (hooked) {
        return { verdict: hooked.verdict, text: hooked.text || "", source: "hook" };
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
      return { verdict: hooked.verdict, text: hooked.text || finalText, source: "hook" };
    }
    return { verdict: parseVerdict(finalText), text: finalText, source: "transcript" };
  } catch (err) {
    const hooked = freshRecordedVerdict(state, agent, beforeSeq);
    if (hooked) return { verdict: hooked.verdict, text: hooked.text || "", source: "hook" };
    return { verdict: null, text: "", error: String(err?.message || err) };
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
  toRun.sort((a, b) => (a === CYCLE_CLOSING_AGENT ? 1 : 0) - (b === CYCLE_CLOSING_AGENT ? 1 : 0));

  const ran = [];
  const passed = [];
  const failed = [];
  for (const agent of toRun) {
    log(`launching reviewer subtask: ${agent}`);
    const beforeSeq = state?.latestVerdict?.[agent]?.seq || 0;
    const { verdict, text, source } = await runReviewer(client, sessionID, agent, state, model, {
      timeoutMs,
      pollMs,
      sleep,
      idleDeferMs: ran.length === 0 ? idleDeferMs : 0,
    });
    ran.push(agent);
    const hooked = freshRecordedVerdict(state, agent, beforeSeq);
    if (hooked) {
      (hooked.verdict === "PASS" ? passed : failed).push(agent);
      continue;
    }
    if (verdict) {
      if (source === "transcript") {
        recordVerdict(store, state, agent, verdict, text || `programmatic review (${agent}): Verdict: ${verdict}`);
      }
      (verdict === "PASS" ? passed : failed).push(agent);
    } else {
      failed.push(agent);
    }
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
    findings,
    completionAllowed: completionAllowed(state, config),
    reviewCycles: state.reviewCycles,
  };
}
