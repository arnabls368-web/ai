/** Validate external upload sources against an operator-controlled exact-host allowlist. */
export function validateExternalVideoUrl(input, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Invalid video URL.");
  }
  const hostname = parsed.hostname.toLowerCase();
  const isIpLiteral = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.startsWith("[");
  const isReservedHost = hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") || hostname.endsWith(".internal") ||
    hostname.endsWith(".test") || hostname.endsWith(".invalid") ||
    hostname.endsWith(".example") || hostname === "metadata.google.internal";
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.port || parsed.hash || hostname.endsWith(".") || isIpLiteral || isReservedHost) {
    throw new Error("Use a public HTTPS video URL on a public DNS hostname and standard HTTPS port.");
  }

  const hosts = String(allowedHosts ?? "").split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.length === 0) {
    throw new Error("External video URL uploads are disabled until YOUTUBE_UPLOAD_ALLOWED_HOSTS is configured.");
  }
  if (!hosts.includes(hostname)) {
    throw new Error("This video host is not on the configured YOUTUBE_UPLOAD_ALLOWED_HOSTS allowlist.");
  }
  return parsed.toString();
}
