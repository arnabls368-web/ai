export type HumanApprovalApi = {
  inputResponse(responses: unknown, key: string): { kind: string; action?: string };
  acceptedContent(responses: unknown, key: string, schema: unknown): { confirm?: boolean } | undefined;
  inputRequired: {
    (spec: unknown): unknown;
    elicit(params: unknown): unknown;
  };
  approvalSchema: unknown;
  approvalWireSchema: unknown;
};
export type HumanApprovalResult =
  | { approved: true; declined: false }
  | { approved: false; declined: true }
  | { approved: false; declined: false; inputRequired: unknown };
export function requestHumanApproval(context: unknown, key: string, message: string, api: HumanApprovalApi): HumanApprovalResult;
