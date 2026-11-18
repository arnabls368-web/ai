export type UploadSourceInput = {
  videoUrl?: string;
  projectId?: string;
  renderJobId?: string;
};

/** Exactly one source is allowed: a URL, or a complete project/job pair. */
export function hasExactlyOneUploadSource(input: UploadSourceInput): boolean {
  const hasUrl = Boolean(input.videoUrl);
  const hasProject = Boolean(input.projectId);
  const hasJob = Boolean(input.renderJobId);
  const hasRenderPair = hasProject && hasJob;
  return hasUrl !== hasRenderPair && hasProject === hasJob;
}

/** Ensure a saved render record is the exact completed output for this project/job. */
export function isVerifiedRenderJob(
  project: unknown,
  projectId: string,
  renderJobId: string,
): boolean {
  if (!project || typeof project !== "object") return false;
  const record = project as {
    id?: unknown;
    renderJob?: { id?: unknown; status?: unknown; outputUrl?: unknown };
  };
  return record.id === projectId &&
    record.renderJob?.id === renderJobId &&
    record.renderJob?.status === "succeeded" &&
    record.renderJob?.outputUrl === `/jobs/${renderJobId}/output`;
}
