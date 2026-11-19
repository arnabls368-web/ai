# NEXUS renderer production integration plan

Status: partially implemented and deployed; production end-to-end verification is still outstanding. This document distinguishes implemented code and deployed infrastructure from capabilities that have not yet been proven against live providers.

## Current rollout checkpoint (2026-11-19)

- Latest reviewed feature-branch head: `0ffe4ecd0967f1248e6e2d10290c8262df7d08cb`.
- All workflows for this head completed successfully, except the prerelease workflow which was correctly skipped: main CI, Semgrep OSS scan, NEXUS FFmpeg renderer, YouTube MCP type check, and deployment-bundle build.
- The renderer workflow passed unit tests, container build, a real FFmpeg encode smoke test, non-root startup, and persistent-volume checks. These are CI/container validations; they do not prove the currently deployed Railway service has been switched to the repository Dockerfile.
- The live Railway renderer is still configured to use Railpack, with one replica and the persistent volume mounted at `/work`. The Dockerfile's `RAILWAY_RUN_UID=0` entrypoint path is not a current live-service prerequisite unless an operator deliberately changes the builder to Dockerfile and approves that rollout.
- The Cloudflare Worker remains on its existing production version. Its live configuration still lacks the `OAUTH_STATE` Durable Object binding/migration required by the current OAuth state implementation. Do not treat the new OAuth state flow as production-ready until the migration and binding are deployed and verified.
- The Cloudflare deployment workflow is manual-only (`workflow_dispatch`) and its credential-bearing deployment job is restricted to `refs/heads/main`. This is a workflow guard, not a substitute for branch protection, environment approvals, or explicit rollout authorization.
- The feature PR remains open and in draft. No production Worker deployment, Durable Object migration, Railway deployment/configuration change, S3 write/delete integration test, or YouTube upload was performed as part of this validation.

## Current architecture

- The Cloudflare Worker authenticates NEXUS MCP requests through Google OAuth and scopes project records in KV using a normalized Google-account owner hash.
- The Worker stores render manifests and per-project asset metadata in KV.
- Renderer requests use short-lived HMAC-SHA256 bearer credentials bound to the renderer audience, tenant, project, scope, and expiry. Separate scopes protect asset writes, render submission, and render reads.
- The Railway FFmpeg renderer runs as a single-process, single-replica job service. It persists job records and completed MP4 outputs on a mounted filesystem volume.
- Generated assets are transferred from HTTPS `fal.media` URLs through the Worker, then stored in a private Railway S3-compatible bucket under tenant/project-scoped object keys.
- During a render, the renderer retrieves each referenced private object, writes a temporary owner-only local copy, invokes FFmpeg with argument arrays and local-file-only input protocols, and removes the temporary asset directory after the job.
- The Worker polls job status and retrieves the completed MP4 through signed, owner/project-bound requests.
- YouTube upload is a separate action. It is private-only, requires explicit approval for the exact video and title, and has a 50 MiB buffering limit. No automatic public publishing is enabled.

## Deployed resources and boundaries

- Cloudflare Worker: `phn-youtube-mcp`.
- Railway project: `NEXUS Universe Renderer`; service: `nexus-ffmpeg-renderer`.
- Railway object bucket: private S3-compatible storage, configured for virtual-host addressing in Singapore.
- Railway persistent volume: mounted at `/work` for job records and rendered outputs.
- The renderer exposes HTTPS endpoints protected by short-lived signed credentials. Its public HTTPS ingress is not private-network-only; authentication and tenant/project authorization are therefore mandatory.
- The service must remain at one replica. Its in-memory queue is not distributed and does not coordinate multiple processes.
- Health checks prove process liveness only. They do not prove object-storage access, render success, output retrieval, or YouTube upload.

## Verified implementation

- Worker-side project ownership checks precede asset transfer, render submission, status retrieval, and output handoff.
- Asset intake restricts sources to HTTPS `fal.media` hosts, rejects redirects, checks allowed media MIME types, and enforces a 100 MiB transfer limit.
- Renderer storage code signs S3-compatible PUT and GET requests and uses tenant/project-scoped object keys.
- Automated storage tests verify signing, virtual-host addressing, and PUT/GET round trips against a mocked storage endpoint.
- Renderer tests cover manifest validation, signed authorization, job ownership, bounded queue recovery, symlink defenses, and owner-only local file permissions.
- Latest CI on `0ffe4ecd0967f1248e6e2d10290c8262df7d08cb` passed main CI, the renderer Docker/FFmpeg/non-root/volume checks, YouTube MCP type checks, deployment-bundle build, and Semgrep OSS scan.
- The latest Semgrep workflow completed successfully. A successful scan does not replace live-provider verification.
- The deployed renderer health endpoint has returned HTTP 200, and the latest deployment started successfully.

## Not yet verified

- A real PUT and GET against the configured Railway bucket using the deployed credentials.
- A full authenticated Worker-to-renderer asset transfer using a real synthetic media asset.
- A successful real FFmpeg job that retrieves private bucket objects, produces an MP4, and returns it through the signed output route.
- Job persistence and recovery across an actual Railway container restart.
- A complete Worker-side output handoff to the private YouTube uploader.
- Provider-level cleanup and lifecycle behavior for orphaned private objects.

Mocked storage tests and a healthy HTTP endpoint must not be described as proof of those live integrations.

## Remaining production risks and limits

- The job queue is single-process, in-memory, and limited to one concurrent render by default; one replica is required.
- There are no distributed queue semantics, idempotency keys, cancellation, authenticated callbacks, or multi-replica coordination.
- Asset transfer buffers up to 100 MiB in the Worker; YouTube upload buffers up to 50 MiB. Do not raise these limits without redesigning memory use.
- Private object lifecycle cleanup, orphan handling, quotas, and retention policy need implementation and verification.
- Railway HTTPS ingress is publicly addressable even though the API requires signed authorization. Private-network-only ingress remains a possible hardening improvement.
- If the Railway service is intentionally switched from Railpack to the repository Dockerfile, review its entrypoint and mounted-volume ownership requirements (including the documented runtime UID override) before rollout. This is not a requirement for the currently configured Railpack service.

## Rollout gates

1. Keep the current single-replica limit and preserve signed tenant/project authorization.
2. Obtain explicit authorization before running an isolated live S3-compatible PUT/GET test with a random test key, then verify deletion. Do not use user media or overwrite existing keys.
3. Obtain explicit authorization before running one synthetic authenticated asset-transfer and render test; verify job status, MP4 MIME type, output bytes, and owner/project isolation.
4. Verify restart recovery with a disposable test job and confirm the persistent output remains readable, only after explicit rollout approval.
5. Review object cleanup, quotas, resource limits, and retention before increasing usage.
6. Keep YouTube upload private-only and separately approval-gated. Do not merge the draft pull request or enable public publishing without explicit review.

## Operational safety

- Never log or expose API keys, S3 credentials, OAuth tokens, signing secrets, or signed URLs.
- Do not run live object-storage writes or deletions except for a specifically isolated test key and only with explicit authorization.
- Do not trigger production restarts, redeployments, scaling, paid services, or public uploads as part of passive verification.
- Report implementation, deployment, and live-provider verification as separate states.
