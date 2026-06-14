import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

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
// Node runtime cannot import; validate its contract textually instead. It must
// follow the proven TUI-plugin shape: a SINGLE `export default { id, tui }` (no
// stray `export const`, which OpenCode's loader would treat as extra plugins).
if (!pluginFiles.includes("goal-sidebar.js")) throw new Error("goal sidebar TUI plugin missing");
const sidebarSrc = readFileSync(join(root, "plugins", "goal-sidebar.js"), "utf8");
if (!/export default \{[^}]*\btui\b/.test(sidebarSrc)) {
  throw new Error("goal-sidebar.js must `export default { id, tui }`");
}
if (/^export\s+const\s/m.test(sidebarSrc)) {
  throw new Error("goal-sidebar.js must not use `export const` (OpenCode loads every export; use a single default object)");
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

// Exactly one user-selectable agent: `goal` is `primary`; every other agent MUST
// be `subagent` so the user can only ever pick Goal — the specialist subagents are
// invoked by the Goal agent (via the task tool), never selected by the user. `all`
// is forbidden because it would expose a subagent in the user's agent picker.
//
// The frontmatter is parsed as REAL YAML (not regex): OpenCode itself parses it
// with a YAML parser, and a malformed value (e.g. an invalid `\.` escape in an
// `external_directory` glob, or an unquoted `: ` in a description) makes OpenCode
// silently drop to `mode: all` with NO permissions applied. Regex matching missed
// that class of bug, so it shipped; YAML.parse here catches it.
let primaryCount = 0;
for (const file of agentFiles) {
  const text = readFileSync(join(root, "agents", file), "utf8");
  const [fm, body] = splitFrontmatter(file, text);

  let meta;
  try {
    meta = parseYaml(fm);
  } catch (err) {
    throw new Error(`${file} frontmatter is not valid YAML (OpenCode would drop it to mode:all): ${String(err.message).split("\n")[0]}`);
  }
  if (!meta || typeof meta !== "object") throw new Error(`${file} frontmatter did not parse to a mapping`);
  if (typeof meta.description !== "string" || !meta.description.trim()) throw new Error(`${file} missing description`);
  if (!["primary", "subagent", "all"].includes(meta.mode)) throw new Error(`${file} has invalid mode: ${JSON.stringify(meta.mode)}`);
  if (file === "goal.md") {
    if (meta.mode !== "primary") throw new Error(`goal.md must be the primary agent (found "${meta.mode}")`);
    primaryCount += 1;
  } else if (meta.mode !== "subagent") {
    throw new Error(`${file} must be mode: subagent (only goal is user-selectable; found "${meta.mode}")`);
  }
  if (meta.permission === undefined) throw new Error(`${file} missing permission`);
  assertCleanBody(file, body);
}
if (primaryCount !== 1) throw new Error(`expected exactly one primary agent (goal), found ${primaryCount}`);

const reviewerNames = agentFiles.filter((f) => /(reviewer|auditor|verifier|quality-gate|completion-guard)/.test(f));
for (const file of reviewerNames) {
  const [fm] = splitFrontmatter(file, readFileSync(join(root, "agents", file), "utf8"));
  const perm = parseYaml(fm)?.permission || {};
  if (perm.edit !== "deny") throw new Error(`${file} (a review gate) must set permission.edit: deny`);
  if (perm.task !== "deny") throw new Error(`${file} (a review gate) must set permission.task: deny`);
}

for (const file of commandFiles) {
  const text = readFileSync(join(root, "commands", file), "utf8");
  const [fm, body] = splitFrontmatter(file, text);
  if (!/^description:/m.test(fm)) throw new Error(`${file} missing description`);
  if (!/^agent:/m.test(fm)) throw new Error(`${file} missing agent`);
  if (!body.includes("$ARGUMENTS")) throw new Error(`${file} command body must reference $ARGUMENTS`);
}

const plugin = await import(join(root, "plugins", "goal-guard.js"));
// OpenCode loads EVERY export of a plugin file as a plugin factory, so the entry
// must export ONLY the default function. Any extra export (a test helper object,
// a second factory) makes OpenCode fail with "Plugin export is not a function".
const extraEntryExports = Object.keys(plugin).filter((k) => k !== "default");
if (extraEntryExports.length) {
  throw new Error(`goal-guard.js must export ONLY a default plugin; extra exports break OpenCode loading: ${extraEntryExports.join(", ")}`);
}
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
