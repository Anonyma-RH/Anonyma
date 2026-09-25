# Security reporting

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/Anonyma-RH/Anonyma/security/advisories/new). Sign in to GitHub and choose **Report a vulnerability** on the repository's Security page. Do not open a public issue with exploit details or customer information.

Include the affected URL or commit, expected and actual behavior, minimal reproduction steps, impact, and a safe way to contact you. Redact passwords, session cookies, API keys, wallet recovery phrases and personal data. Use your own test account; do not access others' data, exhaust shared resources, move funds, or interrupt service.

Reports are reviewed individually. There is no promised response deadline, bounty or automatic payment. This policy does not authorize testing third-party services. Maintainers should acknowledge the report privately, reproduce it in isolated storage, preserve necessary evidence without secrets, and coordinate a verified fix and disclosure with the reporter.

# Runtime protection

Single-server request quotas persist in SQLite. Multiple servers must share the same Redis REST store and namespace; set `SERVER_INSTANCES` accurately. Shared-store failures return 503 and do not fall back to independent quotas. Redis must retain counters for their full TTL and must not evict active counters. App restarts preserve quotas; losing the rate-limit store itself may reset them. Configure trusted proxy CIDRs narrowly so clients cannot forge rate-limit identities.

See [deployment and recovery](docs/operations/deployment.md) for configuration, release checks and recovery steps. Do not horizontally replicate this SQLite-backed application onto independent databases: distributed request quotas do not make the financial database or media storage distributed.
