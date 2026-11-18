const RENDERER_AUDIENCE = "nexus-renderer";
const MAX_RENDER_TOKEN_TTL_SECONDS = 300;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type RenderScope = "render:submit" | "render:read" | "asset:write";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Mint a short-lived credential for one authenticated account and project.
 * The tenant ID must come from getProjectScope(), never from MCP input.
 * Keep this secret in a Worker secret binding; never return tokens to clients.
 */
export async function createRenderAuthorizationToken({
  secret,
  tenantId,
  projectId,
  scope,
  ttlSeconds = 120,
  now = Date.now(),
}: {
  secret: string;
  tenantId: string;
  projectId: string;
  scope: RenderScope;
  ttlSeconds?: number;
  now?: number;
}): Promise<string> {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("NEXUS_RENDER_SIGNING_SECRET must contain at least 32 characters.");
  }
  if (!ID_PATTERN.test(tenantId) || !ID_PATTERN.test(projectId)) {
    throw new Error("A valid tenant and project identity are required.");
  }
  if (!["render:submit", "render:read"].includes(scope)) {
    throw new Error("Unsupported renderer authorization scope.");
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_RENDER_TOKEN_TTL_SECONDS) {
    throw new Error("Renderer authorization lifetime must be between 1 and 300 seconds.");
  }
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    aud: RENDERER_AUDIENCE,
    tenantId,
    projectId,
    scope,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(mac))}`;
}

/**
 * Call only a configured HTTPS renderer endpoint. The credential is scoped
 * to the project and operation; caller-controlled tenant IDs are not accepted.
 */
export async function callPrivateRenderer({
  baseUrl,
  secret,
  tenantId,
  projectId,
  scope,
  path,
  method = "GET",
  body,
}: {
  baseUrl: string;
  secret: string;
  tenantId: string;
  projectId: string;
  scope: RenderScope;
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<Response> {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("NEXUS_RENDERER_URL must be a clean HTTPS base URL.");
  }
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("..")) {
    throw new Error("Invalid private renderer path.");
  }
  if ((method === "POST" && scope !== "render:submit") ||
      (method === "PUT" && scope !== "asset:write") ||
      (method === "GET" && scope !== "render:read") ||
      (body !== undefined && rawBody !== undefined)) {
    throw new Error("Renderer request method or body does not match its authorization scope.");
  }
  const token = await createRenderAuthorizationToken({
    secret, tenantId, projectId, scope,
  });
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  let requestBody: string | undefined;
  if (body !== undefined) {
    requestBody = JSON.stringify(body);
    headers.set("Content-Type", "application/json");
  } else if (rawBody !== undefined) {
    headers.set("Content-Type", contentType ?? "application/octet-stream");
  }
  const target = new URL(path, base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/")) {
    throw new Error("Renderer path escaped its configured base URL.");
  }
  return fetch(target, { method, headers, body: rawBody ?? requestBody, redirect: "error", signal: AbortSignal.timeout(120_000) });
}
