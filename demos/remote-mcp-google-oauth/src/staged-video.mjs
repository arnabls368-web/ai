export const MAX_STAGED_VIDEO_BYTES = 50 * 1024 * 1024;
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "mkv"]);
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MIME_EXTENSIONS = new Map([["video/mp4", "mp4"], ["video/quicktime", "mov"], ["video/webm", "webm"], ["video/x-matroska", "mkv"]]);

/**
 * Stream a fetched video response into the authenticated private renderer.
 * The renderer persists it in private object storage and returns its digest.
 */
export async function stageVideoSource({ source, mimeType, callRenderer, assetId = crypto.randomUUID() }) {
  if (!source?.body || typeof callRenderer !== "function" || !ASSET_ID_PATTERN.test(assetId)) {
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
    if (!response.body) throw new Error("Missing staging response body.");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) {
          await reader.cancel("Staging metadata exceeds 8 KiB.");
          throw new Error("Staging metadata is too large.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    record = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Private renderer returned invalid staging metadata.");
  }
  const expectedExtension = MIME_EXTENSIONS.get(mimeType);
  if (!record || record.assetId !== assetId ||
      record.filename !== assetId + "." + expectedExtension ||
      record.storage !== "private_object_storage" ||
      !Number.isSafeInteger(record.bytes) || record.bytes < 1 ||
      record.bytes > MAX_STAGED_VIDEO_BYTES ||
      typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error("Private renderer returned invalid staged video metadata.");
  }
  const extension = expectedExtension;
  if (!VIDEO_EXTENSIONS.has(extension)) throw new Error("Private renderer returned an unsupported video extension.");
  return { assetId, extension, totalBytes: record.bytes, sha256: record.sha256, mimeType };
}

/** Create a fresh authenticated byte-range reader for resumable upload retries. */
export function createStagedVideoRangeReader({ assetId, extension, totalBytes, callRenderer }) {
  if (!ASSET_ID_PATTERN.test(assetId) || !VIDEO_EXTENSIONS.has(extension) || !Number.isSafeInteger(totalBytes) ||
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


/** Best-effort explicit cleanup; bucket lifecycle expiry remains the crash-safety backstop. */
export async function deleteStagedVideoAsset({ assetId, extension, callRenderer }) {
  if (!ASSET_ID_PATTERN.test(assetId) || !VIDEO_EXTENSIONS.has(extension) || typeof callRenderer !== "function") {
    throw new Error("Invalid staged video cleanup configuration.");
  }
  const response = await callRenderer({
    method: "DELETE",
    scope: "asset:delete",
    path: "/assets/" + assetId + "/" + extension,
  });
  if (!response.ok) {
    const status = response.status;
    await response.body?.cancel();
    throw new Error("Private renderer could not clean up staged video (HTTP " + status + ").");
  }
  await response.body?.cancel();
}
