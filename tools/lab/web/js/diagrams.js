// Goal Lab — structural diagrams: orchestration graph, completion-gate state
// machine, and a swimlane event timeline. Monochrome, square, hairline.

import { h, s } from "./util.js";

const VB_W = 1000;

// ---------------------------------------------------------------------------
// Completion-gate STEPPER (clean horizontal steps — replaces the SVG machine).
// ---------------------------------------------------------------------------
export function gateSteps(guard, events) {
  const g = guard || {};
  const has = (k) => events.some((e) => e.kind === k);
  const contract = !!g.contract || has("signal.contract");
  const gates = (g.stickyGates || []).length || (has("signal.gate") ? 1 : 0);
  const verdicts = (g.verdicts || []).length ?? g.verdicts ?? 0;
  const reviewed = verdicts > 0 || has("signal.review") || (g.reviewCycles || 0) > 0;
  const blocked = (g.completedBlocked || 0) > 0 || has("signal.completion.blocked");
  const earned = !!g.verificationSeen && !g.dirty && verdicts > 0;

  const steps = [
    { label: "Goal set", sub: "", done: true },
    { label: "Contract", sub: contract ? "recorded" : "—", done: contract },
    { label: "Gates", sub: gates ? gates + " required" : "—", done: gates > 0 },
    { label: "Review", sub: reviewed ? verdicts + " verdicts" : "—", done: reviewed },
    { label: "Completion", sub: earned ? "earned" : blocked ? "blocked" : "pending", done: earned, blocked: blocked && !earned, earned },
  ];
  // mark the first not-done step as "current"
  const firstPending = steps.findIndex((x) => !x.done && !x.blocked && !x.earned);
  return h("div.stepper", {}, steps.map((st, i) => {
    const cls = st.earned ? "earned" : st.blocked ? "blocked" : st.done ? "done" : i === firstPending ? "current" : "";
    const on = st.done || st.blocked || st.earned;
    const glyph = st.done || st.earned ? "✓" : st.blocked ? "!" : i === firstPending ? "•" : i + 1;
    return h("div.step." + (cls || "pending") + (on ? " on" : ""), {},
      h("div.s-dot", { text: String(glyph) }),
      h("div.s-label", { text: st.label }),
      st.sub ? h("div.s-sub", { text: st.sub }) : null,
    );
  }));
}

// ---------------------------------------------------------------------------
// Run TREE (Temporal-style breakdown a human can read top to bottom).
// ---------------------------------------------------------------------------
export function runTree(detail, events, incidents) {
  const g = detail?.guard || {};
  const run = detail?.run || {};
  const tools = run.counters?.tools || {};
  const toolList = Object.entries(tools).sort((a, b) => b[1] - a[1]);
  const verdicts = Array.isArray(g.verdicts) ? g.verdicts : [];
  const rejections = Array.isArray(g.completionRejections) ? g.completionRejections : [];
  const gates = g.stickyGates || [];
  const changed = (g.changedFiles || []).length ?? g.changedFiles ?? 0;
  const earned = !!g.verificationSeen && !g.dirty && verdicts.length > 0;

  const node = (label, { mark = "muted", meta = "", dim = false, children = null, collapsed = false } = {}) =>
    ({ label, mark, meta, dim, children, collapsed });

  const root = node(`goal · ${run.modelLabel || ""}`, { mark: "info", meta: `${run.counters?.events || 0} events`, children: [] });

  root.children.push(node("Contract", {
    mark: g.contract ? "ok" : "bad",
    meta: g.contract ? "recorded" : "missing",
    children: g.contract
      ? [node(g.contract.title || "—", { mark: "muted", dim: true }),
         ...(gates.length ? [node("Required gates", { mark: "info", meta: gates.length + "", children: gates.map((x) => node(x, { mark: "muted", dim: true })) })] : [])]
      : null,
  }));

  root.children.push(node("Implementation", {
    mark: toolList.length ? "ok" : "muted",
    meta: `${Object.values(tools).reduce((a, b) => a + b, 0)} tool calls · ${changed} files`,
    collapsed: toolList.length > 6,
    children: toolList.length ? toolList.map(([t, c]) => node(t, { mark: "muted", dim: true, meta: "×" + c })) : null,
  }));

  root.children.push(node("Reviews", {
    mark: verdicts.some((v) => /fail/i.test(v.verdict || v.status)) ? "warn" : verdicts.length ? "ok" : "muted",
    meta: `${verdicts.length} verdicts · ${g.reviewCycles || 0} cycles`,
    children: verdicts.length ? verdicts.map((v) => {
      const pass = /pass/i.test(v.verdict || v.status || "");
      return node(v.agent || "reviewer", { mark: pass ? "ok" : "bad", meta: (v.verdict || v.status || "?") });
    }) : null,
  }));

  root.children.push(node("Completion", {
    mark: earned ? "ok" : (g.completedBlocked ? "warn" : "muted"),
    meta: earned ? "earned" : g.completedBlocked ? `blocked ×${g.completedBlocked}` : "pending",
    children: rejections.length ? rejections.map((r) => node(r.reason || JSON.stringify(r).slice(0, 80), { mark: "warn", dim: true })) : null,
  }));

  const incs = (incidents || []).filter((i) => i.runId === run.id);
  if (incs.length) {
    root.children.push(node("Problems & signals", {
      mark: incs.some((i) => i.severity === "critical" || i.severity === "high") ? "bad" : "warn",
      meta: incs.length + "",
      children: incs.map((i) => node(i.title, { mark: i.desired ? "ok" : i.severity === "critical" || i.severity === "high" ? "bad" : "warn", meta: i.familyId, dim: true })),
    }));
  }

  const wrap = h("div.tree", {});
  wrap.append(renderNode(root, false));
  return wrap;
}

