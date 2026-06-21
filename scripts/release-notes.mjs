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
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const versionHeadingRe = /^##\s+v?(\d+\.\d+\.\d+(?:[-+][^\s]+)?)(?:\s|$)/;

export function extractReleaseNotes(changelog, requestedVersion) {
  const version = String(requestedVersion).replace(/^v/, "").trim();
  const lines = String(changelog).split("\n");

  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const heading = lines[i].match(versionHeadingRe);
    if (start === -1) {
      if (heading?.[1] === version) start = i + 1;
    } else if (heading) {
      end = i;
      break;
    }
  }

  if (start === -1) throw new Error(`No CHANGELOG.md section found for version ${version}`);

  const body = lines.slice(start, end).join("\n").trim();
  if (!body) throw new Error(`CHANGELOG.md section for ${version} is empty`);
  return body;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2] || process.env.RELEASE_VERSION || pkg.version;
  try {
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    process.stdout.write(`${extractReleaseNotes(changelog, arg)}\n`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
