import { createHmac, timingSafeEqual } from "node:crypto";

const AUDIENCE = "nexus-renderer";
const MAX_TOKEN_TTL_SECONDS = 300;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCOPES = ["render:submit", "render:read", "asset:write"];

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signature(secret, payload) {
  return createHmac("sha256", secret).update(payload).digest();
}

export function signRenderToken({ secret, tenantId, projectId, scope, ttlSeconds = 120, now = Date.now() }) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("NEXUS_RENDER_SIGNING_SECRET must contain at least 32 characters.");
  if (!ID_PATTERN.test(tenantId ?? "") || !ID_PATTERN.test(projectId ?? "")) throw new Error("A valid tenantId and projectId are required.");
  if (!SCOPES.includes(scope)) throw new Error("Unsupported render token scope.");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TOKEN_TTL_SECONDS) throw new Error("Render token TTL must be between 1 and 300 seconds.");
  const issuedAt = Math.floor(now / 1000);
  const claims = { aud: AUDIENCE, tenantId, projectId, scope, iat: issuedAt, exp: issuedAt + ttlSeconds };
  const payload = encode(claims);
  return `${payload}.${signature(secret, payload).toString("base64url")}`;
}

export function verifyRenderToken(token, { secret, scope, now = Date.now() } = {}) {
  if (typeof secret !== "string" || secret.length < 32 || typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let supplied;
  let claims;
  try {
    supplied = Buffer.from(parts[1], "base64url");
    claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const expected = signature(secret, parts[0]);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  const nowSeconds = Math.floor(now / 1000);
  if (!claims || claims.aud !== AUDIENCE ||
      !ID_PATTERN.test(claims.tenantId ?? "") || !ID_PATTERN.test(claims.projectId ?? "") ||
      !SCOPES.includes(claims.scope) ||
      (scope && claims.scope !== scope) ||
      !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) ||
      claims.iat > nowSeconds + 30 || claims.exp <= nowSeconds || claims.exp <= claims.iat ||
      claims.exp - claims.iat > MAX_TOKEN_TTL_SECONDS) return null;
  return claims;
}
