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

export function validateFalJobRecord(job, expectedRequestId) {
  if (!job || typeof job !== "object" || Array.isArray(job) ||
      job.requestId !== expectedRequestId ||
      typeof job.endpointId !== "string" ||
      job.endpointId.length > 200 ||
      !/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,4}$/i.test(job.endpointId) ||
      typeof job.statusUrl !== "string" ||
      typeof job.responseUrl !== "string" ||
      (job.cancelUrl !== undefined && typeof job.cancelUrl !== "string")) {
    throw new Error("The saved fal.ai job record is invalid; refusing to contact the provider.");
  }
  return {
    endpointId: job.endpointId,
    requestId: job.requestId,
    statusUrl: trustedFalUrl(job.statusUrl),
    responseUrl: trustedFalUrl(job.responseUrl),
    ...(job.cancelUrl === undefined ? {} : { cancelUrl: trustedFalUrl(job.cancelUrl) }),
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
