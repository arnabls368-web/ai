export function signAuthorizationState(
  state: Record<string, unknown>,
  secret: string,
): Promise<string>;

export function verifyAuthorizationState(
  encodedState: string,
  secret: string,
): Promise<Record<string, unknown> | null>;
