# Shared Collab Balance — Team Treasury

Collab members can pool prepaid credits and explicitly turn on **Team pays** for shared chat requests. The owner sets each member's spending limits. Personal payment stays the default; a refused team-paid request never silently switches to personal funds.

The estimate uses the standard team rate and the member's remaining team allowance. Contributions, withdrawals, holds and charges stay on the ledger. Requesters can recover their own request status after disconnecting. Team totals include former members' spending.

## Ownership and limitations

The owner controls pooled credits, including withdrawal of the full remaining balance. The contribution dialog explains that contributions cannot be taken back. Deleting a collab returns its remaining credits to the owner; deletion is refused while requests are pending. Account closure is blocked while an owned treasury still holds funds.

Team pays supports shared chat requests, not media generation or developer API requests. Members start with a zero daily limit until the owner increases it. Team-paid requests use the standard rate. Turning the feature off preserves balance visibility and owner withdrawal.

## Release film

[Download the original Greek ASCII film](../assets/releases/team-treasury.mp4). The scene is an illustration; shown balances and names are examples. No paid generation was used.

[Watch a real run](../assets/releases/team-treasury-run.mp4): an owner contributes 100 credits and sets a member's limits; the member turns on Team pays and gets an answer charged to the treasury (0.114 credits, signed receipt); the owner's Activity shows who spent it. Recorded before release on the feature branch; the screens shown are unchanged in the release.
