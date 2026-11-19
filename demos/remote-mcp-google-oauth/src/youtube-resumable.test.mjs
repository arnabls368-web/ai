import assert from "node:assert/strict";
import test from "node:test";
import { nextUploadOffset, uploadResumableVideo, uploadResumableVideoFromRanges } from "./youtube-resumable.mjs";

const bytes = Uint8Array.from([10, 20, 30, 40, 50, 60]).buffer;

test("uploads the complete video in one request when the session succeeds", async () => {
  const calls = [];
  const response = await uploadResumableVideo({
    uploadUrl: "https://www.googleapis.com/upload/session",
    videoBytes: bytes,
    mimeType: "video/mp4",
    accessToken: "test-token",
    fetchImpl: async (_url, init) => {
      calls.push(init);
      return new Response(JSON.stringify({ id: "video-id" }), { status: 201 });
    },
  });
  assert.equal(response.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.byteLength, 6);
  assert.equal(calls[0].body.buffer, bytes, "the upload body should view the original buffer without copying");
  assert.equal(calls[0].headers.get("Content-Range"), null);
});

test("checks session progress after a lost response and resumes only remaining bytes", async () => {
  const calls = [];
  const response = await uploadResumableVideo({
    uploadUrl: "https://www.googleapis.com/upload/session",
    videoBytes: bytes,
    mimeType: "video/mp4",
    accessToken: "test-token",
    fetchImpl: async (_url, init) => {
      calls.push(init);
      if (calls.length === 1) throw new Error("connection reset");
      if (calls.length === 2) {
        return new Response(null, { status: 308, headers: { Range: "bytes=0-2" } });
      }
      return new Response(JSON.stringify({ id: "video-id" }), { status: 201 });
    },
  });
  assert.equal(response.status, 201);
  assert.equal(calls.length, 3);
  assert.equal(new Headers(calls[1].headers).get("Content-Range"), "bytes */6");
  assert.equal(calls[2].headers.get("Content-Range"), "bytes 3-5/6");
  assert.deepEqual([...calls[2].body], [40, 50, 60]);
  assert.equal(calls[2].body.buffer, bytes, "resumed uploads should view the original buffer without copying");
});

test("checks session progress after a server error before retrying", async () => {
  const calls = [];
  const response = await uploadResumableVideo({
    uploadUrl: "https://www.googleapis.com/upload/session",
    videoBytes: bytes,
    mimeType: "video/mp4",
    accessToken: "test-token",
    fetchImpl: async (_url, init) => {
      calls.push(init);
      if (calls.length === 1) return new Response("temporary", { status: 503 });
      if (calls.length === 2) return new Response(null, { status: 308 });
      return new Response(JSON.stringify({ id: "video-id" }), { status: 201 });
    },
  });
  assert.equal(response.status, 201);
  assert.equal(calls.length, 3);
  assert.equal(new Headers(calls[1].headers).get("Content-Range"), "bytes */6");
  assert.equal(calls[2].body.byteLength, 6);
});

test("validates the acknowledged byte range", () => {
  assert.equal(nextUploadOffset(null, 6), 0);
  assert.equal(nextUploadOffset("bytes=0-2", 6), 3);
  assert.throws(() => nextUploadOffset("bytes=2-4", 6), /invalid resumable-upload range/);
  assert.throws(() => nextUploadOffset("bytes=0-6", 6), /out-of-range/);
});


test("uploads staged videos as aligned bounded byte ranges", async () => {
  const totalBytes = 300 * 1024;
  const calls = [];
  const requested = [];
  const response = await uploadResumableVideoFromRanges({
    uploadUrl: "https://www.googleapis.com/upload/session",
    totalBytes,
    mimeType: "video/mp4",
    accessToken: "test-token",
    chunkBytes: 256 * 1024,
    readRange: async (start, end) => {
      requested.push([start, end]);
      const bytes = new Uint8Array(end - start + 1);
      bytes.fill(start === 0 ? 1 : 2);
      return { body: bytes, byteLength: bytes.byteLength };
    },
    fetchImpl: async (_url, init) => {
      calls.push(init);
      if (calls.length === 1) {
        return new Response(null, { status: 308, headers: { Range: "bytes=0-262143" } });
      }
      return new Response(JSON.stringify({ id: "video-id" }), { status: 201 });
    },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(requested, [[0, 262143], [262144, totalBytes - 1]]);
  assert.equal(calls[0].headers.get("Content-Range"), `bytes 0-262143/${totalBytes}`);
  assert.equal(calls[1].headers.get("Content-Range"), `bytes 262144-${totalBytes - 1}/${totalBytes}`);
  assert.equal(calls[0].body.byteLength, 256 * 1024);
  assert.equal(calls[1].body.byteLength, totalBytes - 256 * 1024);
});

test("re-reads staged ranges after interrupted chunk uploads and status checks", async () => {
  const totalBytes = 300 * 1024;
  const calls = [];
  const requested = [];
  const response = await uploadResumableVideoFromRanges({
    uploadUrl: "https://www.googleapis.com/upload/session",
    totalBytes,
    mimeType: "video/mp4",
    accessToken: "test-token",
    chunkBytes: 512 * 1024,
    readRange: async (start, end) => {
      requested.push([start, end]);
      return { body: new Uint8Array(end - start + 1), byteLength: end - start + 1 };
    },
    fetchImpl: async (_url, init) => {
      calls.push(init);
      if (calls.length === 1) throw new Error("connection reset");
      if (calls.length === 2) return new Response(null, { status: 308, headers: { Range: "bytes=0-9999" } });
      return new Response(JSON.stringify({ id: "video-id" }), { status: 201 });
    },
  });
  assert.equal(response.status, 201);
  assert.equal(calls.length, 3);
  assert.equal(new Headers(calls[1].headers).get("Content-Range"), `bytes */${totalBytes}`);
  assert.deepEqual(requested, [[0, totalBytes - 1], [10000, totalBytes - 1]]);
  assert.equal(calls[2].headers.get("Content-Range"), `bytes 10000-${totalBytes - 1}/${totalBytes}`);
});

test("rejects invalid staged range sizes and non-aligned chunk configuration", async () => {
  await assert.rejects(uploadResumableVideoFromRanges({
    uploadUrl: "https://www.googleapis.com/upload/session",
    totalBytes: 10,
    mimeType: "video/mp4",
    accessToken: "test-token",
    readRange: async () => ({ body: new Uint8Array(1), byteLength: 1 }),
    chunkBytes: 1000,
  }), /256 KiB multiples/);
  await assert.rejects(uploadResumableVideoFromRanges({
    uploadUrl: "https://www.googleapis.com/upload/session",
    totalBytes: 10,
    mimeType: "video/mp4",
    accessToken: "test-token",
    readRange: async () => ({ body: new Uint8Array(1), byteLength: 1 }),
    chunkBytes: 256 * 1024,
  }), /invalid body or byte length/);
});
