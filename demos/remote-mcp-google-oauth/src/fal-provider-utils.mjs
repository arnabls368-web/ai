export function trustedFalUrl(value) {
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
