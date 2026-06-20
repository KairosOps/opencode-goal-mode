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
  // A verdict ENCLOSED in quotes/backticks is the marker being QUOTED (an
  // example/citation like `(a clean run ends with "Verdict: PASS")`), NOT the
  // reviewer's own conclusion. The PREVIOUS heuristic checked for ANY quote on
  // BOTH sides of the verdict *anywhere on its line* — that wrongly excluded a
  // real conclusion whose line merely MENTIONED a quoted filename, ticket id, or
  // CWE number (e.g. `Found secret in "config.js". Verdict: FAIL (CWE-"798")`),
  // so a FAILING review's final verdict was dropped and an earlier example PASS
  // won — recording PASS when the reviewer actually FAILED. That breaks the guard's
  // core safety invariant (a failing review completing the goal).
  //
  // Fix: only treat a verdict as quoted when a quote char sits IMMEDIATELY around
  // the verdict token (a small window), the way a real quoted/cited span wraps it.
  // A conclusion line that just references a quoted token elsewhere stays live.
  const hasQuote = (s) => /["'`]/.test(s);
  const quoted = (idx, matchLen) => {
    const lineStart = text.lastIndexOf("\n", idx) + 1;
    let lineEnd = text.indexOf("\n", idx);
    if (lineEnd < 0) lineEnd = text.length;
    const left = text.slice(Math.max(lineStart, idx - 4), idx);
    const right = text.slice(idx, Math.min(lineEnd, idx + matchLen + 4));
    return hasQuote(left) && hasQuote(right);
  };
  const loose = [...text.matchAll(LOOSE_RE)].filter((m) => !quoted(m.index, m[0].length));
  if (!loose.length) return null;
  const lastLoose = loose[loose.length - 1];
  const anchored = [...text.matchAll(ANCHORED_RE)].filter((m) => !quoted(m.index, m[0].length));
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
  // Captured BEFORE the overwrite below: the prior cycle-closing verdict, used to
  // decide whether this one opens a genuinely new review cycle.
  const prevClosing = agent === CYCLE_CLOSING_AGENT ? state.latestVerdict[CYCLE_CLOSING_AGENT] : null;
  const entry = { agent, verdict, at, seq };
  state.verdicts.push(entry);
  if (state.verdicts.length > 200) state.verdicts.splice(0, state.verdicts.length - 200);
  state.latestVerdict[agent] = { verdict, at, seq };
  updateReviewerMemory(state, agent, verdict, at, seq, text);
  state.lastReviewAt = at;
  state.lastReviewSeq = seq;
  state.updatedAt = at;
  if (agent === CYCLE_CLOSING_AGENT) {
    // A review cycle ends when the cycle-closing auditor renders a verdict over
    // FRESH work. Count it only if this is the first closing verdict OR the agent
    // edited since the previous one. A second closing verdict with NO intervening
    // edit is the same round recorded twice — e.g. the agent ran the auditor via
    // `task` AND the guard ran it programmatically — and must not inflate the count.
    const prevSeq = prevClosing ? prevClosing.seq : -1;
    const workedSince = (state.lastEditSeq || 0) > prevSeq;
    if (!prevClosing || workedSince) state.reviewCycles += 1;
  }
  return entry;
}
