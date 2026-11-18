import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { env } from "cloudflare:workers";
import { getMcpAuthContext } from "agents/mcp/server";

type RuntimeEnv = Record<string, unknown>;

function secret(name: string): string | undefined {
  const value = (env as unknown as RuntimeEnv)[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function accountScope(): Promise<string> {
  const auth = getMcpAuthContext()?.props as { email?: string } | undefined;
  if (!auth?.email) throw new Error("A signed-in Google account with an email address is required.");
  const bytes = new TextEncoder().encode(auth.email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function result(text: unknown) {
  return { content: [{ type: "text" as const, text: typeof text === "string" ? text : JSON.stringify(text, null, 2) }] };
}

function failure(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Provider request failed." }] };
}

function trustedFalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !["queue.fal.run", "queue.falrun.com"].includes(url.hostname) || url.username || url.password) {
    throw new Error("fal.ai returned an unexpected queue URL; refusing to fetch it.");
  }
  return url.toString();
}

async function providerJson(url: string, init: RequestInit, provider: string): Promise<any> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`${provider} API request failed (${response.status}): ${detail}`);
  }
  return response.json();
}

export function registerProviderTools(server: McpServer) {
  server.registerTool(
    "nexus_research_web",
    {
      description: "Research a video topic with Exa web search. Returns source URLs, titles and relevant excerpts for script research and fact-checking. Requires EXA_API_KEY.",
      inputSchema: z.object({
        query: z.string().min(3).max(1000),
        category: z.enum(["general", "breaking_news", "current_affairs", "politics", "world_news", "local_news", "technology_ai", "business_finance", "science", "health", "sports", "entertainment", "culture", "environment"]).default("general"),
        objective: z.string().min(10).max(1500).default("Find recent, reliable sources and independently verifiable factual evidence for a YouTube video."),
        numResults: z.number().int().min(1).max(10).default(5),
        includeDomains: z.array(z.string().min(1).max(253)).max(10).optional(),
        excludeDomains: z.array(z.string().min(1).max(253)).max(10).optional(),
      }),
    },
    async ({ query, category, objective, numResults, includeDomains, excludeDomains }) => {
      try {
        const apiKey = secret("EXA_API_KEY");
        if (!apiKey) throw new Error("Exa is not configured on this Worker. Add EXA_API_KEY as a Cloudflare Worker secret.");
        const searchQuery = category === "general" ? query : `${category.replaceAll("_", " ")}: ${query}`;
        const body: Record<string, unknown> = {
          query: searchQuery,
          type: "auto",
          numResults,
          contents: { highlights: { query: objective, verbosity: "medium" } },
        };
        if (includeDomains?.length) body.includeDomains = includeDomains;
        if (excludeDomains?.length) body.excludeDomains = excludeDomains;
        const data = await providerJson("https://api.exa.ai/search", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Exa-Beta": "dynamic-highlights-2026-08-28" },
          body: JSON.stringify(body),
        }, "Exa");
        return result({
          query,
          category,
          results: (data.results ?? []).map((item: any) => ({
            title: item.title,
            url: item.url,
            publishedDate: item.publishedDate,
            author: item.author,
            highlights: item.highlights ?? [],
          })),
          costDollars: data.costDollars,
          requestId: data.requestId,
          note: "Treat retrieved pages as sources, verify important claims across independent sources, and cite source URLs in the script notes.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "nexus_submit_media_generation",
    {
      description: "Submit an image, voice, music or video generation request to a fal.ai model endpoint. Requires FAL_KEY and explicit user approval for this paid generation. Use an exact endpoint ID from fal's model catalogue; pass model-specific input matching that model's schema. The result is asynchronous.",
      inputSchema: z.object({
        endpointId: z.string().min(3).max(200).regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,4}$/i),
        input: z.record(z.string(), z.unknown()),
        userApprovedGeneration: z.literal(true),
      }),
    },
    async ({ endpointId, input }) => {
      try {
        const apiKey = secret("FAL_KEY");
        if (!apiKey) throw new Error("fal.ai is not configured on this Worker. Add FAL_KEY as a Cloudflare Worker secret.");
        // Resolve the authenticated account before starting a billable external job.
        // This prevents an untracked paid job if the request has no valid account scope.
        const scope = await accountScope();
        const url = `https://queue.fal.run/${endpointId}`;
        const submitted = await providerJson(url, {
          method: "POST",
          headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }, "fal.ai");
        if (typeof submitted.request_id !== "string" || typeof submitted.status_url !== "string" || typeof submitted.response_url !== "string") {
          throw new Error("fal.ai returned an incomplete queue response; no job record was saved.");
        }
        const record = {
          endpointId,
          requestId: submitted.request_id,
          statusUrl: trustedFalUrl(submitted.status_url),
          responseUrl: trustedFalUrl(submitted.response_url),
          createdAt: new Date().toISOString(),
        };
        await env.OAUTH_KV.put(`nexus:fal-jobs:v1:${scope}:${submitted.request_id}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 7 });
        return result({
          status: submitted.status ?? "IN_QUEUE",
          endpointId,
          requestId: submitted.request_id,
          queuePosition: submitted.queue_position,
          nextTool: "nexus_get_media_generation",
          note: "Poll the same request ID; do not submit the same generation again while it is running. Generation is billable according to the selected model.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "nexus_get_media_generation",
    {
      description: "Check a previously submitted fal.ai generation and retrieve its output when complete. Jobs are scoped to the authenticated Google account.",
      inputSchema: z.object({ requestId: z.string().uuid() }),
    },
    async ({ requestId }) => {
      try {
        const apiKey = secret("FAL_KEY");
        if (!apiKey) throw new Error("fal.ai is not configured on this Worker. Add FAL_KEY as a Cloudflare Worker secret.");
        const scope = await accountScope();
        const key = `nexus:fal-jobs:v1:${scope}:${requestId}`;
        const job = await env.OAUTH_KV.get<{ endpointId: string; requestId: string; statusUrl: string; responseUrl: string; createdAt: string }>(key, "json");
        if (!job) throw new Error("fal.ai job not found for this account, or its 7-day tracking record expired.");
        const status = await providerJson(job.statusUrl, {
          headers: { Authorization: `Key ${apiKey}` },
        }, "fal.ai");
        if (status.status !== "COMPLETED") {
          return result({ status: status.status, requestId, queuePosition: status.queue_position, logs: status.logs ?? [], note: "The same job is still running. Poll this request ID again later." });
        }
        if (status.error || status.error_type) {
          return result({ status: "FAILED", requestId, error: status.error, errorType: status.error_type });
        }
        const output = await providerJson(job.responseUrl, {
          headers: { Authorization: `Key ${apiKey}` },
        }, "fal.ai");
        await env.OAUTH_KV.put(key, JSON.stringify({ ...job, completedAt: new Date().toISOString(), completed: true }), { expirationTtl: 60 * 60 * 24 * 7 });
        return result({ status: "COMPLETED", endpointId: job.endpointId, requestId, output });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "nexus_external_provider_status",
    {
      description: "Check whether Exa and fal.ai API credentials are configured on the NEXUS Worker. Never returns secret values.",
      inputSchema: z.object({}),
    },
    async () => result({
      exa: secret("EXA_API_KEY") ? "configured" : "missing_EXA_API_KEY",
      fal: secret("FAL_KEY") ? "configured" : "missing_FAL_KEY",
      vidIQ: "not configured in this NEXUS Worker; connect the separate vidIQ MCP server in your MCP client if needed",
      note: "ChatGPT app connections do not automatically transfer credentials or tool access to Claude. Configure provider API keys as Worker secrets.",
    }),
  );
}
