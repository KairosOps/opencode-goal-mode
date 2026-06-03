import { mkdirSync, copyFileSync, readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const args = new Set(process.argv.slice(2));
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = args.has("--global")
  ? join(process.env.HOME || "", ".config", "opencode")
  : resolve(process.cwd(), ".opencode");

if (!target || target === ".config/opencode") {
  throw new Error("Cannot resolve OpenCode target directory");
}

function fileHash(path) {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function copyDirFiles(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const dest = join(to, entry);
    if (!statSync(source).isFile()) continue;
    if (args.has("--force")) {
      copyFileSync(source, dest);
      continue;
    }
    if (existsSync(dest)) {
      const srcHash = fileHash(source);
      const dstHash = fileHash(dest);
      if (srcHash === dstHash) continue;
      throw new Error(
        `Refusing to overwrite changed file: ${dest}. Use --force to replace or remove the conflicting file manually.`
      );
    }
    copyFileSync(source, dest);
  }
}

copyDirFiles(join(root, "agents"), join(target, "agents"));
copyDirFiles(join(root, "commands"), join(target, "commands"));
copyDirFiles(join(root, "plugins"), join(target, "plugins"));

console.log(`Installed OpenCode Goal Mode into ${target}`);
console.log("Restart OpenCode for agents, commands, and plugins to load.");
