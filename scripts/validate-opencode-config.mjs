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

// The experimental sidebar is a TUI plugin module (Solid/opentui JSX) that the
// Node runtime cannot import; validate its contract textually instead.
if (!pluginFiles.includes("goal-sidebar.js")) throw new Error("goal sidebar TUI plugin missing");
const sidebarSrc = readFileSync(join(root, "plugins", "goal-sidebar.js"), "utf8");
if (!/export\s+const\s+tui\b/.test(sidebarSrc)) {
  throw new Error("goal-sidebar.js must export a `tui` plugin entry");
}

const forbiddenComponentName = /(auth|session|token|secret|preauth|failures|hosts\.ya?ml)/i;
for (const dir of ["agents", "commands", "plugins"]) {
  for (const file of readdirSync(join(root, dir))) {
    const path = join(root, dir, file);
    if (!statSync(path).isFile()) continue;
    if (forbiddenComponentName.test(file)) throw new Error(`forbidden component filename: ${dir}/${file}`);
  }
}

/** Split a markdown component into [frontmatter, body], erroring on a missing fence. */
function splitFrontmatter(file, text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`${file} missing or malformed YAML frontmatter`);
  return [match[1], match[2]];
}

/** Detect content in the body that should have stayed in frontmatter, or leaked reasoning. */
function assertCleanBody(file, body) {
  if (/<\/?think>/.test(body)) throw new Error(`${file} body contains a leaked reasoning tag`);
  if (/^ext_mcp_server_trust:/m.test(body)) throw new Error(`${file} leaks ext_mcp_server_trust into the body`);
  // A body that opens with a YAML key + block list is almost certainly leaked frontmatter.
  if (/^[a-z_]+:\s*\n(\s+-\s+\S+\n)+/.test(body.replace(/^\s+/, ""))) {
    throw new Error(`${file} body opens with a YAML block that likely leaked from frontmatter`);
  }
}

let primaryCount = 0;
for (const file of agentFiles) {
  const text = readFileSync(join(root, "agents", file), "utf8");
  const [fm, body] = splitFrontmatter(file, text);
  if (!/^description:/m.test(fm)) throw new Error(`${file} missing description`);
  const modeMatch = fm.match(/^mode:\s+(primary|subagent|all)\s*$/m);
  if (!modeMatch) throw new Error(`${file} has invalid mode`);
  if (modeMatch[1] === "primary") primaryCount += 1;
  if (!/^permission:/m.test(fm)) throw new Error(`${file} missing permission`);
  assertCleanBody(file, body);
}
if (primaryCount !== 1) throw new Error(`expected exactly one primary agent, found ${primaryCount}`);

const reviewerNames = agentFiles.filter((f) => /(reviewer|auditor|verifier|quality-gate|completion-guard)/.test(f));
for (const file of reviewerNames) {
  const [fm] = splitFrontmatter(file, readFileSync(join(root, "agents", file), "utf8"));
  if (!/edit:\s+deny/.test(fm)) throw new Error(`${file} (a review gate) must deny edit`);
  if (!/task:\s+deny/.test(fm)) throw new Error(`${file} (a review gate) must deny task nesting`);
}

for (const file of commandFiles) {
  const text = readFileSync(join(root, "commands", file), "utf8");
  const [fm, body] = splitFrontmatter(file, text);
  if (!/^description:/m.test(fm)) throw new Error(`${file} missing description`);
  if (!/^agent:/m.test(fm)) throw new Error(`${file} missing agent`);
  if (!body.includes("$ARGUMENTS")) throw new Error(`${file} command body must reference $ARGUMENTS`);
}

const plugin = await import(join(root, "plugins", "goal-guard.js"));
if (typeof plugin.default !== "function") throw new Error("goal-guard plugin must default-export a function");
const hooks = await plugin.default({ client: { app: { log: async () => undefined } } });
for (const hook of [
  "chat.message",
  "chat.params",
  "experimental.chat.system.transform",
  "tool.execute.before",
  "tool.execute.after",
  "experimental.session.compacting",
  "experimental.text.complete",
  "event",
]) {
  if (typeof hooks?.[hook] !== "function") throw new Error(`goal-guard plugin missing ${hook} hook`);
}
if (hooks.tool && typeof hooks.tool === "object") {
  for (const name of Object.keys(hooks.tool)) {
    if (typeof hooks.tool[name]?.execute !== "function") throw new Error(`custom tool ${name} missing execute`);
  }
}

console.log("OpenCode Goal Mode package validation passed");
