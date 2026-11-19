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


test("private object keys isolate tenants and projects and never expose raw asset IDs", async () => {
  const keys = [
    "AWS_ENDPOINT_URL", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION", "AWS_S3_URL_STYLE",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const requested = [];
  try {
    process.env.AWS_ENDPOINT_URL = "https://objects.example.test";
    process.env.AWS_S3_BUCKET_NAME = "nexus-private";
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    process.env.AWS_DEFAULT_REGION = "auto";
    process.env.AWS_S3_URL_STYLE = "virtual-host";
    globalThis.fetch = async (url) => {
      requested.push(String(url));
      return new Response(null, { status: 200 });
    };
    const { putPrivateAsset } = await import("../src/storage.mjs");
    const common = { assetId: "private-scene-name", mimeType: "image/png", bytes: Buffer.from("image") };
    await putPrivateAsset({ ...common, tenantId: "tenant-a", projectId: "project-1" });
    await putPrivateAsset({ ...common, tenantId: "tenant-b", projectId: "project-1" });
    await putPrivateAsset({ ...common, tenantId: "tenant-a", projectId: "project-2" });
    assert.equal(new Set(requested).size, 3);
    assert.ok(requested.every((url) => url.includes("/assets/")));
    assert.ok(requested.every((url) => !url.includes("private-scene-name")));
    assert.ok(requested[0].includes("/assets/tenant-a/project-1/"));
    assert.ok(requested[1].includes("/assets/tenant-b/project-1/"));
    assert.ok(requested[2].includes("/assets/tenant-a/project-2/"));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("private storage rejects non-HTTPS and credential-bearing endpoints", async () => {
  const keys = ["AWS_ENDPOINT_URL", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  try {
    process.env.AWS_S3_BUCKET_NAME = "nexus-private";
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    const { putPrivateAsset } = await import("../src/storage.mjs");
    for (const endpoint of ["http://objects.example.test", "https://user:pass@objects.example.test"]) {
      process.env.AWS_ENDPOINT_URL = endpoint;
      globalThis.fetch = async () => {
        throw new Error("fetch must not be called for an invalid endpoint");
      };
      await assert.rejects(
        putPrivateAsset({
          tenantId: "tenant-a", projectId: "project-1",
          assetId: "scene-1", mimeType: "image/png", bytes: Buffer.from("image"),
        }),
        /clean HTTPS URL/,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("streams file-backed private assets with a signed content hash and exact length", async () => {
  const keys = [
    "AWS_ENDPOINT_URL", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION", "AWS_S3_URL_STYLE",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const directory = await mkdtemp(join(tmpdir(), "nexus-storage-test-"));
  try {
    process.env.AWS_ENDPOINT_URL = "https://objects.example.test";
    process.env.AWS_S3_BUCKET_NAME = "nexus-private";
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    process.env.AWS_DEFAULT_REGION = "auto";
    process.env.AWS_S3_URL_STYLE = "virtual-host";
    const source = Buffer.from("streamed private video asset");
    const filePath = join(directory, "asset.mp4");
    await writeFile(filePath, source, { mode: 0o600 });
    let captured;
    globalThis.fetch = async (url, init) => {
      const chunks = [];
      for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
      captured = { url: String(url), init, body: Buffer.concat(chunks) };
      return new Response(null, { status: 200 });
    };
    const { putPrivateAssetFile } = await import("../src/storage.mjs");
    const result = await putPrivateAssetFile({
      tenantId: "tenant-stream", projectId: "project-stream",
      assetId: "asset-stream", mimeType: "video/mp4", filePath,
    });
    assert.equal(result.bytes, source.length);
    assert.equal(result.extension, ".mp4");
    assert.deepEqual(captured.body, source);
    assert.equal(captured.init.method, "PUT");
    assert.equal(captured.init.duplex, "half");
    assert.equal(captured.init.headers.get("content-length"), String(source.length));
    assert.equal(
      captured.init.headers.get("x-amz-content-sha256"),
      createHash("sha256").update(source).digest("hex"),
    );
    assert.match(captured.url, /^https:\/\/nexus-private\.objects\.example\.test\/assets\/tenant-stream\/project-stream\//);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});


test("streams a signed bounded byte range from private video storage", async () => {
  const keys = ["AWS_ENDPOINT_URL", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION", "AWS_S3_URL_STYLE"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let captured;
  try {
    process.env.AWS_ENDPOINT_URL = "https://objects.example.test";
    process.env.AWS_S3_BUCKET_NAME = "nexus-private";
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    process.env.AWS_DEFAULT_REGION = "auto";
    process.env.AWS_S3_URL_STYLE = "virtual-host";
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init };
      return new Response(new Uint8Array([3, 4, 5]), {
        status: 206,
        headers: { "content-range": "bytes 3-5/20", "content-length": "3" },
      });
    };
    const { getPrivateAssetRange } = await import("../src/storage.mjs");
    const range = await getPrivateAssetRange({
      tenantId: "tenant-range", projectId: "project-range",
      assetId: "video-1", extension: ".mp4", start: 3, end: 5, prefix: "staged-assets",
    });
    assert.equal(captured.init.method, "GET");
    assert.equal(captured.init.headers.get("range"), "bytes=3-5");
    assert.match(captured.init.headers.get("authorization"), /SignedHeaders=.*range/);
    assert.equal(range.contentRange, "bytes 3-5/20");
    assert.equal(range.contentLength, 3);
    assert.equal(range.totalBytes, 20);
    assert.deepEqual(Buffer.from(await new Response(range.body).arrayBuffer()), Buffer.from([3, 4, 5]));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("rejects inconsistent private object range metadata", async () => {
  const keys = ["AWS_ENDPOINT_URL", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  try {
    process.env.AWS_ENDPOINT_URL = "https://objects.example.test";
    process.env.AWS_S3_BUCKET_NAME = "nexus-private";
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    process.env.AWS_DEFAULT_REGION = "auto";
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2]), {
      status: 206,
      headers: { "content-range": "bytes 0-2/20", "content-length": "2" },
    });
    const { getPrivateAssetRange } = await import("../src/storage.mjs");
    await assert.rejects(getPrivateAssetRange({
      tenantId: "tenant-range", projectId: "project-range",
      assetId: "video-1", extension: ".mp4", start: 0, end: 2,
    }), /inconsistent range metadata/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test("deletes only the scoped private staged object using a signed S3 request", async () => {
  const keys = ["AWS_ENDPOINT_URL", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let captured;
  try {
    process.env.AWS_ENDPOINT_URL = "https://objects.example.test";
    process.env.AWS_S3_BUCKET_NAME = "nexus-private";
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    process.env.AWS_DEFAULT_REGION = "auto";
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init };
      return new Response(null, { status: 204 });
    };
    const { deletePrivateAsset } = await import("../src/storage.mjs");
    const result = await deletePrivateAsset({
      tenantId: "tenant-delete", projectId: "project-delete",
      assetId: "asset-delete", extension: ".mp4", prefix: "staged-assets",
    });
    assert.deepEqual(result, { deleted: true });
    assert.equal(captured.init.method, "DELETE");
    assert.match(captured.url, /staged-assets\/tenant-delete\/project-delete\//);
    assert.match(captured.init.headers.get("authorization"), /^AWS4-HMAC-SHA256/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test("sweeps only expired video objects under the staged-assets prefix", async () => {
  const keys = ["AWS_ENDPOINT_URL", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION", "AWS_S3_URL_STYLE"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const now = Date.parse("2026-11-19T04:00:00.000Z");
  const deleted = [];
  let listingUrl;
  try {
    process.env.AWS_ENDPOINT_URL = "https://objects.example.test";
    process.env.AWS_S3_BUCKET_NAME = "nexus-private";
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    process.env.AWS_DEFAULT_REGION = "auto";
    process.env.AWS_S3_URL_STYLE = "virtual-host";
    globalThis.fetch = async (url, init) => {
      if (init.method === "GET") {
        listingUrl = String(url);
        const xml = '<?xml version="1.0"?>' +
          '<ListBucketResult>' +
          '<Contents><Key>staged-assets/tenant-a/project-a/old.mp4</Key><LastModified>2026-11-18T00:00:00.000Z</LastModified></Contents>' +
          '<Contents><Key>staged-assets/tenant-a/project-a/recent.webm</Key><LastModified>2026-11-19T03:30:00.000Z</LastModified></Contents>' +
          '<Contents><Key>assets/tenant-a/project-a/permanent.mp4</Key><LastModified>2026-11-17T00:00:00.000Z</LastModified></Contents>' +
          '<Contents><Key>staged-assets/tenant-a/project-a/image.png</Key><LastModified>2026-11-17T00:00:00.000Z</LastModified></Contents>' +
          '</ListBucketResult>';
        return new Response(xml);
      }
      if (init.method === "DELETE") {
        deleted.push(String(url));
        return new Response(null, { status: 204 });
      }
      throw new Error("Unexpected storage method");
    };
    const { cleanupStagedAssets } = await import("../src/storage.mjs");
    const result = await cleanupStagedAssets({ olderThanMs: 3 * 60 * 60 * 1000, now });
    assert.deepEqual(result, { scanned: 4, deleted: 1, pages: 1, truncated: false });
    assert.equal(new URL(listingUrl).searchParams.get("prefix"), "staged-assets/");
    assert.equal(new URL(listingUrl).searchParams.get("list-type"), "2");
    assert.equal(deleted.length, 1);
    assert.match(deleted[0], /staged-assets\/tenant-a\/project-a\/old\.mp4$/);
    assert.match(new URL(listingUrl).search, /prefix=staged-assets%2F/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("staged asset cleanup rejects unsafe limits and fails closed on listing errors", async () => {
  const keys = ["AWS_ENDPOINT_URL", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  try {
    process.env.AWS_ENDPOINT_URL = "https://objects.example.test";
    process.env.AWS_S3_BUCKET_NAME = "nexus-private";
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    const { cleanupStagedAssets } = await import("../src/storage.mjs");
    await assert.rejects(cleanupStagedAssets({ olderThanMs: 1000 }), /limits are invalid/);
    globalThis.fetch = async () => new Response("private provider error", { status: 403 });
    await assert.rejects(cleanupStagedAssets(), /listing failed \(HTTP 403\)/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test("paginates staged object listings with safely encoded continuation tokens", async () => {
  const keys = ["AWS_ENDPOINT_URL", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const now = Date.parse("2026-11-19T04:00:00.000Z");
  const urls = [];
  const deleted = [];
  try {
    process.env.AWS_ENDPOINT_URL = "https://objects.example.test";
    process.env.AWS_S3_BUCKET_NAME = "nexus-private";
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    process.env.AWS_DEFAULT_REGION = "auto";
    globalThis.fetch = async (url, init) => {
      urls.push(String(url));
      if (init.method === "DELETE") {
        deleted.push(String(url));
        return new Response(null, { status: 204 });
      }
      if (urls.filter((value) => value.includes("list-type")).length === 1) {
        return new Response("<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next&amp;token/+part</NextContinuationToken></ListBucketResult>");
      }
      return new Response(
        "<ListBucketResult><IsTruncated>false</IsTruncated>" +
        "<Contents><Key>staged-assets/tenant/project/expired.mkv</Key><LastModified>2026-11-18T00:00:00.000Z</LastModified></Contents>" +
        "</ListBucketResult>",
      );
    };
    const { cleanupStagedAssets } = await import("../src/storage.mjs");
    const result = await cleanupStagedAssets({ olderThanMs: 3 * 60 * 60 * 1000, now });
    assert.deepEqual(result, { scanned: 1, deleted: 1, pages: 2, truncated: false });
    assert.equal(urls.filter((value) => value.includes("list-type")).length, 2);
    const secondPage = new URL(urls.filter((value) => value.includes("list-type"))[1]);
    assert.equal(secondPage.searchParams.get("continuation-token"), "next&token/+part");
    assert.equal(deleted.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("rejects private object keys outside the permanent and staging namespaces", async () => {
  const { deletePrivateAsset } = await import("../src/storage.mjs");
  await assert.rejects(deletePrivateAsset({
    tenantId: "tenant-a",
    projectId: "project-a",
    assetId: "asset-a",
    extension: ".mp4",
    prefix: "assets/../../other",
  }), /prefix is not allowed/);
});
