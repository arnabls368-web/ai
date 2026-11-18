# NEXUS FFmpeg Renderer

A small, provider-neutral FFmpeg rendering engine for NEXUS. It consumes the persisted render manifest produced by `nexus_create_render_manifest` plus a local asset map, and creates an MP4 file.

## Current capabilities

- Still-image and video scene inputs.
- Exact contiguous scene timing with cover/contain fitting.
- 720p or 1080p output in 16:9, 9:16 or 1:1.
- 24, 25, 30 or 60 FPS.
- Optional voiceover and background music.
- Optional music ducking under narration.
- H.264 video, AAC audio and fast-start MP4 output.
- Validates canonical local asset paths, rejects symlinks escaping the asset directory, and checks media types again after symlink resolution.
- Allows only explicit image/video/audio file extensions; playlist and manifest-based media inputs are rejected.
- Restricts FFmpeg input protocols to local files and disables interactive stdin.
- Uses `spawn` with argument arrays; it does not interpolate user input into a shell command.
- Enforces a duration-scaled FFmpeg execution timeout, capped at six hours.

## Run locally

Requires Node.js 22+ and FFmpeg on PATH.

```bash
pnpm --filter nexus-ffmpeg-renderer test
pnpm --filter nexus-ffmpeg-renderer render -- manifest.json asset-map.json ./assets ./final.mp4
```

The asset map is a JSON object mapping manifest asset IDs to relative file paths inside the asset directory:

```json
{
  "scene-1": "scene-1.png",
  "scene-2": "scene-2.mp4",
  "voiceover-1": "voiceover.wav",
  "music-1": "music.mp3"
}
```

The asset IDs must match the scene, voiceover and music IDs in the NEXUS render manifest.

## Docker

```bash
docker build -t nexus-ffmpeg-renderer demos/nexus-ffmpeg-renderer
docker run --rm -v "$PWD/render-input:/input" -v "$PWD/render-output:/output" \
  nexus-ffmpeg-renderer /input/manifest.json /input/asset-map.json /input/assets /output/final.mp4
```

## Authenticated render-job API

The package includes a Node HTTP service for a **persistent, single-process render API**. It accepts a manifest and asset-ID map, queues a render, exposes job status, and streams the completed MP4. It never accepts remote asset URLs: assets must already exist under the server's configured local asset directory.

```bash
# Generate a strong bearer token outside the repository.
export NEXUS_RENDER_TOKEN="$(openssl rand -hex 32)"
docker build -t nexus-ffmpeg-renderer demos/nexus-ffmpeg-renderer
mkdir -p ./render-assets ./render-work
docker run --rm -p 8080:8080 \
  -e NEXUS_RENDER_TOKEN \
  -e NEXUS_ASSET_ROOT=/assets \
  -e NEXUS_RENDER_WORKDIR=/work \
  -v "$PWD/render-assets:/assets:ro" \
  -v "$PWD/render-work:/work" \
  nexus-ffmpeg-renderer src/server.mjs
```

- `GET /health` — health check.
- `POST /jobs` — authenticated JSON body: `{"manifest":{...},"assetMap":{"asset-id":"file.png"}}`; returns HTTP 202 and a job ID.
- `GET /jobs/:id` — authenticated job status.
- `GET /jobs/:id/output` — authenticated MP4 download after success.

### Tenant-bound signed authorization (preferred)

Set `NEXUS_RENDER_SIGNING_SECRET` to a random secret of at least 32 characters. When this variable is configured, signed credentials are required and the legacy shared bearer token is not accepted. The signed token format is HMAC-SHA256 over a base64url JSON claim set. Claims bind the credential to:
- `aud: "nexus-renderer"`
- `tenantId` and `projectId`
- `scope: "render:submit"` or `"render:read"`
- `iat` and `exp`, with a maximum lifetime of five minutes.

The API rejects expired, altered, wrong-scope and wrong-tenant/project credentials. A job record is only visible to the same tenant and project that submitted it. Tenant and project identifiers are not included in public job responses. The Cloudflare Worker mints separate short-lived submit/read tokens using the same secret; Google OAuth credentials are never sent to the renderer.

For local development only, if `NEXUS_RENDER_SIGNING_SECRET` is absent, the service may accept the legacy `NEXUS_RENDER_TOKEN` shared bearer credential. The fallback is automatically disabled when `NODE_ENV=production`; production startup fails unless `NEXUS_RENDER_SIGNING_SECRET` is configured. This is deliberately fail-closed and is not suitable to work around by setting production mode off on a public host.

The API requires JSON submissions, limits request bodies to 1 MiB, applies bounded HTTP request/header/keep-alive timeouts, persists job metadata and queued work as atomic JSON files under `NEXUS_RENDER_WORKDIR`, retries jobs interrupted while running when the service restarts, keeps at most 100 terminal job records, stores job directories as owner-only (0700), job records as owner-only (0600), and completed MP4 files as owner-only (0600), and runs at most one render by default. Mount `/work` on persistent storage; without that persistent mount, job state and output files are lost when the container is removed. Mount a trusted asset directory read-only. For isolated local rendering, add `--read-only --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=128` and a bounded writable `/tmp` tmpfs. Do not use `--network=none` for a hosted API that must accept private service traffic; enforce private ingress at the container host instead. Do not put signing secrets or tokens in source control or logs.


### Worker-side signed connectivity check

The Cloudflare Worker contains a matching Web Crypto HMAC-SHA256 token signer and the `nexus_check_renderer_connection` MCP tool. The tool first loads the requested project using the authenticated Google-account owner key, then mints a short-lived read token for that exact tenant/project and calls the renderer's authenticated `GET /auth-check` endpoint. The renderer never trusts a tenant or project supplied by the MCP caller.

The deployed Worker integration uses `NEXUS_RENDERER_URL` and `NEXUS_RENDER_SIGNING_SECRET` to call the renderer. It provides `nexus_check_renderer_connection`, `nexus_transfer_render_asset`, `nexus_submit_render`, and `nexus_get_render_status`. Asset transfer accepts HTTPS `fal.media` sources, applies a 100 MiB limit and MIME checks, then writes bytes to tenant/project-scoped private S3-compatible storage. Render submission verifies that referenced asset IDs exist in the authenticated project's saved asset inventory before sending a manifest to the renderer; the renderer resolves those IDs to private objects and local work files. The renderer output endpoint is then fetched by the Worker for the YouTube upload tool, which verifies the project/job ownership and successful job state. YouTube uploads are private-only, require explicit approval for the exact video and title, and are limited to 50 MiB.

**Important limits:** this remains a single-process render queue and must stay at one replica. It has no distributed queue, idempotency keys, cancellation, authenticated callbacks, or multi-replica coordination. The Railway service has public HTTPS ingress protected by short-lived HMAC credentials; this is not private-network-only ingress. S3-compatible storage is configured, but provider-level upload/download interoperability still needs a real integration test. The Worker currently buffers transferred assets (up to 100 MiB) and completed videos (up to 50 MiB); optimize memory use before increasing these limits. Asset lifecycle cleanup and end-to-end render-to-YouTube testing are still outstanding.

## Deliberate boundaries

The CLI is the rendering engine. The authenticated HTTP service is an early persistent single-process job API. The Cloudflare Worker handles asset intake, private object storage, render orchestration and the authenticated output-to-YouTube handoff. YouTube upload remains a separate, approval-gated action and always sets visibility to private.

No paid service or Cloudflare resource is created by this package.
