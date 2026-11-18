import assert from "node:assert/strict";
import test from "node:test";
import { bindStateToSession, createOAuthState, validateOAuthState } from "./workers-oauth-utils.ts";

function createStateStore() {
  const values = new Map();
  return {
    values,
    expire(id) {
      const record = values.get(id);
      if (record) record.expiresAt = 0;
    },
    idFromName(name) { return name; },
    get(id) {
      return {
        async fetch(input, init = {}) {
          const path = new URL(input).pathname;
          if (path === "/store" && init.method === "POST") {
            const body = JSON.parse(init.body);
            values.set(id, { value: body.value, expiresAt: body.expiresAt });
            return Response.json({ stored: true }, { status: 201 });
          }
          if (path === "/consume" && init.method === "POST") {
            // No await between read and delete: models the DO's atomic consume.
            const record = values.get(id);
            values.delete(id);
            if (!record || record.expiresAt <= Date.now()) {
              return Response.json({ value: null }, { status: 404 });
            }
            return Response.json({ value: record.value });
          }
          return new Response("not found", { status: 404 });
        },
      };
    },
  };
}

const authRequest = {
  clientId: "client-123",
  redirectUri: "https://client.example/callback",
  scope: "openid email",
  state: "client-state",
};

function callbackRequest(stateToken, cookie) {
  return new Request("https://worker.example/callback?state=" + encodeURIComponent(stateToken), {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

test("OAuth state requires its browser binding and is consumed once", async () => {
  const store = createStateStore();
  const { stateToken } = await createOAuthState(authRequest, store);
  const { setCookie } = await bindStateToSession(stateToken);
  const cookie = setCookie.split(";")[0];

  const result = await validateOAuthState(callbackRequest(stateToken, cookie), store);
  assert.deepEqual(result.oauthReqInfo, authRequest);
  assert.match(result.clearCookie, /Max-Age=0/);
  assert.equal(store.values.has(stateToken), false);
  await assert.rejects(validateOAuthState(callbackRequest(stateToken, cookie), store), /Invalid or expired state/);
});

test("OAuth state rejects missing and mismatched browser bindings without consuming state", async () => {
  const store = createStateStore();
  const { stateToken } = await createOAuthState(authRequest, store);
  const { setCookie } = await bindStateToSession(stateToken);
  const cookie = setCookie.split(";")[0];

  await assert.rejects(validateOAuthState(callbackRequest(stateToken), store), /Missing session binding cookie/);
  await assert.rejects(
    validateOAuthState(callbackRequest(stateToken, cookie.replace(/=[^=]+$/, "=not-the-state-hash")), store),
    /does not match session/,
  );
  assert.equal(store.values.has(stateToken), true);
});

test("OAuth state rejects absent, malformed, unknown and expired state", async () => {
  const store = createStateStore();
  await assert.rejects(validateOAuthState(new Request("https://worker.example/callback"), store), /Missing or invalid state parameter/);
  await assert.rejects(validateOAuthState(callbackRequest("not-a-uuid", ""), store), /Missing or invalid state parameter/);
  await assert.rejects(validateOAuthState(callbackRequest("00000000-0000-4000-8000-000000000000", ""), store), /Missing session binding cookie/);

  const { stateToken } = await createOAuthState(authRequest, store);
  store.expire(stateToken);
  const { setCookie } = await bindStateToSession(stateToken);
  await assert.rejects(
    validateOAuthState(callbackRequest(stateToken, setCookie.split(";")[0]), store),
    /Invalid or expired state/,
  );
});

test("concurrent OAuth callbacks can consume a state only once", async () => {
  const store = createStateStore();
  const { stateToken } = await createOAuthState(authRequest, store);
  const { setCookie } = await bindStateToSession(stateToken);
  const request = callbackRequest(stateToken, setCookie.split(";")[0]);

  const results = await Promise.allSettled([
    validateOAuthState(request, store),
    validateOAuthState(request, store),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.match(rejected.reason.message, /Invalid or expired state/);
});
