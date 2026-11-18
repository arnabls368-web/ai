import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRenderJobServer } from "../src/server.mjs";

const TOKEN = "test-token-that-is-at-least-32-characters-long";

async function startServer(workRoot) {
  const server = createRenderJobServer({
    token: TOKEN,
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

async function waitForFailedJob(base, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/jobs/${id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    const job = await response.json();
    if (job.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Render job did not reach a terminal state in time.");
}

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
