import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { acceptedContent, inputRequired, inputResponse, McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";
import { readJsonLimited, refreshGoogleAccessToken } from "./utils";
import { registerProductionTools } from "./production-tools";
import { registerProviderTools } from "./provider-tools";
import { callPrivateRenderer } from "./render-auth";
import { hasExactlyOneUploadSource, isVerifiedRenderJob } from "./upload-source.mjs";
import { uploadResumableVideoFromRanges } from "./youtube-resumable.mjs";
import { stageVideoSource, createStagedVideoRangeReader, deleteStagedVideoAsset } from "./staged-video.mjs";
import { requestHumanApproval } from "./human-approval.mjs";
import { serializeApprovalBinding } from "./approval-binding.mjs";
import { validateExternalVideoUrl } from "./external-video-url.mjs";
export { OAuthStateDO } from "./oauth-state-do";

export type Props = {
  name: string;
  email: string;
  accessToken: string;
  refreshToken?: string;
};

const uploadApprovalSchema = z.object({
  confirm: z.boolean().meta({ title: "I approve this exact private YouTube upload" }),
});
const uploadApprovalWireSchema = {
  type: "object",
  properties: {
    confirm: { type: "boolean", title: "I approve this exact private YouTube upload" },
  },
  required: ["confirm"],
  additionalProperties: false,
};
const humanApprovalApi = {
  inputResponse,
  acceptedContent,
  inputRequired,
  approvalSchema: uploadApprovalSchema,
  approvalWireSchema: uploadApprovalWireSchema,
};

async function uploadToYouTube(
  totalBytes: number,
  readRange: (start: number, end: number) => Promise<{ body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array; byteLength: number }>,
  mimeType: string,
  title: string,
  description: string,
  privacyStatus: "private",
  initialAccessToken: string,
  refreshToken?: string,
): Promise<{ videoId: string; privacyStatus: string }> {
  const metadata = {
    snippet: { title, description },
    status: { privacyStatus },
  };

  const startUpload = async (token: string) => {
    const start = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": mimeType,
          "X-Upload-Content-Length": String(totalBytes),
        },
        body: JSON.stringify(metadata),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!start.ok) return { response: start };
    const uploadUrl = start.headers.get("Location");
    if (!uploadUrl) throw new Error("YouTube did not return an upload URL");

    // The resumable URL is returned by Google's authenticated API. Validate
    // its origin before forwarding the user's OAuth bearer token to it.
    let parsedUploadUrl: URL;
    try {
      parsedUploadUrl = new URL(uploadUrl);
    } catch {
      throw new Error("YouTube returned an invalid resumable upload URL.");
    }
    if (parsedUploadUrl.protocol !== "https:" ||
        parsedUploadUrl.hostname !== "www.googleapis.com" ||
        parsedUploadUrl.port || parsedUploadUrl.username ||
        parsedUploadUrl.password || parsedUploadUrl.hash) {
      throw new Error("YouTube returned an unexpected upload URL; refusing to send authorization credentials.");
    }

    const uploaded = await uploadResumableVideoFromRanges({
      uploadUrl: parsedUploadUrl.toString(),
      totalBytes,
      readRange,
      mimeType,
      accessToken: token,
    });
    return { response: uploaded };
  };

  let result = await startUpload(initialAccessToken);
  if (result.response.status === 401 && refreshToken) {
    await result.response.body?.cancel();
    const renewed = await refreshGoogleAccessToken(
      refreshToken,
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
    );
    if (!renewed) throw new Error("Google authorization expired. Please reconnect YouTube.");
    result = await startUpload(renewed);
  }
  if (!result.response.ok) {
    const status = result.response.status;
    await result.response.body?.cancel();
    throw new Error(`YouTube upload failed (${status}). Check the connected account's YouTube permissions and try again.`);
  }
  let uploadedVideo: unknown;
  try {
    uploadedVideo = await readJsonLimited(result.response, 65_536);
  } catch {
    throw new Error("YouTube returned an invalid upload confirmation.");
  }
  if (!uploadedVideo || typeof uploadedVideo !== "object" || !("id" in uploadedVideo) || typeof uploadedVideo.id !== "string" || !uploadedVideo.id) {
    throw new Error("YouTube upload completed but no valid video ID was returned");
  }
  return { videoId: uploadedVideo.id, privacyStatus };
}

