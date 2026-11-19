/**
 * Validate a Google YouTube resumable-upload session URL before attaching
 * an OAuth bearer token. Google session URLs carry opaque query parameters,
 * so preserve those while pinning scheme, authority and endpoint path.
 */
export function validateYouTubeUploadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("YouTube returned an invalid resumable upload URL.");
  }
  if (url.protocol !== "https:" ||
      url.hostname !== "www.googleapis.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== "/upload/youtube/v3/videos") {
    throw new Error("YouTube returned an unexpected upload URL; refusing to send authorization credentials.");
  }
  return url.toString();
}
