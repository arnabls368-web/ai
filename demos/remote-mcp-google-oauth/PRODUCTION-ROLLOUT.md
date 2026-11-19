# NEXUS production rollout runbook

This document is an operator checklist, not authorization to deploy. The pull request is intentionally kept in draft until the gates below are reviewed. Do not run any step that changes Cloudflare or Railway production state without explicit approval for that rollout.

## Current production boundary

- Cloudflare Worker: `phn-youtube-mcp` at `https://phn-youtube-mcp.arnab368.workers.dev`.
- Railway renderer service: `nexus-ffmpeg-renderer`, one replica in `sin`, with persistent volume mounted at `/work`.
- The live Cloudflare Worker does not yet have the `OAUTH_STATE` Durable Object binding/migration required by the current OAuth state implementation.
- The live Railway service has not enabled `NEXUS_STAGED_ASSET_CLEANUP_ENABLED`.
- The renderer's current Railway deployment uses Railpack, not the repository Dockerfile. The Dockerfile's `RAILWAY_RUN_UID=0` startup path is therefore not a current-service prerequisite unless the service is deliberately switched to the Dockerfile builder.
- Real S3-compatible storage interoperability, Worker-to-renderer transfer, render persistence across restart, and authenticated Google OAuth/YouTube upload have not been proven end to end.
- The Cloudflare deployment workflow is manual-only (`workflow_dispatch`) and its deployment job is restricted to `refs/heads/main`. Selecting a feature branch for manual dispatch must not execute the credential-bearing deploy job. This guard does not replace branch protection, environment approvals, or explicit operator approval for a production rollout.

## Gate 0 — verify before any rollout

- [ ] Confirm the target account, Worker, Railway project/environment/service, and production URLs in the provider dashboards.
- [ ] Confirm the intended Git commit is the reviewed PR head and all required CI/security checks are green.
- [ ] Confirm current Cloudflare Worker version, deployment traffic allocation, compatibility date/flags, KV binding, and all existing Durable Object migrations.
- [ ] Confirm Railway is still single-replica and the persistent `/work` volume is attached.
- [ ] Confirm the active Railway builder (Railpack versus Dockerfile), start command, health check, and all required storage/signing environment variables without exposing secret values.
- [ ] Confirm the object-storage bucket and credentials are the intended private bucket. Never perform a destructive or production write as a connectivity probe.
- [ ] Take/export the current provider configuration and note the exact rollback target.
- [ ] Stop if any observed live setting differs from the assumptions in this runbook.

## Gate 1 — Cloudflare OAuth Durable Object migration

The Wrangler files declare the SQLite-backed `OAUTH_STATE` binding and the first migration tag `v1` creating `OAuthStateDO`. The live Worker does not yet have this binding.

1. Inspect the live Worker configuration and migration history in Cloudflare. Confirm that `v1` has not already been applied under a different class/tag. Never reuse or rewrite an existing migration tag.
2. Review the exact Wrangler diff. Preserve the existing `OAUTH_KV` binding, production secrets, `MCP_RESOURCE`, compatibility flags/date, and unrelated settings.
3. Verify that the Worker code, `OAuthStateDO` class export, binding name, and `v1` migration are all present in the same reviewed commit.
4. Confirm Cloudflare's current Durable Objects migration and deployment semantics, including whether the migration is additive and whether any existing class/storage will be affected. If the live migration history is uncertain, stop and obtain a Cloudflare-specific recovery plan.
5. Only after explicit deployment approval, deploy the reviewed Worker with the pinned Wrangler version and inspect the resulting deployment/version. Do not use a broad account token or print secret values.
6. Verify the deployed script has `OAUTH_STATE` bound to `OAuthStateDO`, and the migration is recorded as applied.
7. Run OAuth verification with a dedicated test Google account/client where possible:
   - first authorization displays the consent screen;
   - modifying the signed approval-state payload is rejected;
   - valid approval creates a state record;
   - callback succeeds once;
   - replaying the callback/state fails;
   - expired state fails and is cleaned up;
   - an already-approved client follows the expected redirect path;
   - existing KV-backed project records remain accessible.
8. Observe Worker errors and OAuth success/failure metrics before declaring the gate complete.

**Rollback warning:** Durable Object migrations are not equivalent to rolling back a stateless Worker script. Do not remove the namespace, delete stored state, or roll back Wrangler migration history as an improvised rollback. If the new Worker code must be rolled back after the class is created, deploy a compatible Worker version that retains the binding/class expectations and consult Cloudflare's migration guidance before any class/schema reversal.

