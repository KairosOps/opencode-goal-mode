import test from "node:test";
import assert from "node:assert/strict";
import { FALSE_COMPLETION_CORPUS } from "../benchmarks/completion-corpus.mjs";
import { evaluateTruthfulnessCase, runTruthfulnessBenchmark } from "../benchmarks/truthfulness.mjs";

test("false completion dataset has unique labeled cases", () => {
  const ids = new Set();
  for (const item of FALSE_COMPLETION_CORPUS) {
    assert.ok(item.id);
    assert.ok(item.family);
    assert.ok(item.expected);
    assert.equal(ids.has(item.id), false, `duplicate corpus id ${item.id}`);
    ids.add(item.id);
  }
});

test("truthfulness evaluator blocks false completion claims and allows valid ones", () => {
  for (const item of FALSE_COMPLETION_CORPUS) {
    const result = evaluateTruthfulnessCase(item);
    assert.equal(result.decisionCorrect, true, item.id);
    assert.equal(result.reasonCorrect, true, item.id);
  }
});

test("truthfulness score is perfect for the current false-completion corpus", () => {
  const result = runTruthfulnessBenchmark();
  assert.equal(result.score, 100);
  assert.equal(result.decisionAccuracy, 100);
  assert.equal(result.reasonAccuracy, 100);
  assert.equal(result.falseCompletionBlockRate, 100);
  assert.equal(result.validCompletionAllowRate, 100);
});
