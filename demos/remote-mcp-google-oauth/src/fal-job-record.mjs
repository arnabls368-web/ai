/**
 * Load an account-scoped fal job record, recovering only with a valid
 * account-bound capability when KV has no usable record.
 *
 * The caller must validate the returned record before using provider URLs.
 */
export async function loadFalJobRecord({
  kv,
  key,
  scope,
  apiKey,
  requestId,
  endpointId,
  recoveryToken,
  verifyToken,
  recoverRecord,
  validateRecord,
}) {
  let job = null;
  let readFailed = false;
  try {
    job = await kv.get(key, "json");
  } catch {
    readFailed = true;
  }
  if (job) {
    try {
      return validateRecord(job, requestId);
    } catch {
      // Treat a malformed cached record as unavailable; only a signed
      // recovery capability may replace it with canonical queue URLs.
      job = null;
    }
  }

  let authorized = false;
  if (endpointId && recoveryToken) {
    try {
      authorized = await verifyToken(apiKey, scope, endpointId, requestId, recoveryToken);
    } catch {
      authorized = false;
    }
  }
  if (!authorized || !endpointId) {
    if (readFailed) {
      throw new Error("NEXUS could not read the fal.ai tracking record. Retry with the endpointId and account-bound recoveryToken returned by the original submission.");
    }
    throw new Error("fal.ai job record not found for this account. Recovery requires the endpointId and valid account-bound recoveryToken returned by the original submission.");
  }

  const recovered = validateRecord(recoverRecord(endpointId, requestId), requestId);
  try {
    await kv.put(key, JSON.stringify(recovered), { expirationTtl: 60 * 60 * 24 * 7 });
  } catch {
    // The verified in-memory record remains usable for this request.
  }
  return recovered;
}
