/**
 * Durable, crash-safe JSON persistence for guard state.
 *
 * OpenCode exposes no key/value store to plugins, and a plugin's in-memory
 * state is lost on every restart. This module persists the guard's review
 * ledger under the XDG state directory, namespaced by a hash of the project
 * worktree, so a long Goal session survives a restart with its dirty flags,
 * verdicts and review-cycle count intact.
 *
 * Writes are atomic (temp file + rename) and debounced so a burst of tool
 * calls does not thrash the disk. All disk access is wrapped so that a
 * read-only or sandboxed filesystem degrades to pure in-memory operation
 * rather than crashing a tool call.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the base directory for guard state files. */
export function stateBaseDir(env = process.env) {
  const xdg = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim();
  const base = xdg || join(homedir(), ".local", "state");
  return join(base, "opencode", "goal-guard");
}

/** Stable per-project key from the worktree/directory. */
export function projectKey(worktree) {
  const input = String(worktree || "default");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Create a persistence handle for one project.
 *
 * @param {object} opts
 * @param {string} [opts.worktree]  Project worktree root (namespacing key).
 * @param {boolean} [opts.enabled=true]
 * @param {number} [opts.debounceMs=400]
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {(fn: () => void, ms: number) => any} [opts.setTimer]  Injectable for tests.
 * @param {(handle: any) => void} [opts.clearTimer]
 */
export function createPersistence({
  worktree,
  enabled = true,
  debounceMs = 400,
  env = process.env,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
} = {}) {
  const dir = stateBaseDir(env);
  const file = join(dir, `${projectKey(worktree)}.json`);
  const tmp = `${file}.tmp`;
  let timer = null;
  let pending = null;
  let degraded = false;

  function load() {
    if (!enabled || degraded) return null;
    try {
      const raw = readFileSync(file, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if (err && err.code === "ENOENT") return null;
      // Corrupt or unreadable file: ignore and start fresh.
      return null;
    }
  }

  function writeNow(data) {
    if (!enabled || degraded) return false;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, JSON.stringify(data), "utf8");
      renameSync(tmp, file);
      return true;
    } catch {
      degraded = true; // Stop trying on a read-only/sandboxed FS.
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  /** Debounced save: coalesces rapid mutations into one disk write. */
  function save(getData) {
    if (!enabled || degraded) return;
    pending = getData;
    if (timer) return;
    timer = setTimer(() => {
      timer = null;
      const fn = pending;
      pending = null;
      if (fn) writeNow(fn());
    }, debounceMs);
  }

  /** Synchronous flush (used on dispose / idle). */
  function flush(getData) {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    const fn = pending || getData;
    pending = null;
    if (fn) return writeNow(fn());
    return false;
  }

  return {
    file,
    load,
    save,
    flush,
    isDegraded: () => degraded,
  };
}
