export type FalEstimateType = "historical_api_price" | "unit_price";

export function buildFalCostEstimateRequest(
  endpointId: string,
  estimateType: FalEstimateType,
  quantity: number,
): {
  estimate_type: FalEstimateType;
  endpoints: Record<string, { call_quantity: number } | { unit_quantity: number }>;
};

export function normalizeFalCostEstimate(
  data: unknown,
  expectedType: FalEstimateType,
): { estimateType: FalEstimateType; totalCost: number; currency: string };
