/**
 * Verdict extraction and recording.
 *
 * Fixes versus the original:
 *  - Last-verdict-wins. A reviewer transcript that says
 *    "previously Verdict: FAIL, after fixes Verdict: PASS" records PASS, not
 *    FAIL. The reviewer's FINAL line is its conclusion.
 *  - Line-anchored matching is preferred, so a `Verdict: PASS` buried in quoted
 *    context or tool metadata does not register a gate the reviewer never
 *    actually rendered.
 *  - The `<task><task_result>…</task_result></task>` wrapper that the task tool
 *    puts around a subagent's output is unwrapped before scanning.
 */

import { CYCLE_CLOSING_AGENT } from "./agents.js";

const TASK_RESULT_RE = /<task_result>([\s\S]*?)<\/task_result>/i;
const ANCHORED_RE = /^[ \t>*_-]*\*{0,2}Verdict:?\*{0,2}[\s*_]*(PASS|FAIL)\b/gim;
const LOOSE_RE = /Verdict:?\*{0,2}[\s*_]*(PASS|FAIL)\b/gi;

/** Pull the human-readable text out of a tool/subagent output object. */
export function textOf(output) {
  if (output == null) return "";
  if (typeof output === "string") return output;
  const raw = output.output ?? output.text ?? output.message ?? output.title ?? "";
  let text;
  if (typeof raw === "string") text = raw;
  else if (raw && typeof raw === "object") text = raw.output ?? raw.text ?? JSON.stringify(raw);
  else text = String(raw ?? "");
  const m = TASK_RESULT_RE.exec(text);
  return m ? m[1] : text;
}

/**
 * Extract the final verdict from a body of text.
 *
 * True textual last-wins: a reviewer's FINAL `Verdict: …` line is its
 * conclusion. We scan ALL matches (loose) and take the one with the greatest
 * position, using line-anchored matches only as a tiebreak when an anchored and
 * a loose match share the same end position. The earlier "prefer the anchored
 * set whenever any anchored match exists" logic was a critical bug: a transcript
 * like "Verdict: PASS (happy path)\nHowever, Verdict: FAIL — blocking" has only
 * the early PASS anchored (the FAIL line starts with "However,"), so it wrongly
 * returned PASS and let a failing final review complete the goal.
 *
 * @returns {"PASS"|"FAIL"|null}
 */
export function parseVerdict(text) {
  if (typeof text !== "string" || !text) return null;
  // A verdict ENCLOSED in quotes/backticks on its line is the marker being QUOTED
  // (an example/citation like `(a clean run ends with "Verdict: PASS")`), NOT the
  // reviewer's own conclusion — counting it let a FAIL review with a trailing quoted
  // example PASS read as PASS. Excluded only when a quote sits on BOTH sides of the
  // verdict within its line, so a real conclusion that merely mentions a quote stays.
  const hasQuote = (s) => /["'`]/.test(s);
  const quoted = (idx) => {
    const lineStart = text.lastIndexOf("\n", idx) + 1;
    let lineEnd = text.indexOf("\n", idx);
    if (lineEnd < 0) lineEnd = text.length;
    return hasQuote(text.slice(lineStart, idx)) && hasQuote(text.slice(idx, lineEnd));
  };
  const loose = [...text.matchAll(LOOSE_RE)].filter((m) => !quoted(m.index));
  if (!loose.length) return null;
  const lastLoose = loose[loose.length - 1];
  const anchored = [...text.matchAll(ANCHORED_RE)].filter((m) => !quoted(m.index));
  const lastAnchored = anchored.length ? anchored[anchored.length - 1] : null;
  // Prefer whichever genuinely occurs last in the text; on a tie, the anchored
  // (conclusion-formatted) one wins.
  const lastAnchoredEnd = lastAnchored ? lastAnchored.index + lastAnchored[0].length : -1;
  const lastLooseEnd = lastLoose.index + lastLoose[0].length;
  const chosen = lastAnchoredEnd >= lastLooseEnd && lastAnchored ? lastAnchored : lastLoose;
  return chosen[1].toUpperCase();
}

export function hasVerdict(text) {
  return parseVerdict(text) !== null;
}

export function latestVerdictFor(state, agent) {
  return state.latestVerdict[agent] || null;
}

function summarizeFinding(text) {
  const headingRe = /^(blocking findings?|findings?|non-blocking findings?|open questions?|summary|verdict|blocking|issues?)[:\s]*$/i;
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s>*_-]+/, "").trim())
    .filter(Boolean)
    .filter((line) => !headingRe.test(line))
    .filter((line) => !/^verdict:?\s*(pass|fail)\b/i.test(line));
  const blocking = lines.find((line) => /block|fail|finding|risk|missing|gap|regression/i.test(line));
  return String(blocking || lines[0] || "Reviewer reported a blocking finding.").slice(0, 240);
}

function updateReviewerMemory(state, agent, verdict, at, seq, text) {
  state.reviewerMemory ||= [];
  if (verdict === "PASS") {
    for (const item of state.reviewerMemory) {
      if (item.agent === agent && item.status === "open") {
        item.status = "resolved";
        item.resolvedAt = at;
        item.resolvedSeq = seq;
      }
    }
    return;
  }
  const finding = summarizeFinding(text);
  const open = state.reviewerMemory.find((item) => item.agent === agent && item.status === "open" && item.finding === finding);
  if (open) {
    open.lastAt = at;
    open.lastSeq = seq;
    open.count += 1;
  } else {
    state.reviewerMemory.push({ agent, finding, severity: "blocking", status: "open", firstAt: at, firstSeq: seq, lastAt: at, lastSeq: seq, count: 1 });
  }
  if (state.reviewerMemory.length > 100) state.reviewerMemory.splice(0, state.reviewerMemory.length - 100);
}

/**
 * Record a review verdict for `agent`, stamping it with the next monotonic seq.
 * Increments the review-cycle count when the cycle-closing agent reports.
 */
export function recordVerdict(store, state, agent, verdict, text = "") {
  const at = store.nowIso();
  const seq = store.nextSeq();
  const entry = { agent, verdict, at, seq };
  state.verdicts.push(entry);
  if (state.verdicts.length > 200) state.verdicts.splice(0, state.verdicts.length - 200);
  state.latestVerdict[agent] = { verdict, at, seq };
  updateReviewerMemory(state, agent, verdict, at, seq, text);
  state.lastReviewAt = at;
  state.lastReviewSeq = seq;
  state.updatedAt = at;
  if (agent === CYCLE_CLOSING_AGENT) state.reviewCycles += 1;
  return entry;
}
