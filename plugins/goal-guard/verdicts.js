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
const ANCHORED_RE = /^[ \t>*_-]*Verdict:\s*\*{0,2}(PASS|FAIL)\b/gim;
const LOOSE_RE = /Verdict:\s*\*{0,2}(PASS|FAIL)\b/gi;

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
 * @returns {"PASS"|"FAIL"|null}
 */
export function parseVerdict(text) {
  if (typeof text !== "string" || !text) return null;
  const anchored = [...text.matchAll(ANCHORED_RE)];
  const matches = anchored.length ? anchored : [...text.matchAll(LOOSE_RE)];
  if (!matches.length) return null;
  return matches[matches.length - 1][1].toUpperCase();
}

export function hasVerdict(text) {
  return parseVerdict(text) !== null;
}

export function latestVerdictFor(state, agent) {
  return state.latestVerdict[agent] || null;
}

/**
 * Record a review verdict for `agent`, stamping it with the next monotonic seq.
 * Increments the review-cycle count when the cycle-closing agent reports.
 */
export function recordVerdict(store, state, agent, verdict) {
  const at = store.nowIso();
  const seq = store.nextSeq();
  const entry = { agent, verdict, at, seq };
  state.verdicts.push(entry);
  if (state.verdicts.length > 200) state.verdicts.splice(0, state.verdicts.length - 200);
  state.latestVerdict[agent] = { verdict, at, seq };
  state.lastReviewAt = at;
  state.lastReviewSeq = seq;
  state.updatedAt = at;
  if (agent === CYCLE_CLOSING_AGENT) state.reviewCycles += 1;
  return entry;
}
