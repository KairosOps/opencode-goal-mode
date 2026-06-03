import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

if (!pkg.type || pkg.type !== "module") throw new Error("package.json must use ESM type module");
if (!pkg.scripts?.test || !pkg.scripts?.validate) throw new Error("package.json missing test/validate scripts");

const agentFiles = readdirSync(join(root, "agents")).filter((file) => file.endsWith(".md"));
const commandFiles = readdirSync(join(root, "commands")).filter((file) => file.endsWith(".md"));

for (const file of agentFiles) {
  const text = readFileSync(join(root, "agents", file), "utf8");
  if (!text.startsWith("---\n")) throw new Error(`${file} missing frontmatter`);
  if (!/^description:/m.test(text)) throw new Error(`${file} missing description`);
  if (!/^mode:\s+(primary|subagent|all)$/m.test(text)) throw new Error(`${file} has invalid mode`);
  if (!/^permission:/m.test(text)) throw new Error(`${file} missing permission`);
}

for (const file of commandFiles) {
  const text = readFileSync(join(root, "commands", file), "utf8");
  if (!text.startsWith("---\n")) throw new Error(`${file} missing frontmatter`);
  if (!/^description:/m.test(text)) throw new Error(`${file} missing description`);
  if (!/^agent:/m.test(text)) throw new Error(`${file} missing agent`);
}

await import(join(root, "plugins", "goal-guard.js"));

console.log("OpenCode Goal Mode package validation passed");
