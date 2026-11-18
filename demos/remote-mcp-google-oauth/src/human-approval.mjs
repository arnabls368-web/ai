/**
 * Dependency-free approval decision logic. The MCP SDK adapter is injected
 * by the caller so this module can be covered by lightweight Node tests.
 */
export function requestHumanApproval(context, key, message, api) {
  const request = context?.mcpReq;
  if (!request) {
    throw new Error("This MCP request cannot carry interactive approval. The operation was not performed.");
  }

  const response = api.inputResponse(request.inputResponses, key);
  if (response.kind === "elicit" && response.action !== "accept") {
    return { approved: false, declined: true };
  }

  const accepted = api.acceptedContent(request.inputResponses, key, api.approvalSchema);
  if (accepted?.confirm === true) {
    return { approved: true, declined: false };
  }

  return {
    approved: false,
    declined: false,
    inputRequired: api.inputRequired({
      inputRequests: {
        [key]: api.inputRequired.elicit({
          message,
          requestedSchema: api.approvalWireSchema,
        }),
      },
    }),
  };
}
