# NEXUS Universe YouTube Automation MCP

NEXUS is a remote MCP server for planning and coordinating a YouTube video-production workflow. The Worker runs on Cloudflare, uses Google OAuth for account-scoped project and YouTube access, connects to Exa and fal.ai provider APIs, and hands media rendering to a separate FFmpeg service.

> **Safety defaults:** YouTube uploads are schema-locked to `private`, limited to 50 MiB, and require a client-mediated approval bound to the exact video bytes (SHA-256), title, description, privacy setting, and Google account. Planning and rendering do not publish videos. There is no public or unlisted upload mode.

## Current capabilities

| Area | Tools / behavior | Current boundary |
| --- | --- | --- |
| Planning | `nexus_plan_video`, `nexus_create_storyboard`, `nexus_build_publish_package` | Creates briefs, timed scene plans and metadata drafts; does not itself generate media |
| Projects | `nexus_create_project`, `nexus_list_projects`, `nexus_get_project`, `nexus_update_project`, `nexus_update_project_stage` | Google-account-scoped records in Cloudflare KV; KV is eventually consistent |
| Research | `nexus_research_web` | Exa-backed research; requires `EXA_API_KEY` |
| Media generation | `nexus_search_media_models`, `nexus_get_media_model_pricing`, `nexus_submit_media_generation`, `nexus_get_media_generation` | Live fal.ai model discovery (including optional input schemas) and pricing lookup are read-only; generation requires `FAL_KEY` and explicit per-operation approval |
| Renderer | `nexus_create_render_manifest`, `nexus_check_renderer_connection`, `nexus_transfer_render_asset`, `nexus_submit_render`, `nexus_get_render_status` | Transfers approved assets to private object storage and submits jobs to the separate FFmpeg service; live end-to-end provider verification remains outstanding |
| Channel insights | `youtube_get_channel_overview`, `youtube_list_recent_videos`, `youtube_get_channel_analytics` | Requires Google OAuth and the corresponding YouTube API scopes |
| Upload | `youtube_upload_video` | Private only; maximum 50 MiB; interactive approval for each exact upload |

The provider-status tools report whether integrations are configured. A configured credential or a successful health response is not proof that a complete provider workflow has succeeded.

## Architecture

1. **MCP client:** connects to the remote Worker and presents interactive approval requests when the client supports MCP elicitation.
2. **Cloudflare Worker:** hosts the MCP endpoint, Google OAuth integration, account-scoped project records, planning tools and provider adapters.
3. **Exa and fal.ai:** Exa supplies web research; fal.ai can submit and poll media-generation jobs. fal.ai usage may incur provider charges, so inspect endpoint pricing before approving a generation.
4. **Private asset storage:** generated assets can be transferred from supported HTTPS fal.ai media URLs into a private S3-compatible bucket using tenant/project-scoped object keys and signed requests.
5. **Railway FFmpeg renderer:** retrieves private assets, renders MP4 output, persists job records and output files on its mounted volume, and serves status/output through signed tenant/project-scoped requests.
6. **YouTube Data API:** uploads a completed video as private only after a separate exact-operation approval.

The renderer is intentionally a single-process, single-replica service. Its queue is in memory, with one concurrent render by default and a bounded queue; it is not a distributed job system. The Worker and renderer use bounded transfers (100 MiB for general assets; 50 MiB for staged YouTube video sources). Video sources are streamed into account/project-scoped private object storage, then read back in bounded byte ranges for YouTube resumable upload; the Worker does not buffer the complete video. Do not increase these limits without redesigning resource controls.

## Verification status and production gates

See the [production rollout runbook](./PRODUCTION-ROLLOUT.md) for the staged Cloudflare Durable Object migration, Railway cleanup enablement, private-storage verification and YouTube OAuth gates. The runbook is a checklist, not deployment authorization.

Automated checks cover the Worker type-check/build, approval decision helper, upload-source validation, renderer unit tests, Docker build, FFmpeg smoke encode, non-root startup and persistent-volume behavior. Storage tests use a mocked S3-compatible endpoint.

External video URL uploads are disabled by default. To enable them, set the Worker variable `YOUTUBE_UPLOAD_ALLOWED_HOSTS` to a comma-separated list of exact, operator-approved hostnames (for example, `media.example.org,cdn.example.net`). Matching is exact; wildcard and parent-domain matching are not supported. Keep the list narrow and use HTTPS-only origins. NEXUS render-job uploads do not use this external-host allowlist.

The following live-provider workflows have **not** yet been proven end to end:

- Real S3-compatible bucket PUT and GET using the deployed credentials.
- Authenticated Worker-to-renderer transfer of a synthetic asset.
- A real render job that retrieves private objects, creates an MP4, and returns it through the signed output route.
- Recovery of a real job/output across a Railway container restart.
- A complete authenticated Google OAuth and YouTube upload test.
- Enable and verify the renderer's staged-object cleanup sweep in Railway. The code now lists only `staged-assets/` objects and deletes video objects older than 24 hours; enable it with `NEXUS_STAGED_ASSET_CLEANUP_ENABLED=true`. It is not yet enabled in the live service. Railway Buckets do not currently support lifecycle configuration, so this scheduled sweep is the crash-recovery cleanup mechanism.

