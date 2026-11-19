const encoder = new TextEncoder();
const TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 7;

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function fromHex(value) {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(value)) return null;
  return Uint8Array.from(value.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

function validRecoveryIdentity(scope, endpointId, requestId) {
  return typeof scope === "string" && /^[0-9a-f]{64}$/i.test(scope) &&
    typeof endpointId === "string" && endpointId.length <= 200 &&
    /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,4}$/i.test(endpointId) &&
    typeof requestId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId);
}

async function recoveryKey(apiKey) {
  if (typeof apiKey !== "string" || apiKey.length < 1) throw new Error("A fal.ai API key is required to sign recovery tokens.");
  return crypto.subtle.importKey("raw", encoder.encode(apiKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function recoveryMessage(scope, endpointId, requestId, expiresAt) {
  return ["nexus-fal-recovery-v1", scope, endpointId, requestId, String(expiresAt)].join("\n");
}

/**
 * Create a short-lived bearer capability bound to one authenticated account,
 * fal endpoint and request. The token contains no account email or API key.
 */
export async function createFalRecoveryToken(apiKey, scope, endpointId, requestId, expiresAt) {
  if (!validRecoveryIdentity(scope, endpointId, requestId) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Math.floor(Date.now() / 1000) ||
      expiresAt > Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS) {
    throw new Error("A valid account, fal job identity and recovery-token expiry are required.");
  }
  const key = await recoveryKey(apiKey);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(recoveryMessage(scope, endpointId, requestId, expiresAt)));
  return "v1." + expiresAt + "." + toHex(signature);
}

/**
 * Verify the account-bound recovery capability. Invalid, expired, or
 * cross-account tokens fail closed without exposing signature details.
 */
export async function verifyFalRecoveryToken(apiKey, scope, endpointId, requestId, token, now = Math.floor(Date.now() / 1000)) {
  if (!validRecoveryIdentity(scope, endpointId, requestId) ||
      typeof token !== "string" || token.length > 256 ||
      !Number.isSafeInteger(now)) return false;
  const match = /^v1\.(0|[1-9][0-9]{0,11})\.([0-9a-f]{64})$/i.exec(token);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  const signature = fromHex(match[2]);
  if (!signature || !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now || expiresAt > now + TOKEN_LIFETIME_SECONDS) return false;
  try {
    const key = await recoveryKey(apiKey);
    return await crypto.subtle.verify("HMAC", key, signature, encoder.encode(recoveryMessage(scope, endpointId, requestId, expiresAt)));
  } catch {
    return false;
  }
}
