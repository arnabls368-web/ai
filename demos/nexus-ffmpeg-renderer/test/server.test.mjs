import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { createRenderJobServer } from "../src/server.mjs";
import { signRenderToken } from "../src/auth.mjs";

const TOKEN = "test-token-that-is-at-least-32-characters-long";
const SIGNING_SECRET = "test-signing-secret-that-is-at-least-32-characters";

async function startServer(workRoot, { ffmpegPath } = {}) {
  const server = createRenderJobServer({
    token: TOKEN,
    assetRoot: path.join(workRoot, "assets"),
    workRoot,
    ffmpegPath,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function startSignedServer(workRoot, { ffmpegPath } = {}) {
  const server = createRenderJobServer({
    token: "",
    signingSecret: SIGNING_SECRET,
    assetRoot: path.join(workRoot, "assets"),
    workRoot,
    ffmpegPath,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function signedHeader(tenantId, projectId, scope) {
  return { authorization: `Bearer ${signRenderToken({
    secret: SIGNING_SECRET, tenantId, projectId, scope,
  })}` };
}

async function withWorkRoot(run) {
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-render-test-"));
  try {
    await run(workRoot);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

function validPayload() {
  return {
    manifest: {
      version: 1,
      renderer: "ffmpeg",
      durationSeconds: 1,
      aspectRatio: "16:9",
      output: { resolution: "720p", frameRate: "24", format: "mp4" },
      tracks: { video: [{ scene: 1, startSeconds: 0, durationSeconds: 1, assetId: "scene", fit: "cover" }] },
    },
    assetMap: { scene: "scene.jpg" },
  };
}

async function waitForFailedJob(base, id, headers = { authorization: `Bearer ${TOKEN}` }) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/jobs/${id}`, { headers });
    assert.equal(response.status, 200);
    const job = await response.json();
    if (job.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Render job did not reach a terminal state in time.");
}

test("HTTP server applies bounded request and keep-alive timeouts", async () => {
  await withWorkRoot(async (workRoot) => {
    const instance = await startServer(workRoot);
    try {
      assert.equal(instance.server.requestTimeout, 30_000);
      assert.equal(instance.server.headersTimeout, 15_000);
      assert.equal(instance.server.keepAliveTimeout, 5_000);
    } finally {
      await instance.close();
    }
  });
});

test("restricts persisted job storage permissions", async () => {
  await withWorkRoot(async (workRoot) => {
    const instance = await startServer(workRoot);
    try {
      const rootInfo = await stat(workRoot);
      assert.equal(rootInfo.mode & 0o777, 0o700);
      const response = await fetch(`${instance.base}/jobs`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(response.status, 202);
      const { id } = await response.json();
      await waitForFailedJob(instance.base, id);
      const jobDirectory = path.join(workRoot, id);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const record = await stat(path.join(jobDirectory, "job.json"));
          assert.equal(record.mode & 0o777, 0o600);
          break;
        } catch {
          if (attempt === 99) throw new Error("Job record was not persisted.");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const directoryInfo = await stat(jobDirectory);
      assert.equal(directoryInfo.mode & 0o777, 0o700);
    } finally {
      await instance.close();
    }
  });
});
test("restart recovery rejects symlinked completed render outputs", async () => {
  await withWorkRoot(async (workRoot) => {
    const assetRoot = path.join(workRoot, "assets");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(path.join(assetRoot, "scene.jpg"), "image");
    const fakeFfmpeg = path.join(workRoot, "fake-ffmpeg");
    await writeFile(fakeFfmpeg, "#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync(process.argv.at(-1), 'fake mp4 output');\n");
    await chmod(fakeFfmpeg, 0o700);
    const first = await startServer(workRoot, { ffmpegPath: fakeFfmpeg });
    let id;
    try {
      const submitted = await fetch(`${first.base}/jobs`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(submitted.status, 202);
      ({ id } = await submitted.json());
      let job;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await fetch(`${first.base}/jobs/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        job = await response.json();
        if (job.status === "succeeded" || job.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(job.status, "succeeded");
    } finally {
      await first.close();
    }
    const outputPath = path.join(workRoot, id, "render.mp4");
    const externalFile = path.join(workRoot, "outside.mp4");
    await rm(outputPath, { force: true });
    await writeFile(externalFile, "not a renderer-owned output");
    await symlink(externalFile, outputPath);
    const restarted = await startServer(workRoot, { ffmpegPath: fakeFfmpeg });
    try {
      const status = await fetch(`${restarted.base}/jobs/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(status.status, 200);
      const recovered = await status.json();
      assert.equal(recovered.status, "failed");
      const output = await fetch(`${restarted.base}/jobs/${id}/output`, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(output.status, 409);
    } finally {
      await restarted.close();
    }
  });
});
test("output download refuses symlink replacement after job completion", async () => {
  await withWorkRoot(async (workRoot) => {
    const assetRoot = path.join(workRoot, "assets");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(path.join(assetRoot, "scene.jpg"), "image");
    const fakeFfmpeg = path.join(workRoot, "fake-ffmpeg");
    await writeFile(fakeFfmpeg, ["#!/usr/bin/env node", "const fs = require('node:fs');", "fs.writeFileSync(process.argv.at(-1), 'fake mp4 output');", ""].join("\n"));
    await chmod(fakeFfmpeg, 0o700);
    const instance = await startServer(workRoot, { ffmpegPath: fakeFfmpeg });
    try {
      const submitted = await fetch(`${instance.base}/jobs`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(submitted.status, 202);
      const { id } = await submitted.json();
      let job;
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        const status = await fetch(`${instance.base}/jobs/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        job = await status.json();
        if (job.status === "succeeded" || job.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(job.status, "succeeded");
      const outputPath = path.join(workRoot, id, "render.mp4");
      const externalFile = path.join(workRoot, "outside-download.mp4");
      await rm(outputPath, { force: true });
      await writeFile(externalFile, "must not be served");
      await symlink(externalFile, outputPath);
      const download = await fetch(`${instance.base}/jobs/${id}/output`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(download.status, 500);
      assert.equal(await download.text().then((body) => body.includes("must not be served")), false);
    } finally {
      await instance.close();
    }
  });
});

test("render execution rejects symlink output paths", async () => {
  await withWorkRoot(async (workRoot) => {
    const assetRoot = path.join(workRoot, "assets");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(path.join(assetRoot, "scene.jpg"), "image");
    const externalFile = path.join(workRoot, "outside.mp4");
    await writeFile(externalFile, "do not modify this target");
    const fakeFfmpeg = path.join(workRoot, "fake-ffmpeg");
    const script = ["#!/bin/sh", 'for arg do output="$arg"; done', `ln -s ${JSON.stringify(externalFile)} "$output"`, ""].join("\n");
    await writeFile(fakeFfmpeg, script);
    await chmod(fakeFfmpeg, 0o700);
    const instance = await startServer(workRoot, { ffmpegPath: fakeFfmpeg });
    try {
      const submitted = await fetch(`${instance.base}/jobs`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(submitted.status, 202);
      const { id } = await submitted.json();
      let job;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const status = await fetch(`${instance.base}/jobs/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        job = await status.json();
        if (job.status === "succeeded" || job.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(job.status, "failed", `unexpected terminal job state: ${job.status}; ${job.error ?? ""}`);
      assert.match(job.error, /regular.*file/i);
      assert.equal(await (await import("node:fs/promises")).readFile(externalFile, "utf8"), "do not modify this target");
      assert.equal((await stat(externalFile)).mode & 0o777, 0o644);
    } finally {
      await instance.close();
    }
  });
});
test("health endpoint is available without credentials", async () => {
  await withWorkRoot(async (workRoot) => {
    const server = await startServer(workRoot);
    try {
      const response = await fetch(`${server.base}/health`);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.service, "nexus-render-jobs");
      assert.equal(result.persistence, "filesystem");
    } finally {
      await server.close();
    }
  });
});

test("stores completed render outputs with owner-only permissions", async () => {
  await withWorkRoot(async (workRoot) => {
    const assetRoot = path.join(workRoot, "assets");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(path.join(assetRoot, "scene.jpg"), "image");
    const fakeFfmpeg = path.join(workRoot, "fake-ffmpeg");
    await writeFile(fakeFfmpeg, "#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync(process.argv.at(-1), 'fake mp4 output');\n");
    await chmod(fakeFfmpeg, 0o700);
    const instance = await startServer(workRoot, { ffmpegPath: fakeFfmpeg });
    try {
      const response = await fetch(`${instance.base}/jobs`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(response.status, 202);
      const { id } = await response.json();
      let job;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const status = await fetch(`${instance.base}/jobs/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        job = await status.json();
        if (job.status === "succeeded" || job.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(job.status, "succeeded");
      const output = await stat(path.join(workRoot, id, "render.mp4"));
      assert.equal(output.mode & 0o777, 0o600);
    } finally {
      await instance.close();
    }
  });
});
test("job API rejects missing bearer credentials", async () => {
  await withWorkRoot(async (workRoot) => {
    const server = await startServer(workRoot);
    try {
      const response = await fetch(`${server.base}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(response.status, 401);
    } finally {
      await server.close();
    }
  });
});

test("job API rejects non-JSON submission content types", async () => {
  await withWorkRoot(async (workRoot) => {
    const instance = await startServer(workRoot);
    try {
      const response = await fetch(`${instance.base}/jobs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "text/plain",
        },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(response.status, 415);
    } finally {
      await instance.close();
    }
  });
});

test("authenticated job submission validates manifests before queueing", async () => {
  await withWorkRoot(async (workRoot) => {
    const server = await startServer(workRoot);
    try {
      const invalid = await fetch(`${server.base}/jobs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ manifest: {}, assetMap: {} }),
      });
      assert.equal(invalid.status, 400);
      assert.match((await invalid.json()).error, /manifest/i);

      const response = await fetch(`${server.base}/jobs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(response.status, 202);
      const result = await response.json();
      assert.match(result.id, /^[0-9a-f-]{36}$/i);
      assert.ok(["queued", "running"].includes(result.status));
      assert.equal(result.statusUrl, `/jobs/${result.id}`);
      await waitForFailedJob(server.base, result.id);
    } finally {
      await server.close();
    }
  });
});

test("restart recovery enforces the bounded render queue", async () => {
  await withWorkRoot(async (workRoot) => {
    const ids = Array.from({ length: 5 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    for (const id of ids) {
      const directory = path.join(workRoot, id);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "job.json"), JSON.stringify({
        id,
        tenantId: null,
        projectId: null,
        status: "queued",
        createdAt: new Date().toISOString(),
        ...validPayload(),
      }));
    }
    const restarted = await startServer(workRoot);
    try {
      const results = [];
      for (const id of ids) {
        let job;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const response = await fetch(`${restarted.base}/jobs/${id}`, {
            headers: { authorization: `Bearer ${TOKEN}` },
          });
          assert.equal(response.status, 200);
          job = await response.json();
          if (job.status === "failed" || job.status === "succeeded") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(job.status, "failed");
        results.push(job);
      }
      assert.equal(results.filter((job) => /queue capacity was exceeded during service recovery/i.test(job.error ?? "")).length, 2);
    } finally {
      await restarted.close();
    }
  });
});

test("live submissions cannot exceed the bounded queue capacity", async () => {
  await withWorkRoot(async (workRoot) => {
    const assetRoot = path.join(workRoot, "assets");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(path.join(assetRoot, "scene.jpg"), "image");
    const fakeFfmpeg = path.join(workRoot, "slow-fake-ffmpeg");
    await writeFile(fakeFfmpeg, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "setTimeout(() => fs.writeFileSync(process.argv.at(-1), 'fake mp4 output'), 700);",
      "",
    ].join("\n"));
    await chmod(fakeFfmpeg, 0o700);
    const instance = await startServer(workRoot, { ffmpegPath: fakeFfmpeg });
    try {
      const submit = () => fetch(`${instance.base}/jobs`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      });
      const first = await submit();
      assert.equal(first.status, 202);
      const second = await submit();
      assert.equal(second.status, 202);
      const third = await submit();
      assert.equal(third.status, 202);
      const accepted = await Promise.all([first, second, third].map((response) => response.json()));
      const fourth = await submit();
      assert.equal(fourth.status, 429);
      assert.match((await fourth.json()).error, /queue is full/i);

      // Do not remove the temporary work root while accepted FFmpeg jobs are
      // still writing their outputs; otherwise cleanup races the render worker.
      for (const { id } of accepted) {
        let job;
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const status = await fetch(`${instance.base}/jobs/${id}`, {
            headers: { authorization: `Bearer ${TOKEN}` },
          });
          assert.equal(status.status, 200);
          job = await status.json();
          if (job.status === "succeeded" || job.status === "failed") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(job.status, "succeeded");
      }
    } finally {
      await instance.close();
    }
  });
});

test("concurrent live submissions reserve queue capacity atomically", async () => {
  await withWorkRoot(async (workRoot) => {
    const assetRoot = path.join(workRoot, "assets");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(path.join(assetRoot, "scene.jpg"), "image");
    const fakeFfmpeg = path.join(workRoot, "slow-fake-ffmpeg");
    await writeFile(fakeFfmpeg, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "setTimeout(() => fs.writeFileSync(process.argv.at(-1), 'fake mp4 output'), 250);",
      "",
    ].join("\n"));
    await chmod(fakeFfmpeg, 0o700);
    const instance = await startServer(workRoot, { ffmpegPath: fakeFfmpeg });
    try {
      const submit = () => fetch(`${instance.base}/jobs`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      });
      const responses = await Promise.all(Array.from({ length: 10 }, () => submit()));
      assert.equal(responses.filter((response) => response.status === 202).length, 3);
      assert.equal(responses.filter((response) => response.status === 429).length, 7);
      const accepted = await Promise.all(responses.filter((response) => response.status === 202).map((response) => response.json()));
      for (const { id } of accepted) {
        let job;
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const status = await fetch(`${instance.base}/jobs/${id}`, {
            headers: { authorization: `Bearer ${TOKEN}` },
          });
          job = await status.json();
          if (job.status === "succeeded" || job.status === "failed") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(job.status, "succeeded");
      }
    } finally {
      await instance.close();
    }
  });
});

test("restart recovery removes stale partial private-asset downloads before retrying", async () => {
  await withWorkRoot(async (workRoot) => {
    const keys = ["AWS_ENDPOINT_URL", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION", "AWS_S3_URL_STYLE"];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    const id = "12345678-1234-4234-8234-123456789abe";
    const assetRoot = path.join(workRoot, "assets");
    const temporaryAssetRoot = path.join(assetRoot, id);
    const localAsset = createHash("sha256").update("scene").digest("hex") + ".jpg";
    try {
      process.env.AWS_ENDPOINT_URL = "https://objects.example.test";
      process.env.AWS_S3_BUCKET_NAME = "nexus-private";
      process.env.AWS_ACCESS_KEY_ID = "test-access";
      process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
      process.env.AWS_DEFAULT_REGION = "auto";
      process.env.AWS_S3_URL_STYLE = "virtual-host";

      await mkdir(temporaryAssetRoot, { recursive: true });
      await writeFile(path.join(temporaryAssetRoot, localAsset), "partial download");
      const directory = path.join(workRoot, id);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "job.json"), JSON.stringify({
        id,
        tenantId: "tenant-a",
        projectId: "project-1",
        status: "queued",
        createdAt: new Date().toISOString(),
        ...validPayload(),
      }));

      const fakeFfmpeg = path.join(workRoot, "fake-ffmpeg");
      await writeFile(fakeFfmpeg, "#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync(process.argv.at(-1), 'fake mp4 output');\n");
      await chmod(fakeFfmpeg, 0o700);
      let assetFetches = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url).startsWith("http://127.0.0.1:")) return originalFetch(url, init);
        assetFetches += 1;
        assert.equal(init.method, "GET");
        return new Response(Buffer.from("restored private image"), { status: 200 });
      };

      const restarted = await startSignedServer(workRoot, { ffmpegPath: fakeFfmpeg });
      try {
        let job;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const response = await fetch(`${restarted.base}/jobs/${id}`, {
            headers: signedHeader("tenant-a", "project-1", "render:read"),
          });
          assert.equal(response.status, 200);
          job = await response.json();
          if (job.status === "succeeded" || job.status === "failed") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(job.status, "succeeded");
        // The API exposes the in-memory terminal state before the finally block
        // has completed its cleanup and persisted the final job record. Wait for
        // that durable record before closing the server and removing the fixture.
        let persistedJob;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          try {
            persistedJob = JSON.parse(await readFile(path.join(workRoot, id, "job.json"), "utf8"));
          } catch {
            // The first atomic write may still be in progress.
          }
          if (persistedJob?.status === "succeeded") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(persistedJob?.status, "succeeded");
        assert.equal(assetFetches, 1);
      } finally {
        await restarted.close();
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test("restart recovery ignores malformed persisted job manifests", async () => {
  await withWorkRoot(async (workRoot) => {
    const id = "12345678-1234-4234-8234-123456789abc";
    const directory = path.join(workRoot, id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "job.json"), JSON.stringify({
      id,
      tenantId: null,
      projectId: null,
      status: "queued",
      createdAt: new Date().toISOString(),
      manifest: { unexpected: "unvalidated persisted data" },
      assetMap: {},
    }));
    const restarted = await startServer(workRoot);
    try {
      const response = await fetch(`${restarted.base}/jobs/${id}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(response.status, 404);
    } finally {
      await restarted.close();
    }
  });
});

test("restart recovery rejects NUL bytes in persisted asset paths", async () => {
  await withWorkRoot(async (workRoot) => {
    const id = "12345678-1234-4234-8234-123456789abd";
    const directory = path.join(workRoot, id);
    await mkdir(directory, { recursive: true });
    const payload = validPayload();
    payload.assetMap.scene = "scene\0.jpg";
    await writeFile(path.join(directory, "job.json"), JSON.stringify({
      id,
      tenantId: null,
      projectId: null,
      status: "queued",
      createdAt: new Date().toISOString(),
      manifest: payload.manifest,
      assetMap: payload.assetMap,
    }));
    const restarted = await startServer(workRoot);
    try {
      const response = await fetch(`${restarted.base}/jobs/${id}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(response.status, 404);
    } finally {
      await restarted.close();
    }
  });
});

test("job status survives a render-service restart", async () => {
  await withWorkRoot(async (workRoot) => {
    const first = await startServer(workRoot);
    let jobId;
    try {
      const response = await fetch(`${first.base}/jobs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(response.status, 202);
      jobId = (await response.json()).id;
      await waitForFailedJob(first.base, jobId);
    } finally {
      await first.close();
    }

    const restarted = await startServer(workRoot);
    try {
      const response = await fetch(`${restarted.base}/jobs/${jobId}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(response.status, 200);
      const job = await response.json();
      assert.equal(job.id, jobId);
      assert.equal(job.status, "failed");
      assert.match(job.error, /ENOENT|asset/i);
      assert.equal("manifest" in job, false);
      assert.equal("assetMap" in job, false);
    } finally {
      await restarted.close();
    }
  });
});

test("signed render jobs are isolated by tenant and project", async () => {
  await withWorkRoot(async (workRoot) => {
    const server = await startSignedServer(workRoot);
    try {
      const submitted = await fetch(`${server.base}/jobs`, {
        method: "POST",
        headers: { ...signedHeader("tenant-a", "project-1", "render:submit"), "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(submitted.status, 202);
      const { id } = await submitted.json();
      await waitForFailedJob(server.base, id, signedHeader("tenant-a", "project-1", "render:read"));

      const wrongTenant = await fetch(`${server.base}/jobs/${id}`, {
        headers: signedHeader("tenant-b", "project-1", "render:read"),
      });
      assert.equal(wrongTenant.status, 404);

      const wrongProject = await fetch(`${server.base}/jobs/${id}`, {
        headers: signedHeader("tenant-a", "project-2", "render:read"),
      });
      assert.equal(wrongProject.status, 404);

      const owner = await fetch(`${server.base}/jobs/${id}`, {
        headers: signedHeader("tenant-a", "project-1", "render:read"),
      });
      assert.equal(owner.status, 200);
      const publicRecord = await owner.json();
      assert.equal(publicRecord.id, id);
      assert.equal("tenantId" in publicRecord, false);
      assert.equal("projectId" in publicRecord, false);
    } finally {
      await server.close();
    }
  });
});

test("signed render API enforces separate submit and read scopes", async () => {
  await withWorkRoot(async (workRoot) => {
    const server = await startSignedServer(workRoot);
    try {
      const denied = await fetch(`${server.base}/jobs`, {
        method: "POST",
        headers: { ...signedHeader("tenant-a", "project-1", "render:read"), "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(denied.status, 401);
    } finally {
      await server.close();
    }
  });
});

test("production mode refuses legacy shared bearer-token authentication", async () => {
  assert.throws(
    () => createRenderJobServer({
      token: TOKEN,
      signingSecret: "",
      allowLegacyToken: false,
      workRoot: path.join(os.tmpdir(), "nexus-render-production-auth-test"),
    }),
    /NEXUS_RENDER_SIGNING_SECRET is required when NODE_ENV=production/,
  );
});

test("signed renderer auth-check confirms service-to-service credentials", async () => {
  await withWorkRoot(async (workRoot) => {
    const server = await startSignedServer(workRoot);
    try {
      const response = await fetch(`${server.base}/auth-check`, {
        headers: signedHeader("tenant-a", "project-1", "render:read"),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        service: "nexus-render-jobs",
        authorization: "signed",
        scope: "render:read",
      });
    } finally {
      await server.close();
    }
  });
});

test("renderer auth-check refuses legacy credentials instead of claiming signed auth", async () => {
  await withWorkRoot(async (workRoot) => {
    const server = await startServer(workRoot);
    try {
      const response = await fetch(`${server.base}/auth-check`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "signed authorization required" });
    } finally {
      await server.close();
    }
  });
});


test("signed asset upload route rejects render scopes before touching object storage", async () => {
  await withWorkRoot(async (workRoot) => {
    const server = await startSignedServer(workRoot);
    try {
      for (const scope of ["render:read", "render:submit"]) {
        const response = await fetch(`${server.base}/assets/scene-1`, {
          method: "PUT",
          headers: {
            ...signedHeader("tenant-a", "project-1", scope),
            "content-type": "image/png",
          },
          body: Buffer.from("test-image"),
        });
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: "unauthorized" });
      }
    } finally {
      await server.close();
    }
  });
});


test("signed asset-write authorization stores uploaded bytes in private object storage", async () => {
  await withWorkRoot(async (workRoot) => {
    const keys = [
      "AWS_ENDPOINT_URL", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION", "AWS_S3_URL_STYLE",
    ];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    let storedRequest;
    try {
      process.env.AWS_ENDPOINT_URL = "https://objects.example.test";
      process.env.AWS_S3_BUCKET_NAME = "nexus-private";
      process.env.AWS_ACCESS_KEY_ID = "test-access";
      process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
      process.env.AWS_DEFAULT_REGION = "auto";
      process.env.AWS_S3_URL_STYLE = "virtual-host";
      globalThis.fetch = async (url, init) => {
        if (String(url).startsWith("http://127.0.0.1:")) return originalFetch(url, init);
        const chunks = [];
        for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
        storedRequest = {
          url: String(url),
          method: init.method,
          body: Buffer.concat(chunks),
          contentLength: new Headers(init.headers).get("content-length"),
          payloadHash: new Headers(init.headers).get("x-amz-content-sha256"),
          duplex: init.duplex,
        };
        return new Response(null, { status: 200 });
      };

      const server = await startSignedServer(workRoot);
      try {
        const bytes = Buffer.from("private-image-bytes");
        const response = await originalFetch(`${server.base}/assets/scene-1`, {
          method: "PUT",
          headers: {
            ...signedHeader("tenant-a", "project-1", "asset:write"),
            "content-type": "image/png",
          },
          body: bytes,
        });
        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), {
          assetId: "scene-1",
          filename: "scene-1.png",
          bytes: bytes.length,
          storage: "private_object_storage",
        });
        assert.equal(storedRequest.method, "PUT");
        assert.deepEqual(storedRequest.body, bytes);
        assert.equal(storedRequest.contentLength, String(bytes.length));
        assert.equal(storedRequest.payloadHash, createHash("sha256").update(bytes).digest("hex"));
        assert.equal(storedRequest.duplex, "half");
        assert.ok(storedRequest.url.startsWith("https://nexus-private.objects.example.test/assets/tenant-a/project-1/"));
      } finally {
        await server.close();
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});


test("signed asset upload rejects an oversized declared body before reading it", async () => {
  await withWorkRoot(async (workRoot) => {
    const server = await startSignedServer(workRoot);
    try {
      const result = await new Promise((resolve, reject) => {
        const request = httpRequest(server.base + "/assets/scene-too-large", {
          method: "PUT",
          headers: {
            ...signedHeader("tenant-a", "project-1", "asset:write"),
            "content-type": "image/png",
            "content-length": String(100 * 1024 * 1024 + 1),
          },
        }, (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }));
        });
        request.on("error", reject);
        request.end();
      });
      assert.equal(result.status, 413);
      assert.deepEqual(JSON.parse(result.body), { error: "Asset exceeds the 100 MiB limit." });
    } finally {
      await server.close();
    }
  });
});
