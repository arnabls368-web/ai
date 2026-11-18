import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);

function fail(message) {
  throw new Error(message);
}

function resolutionSize(resolution, aspectRatio) {
  const longEdge = resolution === "720p" ? 1280 : 1920;
  const ratios = {
    "16:9": [16, 9],
    "9:16": [9, 16],
    "1:1": [1, 1],
  };
  const ratio = ratios[aspectRatio];
  if (!ratio) fail("Unsupported aspect ratio.");
  const [rw, rh] = ratio;
  if (rw >= rh) {
    return [longEdge, Math.round((longEdge * rh) / rw / 2) * 2];
  }
  return [Math.round((longEdge * rw) / rh / 2) * 2, longEdge];
}

export function validateManifest(manifest, assetMap) {
  if (!manifest || manifest.version !== 1 || manifest.renderer !== "ffmpeg") {
    fail("Unsupported render manifest version or renderer.");
  }
  if (manifest.output?.format !== "mp4") fail("Only MP4 output is supported.");
  if (!["720p", "1080p"].includes(manifest.output?.resolution)) fail("Unsupported output resolution.");
  if (!["24", "25", "30", "60"].includes(String(manifest.output?.frameRate))) fail("Unsupported frame rate.");
  if (!Number.isFinite(manifest.durationSeconds) || manifest.durationSeconds <= 0 || manifest.durationSeconds > 10800) {
    fail("Render duration must be between 0 and 10800 seconds.");
  }
  if (!["16:9", "9:16", "1:1"].includes(manifest.aspectRatio)) fail("Unsupported aspect ratio.");
  const scenes = manifest.tracks?.video;
  if (!Array.isArray(scenes) || scenes.length < 1 || scenes.length > 500) fail("The manifest must contain 1–500 video scenes.");
  let cursor = 0;
  for (const [index, scene] of scenes.entries()) {
    if (!Number.isFinite(scene.startSeconds) || !Number.isFinite(scene.durationSeconds) || scene.durationSeconds <= 0) {
      fail(`Scene ${index + 1} has invalid timing.`);
    }
    if (Math.abs(scene.startSeconds - cursor) > 0.01) fail("Video scenes must be contiguous and ordered without gaps or overlaps.");
    if (!scene.assetId || typeof scene.assetId !== "string") fail(`Scene ${index + 1} is missing an asset ID.`);
    if (!Object.hasOwn(assetMap, scene.assetId) || typeof assetMap[scene.assetId] !== "string") fail(`No local asset mapping was supplied for scene asset ${scene.assetId}.`);
    const extension = path.extname(assetMap[scene.assetId]).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension)) fail(`Scene ${index + 1} uses an unsupported media file type.`);
    if (!["cover", "contain"].includes(scene.fit ?? "cover")) fail(`Scene ${index + 1} has an unsupported fit mode.`);
    cursor += scene.durationSeconds;
  }
  if (Math.abs(cursor - manifest.durationSeconds) > 0.05) {
    fail("Scene durations must add up to the manifest duration.");
  }
  for (const trackName of ["voiceover", "music"]) {
    const track = manifest.tracks[trackName];
    if (track && (!track.assetId || !Object.hasOwn(assetMap, track.assetId) || typeof assetMap[track.assetId] !== "string")) {
      fail(`No local asset mapping was supplied for the ${trackName} asset.`);
    }
    if (track && !AUDIO_EXTENSIONS.has(path.extname(assetMap[track.assetId]).toLowerCase())) {
      fail(`The ${trackName} track uses an unsupported audio file type.`);
    }
  }
}

async function resolveAsset(assetRoot, relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) fail("Asset paths must be relative to the asset directory.");
  const root = await realpath(assetRoot);
  const candidate = await realpath(path.resolve(root, relativePath));
  if (candidate !== root && !candidate.startsWith(root + path.sep)) fail("Asset path escapes the configured asset directory.");
  const info = await stat(candidate);
  if (!info.isFile()) fail("Every asset must resolve to a regular file.");
  return candidate;
}

