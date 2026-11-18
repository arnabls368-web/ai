/**
 * Ask the connected MCP client to display a user-mediated approval form.
 * Missing client capability, cancellation, decline, or malformed responses all fail closed.
 */
export async function requestHumanApproval(context, message) {
  const request = context?.mcpReq;
  if (!request || typeof request.elicitInput !== "function") {
    throw new Error("This MCP client cannot display interactive approval. The operation was not performed.");
  }

  let response;
  try {
    response = await request.elicitInput({
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: "I approve this exact operation",
          },
        },
        required: ["confirm"],
      },
    });
  } catch {
    throw new Error("Interactive user approval was unavailable or unsupported. The operation was not performed.");
  }

  return response?.action === "accept" && response?.content?.confirm === true;
}
