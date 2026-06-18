/**
 * Fresh-install verification — proves the PUBLISHED package works for a brand-new
 * user on a clean system, end to end:
 *
 *   1. `npm pack` the repo (the exact tarball users get) and install it with the
 *      shipped installer into an ISOLATED home (so nothing leaks from this machine).
 *   2. Assert every shipped component landed: the `goal` primary agent, all the
 *      `goal-*` reviewers, the commands, the multi-file guard plugin, the manifest
 *      (version matched to package.json), and the tui.json sidebar registration.
 *   3. Assert the installed guard plugin module imports cleanly.
 *   4. Boot a REAL `opencode serve` rooted at that isolated home and assert OpenCode
 *      actually REGISTERS the `goal` agent and the `goal-*` reviewers — the exact
 *      thing a user hits with `/goal`. (A regression here = "agent goal not found".)
 *      Also assert the installed files survive server startup.
 *
 * It SKIPs (exit 0) when `opencode` or `npm` is unavailable so it never breaks a
 * machine without them. Run it explicitly:
 *
 *   npm run test:fresh-install
 *
 * macOS note: the isolated home lives under /private/tmp (not /tmp) so the worktree
 * path the guard hashes is stable (/tmp symlinks to /private/tmp).
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const ROOT = `/private/tmp/goal-fresh-install-${process.pid}`;
const HOME = join(ROOT, "home");
const CFG = join(HOME, ".config", "opencode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
function have(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!have("npm", ["--version"])) {
  console.log("SKIP: npm not available.");
  process.exit(0);
}

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });

try {
  // 1. Pack the exact tarball a user would get, then install it as a fresh global user.
  console.log("\n=== Pack + install the published tarball into an isolated home ===");
  const packDir = join(ROOT, "pack");
  mkdirSync(packDir, { recursive: true });
  const packed = execFileSync("npm", ["pack", REPO, "--pack-destination", packDir], { encoding: "utf8" }).trim().split("\n").pop().trim();
  const tarball = join(packDir, packed);
  check("npm pack produced a tarball", existsSync(tarball), tarball);
  execFileSync("tar", ["-xzf", tarball, "-C", packDir]);
  const installer = join(packDir, "package", "scripts", "install.mjs");
  check("packed tarball contains the installer", existsSync(installer), installer);

  const out = execFileSync("node", [installer, "--global"], { env: { ...process.env, HOME }, encoding: "utf8" });
  check("installer reports the package version", out.includes(PKG.version), `expected ${PKG.version}`);

  // 2. Every shipped component must land.
  console.log("\n=== Installed components ===");
  const agentsDir = join(CFG, "agents");
  const agents = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith(".md")) : [];
  check("the `goal` primary agent is installed", agents.includes("goal.md"));
  const reviewerCount = agents.filter((f) => /^goal-.*\.md$/.test(f)).length;
  check("the goal-* subagents are installed (>= 20)", reviewerCount >= 20, `found ${reviewerCount}`);
  check("commands are installed", existsSync(join(CFG, "commands", "goal.md")));
  check("the guard plugin entry is installed", existsSync(join(CFG, "plugins", "goal-guard.js")));
  check("the guard plugin modules are installed", existsSync(join(CFG, "plugins", "goal-guard", "guard.js")));

  const manifest = JSON.parse(readFileSync(join(CFG, ".goal-mode-manifest.json"), "utf8"));
  check("manifest version matches package.json", manifest.version === PKG.version, `manifest=${manifest.version}`);

  const tui = JSON.parse(readFileSync(join(CFG, "tui.json"), "utf8"));
  check("tui.json registers the sidebar plugin", Array.isArray(tui.plugin) && tui.plugin.includes(PKG.name));

  // 3. The installed plugin module imports cleanly.
  console.log("\n=== Installed plugin loads ===");
  try {
    const mod = await import(join(CFG, "plugins", "goal-guard.js"));
    check("installed goal-guard.js exports a default plugin", typeof mod.default === "function");
  } catch (err) {
    check("installed goal-guard.js imports", false, String(err.message || err));
  }

  // 4. A REAL opencode serve must REGISTER the goal agent + reviewers.
  console.log("\n=== opencode serve registers the agents (fresh home) ===");
  if (!have("opencode", ["--version"])) {
    console.log("  (skipping live serve checks — `opencode` CLI not found)");
  } else {
    const proc = spawn("opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME },
    });
    let log = "";
    let baseUrl = null;
    const onData = (d) => {
      log += d.toString();
      const m = log.match(/listening on (http:\/\/[0-9.]+:\d+)/i);
      if (m) baseUrl = m[1];
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    const deadline = Date.now() + 40000;
    while (!baseUrl && Date.now() < deadline) await sleep(300);
    check("opencode serve started from the fresh install", Boolean(baseUrl), log.slice(0, 200));

    if (baseUrl) {
      let names = [];
      try {
        const res = await fetch(`${baseUrl}/agent`);
        const data = await res.json();
        names = (Array.isArray(data) ? data : data.agents || []).map((a) => a.name || a.id || a);
      } catch (err) {
        check("queried the /agent registry", false, String(err.message || err));
      }
      check("OpenCode registers the `goal` agent (no fallback)", names.includes("goal"), `agents: ${names.slice(0, 6).join(",")}`);
      check("OpenCode registers the goal-* reviewers (>= 20)", names.filter((n) => /^goal-/.test(String(n))).length >= 20, `goal-* = ${names.filter((n) => /^goal-/.test(String(n))).length}`);
    }
    check("installed goal agent survived server startup", existsSync(join(agentsDir, "goal.md")));
    try {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 800);
    } catch {
      /* ignore */
    }
  }
} catch (err) {
  console.error("\nFRESH-INSTALL HARNESS ERROR:", err && (err.stack || err.message || err));
  failed += 1;
} finally {
  await sleep(1200);
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "✅" : "❌"} fresh-install: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
