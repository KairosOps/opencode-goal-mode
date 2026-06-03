import { createHash } from "node:crypto";

const WRITE_TOOLS = new Set(["edit", "write", "apply_patch"]);

const DEEP_RESEARCH_AGENTS = new Set([
  "goal-deep-researcher",
  "goal-web-researcher",
]);

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
    currentAgent: undefined,
    completedBlocked: 0,
    verificationSeen: false,
  };
}

const sessions = new Map();

function stateFor(sessionID) {
  if (!sessions.has(sessionID)) sessions.set(sessionID, createState());
  return sessions.get(sessionID);
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

function looksLikeDestructiveBash(command) {
  const normalized = String(command || "").trim();
  return [
    /(^|&&|;|\|\|)\s*(sudo\s+)?rm\s+-[a-zA-Z]*[rf][a-zA-Z]*[rf]?\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?rm\s+(--recursive|--force|--recursive\s+--force|-rf|-fr)\b/,
    /(^|&&|;|\|\|)\s*git\s+reset\b/,
    /(^|&&|;|\|\|)\s*git\s+clean\b/,
    /(^|&&|;|\|\|)\s*git\s+checkout\s+--?\b/,
    /(^|&&|;|\|\|)\s*git\s+push\s+--force\b/,
    /(^|&&|;|\|\|)\s*git\s+push\s+-f\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?find\b.*\s-delete\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?find\b.*\s-exec\s+rm\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?dd\b.*\bof=\/dev\//,
    /(^|&&|;|\|\|)\s*(sudo\s+)?mkfs(\.|\s|$)/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?shred\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?truncate\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?chmod\s+-[a-zA-Z]*[rR][a-zA-Z]*[wW][a-zA-Z]*[xX][a-zA-Z]*\s+\/\b/,
  ].some((pattern) => pattern.test(normalized));
}

function commandFingerprint(command) {
  return createHash("sha256").update(String(command || "")).digest("hex").slice(0, 12);
}

function verdictAfter(state, agent, since) {
  return state.verdicts.some((entry) => entry.agent === agent && entry.verdict === "PASS" && (!since || entry.at >= since));
}

function requiredGates(state) {
  const since = [state.lastEditAt, state.lastVerificationAt].filter(Boolean).sort().at(-1);
  const gates = ["goal-prompt-auditor", "goal-reviewer", "goal-verifier", "goal-final-auditor"];
  if (state.lastEditAt) gates.splice(2, 0, "goal-diff-reviewer");
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
      if (!input?.sessionID) return;
      const state = stateFor(input.sessionID);
      state.currentAgent = input.agent;
      if (GOAL_AGENTS.has(input.agent)) state.active = true;
    },

    async "tool.execute.before"(input, output) {
      const state = stateFor(input.sessionID);
      if (input.tool === "bash" && looksLikeDestructiveBash(output?.args?.command)) {
        state.active = true;
        state.dirtyReasons.push(`blocked risky bash fingerprint:${commandFingerprint(output.args.command)}`);
        throw new Error("Goal Guard blocked a destructive or high-risk bash command. Ask the user or use a safer command.");
      }
    },

    async "tool.execute.after"(input, output) {
      const state = stateFor(input.sessionID);
      const agent = state.currentAgent;
      const invokedReviewAgent = normalizedAgent(input);
      const at = nowIso();

      if (agent && GOAL_AGENTS.has(agent)) state.active = true;

      if (WRITE_TOOLS.has(input.tool)) {
        state.dirty = true;
        state.lastEditAt = at;
        state.dirtyReasons.push(`${input.tool} at ${at}`);
      }

      if (input.tool === "bash") {
        const command = String(input.args?.command || "");
        if (/\b(npm|pnpm|bun|yarn|node)\s+(test|run|--test)\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b/.test(command)) {
          state.verificationSeen = true;
          state.lastVerificationAt = at;
          state.dirtyReasons.push(`verification command fingerprint:${commandFingerprint(command)}`);
        }
      }

      if (input.tool === "task" && REVIEW_AGENTS.has(invokedReviewAgent)) {
        const out = textOf(output);
        if (isPass(out) || isFail(out)) {
          const verdict = isPass(out) ? "PASS" : "FAIL";
          state.verdicts.push({ agent: invokedReviewAgent, verdict, at });
          state.lastReviewAt = at;
          if (["goal-final-auditor", "goal-reviewer", "goal-prompt-auditor"].includes(invokedReviewAgent)) {
            state.reviewCycles += 1;
          }
          if (verdict === "PASS" && invokedReviewAgent === "goal-final-auditor" && completionAllowed(state)) {
            state.dirty = false;
            state.dirtyReasons = [];
          }
        }
      }

      if (agent && REVIEW_AGENTS.has(agent)) {
        const out = textOf(output);
        if (isPass(out) || isFail(out)) {
          const verdict = isPass(out) ? "PASS" : "FAIL";
          state.verdicts.push({ agent, verdict, at });
          state.lastReviewAt = at;
          if (agent === "goal-final-auditor" || agent === "goal-reviewer" || agent === "goal-prompt-auditor") {
            state.reviewCycles += 1;
          }
          if (["goal-final-auditor", "goal-reviewer", "goal-prompt-auditor", "goal-diff-reviewer", "goal-verifier"].includes(agent) && verdict === "PASS" && completionAllowed(state)) {
            state.dirty = false;
            state.dirtyReasons = [];
          }
        }
      }
    },

    async "experimental.session.compacting"(input, output) {
      const state = stateFor(input.sessionID);
      output.context.push(`Goal Guard state: ${summarizeState(state)}. Preserve Goal Contract, Verification Ledger, Review Ledger, review cycle count, dirty state, and open findings across compaction.`);
    },

    async "experimental.text.complete"(input, output) {
      const state = stateFor(input.sessionID);
      const text = output.text || "";
      const completedMatch = text.match(/Review cycles:\s*(\d+)/i);
      const claimedCycles = completedMatch ? parseInt(completedMatch[1], 10) : -1;

      if (/Goal Completed/i.test(text) && claimedCycles < state.reviewCycles) {
        state.completedBlocked += 1;
        output.text = text.replace(/Goal Completed/i, "Goal Not Completed");
        output.text += `\n\nGoal Guard blocked completion: claimed review cycles (${claimedCycles}) are fewer than recorded (${state.reviewCycles}). State: ${summarizeState(state)}`;
      } else if (/Goal Completed/i.test(text) && claimedCycles === 0 && state.reviewCycles === 0) {
        state.completedBlocked += 1;
        output.text = text.replace(/Goal Completed/i, "Goal Not Completed");
        output.text += `\n\nGoal Guard blocked completion: no review cycles recorded. State: ${summarizeState(state)}`;
      } else if (/Goal Completed/i.test(text) && !completionAllowed(state)) {
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
export const __test = { createState, stateFor, sessions, looksLikeDestructiveBash, summarizeState };
