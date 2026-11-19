import test from "node:test";
import assert from "node:assert/strict";
import { createFalRecoveryToken, verifyFalRecoveryToken } from "./fal-recovery-token.mjs";

const apiKey = "test-fal-secret-key";
const scopeA = "a".repeat(64);
const scopeB = "b".repeat(64);
const endpointId = "blackforestlabs/flux-3-max/text-to-video";
const requestId = "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b";
const now = Math.floor(Date.now() / 1000);

test("creates and verifies a recovery token for the exact account and fal job", async () => {
  const token = await createFalRecoveryToken(apiKey, scopeA, endpointId, requestId, now + 3600);
  assert.match(token, /^v1\.1800003600\.[0-9a-f]{64}$/);
  assert.equal(await verifyFalRecoveryToken(apiKey, scopeA, endpointId, requestId, token, now), true);
});

test("rejects recovery tokens for another account, endpoint, or request", async () => {
  const token = await createFalRecoveryToken(apiKey, scopeA, endpointId, requestId, now + 3600);
  assert.equal(await verifyFalRecoveryToken(apiKey, scopeB, endpointId, requestId, token, now), false);
  assert.equal(await verifyFalRecoveryToken(apiKey, scopeA, "fal-ai/other-model", requestId, token, now), false);
  assert.equal(await verifyFalRecoveryToken(apiKey, scopeA, endpointId, "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a70", token, now), false);
  assert.equal(await verifyFalRecoveryToken("different-secret", scopeA, endpointId, requestId, token, now), false);
});

test("rejects expired, malformed, and overlong recovery tokens", async () => {
  const expired = await createFalRecoveryToken(apiKey, scopeA, endpointId, requestId, now + 60);
  assert.equal(await verifyFalRecoveryToken(apiKey, scopeA, endpointId, requestId, expired, now + 60), false);
  for (const token of ["", "v2.1800003600." + "a".repeat(64), "v1.1800003600.bad", "x".repeat(257), null]) {
    assert.equal(await verifyFalRecoveryToken(apiKey, scopeA, endpointId, requestId, token, now), false);
  }
});

test("rejects invalid identities and recovery-token expiry windows", async () => {
  await assert.rejects(createFalRecoveryToken(apiKey, "not-a-scope", endpointId, requestId, now + 60));
  await assert.rejects(createFalRecoveryToken(apiKey, scopeA, "../attacker", requestId, now + 60));
  await assert.rejects(createFalRecoveryToken(apiKey, scopeA, endpointId, requestId, now + 60 * 60 * 24 * 8));
});
