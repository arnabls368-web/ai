import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFalModelCatalogue, normalizeFalPricing } from "./fal-catalog-utils.mjs";

test("normalizes model catalogue metadata, schema and pagination", () => {
  const schema = { openapi: "3.0.0", paths: { "/": {} } };
  const result = normalizeFalModelCatalogue({
    models: [{
      endpoint_id: "fal-ai/example/text-to-video",
      metadata: {
        display_name: "Example Video",
        category: "text-to-video",
        description: "A test model",
        status: "active",
        tags: ["video", "generation", 7],
        model_url: "https://fal.ai/models/example",
      },
      openapi: schema,
    }],
    next_cursor: "next-page",
    has_more: true,
  }, 5, true);

  assert.deepEqual(result, {
    models: [{
      endpointId: "fal-ai/example/text-to-video",
      name: "Example Video",
      category: "text-to-video",
      description: "A test model",
      status: "active",
      tags: ["video", "generation"],
      modelUrl: "https://fal.ai/models/example",
      openapi: schema,
    }],
    nextCursor: "next-page",
    hasMore: true,
  });
});

test("omits optional schema and malformed catalogue entries", () => {
  const result = normalizeFalModelCatalogue({
    models: [
      null,
      { endpoint_id: 12, metadata: {} },
      { endpoint_id: "fal-ai/minimal", metadata: null, openapi: { paths: {} } },
    ],
  }, 1, false);

  assert.deepEqual(result, {
    models: [{ endpointId: "fal-ai/minimal", tags: [] }],
    nextCursor: null,
    hasMore: false,
  });
});

test("rejects malformed catalogue envelopes", () => {
  for (const value of [null, [], {}, { models: {} }]) {
    assert.throws(() => normalizeFalModelCatalogue(value, 5, false), /invalid model catalogue/);
  }
});

test("normalizes current endpoint prices and caps oversized provider lists", () => {
  const prices = Array.from({ length: 25 }, (_, index) => ({
    unit_price: index / 100,
    unit: "second",
    currency: "USD",
  }));
  const result = normalizeFalPricing({ prices }, "fal-ai/example/video");
  assert.equal(result.endpointId, "fal-ai/example/video");
  assert.equal(result.prices.length, 20);
  assert.deepEqual(result.prices[0], {
    unitPrice: 0,
    unit: "second",
    currency: "USD",
  });
});

test("rejects malformed pricing envelopes", () => {
  for (const value of [null, [], {}, { prices: {} }]) {
    assert.throws(() => normalizeFalPricing(value, "fal-ai/example"), /invalid pricing/);
  }
});
