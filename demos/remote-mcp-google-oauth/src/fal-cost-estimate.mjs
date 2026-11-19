export function buildFalCostEstimateRequest(
  endpointId: string,
  estimateType: FalEstimateType,
  quantity: number,
) {
  if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,4}$/i.test(endpointId)) {
    throw new Error("Invalid fal.ai endpoint ID.");
  }
  if (!Number.isFinite(quantity) || quantity <= 0 ||
      (estimateType === "historical_api_price" && !Number.isInteger(quantity))) {
    throw new Error("Invalid fal.ai estimate quantity.");
  }
  return {
    estimate_type: estimateType,
    endpoints: {
      [endpointId]: estimateType === "historical_api_price"
        ? { call_quantity: quantity }
        : { unit_quantity: quantity },
    },
  };
}

export function normalizeFalCostEstimate(
  data: unknown,
  expectedType: FalEstimateType,
): { estimateType: FalEstimateType; totalCost: number; currency: string } {
  if (!data || typeof data !== "object") {
    throw new Error("fal.ai returned an invalid cost estimate.");
  }
  const value = data as Record<string, unknown>;
  if (value.estimate_type !== expectedType ||
      typeof value.total_cost !== "number" ||
      !Number.isFinite(value.total_cost) || value.total_cost < 0 ||
      typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) {
    throw new Error("fal.ai returned an invalid cost estimate.");
  }
  return {
    estimateType: expectedType,
    totalCost: value.total_cost,
    currency: value.currency,
  };
}
