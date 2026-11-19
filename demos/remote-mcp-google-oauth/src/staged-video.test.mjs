import test from "node:test";
import assert from "node:assert/strict";
import { createStagedVideoRangeReader, stageVideoSource, MAX_STAGED_VIDEO_BYTES } from "./staged-video.mjs";

const sha256 = "a".repeat(64);

test("streams a supported source into private staging and returns verified metadata", async () => {
  let request;
  const staged = await stageVideoSource({
    assetId: "asset-1",
    source: new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } }),
    mimeType: "video/mp4",
    callRenderer: async (value) => {
      request = value;
      const bytes = await new Response(value.rawBody).arrayBuffer();
      assert.equal(bytes.byteLength, 3);
      return Response.json({
        assetId: "asset-1",
        filename: "asset-1.mp4",
        bytes: 3,
        sha256,
        storage: "private_object_storage",
      }, { status: 201 });
    },
  });
  assert.equal(request.method, "PUT");
  assert.equal(request.scope, "asset:write");
  assert.equal(request.path, "/assets/asset-1");
  assert.equal(request.contentType, "video/mp4");
  assert.deepEqual(staged, {
    assetId: "asset-1",
    extension: "mp4",
    totalBytes: 3,
    sha256,
    mimeType: "video/mp4",
  });
});

test("rejects unsupported video MIME types before staging", async () => {
  let called = false;
  await assert.rejects(stageVideoSource({
    source: new Response(new Uint8Array([1])),
    mimeType: "video/avi",
    callRenderer: async () => { called = true; return new Response(); },
  }), /MP4, MOV, WebM, or Matroska/);
  assert.equal(called, false);
});

test("rejects oversized, malformed, or mismatched staging metadata", async () => {
  const source = () => new Response(new Uint8Array([1]));
  const cases = [
    { assetId: "asset-1", filename: "asset-1.mp4", bytes: MAX_STAGED_VIDEO_BYTES + 1, sha256, storage: "private_object_storage" },
    { assetId: "asset-1", filename: "other.mp4", bytes: 3, sha256, storage: "private_object_storage" },
    { assetId: "asset-1", filename: "asset-1.mp4", bytes: 3, sha256: "bad", storage: "private_object_storage" },
  ];
  for (const record of cases) {
    await assert.rejects(stageVideoSource({
      assetId: "asset-1",
      source: source(),
      mimeType: "video/mp4",
      callRenderer: async () => Response.json(record, { status: 201 }),
    }), /invalid staged video metadata/);
  }
});

test("cleans up a staged object when the renderer returns invalid metadata", async () => {
  const methods = [];
  await assert.rejects(stageVideoSource({
    assetId: "asset-partial",
    source: new Response(new Uint8Array([1, 2, 3])),
    mimeType: "video/mp4",
    callRenderer: async (request) => {
      methods.push(request.method);
      if (request.method === "PUT") return Response.json({ assetId: "wrong" }, { status: 201 });
      return Response.json({ deleted: true });
    },
  }), /invalid staged video metadata/);
  assert.deepEqual(methods, ["PUT", "DELETE"]);
});

test("attempts cleanup after a staging request returns an error", async () => {
  const methods = [];
  await assert.rejects(stageVideoSource({
    assetId: "asset-failed",
    source: new Response(new Uint8Array([1, 2, 3])),
    mimeType: "video/mp4",
    callRenderer: async (request) => {
      methods.push(request.method);
      return request.method === "PUT"
        ? new Response("storage error", { status: 502 })
        : Response.json({ deleted: true });
    },
  }), /could not stage the video \(HTTP 502\)/);
  assert.deepEqual(methods, ["PUT", "DELETE"]);
});

test("range reader requests and validates exact bounded byte ranges", async () => {
  let request;
  const readRange = createStagedVideoRangeReader({
    assetId: "asset-1",
    extension: "mp4",
    totalBytes: 20,
    callRenderer: async (value) => {
      request = value;
      return new Response(new Uint8Array([4, 5, 6]), {
        status: 206,
        headers: {
          "content-range": "bytes 3-5/20",
          "content-length": "3",
        },
      });
    },
  });
  const result = await readRange(3, 5);
  assert.equal(request.method, "GET");
  assert.equal(request.scope, "asset:read");
  assert.equal(request.path, "/assets/asset-1/mp4");
  assert.equal(request.range, "bytes=3-5");
  assert.equal(result.byteLength, 3);
  assert.deepEqual([...new Uint8Array(await new Response(result.body).arrayBuffer())], [4, 5, 6]);
});

test("range reader rejects incorrect range metadata and oversized requests", async () => {
  const readRange = createStagedVideoRangeReader({
    assetId: "asset-1",
    extension: "mp4",
    totalBytes: 20,
    callRenderer: async () => new Response(new Uint8Array([1, 2]), {
      status: 206,
      headers: { "content-range": "bytes 0-2/20", "content-length": "2" },
    }),
  });
  await assert.rejects(readRange(0, 2), /invalid staged video range/);
  await assert.rejects(readRange(0, 9 * 1024 * 1024), /invalid/);
});


test("staged video cleanup uses the dedicated scoped DELETE route", async () => {
  const { deleteStagedVideoAsset } = await import("./staged-video.mjs");
  let request;
  await deleteStagedVideoAsset({
    assetId: "asset-1",
    extension: "mp4",
    callRenderer: async (value) => {
      request = value;
      return Response.json({ deleted: true });
    },
  });
  assert.deepEqual(request, {
    method: "DELETE",
    scope: "asset:delete",
    path: "/assets/asset-1/mp4",
  });
});


test("rejects staged asset identifiers that could escape the renderer route", async () => {
  let called = false;
  await assert.rejects(stageVideoSource({
    assetId: "../outside",
    source: new Response(new Uint8Array([1])),
    mimeType: "video/mp4",
    callRenderer: async () => { called = true; return Response.json({}); },
  }), /readable video source and private renderer/);
  assert.equal(called, false);
});


test("rejects a declared oversized source before contacting private staging", async () => {
  let called = false;
  const source = new Response(new Uint8Array([1]), {
    headers: { "content-length": String(MAX_STAGED_VIDEO_BYTES + 1) },
  });
  await assert.rejects(stageVideoSource({
    source,
    mimeType: "video/mp4",
    callRenderer: async () => { called = true; return Response.json({}); },
  }), /between 1 byte and 50 MiB/);
  assert.equal(called, false);
});
