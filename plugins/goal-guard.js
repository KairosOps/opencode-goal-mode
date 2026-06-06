import { createHash } from "node:crypto";

const WRITE_TOOLS = new Set(["edit", "write", "apply_patch"]);

const MUTATING_BASH_PATTERNS = [
  /(^|&&|;|\|\|)\s*(sudo\s+)?(rm|mv|cp|mkdir|rmdir|touch|ln)\b/i,
  /(^|&&|;|\|\|)\s*(sudo\s+)?(tee|xargs\s+(rm|mv|cp))\b/i,
  /(^|&&|;|\|\|)\s*[^|]*\s(>|>>)\s*(?!\/dev\/null\b)\S+/i,
  /(^|&&|;|\|\|)\s*(perl\s+-pi|sed\s+-i)\b/i,
  /(^|&&|;|\|\|)\s*(npm|pnpm|yarn|bun)\s+(install|ci|add|remove|update)\b/i,
  /(^|&&|;|\|\|)\s*(npm|pnpm|yarn|bun)\s+(run\s+)?(format|fix|lint:fix)\b/i,
  /\b((npx|pnpm\s+exec|yarn)\s+)?(prettier|eslint)\b.*\s(--write|--fix)\b/i,
  /\b(node|python3?)\b.*\b(writeFile|appendFile|copyFile|rename|unlink|rmSync|mkdir|rmdir|openSync)\b/i,
];

const REVIEW_AGENTS = new Set([
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
  "goal-api-reviewer",
  "goal-data-reviewer",
  "goal-perf-reviewer",
  "goal-quality-gate",
]);

const GOAL_AGENTS = new Set([
  "goal",
  "goal-implementer",
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
  "goal-deep-researcher",
  "goal-web-researcher",
  "goal-architect",
  "goal-mapper",
  "goal-planner",
  "goal-coordinator",
  "goal-doc-writer",
  "goal-commentator",
  "goal-api-reviewer",
  "goal-data-reviewer",
  "goal-perf-reviewer",
  "goal-quality-gate",
]);

function normalizedAgent(input) {
  if (!input) return undefined;
  const agent = String(input.agent || input.args?.subagent_type || "").trim();
  return agent || undefined;
}

function createState() {
  return {
    active: false,
    dirty: false,
    dirtyReasons: [],
    reviewCycles: 0,
    lastReviewAt: null,
    lastEditAt: null,
    lastVerificationAt: null,
    verdicts: [],
    latestVerdict: {},
    currentAgent: undefined,
    completedBlocked: 0,
    verificationSeen: false,
    lastCompletionRejectAt: null,
  };
}

const sessions = new Map();
const MAX_SESSIONS = 200;

function evictOldestSession() {
  if (sessions.size < MAX_SESSIONS) return;
  let oldestKey = null;
  let oldestTime = Infinity;
  for (const [key, state] of sessions) {
    const t = new Date(state.lastEditAt || state.lastReviewAt || 0).getTime();
    if (t < oldestTime) {
      oldestTime = t;
      oldestKey = key;
    }
  }
  if (oldestKey) sessions.delete(oldestKey);
}

function stateFor(sessionID) {
  const key = String(sessionID || "default").trim() || "default";
  if (!sessions.has(key)) {
    while (sessions.size >= MAX_SESSIONS) evictOldestSession();
    sessions.set(key, createState());
  }
  return sessions.get(key);
}

function nowIso() {
  return new Date().toISOString();
}

function textOf(output) {
  const raw = output?.output || output?.text || output?.message || "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw?.output) return String(raw.output);
  if (typeof raw === "object" && raw?.text) return String(raw.text);
  return JSON.stringify(raw || "");
}

function isPass(text) {
  return /Verdict:\s*PASS\b/i.test(text);
}

function isFail(text) {
  return /Verdict:\s*FAIL\b/i.test(text);
}

