#!/usr/bin/env node

import {
  mkdirSync,
  copyFileSync,
  readdirSync,
  statSync,
  lstatSync,
  rmdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    global: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    uninstall: { type: "boolean", default: false },
    target: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Component directories installed into an OpenCode config dir. */
const COMPONENT_DIRS = ["agents", "commands", "plugins"];
const MANIFEST_NAME = ".goal-mode-manifest.json";

if (values.help) {
  console.log(`Install or remove OpenCode Goal Mode components.

Usage:
  node scripts/install.mjs [--global | --target <dir>] [--force] [--dry-run]
  node scripts/install.mjs --uninstall [--global | --target <dir>] [--dry-run]

Options:
  --global       Install into ~/.config/opencode.
  --target DIR   Install into a specific OpenCode config directory.
  --force        Replace destination files even if locally modified.
  --uninstall    Remove files this installer previously wrote (per manifest).
  --dry-run      Show planned changes without writing.
  -h, --help     Show this help text.

The installer records a manifest of the files it writes so that a later
upgrade can distinguish files it owns (safe to replace) from files you have
locally customized (left untouched unless --force).`);
  process.exit(0);
}

if (values.global && values.target) {
  throw new Error("Use either --global or --target, not both");
}

function resolveTarget() {
  if (values.target) return resolve(String(values.target));
  if (values.global) {
    const home = process.env.HOME;
    if (!home) throw new Error("Cannot resolve HOME for --global install");
    return join(home, ".config", "opencode");
  }
  return resolve(process.cwd(), ".opencode");
}

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
}

/** Recursively list regular files under a directory, returning paths relative to
 * `base`. Uses lstat and skips symlinks so the installer only copies files it can
 * reason about (no following links outside the package tree). */
function listFiles(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) listFiles(abs, base, out);
    else if (st.isFile()) out.push(relative(base, abs));
  }
  return out;
}

/** Remove directories left empty by file removal, bottom-up, within the target. */
function pruneEmptyDirs(targetRoot, relFiles) {
  const dirs = new Set();
  for (const rel of relFiles) {
    let d = dirname(rel);
    while (d && d !== "." && d !== "/") {
      dirs.add(d);
      d = dirname(d);
    }
  }
  // Deepest first so parents become empty after their children are removed.
  for (const rel of [...dirs].sort((a, b) => b.length - a.length)) {
    const abs = join(targetRoot, rel);
    try {
      if (existsSync(abs) && statSync(abs).isDirectory() && readdirSync(abs).length === 0) rmdirSync(abs);
    } catch {
      /* ignore */
    }
  }
}

const target = resolveTarget();
const manifestPath = join(target, MANIFEST_NAME);

function loadManifest() {
  try {
    const data = JSON.parse(readFileSync(manifestPath, "utf8"));
    return data && typeof data === "object" && data.files ? data : { version: null, files: {} };
  } catch {
    return { version: null, files: {} };
  }
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

if (values.uninstall) {
  const manifest = loadManifest();
  const removed = [];
  const kept = [];
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const dest = join(target, rel);
    if (!existsSync(dest)) continue;
    if (fileHash(dest) === hash) {
      if (!values["dry-run"]) rmSync(dest, { force: true });
      removed.push(rel);
    } else {
      kept.push(rel);
    }
  }
  if (!values["dry-run"] && existsSync(manifestPath)) rmSync(manifestPath, { force: true });
  if (!values["dry-run"]) pruneEmptyDirs(target, Object.keys(manifest.files));
  const verb = values["dry-run"] ? "Would remove" : "Removed";
  console.log(`${verb} ${removed.length} Goal Mode files from ${target}.`);
  if (kept.length) {
    console.log(`Left ${kept.length} locally-modified file(s) in place:`);
    for (const rel of kept) console.log(`- ${rel}`);
  }
  console.log("Restart OpenCode to unload the components.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

const manifest = loadManifest();
const summary = { copied: [], unchanged: [], conflicts: [], pruned: [] };
const newManifestFiles = {};

for (const dir of COMPONENT_DIRS) {
  const from = join(root, dir);
  for (const rel of listFiles(from)) {
    const relKey = join(dir, rel);
    const source = join(from, rel);
    const dest = join(target, relKey);
    const srcHash = fileHash(source);
    newManifestFiles[relKey] = srcHash;

    if (existsSync(dest) && !statSync(dest).isFile()) {
      summary.conflicts.push(`${dest} exists but is not a file`);
      continue;
    }

    if (!existsSync(dest)) {
      if (!values["dry-run"]) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(source, dest);
      }
      summary.copied.push(dest);
      continue;
    }

    const dstHash = fileHash(dest);
    if (dstHash === srcHash) {
      summary.unchanged.push(dest);
      continue;
    }

    const ownedHash = manifest.files[relKey];
    const weOwnIt = ownedHash !== undefined && ownedHash === dstHash;
    if (values.force || weOwnIt) {
      if (!values["dry-run"]) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(source, dest);
      }
      summary.copied.push(dest);
      continue;
    }
    summary.conflicts.push(`${dest} differs from packaged ${relKey} and was locally modified`);
  }
}

// Prune files we installed in a previous version that no longer ship (e.g. a
// plugin split into modules), but only if the user hasn't modified them.
for (const [relKey, oldHash] of Object.entries(manifest.files)) {
  if (newManifestFiles[relKey] !== undefined) continue;
  const dest = join(target, relKey);
  if (!existsSync(dest)) continue;
  if (fileHash(dest) === oldHash) {
    if (!values["dry-run"]) rmSync(dest, { force: true });
    summary.pruned.push(relKey);
  }
}
if (!values["dry-run"] && summary.pruned.length) pruneEmptyDirs(target, summary.pruned);

if (summary.conflicts.length) {
  throw new Error(
    [
      "Refusing to overwrite changed OpenCode component files.",
      ...summary.conflicts.map((conflict) => `- ${conflict}`),
      "Use --force to replace them or remove the conflicting files manually.",
    ].join("\n"),
  );
}

if (!values["dry-run"]) {
  mkdirSync(target, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ version: pkg.version, files: newManifestFiles }, null, 2), "utf8");
}

const verb = values["dry-run"] ? "Would install" : "Installed";
console.log(`${verb} OpenCode Goal Mode ${pkg.version} into ${target}`);
console.log(
  `Files copied: ${summary.copied.length}; unchanged: ${summary.unchanged.length}; pruned: ${summary.pruned.length}`,
);
console.log("Restart OpenCode for agents, commands, and plugins to load.");
