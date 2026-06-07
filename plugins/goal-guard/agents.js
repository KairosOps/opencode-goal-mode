/**
 * Canonical agent identities and gating maps for Goal Mode.
 *
 * Keeping these in one module means the plugin, the system-prompt injector and
 * the tests all agree on exactly which agents exist, which are review gates,
 * and which contextual keywords pull in which specialist reviewer.
 */

/** Read-only review/verification gates that emit `Verdict: PASS|FAIL`. */
export const REVIEW_AGENTS = Object.freeze([
  "goal-reviewer",
  "goal-prompt-auditor",
  "goal-diff-reviewer",
  "goal-verifier",
  "goal-test-reviewer",
  "goal-security-reviewer",
  "goal-ux-reviewer",
  "goal-ops-reviewer",
  "goal-doc-reviewer",
  "goal-final-auditor",
  "goal-completion-guard",
  "goal-api-reviewer",
  "goal-data-reviewer",
  "goal-perf-reviewer",
  "goal-quality-gate",
]);

/** Every agent that belongs to Goal Mode (primary + workers + reviewers). */
export const GOAL_AGENTS = Object.freeze([
  "goal",
  "goal-implementer",
  "goal-explorer",
  "goal-researcher",
  "goal-deep-researcher",
  "goal-web-researcher",
  "goal-architect",
  "goal-mapper",
  "goal-planner",
  "goal-coordinator",
  "goal-doc-writer",
  "goal-commentator",
  ...REVIEW_AGENTS,
]);

const REVIEW_SET = new Set(REVIEW_AGENTS);
const GOAL_SET = new Set(GOAL_AGENTS);

export function isReviewAgent(name) {
  return REVIEW_SET.has(String(name || ""));
}

export function isGoalAgent(name) {
  return GOAL_SET.has(String(name || ""));
}

/** Reviewers that always run for any meaningful goal. */
export const BASE_GATES = Object.freeze([
  "goal-prompt-auditor",
  "goal-reviewer",
  "goal-diff-reviewer",
  "goal-verifier",
  "goal-final-auditor",
]);

/**
 * Keyword → specialist reviewer. When the captured goal text or the set of
 * changed files mentions one of these keywords, the corresponding reviewer
 * becomes a required gate. Keys are matched as whole words against lowercased
 * text so that `api` does not match `capital`.
 */
export const CONTEXTUAL_GATES = Object.freeze({
  security: "goal-security-reviewer",
  secure: "goal-security-reviewer",
  vulnerability: "goal-security-reviewer",
  secret: "goal-security-reviewer",
  secrets: "goal-security-reviewer",
  password: "goal-security-reviewer",
  credential: "goal-security-reviewer",
  permission: "goal-security-reviewer",
  permissions: "goal-security-reviewer",
  auth: "goal-security-reviewer",
  authentication: "goal-security-reviewer",
  token: "goal-security-reviewer",
  shell: "goal-security-reviewer",
  test: "goal-test-reviewer",
  tests: "goal-test-reviewer",
  coverage: "goal-test-reviewer",
  spec: "goal-test-reviewer",
  ops: "goal-ops-reviewer",
  restart: "goal-ops-reviewer",
  install: "goal-ops-reviewer",
  installer: "goal-ops-reviewer",
  deploy: "goal-ops-reviewer",
  deployment: "goal-ops-reviewer",
  rollback: "goal-ops-reviewer",
  api: "goal-api-reviewer",
  endpoint: "goal-api-reviewer",
  endpoints: "goal-api-reviewer",
  schema: "goal-api-reviewer",
  contract: "goal-api-reviewer",
  data: "goal-data-reviewer",
  database: "goal-data-reviewer",
  migration: "goal-data-reviewer",
  migrations: "goal-data-reviewer",
  sql: "goal-data-reviewer",
  performance: "goal-perf-reviewer",
  perf: "goal-perf-reviewer",
  latency: "goal-perf-reviewer",
  throughput: "goal-perf-reviewer",
  scalability: "goal-perf-reviewer",
  ux: "goal-ux-reviewer",
  ui: "goal-ux-reviewer",
  accessibility: "goal-ux-reviewer",
  usability: "goal-ux-reviewer",
  docs: "goal-doc-reviewer",
  documentation: "goal-doc-reviewer",
  readme: "goal-doc-reviewer",
  quality: "goal-quality-gate",
  standards: "goal-quality-gate",
});

/** The reviewer that, when it returns a verdict, closes one review cycle. */
export const CYCLE_CLOSING_AGENT = "goal-final-auditor";
