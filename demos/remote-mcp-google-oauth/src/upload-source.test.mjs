import assert from "node:assert/strict";
import test from "node:test";
import { hasExactlyOneUploadSource, isVerifiedRenderJob } from "./upload-source.ts";

test("accepts exactly one public URL source", () => {
  assert.equal(hasExactlyOneUploadSource({ videoUrl: "https://cdn.example/video.mp4" }), true);
});

test("accepts exactly one complete NEXUS render source", () => {
  assert.equal(hasExactlyOneUploadSource({ projectId: "project", renderJobId: "job" }), true);
});

test("rejects missing, mixed, and incomplete upload sources", () => {
  assert.equal(hasExactlyOneUploadSource({}), false);
  assert.equal(hasExactlyOneUploadSource({ projectId: "project" }), false);
  assert.equal(hasExactlyOneUploadSource({ renderJobId: "job" }), false);
  assert.equal(hasExactlyOneUploadSource({ videoUrl: "https://cdn.example/video.mp4", projectId: "project", renderJobId: "job" }), false);
  assert.equal(hasExactlyOneUploadSource({ videoUrl: "https://cdn.example/video.mp4", projectId: "project" }), false);
});

test("accepts only the exact successful render output", () => {
  const project = { id: "project", renderJob: { id: "job", status: "succeeded", outputUrl: "/jobs/job/output" } };
  assert.equal(isVerifiedRenderJob(project, "project", "job"), true);
  assert.equal(isVerifiedRenderJob(project, "other", "job"), false);
  assert.equal(isVerifiedRenderJob(project, "project", "other"), false);
  assert.equal(isVerifiedRenderJob({ ...project, renderJob: { ...project.renderJob, status: "running" } }, "project", "job"), false);
  assert.equal(isVerifiedRenderJob({ ...project, renderJob: { ...project.renderJob, outputUrl: "https://evil.example/video.mp4" } }, "project", "job"), false);
  assert.equal(isVerifiedRenderJob(null, "project", "job"), false);
});
