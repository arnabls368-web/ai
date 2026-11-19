import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rename, rm, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { extensionForMime, getPrivateAsset, getPrivateAssetRange, putPrivateAssetFile, deletePrivateAsset, cleanupStagedAssets, MAX_ASSET_BYTES_LIMIT } from "./storage.mjs";
import { renderManifest, validateManifest } from "./renderer.mjs";
import { verifyRenderToken } from "./auth.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_VIDEO_ASSET_BYTES = 50 * 1024 * 1024;
const MAX_RETAINED_JOBS = 100;
const MAX_QUEUE_SIZE = 3;
const MAX_CONCURRENT_ASSET_UPLOADS = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function requestClaims(request, { signingSecret, legacyToken, scope }) {
  const header = request.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const credential = header.slice(7);
  if (signingSecret) return verifyRenderToken(credential, { secret: signingSecret, scope });
  const supplied = Buffer.from(credential);
  const expected = Buffer.from(legacyToken ?? "");
  if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  return { tenantId: null, projectId: null, legacy: true };
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body exceeds 1 MiB."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

async function writeBinaryLimited(request, filePath, limit = MAX_ASSET_BYTES_LIMIT) {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined && Number(declaredLength) > limit) {
    throw Object.assign(new Error("Asset exceeds the configured " + Math.floor(limit / (1024 * 1024)) + " MiB limit."), { status: 413 });
  }
  const handle = await open(filePath, "wx", 0o600);
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) {
        throw Object.assign(new Error("Asset exceeds the configured " + Math.floor(limit / (1024 * 1024)) + " MiB limit."), { status: 413 });
      }
      await handle.writeFile(chunk);
    }
    if (!size) throw Object.assign(new Error("Asset body must not be empty."), { status: 400 });
    return size;
  } finally {
    await handle.close();
  }
}

function publicJob(job) {
  const result = { ...job };
  delete result.manifest;
  delete result.assetMap;
  delete result.outputPath;
  delete result.tenantId;
  delete result.projectId;
  delete result.idempotencyKey;
  return {
    ...result,
    ...(job.status === "succeeded" ? { outputUrl: `/jobs/${job.id}/output` } : {}),
  };
}

/**
 * Persistent single-process render API.
 * Job records and queued work are atomically stored as JSON under workRoot.
 * Mount workRoot on persistent storage to survive container replacement.
 * This is not a distributed queue and must run as one process/replica.
 */
