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
      typeof job.responseUrl !== "string") {
    throw new Error("The saved fal.ai job record is invalid; refusing to contact the provider.");
  }
  return {
    endpointId: job.endpointId,
    requestId: job.requestId,
    statusUrl: trustedFalUrl(job.statusUrl),
    responseUrl: trustedFalUrl(job.responseUrl),
    createdAt: typeof job.createdAt === "string" ? job.createdAt : "",
  };
}