function renderNode(n, startCollapsed) {
  const hasChildren = Array.isArray(n.children) && n.children.length > 0;
  let open = hasChildren && !n.collapsed;
  const kids = h("div.tchildren");
  const caret = h("span.tn-caret", { text: hasChildren ? (open ? "▾" : "▸") : "" });
  const rowProps = hasChildren ? { class: "clickable", onclick: () => { open = !open; caret.textContent = open ? "▾" : "▸"; kids.style.display = open ? "" : "none"; } } : {};
  const row = h("div.tn-row", rowProps,
    caret,
    h("span.tn-mark." + n.mark, {}),
    h("span.tn-label" + (n.dim ? ".dim" : ""), { text: n.label }),
    n.meta ? h("span.tn-meta", { text: n.meta }) : null,
  );
  const el = h("div.tnode", {}, row);
  if (hasChildren) {
    for (const c of n.children) kids.append(renderNode(c, false));
    if (!open) kids.style.display = "none";
    el.append(kids);
  }
  return el;
}

function svg(height) {
  const el = s("svg", { class: "chart", viewBox: `0 0 ${VB_W} ${height}`, preserveAspectRatio: "xMidYMid meet", height });
  el.style.height = height + "px";
  return el;
}

/** Layered DAG: goal (col0) → subagents/reviewers (col1) → tools (col2). */
export function orchestrationGraph(graph) {
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const colOf = (t) => (t === "root" ? 0 : t === "tool" ? 2 : 1);
  const cols = [[], [], []];
  for (const n of nodes) cols[colOf(n.type)].push(n);
  const colX = [60, 420, 800];
  const boxW = [120, 230, 150];
  const pos = new Map();
  const laneH = 34;
  const H = Math.max(140, Math.max(cols[1].length, cols[2].length, 1) * laneH + 40);
  const el = svg(H);

  cols.forEach((list, ci) => {
    const total = list.length;
    const top = (H - total * laneH) / 2 + 8;
    list.forEach((n, i) => {
      const x = colX[ci];
      const y = top + i * laneH;
      pos.set(n.id, { x, y: y + 11, w: boxW[ci], cx: x + boxW[ci], cy: y + 11 });
      const g = s("g", { transform: `translate(${x}, ${y})` });
      g.append(s("rect", { class: "node-box " + n.type, x: 0, y: 0, width: boxW[ci], height: 22 }));
      const label = n.label.length > 26 ? n.label.slice(0, 25) + "…" : n.label;
      g.append(s("text", { class: "n" + (n.type === "tool" ? " dim" : ""), x: 7, y: 15, "font-size": 10 }, label));
      if (n.count > 1) g.append(s("text", { class: "n dim", x: boxW[ci] - 6, y: 15, "text-anchor": "end", "font-size": 9 }, "×" + n.count));
      el.append(g);
    });
  });

  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + a.w, y1 = a.cy, x2 = b.x, y2 = b.cy;
    const mx = (x1 + x2) / 2;
    el.insertBefore(s("path", { class: "edge", d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, "stroke-width": Math.min(3, 0.6 + e.count * 0.4) }), el.firstChild);
  }
  // column captions
  ["GOAL", "SUBAGENTS", "TOOLS"].forEach((t, i) => el.append(s("text", { class: "lbl", x: colX[i], y: 12, "font-size": 9 }, t)));
  return el;
}

