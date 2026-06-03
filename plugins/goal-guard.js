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
    dirty: false,
    dirtyReasons: [],
    reviewCycles: 0,
    lastReviewAt: null,
    lastEditAt: null,
    verdicts: [],
    currentAgent: undefined,
    completedBlocked: 0,
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
    /(^|&&|;|\|\|)\s*rm\s+-rf\b/,
    /(^|&&|;|\|\|)\s*git\s+reset\b/,
    /(^|&&|;|\|\|)\s*git\s+clean\b/,
    /(^|&&|;|\|\|)\s*git\s+checkout\s+--\b/,
    /(^|&&|;|\|\|)\s*git\s+push\b/,
  ].some((pattern) => pattern.test(normalized));
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
    },

    async "tool.execute.before"(input, output) {
      const state = stateFor(input.sessionID);
      if (input.tool === "bash" && looksLikeDestructiveBash(output?.args?.command)) {
        state.dirtyReasons.push(`blocked risky bash: ${output.args.command}`);
        throw new Error("Goal Guard blocked a destructive or high-risk bash command. Ask the user or use a safer command.");
      }
    },

    async "tool.execute.after"(input, output) {
      const state = stateFor(input.sessionID);
      const agent = state.currentAgent;
      const at = nowIso();

      if (WRITE_TOOLS.has(input.tool)) {
        state.dirty = true;
        state.lastEditAt = at;
        state.dirtyReasons.push(`${input.tool} at ${at}`);
      }

      if (input.tool === "bash") {
        const command = String(input.args?.command || "");
        if (/\b(npm|pnpm|bun|yarn|node)\s+(test|run|--test)\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b/.test(command)) {
          state.dirtyReasons.push(`verification command: ${command}`);
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
          if (verdict === "PASS" && agent === "goal-final-auditor") {
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
      if (/Goal Completed/i.test(output.text || "") && state.dirty) {
        state.completedBlocked += 1;
        output.text = output.text.replace(/Goal Completed/i, "Goal Not Completed");
        output.text += `\n\nGoal Guard blocked completion: latest changes are dirty or review is stale. Run required review gates first. State: ${summarizeState(state)}`;
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
