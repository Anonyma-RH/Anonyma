# How this history was produced

This repository is an allowlisted mirror of a private Anonyma repository. Each
source commit has one corresponding public commit, in the same ancestry order,
with its stored author date, committer date and timezone preserved. Filtering
may leave a commit with no public-file changes; those commits are retained.

Both author and committer are normalized to
`Anonyma Contributors <contributors@example.invalid>`. Identity-bearing trailers
and signatures are removed. Commit text mentioning private identities, internal
tools or private paths is redacted. Public paths are selected explicitly; local
package commands are filtered to remove private operational tooling. These
transformations change commit IDs. The original-to-public mapping stays private.

## Existing reconstruction in the source

The private repository already began with **276 reconstructed source-assembly
checkpoints**, created from one reviewed working tree. Those checkpoints carry
an explicit disclosure: their dates were assigned for presentation and do not
record when the original development occurred. This mirror preserves those
existing records, dates and disclosures. It does not claim that those dates are
authentic development dates and does not invent replacement or filler commits.
The later source commits are retained as they exist in the private repository.

## Publication preparation and later synchronization

The public README, generated header, licenses and clone identity helpers were
added in an actual publication-preparation commit dated when the work was done.
They were not injected into older trees or backdated. The header is AI-generated.

Later synchronization appends transformed source commits. Ordinary three-way
merges preserve contributions made directly to public main; conflicts stop the
sync for review. Such integration merges use their actual integration dates and
are additional to the one-to-one imported commits. No source commits are squashed.

Historical filtered snapshots may be incomplete or fail to build independently.
Commit identity normalization also does not hide GitHub's authenticated pusher
or platform activity records.
