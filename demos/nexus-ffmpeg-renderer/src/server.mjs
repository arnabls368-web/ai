import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { renderManifest, validateManifest } from "./renderer.mjs";
import { verifyRenderToken } from "./auth.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RETAINED_JOBS = 100;
const MAX_QUEUE_SIZE = 3;
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

function publicJob(job) {
  const result = { ...job };
  delete result.manifest;
  delete result.assetMap;
  delete result.outputPath;
  delete result.tenantId;
  delete result.projectId;
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
  maxConcurrent = 1,
} = {}) {
  if (signingSecret && signingSecret.length < 32) throw new Error("NEXUS_RENDER_SIGNING_SECRET must contain at least 32 characters.");
  if (!signingSecret && !allowLegacyToken) throw new Error("NEXUS_RENDER_SIGNING_SECRET is required when NODE_ENV=production.");
  if (!signingSecret && (!token || token.length < 32)) throw new Error("Configure NEXUS_RENDER_SIGNING_SECRET or a legacy NEXUS_RENDER_TOKEN of at least 32 characters for local development.");
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2) {
    throw new Error("maxConcurrent must be 1 or 2.");
  }

  const jobs = new Map();
  const queue = [];
  let active = 0;

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
    await writeFile(temporary, JSON.stringify(job), { mode: 0o600 });
    await rename(temporary, destination);
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
    await mkdir(workRoot, { recursive: true, mode: 0o700 });
    await chmod(workRoot, 0o700);
    const entries = await readdir(workRoot, { withFileTypes: true });
    const restored = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      try {
        const record = JSON.parse(await readFile(path.join(workRoot, entry.name, "job.json"), "utf8"));
        if (!record || record.id !== entry.name || !["queued", "running", "succeeded", "failed"].includes(record.status)) continue;
        const job = { ...record };
        if (job.status === "running" || job.status === "queued") {
          job.status = "queued";
          delete job.startedAt;
          delete job.error;
        } else if (job.status === "succeeded") {
          try {
            const output = await stat(path.join(workRoot, job.id, "render.mp4"));
            job.outputPath = path.join(workRoot, job.id, "render.mp4");
            job.outputBytes = output.size;
          } catch {
            job.status = "failed";
            job.error = "Completed output was missing when the render service restarted.";
            job.completedAt = new Date().toISOString();
            delete job.outputPath;
          }
        }
        jobs.set(job.id, job);
        if (job.status === "queued") restored.push(job);
        await persistJob(job);
      } catch {
        // Ignore malformed/incomplete records; never trust directory names as paths.
      }
    }
    restored.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    queue.push(...restored);
    await pruneJobs();
  }

  async function execute(job) {
    active += 1;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    const outputPath = path.join(jobDirectory(job.id), "render.mp4");
    try {
      await persistJob(job);
      await renderManifest({
        manifest: job.manifest,
        assetMap: job.assetMap,
        assetRoot,
        outputPath,
      });
      const output = await stat(outputPath);
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
      const claims = requestClaims(request, {
        signingSecret,
        legacyToken: allowLegacyToken ? token : undefined,
        scope: isSubmission ? "render:submit" : "render:read",
      });
      if (!claims) return json(response, 401, { error: "unauthorized" });

      if (request.method === "GET" && url.pathname === "/auth-check") {
        if (claims.legacy) return json(response, 401, { error: "signed authorization required" });
        return json(response, 200, { ok: true, service: "nexus-render-jobs", authorization: "signed", scope: claims.scope });
      }

      if (isSubmission) {
        try {
          const contentType = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          if (contentType !== "application/json") return json(response, 415, { error: "content-type must be application/json" });
          if (queue.length + active >= MAX_QUEUE_SIZE) {
            return json(response, 429, { error: "render queue is full" });
          }
          const body = await readJson(request);
          if (!body || typeof body !== "object" || Array.isArray(body) ||
              !body.manifest || typeof body.manifest !== "object" ||
              !body.assetMap || typeof body.assetMap !== "object" || Array.isArray(body.assetMap)) {
            return json(response, 400, { error: "manifest and assetMap are required" });
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
          const id = randomUUID();
          const job = {
            id,
            tenantId: claims.tenantId,
            projectId: claims.projectId,
            status: "queued",
            createdAt: new Date().toISOString(),
            manifest: body.manifest,
            assetMap: body.assetMap,
          };
          await persistJob(job);
          jobs.set(id, job);
          queue.push(job);
          await pruneJobs();
          pump();
          return json(response, 202, { id, status: job.status, statusUrl: `/jobs/${id}` });
        } catch (error) {
          return json(response, error.status ?? 400, { error: error.message });
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
        const outputStream = createReadStream(job.outputPath);
        outputStream.once("open", () => {
          response.writeHead(200, {
            "content-type": "video/mp4",
            "content-disposition": 'attachment; filename="nexus-render.mp4"',
            "cache-control": "no-store",
          });
          outputStream.pipe(response);
        });
        outputStream.once("error", () => {
          if (!response.headersSent) json(response, 500, { error: "render output could not be read" });
          else response.destroy();
        });
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
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  server.once("listening", () => {
    void ready.then(pump).catch((error) => {
      process.stderr.write(`NEXUS render queue recovery error: ${String(error?.message ?? error)}\\n`);
    });
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createRenderJobServer();
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`NEXUS render-job API listening on :${port}\\n`);
  });
}
