import test from "node:test";
import assert from "node:assert/strict";
import { createState, createStore } from "../plugins/goal-guard/state.js";

test("createState produces a well-formed record", () => {
  const st = createState("2026-01-01T00:00:00.000Z");
  assert.equal(st.active, false);
  assert.equal(st.dirty, false);
  assert.equal(st.reviewCycles, 0);
  assert.deepEqual(st.verdicts, []);
  assert.deepEqual(st.latestVerdict, {});
  assert.equal(st.lastEditSeq, 0);
});

test("nextSeq is strictly monotonic", () => {
  const store = createStore();
  const seqs = Array.from({ length: 100 }, () => store.nextSeq());
  for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i] > seqs[i - 1]);
  assert.equal(store.seqValue(), 100);
});

test("stateFor returns a stable object per session", () => {
  const store = createStore();
  const a = store.stateFor("s1");
  a.dirty = true;
  assert.equal(store.stateFor("s1").dirty, true);
  assert.notEqual(store.stateFor("s2"), a);
});

test("stateFor normalizes empty/falsey ids to 'default'", () => {
  const store = createStore();
  const a = store.stateFor("");
  const b = store.stateFor(null);
  const c = store.stateFor(undefined);
  assert.equal(a, b);
  assert.equal(b, c);
});

test("eviction holds the cache at the limit", () => {
  const store = createStore({ maxSessions: 50 });
  for (let i = 0; i < 200; i += 1) store.stateFor(`s${i}`);
  assert.ok(store.size() <= 50);
});

test("eviction drops the least-recently-touched idle session, not a recently touched one", () => {
  const store = createStore({ maxSessions: 3 });
  store.stateFor("old");
  store.stateFor("mid");
  store.stateFor("new");
  // Re-touch "old" so it is now the most recent.
  store.stateFor("old");
  // Adding a 4th evicts the genuine LRU, which is now "mid".
  store.stateFor("trigger");
  assert.equal(store.sessions.has("old"), true, "recently re-touched session survived");
  assert.equal(store.sessions.has("mid"), false, "true LRU was evicted");
});

test("eviction prefers idle sessions over active ones", () => {
  const store = createStore({ maxSessions: 2 });
  const active = store.stateFor("active");
  active.active = true;
  store.stateFor("idle1");
  store.stateFor("idle2"); // forces an eviction
  assert.equal(store.sessions.has("active"), true, "active session must survive");
});

test("TTL drops expired idle sessions", () => {
  let now = 1000;
  const store = createStore({ maxSessions: 100, ttlMs: 500, clock: () => now });
  store.stateFor("ephemeral");
  now += 1000; // advance past TTL
  store.stateFor("fresh"); // triggers eviction sweep
  assert.equal(store.sessions.has("ephemeral"), false);
  assert.equal(store.sessions.has("fresh"), true);
});

test("snapshot/restore round-trips state and seq", () => {
  const a = createStore();
  const st = a.stateFor("s1");
  st.dirty = true;
  st.reviewCycles = 3;
  st.verdicts.push({ agent: "goal-reviewer", verdict: "PASS", at: "t", seq: 5 });
  a.nextSeq();
  a.nextSeq();
  const snap = a.snapshot();

  const b = createStore();
  b.restore(snap);
  const restored = b.stateFor("s1");
  assert.equal(restored.dirty, true);
  assert.equal(restored.reviewCycles, 3);
  assert.equal(restored.verdicts.length, 1);
  assert.ok(b.seqValue() >= a.seqValue());
});

test("restore drops unknown fields and repairs array shapes", () => {
  const store = createStore();
  store.restore({
    version: 1,
    seq: 10,
    sessions: [["s1", { dirty: true, bogus: 42, verdicts: "not-an-array", latestVerdict: null }]],
  });
  const st = store.stateFor("s1");
  assert.equal(st.dirty, true);
  assert.equal(st.bogus, undefined);
  assert.deepEqual(st.verdicts, []);
  assert.deepEqual(st.latestVerdict, {});
});

test("restore tolerates malformed snapshots", () => {
  const store = createStore();
  assert.doesNotThrow(() => store.restore(null));
  assert.doesNotThrow(() => store.restore({}));
  assert.doesNotThrow(() => store.restore({ sessions: "nope" }));
  assert.doesNotThrow(() => store.restore({ sessions: [["bad"], [1, 2, 3]] }));
});

test("restore never lowers the seq counter", () => {
  const store = createStore();
  for (let i = 0; i < 20; i += 1) store.nextSeq();
  store.restore({ seq: 5 });
  assert.equal(store.seqValue(), 20);
});

test("REGRESSION: restore respects maxSessions and keeps active sessions", () => {
  const store = createStore({ maxSessions: 3 });
  const sessions = [];
  for (let i = 0; i < 10; i += 1) sessions.push([`s${i}`, { active: i === 9, touchedAt: i }]);
  store.restore({ version: 1, seq: 1, sessions });
  assert.ok(store.size() <= 3, "restore must not exceed the cap");
  assert.equal(store.sessions.has("s9"), true, "the active session must survive the trim");
});

test("restored sessions are subject to TTL eviction (touchedWall seeded)", () => {
  let now = 10_000;
  const store = createStore({ maxSessions: 100, ttlMs: 1000, clock: () => now });
  store.restore({ version: 1, seq: 1, sessions: [["old", { active: false }]] });
  now += 5000; // past TTL
  store.stateFor("trigger"); // triggers the TTL sweep
  assert.equal(store.sessions.has("old"), false, "restored idle session must be TTL-reapable");
});

test("eviction with all sessions active still holds the cap and drops the LRU active one", () => {
  const store = createStore({ maxSessions: 3 });
  for (const id of ["a", "b", "c"]) store.stateFor(id).active = true;
  // Re-touch b and c so a is the LRU active session.
  store.stateFor("b");
  store.stateFor("c");
  store.stateFor("d").active = true; // forces eviction among all-active
  assert.ok(store.size() <= 3);
  assert.equal(store.sessions.has("a"), false, "LRU active session is the victim when all are active");
});
