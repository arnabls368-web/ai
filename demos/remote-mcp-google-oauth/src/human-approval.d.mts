export type HumanApprovalResult = { approved: true; declined: false } | { approved: false; declined: true } | { approved: false; declined: false; inputRequired: unknown };
export function requestHumanApproval(context: unknown, key: string, message: string): HumanApprovalResult;
