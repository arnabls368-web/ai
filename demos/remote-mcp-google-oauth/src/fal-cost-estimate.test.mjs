import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFalCostEstimateRequest,
  normalizeFalCostEstimate,
} from "./fal-cost-estimate.mjs";

test("builds historical per-call estimate request", () => {
  assert.deepEqual(
    buildFalCostEstimateRequest("fal-ai/example", "historical_api_price", 1),
    {
      estimate_type: "historical_api_price",
      endpoints: { "fal-ai/example": { call_quantity: 1 } },
    },
  );
});

test("builds unit-price estimate request", () => {
  assert.deepEqual(
    buildFalCostEstimateRequest("fal-ai/example", "unit_price", 2.5),
    {
      estimate_type: "unit_price",
      endpoints: { "fal-ai/example": { unit_quantity: 2.5 } },
    },
  );
});

test("rejects malformed endpoint IDs and quantities", () => {
  assert.throws(() => buildFalCostEstimateRequest("https://attacker.test", "historical_api_price", 1), /endpoint ID/);
  assert.throws(() => buildFalCostEstimateRequest("fal-ai/example", "historical_api_price", 1.5), /quantity/);
  assert.throws(() => buildFalCostEstimateRequest("fal-ai/example", "unit_price", 0), /quantity/);
  assert.throws(() => buildFalCostEstimateRequest("fal-ai/example", "unit_price", Number.POSITIVE_INFINITY), /quantity/);
});

test("normalizes a valid provider estimate", () => {
  assert.deepEqual(
    normalizeFalCostEstimate({
      estimate_type: "historical_api_price",
      total_cost: 0.125,
      currency: "USD",
    }, "historical_api_price"),
    { estimateType: "historical_api_price", totalCost: 0.125, currency: "USD" },
  );
});

test("rejects missing, mismatched, negative or non-finite provider estimates", () => {
  assert.throws(() => normalizeFalCostEstimate(null, "unit_price"), /invalid cost estimate/);
  assert.throws(() => normalizeFalCostEstimate({ estimate_type: "unit_price", total_cost: 1, currency: "USD" }, "historical_api_price"), /invalid cost estimate/);
  assert.throws(() => normalizeFalCostEstimate({ estimate_type: "historical_api_price", total_cost: -1, currency: "USD" }, "historical_api_price"), /invalid cost estimate/);
  assert.throws(() => normalizeFalCostEstimate({ estimate_type: "historical_api_price", total_cost: Number.NaN, currency: "USD" }, "historical_api_price"), /invalid cost estimate/);
  assert.throws(() => normalizeFalCostEstimate({ estimate_type: "historical_api_price", total_cost: 1, currency: "usd" }, "historical_api_price"), /invalid cost estimate/);
});
