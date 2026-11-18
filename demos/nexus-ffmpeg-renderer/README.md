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
- Validates local asset paths and rejects symlinks escaping the asset directory.
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

The API rejects expired, altered, wrong-scope and wrong-tenant/project credentials. A job record is only visible to the same tenant and project that submitted it. Tenant and project identifiers are not included in public job responses. The Worker must mint separate short-lived submit/read tokens using the same secret; do not send Google OAuth credentials to the renderer.

For local development only, if `NEXUS_RENDER_SIGNING_SECRET` is absent, the service may accept the legacy `NEXUS_RENDER_TOKEN` shared bearer credential. The fallback is automatically disabled when `NODE_ENV=production`; production startup fails unless `NEXUS_RENDER_SIGNING_SECRET` is configured. This is deliberately fail-closed and is not suitable to work around by setting production mode off on a public host.

The API requires JSON submissions, limits request bodies to 1 MiB, applies bounded HTTP request/header/keep-alive timeouts, persists job metadata and queued work as atomic JSON files under `NEXUS_RENDER_WORKDIR`, retries jobs interrupted while running when the service restarts, keeps at most 100 terminal job records, and runs at most one render by default. Mount `/work` on persistent storage; without that persistent mount, job state and output files are lost when the container is removed. Mount a trusted asset directory read-only. For isolated local rendering, add `--read-only --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=128` and a bounded writable `/tmp` tmpfs. Do not use `--network=none` for a hosted API that must accept private service traffic; enforce private ingress at the container host instead. Do not put signing secrets or tokens in source control or logs.


### Worker-side signed connectivity check

The Cloudflare Worker contains a matching Web Crypto HMAC-SHA256 token signer and the `nexus_check_renderer_connection` MCP tool. The tool first loads the requested project using the authenticated Google-account owner key, then mints a short-lived read token for that exact tenant/project and calls the renderer's authenticated `GET /auth-check` endpoint. The renderer never trusts a tenant or project supplied by the MCP caller.

The Worker integration is dormant until both `NEXUS_RENDERER_URL` and `NEXUS_RENDER_SIGNING_SECRET` are configured as Worker secrets and a private renderer host exists. The connectivity check does not submit jobs. Actual render submission remains disabled until trusted R2 asset transfer and asset-ID-to-file resolution are implemented; callers must never be allowed to submit arbitrary local filesystem paths.

**Important limits:** this remains a single-process prototype. It is not a distributed queue and does not yet provide R2 object ownership checks, idempotency keys, cancellation, authenticated callbacks to the Worker, or multi-replica coordination. Do not expose it publicly or treat it as a production multi-tenant service until the Worker token-minting integration, private networking, R2 validation, durable orchestration, lifecycle cleanup and operational monitoring are implemented and tested.

## Deliberate boundaries

The CLI is the rendering engine. The included authenticated HTTP service is an early persistent single-process job API, not the durable hosted service. Neither component downloads arbitrary URLs, accesses R2 credentials, or uploads to YouTube. A production service must resolve asset IDs from trusted R2 storage, persist job state, call this engine, upload results to R2 and report job state back to NEXUS.

No paid service or Cloudflare resource is created by this package.
