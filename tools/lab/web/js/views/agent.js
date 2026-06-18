// Goal Lab — Agent detail: task, progress steps, run tree, diagrams, and a
// Temporal-style per-task event history. Inline status, semantic color, live.

import { h, clear, fmtDur, fmtNum, clock } from "../util.js";
import { store } from "../store.js";
import { api } from "../api.js";
import { panel, statusText, outcomeText, sevTag, stat, empty, legend } from "../components.js";
import { orchestrationGraph, gateSteps, runTree, timeline } from "../diagrams.js";

const ACTIVE = new Set(["queued", "starting", "running", "settling"]);

export function AgentView(navigate, runId) {
  const header = h("div");
  const stepWrap = h("div");
  const taskWrap = h("div");
  const guardWrap = h("div");
  const treeWrap = h("div");
  const graphWrap = h("div.hscroll");
  const timelineWrap = h("div");
  const evhWrap = h("div");
  const incWrap = h("div");

  const el = h("div.view", {},
    header,
    panel("Progress", stepWrap),
    h("div.grid.cols-2", {}, panel("Task", taskWrap), panel("Guard ledger", guardWrap)),
    panel("Run tree", treeWrap, { sub: "what happened, top to bottom" }),
    h("div.grid.cols-2", {}, panel("Orchestration", graphWrap, { flush: true }), panel("Timeline", timelineWrap, { flush: true })),
    panel("Event history", evhWrap, { flush: true, sub: "every event recorded for this task" }),
    panel("Problems & signals", incWrap, { flush: true }),
  );

  let detail = null;
  let events = [];
  let graph = { nodes: [], edges: [] };
  let filter = "all";
  const openRows = new Set();

  function renderHeader() {
    clear(header);
    const r = detail?.run || store.getRun(runId) || {};
    const g = detail?.guard || r.guard || {};
    const m = detail?.metrics || {};
    const elapsed = r.startedAt ? (r.endedAt || Date.now()) - r.startedAt : 0;
    const active = ACTIVE.has(r.status);
    const errs = r.counters?.errors || 0;
    header.append(h("div.panel", {},
      h("div.panel-head", {},
        h("div.row", { style: { gap: "14px" } },
          h("button.btn.sm.ghost", { onclick: () => navigate("/"), text: "← Agents" }),
          h("span.title", { text: r.taskTitle || r.taskId || runId }),
          statusText(r.status || "queued"),
          outcomeText(r.outcome),
        ),
        h("div.row", {},
          h("a.btn.sm.ghost", { href: `/api/runs/${runId}/data`, target: "_blank", download: `${runId}.json`, text: "Data ↧" }),
          active ? h("button.btn.sm.danger", { onclick: () => api.abort(runId), text: "Abort" }) : null,
        ),
      ),
      h("div.panel-body", {},
        h("div.stats", {},
          stat("Model", r.modelLabel || "—"),
          stat("Elapsed", fmtDur(elapsed)),
          stat("→ Contract", m.ttContractMs ? fmtDur(m.ttContractMs) : "—"),
          stat("Events", String(m.events ?? r.counters?.events ?? 0)),
          stat("Reviews", String(g.verdicts != null ? (Array.isArray(g.verdicts) ? g.verdicts.length : g.verdicts) : 0)),
          stat("Compl. blocked", String(g.completedBlocked || 0), g.completedBlocked ? "warn" : ""),
          stat("Errors", String(errs), errs ? "bad" : ""),
        ),
      ),
    ));
  }

  function renderSteps() { clear(stepWrap); stepWrap.append(gateSteps(detail?.guard || store.getRun(runId)?.guard, events)); }
  function renderTree() { clear(treeWrap); treeWrap.append(detail ? runTree(detail, events, store.incidents) : empty("loading…")); }
  function renderGraph() { clear(graphWrap); graphWrap.append(graph.nodes?.length ? orchestrationGraph(graph) : empty("no subagents/tools yet")); }
  function renderTimeline() {
    clear(timelineWrap);
    if (!events.length) { timelineWrap.append(empty("no events yet")); return; }
    timelineWrap.append(timeline(events), legend([
      { label: "guard signal", color: "var(--info)" },
      { label: "error", color: "var(--danger)" },
      { label: "event", color: "var(--n-400)" },
    ]));
  }

  function renderTask() {
    clear(taskWrap);
    const t = detail?.task;
    if (!t) { taskWrap.append(empty("loading task…")); return; }
    taskWrap.append(
      h("dl.kv", {}, kv("id", t.id), kv("category", t.category), kv("difficulty", `${t.difficulty}/8`)),
      h("div.label", { style: { margin: "12px 0 4px" }, text: "prompt" }),
      h("div", { style: { fontSize: "13px", lineHeight: "1.6", whiteSpace: "pre-wrap", color: "var(--text)" }, text: t.prompt }),
      t.probes?.length ? h("div", {}, h("div.label", { style: { margin: "12px 0 6px" }, text: "guard behaviors exercised" }), h("div.chips", {}, t.probes.map((p) => h("span.chip", { text: p })))) : null,
      t.expect ? h("div", {}, h("div.label", { style: { margin: "12px 0 6px" }, text: "expected guard behavior" }), h("div.chips", {}, Object.entries(t.expect).map(([k, v]) => h("span.chip" + (v === true ? ".pass" : ""), { text: `${k}=${v}` })))) : null,
    );
  }
  const kv = (k, v) => h("div", { style: { display: "contents" } }, h("dt", { text: k }), h("dd", { text: String(v) }));

  function renderGuard() {
    clear(guardWrap);
    const g = detail?.guard || store.getRun(runId)?.guard;
    if (!g) { guardWrap.append(empty("no guard state yet — no contract recorded")); return; }
    const verdicts = Array.isArray(g.verdicts) ? g.verdicts.length : (g.verdicts || 0);
    const reject = (g.completionRejections || []).length || 0;
    const flag = (cond, bad) => (cond ? bad || "warn" : "");
    guardWrap.append(h("dl.kv", {},
      kvf("contract", g.contract ? "recorded" : "MISSING", g.contract ? "good" : "bad"),
      g.contract?.title ? kv("title", trunc(g.contract.title, 38)) : null,
      kv("review cycles", String(g.reviewCycles || 0)),
      kvf("verdicts", String(verdicts)),
      kvf("completion blocked", String(g.completedBlocked || 0), flag(g.completedBlocked)),
      kvf("rejections", String(reject), flag(reject)),
      kvf("auto-continue", `${g.autoContinueCount || 0}${g.autoContinueNoProgress ? " (" + g.autoContinueNoProgress + " no-prog)" : ""}`, flag(g.autoContinueNoProgress >= 2, "bad")),
      kv("changed files", String((g.changedFiles || []).length || 0)),
      kvf("verification", g.verificationSeen ? "seen" : "—", g.verificationSeen ? "good" : ""),
      kvf("dirty", g.dirty ? "yes" : "no", flag(g.dirty)),
    ));
    const gates = g.stickyGates || [];
    if (gates.length) guardWrap.append(h("div.label", { style: { margin: "12px 0 6px" }, text: "required gates" }), h("div.chips", {}, gates.map((x) => h("span.chip", { text: x }))));
    const dr = g.dirtyReasons || [];
    if (dr.length) guardWrap.append(h("div.label", { style: { margin: "12px 0 6px" }, text: "dirty reasons (recent)" }), h("div", { style: { fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--text-subtle)" } }, dr.map((x) => h("div", { text: "· " + x }))));
  }
  const kvf = (k, v, cls) => h("div", { style: { display: "contents" } }, h("dt", { text: k }), h("dd", { class: cls || "", text: v }));

  // ---- Temporal-style event history ----
  function rowClass(e) {
    if (e.level === "error") return "e-row-bad";
    if (e.kind === "signal.shell.blocked" || e.kind === "signal.completion.blocked") return "e-row-good";
    if (e.kind === "signal.review") return e.data?.pass ? "e-row-good" : "e-row-bad";
    if (e.kind === "signal.completion.earned" && e.data?.raw) return "e-row-bad";
    if (e.kind === "signal.dirty" || e.kind === "signal.autocontinue") return "e-row-warn";
    return "";
  }
  function matchFilter(e) {
    if (filter === "all") return true;
    if (filter === "guard") return e.family === "guard";
    if (filter === "problems") return e.level === "error" || rowClass(e) === "e-row-bad" || rowClass(e) === "e-row-warn";
    if (filter === "tools") return e.family === "tools";
    return true;
  }
  function renderEvh() {
    clear(evhWrap);
    const t0 = events[0]?.ts || 0;
    const bar = h("div.filter-bar", {}, [["all", "All"], ["guard", "Guard signals"], ["problems", "Problems"], ["tools", "Tools"]].map(([k, lbl]) =>
      h("button.btn.sm" + (filter === k ? ".primary" : ".ghost"), { onclick: () => { filter = k; renderEvh(); }, text: lbl })));
    bar.append(h("span.dim", { style: { marginLeft: "auto", fontSize: "11px" }, text: `${events.length} events` }));
    const list = h("div.evh.vscroll", { style: { maxHeight: "46vh" } });
    list.append(h("div.eh-head", {}, h("span", { text: "#" }), h("span", { style: { textAlign: "right" }, text: "offset" }), h("span", { text: "time" }), h("span", { text: "type" }), h("span", { text: "detail" })));
    const shown = events.filter(matchFilter);
    if (!shown.length) list.append(empty("no events match this filter"));
    let atBottom = false;
    for (const e of shown) {
      const off = t0 ? "+" + ((e.ts - t0) / 1000).toFixed(1) + "s" : "";
      const isOpen = openRows.has(e.seq);
      const row = h("div.eh-row" + (isOpen ? ".open" : ""), { class: rowClass(e), onclick: () => { isOpen ? openRows.delete(e.seq) : openRows.add(e.seq); renderEvh(); } },
        h("span.e-seq", { text: e.seq }),
        h("span.e-off", { text: off }),
        h("span.e-time", { text: clock(e.ts) }),
        h("span.e-type.f-" + e.family, { title: e.kind, text: e.kind }),
        h("span.e-detail", { title: e.detail || e.title, text: e.title + (e.detail ? " — " + e.detail : "") }),
      );
      list.append(row);
      if (isOpen) list.append(h("div.eh-expand", {}, h("pre", { text: JSON.stringify({ agent: e.agent, tool: e.tool, kind: e.kind, level: e.level, ...e.data }, null, 2) })));
    }
    evhWrap.append(bar, list);
    if (filter === "all" && ACTIVE.has((store.getRun(runId) || {}).status)) list.scrollTop = list.scrollHeight;
  }

  function renderIncidents() {
    clear(incWrap);
    const list = store.incidents.filter((i) => i.runId === runId);
    if (!list.length) { incWrap.append(empty("No problems or signals recorded for this run.")); return; }
    incWrap.append(h("table.tbl", {},
      h("thead", {}, h("tr", {}, h("th", { text: "severity" }), h("th", { text: "family" }), h("th", { text: "title" }), h("th", { text: "what to improve" }))),
      h("tbody", {}, list.map((i) => h("tr", { onclick: () => navigate(`/incidents/${i.id}`) },
        h("td", {}, sevTag(i.severity), i.desired ? h("span.tag-ok", { style: { marginLeft: "8px" }, text: "guard ok" }) : null),
        h("td.mono", { text: i.familyId }),
        h("td.truncate", { title: i.title, text: i.title }),
        h("td.truncate.dim", { title: i.suggestedFix, text: i.suggestedFix }),
      ))),
    ));
  }

  function renderAll() { renderHeader(); renderSteps(); renderTask(); renderGuard(); renderTree(); renderGraph(); renderTimeline(); renderIncidents(); }

  async function loadAll() {
    [detail, events] = await Promise.all([api.run(runId).catch(() => null), store.loadRunEvents(runId)]);
    graph = await api.graph(runId).catch(() => graph);
    renderAll(); renderEvh();
  }

  let dirty = false;
  const offEvent = store.on("event", ({ runId: rid }) => { if (rid !== runId) return; events = store.getRunEvents(runId); renderEvh(); renderTimeline(); renderSteps(); dirty = true; });
  const offInc = store.on("incident", (i) => { if (i.runId === runId) { renderIncidents(); renderTree(); } });
  const tick = setInterval(async () => {
    const r = store.getRun(runId);
    if (dirty || (r && ACTIVE.has(r.status))) {
      dirty = false;
      detail = await api.run(runId).catch(() => detail);
      graph = await api.graph(runId).catch(() => graph);
      renderHeader(); renderSteps(); renderTask(); renderGuard(); renderTree(); renderGraph();
    }
  }, 2500);

  loadAll();
  return { el, destroy() { offEvent(); offInc(); clearInterval(tick); store.dropLive(runId); } };
}

function trunc(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; }
