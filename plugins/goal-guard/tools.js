/**
 * First-class `goal_*` custom tools.
 *
 * These give the model a structured, machine-checked way to interact with the
 * guard instead of relying on free-text parsing: it can record a Goal Contract,
 * log verification evidence, and read back authoritative gate status. They are
 * registered via the plugin `tool` hook (object key == tool name, verbatim).
 *
 * The `@opencode-ai/plugin` import is isolated to this module so that, if the
 * host cannot resolve it, the entry can skip tool registration while the core
 * guard hooks still load.
 */

import { tool } from "@opencode-ai/plugin";
import { evidenceMapReport, reviewerMemoryReport, statusReport } from "./summary.js";
import { recordEvidence } from "./events.js";
import { refreshStickyGates } from "./gates.js";
import { createState, resetGoalProgress } from "./state.js";
import { isPrimaryAgent } from "./agents.js";

const s = tool.schema;

// Stopwords + short tokens carry no goal identity; dropping them keeps the
// similarity score focused on the content words that actually distinguish one
// goal from another.
const GOAL_STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "you", "your", "our", "its", "use", "add", "make",
  "into", "from", "then", "than", "but", "not", "are", "was", "were", "will", "can", "get", "set",
  "via", "per", "all", "any", "new", "should", "must", "need", "want", "please", "also", "using",
]);

function goalContentTokens(v) {
  const set = new Set();
  for (const w of String(v || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length > 2 && !GOAL_STOPWORDS.has(w)) set.add(w);
  }
  return set;
}

/**
 * Jaccard overlap of two goal descriptions' content tokens. Returns -1 when the
 * score is undefined (either side has no content tokens) so callers can fall back
 * to a strict rule. A reworded statement of the SAME goal scores high; a different
 * goal scores near zero.
 */
