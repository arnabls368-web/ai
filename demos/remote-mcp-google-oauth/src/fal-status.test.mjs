import test from "node:test";
import assert from "node:assert/strict";
import { isFalGenerationFailed } from "./fal-status.mjs";

test("recognizes explicit FAILED status", () => {
  assert.equal(isFalGenerationFailed({ status: "FAILED" }), true);
});

test("recognizes failure payload even without FAILED status", () => {
  assert.equal(isFalGenerationFailed({ status: "IN_PROGRESS", error: "render failed" }), true);
  assert.equal(isFalGenerationFailed({ status: "IN_PROGRESS", error_type: "INPUT_VALIDATION" }), true);
});

test("does not classify queued, running or completed jobs as failed", () => {
  assert.equal(isFalGenerationFailed({ status: "IN_QUEUE" }), false);
  assert.equal(isFalGenerationFailed({ status: "IN_PROGRESS" }), false);
  assert.equal(isFalGenerationFailed({ status: "COMPLETED" }), false);
});

test("handles absent or malformed status safely", () => {
  assert.equal(isFalGenerationFailed(undefined), false);
  assert.equal(isFalGenerationFailed(null), false);
  assert.equal(isFalGenerationFailed({}), false);
});
