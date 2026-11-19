import assert from "node:assert/strict";
import test from "node:test";
import { MAX_VIDEO_BYTES, readVideoBodyBounded } from "./read-video-body.mjs";

test("fills one exact-size buffer when Content-Length is available", async () => {
  const source = Uint8Array.from([10, 20, 30, 40, 50, 60]);
  const result = await readVideoBodyBounded(new Response(source, {
    headers: { "Content-Length": String(source.byteLength) },
  }));
  assert.ok(result instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(result)], [...source]);
});

test("rejects a body shorter than its declared Content-Length", async () => {
  const response = new Response(Uint8Array.from([1, 2, 3]), {
    headers: { "Content-Length": "4" },
  });
  await assert.rejects(readVideoBodyBounded(response), /did not match its declared Content-Length/);
});

test("rejects a body longer than its declared Content-Length", async () => {
  const response = new Response(Uint8Array.from([1, 2, 3]), {
    headers: { "Content-Length": "2" },
  });
  await assert.rejects(readVideoBodyBounded(response), /exceeded its declared Content-Length/);
});

test("keeps chunked responses bounded and reads them correctly", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2]));
      controller.enqueue(Uint8Array.from([3, 4]));
      controller.close();
    },
  });
  const result = await readVideoBodyBounded(new Response(body));
  assert.deepEqual([...new Uint8Array(result)], [1, 2, 3, 4]);
});

test("rejects declared and actual sizes over the configured limit", async () => {
  const oversized = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_VIDEO_BYTES + 1));
      controller.close();
    },
  }));
  await assert.rejects(readVideoBodyBounded(oversized), /50 MB limit/);

  const declaredOversized = new Response(new ReadableStream(), {
    headers: { "Content-Length": String(MAX_VIDEO_BYTES + 1) },
  });
  await assert.rejects(readVideoBodyBounded(declaredOversized), /50 MB limit/);
});

test("rejects empty video bodies", async () => {
  await assert.rejects(readVideoBodyBounded(new Response(new Uint8Array())), /must not be empty/);
});
