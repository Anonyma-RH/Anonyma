# Workspace navigation, folders and tool search

Released on 28 September 2026 at [askanonyma.com](https://askanonyma.com/workspace/chat), following community feedback about getting started.

Chat, Images and Video are the primary navigation choices. New conversation returns to chat from another tool. Folders expand to show recent conversations, with a link to the full project. The composer keeps everyday controls visible and groups extra controls under Options; storage/privacy status and applicable cost estimates remain visible.

More tools contains short descriptions and intent-based search. Try **truth** for research and comparison tools, or **make a presentation** for Slides. Ranking uses local tags, aliases, text matching and bounded typo tolerance. Searching makes no model request, stores no query and consumes no credits. Existing tool availability gates still apply.

## Verification

The deployed application passed the complete local release check: **1,614 tests passed, zero failures or skipped tests**, syntax checks, dependency auditing with zero reported vulnerabilities, secret scans and a production build. The live build revision, health endpoint, navigation, Options, descriptions and both search examples were verified on 28 September. Folder reopening was tested with local fixtures. No new paid generation was needed for this frontend release.

The implementation and test commits retain their recorded source dates in this mirror. Public publication can happen later than development or deployment. Commit timestamps record commits, not hours worked; see [the history policy](../../HISTORY.md) for provenance and the disclosed reconstructed early history.
