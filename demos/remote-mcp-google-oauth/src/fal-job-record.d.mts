export interface FalJobRecord {
  endpointId: string;
  requestId: string;
  statusUrl: string;
  responseUrl: string;
  cancelUrl?: string;
  createdAt: string;
}
export function loadFalJobRecord(options: {
  kv: {
    get<T = unknown>(key: string, type: "json"): Promise<T | null>;
    put(key: string, value: string, options: { expirationTtl: number }): Promise<unknown>;
  };
  key: string;
  scope: string;
  apiKey: string;
  requestId: string;
  endpointId?: string;
  recoveryToken?: string;
  verifyToken: (apiKey: string, scope: string, endpointId: string, requestId: string, token: string) => Promise<boolean>;
  recoverRecord: (endpointId: string, requestId: string) => FalJobRecord;
  validateRecord: (job: unknown, requestId: string, expectedEndpointId?: string) => FalJobRecord;
}): Promise<FalJobRecord>;
