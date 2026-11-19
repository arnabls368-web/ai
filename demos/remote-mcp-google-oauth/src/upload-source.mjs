/** @typedef {{ videoUrl?: string, projectId?: string, renderJobId?: string }} UploadSourceInput */

/** Exactly one source is allowed: a URL, or a complete project/job pair. */
export function hasExactlyOneUploadSource(input) {
  const hasUrl = Boolean(input.videoUrl);
  const hasProject = Boolean(input.projectId);
  const hasJob = Boolean(input.renderJobId);
  const hasRenderPair = hasProject && hasJob;
  return hasUrl !== hasRenderPair && hasProject === hasJob;
}

/** Ensure a saved render record is the exact completed output for this project/job. */
export function isVerifiedRenderJob(project, projectId, renderJobId) {
  if (!project || typeof project !== "object") return false;
  const record = project;
  return record.id === projectId &&
    record.renderJob?.id === renderJobId &&
    record.renderJob?.status === "succeeded" &&
    record.renderJob?.outputUrl === `/jobs/${renderJobId}/output`;
}
/** Upload sources must return a complete representation, never a partial range. */
export function isCompleteUploadSourceResponse(status) {
  return status === 200;
}
