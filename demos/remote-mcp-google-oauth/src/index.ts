import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";
import { readJsonLimited, refreshGoogleAccessToken } from "./utils";
import { registerProductionTools } from "./production-tools";
import { registerProviderTools } from "./provider-tools";

export type Props = {
  name: string;
  email: string;
  accessToken: string;
  refreshToken?: string;
};

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/** Read an untrusted video response without ever buffering more than the upload limit. */
async function readVideoBodyBounded(response: Response): Promise<ArrayBuffer> {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new Error("Video response has an invalid Content-Length header.");
    }
    if (parsedLength > MAX_VIDEO_BYTES) {
      throw new Error("Video exceeds the 50 MB limit for this first version.");
    }
  }
  if (!response.body) throw new Error("Video response has no readable body.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_VIDEO_BYTES) {
        await reader.cancel("Video exceeds upload size limit.");
        throw new Error("Video exceeds the 50 MB limit for this first version.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

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

    const uploaded = await fetch(parsedUploadUrl.toString(), {
      method: "PUT",
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
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
        const source = await fetch(parsedUrl.toString(), {
          redirect: "error",
          signal: AbortSignal.timeout(120_000),
        });
        if (!source.ok) {
          const status = source.status;
          await source.body?.cancel();
          throw new Error(`Could not download video (HTTP ${status}).`);
        }
        const mimeType = (source.headers.get("Content-Type") || "").split(";")[0].trim();
        if (!mimeType.startsWith("video/")) {
          await source.body?.cancel();
          throw new Error("The URL must return a video file.");
        }
        const videoBytes = await readVideoBodyBounded(source);

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
