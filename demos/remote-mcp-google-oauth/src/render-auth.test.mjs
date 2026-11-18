import assert from "node:assert/strict";
import test from "node:test";
import { callPrivateRenderer } from "./render-auth.ts";

const secret = "test-render-signing-secret-that-is-at-least-32-characters";

test("private renderer forwards a readable asset stream without buffering it", async () => {
  const originalFetch = globalThis.fetch;
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  let captured;
  try {
    globalThis.fetch = async (_url, init) => {
      captured = init;
      return new Response(null, { status: 201 });
    };
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await callPrivateRenderer({
      baseUrl: "https://renderer.example",
      secret,
      tenantId: "tenant",
      projectId: "project",
      scope: "asset:write",
      path: "/assets/scene-1",
      method: "PUT",
      rawBody: body,
      contentType: "image/png",
    });
    assert.equal(response.status, 201);
    assert.equal(captured.method, "PUT");
    assert.equal(captured.body, body);
    assert.equal(captured.headers.get("content-type"), "image/png");
    assert.equal(captured.headers.get("authorization")?.startsWith("Bearer "), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
