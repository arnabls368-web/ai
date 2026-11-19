import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

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

function signedRequest({ method, key, body, contentType, payloadHash: suppliedPayloadHash, contentLength, range, query }) {
  const { bucket, base, region, accessKeyId, secretAccessKey } = config();
  const urlStyle = process.env.AWS_S3_URL_STYLE ?? "path";
  let url;
  if (urlStyle === "virtual-host") {
    url = new URL(base.toString());
    url.hostname = bucket + "." + base.hostname;
    url.pathname = base.pathname.replace(/\/$/, "") + (key === null ? "" : "/" + encodePath(key));
  } else if (urlStyle === "path") {
    const objectPath = base.pathname.replace(/\/$/, "") + "/" + encodePath(bucket) + (key === null ? "" : "/" + encodePath(key));
    url = new URL(base.origin + objectPath);
  } else {
    throw new Error("AWS_S3_URL_STYLE must be path or virtual-host.");
  }
  const awsEncode = (value) => encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) =>
    "%" + char.charCodeAt(0).toString(16).toUpperCase()
  );
  const queryEntries = Object.entries(query ?? {})
    .map(([name, value]) => [awsEncode(name), awsEncode(value)])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const canonicalQuery = queryEntries.map(([name, value]) => name + "=" + value).join("&");
  url.search = canonicalQuery;
  const host = url.host;
  const payloadHash = suppliedPayloadHash ?? (body ? createHash("sha256").update(body).digest("hex") : EMPTY_SHA256);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headers["content-type"] = contentType;
  if (contentLength !== undefined) headers["content-length"] = String(contentLength);
  if (range) headers.range = range;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((name) =>
    name + ":" + String(headers[name]).trim() + "\n"
  ).join("");
  const canonicalRequest = method + "\n" + url.pathname + "\n" + canonicalQuery + "\n" +
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
    ...(body && !Buffer.isBuffer(body) ? { duplex: "half" } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
}

