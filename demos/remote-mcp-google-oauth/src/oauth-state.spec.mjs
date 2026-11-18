import assert from "node:assert/strict";
import test from "node:test";
import { bindStateToSession, createOAuthState, validateOAuthState } from "./workers-oauth-utils.ts";

function createKv() {
  const values = new Map();
  return {
    values,
    async put(key, value) { values.set(key, value); },
    async get(key) { return values.get(key) ?? null; },
    async delete(key) { values.delete(key); },
  };
}

const authRequest = {
  clientId: "client-123",
  redirectUri: "https://client.example/callback",
  scope: "openid email",
  state: "client-state",
};

test("OAuth state is accepted only with its browser-bound cookie and is consumed once", async () => {
  const kv = createKv();
  const { stateToken } = await createOAuthState(authRequest, kv);
  const { setCookie } = await bindStateToSession(stateToken);
  const cookie = setCookie.split(";")[0];

  const request = new Request("https://worker.example/callback?state=" + encodeURIComponent(stateToken), {
    headers: { Cookie: cookie },
  });
  const result = await validateOAuthState(request, kv);

  assert.deepEqual(result.oauthReqInfo, authRequest);
  assert.match(result.clearCookie, /Max-Age=0/);
  assert.equal(kv.values.has("oauth:state:" + stateToken), false);
  await assert.rejects(validateOAuthState(request, kv), /Invalid or expired state/);
});

test("OAuth state rejects a missing or mismatched browser binding", async () => {
  const kv = createKv();
  const { stateToken } = await createOAuthState(authRequest, kv);
  const { setCookie } = await bindStateToSession(stateToken);
  const cookie = setCookie.split(";")[0];

  const missingCookie = new Request("https://worker.example/callback?state=" + encodeURIComponent(stateToken));
  await assert.rejects(validateOAuthState(missingCookie, kv), /Missing session binding cookie/);

  const mismatchedCookie = new Request("https://worker.example/callback?state=" + encodeURIComponent(stateToken), {
    headers: { Cookie: cookie.replace(/=[^=]+$/, "=not-the-state-hash") },
  });
  await assert.rejects(validateOAuthState(mismatchedCookie, kv), /does not match session/);
});

test("OAuth state rejects absent and expired state parameters", async () => {
  const kv = createKv();
  await assert.rejects(
    validateOAuthState(new Request("https://worker.example/callback"), kv),
    /Missing state parameter/,
  );
  await assert.rejects(
    validateOAuthState(new Request("https://worker.example/callback?state=unknown"), kv),
    /Invalid or expired state/,
  );
});
