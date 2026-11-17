import test from "node:test";
import assert from "node:assert/strict";
import { createRenderJobServer } from "../src/server.mjs";

async function withServer(run) {
  const server = createRenderJobServer({
    token: "test-token-that-is-at-least-32-characters-long",
    assetRoot: "/tmp/nexus-test-assets",
    workRoot: "/tmp/nexus-test-work",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("health endpoint is available without credentials", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).service, "nexus-render-jobs");
  });
});

test("job API rejects missing or invalid bearer credentials", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: {}, assetMap: {} }),
    });
    assert.equal(response.status, 401);
  });
});

test("authenticated job submission returns an opaque job ID", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token-that-is-at-least-32-characters-long",
        "content-type": "application/json",
      },
      body: JSON.stringify({ manifest: {}, assetMap: {} }),
    });
    assert.equal(response.status, 202);
    const result = await response.json();
    assert.match(result.id, /^[0-9a-f-]{36}$/i);
    assert.equal(result.status, "queued");
    assert.equal(result.statusUrl, `/jobs/${result.id}`);
  });
});