## Gate 2 — Railway renderer and staged-object cleanup

The cleanup code is deliberately scoped to the exact `staged-assets/` prefix and video extensions. It applies a 24-hour age threshold, a 1,000-delete cap and a 100-page cap; it must never be broadened to the permanent `assets/` namespace.

1. Verify the active Railway service still has exactly one replica. The renderer queue and cleanup scheduler are process-local.
2. Verify the active builder and start command. The current service uses Railpack; do not assume Dockerfile entrypoint behavior or set `RAILWAY_RUN_UID=0` unless intentionally switching builders and reviewing volume permissions.
3. Verify required S3-compatible endpoint, bucket, access key, secret key and region variables are present without displaying their values. Confirm the bucket is private and dedicated to NEXUS.
4. Verify the deployed renderer version contains the reviewed cleanup implementation and that the cleanup flag is still disabled.
5. Before enabling scheduled cleanup, perform a reviewed non-destructive storage check using provider-supported metadata/list operations only. Confirm the signing region/endpoint and exact prefix semantics. Do not issue DELETE requests or upload test objects into production without separate approval.
6. Confirm the retention policy: only video objects under `staged-assets/<tenant>/<project>/<sha256>.<extension>` older than 24 hours are eligible. Permanent project assets under `assets/` must never be swept.
7. Only after explicit approval, set `NEXUS_STAGED_ASSET_CLEANUP_ENABLED=true` on the Railway renderer service and allow the normal deployment/restart to complete.
8. Inspect startup logs and the first cleanup result. Confirm `scanned`, `deleted`, `pages` and `truncated` are plausible. If listing or deletion errors occur, disable the flag and investigate; do not loosen the key filter.
9. Verify a second run does not delete permanent assets. Confirm the service remains one replica and health checks pass.

Railway Buckets do not currently provide the lifecycle policy needed by this project, so the renderer sweep is the crash-recovery cleanup mechanism. Explicit per-operation cleanup in the Worker remains best effort; the scheduled sweep is the fallback.

## Gate 3 — private-storage and render integration

Use a dedicated non-production bucket/project for the first write test whenever possible.

- [ ] Verify signed S3-compatible PUT, HEAD/list if supported, GET and byte-range GET using a small synthetic fixture.
- [ ] Verify a wrong tenant/project signature cannot read or delete another project's object.
- [ ] Verify Worker-to-renderer transfer uses the expected private object key and does not expose credentials or public object URLs.
- [ ] Submit a tiny synthetic render and verify the exact output MIME, byte length and SHA-256.
- [ ] Restart the renderer in the test environment and verify job metadata/output persistence from the mounted volume.
- [ ] Verify staged cleanup removes only an expired test object under the staging prefix.
- [ ] Verify permanent assets survive the cleanup sweep.
- [ ] Keep production YouTube upload disabled during these tests.

Do not call `/health` an integration test: it establishes process liveness only.

## Gate 4 — YouTube OAuth and upload

- [ ] Confirm Google Cloud has YouTube Data API v3 and YouTube Analytics API enabled.
- [ ] Confirm the production OAuth client redirect URI exactly matches `https://phn-youtube-mcp.arnab368.workers.dev/callback`.
- [ ] Confirm requested scopes and Google verification/consent-screen requirements for the intended users.
- [ ] Reconnect a dedicated test account and verify channel read/analytics access.
- [ ] Verify the client presents the exact upload approval details and that missing/declined approval fails closed.
- [ ] Verify upload remains private-only and capped at 50 MiB.
- [ ] Do not publish publicly or unlisted. Any live upload test requires separate explicit approval for the exact account, video bytes, title, description and operation.

## Stop conditions

Stop and report rather than improvising if:
- a migration tag/class already exists unexpectedly;
- production settings differ from the documented state;
- the active renderer is not single-replica;
- S3 signing, prefix listing, or range semantics are unclear;
- a test could touch existing user assets or publish a video;
- a required secret is missing or its value would need to be exposed;
- any required CI/security check is failing.

## Approval record

For each production change, record the approving operator, exact commit, provider resource, intended change, time, verification evidence, and rollback plan. A general request to continue development is not approval to deploy, migrate production data, enable cleanup, or upload a video.
