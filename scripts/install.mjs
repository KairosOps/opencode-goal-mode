import { mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = new Set(process.argv.slice(2));
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = args.has("--global")
  ? join(process.env.HOME || "", ".config", "opencode")
  : resolve(process.cwd(), ".opencode");

if (!target || target === ".config/opencode") {
  throw new Error("Cannot resolve OpenCode target directory");
}

function copyDirFiles(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const dest = join(to, entry);
    if (statSync(source).isFile()) copyFileSync(source, dest);
  }
}

copyDirFiles(join(root, "agents"), join(target, "agents"));
copyDirFiles(join(root, "commands"), join(target, "commands"));
copyDirFiles(join(root, "plugins"), join(target, "plugins"));

console.log(`Installed OpenCode Goal Mode into ${target}`);
console.log("Restart OpenCode for agents, commands, and plugins to load.");
