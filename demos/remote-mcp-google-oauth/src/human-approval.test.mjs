import test from "node:test";
import assert from "node:assert/strict";
import { requestHumanApproval } from "./human-approval.mjs";

test("requests modern round-trip approval when no answer exists", () => {
  const result = requestHumanApproval(
    { mcpReq: { inputResponses: undefined } },
    "upload-approval",
    "Approve this exact upload?",
  );
  assert.equal(result.approved, false);
  assert.equal(result.declined, false);
  assert.ok(result.inputRequired);
  assert.equal(result.inputRequired.resultType, "input_required");
});

test("accepts only an explicitly accepted true confirmation", () => {
  const result = requestHumanApproval(
    { mcpReq: { inputResponses: {
      "upload-approval": { kind: "elicit", action: "accept", content: { confirm: true } },
    } } },
    "upload-approval",
    "Approve this exact upload?",
  );
  assert.deepEqual(result, { approved: true, declined: false });
});

test("decline and cancel are terminal denials", () => {
  for (const action of ["decline", "cancel"]) {
    const result = requestHumanApproval(
      { mcpReq: { inputResponses: {
        "upload-approval": { kind: "elicit", action },
      } } },
      "upload-approval",
      "Approve this exact upload?",
    );
    assert.deepEqual(result, { approved: false, declined: true });
    assert.equal(result.inputRequired, undefined);
  }
});

test("false, malformed and absent responses request confirmation again", () => {
  for (const content of [{ confirm: false }, {}, { confirm: "yes" }]) {
    const result = requestHumanApproval(
      { mcpReq: { inputResponses: {
        "upload-approval": { kind: "elicit", action: "accept", content },
      } } },
      "upload-approval",
      "Approve this exact upload?",
    );
    assert.equal(result.approved, false);
    assert.ok(result.inputRequired);
  }
});

test("missing MCP request context fails closed", () => {
  assert.throws(
    () => requestHumanApproval({}, "upload-approval", "Approve?"),
    /cannot carry interactive approval/,
  );
});