function isVerification(command) {
  const normalized = String(command || "").trim();
  return [
    /\bnpm\s+test\b/,
    /\bnpm\s+run\s+test\b/,
    /\bnpm\s+run\s+validate\b/,
    /\bnpm\s+run\s+check\b/,
    /\bnpm\s+run\s+lint\b/,
    /\bnpm\s+run\s+typecheck\b/,
    /\bnpm\s+run\s+build\b/,
    /\bnpm\s+run\s+unit\b/,
    /\bnpm\s+run\s+integration\b/,
    /\bjest\b/,
    /\bmocha\b/,
    /\bvite\s+test\b/,
    /\bvitest\b/,
    /\bpnpm\s+test\b/,
    /\byarn\s+test\b/,
    /\bbun\s+test\b/,
    /\bgo\s+test\b/,
    /\bcargo\s+test\b/,
    /\bpytest\b/,
    /\bpython\s+-m\s+pytest\b/,
    /\bpython\s+-m\s+unittest\b/,
    /\bphpunit\b/,
    /\bmake\s+test\b/,
    /\bmake\s+check\b/,
    /\bmake\s+validate\b/,
  ].some((pattern) => pattern.test(normalized));
}

function looksLikeDestructiveBash(command) {
  const normalized = String(command || "").trim();
  return [
    /(^|&&|;|\|\|)\s*(sudo\s+)?rm\s+-[a-zA-Z]*[rR][a-zA-Z]*[rfRF]?\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?rm\s+(--recursive|--force|--recursive\s+--force|-rf|-fr|-r)\b/,
    /(^|&&|;|\|\|)\s*git\s+reset\b/,
    /(^|&&|;|\|\|)\s*git\s+clean\b/,
    /(^|&&|;|\|\|)\s*git\s+checkout\b/,
    /(^|&&|;|\|\|)\s*git\s+restore\b/,
    /(^|&&|;|\|\|)\s*git\s+switch\b/,
    /(^|&&|;|\|\|)\s*git\s+push\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?find\b.*\s-delete\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?find\b.*\s-exec\s+rm\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?dd\b.*\bof=\/dev\//,
    /(^|&&|;|\|\|)\s*(sudo\s+)?mkfs(\.|\s|$)/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?shred\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?truncate\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?chmod\s+-[a-zA-Z]*[rR][a-zA-Z]*[wW][a-zA-Z]*[xX][a-zA-Z]*\s+\/\b/,
  ].some((pattern) => pattern.test(normalized));
}

