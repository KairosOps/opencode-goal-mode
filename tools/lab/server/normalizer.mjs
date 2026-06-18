/**
 * Goal Lab — the single translation layer from raw OpenCode `/event` payloads
 * (and guard-ledger diffs) into the Lab's normalized event schema.
 *
 * One normalizer instance tracks one session. It is intentionally defensive
 * about the wire format (OpenCode's event shapes vary across versions): it keys
 * tool lifecycle on the stable `part.id`, tolerates missing fields, and tags
 * every emission with the canonical kind/level/family the rest of the stack
 * understands. Nothing else in the system parses raw events.
 */

import { EVENT_KIND, EVENT_LEVEL, makeEvent } from "./schema.mjs";

const trunc = (s, n = 240) => {
  const str = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return str.length > n ? str.slice(0, n) + "…" : str;
};

const REVIEWER_RE = /reviewer|auditor|quality-gate|completion-guard|verifier|security/i;
const isGoalAgent = (a) => typeof a === "string" && /^goal-/.test(a);

/** A line that asserts an UN-negated "Goal Completed" (a raw completion claim). */
function rawCompletionClaim(text) {
  for (const l of String(text).split("\n")) {
    if (/^[\s>*_#-]*Goal\s+Completed\b/i.test(l)) return true;
  }
  return false;
}
const completionBlockedClaim = (text) => /Goal\s+Not\s+Completed/i.test(String(text));

export function createNormalizer(sessionId, emit) {
  const toolState = new Map(); // part.id -> last status seen
  const textByMessage = new Map(); // messageID -> joined text
  const flushedMessages = new Set();
  const seenSubagents = new Set();
  let currentAgent = "goal";

  const out = (e) => emit(e);

  function sidOf(p) {
    return p?.sessionID || p?.info?.sessionID || p?.part?.sessionID || null;
  }

  function flushAssistant(messageID, info) {
    if (!messageID || flushedMessages.has(messageID)) return;
    const text = textByMessage.get(messageID) || "";
    flushedMessages.add(messageID);
    if (text.trim()) {
      out(makeEvent({ kind: EVENT_KIND.MSG_TEXT, agent: currentAgent, title: "assistant", detail: trunc(text, 400), data: { messageID, length: text.length } }));
      if (completionBlockedClaim(text)) {
        out(makeEvent({ kind: EVENT_KIND.SIG_COMPLETION_BLOCKED, level: EVENT_LEVEL.SIGNAL, agent: currentAgent, title: "completion rewritten → Not Completed", detail: "the guard rewrote a premature completion claim while gates were open", data: { messageID } }));
      } else if (rawCompletionClaim(text)) {
        out(makeEvent({ kind: EVENT_KIND.SIG_COMPLETION_EARNED, level: EVENT_LEVEL.SIGNAL, agent: currentAgent, title: "raw 'Goal Completed' in output", detail: trunc(text, 200), data: { messageID, raw: true } }));
      }
    }
    if (info) {
      const tokens = info.tokens || info.usage || null;
      const cost = info.cost ?? null;
      if (tokens || cost != null) {
        out(makeEvent({ kind: EVENT_KIND.STEP_FINISH, agent: currentAgent, title: "step finished", data: { tokens, cost, messageID } }));
      }
    }
  }

  function onToolPart(part) {
    const id = part.id;
    if (!id) return;
    const st = part.state || {};
    const status = st.status || "running";
    const prev = toolState.get(id);
    const name = part.tool || "?";

    if (prev === undefined) {
      toolState.set(id, status);
      // subagent spawn
      if (name === "task") {
        const sa = st.input?.subagent_type || st.input?.agent || null;
        if (sa && !seenSubagents.has(sa)) {
          seenSubagents.add(sa);
          out(makeEvent({
            kind: EVENT_KIND.SUBAGENT,
            level: isGoalAgent(sa) ? EVENT_LEVEL.SIGNAL : EVENT_LEVEL.INFO,
            agent: currentAgent,
            tool: "task",
            title: `subagent → ${sa}`,
            detail: trunc(st.input?.description || st.input?.prompt || "", 160),
            data: { subagent: sa, reviewer: REVIEWER_RE.test(sa), goalAgent: isGoalAgent(sa) },
          }));
        }
      }
      out(makeEvent({ kind: EVENT_KIND.TOOL_START, agent: currentAgent, tool: name, title: name, detail: trunc(st.input?.command || st.input?.filePath || st.input?.description || st.input || "", 200), data: { input: st.input } }));
    }

    if (status !== prev) {
      toolState.set(id, status);
      const blob = `${st.error || ""} ${JSON.stringify(st.metadata || {})}`;
      const blocked = /Goal Guard blocked|destructive or high-risk|blocked risky/i.test(blob);
      if (blocked) {
        out(makeEvent({ kind: EVENT_KIND.SIG_SHELL_BLOCKED, level: EVENT_LEVEL.SIGNAL, agent: currentAgent, tool: name, title: "destructive command blocked", detail: trunc(st.input?.command || st.error || "", 200), data: { command: st.input?.command, error: trunc(st.error, 300) } }));
      } else if (status === "error") {
        out(makeEvent({ kind: EVENT_KIND.TOOL_ERROR, level: EVENT_LEVEL.ERROR, agent: currentAgent, tool: name, title: `${name} errored`, detail: trunc(st.error || st.output || "", 300), data: { error: trunc(st.error, 600) } }));
      } else if (status === "completed") {
        out(makeEvent({ kind: EVENT_KIND.TOOL_DONE, agent: currentAgent, tool: name, title: `${name} ✓`, detail: trunc(st.output || st.metadata?.title || "", 200) }));
      }
    }
  }

  /** Handle one raw OpenCode event. Returns true if it belonged to this session. */
  function onRaw(ev) {
    const type = ev?.type;
    const p = ev?.properties || {};
    const sid = sidOf(p);
    if (sid && sid !== sessionId) return false;
    if (!type) return false;

    if (type === "session.idle") {
      out(makeEvent({ kind: EVENT_KIND.RUN_IDLE, title: "session idle" }));
      // flush any assistant text we never saw finalized
      for (const [mid] of textByMessage) if (!flushedMessages.has(mid)) flushAssistant(mid, null);
      return true;
    }

    if (type === "message.updated" && p.info) {
      const info = p.info;
      if (info.role === "user") {
        out(makeEvent({ kind: EVENT_KIND.MSG_USER, title: "user message", data: { id: info.id } }));
      } else if (info.role === "assistant") {
        if (info.agent || info.mode) currentAgent = info.agent || info.mode || currentAgent;
        const done = !!(info.time?.completed || info.completed || info.finishReason);
        if (done) flushAssistant(info.id, info);
      }
      return true;
    }

    if ((type === "message.part.updated" || type === "message.part.delta") && p.part) {
      const part = p.part;
      if (part.type === "tool") onToolPart(part);
      else if (part.type === "text" && part.id) {
        const mid = part.messageID || part.id;
        textByMessage.set(mid, part.text || textByMessage.get(mid) || "");
      } else if (part.type === "step-finish" || part.type === "step-start") {
        // some versions surface steps as parts; ignore (covered by message.updated)
      }
      return true;
    }

    if (typeof type === "string" && /error/i.test(type)) {
      const err = p.error || p.info?.error || p;
      const msg = err?.message || err?.data?.message || JSON.stringify(err);
      const isModel = /model|provider|rate|quota|overload|token|context/i.test(String(msg));
      out(makeEvent({
        kind: isModel ? EVENT_KIND.ERR_MODEL : EVENT_KIND.ERR_SESSION,
        level: EVENT_LEVEL.ERROR,
        title: isModel ? "model/provider error" : "session error",
        detail: trunc(msg, 400),
        data: { rawType: type, error: trunc(msg, 800) },
      }));
      return true;
    }

    return false;
  }

  /** Map a guard-ledger diff (see guard-state.diffGuard) into normalized signals. */
  function onGuardDiff(diffs) {
    for (const d of diffs) {
      switch (d.kind) {
        case "contract":
          out(makeEvent({ kind: EVENT_KIND.SIG_CONTRACT, level: EVENT_LEVEL.SIGNAL, title: "Goal Contract recorded", detail: trunc(d.title, 160), data: { gates: d.gates } }));
          break;
        case "gate":
          out(makeEvent({ kind: EVENT_KIND.SIG_GATE, level: EVENT_LEVEL.SIGNAL, title: `required gate: ${d.gate}`, data: { gate: d.gate } }));
          break;
        case "verdict": {
          // The `task` tool streams empty input on this OpenCode version, so the
          // ONLY reliable place to learn which subagent ran is the verdict's own
          // `agent` field. Surface it as a first-class subagent the first time we
          // see it, so the orchestration graph + reviewer counts are accurate.
          const ag = d.verdict?.agent;
          if (ag && !seenSubagents.has(ag)) {
            seenSubagents.add(ag);
            out(makeEvent({ kind: EVENT_KIND.SUBAGENT, level: EVENT_LEVEL.SIGNAL, agent: "goal", tool: "task", title: `subagent → ${ag}`, data: { subagent: ag, reviewer: REVIEWER_RE.test(ag), goalAgent: isGoalAgent(ag) } }));
          }
          const status = d.verdict?.verdict || d.verdict?.status;
          out(makeEvent({ kind: EVENT_KIND.SIG_REVIEW, level: EVENT_LEVEL.SIGNAL, agent: ag || "goal", title: `verdict: ${ag || "review"} → ${status || "?"}`, detail: trunc(d.verdict?.summary || status || d.verdict, 200), data: { verdict: d.verdict, pass: /pass/i.test(String(status)) } }));
          break;
        }
        case "review-cycle":
          out(makeEvent({ kind: EVENT_KIND.SIG_REVIEW, level: EVENT_LEVEL.SIGNAL, title: `review cycle #${d.count}`, data: { cycle: d.count } }));
          break;
        case "completion-rejection":
          out(makeEvent({ kind: EVENT_KIND.SIG_COMPLETION_BLOCKED, level: EVENT_LEVEL.SIGNAL, title: "completion rejected by guard", detail: trunc(d.rejection?.reason || d.rejection, 240), data: { rejection: d.rejection } }));
          break;
        case "completed-blocked":
          out(makeEvent({ kind: EVENT_KIND.SIG_COMPLETION_BLOCKED, level: EVENT_LEVEL.SIGNAL, title: `completion blocked ×${d.count}`, data: { count: d.count } }));
          break;
        case "dirty":
          out(makeEvent({ kind: EVENT_KIND.SIG_DIRTY, level: EVENT_LEVEL.SIGNAL, title: "session marked dirty", detail: trunc(d.reason, 200), data: { reason: d.reason } }));
          break;
        case "autocontinue":
          out(makeEvent({ kind: EVENT_KIND.SIG_AUTOCONTINUE, level: EVENT_LEVEL.SIGNAL, title: `guard auto-continued (#${d.count})`, detail: d.noProgress ? `no-progress streak: ${d.noProgress}` : "", data: { count: d.count, noProgress: d.noProgress } }));
          break;
        default:
          break;
      }
    }
  }

  return { onRaw, onGuardDiff, currentAgent: () => currentAgent, subagents: () => [...seenSubagents] };
}
