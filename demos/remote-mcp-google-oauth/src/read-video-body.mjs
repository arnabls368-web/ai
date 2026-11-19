/** Maximum accepted source video size for the first upload implementation. */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/**
 * Read a bounded video response.
 *
 * When Content-Length is present, allocate the exact final buffer and fill it
 * directly. This avoids retaining both a chunk list and a second full-size
 * concatenated copy for the common known-length case.
 *
 * Chunked responses remain bounded but currently use a chunk list followed
 * by a final allocation; staging is required to eliminate that fallback copy.
 */
export async function readVideoBodyBounded(response: Response): Promise<ArrayBuffer> {
  const declaredLength = response.headers.get("Content-Length");
  let expectedLength: number | null = null;
  if (declaredLength !== null) {
    expectedLength = Number(declaredLength);
    if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) {
      throw new Error("Video response has an invalid Content-Length header.");
    }
    if (expectedLength > MAX_VIDEO_BYTES) {
      throw new Error("Video exceeds the 50 MB limit for this first version.");
    }
  }
  if (!response.body) throw new Error("Video response has no readable body.");

  const reader = response.body.getReader();
  if (expectedLength !== null) {
    const bytes = new Uint8Array(expectedLength);
    let offset = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > expectedLength - offset) {
          await reader.cancel("Video body exceeded its declared length.");
          throw new Error("Video response exceeded its declared Content-Length.");
        }
        bytes.set(value, offset);
        offset += value.byteLength;
      }
      if (offset !== expectedLength) {
        throw new Error("Video response did not match its declared Content-Length.");
      }
      if (offset === 0) throw new Error("Video response body must not be empty.");
      return bytes.buffer;
    } finally {
      reader.releaseLock();
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_VIDEO_BYTES) {
        await reader.cancel("Video exceeds upload size limit.");
        throw new Error("Video exceeds the 50 MB limit for this first version.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) throw new Error("Video response body must not be empty.");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
