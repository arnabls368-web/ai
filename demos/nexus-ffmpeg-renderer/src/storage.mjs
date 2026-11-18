import { createHash, createHmac } from "node:crypto";

const MIME_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/webp", ".webp"],
  ["image/bmp", ".bmp"], ["image/tiff", ".tiff"],
  ["video/mp4", ".mp4"], ["video/quicktime", ".mov"], ["video/webm", ".webm"], ["video/x-matroska", ".mkv"],
  ["audio/mpeg", ".mp3"], ["audio/wav", ".wav"], ["audio/x-wav", ".wav"],
  ["audio/mp4", ".m4a"], ["audio/aac", ".aac"], ["audio/ogg", ".ogg"], ["audio/flac", ".flac"],
]);
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function config() {
  const bucket = process.env.AWS_S3_BUCKET_NAME;
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const region = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("Private asset storage is not fully configured.");
  }
  const base = new URL(endpoint);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("The private object-storage endpoint must be a clean HTTPS URL.");
  }
  return { bucket, base, region, accessKeyId, secretAccessKey };
}

function encodePath(value) {
  return value.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) =>
    "%" + char.charCodeAt(0).toString(16).toUpperCase()
  )).join("/");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value, "utf8").digest(encoding);
}

function signedRequest({ method, key, body, contentType }) {
  const { bucket, base, region, accessKeyId, secretAccessKey } = config();
  const objectPath = (base.pathname.replace(/\/$/, "") + "/" + encodePath(bucket) + "/" + encodePath(key)) || "/";
  const url = new URL(base.origin + objectPath);
  const host = url.host;
  const payloadHash = body ? createHash("sha256").update(body).digest("hex") : EMPTY_SHA256;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headers["content-type"] = contentType;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((name) =>
    name + ":" + String(headers[name]).trim() + "\n"
  ).join("");
  const canonicalRequest = method + "\n" + url.pathname + "\n\n" +
    canonicalHeaders + signedHeaders + "\n" + payloadHash;
  const scope = dateStamp + "/" + region + "/s3/aws4_request";
  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const dateKey = hmac("AWS4" + secretAccessKey, dateStamp);
  const regionKey = createHmac("sha256", dateKey).update(region).digest();
  const serviceKey = createHmac("sha256", regionKey).update("s3").digest();
  const signingKey = createHmac("sha256", serviceKey).update("aws4_request").digest();
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = "AWS4-HMAC-SHA256 Credential=" + accessKeyId + "/" + scope +
    ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Authorization", authorization);
  return fetch(url, {
    method,
    headers: requestHeaders,
    body: body ?? undefined,
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
}

function objectKey(tenantId, projectId, assetId, extension) {
  const digest = createHash("sha256").update(assetId).digest("hex");
  return "assets/" + tenantId + "/" + projectId + "/" + digest + extension;
}

export function extensionForMime(mimeType) {
  return MIME_EXTENSIONS.get(String(mimeType).split(";")[0].trim().toLowerCase()) ?? null;
}

export async function putPrivateAsset({ tenantId, projectId, assetId, mimeType, bytes }) {
  const extension = extensionForMime(mimeType);
  if (!extension) throw new Error("Unsupported asset media type.");
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_ASSET_BYTES) {
    throw new Error("Asset must be between 1 byte and 100 MiB.");
  }
  const key = objectKey(tenantId, projectId, assetId, extension);
  const response = await signedRequest({
    method: "PUT", key, body: bytes,
    contentType: String(mimeType).split(";")[0].trim().toLowerCase(),
  });
  if (!response.ok) {
    const status = response.status;
    await response.body?.cancel();
    throw new Error("Private object storage rejected asset upload (HTTP " + status + ").");
  }
  await response.body?.cancel();
  return { key, extension, bytes: bytes.length };
}

export async function getPrivateAsset({ tenantId, projectId, assetId, extension }) {
  if (!/^\.(?:jpg|png|webp|bmp|tif|tiff|mp4|mov|m4v|webm|mkv|mp3|wav|m4a|aac|ogg|flac)$/i.test(extension)) {
    throw new Error("Unsupported asset file extension.");
  }
  const response = await signedRequest({
    method: "GET", key: objectKey(tenantId, projectId, assetId, extension),
  });
  if (!response.ok) {
    const status = response.status;
    await response.body?.cancel();
    throw new Error("Private object storage could not read asset (HTTP " + status + ").");
  }
  if (!response.body) throw new Error("Stored asset has no readable body.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ASSET_BYTES) {
        await reader.cancel("Stored asset exceeds size limit.");
        throw new Error("Stored asset exceeds the 100 MiB limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new Error("Stored asset is empty.");
  return Buffer.concat(chunks, size);
}

export const MAX_ASSET_BYTES_LIMIT = MAX_ASSET_BYTES;
