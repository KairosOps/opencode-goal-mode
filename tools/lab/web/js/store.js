// Goal Lab — client-side live store. Single source of truth the views render from.

import { api, connectStream } from "./api.js";

const MAX_TICKER = 240;

function emitter() {
  const map = new Map();
  return {
    on(topic, fn) {
      if (!map.has(topic)) map.set(topic, new Set());
      map.get(topic).add(fn);
      return () => map.get(topic)?.delete(fn);
    },
    emit(topic, payload) {
      for (const fn of map.get(topic) || []) {
        try {
          fn(payload);
        } catch (e) {
          console.error(e);
        }
      }
    },
  };
}

export const store = (() => {
  const bus = emitter();
  const runs = new Map(); // id -> summary
  const eventsByRun = new Map(); // id -> events[] (lazy)
  const liveRuns = new Set(); // run ids whose live events we keep appending
  const ticker = []; // global recent events
  let incidents = [];
  let status = { active: 0, queued: 0, concurrency: 0 };
  let connected = false;
  let metrics = null;
  let metricsAt = 0;

  function upsertRun(summary) {
    const prev = runs.get(summary.id) || {};
    runs.set(summary.id, { ...prev, ...summary });
    bus.emit("runs");
  }

  function onMessage(msg) {
    switch (msg.type) {
      case "run.created":
      case "run.update":
        upsertRun(msg.run);
        break;
      case "run.counters": {
        const r = runs.get(msg.runId);
        if (r) {
          r.counters = msg.counters;
          r.lastEventAt = msg.lastEventAt;
          if (msg.status) r.status = msg.status;
          bus.emit("runs");
        }
        break;
      }
      case "event": {
        ticker.push({ ...msg.event, runId: msg.runId });
        if (ticker.length > MAX_TICKER) ticker.splice(0, ticker.length - MAX_TICKER);
        if (liveRuns.has(msg.runId) && eventsByRun.has(msg.runId)) eventsByRun.get(msg.runId).push(msg.event);
        bus.emit("event", { runId: msg.runId, event: msg.event });
        break;
      }
      case "incident":
        incidents.unshift(msg.incident);
        bus.emit("incident", msg.incident);
        break;
      default:
        break;
    }
  }

  function connect() {
    connectStream({
      open: () => {
        connected = true;
        bus.emit("conn", true);
      },
      close: () => {
        connected = false;
        bus.emit("conn", false);
      },
      hello: (d) => {
        if (d.status) status = d.status;
        bus.emit("status", status);
      },
      snapshot: (d) => {
        runs.clear();
        for (const r of d.runs || []) runs.set(r.id, r);
        incidents = d.incidents ? d.incidents.slice().reverse() : [];
        bus.emit("runs");
        bus.emit("incident");
      },
      message: onMessage,
    });
  }

  async function loadRunEvents(id) {
    const res = await api.events(id);
    eventsByRun.set(id, res.events || []);
    liveRuns.add(id);
    return eventsByRun.get(id);
  }
  function dropLive(id) {
    liveRuns.delete(id);
  }

  async function refreshMetrics(force = false) {
    if (!force && Date.now() - metricsAt < 2500 && metrics) return metrics;
    metrics = await api.metrics();
    metricsAt = Date.now();
    return metrics;
  }

  return {
    bus,
    connect,
    on: bus.on,
    emit: bus.emit,
    get runs() { return Array.from(runs.values()).sort((a, b) => b.createdAt - a.createdAt); },
    getRun: (id) => runs.get(id),
    get ticker() { return ticker; },
    get incidents() { return incidents; },
    get status() { return status; },
    get connected() { return connected; },
    setStatus: (s) => { status = s; bus.emit("status", s); },
    loadRunEvents,
    dropLive,
    getRunEvents: (id) => eventsByRun.get(id) || [],
    refreshMetrics,
    get metrics() { return metrics; },
  };
})();