/** Completion-gate state machine; the reached states are inked solid. */
export function gateMachine(guard, events) {
  const has = (k) => events.some((e) => e.kind === k);
  const reached = {
    goal: true,
    contract: !!(guard && guard.contract) || has("signal.contract"),
    gates: !!(guard && (guard.stickyGates || []).length) || has("signal.gate"),
    review: has("signal.review") || (guard && (guard.verdicts || 0) > 0),
    blocked: has("signal.completion.blocked") || (guard && (guard.completedBlocked || 0) > 0),
    earned: events.some((e) => e.kind === "signal.completion.earned" && !e.data?.raw) || (guard && guard.verificationSeen && !guard.dirty && (guard.verdicts || 0) > 0),
  };
  const states = [
    { id: "goal", label: "GOAL SET" },
    { id: "contract", label: "CONTRACT" },
    { id: "gates", label: "GATES OPEN" },
    { id: "review", label: "REVIEWING" },
    { id: "blocked", label: "BLOCKED ↺" },
    { id: "earned", label: "EARNED ✓" },
  ];
  const H = 90;
  const el = svg(H);
  const bw = 150, gap = (VB_W - states.length * bw) / (states.length - 1);
  states.forEach((st, i) => {
    const x = i * (bw + gap);
    const on = reached[st.id];
    // semantic: a reached BLOCKED state is a caution (amber); EARNED is success (green);
    // other reached states use the brand accent; unreached are neutral.
    const fill = on ? (st.id === "blocked" ? "var(--warn)" : st.id === "earned" ? "var(--ok)" : "var(--brand)") : "var(--card)";
    const g = s("g", { transform: `translate(${x}, 30)` });
    g.append(s("rect", { x: 0, y: 0, width: bw, height: 30, rx: 5, fill, stroke: on ? fill : "var(--border-strong)" }));
    g.append(s("text", { x: bw / 2, y: 19, "text-anchor": "middle", "font-size": 11, "font-family": "var(--font-mono)", fill: on ? "#fff" : "var(--text-faint)" }, st.label));
    el.append(g);
    if (i < states.length - 1) {
      const ax = x + bw, ay = 45;
      el.append(s("path", { class: "edge", d: `M ${ax} ${ay} L ${ax + gap} ${ay}`, "stroke-width": 1.2 }));
      el.append(s("path", { class: "edge", d: `M ${ax + gap - 6} ${ay - 3} L ${ax + gap} ${ay} L ${ax + gap - 6} ${ay + 3}` }));
    }
  });
  // loop arrow blocked -> reviewing
  el.append(s("text", { class: "lbl", x: VB_W / 2, y: 12, "font-size": 9, "text-anchor": "middle" }, "COMPLETION GATE — reached states inked"));
  return el;
}

/** Swimlane timeline of all events across the run, lanes by family. */
export function timeline(events, { height } = {}) {
  const lanes = ["lifecycle", "conversation", "tools", "guard", "errors"];
  const laneH = 30;
  const padL = 90, padT = 18, padB = 16;
  const H = height || padT + lanes.length * laneH + padB;
  const el = svg(H);
  if (!events.length) return el;
  const t0 = events[0].ts, t1 = events[events.length - 1].ts || t0 + 1;
  const span = t1 - t0 || 1;
  const w = VB_W - padL - 12;
  const sx = (ts) => padL + ((ts - t0) / span) * w;
  lanes.forEach((lane, i) => {
    const y = padT + i * laneH;
    el.append(s("line", { class: "grid", x1: padL, y1: y + laneH, x2: VB_W - 12, y2: y + laneH }));
    el.append(s("text", { class: "lbl l", x: 0, y: y + laneH / 2 + 4, "font-size": 9 }, lane.toUpperCase()));
  });
  for (const e of events) {
    const li = lanes.indexOf(e.family);
    if (li < 0) continue;
    const x = sx(e.ts);
    const y = padT + li * laneH + 4;
    const big = e.level === "signal" || e.level === "error";
    // semantic marks: errors red, guard signals blue, ordinary events neutral gray
    const fill = e.level === "error" ? "var(--danger)" : e.level === "signal" ? "var(--info)" : "var(--n-400)";
    el.append(s("rect", { x: x - (big ? 1.5 : 0.7), y, width: big ? 3 : 1.6, height: laneH - 8, fill, opacity: big ? 1 : 0.85 }));
  }
  // time axis ticks
  for (let k = 0; k <= 4; k++) {
    const ts = t0 + (span / 4) * k;
    const x = sx(ts);
    el.append(s("text", { class: "lbl", x, y: H - 4, "text-anchor": k === 0 ? "start" : k === 4 ? "end" : "middle", "font-size": 9 }, Math.round((ts - t0) / 1000) + "s"));
  }
  return el;
}