export function createRenderJobServer({
  token = process.env.NEXUS_RENDER_TOKEN,
  signingSecret = process.env.NEXUS_RENDER_SIGNING_SECRET,
  allowLegacyToken = process.env.NODE_ENV !== "production",
  assetRoot = process.env.NEXUS_ASSET_ROOT ?? "/assets",
  workRoot = process.env.NEXUS_RENDER_WORKDIR ?? "/work",
  assetTempRoot = tmpdir(),
  ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg",
  maxConcurrent = 1,
  cleanupEnabled = process.env.NEXUS_STAGED_ASSET_CLEANUP_ENABLED === "true",
  cleanupIntervalMs = Number(process.env.NEXUS_STAGED_ASSET_CLEANUP_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
  cleanupFn = cleanupStagedAssets,
} = {}) {
  if (signingSecret && signingSecret.length < 32) throw new Error("NEXUS_RENDER_SIGNING_SECRET must contain at least 32 characters.");
  if (!signingSecret && !allowLegacyToken) throw new Error("NEXUS_RENDER_SIGNING_SECRET is required when NODE_ENV=production.");
  if (!signingSecret && (!token || token.length < 32)) throw new Error("Configure NEXUS_RENDER_SIGNING_SECRET or a legacy NEXUS_RENDER_TOKEN of at least 32 characters for local development.");
  if (cleanupEnabled && (!Number.isSafeInteger(cleanupIntervalMs) || cleanupIntervalMs < 15 * 60 * 1000 || typeof cleanupFn !== "function")) {
    throw new Error("Staged asset cleanup requires a valid interval of at least 15 minutes.");
  }
  if (cleanupEnabled && !(process.env.AWS_S3_BUCKET_NAME ?? "").trim()) {
    throw new Error("NEXUS_STAGED_ASSET_CLEANUP_ENABLED requires AWS_S3_BUCKET_NAME.");
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2) {
    throw new Error("maxConcurrent must be 1 or 2.");
  }

  const jobs = new Map();
  // In-flight persistence reservations ensure duplicate submissions wait for
  // the first durable write instead of receiving a receipt for an uncommitted job.
  const idempotencyReservations = new Map();
  const queue = [];
  let active = 0;
  let pendingSubmissions = 0;
  let activeAssetUploads = 0;

  function jobDirectory(id) {
    if (!UUID_PATTERN.test(id)) throw new Error("Invalid job ID.");
    return path.join(workRoot, id);
  }

  async function persistJob(job) {
    const directory = jobDirectory(job.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const destination = path.join(directory, "job.json");
    const temporary = path.join(directory, `job.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(job), { mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      // A failed write or rename must not leave private job metadata fragments
      // behind on the persistent volume.
      await rm(temporary, { force: true });
    }
  }

  async function pruneJobs() {
    if (jobs.size <= MAX_RETAINED_JOBS) return;
    const terminal = [...jobs.values()]
      .filter((job) => job.status === "succeeded" || job.status === "failed")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (jobs.size > MAX_RETAINED_JOBS && terminal.length) {
      const oldest = terminal.shift();
      jobs.delete(oldest.id);
      await rm(jobDirectory(oldest.id), { recursive: true, force: true });
    }
  }

  async function restoreJobs() {
    // Railway persistent-volume mount roots may reject chmod even when writable.
    // Keep the mount's configured permissions and restrict each job directory
    // individually in persistJob() instead.
    await mkdir(workRoot, { recursive: true, mode: 0o700 });
    const entries = await readdir(workRoot, { withFileTypes: true });
    const restored = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      const directoryPath = path.join(workRoot, entry.name);
      const directoryInfo = await lstat(directoryPath);
      if (!directoryInfo.isDirectory()) continue;
      // Remove only our own atomic-write temp filenames left by a hard crash.
      // Never recurse into arbitrary entries or follow symlinks in the job folder.
      const jobEntries = await readdir(directoryPath);
      for (const name of jobEntries) {
        if (!/^job\.[0-9a-f-]{36}\.tmp$/i.test(name)) continue;
        const temporaryPath = path.join(directoryPath, name);
        const temporaryInfo = await lstat(temporaryPath);
        if (temporaryInfo.isFile() || temporaryInfo.isSymbolicLink()) {
          await rm(temporaryPath, { force: true });
        }
      }
      const recordPath = path.join(directoryPath, "job.json");
      let record;
      try {
        const recordInfo = await lstat(recordPath);
        if (!recordInfo.isFile() || recordInfo.size > MAX_BODY_BYTES) continue;
        record = JSON.parse(await readFile(recordPath, "utf8"));
      } catch (error) {
        // A missing or malformed record is incomplete and can be ignored.
        // Other filesystem failures (permissions, I/O, full disk, etc.) must
        // abort startup rather than silently hiding persisted jobs.
        if (error instanceof SyntaxError || error?.code === "ENOENT") continue;
        throw error;
      }
      try {
        if (!record || typeof record !== "object" || Array.isArray(record) ||
            record.id !== entry.name || !["queued", "running", "succeeded", "failed"].includes(record.status) ||
            typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) ||
            !record.manifest || typeof record.manifest !== "object" || Array.isArray(record.manifest) ||
            !record.assetMap || typeof record.assetMap !== "object" || Array.isArray(record.assetMap) ||
            Object.keys(record.assetMap).length > 502 ||
            Object.entries(record.assetMap).some(([id, file]) =>
              !id || id.length > 128 || typeof file !== "string" || !file || file.length > 512 || file.includes("\0")) ||
            (record.idempotencyKey !== undefined &&
              (typeof record.idempotencyKey !== "string" || !/^[0-9a-f]{64}$/i.test(record.idempotencyKey))) ||
            !((record.tenantId === null && record.projectId === null) ||
              (typeof record.tenantId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.tenantId) &&
               typeof record.projectId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.projectId)))) {
          continue;
        }
        validateManifest(record.manifest, record.assetMap);
      } catch {
        // Ignore records that fail schema or manifest validation.
        continue;
      }
      const job = { ...record };
      if (job.status === "running" || job.status === "queued") {
        job.status = "queued";
        delete job.startedAt;
        delete job.error;
      } else if (job.status === "succeeded") {
        let output;
        try {
          output = await lstat(path.join(workRoot, job.id, "render.mp4"));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        if (!output || !output.isFile() || output.size === 0) {
          job.status = "failed";
          job.error = "Completed output was missing when the render service restarted.";
          job.completedAt = new Date().toISOString();
          delete job.outputPath;
        } else {
          job.outputPath = path.join(workRoot, job.id, "render.mp4");
          job.outputBytes = output.size;
        }
      }
      jobs.set(job.id, job);
      if (job.status === "queued") restored.push(job);
      // Persistence failures are fatal: do not start with partially recovered
      // in-memory state that could diverge from the durable job records.
      await persistJob(job);
    }
    restored.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const accepted = restored.slice(0, MAX_QUEUE_SIZE);
    const overflow = restored.slice(MAX_QUEUE_SIZE);
    for (const job of overflow) {
      job.status = "failed";
      job.error = "Render queue capacity was exceeded during service recovery.";
      job.completedAt = new Date().toISOString();
      await persistJob(job);
    }
    queue.push(...accepted);
    await pruneJobs();
  }

  async function execute(job) {
    active += 1;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    const outputPath = path.join(jobDirectory(job.id), "render.mp4");
    try {
      await persistJob(job);
      let renderAssetRoot = assetRoot;
      let renderAssetMap = job.assetMap;
      if (process.env.AWS_S3_BUCKET_NAME && job.tenantId && job.projectId) {
        const temporaryAssetRoot = path.join(assetRoot, job.id);
        // A process crash can leave partial downloads here. Remove them before
        // restoring the job so exclusive writes can safely fetch every asset again.
        await rm(temporaryAssetRoot, { recursive: true, force: true });
        await mkdir(temporaryAssetRoot, { recursive: true, mode: 0o700 });
        renderAssetRoot = temporaryAssetRoot;
        renderAssetMap = {};
        for (const [assetId, declaredName] of Object.entries(job.assetMap)) {
          if (typeof declaredName !== "string" || path.basename(declaredName) !== declaredName) {
            throw new Error("Asset map entries must be plain filenames with a supported extension.");
          }
          const extension = path.extname(declaredName).toLowerCase();
          const localName = createHash("sha256").update(assetId).digest("hex") + extension;
          const bytes = await getPrivateAsset({ tenantId: job.tenantId, projectId: job.projectId, assetId, extension });
          await writeFile(path.join(temporaryAssetRoot, localName), bytes, { flag: "wx", mode: 0o600 });
          renderAssetMap[assetId] = localName;
        }
      }
      await renderManifest({
        manifest: job.manifest,
        assetMap: renderAssetMap,
        assetRoot: renderAssetRoot,
        outputPath,
        ffmpegPath,
      });
      const output = await lstat(outputPath);
      if (!output.isFile() || output.size === 0) throw new Error("Render output is not a non-empty regular file.");
      await chmod(outputPath, 0o600);
      job.status = "succeeded";
      job.outputPath = outputPath;
      job.outputBytes = output.size;
      job.completedAt = new Date().toISOString();
    } catch (error) {
      await rm(outputPath, { force: true }).catch(() => {});
      job.status = "failed";
      job.error = String(error?.message ?? error).slice(0, 1000);
      job.completedAt = new Date().toISOString();
    } finally {
      if (process.env.AWS_S3_BUCKET_NAME && job.tenantId && job.projectId) {
        await rm(path.join(assetRoot, job.id), { recursive: true, force: true }).catch(() => {});
      }
      try {
        await persistJob(job);
        await pruneJobs();
      } finally {
        active -= 1;
        pump();
      }
    }
  }

  function pump() {
    while (active < maxConcurrent && queue.length) {
      const next = queue.shift();
      void execute(next).catch((error) => {
        process.stderr.write(`NEXUS render job persistence error: ${String(error?.message ?? error)}\\n`);
      });
    }
  }

  const ready = restoreJobs();
  const server = createServer(async (request, response) => {
    try {
      await ready;
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { status: "ok", service: "nexus-render-jobs", persistence: "filesystem" });
      }
      const isSubmission = request.method === "POST" && url.pathname === "/jobs";
      const assetMatch = request.method === "PUT" ? url.pathname.match(/^\/assets\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/) : null;
      const stagedAssetMatch = request.method === "PUT" ? url.pathname.match(/^\/staged-assets\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/) : null;
      const assetReadMatch = request.method === "GET" ? url.pathname.match(/^\/staged-assets\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(mp4|mov|m4v|webm|mkv)$/) : null;
      const assetDeleteMatch = request.method === "DELETE" ? url.pathname.match(/^\/staged-assets\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(mp4|mov|m4v|webm|mkv)$/) : null;
      const isAssetUpload = Boolean(assetMatch || stagedAssetMatch);
      const isStagedAssetUpload = Boolean(stagedAssetMatch);
      const isAssetRead = Boolean(assetReadMatch);
      const isAssetDelete = Boolean(assetDeleteMatch);
      const claims = requestClaims(request, {
        signingSecret,
        legacyToken: allowLegacyToken ? token : undefined,
        scope: isSubmission ? "render:submit" : isAssetUpload ? "asset:write" : isAssetRead ? "asset:read" : isAssetDelete ? "asset:delete" : "render:read",
      });
      if (!claims) return json(response, 401, { error: "unauthorized" });

      if (request.method === "GET" && url.pathname === "/auth-check") {
        if (claims.legacy) return json(response, 401, { error: "signed authorization required" });
        return json(response, 200, { ok: true, service: "nexus-render-jobs", authorization: "signed", scope: claims.scope });
      }


      if (isAssetDelete) {
        if (claims.legacy || !claims.tenantId || !claims.projectId) return json(response, 401, { error: "signed project authorization required" });
        try {
          await deletePrivateAsset({ tenantId: claims.tenantId, projectId: claims.projectId, assetId: assetDeleteMatch[1], extension: "." + assetDeleteMatch[2], prefix: "staged-assets" });
          return json(response, 200, { deleted: true });
        } catch (error) {
          // Once streaming headers are sent, a JSON error response is no longer valid.
          if (response.headersSent) {
            response.destroy();
            return;
          }
          if (error.status === 403 || error.status === 404) {
            return json(response, 404, { error: "staged asset not found" });
          }
          return json(response, 502, { error: "private staged asset could not be deleted" });
        }
      }

      if (isAssetRead) {
        if (claims.legacy || !claims.tenantId || !claims.projectId) return json(response, 401, { error: "signed project authorization required" });
        const rangeHeader = request.headers.range ?? "";
        const rangeMatch = rangeHeader.match(/^bytes=(\d+)-(\d+)$/);
        if (!rangeMatch) return json(response, 400, { error: "a single explicit byte range is required" });
        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
            start < 0 || end < start || end - start + 1 > 8 * 1024 * 1024) {
          return json(response, 400, { error: "requested byte range is invalid or exceeds 8 MiB" });
        }
        try {
          const stored = await getPrivateAssetRange({
            tenantId: claims.tenantId,
            projectId: claims.projectId,
            assetId: assetReadMatch[1],
            extension: "." + assetReadMatch[2],
            prefix: "staged-assets",
            start,
            end,
          });
          response.writeHead(206, {
            "content-type": "application/octet-stream",
            "content-length": String(stored.contentLength),
            "content-range": stored.contentRange,
            "accept-ranges": "bytes",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          await pipeline(Readable.fromWeb(stored.body), response);
          return;
        } catch (error) {
          if (error.status === 403 || error.status === 404) {
            return json(response, 404, { error: "staged asset not found" });
          }
          if (error.status === 416) {
            return json(response, 416, { error: error.message });
          }
          return json(response, 502, { error: "private staged asset could not be read" });
        }
      }

      if (isAssetUpload) {
        if (claims.legacy || !claims.tenantId || !claims.projectId) return json(response, 401, { error: "signed project authorization required" });
        const mimeType = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (!extensionForMime(mimeType) || (isStagedAssetUpload && !mimeType.startsWith("video/"))) {
          return json(response, 415, { error: "unsupported asset media type" });
        }
        if (activeAssetUploads >= MAX_CONCURRENT_ASSET_UPLOADS) {
          response.shouldKeepAlive = false;
          return json(response, 429, { error: "asset upload capacity is full" });
        }
        activeAssetUploads += 1;
        try {
          const uploadDirectory = await mkdtemp(path.join(assetTempRoot, "nexus-asset-upload-"));
          const uploadPath = path.join(uploadDirectory, "asset");
          try {
            await writeBinaryLimited(request, uploadPath, mimeType.startsWith("video/") ? MAX_VIDEO_ASSET_BYTES : MAX_ASSET_BYTES_LIMIT);
            const assetId = (stagedAssetMatch ?? assetMatch)[1];
            const stored = await putPrivateAssetFile({
              tenantId: claims.tenantId,
              projectId: claims.projectId,
              assetId,
              mimeType,
              ...(isStagedAssetUpload ? { prefix: "staged-assets" } : {}),
              filePath: uploadPath,
            });
            return json(response, 201, { assetId, filename: assetId + stored.extension, bytes: stored.bytes, sha256: stored.sha256, storage: "private_object_storage" });
          } finally {
            await rm(uploadDirectory, { recursive: true, force: true });
          }
        } catch (error) {
          return json(response, error.status ?? 502, { error: String(error?.message ?? error).slice(0, 500) });
        } finally {
          activeAssetUploads -= 1;
        }
      }

      if (isSubmission) {
        const contentType = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          if (contentType !== "application/json") return json(response, 415, { error: "content-type must be application/json" });
          if (queue.length + active + pendingSubmissions >= MAX_QUEUE_SIZE) {
            response.shouldKeepAlive = false;
            return json(response, 429, { error: "render queue is full" });
          }
          // Reserve capacity before the first await so concurrent requests cannot
          // all pass the limit check while their request bodies or job records persist.
          pendingSubmissions += 1;
          let enqueued = false;
          try {
          const body = await readJson(request);
          if (!body || typeof body !== "object" || Array.isArray(body) ||
              !body.manifest || typeof body.manifest !== "object" ||
              !body.assetMap || typeof body.assetMap !== "object" || Array.isArray(body.assetMap)) {
            return json(response, 400, { error: "manifest and assetMap are required" });
          }
          if (body.idempotencyKey !== undefined &&
              (typeof body.idempotencyKey !== "string" || !/^[0-9a-f]{64}$/i.test(body.idempotencyKey))) {
            return json(response, 400, { error: "idempotencyKey must be a 64-character SHA-256 hex digest" });
          }
          const assetEntries = Object.entries(body.assetMap);
          if (assetEntries.length > 502 || assetEntries.some(([id, file]) =>
            typeof id !== "string" || !id || id.length > 128 ||
            typeof file !== "string" || !file || file.length > 512 || file.includes("\0")
          )) {
            return json(response, 400, { error: "assetMap contains invalid or excessive entries" });
          }
          try {
            validateManifest(body.manifest, body.assetMap);
          } catch (error) {
            return json(response, 400, { error: String(error?.message ?? error).slice(0, 500) });
          }
          const reservationKey = body.idempotencyKey
            ? JSON.stringify([claims.tenantId, claims.projectId, body.idempotencyKey])
            : null;
          if (reservationKey && idempotencyReservations.has(reservationKey)) {
            const pending = await idempotencyReservations.get(reservationKey);
            if (!pending.ok) {
              return json(response, 503, { error: "matching render submission could not be persisted" });
            }
            return json(response, 202, {
              id: pending.job.id,
              status: pending.job.status,
              statusUrl: `/jobs/${pending.job.id}`,
              deduplicated: true,
            });
          }
          const idempotencyMatch = body.idempotencyKey
            ? [...jobs.values()].find((candidate) =>
                candidate.idempotencyKey === body.idempotencyKey &&
                candidate.tenantId === claims.tenantId &&
                candidate.projectId === claims.projectId)
            : null;
          if (idempotencyMatch) {
            return json(response, 202, {
              id: idempotencyMatch.id,
              status: idempotencyMatch.status,
              statusUrl: `/jobs/${idempotencyMatch.id}`,
              deduplicated: true,
            });
          }
          const id = randomUUID();
          const job = {
            id,
            tenantId: claims.tenantId,
            projectId: claims.projectId,
            status: "queued",
            createdAt: new Date().toISOString(),
            manifest: body.manifest,
            assetMap: body.assetMap,
            ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
          };
          // Reserve the scoped key synchronously. The promise always resolves
          // to a result object so a failed write cannot create an unhandled
          // rejection when no duplicate request is waiting.
          jobs.set(id, job);
          const persistence = persistJob(job).then(
            () => ({ ok: true, job }),
            (error) => ({ ok: false, error }),
          );
          if (reservationKey) idempotencyReservations.set(reservationKey, persistence);
          const persisted = await persistence;
          if (!persisted.ok) {
            jobs.delete(id);
            if (reservationKey) idempotencyReservations.delete(reservationKey);
            throw persisted.error;
          }
          if (reservationKey) idempotencyReservations.delete(reservationKey);
          queue.push(job);
          enqueued = true;
          pendingSubmissions -= 1;
          await pruneJobs();
          pump();
          return json(response, 202, { id, status: job.status, statusUrl: `/jobs/${id}` });
          } catch (error) {
            return json(response, error.status ?? 400, { error: error.message });
          } finally {
            if (!enqueued) pendingSubmissions -= 1;
          }
      }

      const match = url.pathname.match(/^\/jobs\/([0-9a-f-]{36})(\/output)?$/i);
      if (!match) return json(response, 404, { error: "not found" });
      const job = jobs.get(match[1]);
      if (!job) return json(response, 404, { error: "job not found" });
      if (!claims.legacy && (job.tenantId !== claims.tenantId || job.projectId !== claims.projectId)) {
        return json(response, 404, { error: "job not found" });
      }

      if (request.method === "GET" && match[2] === "/output") {
        if (job.status !== "succeeded" || !job.outputPath) {
          return json(response, 409, { error: "render output is not ready", status: job.status });
        }
        let outputHandle;
        let outputSize;
        try {
          outputHandle = await open(job.outputPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          const openedFile = await outputHandle.stat();
          if (!openedFile.isFile() || openedFile.size === 0) {
            await outputHandle.close();
            return json(response, 500, { error: "render output is not a regular file" });
          }
          outputSize = openedFile.size;
        } catch {
          if (outputHandle) await outputHandle.close().catch(() => {});
          return json(response, 500, { error: "render output could not be verified" });
        }
        const outputStream = outputHandle.createReadStream();
        outputStream.once("error", () => {
          if (!response.headersSent) json(response, 500, { error: "render output could not be read" });
          else response.destroy();
        });
        response.writeHead(200, {
          "content-type": "video/mp4",
          "content-disposition": "attachment; filename=\"nexus-render.mp4\"",
          "cache-control": "no-store",
          "content-length": String(outputSize),
          "x-content-type-options": "nosniff",
        });
        outputStream.pipe(response);
        return;
      }
      if (request.method === "GET" && !match[2]) {
        return json(response, 200, publicJob(job));
      }
      return json(response, 405, { error: "method not allowed" });
    } catch (error) {
      if (!response.headersSent) json(response, 500, { error: "internal server error" });
      else response.destroy(error);
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  server.once("listening", () => {
    void ready.then(pump).catch((error) => {
      process.stderr.write(`NEXUS render queue recovery error: ${String(error?.message ?? error)}\\n`);
    });
  });
  let cleanupTimer;
  let cleanupRunning = false;
  if (cleanupEnabled && process.env.AWS_S3_BUCKET_NAME) {
    const runCleanup = async () => {
      if (cleanupRunning) return;
      cleanupRunning = true;
      try {
        await ready;
        const result = await cleanupFn();
        process.stdout.write(`NEXUS staged asset cleanup: scanned=${result.scanned} deleted=${result.deleted} truncated=${result.truncated}\\n`);
      } catch (error) {
        process.stderr.write(`NEXUS staged asset cleanup failed: ${String(error?.message ?? error)}\\n`);
      } finally {
        cleanupRunning = false;
      }
    };
    void ready.then(runCleanup);
    cleanupTimer = setInterval(runCleanup, cleanupIntervalMs);
    cleanupTimer.unref();
    server.once("close", () => clearInterval(cleanupTimer));
  }
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createRenderJobServer();
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`NEXUS render-job API listening on :${port}\\n`);
  });
}
