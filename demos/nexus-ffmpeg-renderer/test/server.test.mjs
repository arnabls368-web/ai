import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

async function startSignedServer(workRoot) {
  const server = createRenderJobServer({
    token: "",
    signingSecret: SIGNING_SECRET,
    assetRoot: path.join(workRoot, "assets"),
    workRoot,
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
      const rootInfo = await (await import("node:fs/promises")).stat(workRoot);
      assert.equal(rootInfo.mode & 0o777, 0o700);
      const response = await fetch(`${instance.base}/jobs`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(response.status, 202);
      const { id } = await response.json();
      const jobDirectory = path.join(workRoot, id);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const record = await (await import("node:fs/promises")).stat(path.join(jobDirectory, "job.json"));
          assert.equal(record.mode & 0o777, 0o600);
          break;
        } catch {
          if (attempt === 99) throw new Error("Job record was not persisted.");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const directoryInfo = await (await import("node:fs/promises")).stat(jobDirectory);
      assert.equal(directoryInfo.mode & 0o777, 0o700);
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
