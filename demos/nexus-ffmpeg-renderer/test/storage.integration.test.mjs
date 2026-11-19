import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deletePrivateAsset,
  getPrivateAssetRange,
  putPrivateAssetFile,
} from "../src/storage.mjs";

const enabled = process.env.NEXUS_STORAGE_INTEGRATION === "true";
const bucket = process.env.AWS_S3_BUCKET_NAME ?? "";
const confirmedBucket = process.env.NEXUS_STORAGE_INTEGRATION_BUCKET_CONFIRM ?? "";
const credentialsPresent = Boolean(
  process.env.AWS_ENDPOINT_URL &&
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY
);

test("real S3-compatible staged-object PUT, range GET, tenant isolation and DELETE", {
  skip: !enabled && "Set NEXUS_STORAGE_INTEGRATION=true to opt in.",
}, async () => {
  assert.ok(bucket, "AWS_S3_BUCKET_NAME is required.");
  assert.equal(confirmedBucket, bucket,
    "NEXUS_STORAGE_INTEGRATION_BUCKET_CONFIRM must exactly match AWS_S3_BUCKET_NAME.");
  assert.ok(credentialsPresent,
    "AWS_ENDPOINT_URL and dedicated test credentials are required.");
  assert.match(bucket, /(?:test|sandbox|integration)/i,
    "Refusing real integration writes unless the bucket name clearly identifies a test/sandbox bucket.");

  const tenantId = "integration-" + randomUUID();
  const projectId = "project-" + randomUUID();
  const assetId = "asset-" + randomUUID();
  const directory = await mkdtemp(join(tmpdir(), "nexus-s3-integration-"));
  const filePath = join(directory, "fixture.mp4");
  const payload = Buffer.from("NEXUS-S3-INTEGRATION-FIXTURE\n0123456789abcdef\n");
  let uploaded = false;

  try {
    await writeFile(filePath, payload, { mode: 0o600 });
    const metadata = await putPrivateAssetFile({
      tenantId,
      projectId,
      assetId,
      mimeType: "video/mp4",
      filePath,
      prefix: "staged-assets",
    });
    uploaded = true;
    assert.equal(metadata.bytes, payload.length);
    assert.match(metadata.sha256, /^[a-f0-9]{64}$/);

    const start = 5;
    const end = 19;
    const range = await getPrivateAssetRange({
      tenantId,
      projectId,
      assetId,
      extension: ".mp4",
      prefix: "staged-assets",
      start,
      end,
    });
    const chunks = [];
    for await (const chunk of range.body) chunks.push(Buffer.from(chunk));
    assert.equal(range.contentRange, `bytes ${start}-${end}/${payload.length}`);
    assert.equal(range.contentLength, end - start + 1);
    assert.deepEqual(Buffer.concat(chunks), payload.subarray(start, end + 1));

    await assert.rejects(
      getPrivateAssetRange({
        tenantId: tenantId + "-wrong",
        projectId,
        assetId,
        extension: ".mp4",
        prefix: "staged-assets",
        start: 0,
        end: 3,
      }),
      (error) => error.status === 403 || error.status === 404,
      "A different tenant must not read the staged object.",
    );

    const deleted = await deletePrivateAsset({
      tenantId,
      projectId,
      assetId,
      extension: ".mp4",
      prefix: "staged-assets",
    });
    assert.equal(deleted.deleted, true);
    uploaded = false;

    await assert.rejects(
      getPrivateAssetRange({
        tenantId,
        projectId,
        assetId,
        extension: ".mp4",
        prefix: "staged-assets",
        start: 0,
        end: 3,
      }),
      (error) => error.status === 403 || error.status === 404,
      "The exact object should be absent after deletion.",
    );
  } finally {
    if (uploaded) {
      await deletePrivateAsset({
        tenantId,
        projectId,
        assetId,
        extension: ".mp4",
        prefix: "staged-assets",
      }).catch(() => {});
    }
    await rm(directory, { recursive: true, force: true });
  }
});
