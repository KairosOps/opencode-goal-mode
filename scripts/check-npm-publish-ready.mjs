#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "skip-registry": { type: "boolean", default: false },
    "skip-tag": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

if (!pkg.name) throw new Error("package.json missing package name");
if (!pkg.version) throw new Error("package.json missing package version");
if (pkg.private) throw new Error("Refusing to publish a private package");
if (pkg.publishConfig?.access !== "public") throw new Error("publishConfig.access must be public");
if (pkg.publishConfig?.registry !== "https://registry.npmjs.org/") {
  throw new Error("publishConfig.registry must be https://registry.npmjs.org/");
}

const releaseTag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "";
if (!values["skip-tag"] && releaseTag) {
  const normalizedTag = releaseTag.startsWith("v") ? releaseTag.slice(1) : releaseTag;
  if (normalizedTag !== pkg.version) {
    throw new Error(`Release tag ${releaseTag} does not match package version ${pkg.version}`);
  }
}

function packageMetadataUrl(name) {
  const registry = pkg.publishConfig.registry.replace(/\/$/, "");
  return `${registry}/${encodeURIComponent(name)}`;
}

if (!values["skip-registry"]) {
  const response = await fetch(packageMetadataUrl(pkg.name), {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });

  if (response.status !== 404) {
    if (!response.ok) throw new Error(`npm registry check failed with HTTP ${response.status}`);
    const metadata = await response.json();
    if (metadata?.versions?.[pkg.version]) {
      throw new Error(`${pkg.name}@${pkg.version} already exists on npm`);
    }
  }
}

console.log(`${pkg.name}@${pkg.version} is ready for npm publishing`);
