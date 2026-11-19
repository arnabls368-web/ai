import { acceptedContent, inputRequired, inputResponse, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { env } from "cloudflare:workers";
import { getMcpAuthContext } from "agents/mcp/server";
import { readJsonLimited } from "./utils";
import { isFalGenerationFailed } from "./fal-status.mjs";
import { trustedFalUrl, validateFalJobRecord } from "./fal-provider-utils.mjs";
import { normalizeFalModelCatalogue, normalizeFalPricing } from "./fal-catalog-utils.mjs";
import { requestHumanApproval } from "./human-approval.mjs";
import { serializeApprovalBinding } from "./approval-binding.mjs";

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

const humanApprovalSchema = z.object({ confirm: z.boolean() });
const humanApprovalApi = {
  acceptedContent,
  inputRequired,
  inputResponse,
  approvalSchema: humanApprovalSchema,
  approvalWireSchema: {
    type: "object",
    properties: { confirm: { type: "boolean", title: "I approve this exact operation" } },
    required: ["confirm"],
  },
};

async function providerJson(url: string, init: RequestInit, provider: string): Promise<any> {
  // Provider-returned URLs must not be allowed to redirect requests to an
  // untrusted host or internal address. Bound both request duration and the
  // response body before parsing; upstream error bodies are never surfaced.
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`${provider} API request failed or timed out.`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${provider} API request failed (${response.status}).`);
  }
  try {
    return await readJsonLimited(response, 1_048_576);
  } catch {
    console.error(`${provider} API returned invalid or oversized JSON`);
    throw new Error(`${provider} API returned an invalid response.`);
  }
}



async function estimateFalCost(apiKey: string, endpointId: string, estimateType: "historical_api_price" | "unit_price", quantity: number): Promise<{ estimateType: string; totalCost: number; currency: string }> {
  const endpointEstimate = estimateType === "historical_api_price" ? { call_quantity: quantity } : { unit_quantity: quantity };
  const data = await providerJson("https://api.fal.ai/v1/models/pricing/estimate", {
    method: "POST",
    headers: { Authorization: `Key ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ estimate_type: estimateType, endpoints: { [endpointId]: endpointEstimate } }),
  }, "fal.ai cost estimate");
  if (!data || data.estimate_type !== estimateType || typeof data.total_cost !== "number" ||
      !Number.isFinite(data.total_cost) || data.total_cost < 0 ||
      typeof data.currency !== "string" || !/^[A-Z]{3}$/.test(data.currency)) {
    throw new Error("fal.ai returned an invalid cost estimate.");
  }
  return { estimateType, totalCost: data.total_cost, currency: data.currency };
}

