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

## Deliberate boundaries

This is the rendering engine/CLI, not yet a hosted job API. It does not download arbitrary URLs, accept public network requests, access R2 credentials, store jobs, or upload to YouTube. A future authenticated job service should resolve asset IDs from trusted R2 storage, create local input files, call this engine, upload the result to R2 and report job state back to NEXUS. Do not expose this CLI directly to untrusted users.

No paid service or Cloudflare resource is created by this package.
