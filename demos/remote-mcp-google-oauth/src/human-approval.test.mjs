import test from "node:test";
import assert from "node:assert/strict";
import { requestHumanApproval } from "./human-approval.mjs";

const approvalWireSchema = {
  type: "object",
  properties: { confirm: { type: "boolean", title: "I approve this exact operation" } },
  required: ["confirm"],
};

function makeApi(response) {
  return {
    approvalSchema: "approval-schema",
    approvalWireSchema,
    inputResponse: () => response ?? { kind: "missing" },
    acceptedContent: () => response?.kind === "elicit" && response.action === "accept" ? response.content : undefined,
    inputRequired: Object.assign(
      (value) => ({ resultType: "input_required", ...value }),
      { elicit: (value) => ({ type: "elicitation", ...value }) },
    ),
  };
}

test("requests modern round-trip approval when no answer exists", () => {
  const result = requestHumanApproval(
    { mcpReq: { inputResponses: undefined } },
    "upload-approval",
    "Approve this exact upload?",
    makeApi(undefined),
  );
  assert.equal(result.approved, false);
  assert.equal(result.declined, false);
  assert.equal(result.inputRequired.resultType, "input_required");
  assert.ok(result.inputRequired.inputRequests["upload-approval"]);
});

test("accepts only an explicitly accepted true confirmation", () => {
  const result = requestHumanApproval(
    { mcpReq: { inputResponses: {} } },
    "upload-approval",
    "Approve this exact upload?",
    makeApi({ kind: "elicit", action: "accept", content: { confirm: true } }),
  );
  assert.deepEqual(result, { approved: true, declined: false });
});

test("decline and cancel are terminal denials", () => {
  for (const action of ["decline", "cancel"]) {
    const result = requestHumanApproval(
      { mcpReq: { inputResponses: {} } },
      "upload-approval",
      "Approve this exact upload?",
      makeApi({ kind: "elicit", action }),
    );
    assert.deepEqual(result, { approved: false, declined: true });
    assert.equal(result.inputRequired, undefined);
  }
});

test("false and malformed accepted content never approves", () => {
  for (const content of [{ confirm: false }, {}, { confirm: "yes" }]) {
    const result = requestHumanApproval(
      { mcpReq: { inputResponses: {} } },
      "upload-approval",
      "Approve this exact upload?",
      makeApi({ kind: "elicit", action: "accept", content }),
    );
    assert.equal(result.approved, false);
    assert.ok(result.inputRequired);
  }
});

test("missing MCP request context fails closed", () => {
  assert.throws(
    () => requestHumanApproval({}, "upload-approval", "Approve?", makeApi(undefined)),
    /cannot carry interactive approval/,
  );
});
