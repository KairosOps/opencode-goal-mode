import test from "node:test";
import assert from "node:assert/strict";
import { incidentSignature } from "../tools/lab/server/schema.mjs";

test("incidentSignature builds a stable incident dedupe key", () => {
  assert.equal(incidentSignature("run-1", "model-error", "model:timeout"), "run-1:model-error:model:timeout");
});

test("incidentSignature rejects missing signature parts", () => {
  for (const args of [
    [undefined, "family", "key"],
    ["run", undefined, "key"],
    ["run", "family", undefined],
    ["", "family", "key"],
    ["run", "", "key"],
    ["run", "family", ""],
  ]) {
    assert.throws(() => incidentSignature(...args), /Invalid incident signature/);
  }
});
