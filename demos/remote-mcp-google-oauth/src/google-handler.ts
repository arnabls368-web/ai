import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, readJsonLimited, type Props } from "./utils";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

// Lightweight operational probe for deployment verification. This endpoint does not
// expose credentials or user data and is intentionally independent of Google OAuth.
app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "NEXUS Universe YouTube Automation MCP",
    version: "1.2.0",
    mcpEndpoint: "/mcp",
  }),
);

// Human-friendly root response so the deployed Worker is distinguishable from
// Cloudflare's starter "Hello World" Worker during smoke tests.
app.get("/", (c) =>
  c.json({
    service: "NEXUS Universe YouTube Automation MCP",
    status: "running",
    health: "/health",
    mcp: "/mcp",
  }),
);

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}

	// Check if client is already approved
	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		// Skip approval dialog but still create secure state and bind to session
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
		return redirectToGoogle(c.req.raw, c.env, stateToken, {
			"Set-Cookie": sessionBindingCookie,
		});
	}

	// Generate CSRF protection for the approval form
	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			description: "Connect your Google account to manage private video uploads and read your YouTube channel and analytics data.",
			name: "NEXUS Universe YouTube MCP",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		// Read form data once
		const formData = await c.req.raw.formData();

		// Validate CSRF token and clear the one-time token cookie on success.
		const { clearCookie: clearCsrfCookie } = validateCSRFToken(formData, c.req.raw);

		// Extract state from form data
		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch (_e) {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return c.text("Invalid request", 400);
		}

		// Add client to approved list
		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);

		// Create OAuth state and bind it to this user's session
		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		// Set both cookies: approved client list + session binding
		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionBindingCookie);
		headers.append("Set-Cookie", clearCsrfCookie);

		return redirectToGoogle(c.req.raw, c.env, stateToken, headers);
	} catch (error: any) {
		console.error("POST /authorize error:", error);
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		// Keep internal exception details in server logs, not in the public response.
		return c.text("Internal server error", 500);
	}
});

async function redirectToGoogle(
	request: Request,
	env: Env,
	stateToken: string,
	headers: HeadersInit = {},
) {
	const responseHeaders = new Headers(headers);
	responseHeaders.set(
		"Location",
		getUpstreamAuthorizeUrl({
			clientId: env.GOOGLE_CLIENT_ID,
			hostedDomain: env.HOSTED_DOMAIN,
			redirectUri: new URL("/callback", request.url).href,
			scope: "openid email profile https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly",
			state: stateToken,
			upstreamUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		}),
	);
	return new Response(null, { headers: responseHeaders, status: 302 });
}

/**
 * OAuth Callback Endpoint
 *
 * This route handles the callback from Google after user authentication.
 * It exchanges the temporary code for an access token, then stores some
 * user metadata & the auth token as part of the 'props' on the token passed
 * down to the client. It ends by redirecting the client back to _its_ callback URL
 *
 * SECURITY: This endpoint validates that the state parameter from Google
 * matches both:
 * 1. A valid state token in KV (proves it was created by our server)
 * 2. The __Host-CONSENTED_STATE cookie (proves THIS browser consented to it)
 *
 * This prevents CSRF attacks where an attacker's state token is injected
 * into a victim's OAuth flow.
 */
app.get("/callback", async (c) => {
	// Validate OAuth state with session binding
	// This checks both KV storage AND the session cookie
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;

	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error: any) {
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		// Unexpected non-OAuth error
		return c.text("Internal server error", 500);
	}

	if (!oauthReqInfo.clientId) {
		return c.text("Invalid OAuth request data", 400);
	}

	// Exchange the code for an access token
	const code = c.req.query("code");
	if (!code) {
		return c.text("Missing code", 400);
	}

	const [googleTokens, googleErrResponse] = await fetchUpstreamAuthToken({
		clientId: c.env.GOOGLE_CLIENT_ID,
		clientSecret: c.env.GOOGLE_CLIENT_SECRET,
		code,
		grantType: "authorization_code",
		redirectUri: new URL("/callback", c.req.url).href,
		upstreamUrl: "https://oauth2.googleapis.com/token",
	});
	if (googleErrResponse) {
		return googleErrResponse;
	}
	if (!googleTokens) return c.text("Google did not return an access token", 500);
	const { accessToken, refreshToken } = googleTokens;

	// Fetch the user info from Google
	let userResponse: Response;
	try {
		userResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
			redirect: "error",
			signal: AbortSignal.timeout(20_000),
		});
	} catch {
		console.error("Google userinfo request failed or timed out");
		return c.text("Failed to verify Google account information", 502);
	}
	if (!userResponse.ok) {
		console.error("Google userinfo request failed:", userResponse.status);
		return c.text("Failed to verify Google account information", 502);
	}

	let userInfo: unknown;
	try {
		userInfo = await readJsonLimited(userResponse, 65_536);
	} catch {
		return c.text("Google returned invalid account information", 502);
	}
	if (
		!userInfo ||
		typeof userInfo !== "object" ||
		!("id" in userInfo) ||
		typeof userInfo.id !== "string" ||
		userInfo.id.length === 0 ||
		!("email" in userInfo) ||
		typeof userInfo.email !== "string" ||
		!userInfo.email.includes("@") ||
		!("verified_email" in userInfo) ||
		userInfo.verified_email !== true
	) {
		return c.text("Google returned incomplete account information", 502);
	}
	const id = userInfo.id;
	const email = userInfo.email.trim().toLowerCase();
	const name = "name" in userInfo && typeof userInfo.name === "string" && userInfo.name.trim()
		? userInfo.name.trim().slice(0, 200)
		: email;

	// Return back to the MCP client a new token
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: {
			label: name,
		},
		props: {
			accessToken,
			refreshToken,
			email,
			name,
		} as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: id,
	});

	// Clear the session binding cookie (one-time use) by creating response with headers
	const headers = new Headers({ Location: redirectTo });
	if (clearSessionCookie) {
		headers.set("Set-Cookie", clearSessionCookie);
	}

	return new Response(null, {
		status: 302,
		headers,
	});
});

export { app as GoogleHandler };
