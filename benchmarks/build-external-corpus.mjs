#!/usr/bin/env node
/**
 * Build an EXTERNAL, third-party-authored shell-command corpus for the guard
 * benchmark, so the reported detection / false-positive numbers measure
 * real-world behavior instead of a self-authored set the analyzer was tuned on.
 *
 * Source: the tldr-pages project (https://github.com/tldr-pages/tldr, CC-BY).
 * Every example command in the English `common`, `linux`, and `osx` pages is a
 * real invocation documented by hundreds of contributors who have never seen
 * this analyzer — so the analyzer cannot have been fitted to them.
 *
 * Ground-truth labels come from `labelDestructive()` below: a deliberately
 * SIMPLE, transparent rule based on the primary utility and a fixed list of
 * irreversible operations. It is intentionally independent of the analyzer's
 * own classification logic. It is not perfect (no automatic labeler is) — the
 * benchmark reports raw agreement and discloses the labeler so disagreements
 * are auditable rather than hidden.
 *
 * Usage:
 *   node benchmarks/build-external-corpus.mjs --tldr /path/to/tldr [--limit 600]
 *   TLDR_DIR=/path/to/tldr node benchmarks/build-external-corpus.mjs
 *
 * Writes benchmarks/external-corpus.json (committed, so `npm run bench` is
 * reproducible without a tldr checkout). Re-run this to regenerate it.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    tldr: { type: "string" },
    limit: { type: "string", default: "600" },
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const tldrDir = values.tldr || process.env.TLDR_DIR;
const safeLimit = Math.max(50, Number.parseInt(values.limit, 10) || 600);

if (!tldrDir || !existsSync(tldrDir)) {
  console.error(
    "Need a tldr-pages checkout. Pass --tldr <dir> or set TLDR_DIR.\n" +
      "  git clone --depth 1 https://github.com/tldr-pages/tldr.git",
  );
  process.exit(1);
}

/** Pinned provenance for reproducibility — resolves a symbolic HEAD to its SHA. */
function tldrCommit() {
  try {
    const head = readFileSync(join(tldrDir, ".git", "HEAD"), "utf8").trim();
    const ref = head.match(/^ref:\s*(.+)$/);
    if (!ref) return head;
    return readFileSync(join(tldrDir, ".git", ref[1]), "utf8").trim();
  } catch {
    return "unknown";
  }
}

/**
 * Turn a tldr example line into a real, literal shell command:
 *  - `{{placeholder}}` → its inner text (a realistic argument).
 *  - `[-f|--force]` / `[-r|--recursive]` alternative-flag notation → the first
 *    form (`-f`, `-r`), so the result is a command a shell would actually accept
 *    rather than tldr documentation syntax.
 */
function fillPlaceholders(cmd) {
  return cmd
    .replace(/\{\{(.*?)\}\}/g, (_, inner) => String(inner).trim() || "arg")
    .replace(/\[([^\]|]+)\|[^\]]+\]/g, (_, first) => String(first).trim());
}

/** Independent, transparent destructive-intent labeler (NOT the analyzer). */
function labelDestructive(cmd) {
  const c = cmd.trim();
  // Remote code execution: fetch piped into a shell.
  if (/\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh)\b/.test(c)) return true;
  // Strip a leading wrapper so `sudo rm` / `time rm` resolve to their target.
  const stripped = c.replace(/^(sudo|time|nice|ionice|nohup|env)\s+(-\S+\s+)*/, "");
  const m = stripped.match(/^(\/[^\s]*\/)?([a-zA-Z0-9_.-]+)\b(.*)$/);
  if (!m) return false;
  const bin = m[2];
  const rest = m[3] || "";
  const DESTRUCTIVE_BINS = new Set([
    "rm", "rmdir", "shred", "srm", "dd", "mkfs", "fdisk", "parted",
    "wipefs", "mkswap", "blkdiscard", "sgdisk", "unlink",
  ]);
  if (/^mkfs\./.test(bin)) return true;
  if (DESTRUCTIVE_BINS.has(bin)) {
    if (bin === "dd") return /\bof=\/dev\//.test(rest);
    if (bin === "rmdir") return false; // only removes empty dirs
    return true;
  }
  if (bin === "git") {
    if (/\breset\s+--hard\b/.test(rest)) return true;
    if (/\bclean\b.*\s-\S*f/.test(rest)) return true;
    if (/\bpush\b.*(--force\b|\s-f\b)/.test(rest)) return true;
    if (/\bbranch\b.*\s-D\b/.test(rest)) return true;
    if (/\breflog\s+expire\b/.test(rest)) return true;
    if (/\bgc\b.*--prune/.test(rest)) return true;
    if (/\bfilter-branch\b/.test(rest)) return true;
  }
  return false;
}

const dirs = ["common", "linux", "osx"]
  .map((d) => join(tldrDir, "pages", d))
  .filter((d) => existsSync(d));

const seen = new Set();
const destructive = [];
const safe = [];

for (const dir of dirs) {
  const family = dir.split("/").slice(-1)[0];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const page = file.replace(/\.md$/, "");
    const text = readFileSync(join(dir, file), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      // tldr example commands are fenced in single backticks on their own line.
      if (!trimmed.startsWith("`") || !trimmed.endsWith("`") || trimmed.length < 4) continue;
      const raw = fillPlaceholders(trimmed.slice(1, -1)).trim();
      if (!raw || raw.length > 240) continue;
      if (!/^[a-zA-Z/.~$]/.test(raw)) continue; // must start like a command
      if (seen.has(raw)) continue;
      seen.add(raw);
      const entry = { cmd: raw, page, family };
      if (labelDestructive(raw)) destructive.push(entry);
      else safe.push(entry);
    }
  }
}

/** Deterministic evenly-spaced stride sample (no RNG, so the build is stable). */
function stride(list, target) {
  if (list.length <= target) return list.slice();
  const step = list.length / target;
  const out = [];
  for (let i = 0; i < target; i += 1) out.push(list[Math.floor(i * step)]);
  return out;
}

// Enrich ALL destructive examples (they are rare in real docs) and stride-sample
// safe ones up to the limit. This is disclosed in the report so the imbalance is
// not mistaken for the natural base rate.
destructive.sort((a, b) => a.cmd.localeCompare(b.cmd));
safe.sort((a, b) => a.cmd.localeCompare(b.cmd));
const sampledSafe = stride(safe, safeLimit);

const corpus = {
  source: "tldr-pages",
  url: "https://github.com/tldr-pages/tldr",
  license: "CC-BY-4.0",
  commit: tldrCommit(),
  pages: dirs.map((d) => d.split("/").slice(-2).join("/")),
  labeler: "benchmarks/build-external-corpus.mjs labelDestructive() — independent of the analyzer",
  totals: {
    uniqueCommandsScanned: seen.size,
    destructiveFound: destructive.length,
    safeFound: safe.length,
    safeSampled: sampledSafe.length,
  },
  entries: [...destructive, ...sampledSafe],
};

const outPath = join(here, "external-corpus.json");
writeFileSync(outPath, JSON.stringify(corpus, null, 2));
console.log(
  `Wrote ${corpus.entries.length} external commands ` +
    `(${destructive.length} destructive + ${sampledSafe.length}/${safe.length} safe sampled) ` +
    `from ${seen.size} unique tldr examples @ ${corpus.commit.slice(0, 12)} → ${outPath}`,
);
