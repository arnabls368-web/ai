export type HumanApprovalResult =
  | { approved: true; declined: false }
  | { approved: false; declined: true }
  | { approved: false; declined: false; inputRequired: any };
export function requestHumanApproval(context: unknown, key: string, message: string, api: any): HumanApprovalResult;
