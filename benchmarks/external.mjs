#!/usr/bin/env node
/**
 * Run the shell guard against the EXTERNAL, third-party-authored corpus built by
 * build-external-corpus.mjs (real tldr-pages commands). This is the honest
 * benchmark: the analyzer authors did not write or curate these commands, so the
 * detection / false-positive numbers reflect real-world behavior, warts and all.
 *
 * It deliberately also reports DISAGREEMENTS between the analyzer and the
 * independent ground-truth labeler, so misses and false positives are auditable
 * rather than averaged away.
 *
 *   node benchmarks/external.mjs            # summary
 *   node benchmarks/external.mjs --json     # full machine-readable result
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as current from "../plugins/goal-guard/shell.js";
import * as legacy from "./legacy-analyzer.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function loadExternalCorpus() {
  return JSON.parse(readFileSync(join(here, "external-corpus.json"), "utf8"));
}

function blocked(analyzer, cmd) {
  const a = analyzer.analyzeCommand(cmd);
  return Boolean(a.destructive || a.networkExec);
}

/** Evaluate one analyzer over labeled entries (each {cmd, page, destructive}). */
function score(analyzer, labeled) {
  let destTotal = 0;
  let destCaught = 0;
  let safeTotal = 0;
  let safeFalsePos = 0;
  const misses = [];
  const falsePositives = [];
  for (const e of labeled) {
    const isBlocked = blocked(analyzer, e.cmd);
    if (e.destructive) {
      destTotal += 1;
      if (isBlocked) destCaught += 1;
      else misses.push({ cmd: e.cmd, page: e.page });
    } else {
      safeTotal += 1;
      if (isBlocked) {
        safeFalsePos += 1;
        falsePositives.push({ cmd: e.cmd, page: e.page });
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
    misses,
    falsePositives,
  };
}

export function runExternalBenchmark() {
  const corpus = loadExternalCorpus();
  // The corpus is written destructive-first then safe (see build-external-corpus.mjs),
  // so the recorded count is the label boundary — no re-running the labeler needed.
  const labeled = corpus.entries.map((e, i) => ({ ...e, destructive: i < corpus.totals.destructiveFound }));
  return {
    source: corpus.source,
    commit: corpus.commit,
    totals: corpus.totals,
    sampleSize: labeled.length,
    legacy: score(legacy, labeled),
    current: score(current, labeled),
  };
}

function pct(n) {
  return `${n.toFixed(1)}%`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = runExternalBenchmark();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log("External shell-guard benchmark (third-party tldr-pages commands)");
    console.log("================================================================");
    console.log(`Source: ${r.source} @ ${r.commit.slice(0, 12)}`);
    console.log(
      `Sample: ${r.sampleSize} commands ` +
        `(${r.totals.destructiveFound} destructive [all found], ` +
        `${r.totals.safeSampled}/${r.totals.safeFound} safe sampled)`,
    );
    console.log("");
    console.log(`Detection (destructive caught)   legacy ${pct(r.legacy.detectionRate)}   →   current ${pct(r.current.detectionRate)}`);
    console.log(`False positives on safe commands legacy ${pct(r.legacy.falsePositiveRate)}   →   current ${pct(r.current.falsePositiveRate)}`);
    console.log("");
    console.log(`Current analyzer misses (${r.current.misses.length}):`);
    for (const m of r.current.misses.slice(0, 20)) console.log(`  - ${m.cmd}   [${m.page}]`);
    if (r.current.misses.length > 20) console.log(`  … ${r.current.misses.length - 20} more`);
    console.log(`Current analyzer false positives (${r.current.falsePositives.length}):`);
    for (const f of r.current.falsePositives.slice(0, 20)) console.log(`  - ${f.cmd}   [${f.page}]`);
    if (r.current.falsePositives.length > 20) console.log(`  … ${r.current.falsePositives.length - 20} more`);
  }
}
