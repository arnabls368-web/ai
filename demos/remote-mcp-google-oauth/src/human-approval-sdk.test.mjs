import test from "node:test";
import assert from "node:assert/strict";
import { acceptedContent, inputRequired, inputResponse } from "@modelcontextprotocol/server";
import { z } from "zod";
import { requestHumanApproval } from "./human-approval.mjs";

const approvalSchema = z.object({ confirm: z.boolean() });
const api = {
  acceptedContent,
  inputRequired,
  inputResponse,
  approvalSchema,
  approvalWireSchema: {
    type: "object",
    properties: { confirm: { type: "boolean" } },
    required: ["confirm"],
  },
};

test("real MCP SDK creates an input-required approval result", () => {
  const result = requestHumanApproval(
    { mcpReq: { inputResponses: undefined } },
    "approval-key",
    "Approve this exact operation?",
    api,
  );
  assert.equal(result.approved, false);
  assert.equal(result.inputRequired.resultType, "input_required");
  assert.ok(result.inputRequired.inputRequests["approval-key"]);
});

test("real MCP SDK accepts only an accepted true response", () => {
  const result = requestHumanApproval(
    {
      mcpReq: {
        inputResponses: {
          "approval-key": { action: "accept", content: { confirm: true } },
        },
      },
    },
    "approval-key",
    "Approve this exact operation?",
    api,
  );
  assert.deepEqual(result, { approved: true, declined: false });
});

test("real MCP SDK treats declined and cancelled responses as denials", () => {
  for (const action of ["decline", "cancel"]) {
    const result = requestHumanApproval(
      {
        mcpReq: {
          inputResponses: { "approval-key": { action } },
        },
      },
      "approval-key",
      "Approve this exact operation?",
      api,
    );
    assert.deepEqual(result, { approved: false, declined: true });
  }
});

test("real MCP SDK does not approve false or malformed content", () => {
  for (const content of [{ confirm: false }, {}, { confirm: "yes" }]) {
    const result = requestHumanApproval(
      {
        mcpReq: {
          inputResponses: {
            "approval-key": { action: "accept", content },
          },
        },
      },
      "approval-key",
      "Approve this exact operation?",
      api,
    );
    assert.equal(result.approved, false);
    assert.equal(result.inputRequired.resultType, "input_required");
  }
});