function objectKey(tenantId, projectId, assetId, extension, prefix = "assets") {
  const digest = createHash("sha256").update(assetId).digest("hex");
  return prefix + "/" + tenantId + "/" + projectId + "/" + digest + extension;
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


export async function putPrivateAssetFile({ tenantId, projectId, assetId, mimeType, filePath, prefix = "assets" }) {
  const extension = extensionForMime(mimeType);
  if (!extension) throw new Error("Unsupported asset media type.");
  const info = await stat(filePath);
  if (!info.isFile() || info.size < 1 || info.size > MAX_ASSET_BYTES) {
    throw new Error("Asset must be between 1 byte and 100 MiB.");
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  const sha256 = digest.digest("hex");
  const key = objectKey(tenantId, projectId, assetId, extension, prefix);
  const response = await signedRequest({
    method: "PUT",
    key,
    body: createReadStream(filePath),
    contentType: String(mimeType).split(";")[0].trim().toLowerCase(),
    payloadHash: sha256,
    contentLength: info.size,
  });
  if (!response.ok) {
    const status = response.status;
    await response.body?.cancel();
    throw new Error("Private object storage rejected asset upload (HTTP " + status + ").");
  }
  await response.body?.cancel();
  return { key, extension, bytes: info.size, sha256 };
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


/**
 * Fetch one bounded byte range without buffering the object in renderer memory.
 * The caller owns and must consume or cancel the returned response body.
 */
export async function getPrivateAssetRange({ tenantId, projectId, assetId, extension, start, end, prefix = "assets" }) {
  if (!/^\.(?:mp4|mov|m4v|webm|mkv)$/i.test(extension)) {
    throw new Error("Unsupported staged video extension.");
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end < start || end - start + 1 > 8 * 1024 * 1024) {
    throw new Error("Requested asset range is invalid or exceeds 8 MiB.");
  }
  const response = await signedRequest({
    method: "GET",
    key: objectKey(tenantId, projectId, assetId, extension, prefix),
    range: `bytes=${start}-${end}`,
  });
  if (response.status === 404) {
    await response.body?.cancel();
    throw Object.assign(new Error("Private staged asset was not found."), { status: 404 });
  }
  if (response.status === 416) {
    await response.body?.cancel();
    throw Object.assign(new Error("Requested asset range is not satisfiable."), { status: 416 });
  }
  if (response.status !== 206 || !response.body) {
    await response.body?.cancel();
    throw new Error("Private object storage did not return a valid partial response.");
  }
  const contentRange = response.headers.get("content-range") ?? "";
  const match = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  const contentLength = Number(response.headers.get("content-length"));
  const totalBytes = match ? Number(match[3]) : NaN;
  if (!match || Number(match[1]) !== start || Number(match[2]) !== end ||
      !Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > MAX_ASSET_BYTES ||
      end >= totalBytes || contentLength !== end - start + 1) {
    await response.body.cancel();
    throw new Error("Private object storage returned inconsistent range metadata.");
  }
  return { body: response.body, contentRange, contentLength, totalBytes };
}



function decodeXml(value) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function xmlTag(block, name) {
  const match = block.match(new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">"));
  return match ? decodeXml(match[1]) : null;
}

/**
 * Remove only old video objects in the isolated staged-assets namespace.
 * LastModified is supplied by ListObjectsV2; the 24-hour grace period
 * protects uploads and approvals in progress.
 */
export async function cleanupStagedAssets({
  olderThanMs = 24 * 60 * 60 * 1000,
  maxDeletes = 1000,
  maxPages = 100,
  now = Date.now(),
} = {}) {
  if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 60 * 60 * 1000 ||
      !Number.isSafeInteger(maxDeletes) || maxDeletes < 1 || maxDeletes > 5000 ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100 ||
      !Number.isSafeInteger(now)) {
    throw new Error("Staged asset cleanup limits are invalid.");
  }
  const cutoff = now - olderThanMs;
  let continuationToken;
  let scanned = 0;
  let deleted = 0;
  let pages = 0;
  do {
    const query = {
      "list-type": "2",
      "max-keys": "1000",
      prefix: "staged-assets/",
      ...(continuationToken ? { "continuation-token": continuationToken } : {}),
    };
    const response = await signedRequest({ method: "GET", key: null, query });
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel();
      throw new Error("Private staged asset listing failed (HTTP " + status + ").");
    }
    const xml = await response.text();
    if (xml.length > 2 * 1024 * 1024) throw new Error("Staged asset listing response exceeded 2 MiB.");
    pages += 1;
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = xmlTag(match[1], "Key");
      const modified = xmlTag(match[1], "LastModified");
      const timestamp = modified ? Date.parse(modified) : NaN;
      scanned += 1;
      if (!key || !key.startsWith("staged-assets/") ||
          !/\.(?:mp4|mov|m4v|webm|mkv)$/i.test(key) ||
          !Number.isFinite(timestamp) || timestamp > cutoff) continue;
      const removal = await signedRequest({ method: "DELETE", key });
      if (!removal.ok && removal.status !== 404) {
        const status = removal.status;
        await removal.body?.cancel();
        throw new Error("Private staged asset cleanup failed (HTTP " + status + ").");
      }
      await removal.body?.cancel();
      deleted += 1;
      if (deleted >= maxDeletes) {
        return { scanned, deleted, pages, truncated: true };
      }
    }
    const truncated = xmlTag(xml, "IsTruncated");
    continuationToken = truncated === "true" ? xmlTag(xml, "NextContinuationToken") : null;
    if (truncated === "true" && !continuationToken) {
      throw new Error("Staged asset listing omitted its continuation token.");
    }
  } while (continuationToken && pages < maxPages);
  return { scanned, deleted, pages, truncated: Boolean(continuationToken) };
}

export const MAX_ASSET_BYTES_LIMIT = MAX_ASSET_BYTES;


/** Delete a tenant/project-scoped private staged asset. Missing objects are already clean. */
export async function deletePrivateAsset({ tenantId, projectId, assetId, extension, prefix = "assets" }) {
  if (typeof extension !== "string" || ![".mp4", ".mov", ".m4v", ".webm", ".mkv"].includes(extension.toLowerCase())) {
    throw new Error("Unsupported staged video extension.");
  }
  const response = await signedRequest({
    method: "DELETE",
    key: objectKey(tenantId, projectId, assetId, extension, prefix),
  });
  if (!response.ok && response.status !== 404) {
    const status = response.status;
    await response.body?.cancel();
    throw new Error("Private object storage could not delete staged asset (HTTP " + status + ").");
  }
  await response.body?.cancel();
  return { deleted: response.status !== 404 };
}
