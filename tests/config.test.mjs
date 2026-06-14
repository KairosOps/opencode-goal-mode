import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, DEFAULT_CONFIG } from "../plugins/goal-guard/config.js";

test("defaults apply with no options or env", () => {
  const c = resolveConfig(undefined, {});
  assert.deepEqual(c, DEFAULT_CONFIG);
});

test("returned config is frozen", () => {
  const c = resolveConfig(undefined, {});
  assert.throws(() => {
    c.blockDestructive = false;
  }, TypeError);
});

test("plugin options override defaults", () => {
  const c = resolveConfig({ blockDestructive: false, maxSessions: 10 }, {});
  assert.equal(c.blockDestructive, false);
  assert.equal(c.maxSessions, 10);
  assert.equal(c.enforceCompletion, true);
});

test("environment variables override defaults but options win over env", () => {
  const env = { GOAL_GUARD_BLOCK_DESTRUCTIVE: "false", GOAL_GUARD_MAX_SESSIONS: "5" };
  const fromEnv = resolveConfig(undefined, env);
  assert.equal(fromEnv.blockDestructive, false);
  assert.equal(fromEnv.maxSessions, 5);

  const withOpts = resolveConfig({ blockDestructive: true }, env);
  assert.equal(withOpts.blockDestructive, true, "options take precedence over env");
  assert.equal(withOpts.maxSessions, 5, "env still applies where options are silent");
});

test("restrictSubagents defaults on and is configurable via options and env", () => {
  assert.equal(DEFAULT_CONFIG.restrictSubagents, true);
  assert.equal(resolveConfig({ restrictSubagents: false }, {}).restrictSubagents, false);
  assert.equal(resolveConfig(undefined, { GOAL_GUARD_RESTRICT_SUBAGENTS: "off" }).restrictSubagents, false);
  assert.equal(resolveConfig({ restrictSubagents: true }, { GOAL_GUARD_RESTRICT_SUBAGENTS: "off" }).restrictSubagents, true);
});

test("boolean coercion accepts common string forms", () => {
  for (const truthy of ["1", "true", "yes", "on", "TRUE"]) {
    assert.equal(resolveConfig({ persist: truthy }).persist, true, truthy);
  }
  for (const falsy of ["0", "false", "no", "off", "OFF"]) {
    assert.equal(resolveConfig({ persist: falsy }).persist, false, falsy);
  }
});

test("invalid values fall back to defaults", () => {
  assert.equal(resolveConfig({ blockDestructive: "maybe" }).blockDestructive, DEFAULT_CONFIG.blockDestructive);
  assert.equal(resolveConfig({ maxSessions: "-3" }).maxSessions, DEFAULT_CONFIG.maxSessions);
  assert.equal(resolveConfig({ maxSessions: "abc" }).maxSessions, DEFAULT_CONFIG.maxSessions);
});

test("non-object options are ignored", () => {
  assert.deepEqual(resolveConfig("nonsense", {}), DEFAULT_CONFIG);
  assert.deepEqual(resolveConfig(null, {}), DEFAULT_CONFIG);
  assert.deepEqual(resolveConfig(42, {}), DEFAULT_CONFIG);
});

test("string-valued config (markers) pass through", () => {
  const c = resolveConfig({ completionMarker: "DONE", blockedMarker: "NOT DONE" });
  assert.equal(c.completionMarker, "DONE");
  assert.equal(c.blockedMarker, "NOT DONE");
});
