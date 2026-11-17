# NEXUS Universe YouTube Automation MCP

A remote MCP server that lets Claude and other MCP clients orchestrate a YouTube video-production workflow. It runs on Cloudflare Workers, authenticates users with Google OAuth, and exposes production-planning tools plus a private-only YouTube uploader.

> **Safety default:** uploads are restricted to `private`. There is no public/unlisted publishing option. The upload tool must never be used without the user's explicit approval.

## Current capabilities

| Tool | What it does | Execution status |
| --- | --- | --- |
| `nexus_plan_video` | Creates a structured project brief and production stages | Available |
| `nexus_create_storyboard` | Converts a script into timed scenes and visual prompts | Available; planning only |
| `nexus_build_publish_package` | Drafts YouTube title, description and tags | Available |
| `nexus_check_production_readiness` | Checks assets and explicit upload approval | Available |
| `nexus_create_render_manifest` | Creates and persists a renderer-neutral FFmpeg edit manifest from storyboard and asset IDs | Available; manifest only |
| `nexus_provider_status` | Reports configured and missing integrations | Available |
| `nexus_create_project`, `nexus_list_projects`, `nexus_get_project`, `nexus_update_project` | Account-scoped saved project management | Available; KV-backed |
| `nexus_update_project_stage` | Persist production-stage progress with revision checks | Available; KV-backed |
| `youtube_get_channel_overview` | Reads channel identity and aggregate statistics | Available after OAuth reconnect |
| `youtube_list_recent_videos` | Lists recent uploads and public video statistics | Available after OAuth reconnect |
| `youtube_get_channel_analytics` | Reads daily channel performance metrics | Available after OAuth reconnect |
| `youtube_upload_video` | Uploads a finished HTTPS video file to YouTube | Implemented; private only; 50 MB; explicit per-video approval |

## Not yet connected

The following require separate provider adapters and credentials; the MCP server does not pretend these functions are available until configured:

- Web research and competitor/trend discovery
- AI script and fact-checking provider
- Text-to-speech / voice generation
- Image and video generation
- Video rendering/editing service (FFmpeg or a hosted render worker); the MCP now prepares a persistent render manifest, but does not execute it
- Thumbnail generation
- YouTube comments, playlists and scheduling

Cloudflare Workers are used for orchestration and OAuth, not long-running video rendering. Heavy media processing should run in a dedicated render service or container and return a finished file URL for the uploader.

## Architecture

1. **MCP client / agent:** Claude plans work and invokes tools.
2. **Cloudflare Worker:** authenticates the MCP client and exposes tools at `/mcp`.
3. **Google OAuth:** grants private-upload and read-only channel/analytics permissions and stores refreshable authorization.
4. **Production workflow tools:** create briefs, storyboards, metadata drafts and readiness checks.
5. **Provider adapters (next phase):** research, voice, image/video generation and rendering.
6. **YouTube Data API:** uploads the final render as private content.

Video briefs, workflow stages, storyboards and metadata drafts can be persisted on each project. Project records are currently persisted under a dedicated `nexus:projects:v1:` key prefix in the existing KV namespace, scoped by a SHA-256 hash of the authenticated Google email. OAuth provider keys are not modified. KV is inexpensive and suitable for this initial low-volume project registry, but it is eventually consistent and does not provide transactional compare-and-swap; migrate to D1 before adding concurrent collaborators or stronger transactional guarantees. Each production job should eventually track stage status, retry information, asset references, cost estimates and an approval audit trail.

## Local development

Requirements: Node.js 22+ and npm.

```bash
npm install
npm run type-check
npm run dev
```

For local OAuth, create a separate Google OAuth web client and use `http://localhost:8788/callback` as its redirect URI. Put development-only credentials in `.dev.vars`:

```dotenv
GOOGLE_CLIENT_ID=your_development_client_id
GOOGLE_CLIENT_SECRET=your_development_client_secret
```

Do not commit `.dev.vars` or secrets.

## Cloudflare configuration

The production Worker is named `phn-youtube-mcp`. Its Wrangler configuration declares:

- `MCP_RESOURCE=https://phn-youtube-mcp.arnabls368.workers.dev/mcp`
- KV binding `OAUTH_KV` for the OAuth provider
- Existing secret names: `COOKIE_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

Keep secret values in Cloudflare's secret store. Never put them in source code, GitHub commits, logs or chat.

Google OAuth requests these scopes:

- `youtube.upload` for private video uploads
- `youtube.readonly` for channel and video read access
- `yt-analytics.readonly` for channel analytics

Existing authorizations do not gain new scopes automatically. Reconnect the Google account and approve the expanded read-only permissions before using channel insights tools.

The Google OAuth web client must include this redirect URI:

`https://phn-youtube-mcp.arnabls368.workers.dev/callback`

Enable both **YouTube Data API v3** and **YouTube Analytics API** in the associated Google Cloud project. The Analytics API is needed by the daily channel analytics tool.

## Connect an MCP client

For Claude Desktop or another client that supports remote MCP through `mcp-remote`, configure:

```json
{
  "mcpServers": {
    "nexus-youtube": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://phn-youtube-mcp.arnabls368.workers.dev/mcp"
      ]
    }
  }
}
```

Complete the Google OAuth flow when prompted. The connected account authorizes the YouTube upload tool.

## Deployment

The GitHub Actions workflow builds the Worker bundle and deploys only when the repository secret `CLOUDFLARE_API_TOKEN` is configured. The token should be restricted to the target Cloudflare account and Workers Scripts Write permission. If it is absent, deployment safely skips.

Never merge the draft pull request or create a test upload without explicit user approval. Verify the deployed `/mcp` endpoint and list tools with MCP Inspector before considering deployment complete.

## Upload behavior

- Only public HTTPS video URLs are accepted.
- The first implementation has a 50 MB file-size limit.
- Video visibility is schema-locked to `private`.
- Every upload requires explicit per-video user approval (`userApprovalConfirmed: true`).
- The tool reports the returned YouTube video ID.
- No video is uploaded during planning or readiness checks.
