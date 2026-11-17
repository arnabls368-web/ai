import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";
import { refreshGoogleAccessToken } from "./utils";
import { registerProductionTools } from "./production-tools";
import { registerProviderTools } from "./provider-tools";

export type Props = {
  name: string;
  email: string;
  accessToken: string;
  refreshToken?: string;
};

async function uploadToYouTube(
  videoBytes: ArrayBuffer,
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
          "X-Upload-Content-Length": String(videoBytes.byteLength),
        },
        body: JSON.stringify(metadata),
      },
    );
    if (!start.ok) return { response: start };
    const uploadUrl = start.headers.get("Location");
    if (!uploadUrl) throw new Error("YouTube did not return an upload URL");

    const uploaded = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": mimeType,
      },
      body: videoBytes,
    });
    return { response: uploaded };
  };

  let result = await startUpload(initialAccessToken);
  if (result.response.status === 401 && refreshToken) {
    const renewed = await refreshGoogleAccessToken(
      refreshToken,
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
    );
    if (!renewed) throw new Error("Google authorization expired. Please reconnect YouTube.");
    result = await startUpload(renewed);
  }
  if (!result.response.ok) {
    const detail = await result.response.text();
    throw new Error(`YouTube upload failed (${result.response.status}): ${detail.slice(0, 500)}`);
  }
  const uploadedVideo = (await result.response.json()) as { id?: string };
  if (!uploadedVideo.id) throw new Error("YouTube upload completed but no video ID was returned");
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
      description:
        "Upload a finished video from a publicly reachable HTTPS video URL to the authenticated YouTube channel. Videos are private only. Before invoking this tool, obtain the user's explicit approval for this exact video and title, then set userApprovalConfirmed=true. Never infer approval from a general request to automate the channel. Maximum file size: 50 MB.",
      inputSchema: z.object({
        videoUrl: z.string().url().describe("Direct HTTPS URL to the finished video file"),
        title: z.string().min(1).max(100),
        description: z.string().max(5000).optional(),
        privacyStatus: z.literal("private").default("private"),
        userApprovalConfirmed: z.literal(true).describe("Must be true only after the user explicitly approves this exact video and title in the current conversation."),
      }),
    },
    async ({ videoUrl, title, description, privacyStatus, userApprovalConfirmed }) => {
      const auth = getMcpAuthContext()?.props as Props | undefined;
      if (userApprovalConfirmed !== true) {
        return { isError: true, content: [{ type: "text", text: "Explicit user approval for this exact private upload is required." }] };
      }
      if (!auth?.accessToken) {
        return { isError: true, content: [{ type: "text", text: "YouTube is not connected. Reconnect your Google account." }] };
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(videoUrl);
      } catch {
        return { isError: true, content: [{ type: "text", text: "Invalid video URL." }] };
      }
      if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.hostname === "localhost" || parsedUrl.hostname.endsWith(".localhost") || parsedUrl.hostname.endsWith(".local") || parsedUrl.hostname === "metadata.google.internal" || /^127\./.test(parsedUrl.hostname) || /^10\./.test(parsedUrl.hostname) || /^192\.168\./.test(parsedUrl.hostname) || /^169\.254\./.test(parsedUrl.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(parsedUrl.hostname) || parsedUrl.hostname === "::1" || parsedUrl.hostname.startsWith("[")) {
        return { isError: true, content: [{ type: "text", text: "Use a public HTTPS video URL." }] };
      }

      try {
        const source = await fetch(parsedUrl.toString(), { redirect: "error" });
        if (!source.ok) throw new Error(`Could not download video (HTTP ${source.status})`);
        const mimeType = (source.headers.get("Content-Type") || "").split(";")[0].trim();
        if (!mimeType.startsWith("video/")) throw new Error("The URL must return a video file.");
        const length = Number(source.headers.get("Content-Length") || 0);
        if (length > 50 * 1024 * 1024) throw new Error("Video exceeds the 50 MB limit for this first version.");
        const videoBytes = await source.arrayBuffer();
        if (videoBytes.byteLength > 50 * 1024 * 1024) throw new Error("Video exceeds the 50 MB limit for this first version.");

        const uploaded = await uploadToYouTube(
          videoBytes,
          mimeType,
          title,
          description || "",
          privacyStatus,
          auth.accessToken,
          auth.refreshToken,
        );
        return {
          content: [{
            type: "text",
            text: `Video uploaded successfully. Video ID: ${uploaded.videoId}. URL: https://www.youtube.com/watch?v=${uploaded.videoId}. Visibility: ${uploaded.privacyStatus}.`,
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown upload error";
        return { isError: true, content: [{ type: "text", text: message }] };
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
