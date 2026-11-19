/** Parse the contiguous byte range acknowledged by a Google resumable-upload session. */
export function nextUploadOffset(rangeHeader, totalBytes) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) {
    throw new Error("A positive, safe upload size is required.");
  }
  if (rangeHeader === null || rangeHeader === "") return 0;
  const match = /^bytes=0-(\d+)$/.exec(rangeHeader.trim());
  if (!match) throw new Error("YouTube returned an invalid resumable-upload range.");
  const lastByte = Number(match[1]);
  if (!Number.isSafeInteger(lastByte) || lastByte < 0 || lastByte >= totalBytes) {
    throw new Error("YouTube returned an out-of-range resumable-upload position.");
  }
  return lastByte + 1;
}

/** Parse a 308 acknowledgement and always release its response stream. */
async function acknowledgedUploadOffset(response, totalBytes) {
  try {
    return nextUploadOffset(response.headers.get("Range"), totalBytes);
  } finally {
    try { await response.body?.cancel(); } catch { /* Preserve protocol validation errors. */ }
  }
}

/**
 * Upload a complete buffer through a resumable session. If a PUT is interrupted
 * or receives a 5xx response, query the session before sending any more bytes.
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
  let mustCheckStatus = false;
  let lastFailure;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (mustCheckStatus) {
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
          offset = await acknowledgedUploadOffset(status, totalBytes);
          if (offset >= totalBytes) {
            throw new Error("YouTube reported an incomplete upload after acknowledging every byte.");
          }
          mustCheckStatus = false;
        } else if (status.ok || status.status < 500) {
          return status;
        } else {
          lastFailure = new Error(`YouTube upload status check temporarily failed (HTTP ${status.status}).`);
          await status.body?.cancel();
          continue;
        }
      } catch (error) {
        lastFailure = error instanceof Error ? error : new Error("YouTube upload status check failed.");
        continue;
      }
    }

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
        // A view avoids copying the remaining video bytes on every retry.
        body: new Uint8Array(videoBytes, offset),
      });

      if (uploaded.status === 308) {
        offset = await acknowledgedUploadOffset(uploaded, totalBytes);
        if (offset >= totalBytes) {
          throw new Error("YouTube reported an incomplete upload after acknowledging every byte.");
        }
        continue;
      }
      if (uploaded.ok || uploaded.status < 500) return uploaded;
      lastFailure = new Error(`YouTube upload temporarily failed (HTTP ${uploaded.status}).`);
      await uploaded.body?.cancel();
      mustCheckStatus = true;
    } catch (error) {
      lastFailure = error instanceof Error ? error : new Error("Video upload connection failed.");
      mustCheckStatus = true;
    }
  }

  throw new Error(
    lastFailure
      ? `YouTube upload could not be completed after checking resumable session progress: ${lastFailure.message}`
      : "YouTube upload could not be completed after checking resumable session progress.",
  );
}


async function readStagedRangeBytes(range, expectedBytes) {
  if (!range || range.byteLength !== expectedBytes) {
    throw new Error("Staged video range returned an invalid body or byte length.");
  }
  if (range.body instanceof ArrayBuffer) {
    if (range.body.byteLength !== expectedBytes) throw new Error("Staged video range body length did not match its metadata.");
    return new Uint8Array(range.body);
  }
  if (range.body instanceof Uint8Array) {
    if (range.body.byteLength !== expectedBytes) throw new Error("Staged video range body length did not match its metadata.");
    return range.body;
  }
  if (!(range.body instanceof ReadableStream)) {
    throw new Error("Staged video range returned an unsupported body.");
  }
  const reader = range.body.getReader();
  const bytes = new Uint8Array(expectedBytes);
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > expectedBytes) {
        await reader.cancel("Staged range exceeded its declared length.");
        throw new Error("Staged video range body exceeded its declared length.");
      }
      bytes.set(value, received);
      received += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (received !== expectedBytes) throw new Error("Staged video range body was shorter than its declared length.");
  return bytes;
}

const DEFAULT_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Upload a staged video by fetching one bounded range at a time. The callback
 * must return a fresh body for every retry so a failed request never reuses a
 * consumed stream. Chunks are 8 MiB (a multiple of Google's 256 KiB alignment).
 */
