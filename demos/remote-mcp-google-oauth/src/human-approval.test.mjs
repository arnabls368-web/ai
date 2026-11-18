import test from "node:test";
import assert from "node:assert/strict";
import { requestHumanApproval } from "./human-approval.mjs";

test("accepts only an explicit accepted true confirmation", async () => {
  const context = { mcpReq: { elicitInput: async () => ({ action: "accept", content: { confirm: true } }) } };
  assert.equal(await requestHumanApproval(context, "Approve exact action?"), true);
});

test("decline, cancel and unchecked confirmation are not approval", async () => {
  for (const response of [
    { action: "decline" },
    { action: "cancel" },
    { action: "accept", content: { confirm: false } },
    { action: "accept", content: {} },
    {},
  ]) {
    const context = { mcpReq: { elicitInput: async () => response } };
    assert.equal(await requestHumanApproval(context, "Approve exact action?"), false);
  }
});

test("missing elicitation capability fails closed", async () => {
  await assert.rejects(
    requestHumanApproval({}, "Approve exact action?"),
    /cannot display interactive approval/,
  );
});

test("elicitation errors fail closed", async () => {
  const context = { mcpReq: { elicitInput: async () => { throw new Error("unsupported"); } } };
  await assert.rejects(
    requestHumanApproval(context, "Approve exact action?"),
    /approval was unavailable or unsupported/,
  );
});
