export type UploadSourceInput = {
  videoUrl?: string;
  projectId?: string;
  renderJobId?: string;
};

export declare function hasExactlyOneUploadSource(input: UploadSourceInput): boolean;
export declare function isVerifiedRenderJob(project: unknown, projectId: string, renderJobId: string): boolean;
export declare function isCompleteUploadSourceResponse(status: number): boolean;
