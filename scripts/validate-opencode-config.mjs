import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

if (!pkg.type || pkg.type !== "module") throw new Error("package.json must use ESM type module");
if (pkg.private) throw new Error("package.json must not be private when npm publishing is enabled");
if (!pkg.engines?.node) throw new Error("package.json missing Node engine requirement");
if (!pkg.bin?.["opencode-goal-mode-install"]) throw new Error("package.json missing installer bin");
if (pkg.publishConfig?.access !== "public") throw new Error("package.json publishConfig.access must be public");
if (pkg.publishConfig?.registry !== "https://registry.npmjs.org/") {
  throw new Error("package.json publishConfig.registry must target npmjs.org");
}
if (!pkg.files?.includes("agents/") || !pkg.files?.includes("commands/") || !pkg.files?.includes("plugins/")) {
  throw new Error("package.json files must include installable OpenCode component directories");
}
for (const script of [
  "test",
  "validate",
  "ci",
  "prepublishOnly",
  "install:local",
  "install:global",
  "pack:check",
  "publish:check",
  "audit",
]) {
  if (!pkg.scripts?.[script]) throw new Error(`package.json missing ${script} script`);
}
for (const file of ["README.md", "LICENSE", ".npmignore", ".nvmrc"]) {
  if (!existsSync(join(root, file))) throw new Error(`${file} missing`);
}

const agentFiles = readdirSync(join(root, "agents")).filter((file) => file.endsWith(".md"));
const commandFiles = readdirSync(join(root, "commands")).filter((file) => file.endsWith(".md"));
const pluginFiles = readdirSync(join(root, "plugins")).filter((file) => file.endsWith(".js"));

if (!agentFiles.includes("goal.md")) throw new Error("primary goal agent missing");
if (!commandFiles.includes("goal.md")) throw new Error("primary goal command missing");
if (!pluginFiles.includes("goal-guard.js")) throw new Error("goal guard plugin missing");

const forbiddenComponentName = /(auth|session|token|secret|preauth|failures|hosts\.ya?ml)/i;
for (const dir of ["agents", "commands", "plugins"]) {
  for (const file of readdirSync(join(root, dir))) {
    const path = join(root, dir, file);
    if (!statSync(path).isFile()) continue;
    if (forbiddenComponentName.test(file)) throw new Error(`forbidden component filename: ${dir}/${file}`);
  }
}

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

const plugin = await import(join(root, "plugins", "goal-guard.js"));
if (typeof plugin.default !== "function") throw new Error("goal-guard plugin must default-export a function");
const hooks = await plugin.default({ client: { app: { log: async () => undefined } } });
for (const hook of [
  "chat.params",
  "tool.execute.before",
  "tool.execute.after",
  "experimental.session.compacting",
  "experimental.text.complete",
  "event",
]) {
  if (typeof hooks?.[hook] !== "function") throw new Error(`goal-guard plugin missing ${hook} hook`);
}

console.log("OpenCode Goal Mode package validation passed");