function looksLikeMutatingBash(command) {
  const normalized = String(command || "").trim();
  if (!normalized) return false;
  if (looksLikeDestructiveBash(normalized)) return true;
  return MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function commandFingerprint(command) {
  return createHash("sha256").update(String(command || "")).digest("hex").slice(0, 12);
}

function latestVerdictFor(state, agent) {
  const entries = state.verdicts.filter((entry) => entry.agent === agent);
  if (!entries.length) return null;
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
}

function recordReviewVerdict(state, agent, verdict, at) {
  state.verdicts.push({ agent, verdict, at });
  state.latestVerdict[agent] = { verdict, at };
  state.lastReviewAt = at;
  if (agent === "goal-final-auditor") {
    state.reviewCycles += 1;
  }
}

function verdictAfter(state, agent, since) {
  const latest = latestVerdictFor(state, agent);
  if (!latest) return false;
  if (latest.verdict !== "PASS") return false;
  if (!since) return true;
  return latest.at >= since;
}

const BASE_GATES = [
  "goal-prompt-auditor",
  "goal-reviewer",
  "goal-diff-reviewer",
  "goal-verifier",
  "goal-final-auditor",
];

const CONTEXTUAL_GATES = {
  security: "goal-security-reviewer",
  permissions: "goal-security-reviewer",
  auth: "goal-security-reviewer",
  shell: "goal-security-reviewer",
  test: "goal-test-reviewer",
  coverage: "goal-test-reviewer",
  ops: "goal-ops-reviewer",
  restart: "goal-ops-reviewer",
  install: "goal-ops-reviewer",
  api: "goal-api-reviewer",
  endpoint: "goal-api-reviewer",
  schema: "goal-api-reviewer",
  data: "goal-data-reviewer",
  database: "goal-data-reviewer",
  migration: "goal-data-reviewer",
  performance: "goal-perf-reviewer",
  latency: "goal-perf-reviewer",
  quality: "goal-quality-gate",
  standard: "goal-quality-gate",
};

function requiredGates(state, promptText, changedFilesText) {
  const since = [state.lastEditAt, state.lastVerificationAt].filter(Boolean).sort().at(-1);
  const text = `${promptText || ""} ${(changedFilesText || state.dirtyReasons.join(" ") || "")}`.toLowerCase();
  const gates = [...BASE_GATES];
  for (const [keyword, agent] of Object.entries(CONTEXTUAL_GATES)) {
    if (text.includes(keyword) && !gates.includes(agent)) gates.push(agent);
  }
  return { since, gates };
}

function missingGates(state) {
  const { since, gates } = requiredGates(state);
  return gates.filter((agent) => !verdictAfter(state, agent, since));
}

function completionAllowed(state) {
  return state.active && missingGates(state).length === 0;
}

function summarizeState(state) {
  const verdictSummary = state.verdicts.slice(-8).map((v) => `${v.agent}:${v.verdict}`).join(", ") || "none";
  return [
    `dirty=${state.dirty}`,
    `reviewCycles=${state.reviewCycles}`,
    `lastEditAt=${state.lastEditAt || "none"}`,
    `lastReviewAt=${state.lastReviewAt || "none"}`,
    `recentVerdicts=${verdictSummary}`,
    `dirtyReasons=${state.dirtyReasons.slice(-5).join(" | ") || "none"}`,
  ].join("; ");
}

export async function GoalGuardPlugin({ client }) {
  return {
    async "chat.params"(input) {
      if (!input?.sessionID || typeof input.sessionID !== "string") return;
      const normalized = input.sessionID.trim();
      if (!normalized) return;
      const state = stateFor(normalized);
      state.currentAgent = input.agent;
      if (GOAL_AGENTS.has(input.agent)) state.active = true;
    },

    async "tool.execute.before"(input, output) {
      const state = stateFor(input.sessionID);
      const command = output?.args?.command || input?.args?.command;
      if (input.tool === "bash" && looksLikeDestructiveBash(command)) {
        state.active = true;
        state.dirtyReasons.push(`blocked risky bash fingerprint:${commandFingerprint(command)}`);
        throw new Error(
          "Goal Guard blocked a destructive or high-risk bash command. Ask the user or use a safer command."
        );
      }
      if (input.tool === "write" || input.tool === "edit" || input.tool === "apply_patch") {
        state.dirty = true;
        state.lastEditAt = nowIso();
        state.dirtyReasons.push(`${input.tool} at ${state.lastEditAt}`);
      }
    },

    async "tool.execute.after"(input, output) {
      const state = stateFor(input.sessionID);
      const agent = state.currentAgent;
      const invokedReviewAgent = normalizedAgent(input);
      const at = nowIso();
      let recordedReviewAgent = null;

      if (agent && GOAL_AGENTS.has(agent)) state.active = true;

      if (WRITE_TOOLS.has(input.tool)) {
        state.dirty = true;
        state.lastEditAt = at;
        state.dirtyReasons.push(`${input.tool} at ${at}`);
      }

      const isReviewing = REVIEW_AGENTS.has(state.currentAgent);
      if (input.tool === "bash") {
        const command = String(input?.args?.command || "");
        if (isVerification(command) && !isReviewing) {
          state.verificationSeen = true;
          state.lastVerificationAt = at;
        }
        if (!looksLikeDestructiveBash(command) && looksLikeMutatingBash(command) && !isReviewing) {
          state.dirty = true;
          state.lastEditAt = at;
          state.dirtyReasons.push(`bash mutation fingerprint:${commandFingerprint(command)}`);
        }
      }

      if (input.tool === "task" && REVIEW_AGENTS.has(invokedReviewAgent)) {
        const out = textOf(output);
        const failFirst = isFail(out);
        const passAfter = isPass(out) && !failFirst;
        if (!failFirst && !passAfter) return;
        const verdict = passAfter ? "PASS" : "FAIL";
        recordReviewVerdict(state, invokedReviewAgent, verdict, at);
        recordedReviewAgent = invokedReviewAgent;
      }

      if (agent && REVIEW_AGENTS.has(agent)) {
        const out = textOf(output);
        if (/Verdict:\s*(PASS|FAIL)\b/i.test(out)) {
          const failFirst = isFail(out);
          const passAfter = isPass(out) && !failFirst;
          if (!failFirst && !passAfter) return;
          const verdict = passAfter ? "PASS" : "FAIL";
          recordReviewVerdict(state, agent, verdict, at);
          recordedReviewAgent = agent;
        }
      }

      if (
        recordedReviewAgent === "goal-final-auditor" &&
        latestVerdictFor(state, recordedReviewAgent)?.verdict === "PASS" &&
        completionAllowed(state)
      ) {
        state.dirty = false;
        state.dirtyReasons = [];
      }
    },

    async "experimental.session.compacting"(input, output) {
      const state = stateFor(input.sessionID);
      output.context.push(`Goal Guard state: ${summarizeState(state)}. Preserve Goal Contract, Verification Ledger, Review Ledger, review cycle count, dirty state, and open findings across compaction.`);
    },

    async "experimental.text.complete"(input, output) {
      const state = stateFor(input.sessionID);
      const text = output.text || "";
      const claimsCompletion = /Goal Completed/i.test(text);
      const completedMatch = text.match(/Review cycles:\s*(\d+)/i);
      const claimedCycles = completedMatch ? parseInt(completedMatch[1], 10) : -1;

      if (!claimsCompletion) return;

      if (claimedCycles < 0) {
        state.completedBlocked += 1;
        output.text = text.replace(/Goal Completed/i, "Goal Not Completed");
        output.text += `\n\nGoal Guard blocked completion: missing required Review cycles line. State: ${summarizeState(state)}`;
      } else if (state.reviewCycles === 0) {
        state.completedBlocked += 1;
        output.text = text.replace(/Goal Completed/i, "Goal Not Completed");
        output.text += `\n\nGoal Guard blocked completion: no review cycles recorded. State: ${summarizeState(state)}`;
      } else if (claimedCycles !== state.reviewCycles) {
        state.completedBlocked += 1;
        output.text = text.replace(/Goal Completed/i, "Goal Not Completed");
        output.text += `\n\nGoal Guard blocked completion: claimed review cycles (${claimedCycles}) do not match recorded review cycles (${state.reviewCycles}). State: ${summarizeState(state)}`;
      } else if (!completionAllowed(state)) {
        state.completedBlocked += 1;
        output.text = text.replace(/Goal Completed/i, "Goal Not Completed");
        output.text += `\n\nGoal Guard blocked completion: required review gates are missing or stale (${missingGates(state).join(", ") || "goal session not active"}). State: ${summarizeState(state)}`;
      }
    },

    async event({ event }) {
      if (event?.type === "session.idle" && event?.properties?.sessionID) {
        const state = stateFor(event.properties.sessionID);
        if (state.dirty) {
          await client.app.log({
            body: {
              service: "goal-guard",
              level: "warn",
              message: "Goal session idle while dirty or review-stale",
              extra: { state: summarizeState(state) },
            },
          });
        }
      }
    },
  };
}

export default GoalGuardPlugin;
export const __test = {
  createState,
  stateFor,
  sessions,
  looksLikeDestructiveBash,
  looksLikeMutatingBash,
  isVerification,
  summarizeState,
};
