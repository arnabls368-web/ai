import assert from "node:assert/strict";
import test from "node:test";
import { nextUploadOffset, uploadResumableVideo } from "./youtube-resumable.mjs";

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
  assert.equal(calls[1].headers.get("Content-Range"), "bytes */6");
  assert.equal(calls[2].headers.get("Content-Range"), "bytes 3-5/6");
  assert.deepEqual([...new Uint8Array(calls[2].body)], [40, 50, 60]);
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
  assert.equal(calls[1].headers.get("Content-Range"), "bytes */6");
  assert.equal(calls[2].body.byteLength, 6);
});

test("validates the acknowledged byte range", () => {
  assert.equal(nextUploadOffset(null, 6), 0);
  assert.equal(nextUploadOffset("bytes=0-2", 6), 3);
  assert.throws(() => nextUploadOffset("bytes=2-4", 6), /invalid resumable-upload range/);
  assert.throws(() => nextUploadOffset("bytes=0-6", 6), /out-of-range/);
});
