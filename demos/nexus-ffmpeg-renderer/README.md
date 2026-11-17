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
- Uses `spawn` with argument arrays; it does not interpolate user input into a shell command.

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

Send `Authorization: Bearer <NEXUS_RENDER_TOKEN>` for job routes. The API limits request bodies to 1 MiB, persists job metadata and queued work as atomic JSON files under `NEXUS_RENDER_WORKDIR`, retries jobs interrupted while running when the service restarts, keeps at most 100 terminal job records, and runs at most one render by default. Mount `/work` on persistent storage; without that persistent mount, job state and output files are lost when the container is removed. Mount a trusted asset directory read-only. Do not put the token in source control or logs.

**Important limits:** this is still a single-process, single-bearer-token prototype. It is not a distributed queue, does not provide per-user/tenant authorization, R2 integration, idempotency keys, cancellation, authenticated callbacks to the Worker, or multi-replica coordination. Do not expose it publicly or treat it as a production multi-tenant service. Production still needs tenant-bound credentials, trusted R2 object ownership checks, durable orchestration, lifecycle cleanup, observability and secure Worker-to-renderer connectivity.

## Deliberate boundaries

The CLI is the rendering engine. The included authenticated HTTP service is an early persistent single-process job API, not the durable hosted service. Neither component downloads arbitrary URLs, accesses R2 credentials, or uploads to YouTube. A production service must resolve asset IDs from trusted R2 storage, persist job state, call this engine, upload results to R2 and report job state back to NEXUS.

No paid service or Cloudflare resource is created by this package.
