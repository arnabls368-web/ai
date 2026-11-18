export function nextUploadOffset(rangeHeader: string | null, totalBytes: number): number;

export function uploadResumableVideo(options: {
  uploadUrl: string;
  videoBytes: ArrayBuffer;
  mimeType: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
}): Promise<Response>;
