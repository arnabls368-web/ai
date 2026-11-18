import test from "node:test";
import assert from "node:assert/strict";
import { extensionForMime } from "../src/storage.mjs";

test("maps supported generated media MIME types to safe file extensions", () => {
  assert.equal(extensionForMime("image/png"), ".png");
  assert.equal(extensionForMime("image/jpeg; charset=binary"), ".jpg");
  assert.equal(extensionForMime("video/mp4"), ".mp4");
  assert.equal(extensionForMime("audio/mpeg"), ".mp3");
  assert.equal(extensionForMime("application/x-msdownload"), null);
  assert.equal(extensionForMime("text/html"), null);
});

test("uploads tenant-scoped assets with signed S3-compatible requests", async () => {
  const saved = Object.fromEntries([
    "AWS_ENDPOINT_URL", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION",
  ].map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let captured;
  try {
    process.env.AWS_ENDPOINT_URL = "https://objects.example.test";
    process.env.AWS_S3_BUCKET_NAME = "nexus-private";
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    process.env.AWS_DEFAULT_REGION = "sin";
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init };
      return new Response(null, { status: 200 });
    };
    const { putPrivateAsset } = await import("../src/storage.mjs");
    const result = await putPrivateAsset({
      tenantId: "tenant-a",
      projectId: "project-1",
      assetId: "scene-1",
      mimeType: "image/png",
      bytes: Buffer.from("test-image"),
    });
    assert.equal(result.extension, ".png");
    assert.equal(result.bytes, 10);
    assert.match(captured.url, /^https:\/\/objects\.example\.test\/nexus-private\/assets\/tenant-a\/project-1\//);
    assert.equal(captured.init.method, "PUT");
    assert.match(captured.init.headers.get("authorization"), /^AWS4-HMAC-SHA256 Credential=test-access\//);
    assert.equal(captured.init.headers.get("x-amz-content-sha256")?.length, 64);
    assert.equal(captured.init.body.toString(), "test-image");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
