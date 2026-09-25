# Deployment and recovery

This is an operator procedure, not a claim that production has been deployed or that backups are already scheduled. Keep one named deployer and record every change. Prefer existing included services; a shared rate limiter does not require a new paid subscription if a suitable shared Redis service already exists.

## Configuration and storage

Use Node 24, `npm ci`, and the exact committed lockfile. Set `NODE_ENV=production`, `LOCAL_TEST_MODE=false`, and the same final HTTPS origin in `APP_ORIGIN` and `PUBLIC_BASE_URL`. HTTP production origins are rejected. Put TLS termination in front of the app, expose the upstream port only to that proxy, and set `TRUST_PROXY` to the actual proxy CIDRs. Do not trust arbitrary forwarded headers. Verify redirects and Secure cookies through the public address; an internal `/health` probe is allowed over HTTP.

Set `RELEASED_FEATURES=mvp`; omitted or blank settings also keep unreleased features closed. Committed `released: true` entries remain live. Only add named features when the owner authorizes that release. `all` is an explicit opt-in for isolated capability tests, not a production default.

Persist `DATABASE_PATH`, `MEDIA_PATH` (including its `.secret`) and `CATALOG_PATH` on durable storage. Keep test and live databases separate. Retain an external `APP_SECRET` securely if configured; backups do not contain environment credentials. Set gateway, payment/RPC, SMTP and support-recipient secrets through the hosting provider's secret store. Do not copy secrets into tickets, build logs, Git or public commit messages. Use the environment example for exact variable names.

Single-server limits use the persistent SQLite database. For a shared quota across servers configure `RATE_LIMIT_REDIS_REST_URL` (HTTPS), `RATE_LIMIT_REDIS_REST_TOKEN`, the same `RATE_LIMIT_NAMESPACE`, and the actual `SERVER_INSTANCES`. More than one instance without the shared store is rejected at startup. The endpoint must implement Redis REST `EVAL`; counters and expirations are updated atomically. Use persistence and no eviction of live counters. Redis outages fail protected requests with 503. Monitor these responses and restore store connectivity rather than turning protection off.

**Application scaling remains limited by SQLite and local media.** Keep one production writer on its durable volume. Do not start independent replicas with separate financial databases, or put SQLite WAL files on a network filesystem. Shared rate limiting is ready for a future supported multi-server storage architecture; it does not authorize that migration.

## Mandatory release checks

From a clean checkout run `npm ci --ignore-scripts` and `npm run release:check`. Install Gitleaks 8.30.1 and Redis/redis-cli first. The release command requires the real Redis integration test locally and in CI. The command blocks on static JS/JSX checks, dependency advisories at moderate severity or above, secret scans of history and tracked working files, a production build, and the test suite. Missing scanners fail. GitHub's **Mandatory release checks** job repeats these checks with read-only permissions, pinned actions and a checksum-pinned scanner. Review dependency updates before changing the lockfile; do not bypass findings to release.

A successful run creates `dist/release-checks.json` with the exact commit and lockfile hash. Publish through the existing reviewed identity/allowlist mirror procedure. Require the GitHub check on the target commit before release. Do not reuse a green result from another revision. Public and private commits may differ: record both mapped hashes and the artifact actually deployed.

## Deployment and revision verification

1. Record the release commit, previous deployed commit/image, configuration version, schema changes, and backup location privately. Verify source and target repository heads before deployment.
2. Pause writes and make a verified backup as below before a migration. Schedule any pause with the owner; these instructions do not themselves authorize downtime.
3. Build the immutable artifact with `BUILD_COMMIT_SHA` set to the full checked Git SHA. Docker builds must pass `--build-arg BUILD_COMMIT_SHA=<full-sha>` because `.git` is excluded. `npm run build` otherwise reads Git when available. Unknown revision or a dirty checkout is not release evidence.
4. Deploy that artifact onto the existing durable volume. Preserve secrets and release settings. Never enable local test mode or restore test credits in production.
5. Verify public `/health` and `/version.json` match the release SHA and report `dirty: false` (or `null` only for a trusted image built from the checked clean source). Check HTTPS, a real 404, sitemap XML, configuration release flags, and authenticated account read/export. Confirm generated Secure cookies. A configured integration is not a successful live integration test.
6. Record hosting deployment ID, source and public mirror hashes, image digest, timestamp and observed health build revision. Store screenshots/logs privately without account secrets. Only then report the deployment verified.

## Backup schedule and restore drill

Use the existing verified SQLite/media backup tooling. The recommended operator schedule is daily and before schema changes, with a seven-day rotating encrypted off-host copy. This schedule and retention must be configured on the host; the app does not schedule, encrypt or purge backups automatically. Confirm capacity and access controls before enabling it. Catalogs can be rebuilt, but preserve exact configuration and the signing secret separately in an encrypted secret store.

1. Pause incoming writes, stop background workers and drain paid requests. Reconcile ambiguous payment/generation holds first. A live SQLite snapshot plus concurrently changing media is not a consistent backup.
2. With the app stopped, use `node --env-file=.env.production scripts/backup.mjs create <new-private-directory> --writes-paused`. It uses SQLite `VACUUM INTO`, copies media and writes checksums. Run `node --env-file=.env.production scripts/backup.mjs verify <directory>`. The check verifies file inventory, hashes, SQLite integrity, relationships and media completeness.
3. Resume only after the backup result is verified; securely replicate it off-host. Restrict files to the service operator and never commit them.
4. At least monthly, run `node --env-file=.env.production scripts/backup.mjs restore <backup> <new-empty-directory>` into isolated storage. Never overwrite the running database. The restore verifies checksums again. Restore service settings and external `APP_SECRET` separately. Disable external traffic, mail, payment reconciliation and generation during a drill; never use local test mode against restored live balances.
5. Before switching production to a restore, verify user/ledger counts, media access and ledger invariants with read-only queries. Reapply every deletion made since the snapshot from the private deletion record; otherwise deleted data would reappear. The application does not automatically replay deletion requests into backups. If that record is incomplete, do not make the restored content available until affected deletions are reconciled.
6. Compare post-snapshot payments against provider/chain evidence and preserved transaction IDs before reopening deposits; prevent double credits. Keep an incident record and preserve the old volume for investigation.

## Rollback

Prefer reverting to the previous verified image while retaining the current volume if schema compatibility is proven. Test the old application against a copied database first; startup migrations may be additive, but backwards compatibility is not assumed. Never restore an old financial database just to roll back code. If an incompatible schema demands restore, follow the full stopped-service procedure above and reconcile all later payments, usage and deletions. After rollback, verify the prior image SHA through `/health`, then account reads, content access and release flags. Record the rollback deployment ID and reason.
