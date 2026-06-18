// Goal Lab — shared presentational components (Cloudflare/Kumo, semantic).

import { h } from "./util.js";

export function panel(title, body, { actions, flush, sub } = {}) {
  const head = title || actions
    ? h("div.panel-head", {},
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
          title ? h("span.title", { text: title }) : null,
          sub ? h("span.dim", { style: { fontSize: "12px" }, text: sub }) : null),
        actions ? h("div.row", {}, actions) : null)
    : null;
  return h("div.panel", {}, head, h("div.panel-body" + (flush ? ".flush" : ""), {}, body));
}

const STATUS_LABEL = { queued: "Queued", starting: "Starting", running: "Running", settling: "Settling", completed: "Completed", failed: "Failed", aborted: "Aborted", timeout: "Timeout" };
export function statusText(status) {
  return h("span.st.s-" + status, { text: STATUS_LABEL[status] || status });
}

/** Inline legend row: items = [{ label, color }] where color is a CSS color/var. */
export function legend(items) {
  return h("div.legend", {}, items.map((it) => h("span.lg", {}, h("i", { style: { background: it.color } }), h("span", { text: it.label }))));
}

const OUTCOME_LABEL = { earned: "Earned", "blocked-safety": "Safety block ✓", "guarded-incomplete": "Guarded", incomplete: "Incomplete", "bait-not-attempted": "Not attempted", "missed-safety": "SAFETY MISS", error: "Error", aborted: "Aborted", pending: "—" };
export function outcomeText(outcome) {
  const r = outcome?.result || "pending";
  return h("span.oc." + r, { text: OUTCOME_LABEL[r] || r });
}

export function sevTag(sev, text) {
  return h("span.sev." + sev, { text: text != null ? text : sev });
}

/** Problem marker for list rows: critical (red) / warning (amber) / none. */
export function problemMark(run) {
  const n = run.incidentCount || 0;
  const worst = run.worstIncident;
  const bad = run.outcome?.result === "missed-safety" || worst === "critical";
  if (bad) return h("span.prob.crit", {}, h("span.dotp"), String(n || 1) + " critical");
  if (worst === "high") return h("span.prob.crit", {}, h("span.dotp"), n + " issue" + (n === 1 ? "" : "s"));
  if (n > 0) return h("span.prob.warnp", {}, h("span.dotp"), n + " note" + (n === 1 ? "" : "s"));
  return h("span.prob.none", { text: "—" });
}

export function meter(frac, { variant } = {}) {
  const w = Math.max(0, Math.min(1, frac || 0)) * 100;
  return h("div.meter" + (variant ? "." + variant : ""), {}, h("i", { style: { width: w + "%" } }));
}

export function empty(msg, big) {
  return h("div.empty", {}, big ? h("div.big", { text: big }) : null, h("div", { text: msg }));
}

export function stat(label, value, flag) {
  return h("div.stat", {}, h("div.s-label", { text: label }), h("div.s-val" + (flag ? "." + flag : ""), { text: value }));
}
