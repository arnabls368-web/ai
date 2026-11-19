import test from "node:test";
import assert from "node:assert/strict";
import { validateYouTubeUploadUrl } from "./youtube-upload-url.mjs";

test("accepts Google's canonical resumable session URL and preserves opaque query", () => {
  const value = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=opaque-session-token";
  assert.equal(validateYouTubeUploadUrl(value), value);
});

test("rejects non-HTTPS, untrusted hosts, ports and URL credentials", () => {
  const invalid = [
    "http://www.googleapis.com/upload/youtube/v3/videos?upload_id=x",
    "https://evil.example/upload/youtube/v3/videos?upload_id=x",
    "https://www.googleapis.com:444/upload/youtube/v3/videos?upload_id=x",
    "https://user@www.googleapis.com/upload/youtube/v3/videos?upload_id=x",
    "https://user:pass@www.googleapis.com/upload/youtube/v3/videos?upload_id=x",
  ];
  for (const value of invalid) {
    assert.throws(() => validateYouTubeUploadUrl(value), /unexpected upload URL/);
  }
});

test("rejects unexpected Google paths, fragments and malformed URLs", () => {
  const invalid = [
    "https://www.googleapis.com/other/path?upload_id=x",
    "https://www.googleapis.com/upload/youtube/v3/videos/../other?upload_id=x",
    "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=x#fragment",
    "not a URL",
  ];
  for (const value of invalid) {
    assert.throws(() => validateYouTubeUploadUrl(value));
  }
});