export function goalSimilarity(a, b) {
  const ta = goalContentTokens(a);
  const tb = goalContentTokens(b);
  if (!ta.size || !tb.size) return -1;
  let inter = 0;
  for (const x of ta) if (tb.has(x)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

// Below this content-token overlap, a re-recorded contract is treated as a
// genuinely NEW goal (reset progress). Above it, a reworded restatement of the
// same goal that PRESERVES accrued review progress.
export const SAME_GOAL_THRESHOLD = 0.4;

/**
 * @param {object} deps
 * @param {ReturnType<import("./state.js").createStore>} deps.store
 * @param {object} deps.config
 * @param {() => void} deps.persist  Debounced persistence trigger.
 */
export function createGoalTools({ store, config, persist }) {
  const save = typeof persist === "function" ? persist : () => {};

  function requireGoalMode(state) {
    return Boolean(state?.active || isPrimaryAgent(state?.currentAgent));
  }

  function goalModeOnlyResult() {
    return {
      title: "Goal Mode required",
      output: "This goal_* tool can only mutate Goal Guard state from an active Goal session. Switch to the `goal` agent or start with /goal.",
      metadata: { blocked: true, reason: "not_goal_mode" },
    };
  }

  return {
    goal_status: tool({
      description:
        "Return the authoritative Goal Guard state for this session: recorded review " +
        "cycles, required vs. passing vs. missing review gates, dirty/verification status, " +
        "and whether completion is currently allowed. Read-only.",
      args: {},
      async execute(_args, ctx) {
        const state = store.stateFor(ctx.sessionID);
        if (!requireGoalMode(state)) return goalModeOnlyResult();
        const report = statusReport(state, config);
        const goal = report.goal ? `“${report.goal}” — ` : "";
        return {
          title: `Goal status: ${goal}completion ${report.completionAllowed ? "allowed" : "blocked"}`,
          output: JSON.stringify(report, null, 2),
          metadata: {
            goal: report.goal,
            completionAllowed: report.completionAllowed,
            reviewCycles: report.reviewCycles,
            missingGates: report.missingGates,
          },
        };
      },
    }),

    goal_evidence_map: tool({
      description:
        "Return an authoritative read-only evidence map for this session: each acceptance " +
        "criterion, matching recorded evidence, required reviewer gate status, coverage status, " +
        "gaps, and next action.",
      args: {},
      async execute(_args, ctx) {
        const state = store.stateFor(ctx.sessionID);
        if (!requireGoalMode(state)) return goalModeOnlyResult();
        const report = evidenceMapReport(state, config);
        const covered = report.criteria.filter((item) => item.status === "covered").length;
        return {
          title: `Evidence map: ${covered}/${report.criteria.length} criteria covered`,
          output: JSON.stringify(report, null, 2),
          metadata: { criteriaCount: report.criteria.length, coveredCount: covered, missingGates: report.missingGates },
        };
      },
    }),

    goal_reviewer_memory: tool({
      description:
        "Return durable Reviewer Memory for this session: unresolved and recently resolved " +
        "reviewer findings carried across cycles. Read-only.",
      args: {},
      async execute(_args, ctx) {
        const state = store.stateFor(ctx.sessionID);
        if (!requireGoalMode(state)) return goalModeOnlyResult();
        const report = reviewerMemoryReport(state);
        return {
          title: `Reviewer Memory: ${report.open.length} open findings`,
          output: JSON.stringify(report, null, 2),
          metadata: { openCount: report.open.length, total: report.total },
        };
      },
    }),

    goal_contract: tool({
      description:
        "Record or update the Goal Contract for this session (the explicit requirements, " +
        "inferred requirements, non-goals, and acceptance criteria). Establishing a contract " +
        "activates strict goal enforcement and drives which specialist review gates are required.",
      args: {
        title: s
          .string()
          .describe(
            "A short (max ~8 words) human-friendly title summarizing the GOAL/objective — what the user " +
              "ultimately wants, phrased like a session title but about the outcome. Shown in the TUI sidebar. " +
              "e.g. 'Rate-limit the login endpoint', 'Migrate auth to JWT'. No trailing punctuation.",
          ),
        original: s.string().describe("The original user request, verbatim or faithfully summarized."),
        requirements: s.array(s.string()).optional().describe("Explicit requirements stated by the user."),
        inferred: s.array(s.string()).optional().describe("Reasonable inferred requirements."),
        nonGoals: s.array(s.string()).optional().describe("Things explicitly out of scope."),
        acceptanceCriteria: s
          .array(s.string())
          .describe("Concrete, checkable acceptance criteria that define done."),
      },
      async execute(args, ctx) {
        const state = store.stateFor(ctx.sessionID);
        if (!requireGoalMode(state)) return goalModeOnlyResult();
        state.active = true;
        // A genuinely NEW goal in this session (a different verbatim request) must
        // not inherit the previous goal's gates, verdicts, dirty flags, review
        // cycles, or accumulated goal text — otherwise the TUI sidebar keeps showing
        // the old goal (even its "completed" status). Re-recording/refining the SAME
        // goal (same `original`) preserves progress.
        const norm = (v) => String(v || "").replace(/\s+/g, " ").trim().toLowerCase();
        const newOriginal = norm(args.original);
        // Decide whether this contract describes a genuinely NEW goal (reset accrued
        // progress) or restates the SAME one (preserve it). Exact string equality is
        // too brittle in BOTH directions:
        //   - It WIPED progress when the agent merely FORMALIZED an auto-seeded goal —
        //     re-wording "Add a rate limiter to login" as "Add a configurable
        //     token-bucket rate limiter to the login endpoint" reset reviewCycles to 0
        //     and (lastEditSeq=0) silently disabled the next programmatic review.
        //   - Preserving on equality alone let a DIFFERENT goal authored over the old
        //     contract inherit its passes → instant un-reviewed completion.
        // Use content-token similarity: a faithful restatement scores high (same goal),
        // a different request scores near zero. Fall back to strict inequality when the
        // score is undefined (a content-less original), which keeps the leak closed.
        if (state.contract && newOriginal && newOriginal !== norm(state.contract.original)) {
          const sim = goalSimilarity(args.original, state.contract.original);
          const isNewGoal = sim < 0 ? true : sim < SAME_GOAL_THRESHOLD;
          if (isNewGoal) {
            resetGoalProgress(state, store.nowIso());
            state.active = true;
          }
        }
        state.contract = {
          title: String(args.title || "").replace(/\s+/g, " ").trim(),
          original: String(args.original || ""),
          requirements: args.requirements || [],
          inferred: args.inferred || [],
          nonGoals: args.nonGoals || [],
          acceptanceCriteria: args.acceptanceCriteria || [],
          at: store.nowIso(),
        };
        state.goalText = [state.goalText, state.contract.original].filter(Boolean).join(" ");
        refreshStickyGates(state);
        state.updatedAt = store.nowIso();
        save();
        const report = statusReport(state, config);
        return {
          title: `Goal Contract recorded (${state.contract.acceptanceCriteria.length} acceptance criteria)`,
          output:
            `Goal Contract stored. Required review gates for this goal: ` +
            `${report.requiredGates.join(", ")}.`,
          metadata: { requiredGates: report.requiredGates },
        };
      },
    }),

    goal_evidence: tool({
      description:
        "Record a piece of verification evidence (a command that was run and its result, " +
        "optionally the acceptance criteria it covers). Counts as observed verification.",
      args: {
        command: s.string().describe("The verification command that was executed."),
        result: s.string().describe("Pass/fail summary and any salient output."),
        criteria: s.array(s.string()).optional().describe("Acceptance criteria this evidence covers."),
      },
      async execute(args, ctx) {
        const state = store.stateFor(ctx.sessionID);
        if (!requireGoalMode(state)) return goalModeOnlyResult();
        state.active = true;
        recordEvidence(store, state, args.command, args.result, args.criteria);
        save();
        return {
          title: "Verification evidence recorded",
          output: `Recorded evidence for: ${args.command}. Total evidence entries: ${state.evidence.length}.`,
          metadata: { evidenceCount: state.evidence.length },
        };
      },
    }),

    goal_reset: tool({
      description:
        "Clear all Goal Guard state for this session (contract, dirty flags, verdicts, review " +
        "cycles). Requires confirm=true. Use only when abandoning or restarting a goal.",
      args: {
        confirm: s.boolean().describe("Must be true to actually reset."),
      },
      async execute(args, ctx) {
        const state = store.stateFor(ctx.sessionID);
        if (!requireGoalMode(state)) return goalModeOnlyResult();
        if (!args.confirm) {
          return { title: "Reset not confirmed", output: "Pass confirm=true to reset Goal Guard state." };
        }
        const fresh = createState(store.nowIso());
        store.sessions.set(String(ctx.sessionID || "default"), fresh);
        save();
        return { title: "Goal Guard state reset", output: "All goal state cleared for this session." };
      },
    }),
  };
}
