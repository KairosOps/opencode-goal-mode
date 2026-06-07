import { BASE_GATES } from "../plugins/goal-guard/agents.js";

const allBasePass = BASE_GATES.map((agent) => ({ agent, verdict: "PASS", seq: 10 }));

export const FALSE_COMPLETION_CORPUS = Object.freeze([
  {
    id: "missing-review-cycles-line",
    family: "false-completion",
    text: "Goal Completed\n\nAll done.",
    state: { active: true, reviewCycles: 1, lastEditSeq: 1, verdicts: allBasePass },
    expected: { blocked: true, reasonIncludes: "missing required Review cycles line" },
  },
  {
    id: "zero-review-cycles",
    family: "false-completion",
    text: "Goal Completed\n\nReview cycles: 0",
    state: { active: true, reviewCycles: 0, lastEditSeq: 1, verdicts: allBasePass },
    expected: { blocked: true, reasonIncludes: "no review cycles recorded" },
  },
  {
    id: "wrong-review-cycle-count",
    family: "false-completion",
    text: "Goal Completed\n\nReview cycles: 1",
    state: { active: true, reviewCycles: 2, lastEditSeq: 1, verdicts: allBasePass },
    expected: { blocked: true, reasonIncludes: "do not match recorded review cycles" },
  },
  {
    id: "stale-review-after-edit",
    family: "false-completion",
    text: "Goal Completed\n\nReview cycles: 1",
    state: { active: true, reviewCycles: 1, lastEditSeq: 20, verdicts: BASE_GATES.map((agent) => ({ agent, verdict: "PASS", seq: 5 })) },
    expected: { blocked: true, reasonIncludes: "required review gates are missing or stale" },
  },
  {
    id: "missing-contextual-security-gate",
    family: "false-completion",
    text: "Goal Completed\n\nReview cycles: 1",
    state: { active: true, reviewCycles: 1, lastEditSeq: 1, goalText: "fix auth token flow", verdicts: allBasePass },
    expected: { blocked: true, reasonIncludes: "goal-security-reviewer" },
  },
  {
    id: "valid-completion-allowed",
    family: "true-completion",
    text: "Goal Completed\n\nReview cycles: 1",
    state: { active: true, reviewCycles: 1, lastEditSeq: 1, verdicts: allBasePass },
    expected: { blocked: false },
  },
  {
    id: "mid-text-mention-not-policed",
    family: "true-completion",
    text: "Do not write Goal Completed until reviews pass.",
    state: { active: true, reviewCycles: 0, lastEditSeq: 1, verdicts: [] },
    expected: { blocked: false },
  },
  {
    id: "inactive-session-not-policed",
    family: "true-completion",
    text: "Goal Completed\n\nReview cycles: 0",
    state: { active: false, reviewCycles: 0, lastEditSeq: 1, verdicts: [] },
    expected: { blocked: false },
  },
  {
    id: "custom-marker-escaping",
    family: "true-completion",
    text: "Done? (yes)\n\nReview cycles: 1",
    config: { completionMarker: "Done? (yes)" },
    state: { active: true, reviewCycles: 1, lastEditSeq: 1, verdicts: allBasePass },
    expected: { blocked: false },
  },
]);
