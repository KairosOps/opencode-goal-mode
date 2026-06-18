// Goal Lab — app shell. No topbar: the agent list is home, click through to detail.

import { h, clear } from "./util.js";
import { store } from "./store.js";
import { ListView } from "./views/list.js";
import { AgentView } from "./views/agent.js";
import { IncidentsView } from "./views/incidents.js";

export function navigate(path) {
  location.hash = "#" + path;
}

function parseRoute() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "agent" && parts[1]) return { name: "agent", id: parts[1] };
  if (parts[0] === "incidents" && parts[1]) return { name: "incident", id: parts[1] };
  return { name: "list" };
}

function main() {
  const root = document.getElementById("app");
  const mainEl = h("div.main");
  root.append(mainEl);

  let current = null;
  function route() {
    const r = parseRoute();
    if (current?.destroy) current.destroy();
    clear(mainEl);
    let view;
    if (r.name === "agent") view = AgentView(navigate, r.id);
    else if (r.name === "incident") view = IncidentsView(navigate, r.id);
    else view = ListView(navigate);
    current = view;
    mainEl.append(view.el);
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);
  store.connect();
  route();
}

main();
