import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildFfmpegArgs, renderManifest, validateManifest } from "../src/renderer.mjs";

function sampleManifest() {
  return {
    version: 1,
    renderer: "ffmpeg",
    durationSeconds: 8,
    aspectRatio: "16:9",
    output: { resolution: "1080p", frameRate: "30", format: "mp4" },
    tracks: {
      video: [
        { scene: 1, startSeconds: 0, durationSeconds: 4, assetId: "a", fit: "cover" },
        { scene: 2, startSeconds: 4, durationSeconds: 4, assetId: "b", fit: "contain" }
      ]
    }
  };
}

test("accepts a contiguous storyboard with exact asset mappings", () => {
  assert.doesNotThrow(() => validateManifest(sampleManifest(), { a: "one.jpg", b: "two.mp4" }));
});

test("rejects playlist and unsupported media extensions", () => {
  assert.throws(() => validateManifest(sampleManifest(), { a: "one.m3u8", b: "two.mp4" }), /unsupported media file type/i);
  const manifest = sampleManifest();
  manifest.tracks.music = { assetId: "music" };
  assert.throws(() => validateManifest(manifest, { a: "one.jpg", b: "two.mp4", music: "music.m3u8" }), /unsupported audio file type/i);
});

test("rejects scene gaps and overlaps", () => {
  const manifest = sampleManifest();
  manifest.tracks.video[1].startSeconds = 4.5;
  assert.throws(() => validateManifest(manifest, { a: "one.jpg", b: "two.mp4" }), /contiguous/);
});

test("rejects missing assets and duration mismatches", () => {
  assert.throws(() => validateManifest(sampleManifest(), { a: "one.jpg" }), /No local asset mapping/);
  const manifest = sampleManifest();
  manifest.durationSeconds = 9;
  assert.throws(() => validateManifest(manifest, { a: "one.jpg", b: "two.mp4" }), /add up/);
});

test("builds FFmpeg arguments for image, video, voice and ducked music", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-render-"));
  try {
    await writeFile(path.join(root, "one.jpg"), "image");
    await writeFile(path.join(root, "two.mp4"), "video");
    await writeFile(path.join(root, "voice.wav"), "voice");
    await writeFile(path.join(root, "music.mp3"), "music");
    const manifest = sampleManifest();
    manifest.tracks.voiceover = { assetId: "voice" };
    manifest.tracks.music = { assetId: "music", gain: 0.12, duckUnderVoiceover: true };
    const args = await buildFfmpegArgs(manifest, {
      a: "one.jpg", b: "two.mp4", voice: "voice.wav", music: "music.mp3"
    }, root, "/tmp/out.mp4");
    assert.ok(args.includes("libx264"));
    assert.ok(args.includes("-nostdin"));
    assert.equal(args.filter((value) => value === "-protocol_whitelist").length, 4);
    assert.ok(args.includes("file"));
    assert.ok(args.join(" ").includes("sidechaincompress=threshold=0.03:ratio=8:attack=20:release=250"));
    assert.ok(args.includes("/tmp/out.mp4"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects asset symlinks that escape the asset directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-render-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "nexus-outside-"));
  try {
    await writeFile(path.join(outside, "secret.mp4"), "x");
    await symlink(path.join(outside, "secret.mp4"), path.join(root, "escape.mp4"));
    await assert.rejects(
      buildFfmpegArgs(sampleManifest(), { a: "escape.mp4", b: "escape.mp4" }, root, "/tmp/out.mp4"),
      /escapes/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("kills FFmpeg when a render exceeds its timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-render-timeout-"));
  try {
    const fakeFfmpeg = path.join(root, "fake-ffmpeg");
    await writeFile(fakeFfmpeg, "#!/usr/bin/env node\\nsetTimeout(() => {}, 5000);\\n");
    await chmod(fakeFfmpeg, 0o700);
    await writeFile(path.join(root, "one.jpg"), "image");
    await writeFile(path.join(root, "two.mp4"), "video");
    await assert.rejects(
      renderManifest({
        manifest: sampleManifest(),
        assetMap: { a: "one.jpg", b: "two.mp4" },
        assetRoot: root,
        outputPath: path.join(root, "out.mp4"),
        ffmpegPath: fakeFfmpeg,
        timeoutMs: 50,
      }),
      /exceeded the 50ms render timeout/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
