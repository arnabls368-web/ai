import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchUpstreamAuthToken,
  readJsonLimited,
  refreshGoogleAccessToken,
} from "./utils.ts";

test("readJsonLimited accepts bounded JSON and rejects declared oversized bodies", async () => {
  assert.deepEqual(await readJsonLimited(new Response('{"ok":true}')), { ok: true });

  const oversized = new Response(new ReadableStream(), {
    headers: { "Content-Length": "129" },
  });
  await assert.rejects(readJsonLimited(oversized, 128), /exceeded the size limit/);
});

test("readJsonLimited enforces the streamed byte limit and strict UTF-8", async () => {
  const streamed = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(80));
      controller.enqueue(new Uint8Array(49));
      controller.close();
    },
  }));
  await assert.rejects(readJsonLimited(streamed, 128), /exceeded the size limit/);

  await assert.rejects(
    readJsonLimited(new Response(Uint8Array.from([0xc3, 0x28]))),
    /encoded data|UTF-8/i,
  );
});

test("fetchUpstreamAuthToken validates and returns Google tokens", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return Response.json({ access_token: "access-token", refresh_token: "refresh-token" });
  };
  try {
    const [tokens, error] = await fetchUpstreamAuthToken({
      clientId: "client-id",
      clientSecret: "client-secret",
      code: "auth-code",
      redirectUri: "https://example.test/callback",
      upstreamUrl: "https://oauth2.googleapis.com/token",
      grantType: "authorization_code",
    });
    assert.deepEqual(tokens, { accessToken: "access-token", refreshToken: "refresh-token" });
    assert.equal(error, null);
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.method, "POST");
    const body = new URLSearchParams(request.init.body);
    assert.equal(body.get("code"), "auth-code");
    assert.equal(body.get("grant_type"), "authorization_code");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchUpstreamAuthToken rejects malformed and oversized token fields", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ access_token: "" });
    const [missingAccessToken, missingError] = await fetchUpstreamAuthToken({
      clientId: "id", clientSecret: "secret", code: "code",
      redirectUri: "https://example.test/callback",
      upstreamUrl: "https://oauth2.googleapis.com/token",
      grantType: "authorization_code",
    });
    assert.equal(missingAccessToken, null);
    assert.equal(missingError.status, 502);

    globalThis.fetch = async () => Response.json({
      access_token: "valid",
      refresh_token: "x".repeat(16_385),
    });
    const [invalidRefreshToken, refreshError] = await fetchUpstreamAuthToken({
      clientId: "id", clientSecret: "secret", code: "code",
      redirectUri: "https://example.test/callback",
      upstreamUrl: "https://oauth2.googleapis.com/token",
      grantType: "authorization_code",
    });
    assert.equal(invalidRefreshToken, null);
    assert.equal(refreshError.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshGoogleAccessToken returns a bounded access token and rejects bad responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.redirect, "error");
      assert.equal(new URLSearchParams(init.body).get("grant_type"), "refresh_token");
      return Response.json({ access_token: "renewed-token" });
    };
    assert.equal(await refreshGoogleAccessToken("refresh", "client", "secret"), "renewed-token");

    globalThis.fetch = async () => Response.json({ access_token: "" });
    assert.equal(await refreshGoogleAccessToken("refresh", "client", "secret"), null);

    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    assert.equal(await refreshGoogleAccessToken("refresh", "client", "secret"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
