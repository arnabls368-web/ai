export function createFalRecoveryToken(apiKey: string, scope: string, endpointId: string, requestId: string, expiresAt: number): Promise<string>;
export function verifyFalRecoveryToken(apiKey: string, scope: string, endpointId: string, requestId: string, token: string, now?: number): Promise<boolean>;
