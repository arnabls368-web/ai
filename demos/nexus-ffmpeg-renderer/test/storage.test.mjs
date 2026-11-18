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

test("uses Railway bucket virtual-host addressing when configured", async () => {
  const keys = ["AWS_ENDPOINT_URL", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION", "AWS_S3_URL_STYLE"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  try {
    process.env.AWS_ENDPOINT_URL = "https://objects.example.test";
    process.env.AWS_S3_BUCKET_NAME = "nexus-private";
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    process.env.AWS_DEFAULT_REGION = "auto";
    process.env.AWS_S3_URL_STYLE = "virtual-host";
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return new Response(null, { status: 200 });
    };
    const { putPrivateAsset } = await import("../src/storage.mjs");
    await putPrivateAsset({
      tenantId: "tenant-a", projectId: "project-1", assetId: "scene-2",
      mimeType: "image/webp", bytes: Buffer.from("webp"),
    });
    assert.match(requestedUrl, /^https:\/\/nexus-private\.objects\.example\.test\/assets\/tenant-a\/project-1\//);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("round-trips private assets through the signed S3-compatible PUT and GET paths", async () => {
  const keys = ["AWS_ENDPOINT_URL", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION", "AWS_S3_URL_STYLE"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const stored = new Map();
  const requests = [];
  try {
    process.env.AWS_ENDPOINT_URL = "https://objects.example.test";
    process.env.AWS_S3_BUCKET_NAME = "nexus-private";
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    process.env.AWS_DEFAULT_REGION = "auto";
    process.env.AWS_S3_URL_STYLE = "virtual-host";
    globalThis.fetch = async (url, init) => {
      const key = String(url);
      requests.push({ url: key, method: init.method, authorization: init.headers.get("authorization") });
      if (init.method === "PUT") {
        stored.set(key, Buffer.from(init.body));
        return new Response(null, { status: 200 });
      }
      if (init.method === "GET" && stored.has(key)) {
        return new Response(stored.get(key), { status: 200 });
      }
      return new Response(null, { status: 404 });
    };
    const { putPrivateAsset, getPrivateAsset } = await import("../src/storage.mjs");
    const source = Buffer.from("NEXUS private asset round-trip");
    const metadata = await putPrivateAsset({
      tenantId: "tenant-roundtrip", projectId: "project-roundtrip",
      assetId: "asset-roundtrip", mimeType: "video/mp4", bytes: source,
    });
    const restored = await getPrivateAsset({
      tenantId: "tenant-roundtrip", projectId: "project-roundtrip",
      assetId: "asset-roundtrip", extension: metadata.extension,
    });
    assert.deepEqual(restored, source);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(({ method }) => method), ["PUT", "GET"]);
    assert.ok(requests.every(({ authorization }) =>
      authorization.startsWith("AWS4-HMAC-SHA256 Credential=test-access/")));
    assert.equal(requests[0].url, requests[1].url);
    assert.match(requests[0].url, /^https:\/\/nexus-private\.objects\.example\.test\/assets\/tenant-roundtrip\/project-roundtrip\//);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test("fails closed on object-storage authorization and missing-object responses", async () => {
  const keys = ["AWS_ENDPOINT_URL", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION", "AWS_S3_URL_STYLE"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  try {
    process.env.AWS_ENDPOINT_URL = "https://objects.example.test";
    process.env.AWS_S3_BUCKET_NAME = "nexus-private";
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    process.env.AWS_DEFAULT_REGION = "auto";
    process.env.AWS_S3_URL_STYLE = "virtual-host";
    const { putPrivateAsset, getPrivateAsset } = await import("../src/storage.mjs");

    globalThis.fetch = async () => new Response("sensitive provider detail", { status: 403 });
    await assert.rejects(
      putPrivateAsset({
        tenantId: "tenant-failure", projectId: "project-failure",
        assetId: "asset-failure", mimeType: "image/png", bytes: Buffer.from("image"),
      }),
      (error) => {
        assert.match(error.message, /HTTP 403/);
        assert.equal(error.message.includes("sensitive provider detail"), false);
        return true;
      },
    );

    globalThis.fetch = async () => new Response("private object details", { status: 404 });
    await assert.rejects(
      getPrivateAsset({
        tenantId: "tenant-failure", projectId: "project-failure",
        assetId: "asset-missing", extension: ".png",
      }),
      (error) => {
        assert.match(error.message, /HTTP 404/);
        assert.equal(error.message.includes("private object details"), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
