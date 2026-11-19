export type FalGenerationLifecycle = "pending" | "completed" | "failed" | "unknown";
export function classifyFalGenerationStatus(status: { status?: string; error?: unknown; error_type?: unknown } | null | undefined): FalGenerationLifecycle;
export function isFalGenerationFailed(status: { status?: string; error?: unknown; error_type?: unknown } | null | undefined): boolean;
