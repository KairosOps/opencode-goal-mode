// Goal Lab — home: the agent list. Running (newest) on top, completed below.
// Click a row to open its detail (diagrams + task + event history).

import { h, clear, fmtDur } from "../util.js";
import { store } from "../store.js";
import { api } from "../api.js";
import { statusText, outcomeText, problemMark, empty } from "../components.js";

const ACTIVE = new Set(["queued", "starting", "running", "settling"]);

export function ListView(navigate) {
  const body = h("div.vscroll");
  const count = h("input", { type: "number", min: "1", max: "40", value: "10", style: { width: "56px" }, title: "agents to launch" });
  const launch = h("button.btn.primary", { text: "Launch agents", onclick: async () => {
    launch.setAttribute("disabled", "");
    try { await api.startBatch(Math.max(1, Math.min(40, Number(count.value) || 10))); }
    finally { setTimeout(() => launch.removeAttribute("disabled"), 800); }
  } });
  const abort = h("button.btn.ghost.danger", { text: "Abort all", onclick: () => api.abortAll() });

  const el = h("div.view", {},
    h("div.list-actions", {}, count, launch, abort),
    h("div.panel", {}, body),
  );

  function rowFor(r) {
    const c = r.counters || {};
    const g = r.guard || {};
    const elapsed = r.startedAt ? (r.endedAt || Date.now()) - r.startedAt : 0;
    const tr = h("tr", { onclick: () => navigate(`/agent/${r.id}`), class: ACTIVE.has(r.status) ? "is-running" : "" },
      h("td", {}, statusText(r.status)),
      h("td.truncate", { title: r.taskTitle, text: r.taskTitle || r.taskId }),
      h("td.mono", { text: r.modelLabel || "" }),
      h("td.num", { text: fmtDur(elapsed) }),
      h("td", {}, gateCell(g)),
      h("td.num", { text: String(c.events ?? 0) }),
      h("td.num", { text: String(g.verdicts ?? 0) }),
      h("td.num", { text: g.completedBlocked ? "×" + g.completedBlocked : "—" }),
      h("td", {}, problemMark(r)),
      h("td", {}, outcomeText(r.outcome)),
    );
    return tr;
  }

  function gateCell(g) {
    if (!g || !g.contract) return h("span.faint", { style: { fontSize: "11px" }, text: "no contract" });
    return h("span.mono", { style: { fontSize: "11px", color: "var(--text-subtle)" }, text: `C · ${(g.stickyGates || []).length}g · ${g.reviewCycles || 0}r` });
  }

  function render() {
    const runs = store.runs;
    clear(body);
    if (!runs.length) { body.append(empty("No agents yet. Set a count and launch a batch.", "◗")); return; }
    const active = runs.filter((r) => ACTIVE.has(r.status));
    const done = runs.filter((r) => !ACTIVE.has(r.status));
    const cols = ["Status", "Task", "Model", "Elapsed", "Gate", "Events", "Reviews", "Blocked", "Problems", "Outcome"];
    const head = h("thead", {}, h("tr", {}, cols.map((t, i) => h("th" + ([5, 6, 7].includes(i) ? ".num" : ""), { text: t }))));
    const tbody = h("tbody");
    if (active.length) {
      tbody.append(groupRow(`Running — ${active.length}`, cols.length));
      for (const r of active) tbody.append(rowFor(r));
    }
    if (done.length) {
      tbody.append(groupRow(`Completed — ${done.length}`, cols.length));
      for (const r of done) tbody.append(rowFor(r));
    }
    body.append(h("table.tbl", {}, head, tbody));
  }
  const groupRow = (label, span) => h("tr.group-head", {}, h("td", { colspan: span, text: label }));

  let raf = false;
  const sched = () => { if (raf) return; raf = true; requestAnimationFrame(() => { raf = false; render(); }); };
  const offRuns = store.on("runs", sched);
  const elapsedTick = setInterval(() => { if (store.runs.some((r) => ACTIVE.has(r.status))) sched(); }, 1000);

  render();
  return { el, destroy() { offRuns(); clearInterval(elapsedTick); } };
}
