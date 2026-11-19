import assert from "node:assert/strict";
import test from "node:test";
import { signAuthorizationState, verifyAuthorizationState } from "./authorization-state.mjs";

const secret = "test-cookie-encryption-secret-with-sufficient-entropy";

test("OAuth approval state round-trips and preserves Unicode request metadata", async () => {
  const original = {
    oauthReqInfo: {
      clientId: "client-123",
      redirectUri: "https://client.example/callback",
      scope: "openid email",
      clientName: "NEXUS – 東京 🚀",
    },
  };
  const encoded = await signAuthorizationState(original, secret);
  assert.deepEqual(await verifyAuthorizationState(encoded, secret), original);
});

test("OAuth approval state rejects a modified payload", async () => {
  const encoded = await signAuthorizationState({
    oauthReqInfo: { clientId: "approved-client", redirectUri: "https://client.example/callback" },
  }, secret);
  const [signature, payload] = encoded.split(".");
  const decoded = JSON.parse(atob(payload));
  decoded.oauthReqInfo.clientId = "attacker-client";
  const modifiedPayload = btoa(JSON.stringify(decoded));
  assert.equal(await verifyAuthorizationState(signature + "." + modifiedPayload, secret), null);
});

test("OAuth approval state rejects wrong secrets and malformed encodings", async () => {
  const encoded = await signAuthorizationState({ oauthReqInfo: { clientId: "client-123" } }, secret);
  assert.equal(await verifyAuthorizationState(encoded, "different-secret"), null);
  assert.equal(await verifyAuthorizationState("not-a-signature.not-base64", secret), null);
  assert.equal(await verifyAuthorizationState("a".repeat(44_001), secret), null);
  assert.equal(await verifyAuthorizationState("00.".concat(btoa("{}")), secret), null);
});

test("OAuth approval state refuses oversized payloads", async () => {
  await assert.rejects(
    signAuthorizationState({ value: "x".repeat(32_769) }, secret),
    /too large/,
  );
});
