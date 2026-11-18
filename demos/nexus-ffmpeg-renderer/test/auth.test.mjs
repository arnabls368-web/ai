import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import { signRenderToken, verifyRenderToken } from "../src/auth.mjs";

const SECRET = "unit-test-render-signing-secret-at-least-32";

test("signed render tokens bind tenant, project, audience and scope", () => {
  const token = signRenderToken({
    secret: SECRET,
    tenantId: "tenant-a",
    projectId: "project-7",
    scope: "render:submit",
    now: 1_800_000_000_000,
  });
  const claims = verifyRenderToken(token, {
    secret: SECRET,
    scope: "render:submit",
    now: 1_800_000_010_000,
  });
  assert.equal(claims.tenantId, "tenant-a");
  assert.equal(claims.projectId, "project-7");
  assert.equal(verifyRenderToken(token, { secret: SECRET, scope: "render:read", now: 1_800_000_010_000 }), null);
});

test("signed render tokens reject tampering, expiry and wrong secrets", () => {
  const now = 1_800_000_000_000;
  const token = signRenderToken({ secret: SECRET, tenantId: "tenant-a", projectId: "project-7", scope: "render:read", ttlSeconds: 30, now });
  assert.equal(verifyRenderToken(token + "x", { secret: SECRET, now: now + 1_000 }), null);
  assert.equal(verifyRenderToken(token, { secret: SECRET + "wrong", now: now + 1_000 }), null);
  assert.equal(verifyRenderToken(token, { secret: SECRET, now: now + 31_000 }), null);
});

test("verification rejects tokens whose expiry is not after issuance", () => {
  const now = 1_800_000_000_000;
  const claims = {
    aud: "nexus-renderer",
    tenantId: "tenant-a",
    projectId: "project-7",
    scope: "render:read",
    iat: Math.floor(now / 1000) + 20,
    exp: Math.floor(now / 1000) + 10,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", SECRET).update(payload).digest("base64url");
  assert.equal(verifyRenderToken(`${payload}.${signature}`, { secret: SECRET, now }), null);
});


test("renderer verifier accepts a Web Crypto HMAC token from the Worker runtime", async () => {
  const now = 1_800_000_000_000;
  const claims = {
    aud: "nexus-renderer",
    tenantId: "tenant-worker",
    projectId: "project-worker",
    scope: "render:read",
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 120,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(claims));
  const payload = Buffer.from(bytes).toString("base64url");
  const key = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await webcrypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const token = `${payload}.${Buffer.from(mac).toString("base64url")}`;
  const verified = verifyRenderToken(token, { secret: SECRET, scope: "render:read", now });
  assert.equal(verified?.tenantId, "tenant-worker");
  assert.equal(verified?.projectId, "project-worker");
});

test("signing rejects invalid identity and excessive token lifetime", () => {
  assert.throws(() => signRenderToken({ secret: SECRET, tenantId: "../tenant", projectId: "p", scope: "render:read" }));
  assert.throws(() => signRenderToken({ secret: SECRET, tenantId: "t", projectId: "p", scope: "render:read", ttlSeconds: 301 }));
});
