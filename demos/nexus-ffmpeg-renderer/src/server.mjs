import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { renderManifest } from "./renderer.mjs";

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

function authorized(request, token) {
  const header = request.headers.authorization ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
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
  assetRoot = process.env.NEXUS_ASSET_ROOT ?? "/assets",
  workRoot = process.env.NEXUS_RENDER_WORKDIR ?? "/work",
  maxConcurrent = 1,
} = {}) {
  if (!token || token.length < 32) throw new Error("NEXUS_RENDER_TOKEN must be set to a random secret of at least 32 characters.");
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
    await mkdir(directory, { recursive: true });
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
    await mkdir(workRoot, { recursive: true });
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
    try {
      await persistJob(job);
      const directory = jobDirectory(job.id);
      const outputPath = path.join(directory, "render.mp4");
      await renderManifest({
        manifest: job.manifest,
        assetMap: job.assetMap,
        assetRoot,
        outputPath,
      });
      const output = await stat(outputPath);
      job.status = "succeeded";
      job.outputPath = outputPath;
      job.outputBytes = output.size;
      job.completedAt = new Date().toISOString();
    } catch (error) {
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
      if (!authorized(request, token)) {
        return json(response, 401, { error: "unauthorized" });
      }

      if (request.method === "POST" && url.pathname === "/jobs") {
        try {
          if (queue.length + active >= MAX_QUEUE_SIZE) {
            return json(response, 429, { error: "render queue is full" });
          }
          const body = await readJson(request);
          if (!body || typeof body !== "object" || !body.manifest || !body.assetMap || typeof body.assetMap !== "object") {
            return json(response, 400, { error: "manifest and assetMap are required" });
          }
          const id = randomUUID();
          const job = {
            id,
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

      if (request.method === "GET" && match[2] === "/output") {
        if (job.status !== "succeeded" || !job.outputPath) {
          return json(response, 409, { error: "render output is not ready", status: job.status });
        }
        response.writeHead(200, {
          "content-type": "video/mp4",
          "content-disposition": 'attachment; filename="nexus-render.mp4"',
          "cache-control": "no-store",
        });
        return createReadStream(job.outputPath).pipe(response);
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
