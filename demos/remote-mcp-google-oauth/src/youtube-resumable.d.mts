export function nextUploadOffset(rangeHeader: string | null, totalBytes: number): number;

export function uploadResumableVideo(options: {
  uploadUrl: string;
  videoBytes: ArrayBuffer;
  mimeType: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
}): Promise<Response>;

export function uploadResumableVideoFromRanges(options: {
  uploadUrl: string;
  totalBytes: number;
  mimeType: string;
  accessToken: string;
  readRange: (start: number, end: number) => Promise<{
    body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array;
    byteLength: number;
  }>;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  chunkBytes?: number;
}): Promise<Response>;
