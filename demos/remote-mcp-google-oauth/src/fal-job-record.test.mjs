import test from "node:test";
import assert from "node:assert/strict";
import { loadFalJobRecord } from "./fal-job-record.mjs";

const record = {
  endpointId: "fal-ai/model/text-to-video",
  requestId: "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b",
  statusUrl: "https://queue.fal.run/fal-ai/model/requests/019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b/status",
  responseUrl: "https://queue.fal.run/fal-ai/model/requests/019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b",
  cancelUrl: "https://queue.fal.run/fal-ai/model/requests/019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b/cancel",
  createdAt: "",
};
const base = {
  key: "account-scoped-key",
  scope: "a".repeat(64),
  apiKey: "fal-secret",
  requestId: record.requestId,
  endpointId: record.endpointId,
  recoveryToken: "signed-capability",
  verifyToken: async () => true,
  recoverRecord: () => record,
};

function fakeKv({ get = async () => null, put = async () => {} } = {}) {
  const writes = [];
  return { kv: { get, put: async (...args) => { writes.push(args); return put(...args); } }, writes };
}

test("recovers a stale KV miss only with a valid account-bound token and refreshes KV", async () => {
  const { kv, writes } = fakeKv();
  const result = await loadFalJobRecord({ ...base, kv });
  assert.deepEqual(result, record);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], base.key);
  assert.equal(JSON.parse(writes[0][1]).requestId, base.requestId);
  assert.equal(writes[0][2].expirationTtl, 604800);
});

test("recovers through a KV read outage when the token verifies", async () => {
  const { kv } = fakeKv({ get: async () => { throw new Error("KV unavailable"); } });
  assert.deepEqual(await loadFalJobRecord({ ...base, kv }), record);
});

test("keeps the verified in-memory recovery usable when the KV refresh write fails", async () => {
  const { kv } = fakeKv({ put: async () => { throw new Error("KV write failed"); } });
  assert.deepEqual(await loadFalJobRecord({ ...base, kv }), record);
});

test("fails closed on a stale miss without a token and makes no KV write", async () => {
  const { kv, writes } = fakeKv();
  await assert.rejects(loadFalJobRecord({ ...base, kv, recoveryToken: undefined }), /valid account-bound recoveryToken/);
  assert.equal(writes.length, 0);
});

test("fails closed when the token belongs to another account", async () => {
  const { kv, writes } = fakeKv();
  await assert.rejects(loadFalJobRecord({ ...base, kv, verifyToken: async (_key, scope) => scope === "b".repeat(64) }), /valid account-bound recoveryToken/);
  assert.equal(writes.length, 0);
});

test("fails closed on a KV outage without a valid token", async () => {
  const { kv, writes } = fakeKv({ get: async () => { throw new Error("KV unavailable"); } });
  await assert.rejects(loadFalJobRecord({ ...base, kv, verifyToken: async () => false }), /could not read the fal.ai tracking record/);
  assert.equal(writes.length, 0);
});

test("uses an existing account-scoped KV record without requiring recovery credentials", async () => {
  const { kv, writes } = fakeKv({ get: async () => record });
  const result = await loadFalJobRecord({ ...base, kv, endpointId: undefined, recoveryToken: undefined });
  assert.deepEqual(result, record);
  assert.equal(writes.length, 0);
});

test("fails closed if token verification itself throws", async () => {
  const { kv, writes } = fakeKv();
  await assert.rejects(loadFalJobRecord({ ...base, kv, verifyToken: async () => { throw new Error("crypto unavailable"); } }), /valid account-bound recoveryToken/);
  assert.equal(writes.length, 0);
});
