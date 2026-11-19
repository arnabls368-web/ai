export const MAX_STAGED_VIDEO_BYTES = 50 * 1024 * 1024;
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "mkv"]);

/**
 * Stream a fetched video response into the authenticated private renderer.
 * The renderer persists it in private object storage and returns its digest.
 */
export async function stageVideoSource({ source, mimeType, callRenderer, assetId = crypto.randomUUID() }) {
  if (!source?.body || typeof callRenderer !== "function") {
    throw new Error("A readable video source and private renderer are required.");
  }
  if (!["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"].includes(mimeType)) {
    await source.body.cancel();
    throw new Error("The video source must be MP4, MOV, WebM, or Matroska.");
  }
  const response = await callRenderer({
    method: "PUT",
    scope: "asset:write",
    path: "/assets/" + assetId,
    rawBody: source.body,
    contentType: mimeType,
  });
  if (!response.ok) {
    const status = response.status;
    await response.body?.cancel();
    throw new Error("Private renderer could not stage the video (HTTP " + status + ").");
  }
  let record;
  try {
    const text = await response.text();
    if (text.length > 8192) throw new Error("Staging metadata is too large.");
    record = JSON.parse(text);
  } catch {
    throw new Error("Private renderer returned invalid staging metadata.");
  }
  if (!record || record.assetId !== assetId ||
      typeof record.filename !== "string" ||
      !new RegExp("^" + assetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.(mp4|mov|m4v|webm|mkv)$").test(record.filename) ||
      !Number.isSafeInteger(record.bytes) || record.bytes < 1 ||
      record.bytes > MAX_STAGED_VIDEO_BYTES ||
      typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error("Private renderer returned invalid staged video metadata.");
  }
  const extension = record.filename.slice(record.filename.lastIndexOf(".") + 1);
  if (!VIDEO_EXTENSIONS.has(extension)) throw new Error("Private renderer returned an unsupported video extension.");
  return { assetId, extension, totalBytes: record.bytes, sha256: record.sha256, mimeType };
}

/** Create a fresh authenticated byte-range reader for resumable upload retries. */
export function createStagedVideoRangeReader({ assetId, extension, totalBytes, callRenderer }) {
  if (!VIDEO_EXTENSIONS.has(extension) || !Number.isSafeInteger(totalBytes) ||
      totalBytes < 1 || totalBytes > MAX_STAGED_VIDEO_BYTES || typeof callRenderer !== "function") {
    throw new Error("Invalid staged video range-reader configuration.");
  }
  return async (start, end) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end < start || end >= totalBytes || end - start + 1 > 8 * 1024 * 1024) {
      throw new Error("Requested staged video range is invalid.");
    }
    const response = await callRenderer({
      method: "GET",
      scope: "asset:read",
      path: "/assets/" + assetId + "/" + extension,
      range: "bytes=" + start + "-" + end,
    });
    const expectedLength = end - start + 1;
    const contentRange = response.headers.get("content-range");
    const contentLength = Number(response.headers.get("content-length"));
    if (response.status !== 206 || !response.body ||
        contentRange !== "bytes " + start + "-" + end + "/" + totalBytes ||
        contentLength !== expectedLength) {
      await response.body?.cancel();
      throw new Error("Private renderer returned an invalid staged video range.");
    }
    return { body: response.body, byteLength: contentLength };
  };
}
