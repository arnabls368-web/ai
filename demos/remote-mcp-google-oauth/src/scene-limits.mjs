/**
 * Shared storyboard sizing rule. Keep this limit aligned with the FFmpeg
 * renderer's manifest validation.
 */
export const MAX_RENDER_SCENES = 500;

/**
 * @param {number} targetDurationSeconds
 * @param {number} maxSceneSeconds
 */
export function getStoryboardSceneLimits(targetDurationSeconds, maxSceneSeconds) {
  return {
    sceneCount: Math.max(1, Math.ceil(targetDurationSeconds / maxSceneSeconds)),
    minimumSceneSeconds: Math.ceil(targetDurationSeconds / MAX_RENDER_SCENES),
  };
}
