import test from "node:test";
import assert from "node:assert/strict";
import { trustedFalUrl, validateFalJobRecord } from "./fal-provider-utils.mjs";

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
  for (const value of ["not a URL", "", null, undefined, 42]) {
    assert.throws(() => trustedFalUrl(value), /unexpected queue URL/);
  }
});

test("validates persisted fal.ai job records and normalizes trusted queue URLs", () => {
  const record = validateFalJobRecord({
    endpointId: "fal-ai/example-model",
    requestId: "4d1f2c8e-0d7b-4d6e-9a2a-1f8e2f2d6a01",
    statusUrl: "https://queue.fal.run/fal-ai/example-model/requests/abc/status",
    responseUrl: "https://queue.fal.run/fal-ai/example-model/requests/abc",
    createdAt: "2026-11-19T06:00:00.000Z",
  }, "4d1f2c8e-0d7b-4d6e-9a2a-1f8e2f2d6a01");
  assert.equal(record.endpointId, "fal-ai/example-model");
  assert.equal(record.statusUrl, "https://queue.fal.run/fal-ai/example-model/requests/abc/status");
  assert.equal(record.responseUrl, "https://queue.fal.run/fal-ai/example-model/requests/abc");
});

test("rejects missing, mismatched, malformed, or untrusted persisted job records", () => {
  const valid = {
    endpointId: "fal-ai/example-model",
    requestId: "4d1f2c8e-0d7b-4d6e-9a2a-1f8e2f2d6a01",
    statusUrl: "https://queue.fal.run/model/status",
    responseUrl: "https://queue.fal.run/model/result",
  };
  for (const record of [
    null,
    [],
    { ...valid, requestId: "another-request" },
    { ...valid, endpointId: "https://attacker.example/steal" },
    { ...valid, endpointId: "../attacker" },
    { ...valid, statusUrl: "https://attacker.example/status" },
    { ...valid, responseUrl: "http://queue.fal.run/result" },
    { ...valid, responseUrl: "https://queue.fal.run/result?token=unexpected" },
  ]) {
    assert.throws(
      () => validateFalJobRecord(record, valid.requestId),
      /invalid|unexpected queue URL/,
    );
  }
});
