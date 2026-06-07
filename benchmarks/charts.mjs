/**
 * Minimal dependency-free SVG chart generator for the benchmark report.
 * Produces grouped bar charts that GitHub renders inline in the README.
 */

const PALETTE = {
  legacy: "#9aa0a6",
  current: "#2da44e",
  axis: "#d0d7de",
  text: "#1f2328",
  subtext: "#656d76",
  grid: "#eaeef2",
  bg: "#ffffff",
};

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Grouped vertical bar chart.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.subtitle
 * @param {string[]} opts.groups        x-axis group labels
 * @param {Array<{name:string,color:string,values:number[]}>} opts.series
 * @param {string} [opts.unit]          appended to value labels (e.g. "%")
 * @param {number} [opts.max]           y-axis max (default 100)
 */
export function groupedBarChart({ title, subtitle, groups, series, unit = "%", max = 100 }) {
  const W = 720;
  const H = 380;
  const padL = 48;
  const padR = 20;
  const padT = 64;
  const padB = 84;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const groupW = plotW / groups.length;
  const barGap = 8;
  const barW = (groupW - barGap * (series.length + 1)) / series.length;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${PALETTE.bg}"/>`);
  parts.push(`<text x="${padL}" y="28" font-size="17" font-weight="700" fill="${PALETTE.text}">${esc(title)}</text>`);
  if (subtitle) parts.push(`<text x="${padL}" y="47" font-size="12" fill="${PALETTE.subtext}">${esc(subtitle)}</text>`);

  // Gridlines + y labels.
  const ticks = 5;
  for (let t = 0; t <= ticks; t += 1) {
    const v = (max / ticks) * t;
    const y = padT + plotH - (v / max) * plotH;
    parts.push(`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="${PALETTE.subtext}">${v}${unit}</text>`);
  }

  // Bars.
  groups.forEach((g, gi) => {
    const gx = padL + gi * groupW;
    series.forEach((s, si) => {
      const v = Math.max(0, Math.min(max, s.values[gi] ?? 0));
      const bh = (v / max) * plotH;
      const x = gx + barGap + si * (barW + barGap);
      const y = padT + plotH - bh;
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${s.color}"/>`);
      parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="11" font-weight="600" text-anchor="middle" fill="${PALETTE.text}">${Math.round(v)}${unit}</text>`);
    });
    parts.push(`<text x="${(gx + groupW / 2).toFixed(1)}" y="${(padT + plotH + 18).toFixed(1)}" font-size="11" text-anchor="middle" fill="${PALETTE.text}">${esc(g)}</text>`);
  });

  // Axis line.
  parts.push(`<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="${PALETTE.axis}" stroke-width="1.5"/>`);

  // Legend.
  const legendY = H - 26;
  let lx = padL;
  series.forEach((s) => {
    parts.push(`<rect x="${lx}" y="${legendY - 10}" width="12" height="12" rx="2" fill="${s.color}"/>`);
    parts.push(`<text x="${lx + 18}" y="${legendY}" font-size="12" fill="${PALETTE.text}">${esc(s.name)}</text>`);
    lx += 24 + s.name.length * 7.2;
  });

  parts.push("</svg>");
  return parts.join("\n");
}

/**
 * Categorical capability matrix: rows = capabilities, columns = platforms,
 * each cell colored by enforcement level. Honest, citable comparison.
 * @param {object} opts
 * @param {string[]} opts.columns
 * @param {Array<{capability:string, cells:string[]}>} opts.rows  cell ∈ levels keys
 */
export function capabilityMatrix({ title, subtitle, columns, rows }) {
  const levels = {
    Enforced: { fill: "#2da44e", text: "#ffffff", label: "Enforced" },
    Partial: { fill: "#d4a72c", text: "#1f2328", label: "Partial" },
    "Prompt-only": { fill: "#dbe9d5", text: "#1f2328", label: "Prompt-only" },
    None: { fill: "#eaeef2", text: "#656d76", label: "None" },
  };
  const W = 760;
  const padL = 300;
  const padT = 70;
  const rowH = 38;
  const colW = (W - padL - 16) / columns.length;
  const legendH = 30;
  const H = padT + rows.length * rowH + legendH + 16;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${PALETTE.bg}"/>`);
  parts.push(`<text x="20" y="28" font-size="17" font-weight="700" fill="${PALETTE.text}">${esc(title)}</text>`);
  if (subtitle) parts.push(`<text x="20" y="47" font-size="12" fill="${PALETTE.subtext}">${esc(subtitle)}</text>`);

  // Column headers.
  columns.forEach((c, ci) => {
    const x = padL + ci * colW + colW / 2;
    parts.push(`<text x="${x.toFixed(1)}" y="${padT - 8}" font-size="12.5" font-weight="700" text-anchor="middle" fill="${PALETTE.text}">${esc(c)}</text>`);
  });

  rows.forEach((r, ri) => {
    const y = padT + ri * rowH;
    parts.push(`<text x="${padL - 14}" y="${y + rowH / 2 + 4}" font-size="12" text-anchor="end" fill="${PALETTE.text}">${esc(r.capability)}</text>`);
    r.cells.forEach((cell, ci) => {
      const lv = levels[cell] || levels.None;
      const x = padL + ci * colW + 4;
      parts.push(`<rect x="${x.toFixed(1)}" y="${y + 4}" width="${(colW - 8).toFixed(1)}" height="${rowH - 8}" rx="4" fill="${lv.fill}"/>`);
      parts.push(`<text x="${(x + (colW - 8) / 2).toFixed(1)}" y="${y + rowH / 2 + 4}" font-size="11" font-weight="600" text-anchor="middle" fill="${lv.text}">${lv.label}</text>`);
    });
  });

  // Legend.
  const ly = padT + rows.length * rowH + 22;
  let lx = padL - 14;
  for (const key of ["Enforced", "Partial", "Prompt-only", "None"]) {
    const lv = levels[key];
    parts.push(`<rect x="${lx}" y="${ly - 11}" width="12" height="12" rx="2" fill="${lv.fill}"/>`);
    parts.push(`<text x="${lx + 17}" y="${ly}" font-size="11.5" fill="${PALETTE.text}">${esc(key)}</text>`);
    lx += 30 + key.length * 7;
  }

  parts.push("</svg>");
  return parts.join("\n");
}

/** Horizontal bar chart for a single-series scorecard with long labels. */
export function horizontalBarChart({ title, subtitle, rows, unit = "", max }) {
  const W = 720;
  const rowH = 38;
  const padT = 64;
  const padB = 24;
  const padL = 230;
  const padR = 70;
  const H = padT + rows.length * rowH + padB;
  const plotW = W - padL - padR;
  const top = Math.max(max ?? Math.max(...rows.map((r) => r.value)) * 1.15, 1);

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${PALETTE.bg}"/>`);
  parts.push(`<text x="20" y="28" font-size="17" font-weight="700" fill="${PALETTE.text}">${esc(title)}</text>`);
  if (subtitle) parts.push(`<text x="20" y="47" font-size="12" fill="${PALETTE.subtext}">${esc(subtitle)}</text>`);

  rows.forEach((r, i) => {
    const y = padT + i * rowH;
    const bw = (Math.min(r.value, top) / top) * plotW;
    parts.push(`<text x="${padL - 12}" y="${y + rowH / 2 + 4}" font-size="12" text-anchor="end" fill="${PALETTE.text}">${esc(r.label)}</text>`);
    parts.push(`<rect x="${padL}" y="${y + 6}" width="${plotW}" height="${rowH - 16}" rx="3" fill="${PALETTE.grid}"/>`);
    parts.push(`<rect x="${padL}" y="${y + 6}" width="${bw.toFixed(1)}" height="${rowH - 16}" rx="3" fill="${r.color || PALETTE.current}"/>`);
    parts.push(`<text x="${(padL + bw + 8).toFixed(1)}" y="${y + rowH / 2 + 4}" font-size="12" font-weight="600" fill="${PALETTE.text}">${r.display ?? r.value + unit}</text>`);
  });

  parts.push("</svg>");
  return parts.join("\n");
}
