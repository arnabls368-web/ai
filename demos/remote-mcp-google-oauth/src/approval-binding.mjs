/** Encode approval fields as a JSON tuple so field boundaries cannot collide. */
export function serializeApprovalBinding(fields) {
  if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string")) {
    throw new TypeError("Approval binding fields must be an array of strings.");
  }
  return JSON.stringify(fields);
}
