import test from "node:test";
import assert from "node:assert/strict";
import { serializeApprovalBinding } from "./approval-binding.mjs";

test("approval binding preserves field boundaries", () => {
  const first = serializeApprovalBinding(["account", "video-hash", "title\\npart", "description"]);
  const second = serializeApprovalBinding(["account", "video-hash", "title", "part\\ndescription"]);
  assert.notEqual(first, second);
});

test("approval binding is deterministic and field-order sensitive", () => {
  assert.equal(
    serializeApprovalBinding(["account", "endpoint", "{\"prompt\":\"hello\"}"]),
    serializeApprovalBinding(["account", "endpoint", "{\"prompt\":\"hello\"}"]),
  );
  assert.notEqual(
    serializeApprovalBinding(["account", "endpoint", "input"]),
    serializeApprovalBinding(["endpoint", "account", "input"]),
  );
});

test("approval binding rejects non-string fields", () => {
  assert.throws(() => serializeApprovalBinding(["account", 1]), /array of strings/);
});
