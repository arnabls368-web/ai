import assert from "node:assert/strict";
import test from "node:test";
import { createRenderAuthorizationToken, callPrivateRenderer } from "./render-auth.ts";
import { verifyRenderToken } from "../../nexus-ffmpeg-renderer/src/auth.mjs";

const secret = "test-render-signing-secret-that-is-at-least-32-characters";
const now = 1_800_000_000_000;

test("Worker-issued render token is accepted by the renderer verifier", async () => {
  const token = await createRenderAuthorizationToken({
    secret,
    tenantId: "tenant-123",
    projectId: "project-456",
    scope: "render:read",
    ttlSeconds: 120,
    now,
  });
  const claims = verifyRenderToken(token, { secret, scope: "render:read", now });
  assert.deepEqual(
    { aud: claims.aud, tenantId: claims.tenantId, projectId: claims.projectId, scope: claims.scope, iat: claims.iat, exp: claims.exp },
    {
      aud: "nexus-renderer",
      tenantId: "tenant-123",
      projectId: "project-456",
      scope: "render:read",
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 120,
    },
  );
});

test("render authorization rejects weak secrets, malformed identities, scopes and lifetimes", async () => {
  const base = { secret, tenantId: "tenant", projectId: "project", scope: "render:read" };
  await assert.rejects(createRenderAuthorizationToken({ ...base, secret: "short" }), /at least 32 characters/);
  await assert.rejects(createRenderAuthorizationToken({ ...base, tenantId: "../tenant" }), /valid tenant and project/);
  await assert.rejects(createRenderAuthorizationToken({ ...base, scope: "admin" }), /Unsupported renderer authorization scope/);
  await assert.rejects(createRenderAuthorizationToken({ ...base, ttlSeconds: 301 }), /between 1 and 300 seconds/);
});

test("private renderer calls reject insecure bases, traversal and scope-method mismatches", async () => {
  const base = {
    baseUrl: "https://renderer.example",
    secret,
    tenantId: "tenant",
    projectId: "project",
    scope: "render:read",
    path: "/jobs/123/output",
  };
  await assert.rejects(callPrivateRenderer({ ...base, baseUrl: "http://renderer.example" }), /clean HTTPS base URL/);
  await assert.rejects(callPrivateRenderer({ ...base, path: "/jobs/../secret" }), /Invalid private renderer path/);
  await assert.rejects(callPrivateRenderer({ ...base, method: "POST" }), /method or body does not match/);
});


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
