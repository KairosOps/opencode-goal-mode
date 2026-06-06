#!/usr/bin/env node

import { mkdirSync, copyFileSync, readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    global: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    target: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

if (values.help) {
  console.log(`Install OpenCode Goal Mode components.

Usage:
  node scripts/install.mjs [--global | --target <dir>] [--force] [--dry-run]

Options:
  --global       Install into ~/.config/opencode.
  --target DIR   Install into a specific OpenCode config directory.
  --force        Replace changed destination files.
  --dry-run      Show planned copies without writing files.
  -h, --help     Show this help text.`);
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
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function copyDirFiles(from, to, summary) {
  if (!values["dry-run"]) mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const dest = join(to, entry);
    if (!statSync(source).isFile()) continue;
    if (existsSync(dest) && !statSync(dest).isFile()) {
      summary.conflicts.push(`${dest} exists but is not a file`);
      continue;
    }
    if (values.force) {
      if (!values["dry-run"]) copyFileSync(source, dest);
      summary.copied.push(dest);
      continue;
    }
    if (existsSync(dest)) {
      const srcHash = fileHash(source);
      const dstHash = fileHash(dest);
      if (srcHash === dstHash) {
        summary.unchanged.push(dest);
        continue;
      }
      summary.conflicts.push(`${dest} differs from packaged ${entry}`);
      continue;
    }
    if (!values["dry-run"]) {
      copyFileSync(source, dest);
    }
    summary.copied.push(dest);
  }
}

const target = resolveTarget();
const summary = { copied: [], unchanged: [], conflicts: [] };

copyDirFiles(join(root, "agents"), join(target, "agents"), summary);
copyDirFiles(join(root, "commands"), join(target, "commands"), summary);
copyDirFiles(join(root, "plugins"), join(target, "plugins"), summary);

if (summary.conflicts.length) {
  throw new Error(
    [
      "Refusing to overwrite changed OpenCode component files.",
      ...summary.conflicts.map((conflict) => `- ${conflict}`),
      "Use --force to replace them or remove the conflicting files manually.",
    ].join("\n")
  );
}

const verb = values["dry-run"] ? "Would install" : "Installed";
console.log(`${verb} OpenCode Goal Mode into ${target}`);
console.log(`Files copied: ${summary.copied.length}; unchanged: ${summary.unchanged.length}`);
console.log("Restart OpenCode for agents, commands, and plugins to load.");
