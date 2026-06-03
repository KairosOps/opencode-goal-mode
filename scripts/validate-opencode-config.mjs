import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

if (!pkg.type || pkg.type !== "module") throw new Error("package.json must use ESM type module");
if (!pkg.scripts?.test || !pkg.scripts?.validate) throw new Error("package.json missing test/validate scripts");

console.log("OpenCode Goal Mode package validation passed");
