/**
 * Goal Lab — HTTP + SSE server.
 *
 * Serves the static SPA and the full JSON API the UI (and any external agent)
 * drives the Lab through, plus a single Server-Sent-Events stream that pushes
 * every run/event/incident mutation live. Deliberately dependency-free: Node's
 * http + fs only, so the Lab boots with `node server/index.mjs` and nothing else.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { WEB_ROOT, CONFIG } from "./config.mjs";
import { TASKS, planBatch } from "./tasks.mjs";
import { computeMetrics, computeInsights, perRunMetrics } from "./metrics.mjs";
import { EVENT_KIND } from "./schema.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s), "cache-control": "no-store" });
  res.end(s);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/** Derive the orchestration graph (goal → subagents → tools) for one run. */
function buildGraph(store, runId) {
  const events = store.getEvents(runId);
  const nodes = new Map();
  const edges = new Map();
  const node = (id, label, type) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, type, count: 0 });
    nodes.get(id).count++;
    return id;
  };
  const edge = (from, to) => {
    const k = `${from}→${to}`;
    edges.set(k, (edges.get(k) || 0) + 1);
  };
  node("goal", "goal", "root");
  let activeAgent = "goal";
  for (const e of events) {
    if (e.kind === EVENT_KIND.SUBAGENT && e.data?.subagent) {
      const id = `agent:${e.data.subagent}`;
      node(id, e.data.subagent, e.data.reviewer ? "reviewer" : "subagent");
      edge("goal", id);
      activeAgent = id;
    } else if (e.kind === EVENT_KIND.TOOL_START && e.tool) {
      const id = `tool:${e.tool}`;
      node(id, e.tool, "tool");
      edge(activeAgent, id);
    }
  }
  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.entries()).map(([k, count]) => {
      const [from, to] = k.split("→");
      return { from, to, count };
    }),
  };
}

export function createApiServer(store, orchestrator) {
  async function serveStatic(req, res, pathname) {
    let rel = pathname === "/" ? "/index.html" : pathname;
    const full = normalize(join(WEB_ROOT, rel));
    if (!full.startsWith(WEB_ROOT)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    try {
      const st = await stat(full);
      if (st.isDirectory()) throw new Error("dir");
      const data = await readFile(full);
      res.writeHead(200, { "content-type": MIME[extname(full)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    } catch {
      // SPA fallback for client routes
      try {
        const data = await readFile(join(WEB_ROOT, "index.html"));
        res.writeHead(200, { "content-type": MIME[".html"] });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    }
  }

  function sse(req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ now: Date.now(), status: orchestrator.status() })}\n\n`);
    // initial snapshot so a late-joining client paints immediately
    res.write(`event: snapshot\ndata: ${JSON.stringify({ runs: store.listRuns(), incidents: store.incidents.slice(-50) })}\n\n`);
    const unsub = store.subscribe((msg) => {
      try {
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
      } catch {
        /* ignore */
      }
    });
    const hb = setInterval(() => {
      try {
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      } catch {
        /* ignore */
      }
    }, 15000);
    req.on("close", () => {
      clearInterval(hb);
      unsub();
    });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const method = req.method;

    try {
      // ----- API -----
      if (p === "/api/health") return json(res, 200, { ok: true, ...orchestrator.status(), ...store.stats() });
      if (p === "/api/tasks") return json(res, 200, { tasks: TASKS, models: CONFIG.models });
      if (p === "/api/models") return json(res, 200, { models: CONFIG.models });
      if (p === "/api/stream") return sse(req, res);

      if (p === "/api/runs" && method === "GET") return json(res, 200, { runs: store.listRuns(), status: orchestrator.status() });
      if (p === "/api/runs" && method === "POST") {
        const body = await readBody(req);
        let plan = [];
        if (Array.isArray(body.plan)) plan = body.plan;
        else if (body.taskId && body.model) plan = Array.from({ length: body.count || 1 }, () => ({ taskId: body.taskId, model: body.model }));
        const ids = orchestrator.enqueue(plan);
        return json(res, 200, { started: ids });
      }
      if (p === "/api/batch" && method === "POST") {
        const body = await readBody(req);
        const count = Math.max(1, Math.min(body.count || CONFIG.concurrency, 50));
        const ids = orchestrator.enqueue(planBatch(count, CONFIG.models));
        return json(res, 200, { started: ids, count: ids.length });
      }
      if (p === "/api/abort-all" && method === "POST") {
        orchestrator.abortAll();
        return json(res, 200, { ok: true });
      }

      let m;
      if ((m = p.match(/^\/api\/runs\/([^/]+)$/))) {
        const run = store.getRun(m[1]);
        if (!run) return json(res, 404, { error: "no such run" });
        return json(res, 200, { run: store.summarizeRun(run), task: run.task, guard: run.guard, metrics: perRunMetrics(store, m[1]) });
      }
      if ((m = p.match(/^\/api\/runs\/([^/]+)\/events$/))) {
        const since = Number(url.searchParams.get("since") || 0);
        const limit = Number(url.searchParams.get("limit") || 0);
        return json(res, 200, { events: store.getEvents(m[1], { sinceSeq: since, limit }) });
      }
      if ((m = p.match(/^\/api\/runs\/([^/]+)\/graph$/))) {
        return json(res, 200, buildGraph(store, m[1]));
      }
      if ((m = p.match(/^\/api\/runs\/([^/]+)\/data$/))) {
        // Everything about ONE task in one payload — so an engineer (or an agent)
        // debugging the plugin has the complete record: run, task, guard ledger,
        // every normalized event, derived metrics, graph, and incidents.
        const run = store.getRun(m[1]);
        if (!run) return json(res, 404, { error: "no such run" });
        return json(res, 200, {
          run: store.summarizeRun(run), task: run.task, guard: run.guard,
          metrics: perRunMetrics(store, m[1]), graph: buildGraph(store, m[1]),
          events: store.getEvents(m[1]),
          incidents: store.incidents.filter((i) => i.runId === m[1]),
          exportedAt: Date.now(),
        });
      }
      if ((m = p.match(/^\/api\/runs\/([^/]+)\/abort$/)) && method === "POST") {
        return json(res, 200, { ok: orchestrator.abortRun(m[1]) });
      }

      if (p === "/api/incidents") {
        const fam = url.searchParams.get("family");
        const sev = url.searchParams.get("severity");
        let list = store.incidents.slice().reverse();
        if (fam) list = list.filter((i) => i.familyId === fam);
        if (sev) list = list.filter((i) => i.severity === sev);
        return json(res, 200, { incidents: list });
      }
      if ((m = p.match(/^\/api\/incidents\/([^/]+)$/))) {
        const inc = store.incidents.find((i) => i.id === m[1]);
        if (!inc) return json(res, 404, { error: "no such incident" });
        return json(res, 200, { incident: inc });
      }

      if (p === "/api/metrics") return json(res, 200, computeMetrics(store));
      if (p === "/api/insights") return json(res, 200, computeInsights(store));
      if (p === "/api/export") return json(res, 200, { runs: store.listRuns(), incidents: store.incidents, metrics: computeMetrics(store), insights: computeInsights(store).insights, exportedAt: Date.now() });

      if (p.startsWith("/api/")) return json(res, 404, { error: "unknown endpoint" });

      // ----- static -----
      return serveStatic(req, res, p);
    } catch (err) {
      json(res, 500, { error: String(err?.message || err) });
    }
  });

  return server;
}
