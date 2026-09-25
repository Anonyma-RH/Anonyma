# Reading & Charge Clarity

Reading older messages no longer forces the view to the newest streamed text. Follow replies while near the bottom, or use Jump to latest when ready.

Failure messages distinguish known reservations, settled charges, released funds and unknown status. Check charge status uses the existing request receipt endpoint and never resends the generation. An interrupted connection is not evidence of a refund. Request status stays associated with its own conversation; changing chats does not carry over an unrelated charge notice.

Partial replies and explicit continuation remain available under the existing chat rules. A new Send or retry can be a new paid request. Local test fixtures verify scrolling and network-loss behavior; hosted checks cover configured availability and receipt retrieval.
