import test from "node:test";
import assert from "node:assert/strict";
import { serializeApprovalBinding } from "./approval-binding.mjs";

test("approval binding preserves field boundaries", () => {
  const first = serializeApprovalBinding(["account", "video-hash", "title\\npart", "description"]);
  const second = serializeApprovalBinding(["account", "video-hash", "title", "part\\ndescription"]);
  assert.notEqual(first, second);
});

test("approval binding is deterministic and field-order sensitive", () => {
  assert.equal(
    serializeApprovalBinding(["account", "endpoint", "{\"prompt\":\"hello\"}"]),
    serializeApprovalBinding(["account", "endpoint", "{\"prompt\":\"hello\"}"]),
  );
  assert.notEqual(
    serializeApprovalBinding(["account", "endpoint", "input"]),
    serializeApprovalBinding(["endpoint", "account", "input"]),
  );
});

test("approval binding rejects non-string fields", () => {
  assert.throws(() => serializeApprovalBinding(["account", 1]), /array of strings/);
});

test("fal generation approval binding includes the cost estimate", () => {
  const binding = (estimate) => serializeApprovalBinding([
    "account@example.com",
    "fal-ai/example",
    "{\"prompt\":\"sunrise\"}",
    JSON.stringify(estimate),
  ]);
  const original = binding({ estimateType: "historical_api_price", totalCost: 0.12, currency: "USD" });
  assert.equal(
    original,
    binding({ estimateType: "historical_api_price", totalCost: 0.12, currency: "USD" }),
  );
  assert.notEqual(
    original,
    binding({ estimateType: "historical_api_price", totalCost: 0.13, currency: "USD" }),
  );
  assert.notEqual(
    original,
    binding({ estimateType: "unit_price", totalCost: 0.12, currency: "USD" }),
  );
});
