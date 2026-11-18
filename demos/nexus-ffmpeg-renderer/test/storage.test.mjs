import test from "node:test";
import assert from "node:assert/strict";
import { extensionForMime } from "../src/storage.mjs";

test("maps supported generated media MIME types to safe file extensions", () => {
  assert.equal(extensionForMime("image/png"), ".png");
  assert.equal(extensionForMime("image/jpeg; charset=binary"), ".jpg");
  assert.equal(extensionForMime("video/mp4"), ".mp4");
  assert.equal(extensionForMime("audio/mpeg"), ".mp3");
  assert.equal(extensionForMime("application/x-msdownload"), null);
  assert.equal(extensionForMime("text/html"), null);
});
