import assert from "node:assert/strict";
import test from "node:test";
import { getStoryboardSceneLimits, MAX_RENDER_SCENES } from "./scene-limits.mjs";

test("default three-hour storyboard is rejected with a usable minimum scene length", () => {
  const limits = getStoryboardSceneLimits(10_800, 8);
  assert.equal(limits.sceneCount, 1_350);
  assert.equal(limits.minimumSceneSeconds, 22);
  assert.ok(limits.sceneCount > MAX_RENDER_SCENES);
});

test("three-hour storyboard fits when scene length is increased to the minimum", () => {
  const limits = getStoryboardSceneLimits(10_800, 22);
  assert.equal(limits.sceneCount, 491);
  assert.ok(limits.sceneCount <= MAX_RENDER_SCENES);
});

test("the exact 500-scene boundary is accepted", () => {
  assert.equal(getStoryboardSceneLimits(1_500, 3).sceneCount, 500);
  assert.equal(getStoryboardSceneLimits(1_501, 3).sceneCount, 501);
});

test("ordinary eight-second storyboard remains unchanged", () => {
  assert.equal(getStoryboardSceneLimits(600, 8).sceneCount, 75);
});
