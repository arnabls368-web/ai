export function trustedFalUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new Error("fal.ai returned an unexpected queue URL; refusing to fetch it.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("fal.ai returned an unexpected queue URL; refusing to fetch it.");
  }
  if (url.protocol !== "https:" ||
      !["queue.fal.run", "queue.falrun.com"].includes(url.hostname) ||
      url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("fal.ai returned an unexpected queue URL; refusing to fetch it.");
  }
  return url.toString();
}

export function validateFalJobRecord(job, expectedRequestId, expectedEndpointId) {
  if (!job || typeof job !== "object" || Array.isArray(job) ||
      job.requestId !== expectedRequestId ||
      (expectedEndpointId !== undefined && job.endpointId !== expectedEndpointId) ||
      typeof job.endpointId !== "string" ||
      job.endpointId.length > 200 ||
      !/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,4}$/i.test(job.endpointId) ||
      typeof job.statusUrl !== "string" ||
      typeof job.responseUrl !== "string" ||
      (job.cancelUrl !== undefined && typeof job.cancelUrl !== "string")) {
    throw new Error("The saved fal.ai job record is invalid; refusing to contact the provider.");
  }
  // A trusted hostname alone is insufficient: bind every provider URL to
  // this exact owner/app queue path and request ID before attaching FAL_KEY.
  const modelId = job.endpointId.split("/").slice(0, 2).join("/");
  const basePath = "/" + modelId + "/requests/" + expectedRequestId;
  const statusUrl = trustedFalUrl(job.statusUrl);
  const responseUrl = trustedFalUrl(job.responseUrl);
  const cancelUrl = job.cancelUrl === undefined ? undefined : trustedFalUrl(job.cancelUrl);
  if (new URL(statusUrl).pathname !== basePath + "/status" ||
      new URL(responseUrl).pathname !== basePath ||
      (cancelUrl !== undefined && new URL(cancelUrl).pathname !== basePath + "/cancel")) {
    throw new Error("The saved fal.ai job URL does not match its endpoint and request ID; refusing to contact the provider.");
  }
  return {
    endpointId: job.endpointId,
    requestId: job.requestId,
    statusUrl,
    responseUrl,
    ...(cancelUrl === undefined ? {} : { cancelUrl }),
    createdAt: typeof job.createdAt === "string" ? job.createdAt : "",
  };
}

/**
 * Persist completion metadata without hiding an already retrieved provider output.
 * A KV outage must not turn a successful generation into an apparent provider failure.
 */
export async function tryPersistFalCompletion(kv, key, job, completedAt) {
  try {
    await kv.put(key, JSON.stringify({ ...job, completedAt, completed: true }), {
      expirationTtl: 60 * 60 * 24 * 7,
    });
    return { persisted: true };
  } catch {
    return { persisted: false };
  }
}

/**
 * Rebuild fal queue URLs from the endpoint and request ID when the initial
 * account-scoped KV write failed. The endpoint is validated before path use.
 */
export function recoverFalJobRecord(endpointId, requestId, createdAt = "") {
  if (typeof endpointId !== "string" ||
      endpointId.length > 200 ||
      !/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,4}$/i.test(endpointId) ||
      typeof requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new Error("A valid fal.ai endpoint ID and request ID are required for recovery.");
  }
  // Queue status/result URLs use owner/app, not any endpoint path suffix.
  // For example, owner/app/text-to-video submits to owner/app/requests/{id}.
  const modelId = endpointId.split("/").slice(0, 2).join("/");
  const base = "https://queue.fal.run/" + modelId + "/requests/" + requestId;
  return {
    endpointId,
    requestId,
    statusUrl: trustedFalUrl(base + "/status"),
    responseUrl: trustedFalUrl(base),
    cancelUrl: trustedFalUrl(base + "/cancel"),
    createdAt,
  };
}
