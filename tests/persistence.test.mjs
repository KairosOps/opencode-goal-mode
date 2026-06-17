import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPersistence, projectKey, stateBaseDir } from "../plugins/goal-guard/persistence.js";
import { createStore } from "../plugins/goal-guard/state.js";
import { createGuard } from "../plugins/goal-guard/guard.js";

function tempEnv() {
  const dir = mkdtempSync(join(tmpdir(), "goal-persist-"));
  return { XDG_STATE_HOME: dir, __dir: dir };
}

/** A synchronous timer shim so debounced saves can be flushed deterministically. */
function syncTimers() {
  let cb = null;
  return {
    setTimer: (fn) => {
      cb = fn;
      return 1;
    },
    clearTimer: () => {
      cb = null;
    },
    fire: () => {
      if (cb) {
        const f = cb;
        cb = null;
        f();
      }
    },
  };
}

test("projectKey is stable and worktree-specific", () => {
  assert.equal(projectKey("/a/b"), projectKey("/a/b"));
  assert.notEqual(projectKey("/a/b"), projectKey("/a/c"));
});

test("stateBaseDir honors XDG_STATE_HOME", () => {
  assert.match(stateBaseDir({ XDG_STATE_HOME: "/custom" }), /\/custom\/opencode\/goal-guard$/);
});

test("save (debounced) then load round-trips", () => {
  const env = tempEnv();
  const timers = syncTimers();
  const p = createPersistence({ worktree: "/proj", env, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  p.save(() => ({ version: 1, hello: "world" }));
  assert.equal(p.load(), null, "nothing written until the timer fires");
  timers.fire();
  assert.deepEqual(p.load(), { version: 1, hello: "world" });
});

test("debounce coalesces multiple saves into the last value", () => {
  const env = tempEnv();
  const timers = syncTimers();
  const p = createPersistence({ worktree: "/proj", env, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  p.save(() => ({ n: 1 }));
  p.save(() => ({ n: 2 }));
  p.save(() => ({ n: 3 }));
  timers.fire();
  assert.equal(p.load().n, 3);
});

test("flush writes synchronously", () => {
  const env = tempEnv();
  const p = createPersistence({ worktree: "/proj", env });
  assert.equal(p.flush(() => ({ flushed: true })), true);
  assert.deepEqual(p.load(), { flushed: true });
});

test("writes are atomic (no leftover temp file)", () => {
  const env = tempEnv();
  const p = createPersistence({ worktree: "/proj", env });
  p.flush(() => ({ ok: 1 }));
  assert.equal(existsSync(`${p.file}.tmp`), false);
  assert.equal(existsSync(p.file), true);
});

test("corrupt state file loads as null instead of throwing", () => {
  const env = tempEnv();
  const p = createPersistence({ worktree: "/proj", env });
  mkdirSync(stateBaseDir(env), { recursive: true });
  writeFileSync(p.file, "{ not valid json", "utf8");
  assert.equal(p.load(), null);
});

test("missing file loads as null", () => {
  const env = tempEnv();
  const p = createPersistence({ worktree: "/never-written", env });
  assert.equal(p.load(), null);
});

test("disabled persistence is a no-op", () => {
  const env = tempEnv();
  const p = createPersistence({ worktree: "/proj", env, enabled: false });
  assert.equal(p.flush(() => ({ a: 1 })), false);
  assert.equal(p.load(), null);
});

test("unwritable destination degrades instead of throwing", () => {
  const env = tempEnv();
  // Make the base dir a file so mkdir/write fails.
  const base = stateBaseDir(env);
  mkdirSync(join(env.__dir, "opencode"), { recursive: true });
  writeFileSync(base, "i am a file, not a dir", "utf8");
  const p = createPersistence({ worktree: "/proj", env });
  assert.doesNotThrow(() => p.flush(() => ({ a: 1 })));
  assert.equal(p.isDegraded(), true);
});

test("snapshot survives a simulated restart (new guard rehydrates)", () => {
  const env = tempEnv();
  const worktree = "/restart-proj";

  // First guard: record an edit, a verdict, and persist.
  const g1 = createGuard({ client: {}, worktree }, {}, { env });
  // Persistence in g1 is real (writes under env XDG); force a synchronous flush.
  const s1 = g1.store.stateFor("sess");
  s1.active = true;
  s1.reviewCycles = 2;
  s1.dirty = true;
  g1.persistence.flush(() => g1.store.snapshot());

  // Second guard for the same worktree rehydrates from disk.
  const g2 = createGuard({ client: {}, worktree }, {}, { env });
  const s2 = g2.store.stateFor("sess");
  assert.equal(s2.reviewCycles, 2);
  assert.equal(s2.dirty, true);
  assert.equal(s2.active, true);
});

test("persisted snapshot carries the resolved config (so the TUI sidebar agrees with the server)", async () => {
  const env = tempEnv();
  const timers = syncTimers();
  const worktree = "/cfg-snap";
  const g = createGuard({ client: {}, worktree }, { contextualGates: false }, { env, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  await g.hooks["chat.message"]({ sessionID: "s", agent: "goal" }, { parts: [{ type: "text", text: "do a thing" }] });
  timers.fire();
  const p = createPersistence({ worktree, env });
  const snap = JSON.parse(readFileSync(p.file, "utf8"));
  assert.equal(snap.config && snap.config.contextualGates, false, "snapshot must carry the server's resolved config");
});

test("a goal→build switch is persisted (active=false on disk for the sidebar fallback)", async () => {
  const env = tempEnv();
  const timers = syncTimers();
  const worktree = "/switch-persist";
  const g = createGuard({ client: {}, worktree }, {}, { env, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  await g.hooks["chat.message"]({ sessionID: "s", agent: "goal" }, { parts: [{ type: "text", text: "the goal" }] });
  timers.fire();
  await g.hooks["chat.params"]({ sessionID: "s", agent: "build" }, {}); // switch to build → active=false + persist
  timers.fire();
  const p = createPersistence({ worktree, env });
  const snap = JSON.parse(readFileSync(p.file, "utf8"));
  const rec = (snap.sessions || []).find((e) => e[0] === "s");
  assert.ok(rec, "session present in snapshot");
  assert.equal(rec[1].active, false, "the goal→build switch must be persisted to disk");
});

test("createGuard tolerates a valid-JSON-but-wrong-shape state file", () => {
  const env = tempEnv();
  const worktree = "/wrong-shape";
  const p = createPersistence({ worktree, env });
  mkdirSync(stateBaseDir(env), { recursive: true });
  writeFileSync(p.file, JSON.stringify({ totally: "wrong", sessions: { not: "an array" } }), "utf8");
  let guard;
  assert.doesNotThrow(() => {
    guard = createGuard({ client: {}, worktree }, {}, { env });
  });
  assert.equal(guard.store.size(), 0);
});

test("two different worktrees persist independently", () => {
  const env = tempEnv();
  const a = createStore();
  const b = createStore();
  a.stateFor("x").reviewCycles = 1;
  b.stateFor("x").reviewCycles = 9;
  const pa = createPersistence({ worktree: "/a", env });
  const pb = createPersistence({ worktree: "/b", env });
  pa.flush(() => a.snapshot());
  pb.flush(() => b.snapshot());
  assert.notEqual(pa.file, pb.file);
  const ra = createStore();
  ra.restore(pa.load());
  assert.equal(ra.stateFor("x").reviewCycles, 1);
});
