import test from "node:test";
import assert from "node:assert/strict";
import { trustedFalUrl } from "./fal-provider-utils.mjs";

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
