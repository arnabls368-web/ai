# NEXUS renderer production integration plan

Status: design only. No Cloudflare resources, secrets, containers, or external services are created by this document.

## Current verified boundary

- The Cloudflare Worker persists render manifests and project records in KV.
- The FFmpeg package can render locally and has a single-process HTTP job API.
- The HTTP API uses one shared bearer token and local filesystem asset/work directories.
- The renderer does not currently read or write R2, authenticate individual NEXUS accounts, call back to the Worker, or coordinate multiple replicas.
- Therefore the renderer API must not be exposed as a public multi-tenant service in its current form.

## Target request flow

1. An authenticated NEXUS MCP request resolves the Google account scope and project ownership in the Worker.
2. The Worker validates the saved manifest and confirms every asset ID belongs to that same account/project.
3. The Worker creates a durable render-job record with a unique idempotency key and a stable project revision.
4. A private render service receives a signed, short-lived job authorization. It must not receive Google OAuth tokens or the fal/Exa API keys.
5. The renderer obtains input objects from a private R2 bucket using narrowly scoped object access, streams them to bounded local scratch storage, and invokes FFmpeg with argument arrays.
6. The renderer uploads the finished MP4 to a private output prefix in R2, verifies size/content type/checksum, and reports only the job ID and output object key to an authenticated Worker callback.
7. The Worker verifies callback authentication and job ownership, records completion in KV (or D1 if transactional coordination is required), and returns a short-lived download URL only to the owning account.
8. YouTube upload remains a separate action requiring explicit approval for the exact video and title; visibility remains private.

## Required security controls before public deployment

- Replace the single shared bearer token with short-lived, audience-bound job credentials or signed requests; bind every job and object key to an account and project.
- Keep the renderer private behind authenticated service-to-service connectivity. Never expose R2 credentials or Google OAuth tokens to it.
- Validate manifest schema, asset ownership, MIME type, file size, duration, resolution, frame rate, and total resource budget before enqueueing.
- Restrict object keys to server-generated account/project prefixes. Never accept arbitrary remote URLs or caller-selected filesystem paths.
- Add idempotency, durable queue semantics, retry limits, cancellation, concurrency limits, job expiry, and orphaned-object cleanup.
- Enforce per-account quotas and render timeouts. Keep job logs free of credentials and signed URLs.
- Authenticate and replay-protect callbacks; make completion handling idempotent.
- Store outputs privately and use short-lived, owner-authorized download links.

## Infrastructure decisions still required

- Create/select a private R2 bucket and choose its binding name and retention policy.
- Choose a container host that supports persistent or object-backed job orchestration and private service networking.
- Decide whether job state remains in KV for the initial single-owner deployment or moves to D1/Queues for transactional and distributed processing.
- Provision secrets through the host's secret manager only after the architecture and permissions are reviewed.

## Rollout gates

1. Local contract tests for job submission, status, completion, retries, and ownership rejection.
2. Private staging deployment with synthetic assets only.
3. R2 round-trip test with a non-sensitive sample video.
4. End-to-end render test with no YouTube upload.
5. Explicit review before enabling any YouTube upload integration.
