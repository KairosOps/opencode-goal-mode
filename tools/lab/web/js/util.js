// Goal Lab — tiny DOM + formatting helpers (no framework).

/** Hyperscript: h("div.cls#id", { attr }, ...children). */
export function h(spec, props, ...children) {
  const [tag, ...rest] = String(spec).split(/(?=[.#])/);
  const el = document.createElementNS(props?.ns || "http://www.w3.org/1999/xhtml", tag || "div");
  for (const token of rest) {
    if (token[0] === ".") for (const cls of token.slice(1).split(/\s+/)) { if (cls) el.classList.add(cls); }
    else if (token[0] === "#") el.id = token.slice(1);
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === "ns") continue;
      if (v == null || v === false) continue;
      if (k === "class") el.className = (el.className ? el.className + " " : "") + v;
      else if (k === "html") el.innerHTML = v;
      else if (k === "text") el.textContent = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "dataset") for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

const SVGNS = "http://www.w3.org/2000/svg";
/** SVG element builder. */
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) { if (v != null) el.setAttribute(k, v); }
  for (const c of children.flat(Infinity)) { if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export const $ = (sel, root = document) => root.querySelector(sel);

// ---- formatting ----
export function fmtDur(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  if (ms < 1000) return ms + "ms";
  const sFloat = ms / 1000;
  if (sFloat < 60) return sFloat.toFixed(sFloat < 10 ? 1 : 0) + "s";
  const m = Math.floor(sFloat / 60), sec = Math.round(sFloat % 60);
  if (m < 60) return `${m}m${String(sec).padStart(2, "0")}s`;
  const hr = Math.floor(m / 60);
  return `${hr}h${String(m % 60).padStart(2, "0")}m`;
}
export function ago(ts) {
  if (!ts) return "—";
  const d = Date.now() - ts;
  if (d < 1000) return "now";
  if (d < 60000) return Math.floor(d / 1000) + "s";
  if (d < 3600000) return Math.floor(d / 60000) + "m";
  return Math.floor(d / 3600000) + "h";
}
export function clock(ts) {
  if (!ts) return "--:--:--";
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}
export function fmtNum(n) {
  if (n == null || !isFinite(n)) return "—";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return String(Math.round(n));
}
export function fmtPct(x, digits = 0) {
  if (x == null || !isFinite(x)) return "—";
  return (x * 100).toFixed(digits) + "%";
}
export function shortKind(kind) {
  return String(kind).replace("signal.", "✦").replace("run.", "").replace("tool.", "").replace("msg.", "").replace("error.", "err.").replace("subagent.invoked", "subagent").replace("step.", "");
}