export async function buildFfmpegArgs(manifest, assetMap, assetRoot, outputPath) {
  validateManifest(manifest, assetMap);
  const [width, height] = resolutionSize(manifest.output.resolution, manifest.aspectRatio);
  const fps = Number(manifest.output.frameRate);
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  const inputs = [];
  for (const scene of manifest.tracks.video) {
    const file = await resolveAsset(assetRoot, assetMap[scene.assetId]);
    const image = IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
    if (image) args.push("-protocol_whitelist", "file", "-loop", "1", "-framerate", String(fps), "-t", String(scene.durationSeconds), "-i", file);
    else args.push("-protocol_whitelist", "file", "-stream_loop", "-1", "-i", file);
    inputs.push({ scene, index: inputs.length });
  }

  let voiceIndex;
  let musicIndex;
  if (manifest.tracks.voiceover) {
    voiceIndex = inputs.length;
    const file = await resolveAsset(assetRoot, assetMap[manifest.tracks.voiceover.assetId]);
    args.push("-protocol_whitelist", "file", "-i", file);
  }
  if (manifest.tracks.music) {
    musicIndex = inputs.length + (voiceIndex === undefined ? 0 : 1);
    const file = await resolveAsset(assetRoot, assetMap[manifest.tracks.music.assetId]);
    args.push("-protocol_whitelist", "file", "-stream_loop", "-1", "-i", file);
  }

  const filters = [];
  const sceneLabels = [];
  for (const { scene, index } of inputs) {
    const label = `scene${index}`;
    const fit = scene.fit ?? "cover";
    const fitFilter = fit === "cover"
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
    filters.push(`[${index}:v:0]trim=duration=${scene.durationSeconds},setpts=PTS-STARTPTS,${fitFilter},setsar=1,fps=${fps},format=yuv420p[${label}]`);
    sceneLabels.push(`[${label}]`);
  }
  filters.push(`${sceneLabels.join("")}concat=n=${inputs.length}:v=1:a=0[vout]`);

  if (voiceIndex !== undefined && musicIndex !== undefined) {
    const musicGain = Number.isFinite(manifest.tracks.music.gain) ? Math.min(1, Math.max(0, manifest.tracks.music.gain)) : 0.12;
    if (manifest.tracks.music.duckUnderVoiceover === false) {
      filters.push(`[${voiceIndex}:a:0]aresample=48000,apad,atrim=duration=${manifest.durationSeconds}[voice]`);
      filters.push(`[${musicIndex}:a:0]aresample=48000,volume=${musicGain},atrim=duration=${manifest.durationSeconds}[music]`);
      filters.push("[voice][music]amix=inputs=2:duration=first:dropout_transition=0[aout]");
    } else {
      filters.push(`[${voiceIndex}:a:0]aresample=48000,apad,atrim=duration=${manifest.durationSeconds}[voice]`);
      filters.push(`[${musicIndex}:a:0]aresample=48000,volume=${musicGain},atrim=duration=${manifest.durationSeconds}[music]`);
      filters.push("[music][voice]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=250[ducked]");
      filters.push("[ducked][voice]amix=inputs=2:duration=first:dropout_transition=0[aout]");
    }
  } else if (voiceIndex !== undefined) {
    filters.push(`[${voiceIndex}:a:0]aresample=48000,apad,atrim=duration=${manifest.durationSeconds}[aout]`);
  } else if (musicIndex !== undefined) {
    const musicGain = Number.isFinite(manifest.tracks.music.gain) ? Math.min(1, Math.max(0, manifest.tracks.music.gain)) : 0.12;
    filters.push(`[${musicIndex}:a:0]aresample=48000,volume=${musicGain},atrim=duration=${manifest.durationSeconds}[aout]`);
  }

  args.push("-filter_complex", filters.join(";"), "-map", "[vout]");
  if (voiceIndex !== undefined || musicIndex !== undefined) args.push("-map", "[aout]");
  else args.push("-an");
  args.push(
    "-t", String(manifest.durationSeconds),
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  );
  if (voiceIndex !== undefined || musicIndex !== undefined) args.push("-c:a", "aac", "-b:a", "192k");
  args.push(outputPath);
  return args;
}

export async function renderManifest({ manifest, assetMap, assetRoot, outputPath, ffmpegPath = "ffmpeg" }) {
  const args = await buildFfmpegArgs(manifest, assetMap, assetRoot, outputPath);
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.trim()}`));
    });
  });
  return { outputPath, durationSeconds: manifest.durationSeconds, format: "mp4" };
}
