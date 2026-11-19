export function normalizeFalModelCatalogue(data, limit, includeSchema) {
  if (!data || typeof data !== "object" || !Array.isArray(data.models)) {
    throw new Error("fal.ai returned an invalid model catalogue response.");
  }
  const models = data.models
    .filter((model) => model && typeof model === "object" &&
      typeof model.endpoint_id === "string" && model.endpoint_id.length > 0)
    .slice(0, limit)
    .map((model) => {
      const metadata = model.metadata && typeof model.metadata === "object"
        ? model.metadata
        : {};
      return {
        endpointId: model.endpoint_id,
        ...(typeof metadata.display_name === "string" ? { name: metadata.display_name } : {}),
        ...(typeof metadata.category === "string" ? { category: metadata.category } : {}),
        ...(typeof metadata.description === "string" ? { description: metadata.description } : {}),
        ...(typeof metadata.status === "string" ? { status: metadata.status } : {}),
        tags: Array.isArray(metadata.tags)
          ? metadata.tags.filter((tag) => typeof tag === "string").slice(0, 12)
          : [],
        ...(typeof metadata.model_url === "string" ? { modelUrl: metadata.model_url } : {}),
        ...(includeSchema && model.openapi && typeof model.openapi === "object"
          ? { openapi: model.openapi }
          : {}),
      };
    });
  return {
    models,
    nextCursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
    hasMore: data.has_more === true,
  };
}

export function normalizeFalPricing(data, endpointId) {
  if (!data || typeof data !== "object" || !Array.isArray(data.prices)) {
    throw new Error("fal.ai returned an invalid pricing response.");
  }
  return {
    endpointId,
    prices: data.prices.slice(0, 20).map((price) => ({
      unitPrice: price?.unit_price,
      unit: price?.unit,
      currency: price?.currency,
    })),
  };
}
