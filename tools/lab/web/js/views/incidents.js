// Goal Lab — Incident detail (reached from an agent's "Problems & signals").
// Auto-investigated: what happened, why, and exactly what to improve in the plugin.

import { h, clear, clock } from "../util.js";
import { api } from "../api.js";
import { panel, sevTag, empty } from "../components.js";

export function IncidentsView(navigate, incidentId) {
  const body = h("div");
  const el = h("div.view", {}, body);

  api.incident(incidentId).then(({ incident: i }) => {
    clear(body);
    if (!i) { body.append(empty("incident not found")); return; }
    body.append(h("div.panel", {},
      h("div.panel-head", {},
        h("div.row", { style: { gap: "12px" } },
          h("button.btn.sm.ghost", { onclick: () => navigate(`/agent/${i.runId}`), text: "← Run" }),
          sevTag(i.severity),
          h("span.title", { text: i.title }),
          i.desired ? h("span.tag-ok", { text: "guard ok" }) : null,
        ),
      ),
      h("div.panel-body", {},
        h("dl.kv", {}, kv("family", i.family), kv("model", i.modelLabel || ""), kv("task", i.taskTitle || ""), kv("run", i.runId)),
        section("Summary", i.summary),
        section("Hypothesis", i.hypothesis),
        section("What to improve in the plugin", i.suggestedFix),
      ),
    ));
    body.append(panel("Context — events around the trigger", h("div.evh", {},
      (i.context || []).map((e) => h("div.eh-row", { class: e.level === "error" ? "e-row-bad" : "", style: { gridTemplateColumns: "48px 86px 168px 1fr", cursor: "default" } },
        h("span.e-seq", { text: e.seq }),
        h("span.e-time", { text: clock(e.ts) }),
        h("span.e-type.f-" + (e.kind || "").split(".")[0], { text: e.kind }),
        h("span.e-detail", { title: e.detail, text: e.title + (e.detail ? " — " + e.detail : "") }),
      ))), { flush: true }));
  });

  const kv = (k, v) => h("div", { style: { display: "contents" } }, h("dt", { text: k }), h("dd", { text: v }));
  const section = (t, v) => h("div", { style: { marginTop: "14px" } }, h("div.label", { style: { marginBottom: "4px" }, text: t }), h("div", { style: { fontSize: "13px", lineHeight: "1.6" }, text: v || "—" }));
  return { el, destroy() {} };
}
