# Contributing

Run `npm ci` or `npm run identity:setup` in your clone before committing.
Every commit must use `Anonyma Contributors <contributors@example.invalid>`
for both author and committer. Do not add identity-bearing trailers. Keep
third-party license notices intact; they are not contributor metadata.

Use local commits and local merges. GitHub's web editor and web merge controls
may introduce a different committer identity. Hooks are local conveniences and
can be bypassed; they do not replace server-side enforcement or secret review.

Only reviewed paths are imported from the private repository. A new file must
be added to the private mirror policy before the next synchronization. The
mirror stops on conflicts so public contributions are never silently discarded.
