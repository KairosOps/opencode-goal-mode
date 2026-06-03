import { createHash } from "node:crypto";

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
]);

const WRITE_TOOLS = new Set(["edit", "write", "apply_patch"]);

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
]);

function createState() {
  return {
    active: false,
    dirty: false,
    dirtyReasons: [],
    reviewCycles: 0,
    lastReviewAt: null,
    lastEditAt: null,
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
  return String(output?.output || "");
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
    /(^|&&|;|\|\|)\s*git\s+reset\b/,
    /(^|&&|;|\|\|)\s*git\s+clean\b/,
    /(^|&&|;|\|\|)\s*git\s+checkout\s+--\b/,
    /(^|&&|;|\|\|)\s*git\s+push\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?find\b.*\s-delete\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?dd\b.*\bof=\/dev\//,
    /(^|&&|;|\|\|)\s*(sudo\s+)?mkfs(\.|\s|$)/,
  ].some((pattern) => pattern.test(normalized));
}

function commandFingerprint(command) {
  return createHash("sha256").update(String(command || "")).digest("hex").slice(0, 12);
}

function verdictAfter(state, agent, since) {
  return state.verdicts.some((entry) => entry.agent === agent && entry.verdict === "PASS" && (!since || entry.at >= since));
}

function requiredGates(state) {
  const since = state.lastEditAt;
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
          state.dirtyReasons.push(`verification command fingerprint:${commandFingerprint(command)}`);
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
          if (verdict === "PASS" && agent === "goal-final-auditor" && completionAllowed(state)) {
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
      if (/Goal Completed/i.test(output.text || "") && !completionAllowed(state)) {
        state.completedBlocked += 1;
        output.text = output.text.replace(/Goal Completed/i, "Goal Not Completed");
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
