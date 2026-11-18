import assert from "node:assert/strict";
import test from "node:test";
import { validateExternalVideoUrl } from "./external-video-url.mjs";

test("external video URLs require an exact operator-approved HTTPS hostname", () => {
  assert.equal(
    validateExternalVideoUrl("https://media.example.org/video.mp4?signature=abc", "media.example.org"),
    "https://media.example.org/video.mp4?signature=abc",
  );
  assert.throws(
    () => validateExternalVideoUrl("https://sub.media.example.org/video.mp4", "media.example.org"),
    /not on the configured/,
  );
  assert.throws(
    () => validateExternalVideoUrl("https://media.example.org/video.mp4", ""),
    /uploads are disabled/,
  );
});

test("external video URLs reject unsafe schemes, credentials, ports, fragments and IP literals", () => {
  const allowed = "media.example.org";
  for (const url of [
    "http://media.example.org/video.mp4",
    "https://user:pass@media.example.org/video.mp4",
    "https://media.example.org:8443/video.mp4",
    "https://media.example.org/video.mp4#fragment",
    "https://127.0.0.1/video.mp4",
    "https://2130706433/video.mp4",
    "https://[::1]/video.mp4",
    "https://metadata.google.internal/video.mp4",
  ]) {
    assert.throws(() => validateExternalVideoUrl(url, allowed), undefined, url);
  }
});
