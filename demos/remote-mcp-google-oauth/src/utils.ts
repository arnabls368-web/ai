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
  } catch {
    console.error("Google token exchange request failed or timed out");
    return [null, new Response("Google token exchange request failed", { status: 502 })];
  }
  if (!resp.ok) {
    console.error("Google token exchange failed:", resp.status);
    return [null, new Response("Failed to fetch access token", { status: 500 })];
  }

  let body: unknown;
  try {
    body = await resp.json();
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
  const response = await fetch("https://oauth2.googleapis.com/token", {
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
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
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
