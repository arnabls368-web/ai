import { acceptedContent, inputRequired, inputResponse } from "@modelcontextprotocol/server";
import { z } from "zod";

const approvalSchema = z.object({ confirm: z.boolean() });
const approvalWireSchema = {
  type: "object",
  properties: {
    confirm: { type: "boolean", title: "I approve this exact operation" },
  },
  required: ["confirm"],
};

/**
 * Return a modern input_required result until the connected client explicitly
 * accepts the exact approval prompt. The SDK legacy shim handles older clients.
 * Declines and cancellations are terminal; missing/malformed answers never approve.
 */
export function requestHumanApproval(context, key, message) {
  const request = context?.mcpReq;
  if (!request) {
    throw new Error("This MCP request cannot carry interactive approval. The operation was not performed.");
  }

  const response = inputResponse(request.inputResponses, key);
  if (response.kind === "elicit" && response.action !== "accept") {
    return { approved: false, declined: true };
  }

  const accepted = acceptedContent(request.inputResponses, key, approvalSchema);
  if (accepted?.confirm === true) {
    return { approved: true, declined: false };
  }

  return {
    approved: false,
    declined: false,
    inputRequired: inputRequired({
      inputRequests: {
        [key]: inputRequired.elicit({
          message,
          requestedSchema: approvalWireSchema,
        }),
      },
    }),
  };
}