export function registerProviderTools(server: McpServer) {
  server.registerTool(
    "nexus_search_media_models",
    {
      description: "Search fal.ai's live model catalogue before generation. Filter by keyword, category (for example text-to-video, image-to-video, text-to-image, text-to-speech), or exact endpoint ID. Optionally return the model's OpenAPI schema so you can construct valid model-specific input. Read-only; does not submit or bill a generation.",
      inputSchema: z.object({
        query: z.string().min(1).max(120).optional(),
        category: z.string().min(2).max(80).optional(),
        endpointId: z.string().min(3).max(200).optional(),
        cursor: z.string().min(1).max(512).optional(),
        limit: z.number().int().min(1).max(10).default(5),
        includeSchema: z.boolean().default(false),
      }),
    },
    async ({ query, category, endpointId, cursor, limit, includeSchema }) => {
      try {
        const apiKey = secret("FAL_KEY");
        if (!apiKey) throw new Error("fal.ai is not configured on this Worker. Add FAL_KEY as a Cloudflare Worker secret.");
        const url = new URL("https://api.fal.ai/v1/models");
        url.searchParams.set("limit", String(limit));
        url.searchParams.set("status", "active");
        if (query) url.searchParams.set("q", query);
        if (category) url.searchParams.set("category", category);
        if (endpointId) url.searchParams.set("endpoint_id", endpointId);
        if (cursor) url.searchParams.set("cursor", cursor);
        if (includeSchema) url.searchParams.append("expand", "openapi-3.0");
        const data = await providerJson(url.toString(), {
          headers: { Authorization: `Key ${apiKey}`, Accept: "application/json" },
        }, "fal.ai model catalogue");
        return result({
          ...normalizeFalModelCatalogue(data, limit, includeSchema),
          note: "Use the exact endpointId and inspect its schema before submitting generation. Catalogue metadata is not a price quote; check pricing separately. Search is read-only and does not create a billable job.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "nexus_get_media_model_pricing",
    {
      description: "Retrieve current fal.ai per-endpoint pricing and billing units before requesting paid image, audio or video generation. Read-only; does not submit a generation.",
      inputSchema: z.object({
        endpointId: z.string().min(3).max(200).regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,4}$/i),
      }),
    },
    async ({ endpointId }) => {
      try {
        const apiKey = secret("FAL_KEY");
        if (!apiKey) throw new Error("fal.ai is not configured on this Worker. Add FAL_KEY as a Cloudflare Worker secret.");
        const url = new URL("https://api.fal.ai/v1/models/pricing");
        url.searchParams.set("endpoint_id", endpointId);
        const data = await providerJson(url.toString(), {
          headers: { Authorization: `Key ${apiKey}`, Accept: "application/json" },
        }, "fal.ai pricing");
        return result({
          ...normalizeFalPricing(data, endpointId),
          note: "Prices and billing units are provider-reported and may change. Video models may bill per generated second or per video. Check the model's current pricing immediately before approving generation; this is not a guaranteed final charge.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "nexus_estimate_media_generation_cost",
    {
      description: "Estimate fal.ai cost for one endpoint using historical per-call pricing or a known number of billing units. Read-only; does not submit a generation. Estimates are advisory, not guaranteed charges.",
      inputSchema: z.object({
        endpointId: z.string().min(3).max(200).regex(/^[a-z0-9][a-z0-9._-]*(\\/[a-z0-9][a-z0-9._-]*){1,4}$/i),
        estimateType: z.enum(["historical_api_price", "unit_price"]).default("historical_api_price"),
        callQuantity: z.number().int().min(1).max(100000).optional(),
        unitQuantity: z.number().positive().max(100000000).optional(),
      }),
    },
    async ({ endpointId, estimateType, callQuantity, unitQuantity }) => {
      try {
        const apiKey = secret("FAL_KEY");
        if (!apiKey) throw new Error("fal.ai is not configured on this Worker. Add FAL_KEY as a Cloudflare Worker secret.");
        if (estimateType === "historical_api_price" && (callQuantity === undefined || unitQuantity !== undefined)) throw new Error("historical_api_price requires callQuantity and does not accept unitQuantity.");
        if (estimateType === "unit_price" && (unitQuantity === undefined || callQuantity !== undefined)) throw new Error("unit_price requires unitQuantity and does not accept callQuantity.");
        const quantity = estimateType === "historical_api_price" ? callQuantity! : unitQuantity!;
        const estimate = await estimateFalCost(apiKey, endpointId, estimateType, quantity);
        return result({
          endpointId, ...estimate, quantity,
          note: estimateType === "historical_api_price"
            ? "Historical per-call estimate based on fal.ai usage patterns; it may not reflect this request's exact settings."
            : "Unit-price estimate based on the supplied billing-unit quantity. Ensure the quantity matches this model's billing unit.",
          disclaimer: "Advisory estimate only, not a quote or guaranteed final charge. Model settings, successful output quantity, account discounts and provider pricing changes can affect the actual cost.",
        });
      } catch (error) { return failure(error); }
    },
  );

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
      description: "Submit an image, voice, music or video generation request to a fal.ai model endpoint. NEXUS first obtains a historical one-call cost estimate and includes it in the approval dialog; if estimation fails, submission fails closed. Requires FAL_KEY and interactive user approval before any billable request is sent. The approval dialog displays the exact endpoint, input and advisory estimate. Use an exact endpoint ID from fal model catalogue; pass model-specific input matching that model schema. The result is asynchronous.",
      inputSchema: z.object({
        endpointId: z.string().min(3).max(200).regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,4}$/i),
        input: z.record(z.string(), z.unknown()),
      }),
    },
    async ({ endpointId, input }, ctx) => {
      try {
        // Require a verified account and display the exact endpoint + input before
        // creating a billable provider job. Never trust a model-supplied boolean.
        const scope = await accountScope();
        const auth = getMcpAuthContext()?.props as { email?: string } | undefined;
        const account = auth?.email?.trim().toLowerCase();
        if (!account) throw new Error("A signed-in Google account with an email address is required.");
        const inputJson = JSON.stringify(input);
        if (typeof inputJson !== "string" || inputJson.length > 12_000) {
          throw new Error("Generation input exceeds the 12,000-character approval display limit; reduce it before requesting generation.");
        }
        const apiKey = secret("FAL_KEY");
        if (!apiKey) throw new Error("fal.ai is not configured on this Worker. Add FAL_KEY as a Cloudflare Worker secret.");
        const estimate = await estimateFalCost(apiKey, endpointId, "historical_api_price", 1);
        const estimateJson = JSON.stringify(estimate);
        const approvalDigest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(serializeApprovalBinding([account, endpointId, inputJson, estimateJson])),
        );
        const approvalKey = "fal-generation-" + Array.from(new Uint8Array(approvalDigest), (value) => value.toString(16).padStart(2, "0")).join("");
        const approval = requestHumanApproval(
          ctx,
          approvalKey,
          "PAID fal.ai generation approval\\n" +
          "Google account: " + account + "\\n" +
          "Endpoint: " + endpointId + "\\n" +
          "Historical one-call cost estimate: " + estimate.currency + " " + estimate.totalCost + "\\n" +
          "Exact input JSON:\\n" + inputJson + "\\n" +
          "IMPORTANT: This is an advisory historical estimate, not a quote. Actual charges depend on successful output units, model settings, account pricing and current provider rates. If you approve, only this exact endpoint and input will be submitted.",
          humanApprovalApi,
        );
        if (!approval.approved) {
          if ("inputRequired" in approval) return approval.inputRequired;
          return failure("Generation was not approved. No fal.ai job was submitted.");
        }
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
          ...(typeof submitted.cancel_url === "string" ? { cancelUrl: trustedFalUrl(submitted.cancel_url) } : {}),
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
        // Treat KV records as untrusted at the point of use too: validate their
        // shape and provider origins before attaching the secret API key.
        const validatedJob = validateFalJobRecord(job, requestId);
        const statusUrl = validatedJob.statusUrl;
        const responseUrl = validatedJob.responseUrl;
        const status = await providerJson(statusUrl, {
          headers: { Authorization: `Key ${apiKey}` },
        }, "fal.ai");
        // fal.ai can report FAILED with an error payload. Handle terminal
        // failures before the generic non-COMPLETED branch so diagnostics are
        // not accidentally presented as a job that is still running.
        if (isFalGenerationFailed(status)) {
          return result({ status: "FAILED", requestId, error: status.error, errorType: status.error_type });
        }
        if (status.status !== "COMPLETED") {
          return result({ status: status.status, requestId, queuePosition: status.queue_position, logs: status.logs ?? [], note: "The same job is still running. Poll this request ID again later." });
        }
        const output = await providerJson(responseUrl, {
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
    "nexus_cancel_media_generation",
    {
      description: "Request cancellation of a fal.ai generation job submitted by the signed-in Google account. A queued job may be removed; an in-progress runner receives a cancellation signal, but stopping is model-dependent. Does not cancel or refund work already completed.",
      inputSchema: z.object({ requestId: z.string().uuid() }),
    },
    async ({ requestId }) => {
      try {
        const apiKey = secret("FAL_KEY");
        if (!apiKey) throw new Error("fal.ai is not configured on this Worker. Add FAL_KEY as a Cloudflare Worker secret.");
        const scope = await accountScope();
        const key = "nexus:fal-jobs:v1:" + scope + ":" + requestId;
        const job = await env.OAUTH_KV.get<{ endpointId: string; requestId: string; statusUrl: string; responseUrl: string; cancelUrl?: string; createdAt: string }>(key, "json");
        if (!job) throw new Error("fal.ai job not found for this account, or its 7-day tracking record expired.");
        const validatedJob = validateFalJobRecord(job, requestId);
        if (!validatedJob.cancelUrl) {
          throw new Error("This job predates cancellation support and has no saved fal.ai cancellation URL. It can still be checked with nexus_get_media_generation.");
        }
        const cancellation = await providerJson(validatedJob.cancelUrl, {
          method: "PUT",
          headers: { Authorization: "Key " + apiKey, Accept: "application/json" },
        }, "fal.ai cancellation");
        const status = cancellation.status;
        if (!["OK", "CANCELLATION_REQUESTED", "ALREADY_COMPLETED", "NOT_FOUND"].includes(status)) {
          throw new Error("fal.ai returned an unexpected cancellation status.");
        }
        return result({
          status,
          requestId,
          endpointId: validatedJob.endpointId,
          note: status === "CANCELLATION_REQUESTED"
            ? "Cancellation was requested. Check the same request ID; an in-progress model runner may take time to stop."
            : status === "ALREADY_COMPLETED"
              ? "The generation had already completed; cancellation did not undo the completed work or its charges."
              : status === "NOT_FOUND"
                ? "fal.ai could not find this request; check its status using the same request ID."
                : "fal.ai accepted the cancellation request.",
        });
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
