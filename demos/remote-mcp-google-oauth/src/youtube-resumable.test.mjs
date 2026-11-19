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

test("does not query or retry a YouTube session when the private range reader fails", async () => {
  let requests = 0;
  await assert.rejects(uploadResumableVideoFromRanges({
    uploadUrl: "https://www.googleapis.com/upload/session",
    totalBytes: 300 * 1024,
    mimeType: "video/mp4",
    accessToken: "test-token",
    chunkBytes: 256 * 1024,
    readRange: async () => { throw new Error("private staging unavailable"); },
    fetchImpl: async () => { requests += 1; return new Response(null, { status: 308 }); },
  }), /private staging unavailable/);
  assert.equal(requests, 0);
});


test("buffers only the requested bounded stream range before a resumable PUT", async () => {
  const expected = new Uint8Array([1, 2, 3, 4, 5]);
  let sent;
  const response = await uploadResumableVideoFromRanges({
    uploadUrl: "https://www.googleapis.com/upload/session",
    totalBytes: expected.byteLength,
    mimeType: "video/mp4",
    accessToken: "test-token",
    chunkBytes: 256 * 1024,
    readRange: async (start, end) => ({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(expected.slice(start, Math.min(end + 1, 2)));
          controller.enqueue(expected.slice(Math.min(end + 1, 2), end + 1));
          controller.close();
        },
      }),
      byteLength: end - start + 1,
    }),
    fetchImpl: async (_url, init) => {
      sent = init.body;
      return new Response(JSON.stringify({ id: "video-id" }), { status: 201 });
    },
  });
  assert.equal(response.status, 201);
  assert.ok(sent instanceof Uint8Array);
  assert.deepEqual([...sent], [1, 2, 3, 4, 5]);
});



test("releases a malformed 308 response body when range validation fails", async () => {
  let canceled = false;
  await assert.rejects(uploadResumableVideoFromRanges({
    uploadUrl: "https://www.googleapis.com/upload/session",
    totalBytes: 300 * 1024,
    mimeType: "video/mp4",
    accessToken: "test-token",
    chunkBytes: 256 * 1024,
    readRange: async (start, end) => ({
      body: new Uint8Array(end - start + 1),
      byteLength: end - start + 1,
    }),
    fetchImpl: async () => new Response(new ReadableStream({
      cancel() { canceled = true; },
    }), {
      status: 308,
      headers: { Range: "bytes=1-10" },
    }),
  }), /invalid resumable-upload range/);
  assert.equal(canceled, true);
});

test("rejects a server acknowledgement beyond the submitted staged chunk", async () => {
  const totalBytes = 600 * 1024;
  await assert.rejects(uploadResumableVideoFromRanges({
    uploadUrl: "https://www.googleapis.com/upload/session",
    totalBytes,
    mimeType: "video/mp4",
    accessToken: "test-token",
    chunkBytes: 256 * 1024,
    readRange: async (start, end) => ({
      body: new Uint8Array(end - start + 1),
      byteLength: end - start + 1,
    }),
    fetchImpl: async () => new Response(null, {
      status: 308,
      headers: { Range: "bytes=0-524287" },
    }),
  }), /acknowledged bytes beyond the submitted chunk/);
});


test("rejects resumable session progress that moves backwards after a partial chunk", async () => {
  const totalBytes = 600 * 1024;
  let uploadCalls = 0;
  await assert.rejects(uploadResumableVideoFromRanges({
    uploadUrl: "https://www.googleapis.com/upload/session",
    totalBytes,
    mimeType: "video/mp4",
    accessToken: "test-token",
    chunkBytes: 256 * 1024,
    readRange: async (start, end) => ({
      body: new Uint8Array(end - start + 1),
      byteLength: end - start + 1,
    }),
    fetchImpl: async (_url, init) => {
      if (new Headers(init.headers).get("Content-Range") === "bytes */" + totalBytes) {
        return new Response(null, {
          status: 308,
          headers: { Range: "bytes=0-0" },
        });
      }
      uploadCalls += 1;
      if (uploadCalls === 1) {
        return new Response(null, {
          status: 308,
          headers: { Range: "bytes=0-262143" },
        });
      }
      throw new Error("connection reset");
    },
  }), /progress moved backwards/);
});

test("status-checks an existing upload session before resuming with a refreshed token", async () => {
  const totalBytes = 600 * 1024;
  const calls = [];
  const requested = [];
  const response = await uploadResumableVideoFromRanges({
    uploadUrl: "https://www.googleapis.com/upload/session",
    totalBytes,
    mimeType: "video/mp4",
    accessToken: "refreshed-token",
    checkStatusFirst: true,
    chunkBytes: 256 * 1024,
    readRange: async (start, end) => {
      requested.push([start, end]);
      return { body: new Uint8Array(end - start + 1), byteLength: end - start + 1 };
    },
    fetchImpl: async (_url, init) => {
      calls.push(init);
      if (calls.length === 1) {
        assert.equal(new Headers(init.headers).get("Authorization"), "Bearer refreshed-token");
        assert.equal(new Headers(init.headers).get("Content-Range"), `bytes */${totalBytes}`);
        return new Response(null, { status: 308, headers: { Range: "bytes=0-524287" } });
      }
      return new Response(JSON.stringify({ id: "video-id" }), { status: 201 });
    },
  });
  assert.equal(response.status, 201);
  assert.equal(calls.length, 2);
  assert.deepEqual(requested, [[524288, totalBytes - 1]]);
  assert.equal(calls[1].headers.get("Content-Range"), `bytes 524288-${totalBytes - 1}/${totalBytes}`);
});

