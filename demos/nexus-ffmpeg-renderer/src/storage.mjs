import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const MIME_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/webp", ".webp"],
  ["image/bmp", ".bmp"], ["image/tiff", ".tiff"],
  ["video/mp4", ".mp4"], ["video/quicktime", ".mov"], ["video/webm", ".webm"], ["video/x-matroska", ".mkv"],
  ["audio/mpeg", ".mp3"], ["audio/wav", ".wav"], ["audio/x-wav", ".wav"],
  ["audio/mp4", ".m4a"], ["audio/aac", ".aac"], ["audio/ogg", ".ogg"], ["audio/flac", ".flac"],
]);
const MAX_ASSET_BYTES = 100 * 1024 * 1024;

function config() {
  const bucket = process.env.AWS_S3_BUCKET_NAME;
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const region = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  if (!bucket || !endpoint || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("Private asset storage is not fully configured.");
  }
  return { bucket, client: new S3Client({
    region, endpoint, forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  }) };
}

function objectKey(tenantId, projectId, assetId, extension) {
  const digest = createHash("sha256").update(assetId).digest("hex");
  return `assets/${tenantId}/${projectId}/${digest}${extension}`;
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
  const { bucket, client } = config();
  const key = objectKey(tenantId, projectId, assetId, extension);
  await client.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: bytes, ContentLength: bytes.length,
    ContentType: String(mimeType).split(";")[0].trim().toLowerCase(),
    ServerSideEncryption: "AES256",
  }));
  return { key, extension, bytes: bytes.length };
}

export async function getPrivateAsset({ tenantId, projectId, assetId, extension }) {
  if (!/^\.(?:jpg|png|webp|bmp|tif|tiff|mp4|mov|m4v|webm|mkv|mp3|wav|m4a|aac|ogg|flac)$/i.test(extension)) {
    throw new Error("Unsupported asset file extension.");
  }
  const { bucket, client } = config();
  const result = await client.send(new GetObjectCommand({
    Bucket: bucket, Key: objectKey(tenantId, projectId, assetId, extension),
  }));
  if (!result.Body) throw new Error("Stored asset has no readable body.");
  const chunks = [];
  let size = 0;
  for await (const chunk of result.Body) {
    size += chunk.length;
    if (size > MAX_ASSET_BYTES) throw new Error("Stored asset exceeds the 100 MiB limit.");
    chunks.push(Buffer.from(chunk));
  }
  if (!size) throw new Error("Stored asset is empty.");
  return Buffer.concat(chunks, size);
}

export const MAX_ASSET_BYTES_LIMIT = MAX_ASSET_BYTES;
