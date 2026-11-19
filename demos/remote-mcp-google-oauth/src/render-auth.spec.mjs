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


test("private asset range reads use a dedicated signed scope and Range header", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  try {
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init };
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 206,
        headers: { "content-range": "bytes 0-3/10", "content-length": "4" },
      });
    };
    const response = await callPrivateRenderer({
      baseUrl: "https://renderer.example",
      secret,
      tenantId: "tenant",
      projectId: "project",
      scope: "asset:read",
      path: "/assets/asset-123/mp4",
      method: "GET",
      range: "bytes=0-3",
    });
    assert.equal(response.status, 206);
    assert.equal(captured.url, "https://renderer.example/assets/asset-123/mp4");
    assert.equal(captured.init.headers.get("range"), "bytes=0-3");
    const token = captured.init.headers.get("authorization").slice("Bearer ".length);
    const claims = verifyRenderToken(token, { secret, scope: "asset:read" });
    assert.equal(claims.projectId, "project");
    assert.equal(claims.tenantId, "tenant");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("private asset range reads reject malformed range headers before network access", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  try {
    globalThis.fetch = async () => { called = true; return new Response(null); };
    await assert.rejects(callPrivateRenderer({
      baseUrl: "https://renderer.example",
      secret,
      tenantId: "tenant",
      projectId: "project",
      scope: "asset:read",
      path: "/assets/asset-123/mp4",
      method: "GET",
      range: "bytes=0-3,5-8",
    }), /method or body does not match/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("private staged-object cleanup uses a dedicated signed deletion scope", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  try {
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init };
      return Response.json({ deleted: true });
    };
    const response = await callPrivateRenderer({
      baseUrl: "https://renderer.example",
      secret,
      tenantId: "tenant",
      projectId: "project",
      scope: "asset:delete",
      path: "/assets/asset-123/mp4",
      method: "DELETE",
    });
    assert.equal(response.status, 200);
    assert.equal(captured.init.method, "DELETE");
    const token = captured.init.headers.get("authorization").slice("Bearer ".length);
    const claims = verifyRenderToken(token, { secret, scope: "asset:delete" });
    assert.equal(claims.projectId, "project");
    assert.equal(claims.tenantId, "tenant");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("asset deletion rejects mismatched scopes and request shapes before network access", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  try {
    globalThis.fetch = async () => { called = true; return new Response(null); };
    await assert.rejects(callPrivateRenderer({
      baseUrl: "https://renderer.example",
      secret,
      tenantId: "tenant",
      projectId: "project",
      scope: "asset:read",
      path: "/assets/asset-123/mp4",
      method: "DELETE",
    }), /method or body does not match/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