A healthy `/health` endpoint proves process liveness only. It does not prove storage access, rendering, output retrieval, OAuth, or YouTube upload.

### Railway volume prerequisite

The repository Dockerfile runs Node as the unprivileged `node` user. If the Railway service is deliberately switched from its current Railpack builder to this Dockerfile, review volume ownership and set `RAILWAY_RUN_UID=0` so the entrypoint can initialize only the `/work` and `/assets` mount roots before dropping privileges with `gosu`. The current Railway service uses Railpack, so this Dockerfile-specific setting is not currently active. Do not switch builders or deploy a changed renderer without an explicitly approved rollout. Existing job data is not recursively chowned.

## Local development

Requirements: Node.js 22+ and pnpm.

From the repository root:

```bash
pnpm install --filter remote-mcp-google-oauth...
pnpm --filter remote-mcp-google-oauth run type-check
pnpm --filter remote-mcp-google-oauth run dev
```

For local OAuth, create a separate Google OAuth web client and use `http://localhost:8788/callback` as its redirect URI. Put development-only credentials in `.dev.vars`:

```dotenv
GOOGLE_CLIENT_ID=your_development_client_id
GOOGLE_CLIENT_SECRET=your_development_client_secret
```

Do not commit `.dev.vars` or secrets.

## Cloudflare configuration

The Worker is named `phn-youtube-mcp`. Its Wrangler configuration declares:

- `MCP_RESOURCE=https://phn-youtube-mcp.arnab368.workers.dev/mcp`
- KV binding `OAUTH_KV` for account-scoped project records and OAuth provider data
- SQLite-backed Durable Object binding `OAUTH_STATE` for browser-bound OAuth state, atomic one-time consumption, and expiry cleanup
- Secret bindings including `COOKIE_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `EXA_API_KEY`, `FAL_KEY`, and renderer signing/configuration values.

Keep secret values in Cloudflare's secret store. Never put them in source code, GitHub commits, logs or chat.

**Live deployment gate:** the current Cloudflare Worker deployment has not yet been migrated to bind the `OAUTH_STATE` Durable Object declared above. The OAuth state flow must not be considered production-ready until the `v1` SQLite Durable Object migration and binding are deployed and verified. That migration is intentionally not performed as part of ordinary code development.


Google OAuth requests these scopes:

- `youtube.upload` for private video uploads
- `youtube.readonly` for channel and video read access
- `yt-analytics.readonly` for channel analytics

Existing authorizations do not gain new scopes automatically. Reconnect the Google account and approve the requested permissions before using channel-insights tools.

The Google OAuth web client must include this redirect URI:

`https://phn-youtube-mcp.arnab368.workers.dev/callback`

Enable both **YouTube Data API v3** and **YouTube Analytics API** in the associated Google Cloud project.

## Connect an MCP client

For Claude Desktop or another client that supports remote MCP through `mcp-remote`, configure:

```json
{
  "mcpServers": {
    "nexus-youtube": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://phn-youtube-mcp.arnab368.workers.dev/mcp"
      ]
    }
  }
}
```

Complete the Google OAuth flow when prompted. The connected account authorizes the YouTube tools. Interactive approval requires an MCP client that supports elicitation; if approval cannot be obtained, paid generation and upload must fail closed without performing the operation.

## Deployment

The YouTube MCP deployment workflow is **manual-only** (`workflow_dispatch`); pull requests and branch pushes do not deploy the Worker. A manual dispatch must also explicitly check the required `confirm_production_deploy` boolean input, which defaults to false, and must target `main`. The workflow requires the repository secret `CLOUDFLARE_API_TOKEN`, restricted to the target Cloudflare account and Workers Scripts Write permission. Do not dispatch it or deploy production as part of passive testing.

The pull request remains a draft. Do not merge it, deploy it, run live storage writes, start paid generation, or upload a video without the required explicit approval.

## Optional creator research with vidIQ

vidIQ provides a separate hosted remote MCP endpoint at `https://mcp.vidiq.com/mcp`. It can be connected as a second MCP server in a compatible client; it is not part of this Worker and its usage is subject to the vidIQ plan's limits and credits. See the [official vidIQ MCP setup guide](https://vidiq.com/mcp/).

## Upload behavior

- Accepts either a public HTTPS video URL or a completed NEXUS render job owned by the authenticated Google account.
- Maximum video size: 50 MiB; sources are streamed to private staging and uploaded to YouTube in 8 MiB ranges (final range may be smaller).
- Video visibility is schema-locked to `private`.
- The source is streamed into private account-scoped staging; its size and SHA-256 are verified from the renderer storage path.
- Before starting a YouTube upload session, the tool requests interactive approval bound to the connected Google account, video SHA-256, title, description and privacy setting.
- After approval, the uploader fetches bounded byte ranges from private staging and sends them through a resumable YouTube session; interrupted transfers query the acknowledged upload offset before retrying.
- Staged objects are explicitly deleted after the tool operation where possible. The Railway renderer's bounded scheduled sweep is the fallback for worker termination or network failure: it deletes only expired video objects under `staged-assets/`. Railway Buckets do not currently support the lifecycle policy needed here; do not apply a bucket-wide expiry because it could delete permanent assets.
- A decline, cancellation, missing approval context, or unsupported approval flow does not start an upload.
- No video is uploaded during planning, research, asset generation, rendering or readiness checks.
