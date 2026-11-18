/** Return true when fal.ai reports a terminal failed generation. */
export function isFalGenerationFailed(status) {
  return status?.status === "FAILED" || Boolean(status?.error) || Boolean(status?.error_type);
}
