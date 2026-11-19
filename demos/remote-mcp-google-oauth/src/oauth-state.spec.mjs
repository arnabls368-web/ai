import assert from "node:assert/strict";
import test from "node:test";
import { bindStateToSession, createOAuthState, validateOAuthState } from "./workers-oauth-utils.ts";
import { OAuthStateDO } from "./oauth-state-do.ts";

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
  const unknownToken = "00000000-0000-4000-8000-000000000000";
  const { setCookie: unknownCookie } = await bindStateToSession(unknownToken);
  await assert.rejects(validateOAuthState(callbackRequest(unknownToken, unknownCookie.split(";")[0]), store), /Invalid or expired state/);

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

test("Durable Object storage transaction enforces one-time consumption under concurrency", async () => {
  const values = new Map();
  let transactionTail = Promise.resolve();
  let alarmAt = null;
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async delete(key) { return values.delete(key); },
    async setAlarm(value) { alarmAt = value; },
    transaction(callback) {
      const result = transactionTail.then(() => callback({
        get: async (key) => values.get(key),
        put: async (key, value) => values.set(key, value),
        delete: async (key) => values.delete(key),
      }));
      transactionTail = result.catch(() => {});
      return result;
    },
  };
  const durableObject = new OAuthStateDO({ storage });
  const expiresAt = Date.now() + 60_000;
  const stored = await durableObject.fetch(new Request("https://do.example/store", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(authRequest), expiresAt }),
  }));
  assert.equal(stored.status, 201);
  assert.equal(alarmAt, expiresAt);
  const duplicate = await durableObject.fetch(new Request("https://do.example/store", {
    method: "POST",
    body: JSON.stringify({ value: JSON.stringify(authRequest), expiresAt }),
  }));
  assert.equal(duplicate.status, 409);

  const consume = () => durableObject.fetch(new Request("https://do.example/consume", { method: "POST" }));
  const responses = await Promise.all([consume(), consume()]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 404]);
  const winner = responses.find((response) => response.status === 200);
  assert.deepEqual(await winner.json(), { value: JSON.stringify(authRequest) });
  assert.equal(values.has("oauth-state"), false);
});

test("Durable Object stores once and consumes a valid state exactly once", async () => {
  const values = new Map();
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async delete(key) { return values.delete(key); },
    async setAlarm() {},
    async transaction(callback) {
      return callback({
        get: async (key) => values.get(key),
        put: async (key, value) => values.set(key, value),
        delete: async (key) => values.delete(key),
      });
    },
  };
  const durableObject = new OAuthStateDO({ storage });
  const record = { value: "one-time-state", expiresAt: Date.now() + 60_000 };
  const storeRequest = () => new Request("https://do.example/store", {
    method: "POST",
    body: JSON.stringify(record),
  });
  assert.equal((await durableObject.fetch(storeRequest())).status, 201);
  assert.equal((await durableObject.fetch(storeRequest())).status, 409);

  const firstConsume = await durableObject.fetch(new Request("https://do.example/consume", { method: "POST" }));
  assert.equal(firstConsume.status, 200);
  assert.deepEqual(await firstConsume.json(), { value: "one-time-state" });
  const replay = await durableObject.fetch(new Request("https://do.example/consume", { method: "POST" }));
  assert.equal(replay.status, 404);
  assert.deepEqual(await replay.json(), { value: null });
});

test("Durable Object consumes and deletes an expired state without returning its value", async () => {
  const values = new Map([["oauth-state", { value: "expired-state", expiresAt: Date.now() - 1 }]]);
  const storage = {
    async transaction(callback) {
      return callback({
        get: async (key) => values.get(key),
        delete: async (key) => values.delete(key),
      });
    },
  };
  const durableObject = new OAuthStateDO({ storage });
  const response = await durableObject.fetch(new Request("https://do.example/consume", { method: "POST" }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { value: null });
  assert.equal(values.has("oauth-state"), false);
});

test("Durable Object rejects malformed state records and expires abandoned state", async () => {
  const values = new Map();
  let alarmAt = null;
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async delete(key) { return values.delete(key); },
    async setAlarm(value) { alarmAt = value; },
    async transaction(callback) {
      return callback({
        get: async (key) => values.get(key),
        put: async (key, value) => values.set(key, value),
        delete: async (key) => values.delete(key),
      });
    },
  };
  const durableObject = new OAuthStateDO({ storage });
  const malformed = await durableObject.fetch(new Request("https://do.example/store", {
    method: "POST",
    body: JSON.stringify({ value: "", expiresAt: Date.now() + 60_000 }),
  }));
  assert.equal(malformed.status, 400);
  const oversized = await durableObject.fetch(new Request("https://do.example/store", {
    method: "POST",
    body: JSON.stringify({ value: "x".repeat(16_385), expiresAt: Date.now() + 60_000 }),
  }));
  assert.equal(oversized.status, 400);
  const excessiveTtl = await durableObject.fetch(new Request("https://do.example/store", {
    method: "POST",
    body: JSON.stringify({ value: "state", expiresAt: Date.now() + 601_000 }),
  }));
  assert.equal(excessiveTtl.status, 400);

  const expiredAt = Date.now() + 1_000;
  await durableObject.fetch(new Request("https://do.example/store", {
    method: "POST",
    body: JSON.stringify({ value: "expired", expiresAt: expiredAt }),
  }));
  await durableObject.alarm();
  assert.equal(values.has("oauth-state"), false);
  assert.equal(alarmAt, expiredAt);
});
