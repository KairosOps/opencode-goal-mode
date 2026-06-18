/**
 * Goal Lab — the central store.
 *
 * Owns the canonical in-memory view of every run, its normalized event log, and
 * the investigated incidents, AND durably appends each event to JSONL on disk so
 * a Lab restart (or post-hoc analysis) loses nothing. A tiny synchronous pub/sub
 * bus fans every mutation out to the SSE endpoint for the live UI.
 *
 * Deliberately dependency-free: Node built-ins only.
 */

import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, RUNS_ROOT, STATE_HOME, PROJECTS_ROOT } from "./config.mjs";
import { EVENT_KIND, TERMINAL_STATUS, incidentSignature } from "./schema.mjs";

export function createStore() {
  /** @type {Map<string, any>} */
  const runs = new Map();
  /** @type {Map<string, any[]>} runId -> normalized events (in memory). */
  const events = new Map();
  /** @type {any[]} */
  const incidents = [];
  const incidentSigs = new Set();
  /** @type {Set<(msg:any)=>void>} */
  const subscribers = new Set();
  let incidentSeq = 0;

  for (const d of [DATA_ROOT, RUNS_ROOT, STATE_HOME, PROJECTS_ROOT]) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  const runDir = (id) => join(RUNS_ROOT, id);
  const emit = (msg) => {
    for (const fn of subscribers) {
      try {
        fn(msg);
      } catch {
        /* a slow/broken subscriber must never break ingestion */
      }
    }
  };

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------
  function createRun(partial) {
    const run = {
      id: partial.id,
      model: partial.model,
      modelLabel: partial.modelLabel,
      taskId: partial.taskId,
      task: partial.task,
      status: partial.status,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      // runtime handles
      cwd: null,
      baseUrl: null,
      port: null,
      pid: null,
      sessionId: null,
      // rollups maintained incrementally for cheap listing
      counters: {
        events: 0,
        byKind: {},
        byFamily: {},
        tools: {},
        subagents: [],
        errors: 0,
        signals: 0,
      },
      // latest projection of the guard's on-disk ledger (filled by guard poller)
      guard: null,
      // derived outcome/metrics (filled at settle/terminal)
      outcome: null,
      metrics: {},
      lastEventAt: null,
      error: null,
    };
    runs.set(run.id, run);
    events.set(run.id, []);
    try {
      mkdirSync(runDir(run.id), { recursive: true });
      writeFileSync(join(runDir(run.id), "run.json"), JSON.stringify(run));
    } catch {
      /* ignore */
    }
    emit({ type: "run.created", run: summarizeRun(run) });
    return run;
  }

  function updateRun(id, patch) {
    const run = runs.get(id);
    if (!run) return null;
    Object.assign(run, patch);
    if (patch.status && TERMINAL_STATUS.has(patch.status) && !run.endedAt) {
      run.endedAt = Date.now();
    }
    try {
      writeFileSync(join(runDir(id), "run.json"), JSON.stringify(run));
    } catch {
      /* ignore */
    }
    emit({ type: "run.update", run: summarizeRun(run) });
    return run;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------
  function appendEvent(runId, evt) {
    const run = runs.get(runId);
    if (!run) return null;
    const list = events.get(runId);
    evt.seq = list.length + 1;
    evt.ts = evt.ts || Date.now();
    evt.runId = runId;
    list.push(evt);

    // incremental rollups
    const c = run.counters;
    c.events += 1;
    c.byKind[evt.kind] = (c.byKind[evt.kind] || 0) + 1;
    c.byFamily[evt.family] = (c.byFamily[evt.family] || 0) + 1;
    if (evt.kind === EVENT_KIND.TOOL_START && evt.tool) c.tools[evt.tool] = (c.tools[evt.tool] || 0) + 1;
    if (evt.kind === EVENT_KIND.SUBAGENT && evt.data?.subagent && !c.subagents.includes(evt.data.subagent)) {
      c.subagents.push(evt.data.subagent);
    }
    if (evt.level === "error") c.errors += 1;
    if (evt.level === "signal") c.signals += 1;
    run.lastEventAt = evt.ts;

    try {
      appendFileSync(join(runDir(runId), "events.jsonl"), JSON.stringify(evt) + "\n");
    } catch {
      /* ignore */
    }
    emit({ type: "event", runId, event: evt });
    // a cheap run.update keeps the list view's counters live without re-sending events
    emit({ type: "run.counters", runId, counters: c, lastEventAt: evt.ts, status: run.status });
    return evt;
  }

  function getEvents(runId, { sinceSeq = 0, limit = 0 } = {}) {
    const list = events.get(runId) || [];
    let out = sinceSeq > 0 ? list.filter((e) => e.seq > sinceSeq) : list.slice();
    if (limit > 0 && out.length > limit) out = out.slice(out.length - limit);
    return out;
  }

  // -------------------------------------------------------------------------
  // Incidents
  // -------------------------------------------------------------------------
  function recordIncident(inc) {
    const sig = incidentSignature(inc.runId, inc.familyId, inc.key);
    if (incidentSigs.has(sig)) return null; // dedupe identical findings within a run
    incidentSigs.add(sig);
    inc.id = `inc-${++incidentSeq}`;
    inc.ts = inc.ts || Date.now();
    inc.signature = sig;
    incidents.push(inc);
    try {
      appendFileSync(join(DATA_ROOT, "incidents.jsonl"), JSON.stringify(inc) + "\n");
    } catch {
      /* ignore */
    }
    // tag the owning run so the list view can surface incident counts
    const run = runs.get(inc.runId);
    if (run) {
      run.incidentCount = (run.incidentCount || 0) + 1;
      if (!run.worstIncident || rank(inc.severity) < rank(run.worstIncident)) run.worstIncident = inc.severity;
    }
    emit({ type: "incident", incident: inc });
    return inc;
  }

  const rank = (s) => ({ critical: 0, high: 1, medium: 2, low: 3 }[s] ?? 9);

  // -------------------------------------------------------------------------
  // Projections
  // -------------------------------------------------------------------------
  function summarizeRun(run) {
    return {
      id: run.id,
      model: run.model,
      modelLabel: run.modelLabel,
      taskId: run.taskId,
      taskTitle: run.task?.title,
      category: run.task?.category,
      difficulty: run.task?.difficulty,
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      lastEventAt: run.lastEventAt,
      counters: run.counters,
      guard: run.guard ? projectGuard(run.guard) : null,
      outcome: run.outcome,
      metrics: run.metrics,
      incidentCount: run.incidentCount || 0,
      worstIncident: run.worstIncident || null,
      port: run.port,
      baseUrl: run.baseUrl,
      error: run.error,
    };
  }

  /** Compact, UI-friendly view of the guard ledger (full record stays on the run). */
  function projectGuard(g) {
    if (!g) return null;
    return {
      active: g.active,
      contract: g.contract ? { title: g.contract.title, gates: g.contract.gates || g.stickyGates } : null,
      stickyGates: g.stickyGates || [],
      reviewCycles: g.reviewCycles || 0,
      verdicts: (g.verdicts || []).length,
      completionRejections: (g.completionRejections || []).length,
      completedBlocked: g.completedBlocked || 0,
      dirty: !!g.dirty,
      dirtyReasons: (g.dirtyReasons || []).slice(-5),
      autoContinueCount: g.autoContinueCount || 0,
      autoContinueNoProgress: g.autoContinueNoProgress || 0,
      changedFiles: (g.changedFiles || []).length,
      verificationSeen: !!g.verificationSeen,
    };
  }

  function listRuns() {
    return Array.from(runs.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(summarizeRun);
  }

  return {
    runs,
    events,
    incidents,
    createRun,
    updateRun,
    appendEvent,
    getEvents,
    recordIncident,
    getRun: (id) => runs.get(id) || null,
    summarizeRun,
    projectGuard,
    listRuns,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    emit,
    stats: () => ({ runs: runs.size, incidents: incidents.length, subscribers: subscribers.size }),
  };
}
