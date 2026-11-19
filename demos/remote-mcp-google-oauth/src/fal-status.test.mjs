import test from "node:test";
import assert from "node:assert/strict";
import { classifyFalGenerationStatus, isFalGenerationFailed } from "./fal-status.mjs";

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

test("classifies only documented pending and completed lifecycle states", () => {
  assert.equal(classifyFalGenerationStatus({ status: "IN_QUEUE" }), "pending");
  assert.equal(classifyFalGenerationStatus({ status: "IN_PROGRESS" }), "pending");
  assert.equal(classifyFalGenerationStatus({ status: "COMPLETED" }), "completed");
  assert.equal(classifyFalGenerationStatus({ status: "FAILED" }), "failed");
});

test("unknown or malformed lifecycle states are not silently treated as pending", () => {
  for (const status of [undefined, null, {}, { status: "CANCELLED" }, { status: "SOMETHING_NEW" }, "IN_PROGRESS"]) {
    assert.equal(classifyFalGenerationStatus(status), "unknown");
  }
});

test("provider error payloads are classified as failed regardless of status label", () => {
  assert.equal(classifyFalGenerationStatus({ status: "IN_PROGRESS", error: "runner error" }), "failed");
  assert.equal(classifyFalGenerationStatus({ status: "IN_QUEUE", error_type: "INVALID_INPUT" }), "failed");
});
