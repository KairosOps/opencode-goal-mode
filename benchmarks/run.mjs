#!/usr/bin/env node
/**
 * Reproducible benchmark of the shell-command guard.
 *
 * Compares the original regex classifier (benchmarks/legacy-analyzer.mjs,
 * preserved verbatim from the first release) against the current quote-aware
 * analyzer (plugins/goal-guard/shell.js) on a labeled corpus, and measures
 * detection rate, false-positive rate, and throughput. Writes results.json and
 * the SVG charts embedded in the README.
 *
 *   node benchmarks/run.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { CORPUS } from "./corpus.mjs";
import * as current from "../plugins/goal-guard/shell.js";
import * as legacy from "./legacy-analyzer.mjs";
import { groupedBarChart, horizontalBarChart } from "./charts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "docs", "benchmarks");
mkdirSync(outDir, { recursive: true });

/** A command is "blocked" when flagged destructive or as remote execution. */
function blocked(analyzer, cmd) {
  const a = analyzer.analyzeCommand(cmd);
  return Boolean(a.destructive || a.networkExec);
}

function evaluate(analyzer) {
  const families = {};
  let destTotal = 0;
  let destCaught = 0;
  let safeTotal = 0;
  let safeFalsePos = 0;

  for (const { cmd, label, family } of CORPUS) {
    families[family] ??= { destTotal: 0, destCaught: 0, safeTotal: 0, safeFalsePos: 0 };
    const isBlocked = blocked(analyzer, cmd);
    if (label === "destructive") {
      destTotal += 1;
      families[family].destTotal += 1;
      if (isBlocked) {
        destCaught += 1;
        families[family].destCaught += 1;
      }
    } else {
      safeTotal += 1;
      families[family].safeTotal += 1;
      if (isBlocked) {
        safeFalsePos += 1;
        families[family].safeFalsePos += 1;
      }
    }
  }

  return {
    detectionRate: destTotal ? (destCaught / destTotal) * 100 : 0,
    falsePositiveRate: safeTotal ? (safeFalsePos / safeTotal) * 100 : 0,
    destCaught,
    destTotal,
    safeFalsePos,
    safeTotal,
    families,
  };
}

function throughput(analyzer) {
  const cmds = CORPUS.map((c) => c.cmd);
  // Warm up.
  for (const c of cmds) analyzer.analyzeCommand(c);
  const iterations = 4000;
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    for (const c of cmds) analyzer.analyzeCommand(c);
  }
  const ms = performance.now() - start;
  const ops = (iterations * cmds.length) / (ms / 1000);
  return Math.round(ops);
}

/** Locale-independent thousands grouping (the host locale may use '.' as separator). */
function fmt(n) {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const legacyEval = evaluate(legacy);
const currentEval = evaluate(current);
const legacyOps = throughput(legacy);
const currentOps = throughput(current);
const legacyUs = 1e6 / legacyOps;
const currentUs = 1e6 / currentOps;

const FAMILY_LABELS = {
  classic: "Classic",
  bypass: "Obfuscated",
  "remote-exec": "Remote exec",
};
const detFamilies = ["classic", "bypass", "remote-exec"];

function familyRate(ev, fam) {
  const f = ev.families[fam];
  return f && f.destTotal ? (f.destCaught / f.destTotal) * 100 : 0;
}

const results = {
  corpusSize: CORPUS.length,
  destructiveCount: CORPUS.filter((c) => c.label === "destructive").length,
  safeCount: CORPUS.filter((c) => c.label === "safe").length,
  legacy: { ...legacyEval, opsPerSec: legacyOps, usPerCommand: Number(legacyUs.toFixed(2)) },
  current: { ...currentEval, opsPerSec: currentOps, usPerCommand: Number(currentUs.toFixed(2)) },
};

writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));

// Chart 1: detection rate by command family.
writeFileSync(
  join(outDir, "detection-by-family.svg"),
  groupedBarChart({
    title: "Destructive-command detection rate by family",
    subtitle: `Higher is better. Corpus: ${results.destructiveCount} destructive commands.`,
    groups: detFamilies.map((f) => FAMILY_LABELS[f]),
    series: [
      { name: "Legacy regex guard", color: "#9aa0a6", values: detFamilies.map((f) => familyRate(legacyEval, f)) },
      { name: "Goal Mode analyzer", color: "#2da44e", values: detFamilies.map((f) => familyRate(currentEval, f)) },
    ],
  }),
);

// Chart 2: overall scorecard (detection up, false positives down).
writeFileSync(
  join(outDir, "overall-scorecard.svg"),
  groupedBarChart({
    title: "Overall guard accuracy",
    subtitle: "Detection rate (higher better) vs false-positive rate (lower better).",
    groups: ["Detection rate", "False-positive rate"],
    series: [
      { name: "Legacy regex guard", color: "#9aa0a6", values: [legacyEval.detectionRate, legacyEval.falsePositiveRate] },
      { name: "Goal Mode analyzer", color: "#2da44e", values: [currentEval.detectionRate, currentEval.falsePositiveRate] },
    ],
  }),
);

// Chart 3: per-command latency — the deeper analysis costs ~1 microsecond more,
// which is negligible for a tool-call guard. Shown for honesty, not as a "win".
writeFileSync(
  join(outDir, "latency.svg"),
  horizontalBarChart({
    title: "Per-command analysis latency",
    subtitle: "Microseconds to classify one command. Both are negligible for a tool-call guard.",
    unit: " µs",
    max: Math.max(legacyUs, currentUs) * 1.4,
    rows: [
      { label: "Legacy regex guard", value: legacyUs, display: `${legacyUs.toFixed(2)} µs`, color: "#9aa0a6" },
      { label: "Goal Mode analyzer", value: currentUs, display: `${currentUs.toFixed(2)} µs`, color: "#2da44e" },
    ],
  }),
);

const pct = (n) => `${n.toFixed(1)}%`;
console.log("Goal Mode shell-guard benchmark");
console.log("================================");
console.log(`Corpus: ${results.corpusSize} commands (${results.destructiveCount} destructive, ${results.safeCount} safe)`);
console.log("");
console.log(`Detection rate   legacy ${pct(legacyEval.detectionRate)}   →   Goal Mode ${pct(currentEval.detectionRate)}`);
console.log(`False positives  legacy ${pct(legacyEval.falsePositiveRate)}   →   Goal Mode ${pct(currentEval.falsePositiveRate)}`);
console.log(`Latency          legacy ${legacyUs.toFixed(2)} µs/cmd   →   Goal Mode ${currentUs.toFixed(2)} µs/cmd (${fmt(currentOps)}/s)`);
console.log("");
console.log("By family (detection rate):");
for (const f of detFamilies) {
  console.log(`  ${FAMILY_LABELS[f].padEnd(12)} legacy ${pct(familyRate(legacyEval, f)).padStart(6)}  →  Goal Mode ${pct(familyRate(currentEval, f)).padStart(6)}`);
}
console.log("");
console.log(`Wrote results.json + 3 SVG charts to docs/benchmarks/`);