export async function uploadResumableVideoFromRanges({
  uploadUrl,
  totalBytes,
  mimeType,
  accessToken,
  readRange,
  fetchImpl = fetch,
  maxAttempts = 4,
  chunkBytes = DEFAULT_UPLOAD_CHUNK_BYTES,
  checkStatusFirst = false,
}) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > 50 * 1024 * 1024) {
    throw new Error("A video size between 1 byte and 50 MiB is required.");
  }
  if (typeof readRange !== "function") throw new Error("A staged video range reader is required.");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) {
    throw new Error("Invalid resumable-upload retry limit.");
  }
  if (!Number.isInteger(chunkBytes) || chunkBytes < 256 * 1024 ||
      chunkBytes > DEFAULT_UPLOAD_CHUNK_BYTES || chunkBytes % (256 * 1024) !== 0) {
    throw new Error("Upload chunks must be 256 KiB multiples up to 8 MiB.");
  }

  let offset = 0;
  if (checkStatusFirst) {
    let status;
    let lastFailure;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        status = await fetchImpl(uploadUrl, {
          method: "PUT",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Range": `bytes */${totalBytes}`,
          },
          body: new ArrayBuffer(0),
        });
        break;
      } catch (error) {
        lastFailure = error;
      }
    }
    if (!status) {
      throw new Error(lastFailure instanceof Error
        ? `YouTube upload status check failed: ${lastFailure.message}`
        : "YouTube upload status check failed.");
    }
    if (status.status === 308) {
      offset = await acknowledgedUploadOffset(status, totalBytes);
      if (offset >= totalBytes) {
        throw new Error("YouTube reported an incomplete upload after acknowledging every byte.");
      }
    } else if (status.ok || status.status < 500) {
      return status;
    } else {
      const code = status.status;
      await status.body?.cancel();
      throw new Error(`YouTube upload status check temporarily failed (HTTP ${code}).`);
    }
  }
  while (offset < totalBytes) {
    let lastFailure;
    let mustCheckStatus = false;
    let advanced = false;
    let lastSentEnd = offset - 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (mustCheckStatus) {
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
            const acknowledged = await acknowledgedUploadOffset(status, totalBytes);
            if (acknowledged < offset) {
              await status.body?.cancel();
              throw new Error("YouTube resumable-upload progress moved backwards.");
            }
            if (acknowledged > lastSentEnd + 1) {
              await status.body?.cancel();
              throw new Error("YouTube acknowledged bytes beyond the submitted chunk.");
            }
            if (acknowledged >= totalBytes) {
              throw new Error("YouTube reported an incomplete upload after acknowledging every byte.");
            }
            advanced = acknowledged > offset;
            offset = acknowledged;
            mustCheckStatus = false;
            if (advanced) break;
          } else if (status.ok || status.status < 500) {
            return status;
          } else {
            lastFailure = new Error(`YouTube upload status check temporarily failed (HTTP ${status.status}).`);
            await status.body?.cancel();
            continue;
          }
        } catch (error) {
          lastFailure = error instanceof Error ? error : new Error("YouTube upload status check failed.");
          continue;
        }
      }

      const end = Math.min(totalBytes - 1, offset + chunkBytes - 1);
      const expectedBytes = end - offset + 1;
      lastSentEnd = end;
      const range = await readRange(offset, end);
      const chunkBody = await readStagedRangeBytes(range, expectedBytes);
      const headers = new Headers({
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": mimeType,
        "Content-Range": `bytes ${offset}-${end}/${totalBytes}`,
      });
      let uploaded;
      try {
        uploaded = await fetchImpl(uploadUrl, {
          method: "PUT",
          redirect: "error",
          signal: AbortSignal.timeout(120_000),
          headers,
          body: chunkBody,
        });
      } catch (error) {
        lastFailure = error instanceof Error ? error : new Error("Video upload connection failed.");
        mustCheckStatus = true;
        continue;
      }
      if (uploaded.status === 308) {
        const acknowledged = await acknowledgedUploadOffset(uploaded, totalBytes);
        if (acknowledged < offset) {
          await uploaded.body?.cancel();
          throw new Error("YouTube resumable-upload progress moved backwards.");
        }
        if (acknowledged > end + 1) {
          await uploaded.body?.cancel();
          throw new Error("YouTube acknowledged bytes beyond the submitted chunk.");
        }
        if (acknowledged > offset) {
          offset = acknowledged;
          advanced = true;
          break;
        }
        lastFailure = new Error("YouTube did not acknowledge progress for the uploaded chunk.");
        mustCheckStatus = true;
        continue;
      }
      if (uploaded.ok || uploaded.status < 500) return uploaded;
      lastFailure = new Error(`YouTube upload temporarily failed (HTTP ${uploaded.status}).`);
      await uploaded.body?.cancel();
      mustCheckStatus = true;
    }
    if (!advanced && offset < totalBytes) {
      throw new Error(
        lastFailure
          ? `YouTube upload could not resume staged bytes: ${lastFailure.message}`
          : "YouTube upload could not resume staged bytes.",
      );
    }
  }
  throw new Error("YouTube upload ended without a final completion response.");
}
