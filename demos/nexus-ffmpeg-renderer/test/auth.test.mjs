import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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

test("signing rejects invalid identity and excessive token lifetime", () => {
  assert.throws(() => signRenderToken({ secret: SECRET, tenantId: "../tenant", projectId: "p", scope: "render:read" }));
  assert.throws(() => signRenderToken({ secret: SECRET, tenantId: "t", projectId: "p", scope: "render:read", ttlSeconds: 301 }));
});
