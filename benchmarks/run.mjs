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
import { runTruthfulnessBenchmark } from "./truthfulness.mjs";
import { runExternalBenchmark } from "./external.mjs";

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
const external = runExternalBenchmark();
const truthfulness = runTruthfulnessBenchmark();
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

// Trim the per-command miss/false-positive lists to keep results.json readable;
// the full lists are always available via `node benchmarks/external.mjs --json`.
const externalSummary = {
  source: external.source,
  commit: external.commit,
  totals: external.totals,
  sampleSize: external.sampleSize,
  legacy: {
    detectionRate: Number(external.legacy.detectionRate.toFixed(1)),
    falsePositiveRate: Number(external.legacy.falsePositiveRate.toFixed(1)),
    destCaught: external.legacy.destCaught,
    destTotal: external.legacy.destTotal,
    safeFalsePos: external.legacy.safeFalsePos,
    safeTotal: external.legacy.safeTotal,
  },
  current: {
    detectionRate: Number(external.current.detectionRate.toFixed(1)),
    falsePositiveRate: Number(external.current.falsePositiveRate.toFixed(1)),
    destCaught: external.current.destCaught,
    destTotal: external.current.destTotal,
    safeFalsePos: external.current.safeFalsePos,
    safeTotal: external.current.safeTotal,
    misses: external.current.misses.map((m) => m.cmd),
    falsePositives: external.current.falsePositives.map((f) => f.cmd),
  },
};

const results = {
  // The honest, third-party benchmark: real commands the analyzer was never
  // fitted to. This is the headline number.
  external: externalSummary,
  // Curated REGRESSION FIXTURES: a hand-authored set of known destructive
  // patterns and their safe look-alikes. These define the patterns the analyzer
  // is built to catch and guard against regressions — they are NOT an unbiased
  // sample, so the 100%/0% here is "passes its own spec", not measured accuracy.
  fixtures: {
    corpusSize: CORPUS.length,
    destructiveCount: CORPUS.filter((c) => c.label === "destructive").length,
    safeCount: CORPUS.filter((c) => c.label === "safe").length,
    legacy: { ...legacyEval, opsPerSec: legacyOps, usPerCommand: Number(legacyUs.toFixed(2)) },
    current: { ...currentEval, opsPerSec: currentOps, usPerCommand: Number(currentUs.toFixed(2)) },
  },
  // Completion-enforcement fixtures (hand-authored policy cases), not a survey.
  completionFixtures: truthfulness,
};

writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));

// Headline chart: detection + false positives on the EXTERNAL third-party corpus.
writeFileSync(
  join(outDir, "external-scorecard.svg"),
  groupedBarChart({
    title: "Guard accuracy on real third-party commands",
    subtitle: `${external.sampleSize} tldr-pages commands the analyzer was never fitted to. Detection higher = better; false positives lower = better.`,
    groups: ["Detection rate", "False-positive rate"],
    series: [
      { name: "Legacy regex guard", color: "#9aa0a6", values: [external.legacy.detectionRate, external.legacy.falsePositiveRate] },
      { name: "Goal Mode analyzer", color: "#2da44e", values: [external.current.detectionRate, external.current.falsePositiveRate] },
    ],
  }),
);

// Chart 1: detection rate by command family (CURATED regression fixtures).
writeFileSync(
  join(outDir, "detection-by-family.svg"),
  groupedBarChart({
    title: "Detection by family — curated regression fixtures",
    subtitle: `Curated patterns the analyzer is built to catch (not an unbiased sample). ${results.fixtures.destructiveCount} destructive fixtures.`,
    groups: detFamilies.map((f) => FAMILY_LABELS[f]),
    series: [
      { name: "Legacy regex guard", color: "#9aa0a6", values: detFamilies.map((f) => familyRate(legacyEval, f)) },
      { name: "Goal Mode analyzer", color: "#2da44e", values: detFamilies.map((f) => familyRate(currentEval, f)) },
    ],
  }),
);

// Chart 2: overall scorecard on the CURATED fixtures (passes its own spec).
writeFileSync(
  join(outDir, "overall-scorecard.svg"),
  groupedBarChart({
    title: "Curated fixtures — passes its own spec",
    subtitle: "Curated regression fixtures, not measured accuracy. See external-scorecard.svg for the real-world number.",
    groups: ["Detection rate", "False-positive rate"],
    series: [
      { name: "Legacy regex guard", color: "#9aa0a6", values: [legacyEval.detectionRate, legacyEval.falsePositiveRate] },
      { name: "Goal Mode analyzer", color: "#2da44e", values: [currentEval.detectionRate, currentEval.falsePositiveRate] },
    ],
  }),
);

// Chart 3: per-command latency — the deeper analysis costs a few microseconds,
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

writeFileSync(
  join(outDir, "truthfulness-score.svg"),
  horizontalBarChart({
    title: "Completion-enforcement fixtures",
    subtitle: `${truthfulness.corpusSize} hand-authored policy cases (a spec, not a survey): premature claims blocked, valid ones allowed.`,
    unit: "%",
    max: 100,
    rows: [
      { label: "Truthfulness score", value: truthfulness.score, display: `${truthfulness.score.toFixed(1)}%`, color: "#2da44e" },
      { label: "Decision accuracy", value: truthfulness.decisionAccuracy, display: `${truthfulness.decisionAccuracy.toFixed(1)}%`, color: "#0969da" },
      { label: "Reason accuracy", value: truthfulness.reasonAccuracy, display: `${truthfulness.reasonAccuracy.toFixed(1)}%`, color: "#bf8700" },
    ],
  }),
);

const pct = (n) => `${n.toFixed(1)}%`;
console.log("Goal Mode shell-guard benchmark");
console.log("================================");
console.log("");
console.log(`HEADLINE — external corpus: ${external.sampleSize} real tldr-pages commands @ ${external.commit.slice(0, 12)}`);
console.log(`  (${external.totals.destructiveFound} destructive [all found] + ${external.totals.safeSampled}/${external.totals.safeFound} safe sampled)`);
console.log(`  Detection       legacy ${pct(external.legacy.detectionRate)}   →   Goal Mode ${pct(external.current.detectionRate)}`);
console.log(`  False positives legacy ${pct(external.legacy.falsePositiveRate)}   →   Goal Mode ${pct(external.current.falsePositiveRate)}`);
console.log(`  Remaining Goal Mode misses: ${external.current.misses.length} (mostly un-flagged single-target rm — see external.mjs --json)`);
console.log("");
console.log(`Curated regression fixtures: ${results.fixtures.corpusSize} commands (defines patterns to catch; not an unbiased sample)`);
console.log(`  Detection   legacy ${pct(legacyEval.detectionRate)}   →   Goal Mode ${pct(currentEval.detectionRate)}   (passes its own spec)`);
console.log(`  False pos   legacy ${pct(legacyEval.falsePositiveRate)}   →   Goal Mode ${pct(currentEval.falsePositiveRate)}`);
console.log(`Completion-enforcement fixtures: ${truthfulness.corpusSize} hand-authored policy cases, all pass (a spec, not a survey)`);
console.log(`Latency: Goal Mode ${currentUs.toFixed(2)} µs/cmd (${fmt(currentOps)}/s)`);
console.log("");
console.log(`Wrote results.json + 5 SVG charts to docs/benchmarks/`);
