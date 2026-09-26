# Sealed Mode: operations and release precondition

Sealed Mode (update `sealed`) is end-to-end encrypted chat. The browser verifies
the enclave's attestation itself, encrypts the request with EHBP (HPKE: X25519,
HKDF-SHA256, AES-256-GCM) to the key the attestation vouches for, and ANONYMA's
server relays the ciphertext to PPQ's private endpoint. Only PPQ's `private/*`
models with `privacyLevel: "e2e"` are offered: they are open-weight models that
run inside Tinfoil's enclave. A proprietary model is refused (`400
sealed_model_required`), because the enclave would forward its prompt to the
model's provider.

## Release precondition: billing must be known

**Do not release `sealed` until PPQ has answered, in writing:**

1. May ANONYMA's server relay `/private` calls for its users, under our key?
2. Does PPQ forward Tinfoil's `X-Tinfoil-Usage-Metrics` **trailer** on streamed
   `/private/v1/chat/completions` replies (we send
   `X-Tinfoil-Request-Usage-Metrics: true` and `TE: trailers`)?
3. What are the `private/*` rates, and is the `/v1/models` catalog price the
   full debit (it looks like upstream × 1.055)?
4. Can we have a dedicated key for sealed traffic, and a per-request id in
   `/queries/history` for reconciliation?

Then set the billing mode. Until `SEALED_BILLING` is set, the routes answer
`503 sealed_unavailable`, `/api/config` reports `services.sealed: false` and the
workspace hides the switch, even with the update flag on.

| PPQ's answer | Configure |
|---|---|
| The trailer is forwarded | `SEALED_BILLING=trailer` and `SEALED_RECONCILE=true` (a stopped or cut-off request never gets a trailer) |
| No trailer, but history is reliable | `SEALED_BILLING=reconcile` and `SEALED_RECONCILE=true` |
| Neither | Don't release. |

Before the release commit, run one paid end-to-end request on the production
key and compare the settled charge with PPQ's history.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SEALED_BILLING` | unset (off) | `trailer` or `reconcile`. Anything else stops the server at startup. |
| `SEALED_RECONCILE` | `false` | Settle held sealed requests from `GET /queries/history`. Required for `reconcile`. |
| `SEALED_GATEWAY_API_KEY` | `GATEWAY_API_KEY` | A dedicated key keeps its history to sealed requests only. |
| `SEALED_GATEWAY_BASE_URL` | `GATEWAY_BASE_URL` | PPQ's API. |
| `SEALED_MAX_OUTPUT_TOKENS` | `8192` | The reply budget a sealed request asks for and is held for. |
| `SEALED_MAX_HOLD_USD` | `2` | The most one sealed request may hold; larger ones are refused unsent (`413 sealed_hold_cap`). |

## Billing

- **Hold.** The server can't read the request, so the hold is the worst case
  at the model's catalog price: every ciphertext byte as an input token (a
  token always covers at least one byte) plus 1,024, and the full output cap.
- **Trailer mode.** The relay reads the trailer with `node:https` (fetch can't)
  and charges its token counts at the catalog price, never more than the hold.
  `cost_usd` (Tinfoil's cost) is kept for comparison only.
- **No usable trailer** (absent, malformed, naming another model, a Stop, a
  cut-off, a timeout, or reconcile mode): the hold is **kept**, neither
  released nor charged in full, and the request is `reconcile_pending`.
- **Reconciliation.** Every worker tick, requests pending for over a minute are
  matched against PPQ's history: same model, a timestamp from a minute before
  the request to five minutes after it ended, and input tokens within the
  ciphertext bound. A row settles a request only when each is the other's only
  match, and never twice (`reconcile_ref` is unique). The charge is the row's
  `price_in_usd` at the account's rate. Ambiguous requests stay held; they are
  listed as `sealedPending` by `npm run operator -- reconciliation`.
- **Failures, as in chat.** Not accepted (a key-rotation 422, an error, no
  answer): released, nothing charged. Accepted and then stopped: charged, via
  reconciliation. A 200 without EHBP is never passed on and stays held.
- **Output cap.** `max_tokens` is inside the ciphertext. The relay cuts a reply
  off after `8192 × 512 + 256 KiB` bytes; a modified client could still cost
  up to about twice the cap, and any cost above the hold is recorded in
  `holds.uncovered`.

## What the server sees and keeps

Seen: the account, the model (`X-Private-Model`), the `Ehbp-*` headers,
ciphertext size and timing, and the usage record. Kept in `sealed_requests`:
that metadata and the charge, never a body. Nothing is logged. Panic Wipe and
account closure remove finished records; one still owed stays until settled.
A pending sealed charge doesn't block Panic Wipe; account closure waits for it.

## Limits to be honest about

- SEV-SNP reports carry no client nonce. The browser re-verifies every ten
  minutes and refuses an enclave certificate that has expired or is over 90
  days old. The verifier doesn't check that certificate's chain, so this stops
  a naive replay of an old bundle, not a determined one; only a fresh-challenge
  attestation would, and Tinfoil's router doesn't offer one.
- Users trust the JavaScript we serve to do the encrypting. It is open source.
- The verifier pins AMD's roots. GPU attestation happens inside the enclave.
