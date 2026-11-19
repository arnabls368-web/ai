import test from "node:test";
import assert from "node:assert/strict";
import { recoverFalJobRecord, trustedFalUrl, validateFalJobRecord } from "./fal-provider-utils.mjs";

test("accepts HTTPS queue URLs on the two approved fal.ai queue hosts", () => {
  assert.equal(
    trustedFalUrl("https://queue.fal.run/model/request/status"),
    "https://queue.fal.run/model/request/status",
  );
  assert.equal(
    trustedFalUrl("https://queue.falrun.com/model/request/result"),
    "https://queue.falrun.com/model/request/result",
  );
});

test("rejects non-HTTPS, untrusted hosts, and lookalike hostnames", () => {
  for (const value of [
    "http://queue.fal.run/model/status",
    "https://fal.run/model/status",
    "https://queue.fal.run.attacker.example/model/status",
    "https://queue-fal.run/model/status",
    "https://127.0.0.1/model/status",
  ]) {
    assert.throws(() => trustedFalUrl(value), /unexpected queue URL/);
  }
});

test("rejects embedded credentials, explicit ports, query strings and fragments", () => {
  for (const value of [
    "https://user@queue.fal.run/model/status",
    "https://user:secret@queue.fal.run/model/status",
    "https://queue.fal.run:8443/model/status",
    "https://queue.fal.run/model/status?next=https://attacker.example",
    "https://queue.fal.run/model/status#fragment",
  ]) {
    assert.throws(() => trustedFalUrl(value), /unexpected queue URL/);
  }
});

test("rejects malformed and non-string inputs", () => {
  for (const value of ["not a URL", "", null, undefined, 42, {}, { toString: () => "https://queue.fal.run/model/status" }, "https://queue.fal.run/" + "a".repeat(2_049)]) {
    assert.throws(() => trustedFalUrl(value), /unexpected queue URL/);
  }
});

test("validates persisted fal.ai job records and normalizes trusted queue URLs", () => {
  const record = validateFalJobRecord({
    endpointId: "fal-ai/example-model",
    requestId: "4d1f2c8e-0d7b-4d6e-9a2a-1f8e2f2d6a01",
    statusUrl: "https://queue.fal.run/fal-ai/example-model/requests/4d1f2c8e-0d7b-4d6e-9a2a-1f8e2f2d6a01/status",
    responseUrl: "https://queue.fal.run/fal-ai/example-model/requests/4d1f2c8e-0d7b-4d6e-9a2a-1f8e2f2d6a01",
    cancelUrl: "https://queue.fal.run/fal-ai/example-model/requests/4d1f2c8e-0d7b-4d6e-9a2a-1f8e2f2d6a01/cancel",
    createdAt: "2026-11-19T06:00:00.000Z",
  }, "4d1f2c8e-0d7b-4d6e-9a2a-1f8e2f2d6a01");
  assert.equal(record.endpointId, "fal-ai/example-model");
  assert.equal(record.statusUrl, "https://queue.fal.run/fal-ai/example-model/requests/4d1f2c8e-0d7b-4d6e-9a2a-1f8e2f2d6a01/status");
  assert.equal(record.responseUrl, "https://queue.fal.run/fal-ai/example-model/requests/abc");
  assert.equal(record.cancelUrl, "https://queue.fal.run/fal-ai/example-model/requests/4d1f2c8e-0d7b-4d6e-9a2a-1f8e2f2d6a01/cancel");
});

test("rejects missing, mismatched, malformed, or untrusted persisted job records", () => {
  const valid = {
    endpointId: "fal-ai/example-model",
    requestId: "4d1f2c8e-0d7b-4d6e-9a2a-1f8e2f2d6a01",
    statusUrl: "https://queue.fal.run/fal-ai/example-model/requests/4d1f2c8e-0d7b-4d6e-9a2a-1f8e2f2d6a01/status",
    responseUrl: "https://queue.fal.run/fal-ai/example-model/requests/4d1f2c8e-0d7b-4d6e-9a2a-1f8e2f2d6a01",
  };
  for (const record of [
    null,
    [],
    { ...valid, requestId: "another-request" },
    { ...valid, endpointId: "https://attacker.example/steal" },
    { ...valid, endpointId: "../attacker" },
    { ...valid, endpointId: "fal-ai/" + "a".repeat(194) },
    { ...valid, statusUrl: "https://attacker.example/status" },
    { ...valid, responseUrl: "http://queue.fal.run/result" },
    { ...valid, responseUrl: "https://queue.fal.run/result?token=unexpected" },
    { ...valid, cancelUrl: "https://attacker.example/cancel" },
    { ...valid, cancelUrl: "http://queue.fal.run/cancel" },
    { ...valid, statusUrl: "https://queue.fal.run/fal-ai/example-model/requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/status" },
    { ...valid, responseUrl: "https://queue.fal.run/other-owner/other-app/requests/4d1f2c8e-0d7b-4d6e-9a2a-1f8e2f2d6a01" },
    { ...valid, statusUrl: "https://queue.fal.run/fal-ai/example-model/requests/4d1f2c8e-0d7b-4d6e-9a2a-1f8e2f2d6a01/result" },
    { ...valid, cancelUrl: "https://queue.fal.run/fal-ai/example-model/requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cancel" },
  ]) {
    assert.throws(
      () => validateFalJobRecord(record, valid.requestId),
      /invalid|unexpected queue URL/,
    );
  }
});

test("completion metadata persistence keeps the successful output path non-fatal", async () => {
  const { tryPersistFalCompletion } = await import("./fal-provider-utils.mjs");
  const writes = [];
  const kv = { put: async (...args) => { writes.push(args); } };
  const job = { endpointId: "fal-ai/example-model", requestId: "request-1" };
  assert.deepEqual(await tryPersistFalCompletion(kv, "job-key", job, "2026-11-19T08:00:00.000Z"), { persisted: true });
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0][1]), { ...job, completedAt: "2026-11-19T08:00:00.000Z", completed: true });
  assert.equal(writes[0][2].expirationTtl, 60 * 60 * 24 * 7);

  const unavailableKv = { put: async () => { throw new Error("KV unavailable"); } };
  assert.deepEqual(await tryPersistFalCompletion(unavailableKv, "job-key", job, "2026-11-19T08:00:00.000Z"), { persisted: false });
});

test("reconstructs trusted fal queue URLs from a valid endpoint and UUID", () => {
  const requestId = "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b";
  const record = recoverFalJobRecord("blackforestlabs/flux-3-max/text-to-video", requestId);
  assert.equal(record.statusUrl, `https://queue.fal.run/blackforestlabs/flux-3-max/requests/${requestId}/status`);
  assert.equal(record.responseUrl, `https://queue.fal.run/blackforestlabs/flux-3-max/requests/${requestId}`);
  assert.equal(record.cancelUrl, `https://queue.fal.run/blackforestlabs/flux-3-max/requests/${requestId}/cancel`);
});

test("rejects invalid endpoint IDs and request IDs during fal job recovery", () => {
  for (const [endpointId, requestId] of [
    ["https://attacker.example", "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b"],
    ["../attacker", "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b"],
    ["blackforestlabs/flux-3-max", "not-a-uuid"],
    ["blackforestlabs/flux-3-max", "019a1b2c-3d4e-7f80-7a1b-2c3d4e5f6a7b"],
  ]) {
    assert.throws(() => recoverFalJobRecord(endpointId, requestId), /valid fal.ai endpoint ID and request ID/);
  }
});
