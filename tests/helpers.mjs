import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const root = fileURLToPath(new URL("..", import.meta.url));

export function filesIn(dir) {
  return readdirSync(join(root, dir)).filter((file) => file.endsWith(".md") || file.endsWith(".js"));
}

export function readRepo(path) {
  return readFileSync(join(root, path), "utf8");
}

export function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("Missing YAML frontmatter");
  return match[1];
}

export function hasLine(fm, key) {
  return new RegExp(`^${key}:`, "m").test(fm);
}
