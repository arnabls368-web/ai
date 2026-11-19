/**
 * Parse an upstream JSON response without allowing an unbounded body allocation.
 * Content-Length is advisory; the streamed byte count is always enforced.
 */
export async function readJsonLimited(response: Response, maxBytes = 65_536): Promise<unknown> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel();
      throw new Error("Upstream JSON response exceeded the size limit.");
    }
  }
  if (!response.body) throw new Error("Upstream JSON response had no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("Upstream JSON response exceeded the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
}

/**
 * Constructs an authorization URL for Google OAuth.
 */
export function getUpstreamAuthorizeUrl({
  upstreamUrl,
  clientId,
  scope,
  redirectUri,
  state,
  hostedDomain,
}: {
  upstreamUrl: string;
  clientId: string;
  scope: string;
  redirectUri: string;
  state?: string;
  hostedDomain?: string;
}) {
  const upstream = new URL(upstreamUrl);
  upstream.searchParams.set("client_id", clientId);
  upstream.searchParams.set("redirect_uri", redirectUri);
  upstream.searchParams.set("scope", scope);
  upstream.searchParams.set("response_type", "code");
  upstream.searchParams.set("access_type", "offline");
  upstream.searchParams.set("prompt", "consent");
  if (state) upstream.searchParams.set("state", state);
  if (hostedDomain) upstream.searchParams.set("hd", hostedDomain);
  return upstream.href;
}

export async function fetchUpstreamAuthToken({
  clientId,
  clientSecret,
  code,
  redirectUri,
  upstreamUrl,
  grantType,
}: {
  code: string | undefined;
  upstreamUrl: string;
  clientSecret: string;
  redirectUri: string;
  clientId: string;
  grantType: string;
}): Promise<[{ accessToken: string; refreshToken?: string } | null, Response | null]> {
  if (!code) return [null, new Response("Missing code", { status: 400 })];

  let resp: Response;
  try {
    resp = await fetch(upstreamUrl, {
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: grantType,
        redirect_uri: redirectUri,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    // Log only transport error metadata. Never log the authorization code,
    // client secret, request body, access token, or full request URL.
    const primary = error instanceof Error ? error : undefined;
    const cause = primary?.cause instanceof Error ? primary.cause : undefined;
    const safeText = (value: string | undefined) =>
      value ? value.replace(/https?:\/\/[^\s]+/gi, "[url]").slice(0, 180) : undefined;
    console.error("Google token exchange transport failure", {
      errorName: primary?.name ?? "UnknownError",
      errorMessage: safeText(primary?.message),
      causeName: cause?.name,
      causeMessage: safeText(cause?.message),
      timedOut: primary?.name === "TimeoutError" || cause?.name === "TimeoutError",
    });
    return [null, new Response("Google token exchange request failed", { status: 502 })];
  }
  if (!resp.ok) {
    console.error("Google token exchange failed:", resp.status);
    await resp.body?.cancel();
    return [null, new Response("Failed to fetch access token", { status: 500 })];
  }

  let body: unknown;
  try {
    body = await readJsonLimited(resp, 65_536);
  } catch {
    console.error("Google token exchange returned invalid JSON");
    return [null, new Response("Google returned an invalid token response", { status: 502 })];
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("access_token" in body) ||
    typeof body.access_token !== "string" ||
    body.access_token.length === 0 ||
    body.access_token.length > 16_384
  ) {
    console.error("Google token exchange response did not contain a valid access token");
    return [null, new Response("Google returned an invalid access token", { status: 502 })];
  }
  const refresh = "refresh_token" in body ? body.refresh_token : undefined;
  if (refresh !== undefined && (typeof refresh !== "string" || refresh.length === 0 || refresh.length > 16_384)) {
    console.error("Google token exchange response contained an invalid refresh token");
    return [null, new Response("Google returned an invalid refresh token", { status: 502 })];
  }
  return [{ accessToken: body.access_token, ...(typeof refresh === "string" ? { refreshToken: refresh } : {}) }, null];
}

export async function refreshGoogleAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    console.error("Google token refresh request failed or timed out");
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  let body: unknown;
  try {
    body = await readJsonLimited(response, 65_536);
  } catch {
    console.error("Google token refresh returned invalid JSON");
    return null;
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("access_token" in body) ||
    typeof body.access_token !== "string" ||
    body.access_token.length === 0 ||
    body.access_token.length > 16_384
  ) {
    console.error("Google token refresh response did not contain a valid access token");
    return null;
  }
  return body.access_token;
}

export type Props = {
  name: string;
  email: string;
  accessToken: string;
  refreshToken?: string;
};
