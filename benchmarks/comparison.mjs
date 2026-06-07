#!/usr/bin/env node
/**
 * Generates the capability-comparison chart (docs/benchmarks/capability-matrix.svg).
 *
 * The classification reflects published, verifiable behavior as of the research
 * in research/goal-mode-comparison.md (Claude Code docs at code.claude.com,
 * OpenAI Codex docs). It is deliberately conservative and honest: where Claude
 * Code or Codex are genuinely strong (custom hooks, OS sandbox) that is marked,
 * and Goal Mode's prompt-only autonomous loop is NOT claimed as enforced.
 *
 *   node benchmarks/comparison.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { capabilityMatrix } from "./charts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "docs", "benchmarks");
mkdirSync(outDir, { recursive: true });

// columns: Goal Mode, Claude Code, Codex
const ROWS = [
  { capability: "Autonomous goal loop", cells: ["Prompt-only", "Partial", "Partial"] },
  { capability: "Review gate before “done”", cells: ["Enforced", "Partial", "None"] },
  { capability: "Contextual specialist reviews", cells: ["Enforced", "Prompt-only", "Prompt-only"] },
  { capability: "Stale-review invalidation on edit", cells: ["Enforced", "None", "None"] },
  { capability: "Completion-claim enforcement", cells: ["Enforced", "Partial", "None"] },
  { capability: "Destructive-command blocking", cells: ["Enforced", "Partial", "Partial"] },
  { capability: "Remote-exec (curl | sh) blocking", cells: ["Enforced", "Partial", "Partial"] },
  { capability: "Enforcement state survives restart", cells: ["Enforced", "Partial", "Partial"] },
  { capability: "State survives compaction", cells: ["Enforced", "Partial", "Partial"] },
  { capability: "Custom enforcement hooks/tools", cells: ["Enforced", "Enforced", "Partial"] },
];

writeFileSync(
  join(outDir, "capability-matrix.svg"),
  capabilityMatrix({
    title: "Mechanically-enforced goal discipline",
    subtitle: "Enforced = guaranteed by the harness; Prompt-only / Partial = depends on the model or user config.",
    columns: ["Goal Mode", "Claude Code", "Codex"],
    rows: ROWS,
  }),
);

console.log("Wrote docs/benchmarks/capability-matrix.svg");