function createServer() {
  const server = new McpServer({
    name: "NEXUS Universe YouTube Automation MCP",
    version: "1.2.0",
  });

  server.registerTool(
    "youtube_upload_video",
    {
      description: "Upload a finished video to the authenticated YouTube channel. Accepts either a public HTTPS video URL or a completed NEXUS private renderer job belonging to the authenticated Google account. Videos are private only. The tool displays an interactive approval request bound to the connected Google account, source, MIME type, file size, exact video SHA-256, title and description before upload. Maximum file size: 50 MB.",
      inputSchema: z.object({
        videoUrl: z.string().url().optional(),
        projectId: z.string().uuid().optional(),
        renderJobId: z.string().uuid().optional(),
        title: z.string().min(1).max(100),
        description: z.string().max(5000).optional(),
        privacyStatus: z.literal("private").default("private"),
      }).refine(hasExactlyOneUploadSource, "Provide either videoUrl OR both projectId and renderJobId."),
    },
    async ({ videoUrl, projectId, renderJobId, title, description, privacyStatus }, ctx) => {
      const auth = getMcpAuthContext()?.props as Props | undefined;
      if (!auth?.accessToken) return { isError: true, content: [{ type: "text", text: "YouTube is not connected. Reconnect your Google account." }] };
      let cleanupStagedAsset: (() => Promise<void>) | undefined;
      try {
        const email = auth.email?.trim().toLowerCase();
        if (!email) throw new Error("The authenticated Google account has no verified email scope.");
        const ownerDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
        const owner = Array.from(new Uint8Array(ownerDigest), (value) => value.toString(16).padStart(2, "0")).join("");
        let source: Response;
        if (projectId && renderJobId) {
          const key = "nexus:projects:v1:" + owner + ":" + projectId;
          const project = await env.OAUTH_KV.get<any>(key, "json");
          if (!isVerifiedRenderJob(project, projectId, renderJobId)) throw new Error("The render job was not found as a completed output in a project owned by this Google account.");
          const bindings = env as unknown as Record<string, unknown>;
          if (typeof bindings.NEXUS_RENDERER_URL !== "string" || typeof bindings.NEXUS_RENDER_SIGNING_SECRET !== "string") throw new Error("The private NEXUS renderer is not configured on this Worker.");
          source = await callPrivateRenderer({
            baseUrl: bindings.NEXUS_RENDERER_URL, secret: bindings.NEXUS_RENDER_SIGNING_SECRET,
            tenantId: owner, projectId, scope: "render:read",
            path: "/jobs/" + renderJobId + "/output", method: "GET",
          });
        } else {
          const bindings = env as unknown as Record<string, unknown>;
          const allowedHosts = typeof bindings.YOUTUBE_UPLOAD_ALLOWED_HOSTS === "string"
            ? bindings.YOUTUBE_UPLOAD_ALLOWED_HOSTS
            : "";
          const safeUrl = validateExternalVideoUrl(videoUrl!, allowedHosts);
          source = await fetch(safeUrl, { redirect: "error", signal: AbortSignal.timeout(120_000) });
        }
        if (!source.ok) { const status = source.status; await source.body?.cancel(); throw new Error("Could not retrieve video (HTTP " + status + ")."); }
        const mimeType = (source.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
        if (!["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"].includes(mimeType)) {
          await source.body?.cancel();
          throw new Error("The video source must return MP4, MOV, WebM, or Matroska content.");
        }
        const sourceLabel = projectId && renderJobId
          ? "NEXUS render project " + projectId + ", job " + renderJobId
          : "External HTTPS source host " + new URL(videoUrl!).hostname;
        // Stream into private, account-scoped staging instead of buffering the video in this Worker.
        const stagingBindings = env as unknown as Record<string, unknown>;
        if (typeof stagingBindings.NEXUS_RENDERER_URL !== "string" || typeof stagingBindings.NEXUS_RENDER_SIGNING_SECRET !== "string") {
          await source.body?.cancel();
          throw new Error("Private NEXUS staging storage is not configured on this Worker.");
        }
        const rendererProjectId = projectId ?? "youtube-uploads";
        const callStagingRenderer = (request: {
          method: "GET" | "PUT" | "DELETE";
          scope: "asset:read" | "asset:write" | "asset:delete";
          path: string;
          rawBody?: ReadableStream<Uint8Array>;
          contentType?: string;
          range?: string;
        }) => callPrivateRenderer({
          baseUrl: stagingBindings.NEXUS_RENDERER_URL as string,
          secret: stagingBindings.NEXUS_RENDER_SIGNING_SECRET as string,
          tenantId: owner,
          projectId: rendererProjectId,
          ...request,
        });
        const staged = await stageVideoSource({ source, mimeType, callRenderer: callStagingRenderer });
        cleanupStagedAsset = () => deleteStagedVideoAsset({
          assetId: staged.assetId,
          extension: staged.extension,
          callRenderer: callStagingRenderer,
        });
        const readRange = createStagedVideoRangeReader({
          assetId: staged.assetId,
          extension: staged.extension,
          totalBytes: staged.totalBytes,
          callRenderer: callStagingRenderer,
        });
        // Approval binds the exact staged digest and metadata before YouTube upload begins.
        const videoSha256 = staged.sha256;
        const approvalDigest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(serializeApprovalBinding([
            auth.email.trim().toLowerCase(),
            sourceLabel,
            mimeType,
            String(staged.totalBytes),
            videoSha256,
            title,
            description || "",
            privacyStatus,
          ])),
        );
        const approvalKey = "youtube-upload-" + Array.from(new Uint8Array(approvalDigest), (value) => value.toString(16).padStart(2, "0")).join("");
        const approval = requestHumanApproval(
          ctx,
          approvalKey,
          [
            "YOUTUBE PRIVATE UPLOAD APPROVAL",
            "Google channel account: " + auth.email,
            "Source: " + sourceLabel,
            "Video size: " + staged.totalBytes + " bytes",
            "Media type: " + mimeType,
            "Video SHA-256: " + videoSha256,
            "Title: " + title,
            "Description: " + (description || ""),
            "Visibility: private",
            "Confirm only if you approve uploading these exact video bytes and metadata to this Google account.",
          ].join("\n"),
          humanApprovalApi,
        );
        if (!approval.approved) {
          if ("inputRequired" in approval) return approval.inputRequired;
          return { isError: true, content: [{ type: "text", text: "YouTube upload was not approved. No upload session was started." }] };
        }
        const uploaded = await uploadToYouTube(staged.totalBytes, readRange, mimeType, title, description || "", privacyStatus, auth.accessToken, auth.refreshToken);
        return { content: [{ type: "text", text: "Video uploaded successfully. Video ID: " + uploaded.videoId + ". URL: https://www.youtube.com/watch?v=" + uploaded.videoId + ". Visibility: " + uploaded.privacyStatus + "." }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown upload error";
        return { isError: true, content: [{ type: "text", text: message }] };
      } finally {
        if (cleanupStagedAsset) {
          try { await cleanupStagedAsset(); } catch { /* Object lifecycle expiry is the fallback. */ }
        }
      }
    },
  );

  registerProductionTools(server);
  registerProviderTools(server);
  return server;
}

const mcpHandler = createMcpHandler(createServer);

export default new OAuthProvider<Env>({
  apiHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      return mcpHandler(request, env, ctx);
    },
  },
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GoogleHandler as any,
  tokenEndpoint: "/token",
  resourceMetadata: { resource: env.MCP_RESOURCE },
});
