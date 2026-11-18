/** Parse the contiguous byte range acknowledged by a Google resumable-upload session. */
export function nextUploadOffset(rangeHeader, totalBytes) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) {
    throw new Error("A positive, safe upload size is required.");
  }
  if (rangeHeader === null || rangeHeader === "") return 0;
  const match = /^bytes=0-(\\d+)$/.exec(rangeHeader.trim());
  if (!match) throw new Error("YouTube returned an invalid resumable-upload range.");
  const lastByte = Number(match[1]);
  if (!Number.isSafeInteger(lastByte) || lastByte < 0 || lastByte >= totalBytes) {
    throw new Error("YouTube returned an out-of-range resumable-upload position.");
  }
  return lastByte + 1;
}

/**
 * Upload a complete buffer through a resumable session, checking server state
 * after interruptions/5xx responses and continuing from the first uncommitted
 * byte. A single whole-buffer PUT is still used when the first attempt works.
 */
export async function uploadResumableVideo({
  uploadUrl,
  videoBytes,
  mimeType,
  accessToken,
  fetchImpl = fetch,
  maxAttempts = 4,
}) {
  if (!(videoBytes instanceof ArrayBuffer) || videoBytes.byteLength < 1) {
    throw new Error("A non-empty video buffer is required.");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) {
    throw new Error("Invalid resumable-upload retry limit.");
  }

  const totalBytes = videoBytes.byteLength;
  let offset = 0;
  let lastFailure;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const headers = new Headers({
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": mimeType,
      });
      if (offset > 0) {
        headers.set("Content-Range", `bytes ${offset}-${totalBytes - 1}/${totalBytes}`);
      }
      const uploaded = await fetchImpl(uploadUrl, {
        method: "PUT",
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
        headers,
        body: videoBytes.slice(offset),
      });

      if (uploaded.status === 308) {
        offset = nextUploadOffset(uploaded.headers.get("Range"), totalBytes);
        await uploaded.body?.cancel();
        if (offset >= totalBytes) {
          throw new Error("YouTube reported an incomplete upload after acknowledging every byte.");
        }
        continue;
      }
      if (uploaded.ok || uploaded.status < 500) return uploaded;
      lastFailure = new Error(`YouTube upload temporarily failed (HTTP ${uploaded.status}).`);
      await uploaded.body?.cancel();
    } catch (error) {
      lastFailure = error instanceof Error ? error : new Error("Video upload connection failed.");
    }

    // The previous PUT may have reached YouTube even if its response was lost.
    // Ask the session before retransmitting so we never blindly duplicate bytes.
    try {
      const status = await fetchImpl(uploadUrl, {
        method: "PUT",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Range": `bytes */${totalBytes}`,
        },
        body: new ArrayBuffer(0),
      });
      if (status.status === 308) {
        offset = nextUploadOffset(status.headers.get("Range"), totalBytes);
        await status.body?.cancel();
        if (offset >= totalBytes) {
          throw new Error("YouTube reported an incomplete upload after acknowledging every byte.");
        }
        continue;
      }
      if (status.ok || status.status < 500) return status;
      lastFailure = new Error(`YouTube upload status check temporarily failed (HTTP ${status.status}).`);
      await status.body?.cancel();
    } catch (error) {
      lastFailure = error instanceof Error ? error : new Error("YouTube upload status check failed.");
    }
  }

  throw new Error(
    lastFailure
      ? `YouTube upload could not be completed after checking resumable session progress: ${lastFailure.message}`
      : "YouTube upload could not be completed after checking resumable session progress.",
  );
}
