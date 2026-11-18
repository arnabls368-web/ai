type StoredOAuthState = { value: string; expiresAt: number };

/**
 * Per-state Durable Object. Each OAuth state token maps to one object, and
 * consume uses a storage transaction so concurrent callbacks cannot both win.
 */
export class OAuthStateDO {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    if (url.pathname === "/store") {
      let body: { value?: unknown; expiresAt?: unknown };
      try {
        body = await request.json() as { value?: unknown; expiresAt?: unknown };
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      if (typeof body.value !== "string" || !body.value ||
          typeof body.expiresAt !== "number" || !Number.isSafeInteger(body.expiresAt) ||
          body.expiresAt <= Date.now()) {
        return Response.json({ error: "invalid OAuth state record" }, { status: 400 });
      }
      await this.state.storage.put<StoredOAuthState>("oauth-state", {
        value: body.value,
        expiresAt: body.expiresAt,
      });
      await this.state.storage.setAlarm(body.expiresAt);
      return Response.json({ stored: true }, { status: 201 });
    }

    if (url.pathname === "/consume") {
      const value = await this.state.storage.transaction(async (transaction) => {
        const stored = await transaction.get<StoredOAuthState>("oauth-state");
        if (!stored) return null;
        await transaction.delete("oauth-state");
        return stored.expiresAt > Date.now() ? stored.value : null;
      });
      return value === null
        ? Response.json({ value: null }, { status: 404 })
        : Response.json({ value });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.state.storage.delete("oauth-state");
  }
}
