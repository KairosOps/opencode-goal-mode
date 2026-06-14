#!/usr/bin/env node
/**
 * Extract the CHANGELOG.md section for a version, for use as a GitHub Release body.
 *
 *   node scripts/release-notes.mjs            # uses package.json version
 *   node scripts/release-notes.mjs 0.3.2      # explicit version
 *   node scripts/release-notes.mjs v0.3.2     # leading v tolerated
 *
 * Prints the section (without the heading) to stdout. Exits non-zero if the
 * version has no CHANGELOG section, so a release can fail loudly rather than ship
 * an empty body.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const arg = process.argv[2] || process.env.RELEASE_VERSION || pkg.version;
const version = String(arg).replace(/^v/, "").trim();

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const lines = changelog.split("\n");

let start = -1;
let end = lines.length;
const headingRe = /^##\s+v?/;
for (let i = 0; i < lines.length; i += 1) {
  if (start === -1) {
    if (headingRe.test(lines[i]) && lines[i].replace(/^##\s+v?/, "").trim() === version) start = i + 1;
  } else if (headingRe.test(lines[i])) {
    end = i;
    break;
  }
}

if (start === -1) {
  console.error(`No CHANGELOG.md section found for version ${version}`);
  process.exit(1);
}

const body = lines.slice(start, end).join("\n").trim();
if (!body) {
  console.error(`CHANGELOG.md section for ${version} is empty`);
  process.exit(1);
}
process.stdout.write(`${body}\n`);
