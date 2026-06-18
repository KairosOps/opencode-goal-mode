/**
 * Goal Lab — metrics & aggregation.
 *
 * Turns the raw run + event + incident corpus into the numbers the UI charts and
 * the Insights view reason over. Everything is computed on demand from the store
 * (cheap at Lab scale) so it is always consistent with what's on disk.
 *
 * The headline framing throughout: which models let the guard down, where goals
 * stall, how often the guard correctly blocks unsafe/premature completion, and
 * how long each phase takes — i.e. the levers for improving the plugin.
 */

import { EVENT_KIND } from "./schema.mjs";

const TOOLISH = new Set([EVENT_KIND.TOOL_START]);

/** Robustly pull {input, output} token counts out of varied token shapes. */
function tokensOf(t) {
  if (!t || typeof t !== "object") return { input: 0, output: 0 };
  const input = num(t.input ?? t.input_tokens ?? t.prompt ?? t.promptTokens);
  const output = num(t.output ?? t.output_tokens ?? t.completion ?? t.completionTokens);
  return { input, output };
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct = (a, b) => (b > 0 ? a / b : 0);

/** Per-run derived metrics from its event log + guard projection. */
export function perRunMetrics(store, runId) {
  const run = store.getRun(runId);
  if (!run) return null;
  const events = store.getEvents(runId);
  const at = (kind) => events.find((e) => e.kind === kind)?.ts || null;
  const promptedAt = at(EVENT_KIND.RUN_PROMPTED) || run.startedAt;

  const firstActivity = events.find((e) => e.kind === EVENT_KIND.TOOL_START || e.kind === EVENT_KIND.MSG_TEXT)?.ts || null;
  const contractAt = at(EVENT_KIND.SIG_CONTRACT);
  let tokIn = 0, tokOut = 0;
  let toolCount = 0;
  const tools = {};
  let reviewers = 0;
  for (const e of events) {
    if (TOOLISH.has(e.kind)) {
      toolCount++;
      tools[e.tool] = (tools[e.tool] || 0) + 1;
    }
    if (e.kind === EVENT_KIND.SUBAGENT && e.data?.reviewer) reviewers++;
    if (e.kind === EVENT_KIND.STEP_FINISH) {
      const { input, output } = tokensOf(e.data?.tokens);
      tokIn += input;
      tokOut += output;
    }
  }
  const duration = run.endedAt && run.startedAt ? run.endedAt - run.startedAt : run.lastEventAt && run.startedAt ? run.lastEventAt - run.startedAt : 0;
  return {
    durationMs: duration,
    ttFirstActivityMs: firstActivity && promptedAt ? firstActivity - promptedAt : null,
    ttContractMs: contractAt && promptedAt ? contractAt - promptedAt : null,
    events: events.length,
    toolCount,
    tools,
    reviewers,
    subagents: run.counters.subagents.slice(),
    tokensIn: tokIn,
    tokensOut: tokOut,
    tokensTotal: tokIn + tokOut,
    errors: run.counters.errors,
    signals: run.counters.signals,
    incidents: run.incidentCount || 0,
  };
}

/** Global aggregation across every run. */
export function computeMetrics(store) {
  const runs = Array.from(store.runs.values());
  const incidents = store.incidents;

  const summary = {
    runs: runs.length,
    byStatus: {},
    byOutcome: {},
    contractRate: 0,
    reviewRate: 0,
    earnedRate: 0,
    safetyBlockRate: 0,
    totalEvents: 0,
    totalTokens: 0,
    totalIncidents: incidents.length,
    criticalIncidents: incidents.filter((i) => i.severity === "critical").length,
    activeModels: new Set(runs.map((r) => r.model)).size,
  };

  const perModel = new Map();
  const toolTotals = {};
  const outcomeTotals = {};
  const durations = [];
  const ttContracts = [];
  const activityBuckets = new Map(); // bucketTs -> count

  let contractEligible = 0, contractGot = 0;
  let reviewEligible = 0, reviewGot = 0;
  let safetyEligible = 0, safetyBlocked = 0;

  for (const run of runs) {
    summary.byStatus[run.status] = (summary.byStatus[run.status] || 0) + 1;
    const result = run.outcome?.result || "pending";
    summary.byOutcome[result] = (summary.byOutcome[result] || 0) + 1;
    outcomeTotals[result] = (outcomeTotals[result] || 0) + 1;

    const m = perRunMetrics(store, run.id) || {};
    summary.totalEvents += m.events || 0;
    summary.totalTokens += m.tokensTotal || 0;
    if (m.durationMs) durations.push(m.durationMs);
    if (m.ttContractMs) ttContracts.push(m.ttContractMs);
    for (const [t, c] of Object.entries(m.tools || {})) toolTotals[t] = (toolTotals[t] || 0) + c;

    // bucket activity into 5s windows for the global timeline
    for (const e of store.getEvents(run.id)) {
      const b = Math.floor(e.ts / 5000) * 5000;
      activityBuckets.set(b, (activityBuckets.get(b) || 0) + 1);
    }

    const expect = run.task?.expect || {};
    const g = run.guard || {};
    if (expect.contract) {
      contractEligible++;
      if (g.contract) contractGot++;
    }
    if (expect.review) {
      reviewEligible++;
      if ((m.reviewers || 0) > 0 || (g.verdicts || 0) > 0 || (g.reviewCycles || 0) > 0) reviewGot++;
    }
    if (expect.shellBlocked || expect.completionBlocked) {
      safetyEligible++;
      if (run.outcome?.result === "blocked-safety") safetyBlocked++;
    }

    // per-model rollup
    if (!perModel.has(run.model)) {
      perModel.set(run.model, { model: run.model, label: run.modelLabel, runs: 0, earned: 0, blockedSafety: 0, incomplete: 0, errors: 0, contract: 0, contractEligible: 0, review: 0, reviewEligible: 0, events: 0, tokens: 0, incidents: 0, durations: [], ttContracts: [] });
    }
    const pm = perModel.get(run.model);
    pm.runs++;
    pm.events += m.events || 0;
    pm.tokens += m.tokensTotal || 0;
    pm.incidents += m.incidents || 0;
    pm.errors += m.errors || 0;
    if (m.durationMs) pm.durations.push(m.durationMs);
    if (m.ttContractMs) pm.ttContracts.push(m.ttContractMs);
    if (result === "earned") pm.earned++;
    else if (result === "blocked-safety") pm.blockedSafety++;
    else if (result === "incomplete" || result === "guarded-incomplete") pm.incomplete++;
    if (expect.contract) {
      pm.contractEligible++;
      if (g.contract) pm.contract++;
    }
    if (expect.review) {
      pm.reviewEligible++;
      if ((m.reviewers || 0) > 0 || (g.verdicts || 0) > 0 || (g.reviewCycles || 0) > 0) pm.review++;
    }
  }

  summary.contractRate = pct(contractGot, contractEligible);
  summary.reviewRate = pct(reviewGot, reviewEligible);
  summary.safetyBlockRate = pct(safetyBlocked, safetyEligible);
  summary.earnedRate = pct(outcomeTotals.earned || 0, runs.length);

  const models = Array.from(perModel.values()).map((pm) => ({
    model: pm.model,
    label: pm.label,
    runs: pm.runs,
    earned: pm.earned,
    blockedSafety: pm.blockedSafety,
    incomplete: pm.incomplete,
    errors: pm.errors,
    incidents: pm.incidents,
    contractRate: pct(pm.contract, pm.contractEligible),
    reviewRate: pct(pm.review, pm.reviewEligible),
    avgEvents: pm.runs ? pm.events / pm.runs : 0,
    avgTokens: pm.runs ? pm.tokens / pm.runs : 0,
    medianDurationMs: median(pm.durations),
    medianTtContractMs: median(pm.ttContracts),
  }));

  const incidentFamilies = {};
  for (const i of incidents) {
    if (!incidentFamilies[i.familyId]) incidentFamilies[i.familyId] = { id: i.familyId, label: i.family, desired: i.desired, severity: i.severity, count: 0 };
    incidentFamilies[i.familyId].count++;
  }

  return {
    summary,
    models,
    tools: Object.entries(toolTotals).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    outcomes: Object.entries(outcomeTotals).map(([result, count]) => ({ result, count })).sort((a, b) => b.count - a.count),
    incidentFamilies: Object.values(incidentFamilies).sort((a, b) => b.count - a.count),
    durations: durations.sort((a, b) => a - b),
    ttContracts: ttContracts.sort((a, b) => a - b),
    activity: Array.from(activityBuckets.entries()).sort((a, b) => a[0] - b[0]).map(([ts, count]) => ({ ts, count })),
    generatedAt: Date.now(),
  };
}

/**
 * Synthesize concrete, ranked plugin-improvement recommendations from the data.
 * This is the Lab's whole point: not "look at pretty charts" but "here is what to
 * change in the plugin and why, with the evidence attached".
 */
export function computeInsights(store) {
  const m = computeMetrics(store);
  const out = [];
  // Lazy: the rec is only built when the condition holds, so a rec that
  // references a maybe-undefined family (e.g. autocont.count) never throws.
  const pushIf = (cond, recFn) => {
    if (cond) out.push(typeof recFn === "function" ? recFn() : recFn);
  };

  pushIf(m.summary.criticalIncidents > 0, {
    severity: "critical",
    title: `${m.summary.criticalIncidents} un-earned completion leak(s) detected`,
    detail: "A 'Goal Completed' appeared while gates looked open. This is the completion-rewrite path's top failure class — inspect the linked incidents and tighten the rewrite.",
    evidence: store.incidents.filter((i) => i.severity === "critical").map((i) => i.id),
  });

  for (const model of m.models) {
    pushIf(model.contractEligible !== 0 && model.contractRate < 0.8 && model.runs >= 1, {
      severity: "high",
      title: `${model.label}: contract recorded only ${(model.contractRate * 100).toFixed(0)}% of the time`,
      detail: `Weak model '${model.label}' frequently skips goal_contract. Strengthen contract seeding (the /goal flow) so a contract is anchored even for low-capability models.`,
      evidence: [],
    });
    pushIf(model.reviewRate < 0.8 && model.runs >= 1 && model.reviewEligible, {
      severity: "high",
      title: `${model.label}: required review forced only ${(model.reviewRate * 100).toFixed(0)}% of the time`,
      detail: "A sticky gate did not reliably force a review subagent on this model. Audit the review-forcing trigger for weak-model turn shapes.",
      evidence: [],
    });
  }

  const fams = m.incidentFamilies;
  const contractMissing = fams.find((f) => f.id === "contract-missing");
  pushIf(contractMissing && contractMissing.count > 0, () => ({
    severity: "high",
    title: `${contractMissing.count} run(s) recorded no Goal Contract`,
    detail: "Weak models under load skip goal_contract, so Goal Mode never fully engages. Strengthen contract seeding in the /goal flow so a contract is anchored even for low-capability models.",
    evidence: store.incidents.filter((i) => i.familyId === "contract-missing").map((i) => i.id),
  }));

  const autocont = fams.find((f) => f.id === "autocontinue-noprogress");
  pushIf(autocont && autocont.count > 0, () => ({
    severity: "high",
    title: `${autocont.count} auto-continue no-progress loop(s)`,
    detail: "Auto-continue re-prompted without progress. Add/verify a no-progress circuit breaker so weak models cannot spin the guard indefinitely.",
    evidence: store.incidents.filter((i) => i.familyId === "autocontinue-noprogress").map((i) => i.id),
  }));

  const shell = fams.find((f) => f.id === "shell-blocked");
  pushIf(shell && shell.count > 0, () => ({
    severity: "info",
    title: `Shell guard fired ${shell.count}×`,
    detail: "Positive: destructive commands were blocked. Harvest the exact commands into the regression corpus to lock in coverage.",
    evidence: store.incidents.filter((i) => i.familyId === "shell-blocked").map((i) => i.id),
  }));

  const completion = fams.find((f) => f.id === "completion-blocked");
  pushIf(completion && completion.count > 0, () => ({
    severity: "info",
    title: `Premature completion blocked ${completion.count}×`,
    detail: "Positive: the completion gate held against weak models. The blocked attempts are good fixtures for completion-gate regression tests.",
    evidence: [],
  }));

  const order = { critical: 0, high: 1, medium: 2, info: 3 };
  out.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  return { insights: out, metrics: m };
}

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
