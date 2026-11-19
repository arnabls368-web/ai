/** Classify fal.ai queue responses without treating unknown states as pending. */
export function classifyFalGenerationStatus(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return "unknown";
  if (status.status === "FAILED" || Boolean(status.error) || Boolean(status.error_type)) return "failed";
  if (status.status === "COMPLETED") return "completed";
  if (status.status === "IN_QUEUE" || status.status === "IN_PROGRESS") return "pending";
  return "unknown";
}

/** Return true when fal.ai reports a terminal failed generation. */
export function isFalGenerationFailed(status) {
  return classifyFalGenerationStatus(status) === "failed";
}
