import { featuresFor, isReleased, releaseInfo } from "./releases.js";

const string = { type: "string" };
const number = { type: "number" };
const integer = { type: "integer" };
const bool = { type: "boolean" };
const object = (properties = {}, required = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const array = (items) => ({ type: "array", items });
const nullableString = { type: ["string", "null"] };
const retentionDays = { type: ["integer", "null"], enum: [null, 1, 7, 30] };
const requestId = {
  ...string,
  minLength: 1,
  maxLength: 200,
  description:
    "Unique ID per logical paid request. Reuse after transport uncertainty; never silently create a fresh charge.",
};
const message = object(
  {
    role: { enum: ["system", "user", "assistant"] },
    content: {
      oneOf: [
        string,
        array(
          object(
            {
              type: { enum: ["text", "image_url", "file"] },
              text: string,
              image_url: object({ url: string }, ["url"]),
              file: object({ file_id: string }, ["file_id"]),
            },
            ["type"],
          ),
        ),
      ],
    },
  },
  ["role", "content"],
);
const chat = object(
  {
    model: string,
    messages: array(message),
    max_tokens: {
      ...integer,
      minimum: 1,
      default: 4096,
      description: "Default 4096. With Longer, More Reliable Answers released, explicit budgets are checked against the model limit shown by /api/models (service ceiling 32768; conservative 8192 where an output limit is unavailable). Oversized budgets or context are refused before reservation; older releases clamp to 8192.",
    },
    requestId,
    conversationId: string,
    mode: { enum: ["chat", "code", "symposium"] },
    stream: bool,
    web_search: {
      ...bool,
      description:
        'Search the web before answering (also accepted as plugins: [{ id: "web" }]). Adds the per-search fee; cited sources are returned as citations.',
    },
    ephemeral: {
      ...bool,
      description:
        "Off the record: no conversation or message is stored, not even the user's message, and conversationId must be absent. Billing (hold, settlement, ledger entry, receipt) is unchanged.",
    },
    private: {
      ...bool,
      description:
        'Private Mode: the model must be flagged private (see /api/models\' private field; 400 private_model_required otherwise), and requires both the private and ephemeral updates released (403 feature_unreleased otherwise). Always takes the ephemeral path, so conversationId must be absent. The final SSE event and JSON response carry anonyma.private: { provider, stored: false }. Billing is unchanged.',
    },
    double_check: {
      ...object({ source_model: string, source_conversation: string }, ["source_model"]),
      description:
        "Double-check This: a second opinion on an answer from source_model. Needs the Double-check This and Symposium updates released (403 feature_unreleased otherwise). The model must come from a different provider (maker) than source_model (400 double_check_same_provider; 400 double_check_provider_unknown when either maker can't be established). mode must be symposium and conversationId absent, so the reviewed conversation is never changed; ephemeral and private apply as usual. A saved check must name the reviewed conversation in source_conversation (which must be accessible and not itself a check) and stays linked to it: it never outlives it (its deletion time, or the account default if sooner), shortening that conversation's auto-delete shortens the check, nothing extends it, and it is deleted with the conversation or when its owner loses access (leaving the collab). Billed like any chat request.",
    },
    veil_masked: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: 10000,
      description:
        "Privacy Trail: how many details Veil masked in this browser before sending, or null when Veil was off. A count only; the masked values never leave the browser. Needs the trail update released (403 feature_unreleased otherwise). Echoed as anonyma.privacy.veil_masked and kept with a saved reply.",
    },
    allow_seed_phrase: {
      ...bool,
      description:
        "Seed Guard: once the seedguard update is released, a request whose newest user message or system instructions contain a valid BIP39 seed phrase (12, 15, 18, 21 or 24 English wordlist words with a valid checksum) is refused with 400 seed_phrase_blocked before anything is reserved, stored or sent. Send true only after the user has confirmed sending it anyway (the workspace asks twice). Needs the seedguard update released (403 feature_unreleased otherwise). Nothing about a match is logged or stored.",
    },
    project: {
      ...string,
      description:
        "Projects: file the new saved conversation this request creates (a Symposium run too) in one of your projects. Needs the projects update released (403 feature_unreleased otherwise); 404 project_not_found for a project that isn't yours. Refused (400 invalid_request) with ephemeral or private, which store nothing and so are never filed, and with conversationId (move a saved chat with POST /api/projects/{id}/chats). The project's instructions aren't added by the server: the workspace sends them as the leading system message, like standing instructions, so Veil can mask them.",
    },
    memory: {
      ...array(object({ id: string, text: { ...string, maxLength: 2400 }, updated: integer }, ["id", "text"])),
      maxItems: 50,
      description:
        "Memory Across Models: the saved facts to send with this request, as { id, text, updated } (updated is the current fact revision and is required for masked text; text may be masked with Veil tags such as [EMAIL_1]). Needs the memory update released (403 feature_unreleased otherwise). The server keeps only this account's stored, enabled facts whose text is unchanged apart from masking, and only when memory is switched on for the account, the request is not ephemeral or private, the mode is chat, code or uncensored (not symposium or double_check) and conversationId is not a shared (collab) conversation; otherwise nothing is added. Kept facts are sent upstream as one system message after any leading system messages, priced like the rest of the request and never saved with the conversation. The final event's anonyma.memory reports { used, facts (exactly as sent), skipped, reason? }.",
    },
  },
  ["model", "messages"],
);
const generation = {
  model: string,
  prompt: { ...string, maxLength: 48000 },
  requestId,
};
const apiChat = object(
  {
    model: string,
    max_tokens: chat.properties.max_tokens,
    stream: { ...bool, default: false },
    requestId,
    web_search: chat.properties.web_search,
    plugins: {
      ...array(object({ id: { const: "web" } }, ["id"])),
      description: "Alternative to web_search: true.",
    },
    messages: array(
      object(
        { role: { enum: ["system", "user", "assistant"] }, content: string },
        ["role", "content"],
      ),
    ),
  },
  ["model", "messages"],
);
const schemas = {
  Error: object(
    {
      error: object(
        {
          message: string,
          code: string,
          type: string,
          param: { type: ["string", "null"] },
        },
        ["message", "code", "type"],
      ),
      anonyma: object({ credits_charged: number }),
      spending_limit: {
        ...object({
          limit: { enum: ["daily", "monthly"] },
          window_hours: integer,
          limit_credits: number,
          used_credits: number,
          held_credits: number,
          remaining_credits: number,
          requested_credits: number,
          frees_at: { type: ["integer", "null"] },
        }),
        description:
          "Present with 402 spending_limit: which of the account's own limits refused the request, its usage (settled spend in the rolling window plus open holds), what this request would have held, and frees_at, the millisecond time enough settled spend leaves the window for it to fit (null when it depends on requests still in progress, or the request is larger than the whole limit).",
      },
    },
    ["error"],
  ),
  Ok: object({ ok: bool }, ["ok"]),
  User: object({
    id: string,
    username: nullableString,
    email: nullableString,
    wallet: nullableString,
    created: integer,
    balance: number,
    available: number,
    held: number,
    tokenBalance: string,
    tokenSince: { type: ["integer", "null"] },
    discount: number,
    tokenChecked: { type: ["integer", "null"] },
    earlyAccess: array(string),
    holder: object({
      eligible: bool,
      threshold: number,
      tier: { type: ["string", "null"], enum: [null, "holder", "insider", "inner"] },
    }),
    caps: ref("RetentionCaps"),
  }),
  RetentionCaps: object({
  conversations: integer,
  symposium: integer,
  image: integer,
  video: integer,
  audio: integer,
}),
  HolderVote: object({
    month: string,
    open: bool,
    choice: nullableString,
    candidates: array(object({ id: string, title: string })),
  }),
  Session: object({ user: { oneOf: [ref("User"), { type: "null" }] } }, [
    "user",
  ]),
  // Two-Step Sign-in: a correct first step for an account with two-step on
  // sets no cookie and returns this instead of a Session.
  TwoStepChallenge: object(
    {
      twoStep: object(
        {
          token: { ...string, description: "Send with the code to /api/auth/two-step. Single use; expires after 5 minutes or 5 wrong codes." },
          method: { enum: ["password", "email", "recover", "wallet"], description: "The first step that succeeded. recover: the new password applies only once the code is right." },
          expires: integer,
        },
        ["token", "method", "expires"],
      ),
    },
    ["twoStep"],
  ),
  ChatRequest: chat,
  ApiChatRequest: apiChat,
  Media: object({
    id: string,
    kind: { enum: ["image", "video", "audio"] },
    mime: string,
    prompt: string,
    model: string,
    cost: number,
    created: integer,
    url: string,
    expires: { type: ["integer", "null"] },
  }),
  Video: object({
    id: string,
    status: {
      enum: [
        "submitting",
        "pending",
        "processing",
        "completed",
        "failed",
        "reconciliation",
      ],
    },
    error: nullableString,
    media_id: nullableString,
    created: integer,
    request: object(),
  }),
  Deposit: object({
    id: string,
    provider_id: nullableString,
    amount: { ...number, description: "USD face value, not credits." },
    currency: string,
    status: string,
    payload: object(),
    credited: {
      ...integer,
      description:
        "1 only while the original payment credit is currently usable; 0 while it is disputed or reversed. Historical credits and corrections remain in the append-only ledger.",
    },
    created: integer,
    updated: integer,
    refreshError: {
      ...string,
      description:
        "Present when a pending invoice could not be refreshed from the processor; saved invoice details are returned without asserting a new payment status.",
    },
  }),
  Quote: object({
    credits: number,
    usd: number,
    available: number,
    model: string,
    estimate: { const: true },
    spending_limit: {
      ...object({ remaining: number }),
      description:
        "Spending Limits: present when the account has a daily or monthly limit in force (and the limits update is released). remaining is the room left under the tightest one; a personal request larger than it is refused with 402 spending_limit. Not present on team-paid estimates, which don't count.",
    },
  }),
  ChatCompletion: object({
    id: string,
    object: { const: "chat.completion" },
    created: integer,
    model: string,
    choices: array(object()),
    usage: object({
      prompt_tokens: integer,
      completion_tokens: integer,
      total_tokens: integer,
    }),
    anonyma: object({
      credits_charged: number,
      request_id: string,
      signed_receipt: {
        ...ref("SignedReceipt"),
        description: "Present only when the receipts update is released.",
      },
      privacy: {
        ...ref("PrivacyTrail"),
        description: "Present only when the trail update is released.",
      },
    }),
    askr: object(),
  }),
  PrivacyTrail: {
    ...object(
      {
        model: string,
        provider: {
          ...nullableString,
          description: "The model's owned_by in the catalog; null when the catalog lists none.",
        },
        route: {
          enum: ["primary", "backup"],
          description: "backup when the backup gateway served the request after the primary refused it before accepting.",
        },
        retention: {
          enum: ["zero_data_retention", "provider_may_retain"],
          description: "zero_data_retention only when the request was sent with zero-data-retention routing (Private Mode, or a private-only connected app). Zero data retention is opt-in per request, so any other request is provider_may_retain.",
        },
        trains_on_prompts: {
          ...bool,
          description: "Training Labels: the provider says it uses what is sent to this model to improve its products. Present once the training update is released.",
        },
        storage: {
          enum: ["saved", "off_the_record", "private", "not_saved"],
          description: "saved: kept in the account's conversation history. off_the_record and private (Private Mode): nothing about the chat is stored. not_saved: API and MCP requests, which are never saved as conversations.",
        },
        veil_masked: {
          type: ["integer", "null"],
          description: "Workspace only: the Veil mask count the browser reported for this request, or null when Veil was off. Absent over the API.",
        },
        receipt_id: {
          ...nullableString,
          description: "The signed receipt's id (the requestId) once Signed Receipts is released and the reply was signed; verify it at /verify. Otherwise null.",
        },
      },
      ["model", "provider", "route", "retention", "storage", "receipt_id"],
    ),
    description:
      "Privacy Trail: where one prompt went, from facts the service holds for that request. Never contains prompt or answer text.",
  },
  Scroll: object({
    id: string,
    title: string,
    body: string,
    created: integer,
    updated: integer,
  }),
  Instructions: object({
    body: string,
    enabled: bool,
    updated: { type: ["integer", "null"] },
  }),
  RequestStatus: object({
    requestId: string,
    kind: string,
    status: { enum: ["held", "settled", "released"] },
    reserved: number,
    created: integer,
    expires: integer,
    receipt: { type: ["object", "null"] },
  }),
  ReceiptPayload: object({
    v: { const: 1 },
    id: { ...string, description: "The requestId this receipt settled." },
    issued: string,
    service: { ...string, description: "Public origin that issued the receipt." },
    model: string,
    usage: {
      ...object({ input_tokens: integer, output_tokens: integer }),
      description: "Chat receipts only.",
    },
    kind: {
      enum: ["image", "speech", "transcription", "video"],
      description: "/v1 media receipts only, in place of usage.",
    },
    credits_charged: number,
    credits_released: number,
    request_sha256: { ...string, description: "sha256 of the canonical JSON of the sent messages. For media: of the billed request (model, prompt or input, options; an uploaded file as its sha256)." },
    response_sha256: { ...string, description: "sha256 of the full answer text. For media: of the transcript text, or of the delivered file bytes in order." },
    key_id: string,
  }),
  SignedReceipt: object({
    receipt: ref("ReceiptPayload"),
    signature: { ...string, description: "Base64 Ed25519 signature over the canonical (sorted-key) JSON of receipt." },
    key_id: string,
  }),
  ReceiptKey: object({
    key_id: string,
    algorithm: { const: "Ed25519" },
    public_key_pem: string,
    jwk: object(),
  }),
  McpMessage: object(
    {
      jsonrpc: { const: "2.0" },
      id: { oneOf: [string, number, { type: "null" }] },
      method: string,
      params: object(),
    },
    ["jsonrpc", "method"],
  ),
  McpRequest: {
    oneOf: [ref("McpMessage"), array(ref("McpMessage"))],
    description: "A single JSON-RPC message, or a batch array of messages.",
  },
  McpResponse: {
    oneOf: [object(), array(object())],
    description:
      "A single JSON-RPC response/error, or a batch array of them. A request made only of notifications returns 202 with no body.",
  },
  KeyUsage: object({
    spent_total: {
      ...number,
      description: "Lifetime settled spend on this key, in credits.",
    },
    in_flight: { ...number, description: "Sum of this key's active holds." },
    allowance_total: { type: ["number", "null"] },
    remaining: {
      type: ["number", "null"],
      description: "allowance_total minus spent_total and in_flight.",
    },
    expires_at: { type: ["integer", "null"] },
    paused: bool,
    last_used: { type: ["integer", "null"] },
    requests: integer,
  }),
};
const paths = {
  "/sitemap.xml": { get: { operationId: "getSitemap", summary: "Public page sitemap", responses: { 200: { description: "XML sitemap" } } } },
  "/robots.txt": { get: { operationId: "getRobots", summary: "Crawler rules", responses: { 200: { description: "Robots text with sitemap URL" } } } },
};
function route(
  method,
  path,
  summary,
  {
    auth = "session",
    body,
    response = object(),
    status = 200,
    description = "",
    query = [],
    stream = false,
  } = {},
) {
  const params = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: "path",
    required: true,
    schema: string,
  }));
  const success = {
    description: "Success",
    content: {
      [stream ? "text/event-stream" : "application/json"]: {
        schema: stream ? string : response,
      },
    },
  };
  paths[path] ||= {};
  paths[path][method] = {
    summary,
    description,
    operationId: method + "_" + path.replace(/[^a-zA-Z0-9]+/g, "_"),
    security: auth ? [{ [auth]: [] }] : [],
    ...(params.length || query.length
      ? { parameters: [...params, ...query] }
      : {}),
    ...(body
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: body } },
          },
        }
      : {}),
    responses: {
      [status]: success,
      default: {
        description:
          "Error. Streaming failures appear inside the SSE stream after HTTP headers were sent; inspect every event.",
        content: { "application/json": { schema: ref("Error") } },
      },
    },
  };
}
route("get", "/api/me", "Current session", {
  auth: null,
  response: ref("Session"),
});
for (const [path, summary, body, status] of [
  [
    "/api/auth/register",
    "Create password account",
    object(
      {
        username: { ...string, minLength: 3, maxLength: 32 },
        password: { ...string, minLength: 10, maxLength: 256 },
      },
      ["username", "password"],
    ),
    201,
  ],
  [
    "/api/auth/password",
    "Sign in with password",
    object({ username: string, password: string }, ["username", "password"]),
    200,
  ],
  [
    "/api/auth/email/send",
    "Send email login, linking or recovery code",
    object(
      {
        email: string,
        purpose: { enum: ["login", "link", "recover"], default: "login" },
      },
      ["email"],
    ),
    200,
  ],
  [
    "/api/auth/email/verify",
    "Verify email code; recovery changes password",
    object({ id: string, code: string, password: string }, ["id", "code"]),
    200,
  ],
  [
    "/api/auth/wallet/challenge",
    "Create domain-bound wallet sign-in message",
    object({ address: string, link: bool }, ["address"]),
    200,
  ],
  [
    "/api/auth/wallet/verify",
    "Verify wallet signature",
    object({ id: string, signature: string }, ["id", "signature"]),
    200,
  ],
])
  route("post", path, summary, {
    auth: null,
    body,
    status,
    description:
      "Email/wallet linking requires an existing session. Sign-in responses set an HttpOnly session cookie. Codes and wallet challenges expire after 10 minutes." +
      (["/api/auth/password", "/api/auth/email/verify", "/api/auth/wallet/verify"].includes(path)
        ? " For an account with Two-Step Sign-in on, a correct first step (password, email code, password reset or wallet signature, but not email or wallet linking) sets no cookie and returns a TwoStepChallenge; the session comes from /api/auth/two-step. A password reset then applies only after the code."
        : ""),
    response: path.endsWith("/send")
      ? object({ id: string, message: string })
      : path.endsWith("/challenge")
        ? object({ id: string, message: string })
        : ["/api/auth/password", "/api/auth/email/verify", "/api/auth/wallet/verify"].includes(path)
          ? { oneOf: [ref("Session"), ref("TwoStepChallenge")] }
          : ref("Session"),
  });
// Two-Step Sign-in (update "twostep"). The sign-in step is listed once the
// update is live, but always answers: an account that turned two-step on
// keeps needing its code.
route("post", "/api/auth/two-step", "Finish a sign-in with a two-step code", {
  auth: null,
  body: object(
    {
      token: { ...string, description: "From the TwoStepChallenge" },
      code: { ...string, description: "The current 6-digit authenticator code, or an unused recovery code (xxxx-xxxx-xxxx-xxxx; case, spaces and dashes are ignored)" },
    },
    ["token", "code"],
  ),
  response: object({
    user: ref("User"),
    twoStep: object({
      method: { enum: ["totp", "recovery"] },
      recoveryCodesLeft: integer,
    }),
  }),
  description:
    "Sets the HttpOnly session cookie. Authenticator codes use RFC 6238 (SHA-1, 6 digits, 30-second steps); a code from the step before or after is accepted, and each code works once (401 two_step_code_used). A recovery code is spent when used. 400 two_step_expired when the token is unknown, expired or used up (sign in again); 400 two_step_code_format when the code isn't a code; 401 two_step_invalid for a wrong code. Five wrong codes for one account within 15 minutes lock its code entry for 15 minutes (429 two_step_locked with Retry-After). 20 requests per 15 minutes per IP. 503 two_step_unavailable when the server can't read authenticator secrets (a changed APP_SECRET); recovery codes still work.",
});
const twoStepStatus = {
  enabled: bool,
  enabledAt: { type: ["integer", "null"] },
  recoveryCodesLeft: integer,
  reauthMethods: {
    ...array({ enum: ["password", "email", "wallet"] }),
    description: "How this account confirms it's you: its password when it has one, otherwise an email code and/or a wallet signature",
  },
  reauthUntil: {
    type: ["integer", "null"],
    description: "Until when this session's last confirmation counts; null means confirm again before turning two-step on or making new recovery codes",
  },
};
const reauthNeeded =
  " Needs this session to have confirmed it's you within the last 10 minutes (POST /api/account/two-step/reauth), otherwise 403 two_step_reauth_required: a stolen session can't turn two-step on or take new recovery codes.";
route("get", "/api/account/two-step", "Two-step sign-in status", {
  response: object(twoStepStatus),
  description: "Never returns the secret or recovery codes.",
});
route("post", "/api/account/two-step/reauth/start", "Start confirming it's you with an email code or a wallet signature", {
  body: object({ method: { enum: ["email", "wallet"] } }, ["method"]),
  response: object({
    id: string,
    message: { ...string, description: "wallet: the one-time message to sign (it authorizes no transaction and can't be used to sign in); email: a notice" },
    testCode: { ...string, description: "Local test mode only" },
  }),
  description:
    "Only for accounts without a password (400 two_step_reauth_method otherwise). email sends a 6-digit code to the account's own address (five per address per hour, 10-minute expiry); wallet returns a message for the linked wallet. Either is bound to this session. 10 an hour.",
});
route("post", "/api/account/two-step/reauth", "Confirm it's you", {
  body: object({
    method: { enum: ["password", "email", "wallet"] },
    password: { ...string, description: "method password" },
    id: { ...string, description: "method email or wallet: from /reauth/start" },
    code: { ...string, description: "method email" },
    signature: { ...string, description: "method wallet: the linked wallet's signature of the message" },
  }, ["method"]),
  response: object({ reauthUntil: integer }),
  description:
    "The account's password when it has one; otherwise a fresh email code or wallet signature started by this session (400 two_step_reauth_method for another method). Marks this session, and only this session, as confirmed for 10 minutes. 401 two_step_reauth_failed for a wrong password or signature, 400 for a wrong email code, 400 two_step_reauth_expired for an unknown, expired, used or other session's confirmation. 10 tries per 15 minutes.",
});
route("post", "/api/account/two-step/setup", "Start turning on two-step sign-in", {
  body: object(),
  response: object({
    secret: { ...string, description: "Base32 (RFC 4648) authenticator key" },
    uri: { ...string, description: "otpauth://totp link for a QR code" },
    issuer: string,
    label: string,
    expires: integer,
  }),
  description:
    "A new secret, stored sealed with a key derived from the app secret and valid for 15 minutes; it replaces any setup not yet confirmed. Nothing changes for sign-in until /enable. 409 two_step_on when already on. 10 an hour." + reauthNeeded,
});
route("post", "/api/account/two-step/enable", "Confirm the setup with a current code", {
  body: object({ code: string }, ["code"]),
  response: object({
    ...twoStepStatus,
    recoveryCodes: { ...array(string), description: "Ten single-use codes, shown only here; stored as hashes" },
    signedOutSessions: integer,
  }),
  description:
    "Turns two-step sign-in on and signs out every other session. 400 two_step_setup_expired, 400 two_step_code_format, 401 two_step_invalid, 409 two_step_on. API keys and connected apps are unaffected." + reauthNeeded,
});
route("post", "/api/account/two-step/recovery-codes", "Replace the recovery codes", {
  body: object({ code: string }, ["code"]),
  response: object({ ...twoStepStatus, recoveryCodes: array(string) }),
  description:
    "Needs a current authenticator code (a recovery code isn't accepted here). The old codes stop working. Wrong codes count towards the account's lock. The confirmation is checked before the code, so a refused request never uses a code up." + reauthNeeded,
});
route("post", "/api/account/two-step/disable", "Turn off two-step sign-in", {
  body: object({ code: string }, ["code"]),
  response: object({ ...twoStepStatus, signedOutSessions: integer }),
  description:
    "Needs a current authenticator code or an unused recovery code. Deletes the secret and recovery codes and signs out every other session. Wrong codes count towards the account's lock (429 two_step_locked).",
});
for (const path of ["/api/auth/logout", "/api/auth/logout-all"])
  route(
    "post",
    path,
    "Revoke session" + (path.endsWith("-all") ? "s on all devices" : ""),
    { body: object(), response: ref("Ok") },
  );
route("get", "/api/account/sessions", "List active sessions", {
  response: object({
    data: array(object({ created: integer, expires: integer })),
  }),
});
route("post", "/api/account/token/refresh", "Refresh linked ERC20 holdings", {
  body: object(),
  response: ref("Session"),
});
route("post", "/api/account/wallet/unlink", "Unlink the account's wallet", {
  body: object(),
  response: ref("Session"),
  description:
    "NYMA Holder Program. Removes the linked wallet, its recorded holdings and its open cycle. 409 wallet_sign_in_only when the wallet is the account's only sign-in method.",
});
const earlyModelsSchema = object({
  days: integer,
  models: array(
    object({ id: string, name: string, type: string, opensAt: integer }),
  ),
});
route("get", "/api/account/holdings", "The account's NYMA Holder Program state", {
  response: object({
    checks: bool,
    tier: {
      oneOf: [
        object({ id: string, name: string, level: integer }),
        { type: "null" },
      ],
    },
    cycle: {
      oneOf: [
        object({
          start: integer,
          ends: integer,
          daysLeft: integer,
          low: number,
          waiting: bool,
          due: object({ credits: number, bonus: bool }),
        }),
        { type: "null" },
      ],
    },
    paidInARow: integer,
    loyalty: object({ after: integer, multiplier: number }),
    lastReward: {
      oneOf: [
        object({ credits: number, tier: string, bonus: bool, paid: integer }),
        { type: "null" },
      ],
    },
    caps: ref("RetentionCaps"),
    vote: ref("HolderVote"),
    earlyModels: earlyModelsSchema,
  }),
  description:
    "The current tier is set by the lowest balance successful reads saw in the open 30-day cycle, with a read in the last 48 hours. cycle.due is what the cycle pays at its end at the current tier; waiting means it is due but needs a fresh read first. Once Early Model Access is released (with the Holder Program live and balance checks on), earlyModels lists the models open to Insiders and up first right now (days is the early window; opensAt is when each opens to everyone, epoch ms), the same list for every account.",
});
// API Boost (update "apiboost").
route("get", "/api/account/api-limit", "Your API and MCP request limits", {
  response: object({
    perMinute: {
      ...integer,
      description:
        "Requests a minute for /v1/chat/completions, the /v1 media endpoints and POST /mcp together: 120, times the multiplier.",
    },
    filesPerMinute: {
      ...integer,
      description: "Requests a minute for /v1/files: 60, times the multiplier.",
    },
    standard: object({ perMinute: integer, filesPerMinute: integer }),
    multiplier: {
      ...number,
      description:
        "Your current NYMA tier's multiplier from HOLDER_API_MULTIPLIERS (default holder 2, insider 3, inner 5); 1 without a tier.",
    },
    tier: {
      oneOf: [object({ id: string, name: string }), { type: "null" }],
      description: "The tier behind a boost; null when there is none.",
    },
    windowSeconds: integer,
  }),
  description:
    "Session only; API keys and connected apps are never told a tier. Your tier is the NYMA Holder Program's current tier (the lowest balance read this 30-day cycle, with a successful read in the last 48 hours); a stale read, no wallet or no tier means the standard limits. A tier change applies to the next request. Once API Boost is released, requests with a valid API key (or, on /mcp, a connected app's access token) count per account and IP address; requests without one count per IP address at the standard limit. Rates only: every paid request is still bounded by your balance, key caps, allowances and spending limits. 429 rate_limit responses are unchanged (same message and Retry-After). Needs the api and apiboost updates released (403 feature_unreleased otherwise).",
});
route("put", "/api/holders/vote", "Cast or change this month's roadmap vote", {
  body: object({ update: string }, ["update"]),
  response: ref("HolderVote"),
  description:
    "Inner Circle only (403 inner_circle_only otherwise). One vote per account per UTC month; voting again replaces it. update must be a registered, unreleased update that isn't open for early access (400 invalid_vote).",
});
route("get", "/api/holders/summary", "Holder Program transparency: aggregates only", {
  auth: null,
  response: object({
    rewards: object({
      since: integer,
      until: integer,
      credits: number,
      holders: integer,
    }),
    vote: object({
      month: string,
      candidates: array(object({ id: string, title: string, votes: integer })),
    }),
    earlyModels: earlyModelsSchema,
  }),
  description:
    "Credits paid and accounts rewarded over the 30 whole UTC days before today, and this month's roadmap vote counts per candidate. Once Early Model Access is released, earlyModels lists the models open to Insiders first right now, as in GET /api/account/holdings. Never names or identifies an account.",
});
for (const [path, summary] of [
  [
    "/api/config",
    "Public service availability; configured does not mean verified",
  ],
  [
    "/api/models",
    "Model catalog including capability, pricing, private-mode and training metadata. Once Early Model Access is released, a model in its first days carries earlyUntil (epoch ms, when it opens to everyone); only NYMA Insiders and up can use it until then (403 early_model otherwise)",
  ],
  ["/api/market", "Public cryptocurrency market feed"],
  ["/api/rates", "Crypto units per USD; validated rates cached for 60 seconds"],
  [
    "/health",
    "Process health and required configuration; HTTP 200 does not certify upstream workflows",
  ],
])
  route("get", path, summary, { auth: null });
route("get", "/api/conversations", "List latest 300 conversations", {
  response: object({ data: array(object()) }),
  description:
    "Each entry includes expires (epoch ms, or null for no auto-delete). An expired-but-not-yet-purged conversation is already excluded. Once Projects is released each entry also has project_id (null when the chat is in no project); GET /api/conversations/{id} includes it for a personal chat too.",
});
route("post", "/api/conversations", "Create conversation", {
  body: object({ title: string, mode: string }),
  response: object({ id: string }),
  status: 201,
});
route(
  "get",
  "/api/conversations/export",
  "Download personal and currently accessible shared conversations as JSON",
  { description: "Shared membership is required. Other members spending fields are redacted; removed members cannot export shared threads. The account export separately includes the requester’s retained shared contributions." },
);
route("delete", "/api/conversations", "Delete all personal conversations", {
  response: ref("Ok"),
});
route(
  "get",
  "/api/conversations/{id}",
  "Read conversation and decoded messages",
);
route("patch", "/api/conversations/{id}", "Rename or update conversation", {
  body: object({
    title: string,
    retention: {
      ...retentionDays,
      description:
        "Days until auto-delete from now; null clears it. Owner only — for a collab conversation, the collab owner.",
    },
  }),
  response: ref("Ok"),
  description:
    "A body without retention updates the title as before (defaulting to Untitled). A retention-only body leaves the title unchanged.",
});
route(
  "post",
  "/api/conversations/{id}/branch",
  "Branch a conversation from one of its messages",
  {
    body: object(
      {
        before: { ...string, description: "Copy every message ahead of this message id (edit or regenerate that turn)." },
        through: { ...string, description: "Copy messages up to and including this message id." },
        requestId: { ...string, description: "1–200 characters; retrying with the same id returns the same branch." },
        title: string,
      },
      ["requestId"],
    ),
    response: object({ id: string, title: string, mode: string, parent: object(), copied: integer }),
    status: 201,
    description:
      "Needs the Edit, Regenerate & Branch Chats update released (403 feature_unreleased otherwise). Give exactly one of before or through. The original conversation is unchanged. A shared conversation's branch stays in its collab (current members only). Copied messages carry origin_id and cost 0; nothing is charged. The branch never outlives an auto-deleting source. A retry with the same requestId returns 200 with the same branch; reusing it for a different branch is 409 idempotency_conflict. Symposium runs can't be branched. GET /api/conversations/{id} returns parent (if you can still open it) and branches (those you can open).",
  },
);
route("delete", "/api/conversations/{id}", "Delete conversation", {
  response: ref("Ok"),
});
route(
  "get",
  "/api/retention",
  "Account default auto-delete for new conversations",
  { response: object({ days: retentionDays }, ["days"]) },
);
route("put", "/api/retention", "Set account default auto-delete", {
  body: object({ days: retentionDays }, ["days"]),
  response: object({ ok: bool, days: retentionDays }),
  description:
    "Applies only to conversations created after this is set; existing conversations are unchanged.",
});
route("post", "/api/quote", "Estimate credits for a request", {
  body: object(
    {
      ...chat.properties,
      treasury: { ...bool, description: "Team-paid chat estimate: requires an accessible collab conversationId and the treasury release. Uses the standard team rate; available is the member's remaining spendable team balance. Does not reserve or charge." },
      ...generation,
      n: integer,
      ratio: string,
      duration: { type: ["string", "number"] },
      quality: string,
      image_url: string,
    },
    ["model"],
  ),
  response: ref("Quote"),
  description:
    "Estimate only: nothing is reserved, charged or stored. For a chat model it is the amount /api/chat prices the same messages, max_tokens and web search at; a chat request may hold up to the reservation multiplier times it while it runs. Final charge follows usage and the documented failure-billing policy. Limited to 120 quotes a minute per account.",
});
route("post", "/api/estimate/compare", "Cost Compare: estimate one chat request on several models", {
  body: object(
    {
      models: {
        ...array(string),
        minItems: 1,
        maxItems: 8,
        description:
          "1 to 8 distinct model ids. The first is the model in use: every difference is measured against it.",
      },
      messages: array(message),
      max_tokens: {
        ...integer,
        minimum: 1,
        default: 4096,
        description:
          "The reply budget as chosen. Each model is priced at the budget /api/chat would take from it: this one, up to that model's limit shown by /api/models (with Longer, More Reliable Answers released).",
      },
      mode: { enum: ["chat", "code", "uncensored"], default: "chat" },
      private: {
        ...bool,
        description:
          "Private Mode: only models flagged private are priced (others: private_model_required), and saved memory is never added. Needs the private update released.",
      },
      web_search: chat.properties.web_search,
      memory: {
        ...array(object({ id: string, text: string, updated: integer }, ["id", "text"])),
        description: "The saved memory facts Send would carry, priced exactly as /api/quote prices them. Needs the memory update released.",
      },
      conversationId: string,
      treasury: {
        ...bool,
        description: "Team-paid estimate, as for /api/quote: an accessible collab conversationId, the team rate and the member's spendable team balance.",
      },
    },
    ["models", "messages"],
  ),
  response: object({
    estimate: { const: true },
    current: string,
    available: number,
    web_search: bool,
    spending_limit: object({ remaining: number }),
    memory: object({ used: integer, skipped: integer }),
    results: array(
      object(
        {
          model: string,
          status: { enum: ["ok", "refused"] },
          credits: number,
          usd: number,
          difference: {
            type: ["number", "null"],
            description: "credits minus the first model's credits, subtracted in whole ledger units; null when the first model was refused.",
          },
          reply_budget: integer,
          code: {
            enum: [
              "context_limit_exceeded",
              "vision_required",
              "private_model_required",
              "other_section",
              "unsupported_model",
              "model_not_found",
              "model_unavailable",
              "unpriced_model",
            ],
          },
          message: string,
          context: object({
            input_tokens_estimate: integer,
            reply_budget: integer,
            allowance: integer,
            fits: bool,
          }),
        },
        ["model", "status"],
      ),
    ),
  }),
  description:
    "Cost Compare. Estimate only: nothing is reserved, charged or stored. Each ok result is exactly what POST /api/quote returns for that model with the same body and that model's reply_budget, which is what /api/chat would price (a chat may hold up to the reservation multiplier times it while it runs). A model that Send would refuse for this request is returned as refused with a code instead of a price: the message and reply budget exceed its context allowance (context_limit_exceeded, with the conservative token estimate), it can't read attached images (vision_required), it isn't private in Private Mode (private_model_required), it belongs to another section (other_section: Uncensored prices only its curated models, chat and code leave them out), or it's unknown, unavailable, unpriced or not a chat model. A problem with the request itself (no messages, an invalid budget or model list, more than 8 models) is a 400 for the whole comparison. Needs the Cost Compare and Credit Estimates updates released (403 feature_unreleased otherwise), plus Private Mode, Memory, Code & Build, Uncensored, Live Web Search or Team Treasury when the body uses them. Limited to 30 comparisons a minute per account.",
});
route(
  "get",
  "/api/requests/{id}",
  "Recover paid request reservation/receipt after a disconnect",
  {
    response: ref("RequestStatus"),
    description:
      "Use the original requestId, URL-encoded as a path segment. Owner-scoped. A 404 means no stored reservation; held means do not resubmit with a fresh ID. Receipt.charged uses integer ledger subunits; receipt.credits_charged uses displayed credits.",
  },
);
route("get", "/api/receipts/{id}", "Read a stored signed receipt", {
  response: ref("SignedReceipt"),
  description:
    "Owner-scoped. Use the requestId returned in the chat response's anonyma/askr extension, URL-encoded as a path segment.",
});
route("get", "/api/receipts/key", "Public Ed25519 receipt-signing key", {
  auth: null,
  response: ref("ReceiptKey"),
});
route(
  "get",
  "/.well-known/anonyma-receipts.json",
  "Same public receipt-signing key, at a well-known discovery path",
  { auth: null, response: ref("ReceiptKey") },
);
route("post", "/api/receipts/verify", "Verify a signed receipt", {
  auth: null,
  body: object(
    {
      receipt: ref("ReceiptPayload"),
      signature: string,
      answer: {
        ...string,
        description: "Optional answer text to check against response_sha256.",
      },
    },
    ["receipt", "signature"],
  ),
  response: object({
    valid: bool,
    key_id: nullableString,
    reason: { enum: ["unknown_key", "invalid_signature"] },
    answer_matches: bool,
  }),
  description:
    "Stateless: verifies the signature against the published public key alone; no database lookup of the original receipt is required. answer_matches is included only when answer is sent.",
});
route("post", "/api/chat", "Stream chat, code or compatible image output", {
  body: ref("ChatRequest"),
  stream: true,
  description:
    "Always SSE via fetch POST, not EventSource. Retains latest 20 messages. Parse data events across arbitrary byte boundaries; final usage event includes conversationId, askr and anonyma receipt (with anonyma.privacy once Privacy Trail is released), followed by [DONE]. Abort cancels work and settles delivered usage. Errors can follow HTTP 200. Use a stable requestId or Idempotency-Key; duplicates return 409, not a new charge. See the request body's private field for Private Mode. A request paid from the personal balance that would go over the account's own spending limits is refused with 402 spending_limit before anything is reserved (see GET /api/spending-limits); team-paid requests don't count.",
});
route("post", "/api/images", "Generate and save 1–4 images", {
  body: object(
    {
      ...generation,
      n: { ...integer, minimum: 1, maximum: 4, default: 1 },
      images: array(string),
    },
    ["model", "prompt"],
  ),
  response: object({
    data: array(ref("Media")),
    receipt: object({ charged: integer, credits_charged: number }),
    testMode: bool,
    partial: bool,
    warning: string,
  }),
  description:
    "Reference images use supported data URLs or HTTPS URLs; 8 total, 1.5 MB each. A later batch failure returns saved images with a warning and charges only delivered progress.",
});
route("post", "/api/videos", "Submit durable video job", {
  body: object(
    {
      ...generation,
      prompt: { ...string, maxLength: 2000 },
      ratio: string,
      duration: { type: ["string", "number"] },
      quality: string,
      image_url: string,
    },
    ["model", "prompt"],
  ),
  response: object({ id: string, status: string }),
  status: 202,
  description:
    "Choose a published variant from model pricing. Image-to-video requires HTTPS image_url. Poll GET /api/videos; resolve media_id through /api/media. Uncertain submission becomes reconciliation and must not be submitted again.",
});
route("get", "/api/videos", "List latest 60 jobs", {
  response: object({ data: array(ref("Video")) }),
});
route("get", "/api/audio/models", "List speech models, voices and prices", {
  auth: null,
  response: object({
    tts: array(
      object({
        id: string,
        name: string,
        char_limit: integer,
        credits_per_1k_chars: number,
        voices: array(object({ id: string, name: string, language: string })),
      }),
    ),
    stt: array(
      object({
        id: string,
        name: string,
        credits_per_minute: number,
        max_minutes: integer,
      }),
    ),
  }),
});
route(
  "post",
  "/api/audio/speech",
  "Turn text into speech saved to the library",
  {
    body: object(
      {
        model: string,
        text: { ...string, maxLength: 5000 },
        voice: string,
        language: string,
        requestId,
      },
      ["model", "text"],
    ),
    response: object({ data: ref("Media"), receipt: object() }),
    description:
      "Charged per character at the model's published rate; the audio file is stored privately with kind audio.",
  },
);
route("post", "/api/audio/transcriptions", "Transcribe a recording", {
  body: object(
    {
      audio: {
        ...string,
        description:
          "base64 audio data URL (webm, ogg, mp4, mpeg, wav), up to 10 MB",
      },
      model: string,
      language: string,
      requestId,
    },
    ["audio"],
  ),
  response: object({
    text: string,
    duration: { type: ["number", "null"] },
    receipt: object(),
  }),
  description:
    "Holds the cost of 10 minutes and charges the transcribed duration. Longer recordings are charged at most 10 minutes.",
});
const collabSummary = object({
  id: string,
  name: string,
  role: string,
  members: integer,
  updated: integer,
});
route("get", "/api/collabs", "List collabs you belong to", {
  response: object({ data: array(collabSummary) }),
});
route("post", "/api/collabs", "Create a collab", {
  body: object({ name: { ...string, maxLength: 60 } }, ["name"]),
  response: object({ id: string, name: string }),
  status: 201,
});
route("get", "/api/collabs/{id}", "Collab members and shared conversations", {
  response: object({
    id: string,
    name: string,
    role: string,
    maxMembers: integer,
    members: array(object({ username: string, role: string, joined: integer })),
    conversations: array(
      object({
        id: string,
        title: string,
        mode: string,
        updated: integer,
        author: string,
      }),
    ),
  }),
  description:
    "Members only. Shared conversations are read and posted through /api/conversations/{id} and /api/chat; each member's requests are billed to their own balance unless the chat request sets treasury (Team Treasury).",
});
route("patch", "/api/collabs/{id}", "Rename a collab (owner)", {
  body: object({ name: string }, ["name"]),
  response: ref("Ok"),
});
route(
  "delete",
  "/api/collabs/{id}",
  "Delete a collab and its shared conversations (owner)",
  {
    response: ref("Ok"),
    description:
      "Any Team Treasury balance returns to the owner as a linked treasury_return ledger pair in the same transaction. 409 treasury_busy while team-paid requests still hold treasury credits.",
  },
);
route("post", "/api/collabs/{id}/invite", "Create an invite link (owner)", {
  response: object({ token: string, link: string }),
  description: "Replaces any previous invite link.",
});
route("post", "/api/collabs/join", "Join a collab with an invite token", {
  body: object({ token: string }, ["token"]),
  response: object({ id: string, name: string }),
  description: "Up to 12 members per collab. Joining again is a no-op.",
});
route(
  "delete",
  "/api/collabs/{id}/members/{username}",
  "Remove a member or leave",
  {
    response: ref("Ok"),
    description:
      "The owner removes anyone else; a member may remove themself. The owner can't leave.",
  },
);
route(
  "post",
  "/api/collabs/{id}/conversations",
  "Start a shared conversation",
  {
    body: object({ title: string, mode: { enum: ["chat", "code"] } }),
    response: object({ id: string }),
    status: 201,
  },
);
route("get", "/api/scrolls", "List your saved scrolls", {
  response: object({ data: array(ref("Scroll")) }),
});
route("post", "/api/scrolls", "Save a reusable prompt as a scroll", {
  body: object(
    {
      title: { ...string, maxLength: 80 },
      body: { ...string, maxLength: 8000 },
    },
    ["title", "body"],
  ),
  response: ref("Scroll"),
  status: 201,
  description:
    'Body may contain {{variable}} placeholders filled in before sending. Up to 200 scrolls per account.',
});
route("patch", "/api/scrolls/{id}", "Rename or edit a scroll (owner)", {
  body: object({
    title: { ...string, maxLength: 80 },
    body: { ...string, maxLength: 8000 },
  }),
  response: ref("Scroll"),
});
route("delete", "/api/scrolls/{id}", "Delete a scroll (owner)", {
  response: ref("Ok"),
});
route(
  "get",
  "/api/instructions",
  "Read your standing instructions and whether they're enabled",
  { response: ref("Instructions") },
);
route(
  "put",
  "/api/instructions",
  "Replace your standing instructions and enabled flag",
  {
    body: object({ body: { ...string, maxLength: 4000 }, enabled: bool }),
    response: ref("Instructions"),
    description:
      "When enabled, the client sends this as a leading system message on chat, code and Uncensored requests, masked by Veil when Veil is on. This endpoint only stores it; it does not itself alter /api/chat.",
  },
);
// Memory Across Models (update "memory").
const memoryFact = object({ id: string, text: string, enabled: bool, created: integer, updated: integer, source: { type: ["object", "null"], properties: { conversation_id: string, title: { type: ["string", "null"] } } } });
route("get", "/api/memory", "Your memory: on/off and every saved fact", {
  response: object({ enabled: bool, facts: array(memoryFact), limit: integer }),
  description: "Off until you switch it on. Facts are only ever written through these routes; chat requests never add to memory.",
});
route("put", "/api/memory/settings", "Switch memory on or off for your account", {
  body: object({ enabled: bool }, ["enabled"]),
  response: object({ enabled: bool }),
  description: "Off: no fact is sent with any request, even if a request lists some.",
});
route("post", "/api/memory/facts", "Save a fact", {
  status: 201,
  body: object({ text: { ...string, maxLength: 300 }, enabled: bool, source_conversation: string }, ["text"]),
  response: memoryFact,
  description:
    "Text is trimmed to one line (1–300 characters). Secret keys (API-key and private-key formats), card and bank account numbers are refused (400 memory_sensitive). Up to 50 facts (400 memory_full). source_conversation, when saving from a message, must be a saved personal conversation you can read (404 otherwise; 400 memory_shared_source for a shared one); off-the-record and Private chats are never saved, so they can't be sources.",
});
route("patch", "/api/memory/facts/{id}", "Edit, pause or resume a fact", {
  body: object({ text: { ...string, maxLength: 300 }, enabled: bool }),
  response: memoryFact,
  description: "Takes effect on the next request: an edited fact's old text and a paused fact are no longer sent.",
});
route("delete", "/api/memory/facts/{id}", "Delete a fact", { response: ref("Ok") });
route("delete", "/api/memory", "Delete every saved fact", {
  response: ref("Ok"),
  description: "The on/off choice is kept. Account deletion also deletes memory; account export includes it.",
});
// Spending Limits (update "limits").
const limitCredits = {
  type: ["number", "null"],
  minimum: 0,
  maximum: 1e9,
  description: "Credits with at most four decimals; null means no limit.",
};
const limitWindow = object({
  limit: { ...limitCredits, description: "The limit in force now, in credits; null means none." },
  window_hours: integer,
  settled: { ...number, description: "Settled spend in the rolling window." },
  held: { ...number, description: "Every open hold on the personal balance." },
  used: { ...number, description: "settled + held." },
  remaining: { type: ["number", "null"], description: "limit minus used, never below 0; null without a limit." },
  pending: {
    type: ["object", "null"],
    properties: { limit: limitCredits, applies_at: integer },
    description: "A raise or removal waiting its 24 hours: the new limit (null removes it) and when it applies.",
  },
  next_room_at: { type: ["integer", "null"], description: "When the oldest counted spend in the window leaves it." },
});
const spendingLimits = object({
  daily: limitWindow,
  monthly: limitWindow,
  held: number,
  raise_delay_hours: integer,
});
route("get", "/api/spending-limits", "Your spending limits and usage", {
  response: spendingLimits,
  description:
    "Off until you set one. daily covers the last 24 hours, monthly the last 30 days, both rolling. What counts: settled charges on your personal balance (workspace, /v1 API, API keys, connected apps and the MCP server), credits you send, treasury contributions, and every hold still open. Team-paid collab requests (charged to the treasury), top-ups, refunds and rewards don't count.",
});
route("patch", "/api/spending-limits", "Set, lower, raise or remove a spending limit", {
  body: object({ daily_limit: limitCredits, monthly_limit: limitCredits }),
  response: {
    ...spendingLimits,
    properties: {
      ...spendingLimits.properties,
      changes: {
        ...object({
          daily_limit: { enum: ["applied", "pending", "unchanged"] },
          monthly_limit: { enum: ["applied", "pending", "unchanged"] },
        }),
        description: "What happened to each field sent.",
      },
    },
  },
  description:
    "Omitted fields keep their value. Adding or lowering a limit applies immediately (applied). Raising or removing one (null) applies 24 hours later (pending) and can be cancelled until then; a new value replaces any pending change, and a new raise starts the 24 hours again. Sending the limit in force cancels a pending change (unchanged). Limits are stored as integer ledger subunits and never write the ledger. 400 invalid_limit.",
});
route("delete", "/api/spending-limits/pending/{limit}", "Cancel a pending raise or removal", {
  response: spendingLimits,
  description:
    "limit is daily or monthly. The limit in force stays. 404 no_pending_change when nothing is pending.",
});
// Low-Balance Alerts (update "balancealerts").
const alertLevel = {
  type: ["number", "null"],
  minimum: 1,
  maximum: 1e9,
  description:
    "The alert level in credits (at most four decimals); null means the alert is off.",
};
const balanceAlert = object({
  enabled: bool,
  threshold: alertLevel,
  notify: {
    ...bool,
    description:
      "Whether the account asked for a browser notification as well as the in-app warning. Each browser still has to grant permission itself.",
  },
  available: {
    ...number,
    description:
      "The available balance now, in credits: credits minus every open hold (the same figure as /api/me's available).",
  },
  below: { ...bool, description: "enabled and available < threshold." },
  suggested: { ...number, description: "The level the app offers when you turn the alert on (500 credits)." },
  min: number,
  max: number,
  updated: { type: ["integer", "null"] },
});
route("get", "/api/balance-alert", "Your low-balance alert", {
  response: balanceAlert,
  description:
    "Off until you set a level. The app warns in the workspace when the available balance (personal balance minus open holds) is below it, and, if notify is on and the browser allowed it, shows one browser notification when it first drops below while ANONYMA is open. There is no email and no background push. Team Treasury balances aren't watched. Separate from spending limits. Account export includes it as balanceAlert; closing the account deletes it; Panic Wipe keeps it.",
});
route("patch", "/api/balance-alert", "Turn the low-balance alert on or off, or change it", {
  body: object({ threshold: alertLevel, notify: bool }),
  response: balanceAlert,
  description:
    "Omitted fields keep their value. threshold null turns the alert off and forgets notify with it. Turning it on needs a threshold (400 invalid_threshold otherwise); notify alone changes an alert that's already on. Stored as integer ledger subunits; never writes the ledger. 400 invalid_threshold, invalid_notify or invalid_alert. 60 changes an hour.",
});
// Share a Chat (update "sharelinks").
const shareLink = object({
  id: string,
  url: { ...string, description: "The public link: <origin>/s/<token>, 32 base64url characters (192 random bits)" },
  path: string,
  title: string,
  conversation_id: string,
  conversation_title: string,
  messages: { ...integer, description: "Messages in the snapshot" },
  created: integer,
  expires: { type: ["integer", "null"], description: "null: until revoked or the conversation is deleted" },
  ends_with_conversation: { ...bool, description: "The conversation's auto-delete is the deadline that applies" },
  sealed: { ...bool, description: "Sealed Share: the snapshot is ciphertext only. title and messages are null (they're sealed inside it) and url has no key: only the link made when it was shared can open it." },
  device_only: { ...bool, description: "Sealed Share: a sealed copy of a Device-only chat, with no conversation on the server (conversation_id null)" },
  bytes: { ...integer, description: "Sealed Share: the stored ciphertext's size" },
});
const sharedMessage = object({
  role: { enum: ["user", "assistant"] },
  text: { ...string, description: "The text as saved; Veil tags such as [EMAIL_1] stay as tags" },
  withheld: { ...integer, description: "Attachments, images or files left out; shown as a placeholder" },
  model: { ...string, description: "The model that wrote a reply" },
  interrupted: bool,
  citations: array(object({ url: string, title: string })),
});
route("get", "/api/shares", "Your live share links", {
  query: [{ name: "conversation", in: "query", required: false, schema: string, description: "Only links to this conversation" }],
  response: object({
    data: array(shareLink),
    limits: object({ active: integer, per_conversation: integer }),
  }),
  description: "Newest first. Revoked and expired links, and links whose conversation is gone, aren't listed.",
});
route("post", "/api/shares/draft", "The snapshot a sealed link would hold, for your browser to seal", {
  body: object(
    {
      conversationId: string,
      title: { ...string, maxLength: 70, description: "Defaults to the conversation's title" },
    },
    ["conversationId"],
  ),
  response: object({ title: string, messages: array(sharedMessage), withheld: integer, masked: integer }),
  description:
    "Sealed Share (needs sharelinks and sealedshare released). Builds the same snapshot an open link publishes and stores nothing. The browser seals { format: \"anonyma-sealed-share\", version: 1, title, messages } as UTF-8 JSON with AES-256-GCM (a random key and 12-byte IV, additional data \"anonyma-sealed-share:v1\") and uploads IV + ciphertext + tag with POST /api/shares. The same refusals as POST /api/shares.",
});
route("post", "/api/shares", "Share a saved conversation as a read-only snapshot link", {
  status: 201,
  body: object(
    {
      conversationId: { ...string, description: "Required, except for a Device-only share (device: true), which must not send one" },
      expires_in_days: { type: ["integer", "null"], enum: [1, 7, 30, null], default: 7, description: "null: never (until revoked). Never later than the conversation's own auto-delete." },
      title: { ...string, maxLength: 70, description: "Shown on the shared page; defaults to the conversation's title. Refused on a sealed link, whose title is sealed inside it." },
      sealed: { ...bool, default: false, description: "Sealed Share (needs sealedshare released): upload ciphertext only. The link's key stays in its #k= fragment and never reaches the server." },
      ciphertext: { ...string, description: "With sealed: base64url of the 12-byte IV, the AES-GCM ciphertext and its 16-byte tag, at most 3 MB (400 share_too_large); an account's live sealed links hold at most 32 MB in all (400 share_limit)." },
      device: { ...bool, default: false, description: "With sealed: a Device-only chat, kept only in the browser and never on the server. Refused without sealed (400 share_device_sealed)." },
    },
  ),
  response: object({ ...shareLink.properties, withheld: integer, masked: { ...integer, description: "Veil tags in the snapshot" } }),
  description:
    "Copies the conversation's messages once: user and assistant text as saved (Veil tags stay tags), a placeholder count for attachments, images and files, and the model that wrote each reply. Later messages are not added. Never includes the account's username, email, wallet, balance, costs, receipts or request ids. Only your own saved personal chat, code or uncensored conversations (404 otherwise); off-the-record and Private chats are never saved (400 share_excluded), collab conversations are refused (400 share_collab), as are Symposium runs (400 share_mode), empty conversations (400 share_empty) and snapshots over 400 messages or 2,000,000 characters (400 share_too_large). Up to 100 live links per account and 5 per conversation (400 share_limit). Deleting the conversation or closing the account deletes its links.",
});
route("delete", "/api/shares/{id}", "Revoke a share link", {
  response: ref("Ok"),
  description: "Deletes the snapshot; the link returns 404 at once.",
});
route("get", "/api/s/{token}", "A shared conversation snapshot (public)", {
  auth: null,
  response: object({
    title: string,
    created: { ...integer, description: "When the snapshot was taken" },
    messages: array(sharedMessage),
    sealed: { ...bool, description: "Sealed Share: only sealed, created and ciphertext are sent; the page opens the ciphertext with the key in its link" },
    ciphertext: { ...string, description: "Sealed Share: base64url IV + AES-GCM ciphertext + tag" },
  }),
  description:
    "No sign-in. Rate-limited per address. Unknown, revoked, expired and deleted links all return the same 404 share_not_found. Sent with X-Robots-Tag: noindex, nofollow and Referrer-Policy: no-referrer.",
});
route("get", "/s/{token}", "The shared conversation page (public)", {
  auth: null,
  description: "The web app's page for a share link, with the same headers and the same 404 as /api/s/{token}. The page is the same generic app shell for every link, sealed or not: link previews never show a snapshot's title or text.",
});
// Routines (update "routines").
const routineSchedule = object(
  {
    repeat: { enum: ["daily", "weekdays", "weekly"], description: "weekdays: Monday to Friday in the routine's time zone" },
    time: { ...string, pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "Wall-clock time, 24-hour HH:MM" },
    day: { ...integer, minimum: 0, maximum: 6, description: "Weekly only: 0 = Sunday … 6 = Saturday" },
    timezone: { ...string, default: "UTC", description: "IANA time zone, stored in its canonical form. A time the clocks skip runs as far past the jump; a repeated time runs once, the first time." },
  },
  ["repeat", "time"],
);
const routineFields = {
  name: { ...string, minLength: 1, maxLength: 80 },
  prompt: { ...string, minLength: 1, maxLength: 8000, description: "Sent as written: Veil runs in the browser and can't mask a scheduled run." },
  model: { ...string, description: "A text chat model this installation can run" },
  web_search: { ...bool, default: false, description: "Needs Live Web Search released; each run pays its search fee." },
  private_only: { ...bool, default: false, description: "Needs Private Mode released. Routes like Private Mode: zero data retention models only, never the backup gateway. Answers are still kept in the inbox." },
  schedule: routineSchedule,
  per_run_credits: { ...number, exclusiveMinimum: 0, maximum: 100000, description: "At most four decimals. Also sets the reply budget: the largest (256 to 4,096 tokens) whose worst-case hold fits." },
  monthly_budget_credits: { ...number, exclusiveMinimum: 0, maximum: 1000000, description: "Per calendar month in the routine's time zone; at least per_run_credits." },
  enabled: { ...bool, default: true },
};
const routine = object({
  id: string,
  ...routineFields,
  next_run_at: { type: ["integer", "null"], description: "null while off" },
  running: bool,
  last_run_at: { type: ["integer", "null"], description: "The slot of the latest run" },
  last_status: { type: ["string", "null"], enum: ["done", "refused", "failed", null] },
  month: object({ spent: number, held: number, remaining: number, resets_at: integer }),
  created: integer,
  updated: integer,
});
const routineRun = object({
  id: string,
  routine_id: string,
  routine_name: string,
  scheduled_for: integer,
  started_at: integer,
  finished_at: { type: ["integer", "null"] },
  status: { enum: ["running", "done", "refused", "failed"], description: "refused: nothing was reserved or charged" },
  skipped: { ...integer, description: "Older missed slots skipped by this catch-up run" },
  model: string,
  web_search: bool,
  private_only: bool,
  request_id: string,
  credits_charged: number,
  reply_budget: { type: ["integer", "null"] },
  finish_reason: { type: ["string", "null"] },
  answer: { type: ["string", "null"] },
  citations: array(object({ url: string, title: string })),
  signed_receipt: { type: ["object", "null"], description: "Present once Signed Receipts is released; verify at /api/receipts/verify" },
  code: { type: ["string", "null"], description: "Why a run was refused or failed: insufficient_credits, spending_limit, routine_run_cap, routine_budget, routine_gone, model_unavailable, search_unavailable, private_unavailable, private_model_required, interrupted or a provider error code" },
  message: { type: ["string", "null"] },
});
route("get", "/api/routines", "Your routines", {
  response: object({ routines: array(routine), max_routines: integer, keep_runs: integer }),
  description: "Oldest first. month is this calendar month in each routine's own time zone: settled charges and open holds. 120 reads a minute.",
});
route("post", "/api/routines", "Create a routine", {
  status: 201,
  body: object(routineFields, ["name", "prompt", "model", "schedule", "per_run_credits", "monthly_budget_credits"]),
  response: routine,
  description:
    "At most 10 per account (409 routine_limit). The first run is the next slot after now; saving never runs a routine at once. Runs start from the background worker on the same hold and settle path as /v1/chat/completions, and are refused, with nothing reserved, when the balance, the account's spending limits, the monthly budget or the per-run maximum can't cover the worst case. One run at a time per routine; after downtime only the latest missed slot runs. 400 invalid_routine, invalid_schedule, invalid_model or private_model_required. 120 changes an hour.",
});
route("patch", "/api/routines/{id}", "Change, switch on or switch off a routine", {
  body: object(routineFields),
  response: routine,
  description: "Omitted fields keep their value. A new schedule, or switching on, moves the next run to the next slot after now.",
});
route("delete", "/api/routines/{id}", "Delete a routine and its inbox", {
  response: ref("Ok"),
  description: "409 routine_running while a run is in flight.",
});
route("get", "/api/routines/runs", "The Routines inbox", {
  query: [
    { name: "routine", in: "query", required: false, schema: string, description: "Only this routine's runs" },
    { name: "before", in: "query", required: false, schema: integer, description: "Only runs started before this time, for the next page" },
  ],
  response: object({ runs: array(routineRun), more: bool }),
  description: "Newest first, 50 at a time. Each routine keeps its newest 50 runs.",
});
route("delete", "/api/routines/runs/{id}", "Delete one run from the inbox", {
  response: ref("Ok"),
  description: "The ledger entry and signed receipt stay. 409 routine_running while it's in flight.",
});
// Projects (update "projects"; pinning files also needs "files", and a
// default privacy mode the update behind it).
const projectFile = object({
  id: string,
  name: string,
  bytes: integer,
  kind: { const: "document" },
  truncated: bool,
  characters: integer,
  expires: { ...integer, description: "The saved upload's own expiry; the pin goes with it." },
});
const projectChat = object({
  id: string,
  title: string,
  mode: string,
  created: integer,
  updated: integer,
  expires: { type: ["integer", "null"] },
});
const projectFields = {
  name: { ...string, minLength: 1, maxLength: 60 },
  color: { enum: ["cobalt", "navy", "amber", "ink", "slate", "mist"], default: "cobalt" },
  instructions: {
    ...string,
    maxLength: 4000,
    default: "",
    description:
      "Sent by the workspace with every chat in the project, after the account's standing instructions, as the leading system message; Veil masks them in the browser. Once Seed Guard is released a wallet seed phrase is refused (400 seed_phrase_blocked), with no override.",
  },
  privacy: {
    enum: ["normal", "off_record", "private"],
    default: "normal",
    description:
      "How a new chat in the project starts. off_record needs Ephemeral Chats and private needs Private Mode and Ephemeral Chats (403 feature_unreleased otherwise). Off the record and Private chats store nothing on the server, so they're never listed in a project here.",
  },
  model: { type: ["string", "null"], description: "A default chat model id, or null for none." },
  files: {
    ...array(string),
    maxItems: 5,
    description:
      "Saved upload ids to pin (text and Office files only), replacing the current pins. Needs Files & Reusable Uploads released. The workspace attaches their text to each new chat in the project where Saved files work: not in Private Mode, off the record, Device only or with Veil on. 404 for a file that isn't yours.",
  },
};
const project = object({
  id: string,
  name: string,
  color: string,
  instructions: string,
  privacy: string,
  model: { type: ["string", "null"] },
  files: array(projectFile),
  chat_count: integer,
  run_count: { ...integer, description: "Symposium runs filed in the project" },
  created: integer,
  updated: integer,
});
const projectDetail = {
  ...project,
  properties: {
    ...project.properties,
    chats: array(projectChat),
    runs: { ...array(projectChat), description: "Symposium runs, newest first" },
  },
};
route("get", "/api/projects", "Your projects", {
  response: object({ projects: array(project), max_projects: integer, max_pinned: integer }),
  description: "Oldest first. Counts and lists leave out auto-deleted chats.",
});
route("post", "/api/projects", "Create a project", {
  status: 201,
  body: object(projectFields, ["name"]),
  response: projectDetail,
  description:
    "At most 50 per account (409 project_limit). 400 invalid_project, invalid_model or project_files_limit. 240 changes an hour.",
});
route("get", "/api/projects/{id}", "A project with its chats and Symposium runs", {
  response: projectDetail,
  description: "404 project_not_found for a project that isn't yours.",
});
route("patch", "/api/projects/{id}", "Change a project", {
  body: object(projectFields),
  response: projectDetail,
  description: "Omitted fields keep their value; files replaces the pins.",
});
route("delete", "/api/projects/{id}", "Delete a project", {
  response: ref("Ok"),
  description: "Its chats and Symposium runs stay saved, in no project; pinned uploads stay in Saved files.",
});
route("post", "/api/projects/{id}/chats", "Move a saved chat into a project", {
  body: object({ conversationId: string }, ["conversationId"]),
  response: object({ ok: bool, conversation_id: string, project_id: string }),
  description:
    "From no project or another project. Your own personal chats and Symposium runs only: a collab's shared chats stay in the collab (400), and another account's chat or project is 404.",
});
route("delete", "/api/projects/{id}/chats/{conversation}", "Take a chat out of a project", {
  response: ref("Ok"),
  description: "The chat stays saved, in no project. 404 not_in_project when it isn't in this one.",
});
// Sealed Mode (update "sealed"; server/sealed.js). The body of a sealed chat
// is EHBP ciphertext the server can't read: see docs/operations/sealed-mode.md.
const sealedRequest = object({
  requestId: string,
  status: {
    ...string,
    enum: ["relaying", "settled", "released", "reconcile_pending"],
    description: "settled: charged from the enclave's usage record or PPQ's query history. released: nothing was charged (the provider never accepted it). reconcile_pending: the hold is kept until PPQ's query history shows the charge.",
  },
  model: string,
  held: number,
  charged: { type: ["number", "null"] },
  usage: { type: ["object", "null"], description: "Token counts, once settled" },
  reason: { type: ["string", "null"] },
  ciphertextBytes: integer,
  responseBytes: integer,
  created: integer,
  finished: { type: ["integer", "null"] },
});
route("get", "/api/sealed/attestation", "The enclave's attestation bundle", {
  query: [{ name: "fresh", in: "query", required: false, schema: string, description: "1 skips the relay's one-minute cache (after the enclave rotated its key)" }],
  response: object({}),
  description:
    "PPQ's /private/attestation bundle as served (Tinfoil's router enclave: an AMD SEV-SNP report, the Sigstore bundle of its release, the VCEK and the enclave certificate binding its HPKE key). The browser verifies it itself; nothing here is trusted. 503 sealed_unavailable until Sealed Mode is released and SEALED_BILLING is set; 503 attestation_unavailable. 30 reads a minute.",
});
route("post", "/api/sealed/chat", "Relay a sealed chat request", {
  body: { ...string, format: "binary", description: "EHBP ciphertext: a 4-byte big-endian length, then the HPKE-sealed chat request. Sent as application/json, as EHBP keeps the original type; never parsed. At most 1.5 MiB." },
  stream: true,
  description:
    "Headers: Ehbp-Encapsulated-Key (64 hex), X-Private-Model (an open-weight private/* model with privacyLevel e2e; anything else is 400 sealed_model_required) and Idempotency-Key (the request id). The hold is the worst case at the model's catalog price (every ciphertext byte as an input token plus the sealed output cap), refused above SEALED_MAX_HOLD_USD with 413 sealed_hold_cap. The body goes to PPQ's private endpoint unchanged and the encrypted reply streams back unbuffered with its Ehbp-Response-Nonce. A 422 key-config problem passes through so the browser re-verifies; other refusals are released with no charge. Settled from the X-Tinfoil-Usage-Metrics trailer, or held as reconcile_pending until PPQ's query history shows the charge. 20 a minute.",
});
route("get", "/api/sealed/requests/{id}", "A sealed request's billing", {
  response: sealedRequest,
  description: "Metadata only: the relay never sees the prompt or reply. 404 for another account's request.",
});
paths["/s/{token}"].get.responses[200].content = { "text/html": { schema: string } };
// Bookmarks (update "bookmarks").
const bookmark = object({
  id: string,
  message_id: string,
  conversation_id: string,
  conversation_title: string,
  conversation_mode: { enum: ["chat", "code", "uncensored"] },
  collab: { type: ["object", "null"], properties: { id: string, name: string }, description: "The shared workspace, for a message in a collab conversation" },
  expires: { type: ["integer", "null"], description: "The conversation's auto-delete time; the bookmark goes with it" },
  role: { enum: ["user", "assistant"] },
  model: { type: ["string", "null"], description: "The model that wrote a reply" },
  author: { type: ["string", "null"], description: "Who wrote a prompt in a shared conversation, when it wasn't you" },
  message_created: integer,
  excerpt: { ...string, description: "Up to 280 characters of the message as one line (a prompt without its attached documents); empty for an image- or attachment-only message" },
  more: { ...bool, description: "The message goes on past the excerpt" },
  diagram: { ...bool, description: "Math & Diagrams: present (true) once that update is released, on an answer whose Mermaid diagram was left out of the excerpt" },
  note: { ...string, maxLength: 140, description: "Your private note; empty when there is none" },
  created: integer,
  updated: integer,
});
route("get", "/api/bookmarks", "Your bookmarks", {
  query: [
    { name: "q", in: "query", required: false, schema: { ...string, maxLength: 160 }, description: "Only bookmarks whose note, conversation title or message text contains this" },
    { name: "role", in: "query", required: false, schema: { enum: ["all", "user", "assistant"], default: "all" }, description: "user: prompts; assistant: answers" },
    { name: "noted", in: "query", required: false, schema: bool, description: "Only bookmarks with a note" },
    { name: "conversation", in: "query", required: false, schema: string, description: "Only bookmarks in this conversation" },
    { name: "limit", in: "query", required: false, schema: { ...integer, minimum: 1, maximum: 1000, default: 50 } },
    { name: "offset", in: "query", required: false, schema: { ...integer, minimum: 0, maximum: 1000, default: 0 } },
  ],
  response: object({
    data: array(bookmark),
    nextOffset: { type: ["integer", "null"] },
    total: { ...integer, description: "Every bookmark you can see, whatever the filter" },
    limit: { ...integer, description: "Bookmarks an account can keep (1,000)" },
  }),
  description:
    "Newest first. Only your own bookmarks, and only on messages you can still read: a conversation that was deleted, is past its auto-delete time, or belongs to a collab you left is never listed, and its bookmarks are deleted with it. 400 invalid_request.",
});
route("post", "/api/bookmarks", "Bookmark a saved message", {
  status: 201,
  body: object(
    {
      message_id: string,
      note: { ...string, maxLength: 140, description: "Optional private note, one line. With Seed Guard live, a seed phrase is refused (400 seed_phrase_blocked)." },
    },
    ["message_id"],
  ),
  response: bookmark,
  description:
    "A message of a saved chat, code or Uncensored conversation you can open: your own, or a shared one in a collab you belong to. Other members never see your bookmarks. Messages you can't read return the same 404 bookmark_message_not_found as missing ones; Symposium runs return 400 bookmark_excluded (off-the-record and Private chats are never saved). Bookmarking a message again returns its bookmark unchanged (200). At most 1,000 per account (409 bookmark_limit). A bookmark stays on its message: branching copies the conversation's messages without it.",
});
route("patch", "/api/bookmarks/{id}", "Change a bookmark's note", {
  body: object({ note: { ...string, maxLength: 140, description: "An empty note clears it" } }, ["note"]),
  response: bookmark,
  description: "404 bookmark_not_found for another account's bookmark or one whose message you can no longer read.",
});
route("delete", "/api/bookmarks/{id}", "Remove a bookmark", {
  response: ref("Ok"),
  description: "The message itself is unchanged.",
});
// Link Reader (update "linkreader", which also needs "documents").
route("post", "/api/read", "Read a web page for a message", {
  body: object(
    { url: { ...string, maxLength: 2048, description: "An http:// or https:// link on port 80 or 443, without a username or password" } },
    ["url"],
  ),
  response: object({
    kind: { enum: ["html", "text", "pdf"] },
    url: { ...string, description: "The page's final address, after redirects, without tracking parameters (utm_*, fbclid, gclid, ...)" },
    host: string,
    redirected: bool,
    title: string,
    site_name: { ...string, description: "The site's own name when the page gives one; may be empty" },
    byline: { ...string, description: "The author line when the page gives one; may be empty" },
    words: { ...integer, description: "Words in text (html and text only)" },
    truncated: { ...bool, description: "The page was longer than 30,000 words and text is its start (html and text only)" },
    text: { ...string, description: "The readable text: scripts, styles, forms, navigation and link URLs removed (html and text only)" },
    bytes: { ...integer, description: "The PDF's size (pdf only)" },
    pdf: { ...string, description: "The PDF, base64-encoded, for the browser's own text extraction (pdf only)" },
  }),
  description:
    "Fetched by the server, so the site never sees your browser or IP: no cookies, no Referer, a generic User-Agent. Only public addresses are fetched: the name is resolved once per hop and every address must be public (loopback, private, link-local, CGNAT, multicast, reserved, IPv6 ULA and link-local, their IPv4-mapped forms and cloud metadata addresses are refused, 400 link_blocked), and the connection goes to the checked address. At most 3 redirects, each checked again (502 link_redirects); 10 seconds (504 link_timeout); 5 MB (413 link_too_large); text/html, text/plain and application/pdf only (415 link_type). Other refusals: 400 link_invalid, link_userinfo, link_port; 502 link_unreachable, link_status; 422 link_unreadable; 429 link_busy (2 at once per account) or rate_limit (60 an hour). Free: nothing is charged or stored, and the link is never logged. The browser attaches the text to your message as a document.",
});
// Team Treasury (update "treasury", which also needs "collab").
const treasuryAmount = (verb) =>
  object(
    {
      credits: {
        ...number,
        minimum: 1,
        maximum: 1000000,
        description: `Credits to ${verb}, up to four decimals`,
      },
      idempotency_key: {
        ...string,
        minLength: 1,
        maxLength: 200,
        description:
          "Required (or the Idempotency-Key header). A retry with the same key returns the original transfer; the same key with a different amount is refused with 409 idempotency_conflict.",
      },
    },
    ["credits", "idempotency_key"],
  );
const treasuryTransfer = object({
  id: string,
  credits: number,
  balance: { ...number, description: "Treasury balance after the transfer" },
  available: {
    ...number,
    description: "Treasury balance less credits held by team-paid requests",
  },
});
const creditLimit = {
  type: ["number", "null"],
  description: "Credits; null means no limit",
};
const treasuryMember = object({
  id: string,
  username: string,
  role: string,
  daily_limit: creditLimit,
  monthly_limit: creditLimit,
  daily_used: number,
  monthly_used: number,
});
route("get", "/api/collabs/{id}/treasury", "Team Treasury balance, limits and activity", {
  response: object({
    id: string,
    name: string,
    role: string,
    balance: number,
    available: number,
    held: number,
    you: treasuryMember,
    members: array(treasuryMember),
    monthly_used: { ...number, description: "Collab-wide settled spend over 30 days plus active holds, including former members." },
    activity: array(
      object({
        type: { enum: ["contribution", "withdrawal", "return", "spend"] },
        member: string,
        model: { ...string, description: "Spends only" },
        status: {
          enum: ["pending", "charged", "released"],
          description: "Spends only. Pending shows the credits held.",
        },
        credits: number,
        created: integer,
      }),
    ),
  }),
  description:
    "Members only. Limits cover the last 24 hours (daily) and 30 days (monthly); usage is settled team spend in the window plus credits still held. Members start with a daily limit of 0, so they can't spend until the owner sets one, and no monthly limit; the owner has no limit unless they set one. Activity lists the latest 50 contributions, withdrawals, returns and spends.",
});
route("post", "/api/collabs/{id}/treasury/contribute", "Contribute credits to the treasury", {
  body: treasuryAmount("contribute"),
  response: treasuryTransfer,
  status: 201,
  description:
    "Any member. Moves available credits atomically as a linked treasury_contribution ledger pair; the treasury is a hidden ledger account created on the first contribution. Contributed credits belong to the treasury, which its owner controls, and can't be taken back. Repeats return 200. 402 insufficient_credits; 402 spending_limit when the contribution would go over the contributor's own spending limits (contributions count toward them); 409 payment_reconciliation_pending while the contributor has a credited payment under reconciliation.",
});
route("post", "/api/collabs/{id}/treasury/withdraw", "Withdraw treasury credits (owner)", {
  body: treasuryAmount("withdraw"),
  response: treasuryTransfer,
  status: 201,
  description:
    "Owner only, back to the owner's own balance, as a linked treasury_withdrawal ledger pair. Only available credits (not those held by team-paid requests) can be withdrawn: 402 treasury_insufficient. Repeats return 200.",
});
route(
  "patch",
  "/api/collabs/{id}/treasury/members/{userId}",
  "Set a member's team spending limits (owner)",
  {
    body: object({ daily_limit: creditLimit, monthly_limit: creditLimit }),
    response: treasuryMember,
    description:
      "Omitted fields keep their value; null means no limit and 0 means the member can't spend. Limits go when the member leaves, is removed or closes their account; someone who rejoins starts at a daily limit of 0 again.",
  },
);
// Workspace chat only; /v1 ignores it.
chat.properties.treasury = {
  ...bool,
  description:
    'Team Treasury "Team pays": hold and charge this request to the treasury of the collab that owns conversationId, within the member\'s daily and monthly limits (checked atomically with the hold, counting their held requests). 400 treasury_unavailable outside collab conversations; 402 treasury_limit or treasury_insufficient. Charged at the standard rate, since every member sees the spend. Settlement, receipts and refunds are unchanged.',
};
route("get", "/api/referrals", "Your referral link and rewards", {
  response: object(
    {
      code: string,
      link: string,
      percent: {
        ...number,
        description: "The base referral percent (REFERRAL_PERCENT)",
      },
      invited: integer,
      earned: number,
      rate: {
        ...object({
          percent: number,
          base: number,
          tier: {
            ...nullableString,
            enum: ["holder", "insider", "inner", null],
            description: "The NYMA tier that raises the rate, or null",
          },
        }),
        description:
          "Referral Boost, only while it's released: your rate now. The rate a reward uses is fixed when each deposit is credited.",
      },
      boost: {
        ...object({
          base: number,
          tiers: array(
            object({
              id: string,
              name: string,
              min: number,
              percent: number,
            }),
          ),
        }),
        description:
          "Referral Boost, only while it's released: each NYMA Holder Program tier's referral percent.",
      },
    },
    ["code", "link", "percent", "invited", "earned"],
  ),
  description:
    "Sign-ups through the link (the ref query parameter sets the anonyma_ref cookie) are attributed to you. You earn percent of each credited deposit they make; the reward is reversed if that deposit is reversed. With Referral Boost released, a referrer at a NYMA Holder Program tier (a fresh balance check, as for every holder perk) earns that tier's percent instead, fixed when the deposit is credited and recorded in the reward's ledger description, e.g. \"Referral reward (7.5%, Insider boost)\"; a reversal takes back exactly what was paid.",
});
route("post", "/api/credits/send", "Send credits to another account", {
  body: object(
    {
      to: {
        ...string,
        description: "Recipient username (a leading @ is ignored)",
      },
      amount: {
        ...number,
        minimum: 1,
        maximum: 1000000,
        description: "Credits, up to four decimals",
      },
      requestId,
    },
    ["to", "amount"],
  ),
  response: object({
    id: string,
    to: string,
    credits: number,
    available: number,
  }),
  status: 201,
  description:
    "Moves available credits atomically as a linked transfer_out/transfer_in ledger pair. Reusing a requestId returns the original transfer instead of sending again. Paused while a credited payment is under reconciliation. Credits sent count toward the sender's own spending limits: 402 spending_limit when a transfer would go over one.",
});
route("get", "/api/media", "List private workspace library", {
  response: object({ data: array(ref("Media")) }),
});
route("get", "/api/media/{id}", "Fetch owned or temporarily signed media", {
  auth: null,
  description:
    "Requires owner cookie OR valid expires and sig query parameters on an API-issued URL. Returns image/video bytes with their MIME type; expired or unauthorized URLs return 404.",
  query: [
    { in: "query", name: "expires", schema: integer },
    { in: "query", name: "sig", schema: string },
  ],
});
paths["/api/media/{id}"].get.responses[200].content = {
  "application/octet-stream": { schema: { type: "string", format: "binary" } },
};
route("delete", "/api/media/{id}", "Delete private media", {
  response: ref("Ok"),
});
route(
  "get",
  "/api/account/ledger",
  "Latest 50 ledger entries and current balance",
);
route("get", "/api/account/summary", "Spending over the last 14 days", {
  description:
    "Settled usage per local day (oldest first), per kind (chat, image, video, audio) and for the last 7 days against the 7 before. Deposits, transfers and referral rewards are excluded.",
  query: [
    {
      in: "query",
      name: "tz",
      description:
        "Minutes behind UTC, as returned by Date.getTimezoneOffset().",
      schema: integer,
    },
  ],
});
// Usage Insights & Export (update "insights"; server/usage-insights.js).
const exactMoney = object({
  units: { ...integer, description: "Integer ledger subcredits (10000 = 1 credit)." },
  credits: { ...string, description: "Exact decimal string, 4 places." },
  usd: { ...string, description: "Exact decimal string, 7 places (1 USD = 1000 credits)." },
});
const usageQuery = [
  {
    in: "query",
    name: "from",
    description: "First UTC day, YYYY-MM-DD (inclusive). Send with to, not with days.",
    schema: string,
  },
  {
    in: "query",
    name: "to",
    description: "Last UTC day, YYYY-MM-DD (inclusive), no later than today (UTC).",
    schema: string,
  },
  {
    in: "query",
    name: "days",
    description: "The last N UTC days including today, 1–366. Default 30 when from/to are absent.",
    schema: { ...integer, minimum: 1, maximum: 366, default: 30 },
  },
];
const usageRow = (label) =>
  array(object({ [label]: string, requests: integer, spent: exactMoney }));
route("get", "/api/account/usage", "Where your credits went, from your own ledger", {
  query: usageQuery,
  response: object({
    range: object({ from: string, to: string, days: integer, timezone: { const: "UTC" }, start: string, end: string }),
    units: object({ credits: string, usd: string }),
    totals: object({
      spent: exactMoney,
      topups: exactMoney,
      sent: exactMoney,
      received: exactMoney,
      rewards: exactMoney,
      team_transfers: exactMoney,
      other: exactMoney,
      net: exactMoney,
      requests: integer,
      entries: integer,
    }),
    held: object({ ...exactMoney.properties, requests: integer }),
    team_paid: object({ ...exactMoney.properties, requests: integer }),
    daily: array(object({ date: string, requests: integer, spent: exactMoney })),
    by_model: usageRow("model"),
    by_feature: usageRow("feature"),
    by_source: array(
      object({
        source: { enum: ["web", "api_key", "connected_app"] },
        id: nullableString,
        label: nullableString,
        revoked: bool,
        requests: integer,
        spent: exactMoney,
      }),
    ),
  }),
  description:
    "Needs the insights update released (403 feature_unreleased otherwise); only the signed-in account's own ledger; 60 requests a minute. Days are UTC days, and the range is at most 366 of them (400 invalid_range or range_too_long). All sums are integer subcredits written as exact decimal strings, so net equals the ledger's own sum for the range and equals topups + received + rewards + team_transfers + other - spent - sent. spent is settled requests only (a released hold adds nothing), and daily, by_model, by_feature and by_source each add up to it. by_feature is chat, web_search, symposium, double_check (chat requests labelled from this release on; off the record and Private only chat or web_search), image, video, speech, transcription. held is what is reserved right now, not a range figure. team_paid is what this account's Team pays requests cost Team Treasuries in the range: not this account's balance, so it is in no other figure and not exported. No prompts, replies or media are read.",
});
route("get", "/api/account/usage/export", "Download your ledger rows as CSV or JSON", {
  query: [
    {
      in: "query",
      name: "format",
      description: "csv (default) or json.",
      schema: { enum: ["csv", "json"], default: "csv" },
    },
    ...usageQuery,
  ],
  description:
    "Needs the insights update released (403 feature_unreleased otherwise). Every ledger entry of the signed-in account in the range (same from/to/days rules as /api/account/usage), oldest first, as a download (Content-Disposition attachment; X-Export-Rows gives the count). Columns: timestamp_utc (ISO 8601), entry_id, type (ledger kind), category (spend, topup, sent, received, reward, team, other), credits and usd (exact signed decimal strings from integer subcredits), subcredits (the integer), model, feature and source (spend rows), key_or_app (API key or connected app name), receipt_id (request id of a signed receipt, for GET /api/receipts/{id}), ledger_ref, description (server-written). The credits column sums exactly to the ledger for those rows. CSV is RFC 4180 with CRLF and a UTF-8 byte-order mark; a text cell starting with = + - @, a tab or a line break (or a full-width = + - @) is prefixed with an apostrophe so spreadsheets don't run it. JSON has the same entries plus range, units and a summary. Team pays charges (a Team Treasury's ledger) and all prompt, reply and media content are never included. At most 100,000 entries per file (400 export_too_large with the count; nothing is truncated); 20 exports per 10 minutes.",
});
paths["/api/account/usage/export"].get.responses[200].content = {
  "text/csv": { schema: { type: "string" } },
  "application/json": { schema: object() },
};
route("get", "/api/keys", "List key metadata; raw keys never returned");
route("post", "/api/keys", "Create API key; secret returned once", {
  body: object({
    name: string,
    cap: {
      type: ["number", "null"],
      minimum: 0,
      maximum: 1e9,
      description:
        "Rolling 24-hour displayed-credit cap, including active holds.",
    },
  }),
  status: 201,
  response: object({ id: string, key: string, name: string, message: string }),
});
route("delete", "/api/keys/{id}", "Revoke API key", { response: ref("Ok") });
route(
  "patch",
  "/api/keys/{id}/allowance",
  "Set or clear a key's lifetime allowance, expiry and agent label",
  {
    body: object({
      total_credits: {
        type: ["number", "null"],
        minimum: 0,
        maximum: 1e9,
        description: "Lifetime credit cap. null removes it (unlimited).",
      },
      expires_at: {
        type: ["integer", "null"],
        description: "Millisecond timestamp. null removes the expiry.",
      },
      label: { type: ["string", "null"], maxLength: 60 },
    }),
    response: ref("KeyUsage"),
    description:
      "Owner only. Fields left out of the body are unchanged; sending null clears that field.",
  },
);
route("post", "/api/keys/{id}/pause", "Pause an API key", {
  response: ref("KeyUsage"),
  description:
    "Owner only. A paused key still authenticates, but every request that would spend credits is refused with 403 key_paused until it is resumed.",
});
route("post", "/api/keys/{id}/resume", "Resume a paused API key", {
  response: ref("KeyUsage"),
  description: "Owner only.",
});
route("get", "/api/keys/{id}/usage", "Read a key's allowance and spend", {
  response: ref("KeyUsage"),
  description:
    "Owner only. remaining accounts for in-flight holds, the same way allowance enforcement does.",
});
route(
  "get",
  "/api/payments/currencies",
  "Discover processor payment currencies",
);
route("get", "/api/deposits", "List latest 50 invoices", {
  response: object({ data: array(ref("Deposit")) }),
});
route("post", "/api/deposits", "Create cryptocurrency deposit invoice", {
  body: object(
    {
      amount: { ...number, minimum: 5, maximum: 10000, description: "USD" },
      currency: string,
      requestId,
    },
    ["amount", "currency"],
  ),
  status: 201,
  description:
    "Use one stable requestId per invoice. Successful repeats return 200 and the original invoice. Display exact processor pay_address, pay_amount, pay_currency/network. Do not credit from a browser success state. Server verifies IPN or processor status and credits finished invoices once.",
});
route(
  "post",
  "/api/deposits/wallet",
  "Credit a stablecoin payment sent from the linked wallet",
  {
    body: object(
      {
        txHash: {
          ...string,
          pattern: "^0x[0-9a-fA-F]{64}$",
          description: "Transaction hash of the transfer",
        },
      },
      ["txHash"],
    ),
    status: 201,
    response: ref("Deposit"),
    description:
      "For the chain and token in /api/config walletPayments. The server reads the transaction and credits the sum of that token's transfers from the account's linked wallet to the payment address, at 1 token = 1 USD, once it has the configured confirmations. Returns 202 {status: waiting|confirming, confirmations, required} until then; post the same hash again. Each transaction is credited once (repeats return 200 and the same deposit). Transfers from another wallet, of another token, to another address, reverted, or older than 7 days are refused.",
  },
);
// Pay with NYMA (update "paynyma").
const nymaQuote = object({
  id: string,
  wallet: { ...string, description: "The linked wallet when the quote was made" },
  nyma: { ...string, description: "Whole NYMA to send" },
  credits: { ...number, description: "Credits that NYMA is worth at the quoted rate" },
  bonusCredits: { ...number, description: "Bonus credits on top, at bonusPercent" },
  usd: number,
  bonusPercent: number,
  usdPerNyma: number,
  created: integer,
  expires: integer,
  open: bool,
});
const nymaLimits = { usedTodayUsd: number, remainingTodayUsd: number };
route("get", "/api/nyma/rate", "The current NYMA top-up rate", {
  response: object({
    usdPerNyma: number,
    creditsPerMillion: { ...number, description: "Credits 1,000,000 NYMA are worth now, before the bonus" },
    bonus: { ...number, description: "Bonus share of credits, e.g. 0.1" },
    averageMinutes: integer,
    measuredAt: integer,
  }),
  description:
    "Read from Robinhood Chain: the lower of the NYMA/ETH and ETH/USDG pools' current values and their time-weighted averages over at least 30 minutes, rebuilt from the pools' Swap events. 503 nyma_rate_unavailable when a pool's current value is more than the allowed deviation from its average, the NYMA pool is too thin, or the chain data is missing; 503 nyma_payments_unconfigured without a wallet-payment address on chain 4663. Measured at most every 30 seconds. 240 reads an hour.",
});
route("get", "/api/nyma/quote", "Your open NYMA quote", {
  response: object({ quote: { ...nymaQuote, type: ["object", "null"] }, ...nymaLimits }),
  description: "The quote that is still open, or null, and what the 24-hour NYMA limit leaves.",
});
route("post", "/api/nyma/quote", "Ask for a NYMA top-up quote", {
  status: 201,
  body: object({ usd: { ...number, description: "Value in USD, within /api/config nymaPayments minUsd and maxUsd" } }, ["usd"]),
  response: object({ quote: nymaQuote, ...nymaLimits }),
  description:
    "Locks the current rate for 10 minutes: send `nyma` NYMA from the linked wallet to /api/config walletPayments.address. A new quote ends the open one at once. Needs a linked wallet (400 wallet_not_linked). 400 invalid_amount; 409 nyma_daily_limit past the 24-hour limit; 409 payment_reconciliation_pending while a credited payment is under reconciliation; 503 nyma_rate_unavailable. 30 quotes an hour.",
});
route("post", "/api/nyma/claim", "Credit a NYMA transfer", {
  status: 201,
  body: object(
    {
      txHash: {
        ...string,
        pattern: "^0x[0-9a-fA-F]{64}$",
        description: "Transaction hash of the NYMA transfer",
      },
    },
    ["txHash"],
  ),
  response: ref("Deposit"),
  description:
    "Reads the transaction from chain 4663 and sums its NYMA Transfer logs from the linked wallet to the payment address. Returns 202 {status: waiting|confirming, confirmations, required} until it has the configured confirmations; post the same hash again. The transfer is matched to the quote made before it: inside that quote's window it is credited at the quoted rate; after it, at the lower of the quoted and current rates. Whatever arrived is credited at that rate (less NYMA proportionally, more in full), as a deposit in currency nyma with ledger entries nyma_topup (the value) and nyma_bonus (the quote's bonus share). Each Transfer log is credited once; repeats return 200 and the same deposit. 400 payment_not_matched (another token, sender or recipient), transaction_failed, wallet_not_linked; 409 payment_already_claimed; 409 wallet_payment_review for a transfer sent before any quote, over the per-payment or 24-hour limit, or older than 7 days; 503 chain_unavailable or nyma_rate_unavailable (late transfers need a current rate). 240 checks an hour.",
});
route(
  "get",
  "/api/deposits/{id}",
  "Read invoice and refresh pending processor status",
  {
    response: ref("Deposit"),
    description:
      "If the processor is temporarily unavailable, returns the last verified saved invoice with refreshError. A processor identity mismatch is rejected. Saved status is not treated as new payment confirmation. Conflicting terminal updates pause new spending until a current authenticated processor status is checked. Confirmed reversals use append-only ledger corrections; reinstatement after a reversal requires operator confirmation.",
  },
);
route("post", "/api/payments/ipn", "NOWPayments signed callback", {
  auth: "ipn",
  body: object(
    {
      payment_id: { type: ["string", "number"] },
      order_id: string,
      payment_status: string,
      price_amount: number,
      price_currency: string,
      pay_currency: string,
    },
    ["payment_id", "payment_status"],
  ),
  response: ref("Ok"),
  description:
    "Processor-only endpoint. HMAC-SHA512 of recursively key-sorted JSON using the private IPN secret. Unknown orders are acknowledged; invalid signatures or inconsistent invoice values are rejected.",
});
route("post", "/api/support", "Send a support request to the operator inbox", {
  auth: false,
  body: object(
    {
      subject: { ...string, maxLength: 200 },
      body: { ...string, maxLength: 10000 },
      email: { ...string, format: "email", maxLength: 254 },
    },
    ["subject", "body"],
  ),
  status: 201,
  response: object({ id: string, message: string, delivery: string }),
  description:
    "Public endpoint; sign-in is optional. Reply email is required unless the signed-in account has one. Five requests per hour per account or visitor IP. Persists the ticket before SMTP delivery to the configured operator inbox. 201 with delivery=accepted means SMTP accepted the message, not verified inbox receipt. 202 with delivery=failed means saved but email failed; an operator may retry. Missing live mail configuration returns 503 without saving. Test mode saves locally and never sends email.",
});
route(
  "get",
  "/api/account/export",
  "Download account JSON with explicit monetary units",
  {
    description:
      "Authenticated account export: profile, full ledger and deposits, request accounting, video jobs, key metadata, active session dates, account-linked support tickets, media metadata, accessible conversations, spending limits (spendingLimits, null when none were set), routines (routines: each routine and its inbox runs), once Projects is released or while any exists, projects (each project's settings, the ids of the chats and SPaymposium runs fiealed in wit,h anNYMA quod its pinned files), and whether two-step sign-in is on (twoStep: { enabled }, once that update is live or while it's obillin; never its secret org recovrds (serny coaledReques),ts: metand,ata once Bookmarks is released or while any exist, bookmarks (bookmarks: id, message_id, conversation_id, nQuote, created and updated; the message text is already in its conversation). Own shared contributions remain exportable after membership removal, without other members content. Passwords, key/session secrets and hashes are excluded. Media bytes are not embedded; download before deletion. schemaVersion, exportedAt and units describe the format.",
  },
);
route("delete", "/api/account", "Close account and forfeit unused credits", {
  body: object({ confirm: { const: "DELETE" } }, ["confirm"]),
  response: ref("Ok"),
  description:
    "409 while holds or unresolved invoices exist, or while an owned collab's Team Treasury holds any credits (treasury_not_empty: withdraw or spend them first) or has team-paid requests in progress (treasury_busy). Deletes personal content, saved media files, account-linked tickets, video jobs, sessions, two-step sign-in (its secret and recovery codes) and owned collaborations. Clears profile identifiers and API-key hashes/names/prefixes. Other owners shared content, financial records and external copies remain. Retained accounting has no automatic expiry. Media removal errors prevent a success response and may require retry; deletion does not erase provider copies or existing backups.",
});
route("post", "/api/account/wipe", "Panic Wipe: erase the account's content, keep its credits", {
  body: object({ confirm: { const: "WIPE" } }, ["confirm"]),
  response: ref("Ok"),
  description:
    "Needs the wipe update released (403 feature_unreleased otherwise). 400 confirmation_required unless confirm is WIPE. 409 requests_in_flight while a request reserved on the account, or a team-paid request it started, is in progress; 409 treasury_not_empty or treasury_busy while a collab it owns has Team Treasury credits or team-paid requests (the account-closure rule). Saved media files are removed first (503 media_delete_failed stops the wipe with nothing else changed; retry). Then one transaction deletes personal conversations and messages (Symposium runs, branches, Double-checks), share links, saved media and library entries, saved uploads, video jobs, memory facts, Scrolls, standing instructions, account-linked support tickets, owned collabs with their shared conversations, membership of other collabs (their shared messages stay), every session and pending sign-in code, and connected apps' tokens and codes; it revokes every API key and connected app, overwriting deleted rows in the database file. The account, balance, ledger, deposits, request records, receipts and settings (spending limits, auto-delete, the memory switch, two-step sign-in) are unchanged. Clears the session cookie. Safe to repeat: already-removed content is skipped and revocation times are kept. 10 requests an hour. Backups, exports and provider copies are not erased.",
});
route("get", "/v1", "Free API connection check", {
  auth: null,
  description:
    "Optional Bearer key includes balance/key metadata. An absent or invalid key returns authenticated: false rather than 401. Terminal user agents receive plain text; other clients receive JSON. No credits are charged.",
});
route("get", "/v1/models", "List API-callable models", {
  auth: "bearer",
  description:
    "Returns {object: list, data: [{id, object: model, owned_by, created}]}. Includes callable chat and image entries; chat completions accepts chat models only. Use /api/models type metadata to choose a chat model. Once Early Model Access is released, a model in its first days is listed only when the key's account is at the NYMA Insider tier or above. Once the Training Labels update is released, a model whose provider says it uses what you send to improve its products carries trains_on_prompts: true, plus untrained_alternative (the id of the listed version that isn't used that way) when there is one; /api/models carries the same as trainsOnPrompts and untrainedAlternative.",
});
route("get", "/v1/balance", "API key balance", {
  auth: "bearer",
  response: object({ balance: number, available: number }),
  description:
    "Total and available displayed credits; 1000 credits = USD 1. Available excludes holds.",
});
route("post", "/v1/chat/completions", "OpenAI-style chat completion", {
  auth: "bearer",
  body: ref("ApiChatRequest"),
  response: ref("ChatCompletion"),
  description:
    "stream=true returns SSE; false/default returns JSON. Retains latest 40 usable string-content messages; array content is skipped. Maximum total text 120,000 characters; body 256 KB. Other optional parameters such as temperature, tools and response_format are ignored. Tool calling, audio, embeddings and Responses are not implemented. web_search=true or plugins: [{id: web}] requests web search and its fee. Idempotency-Key (1–200 characters) overrides requestId; repeats return 409 duplicate_request without replaying output or charging again. Missing IDs generate a new request, so transport retries without an ID can create another charge. Errors use {error: {message, code, type, param}}. 402 spending_limit (with a spending_limit object) means the account's own daily or monthly spending limit would be exceeded; it is returned before anything is reserved. Once Early Model Access is released, a model in its first days needs the key's account at the NYMA Insider tier or above: otherwise 403 early_model, with early_model: {model, opens_at}, before anything is reserved. The same applies to image, speech, transcription and video models on the /v1 media routes and the workspace routes. SSE errors may occur after HTTP 200; inspect every event through [DONE]. Timeouts and unreadable provider responses can charge the base estimate; see /docs/billing. Rate limit: 120 requests a minute per IP address, shared with the /v1 media endpoints and /mcp (429 rate_limit with Retry-After); once API Boost is released they count per account and IP address for a valid key, and NYMA holders get their tier's multiple (GET /api/account/api-limit). Final SSE usage and JSON include askr.credits_charged and anonyma.credits_charged. Once Privacy Trail is released they also carry anonyma.privacy (see PrivacyTrail): the model, provider, gateway route, retention, storage (not_saved over the API) and signed receipt id.",
});
paths["/v1/chat/completions"].post.parameters = [
  { name: "Idempotency-Key", in: "header", required: false, schema: requestId },
];
paths["/v1/chat/completions"].post.responses[200].content["text/event-stream"] =
  { schema: string };
route(
  "post",
  "/mcp",
  "Remote MCP server (Streamable HTTP, JSON-RPC 2.0)",
  {
    auth: "bearer",
    body: ref("McpRequest"),
    response: ref("McpResponse"),
    description:
      "Stateless: no Mcp-Session-Id, no SSE stream. Methods: initialize, ping, tools/list, tools/call (list_models, ask, balance). A notification (no id) is acknowledged with 202 and no body. Unknown methods return -32601; malformed input returns -32700/-32600. Same key authorization, rate limits and caps as /v1 (a connected app's requests count for the account that approved it, at that account's limit, and are never told its tier). Requires the api update released as well as mcp. Once Connect an App is live, an OAuth access token also works here (and only here): its tools report that connection's own budget, and a private-only connection lists and runs zero-data-retention models only. Once Privacy Trail is released, ask results carry structuredContent.privacy (see PrivacyTrail). A 401 then carries WWW-Authenticate resource_metadata for OAuth discovery.",
  },
);
for (const method of ["get", "delete"])
  route(method, "/mcp", "Unsupported on the stateless MCP endpoint", {
    auth: "bearer",
    description: "Always 405. Use POST.",
  });
for (const method of ["get", "delete"]) paths["/mcp"][method].responses = {
  405: {
    description: "Method not allowed",
    content: { "application/json": { schema: ref("Error") } },
  },
};
// Onchain Explainer (update "onchain"; server/onchain.js).
route("post", "/api/onchain/lookup", "Look up a transaction or address", {
  body: object(
    {
      value: {
        ...string,
        pattern: "^0x([0-9a-fA-F]{64}|[0-9a-fA-F]{40})$",
        description: "A transaction hash (0x and 64 hex) or an address (0x and 40 hex). Sent in the body so no access log records it.",
      },
      kind: { enum: ["transaction", "address"], description: "Optional; must match the value's shape" },
      chain: {
        oneOf: [{ const: "auto" }, { enum: [4663, 1, 8453, 42161, 10] }],
        default: "auto",
        description: "A chain id, or auto: Robinhood Chain, Ethereum, Base, Arbitrum, then Optimism, stopping at the first that has it (for an address, the first with any activity)",
      },
    },
    ["value"],
  ),
  response: object({
    facts: object({
      kind: { enum: ["transaction", "address"] },
      chain: object({ id: integer, name: string }),
      source: { ...string, description: "Where the facts were read" },
      hints: array(object({ code: { enum: ["unlimited_approval", "approval_for_all", "approval_to_wallet", "unverified_contract", "flagged", "new_recipient", "never_sent"] } })),
    }),
  }),
  description:
    "Free and read only: nothing is signed, sent or connected. Read on the server from fixed public sources (Robinhood Chain's JSON-RPC node; Blockscout's API for the others), so the user's IP never reaches them; no redirects, JSON only, 8 seconds and 1 MB at most, kept in memory for 60 seconds, never stored or logged. A transaction's facts: status, time, block, from/to with explorer names, the call, value, fee, token transfers, approvals and a created contract; an address's: kind, name and labels, balance, activity counts, tokens held and token details. Hints appear only when the facts show them. 400 invalid_request; 400 onchain_chain_unsupported; 404 onchain_not_found; 502 onchain_unavailable. 20 a minute and 200 an hour per account.",
});
// Seed Guard's opt-out header for API clients (server/seed-guard.js).
const seedGuardHeader = {
  name: "X-Anonyma-Seed-Guard",
  in: "header",
  required: false,
  schema: { enum: ["off"] },
  description:
    "Seed Guard: once the seedguard update is released, a request whose newest user message, system instructions, prompt or input contains a valid BIP39 seed phrase (12, 15, 18, 21 or 24 English wordlist words with a valid checksum) is refused with 400 seed_phrase_blocked before anything is reserved or sent upstream. Send off to allow it, for example for a known test mnemonic. Nothing about a match is logged or stored.",
};
for (const path of ["/v1/chat/completions", "/mcp"])
  (paths[path].post.parameters ||= []).push(seedGuardHeader);
// Connect an App: OAuth 2.1 for the MCP server (public clients, PKCE S256,
// no identity). Error bodies on /oauth/* follow RFC 6749:
// {error, error_description}.
const oauthError = object({ error: string, error_description: string });
const connection = object({
  id: string,
  name: string,
  app_name: { ...string, description: "The name the app registered with (self-reported)." },
  redirect_host: string,
  redirect_kind: { enum: ["web", "loopback", "app"] },
  created: integer,
  activated: { type: ["integer", "null"] },
  last_used: { type: ["integer", "null"] },
  private_only: bool,
  expired: bool,
  signed_in: { ...bool, description: "The app holds a current refresh token." },
  budget: number,
  spent: number,
  in_flight: number,
  remaining: number,
  expires_at: integer,
  paused: bool,
});
const authorizationRequest = object(
  {
    response_type: { const: "code" },
    client_id: string,
    redirect_uri: string,
    code_challenge: string,
    code_challenge_method: { const: "S256" },
    state: string,
    scope: string,
    resource: string,
  },
  ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method"],
);
for (const path of [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
])
  route("get", path, "OAuth protected resource metadata for /mcp (RFC 9728)", {
    auth: null,
    response: object({
      resource: string,
      authorization_servers: array(string),
      scopes_supported: array(string),
      bearer_methods_supported: array(string),
      resource_name: string,
    }),
    description: "CORS: any origin, no credentials.",
  });
route("get", "/.well-known/oauth-authorization-server", "OAuth authorization server metadata (RFC 8414)", {
  auth: null,
  description:
    "Authorization code with PKCE S256 and refresh tokens only; public clients (token_endpoint_auth_method none); scope mcp; iss in authorization responses. No OpenID Connect and no client ID metadata documents. CORS: any origin, no credentials.",
});
route("post", "/oauth/register", "Register a public OAuth client (RFC 7591)", {
  auth: null,
  body: object(
    {
      redirect_uris: {
        ...array(string),
        minItems: 1,
        maxItems: 5,
        description:
          "https, http on localhost/127.0.0.1/[::1] (any port), or a private-use app scheme. No fragments; javascript, data, file, vbscript and blob are refused.",
      },
      client_name: { ...string, maxLength: 80 },
      token_endpoint_auth_method: { const: "none" },
      grant_types: array({ enum: ["authorization_code", "refresh_token"] }),
      response_types: array({ const: "code" }),
    },
    ["redirect_uris"],
  ),
  status: 201,
  response: object({
    client_id: string,
    client_id_issued_at: integer,
    client_name: string,
    redirect_uris: array(string),
    grant_types: array(string),
    response_types: array(string),
    token_endpoint_auth_method: string,
    scope: string,
  }),
  description:
    "20 registrations per hour per IP. A client that never completes an authorization is removed after 24 hours. Errors: 400 invalid_redirect_uri or invalid_client_metadata. CORS: any origin, no credentials.",
});
route("get", "/oauth/authorize", "OAuth authorization endpoint", {
  auth: null,
  query: ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"].map((name) => ({
    name,
    in: "query",
    required: !["state", "scope", "resource"].includes(name),
    schema: string,
  })),
  description:
    "An unknown client_id or a redirect_uri that isn't exactly registered gets a 400 HTML page and is never redirected. Everything else redirects to the /connect consent page, which needs a signed-in user. Other errors are shown there, and the user can send them back to the app (error, error_description, state and iss on the redirect_uri); there is no automatic error redirect, so the endpoint can't serve as an open redirector for dynamically registered clients. resource, when sent, must be this server's /mcp URL.",
});
paths["/oauth/authorize"].get.responses = {
  302: { description: "To the consent page" },
  400: { description: "Error page (client or redirect URI can't be trusted)", content: { "text/html": { schema: string } } },
};
route("post", "/oauth/token", "OAuth token endpoint", {
  auth: null,
  body: object(
    {
      grant_type: { enum: ["authorization_code", "refresh_token"] },
      client_id: string,
      code: string,
      redirect_uri: string,
      code_verifier: string,
      refresh_token: string,
      resource: string,
    },
    ["grant_type", "client_id"],
  ),
  response: object({
    access_token: string,
    token_type: { const: "Bearer" },
    expires_in: integer,
    refresh_token: string,
    scope: string,
  }),
  description:
    "application/x-www-form-urlencoded or JSON. Codes are single use and expire after 60 seconds; reusing one revokes the tokens issued from it. Access tokens last an hour and work only on /mcp. Refresh tokens rotate on every use, never outlive the connection, and reusing a rotated one revokes the connection's tokens. Responses are no-store. Errors are RFC 6749 bodies. CORS: any origin, no credentials.",
});
paths["/oauth/token"].post.responses.default.content["application/json"].schema = oauthError;
route("post", "/oauth/revoke", "Revoke an OAuth token (RFC 7009)", {
  auth: null,
  body: object({ token: string, token_type_hint: string, client_id: string }, ["token"]),
  description:
    "Always 200 with an empty body. Revoking a refresh token ends the connection; an access token is revoked on its own. CORS: any origin, no credentials.",
});
route("get", "/api/connections/authorize", "Describe a pending app authorization for the consent page", {
  query: ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"].map((name) => ({
    name,
    in: "query",
    required: false,
    schema: string,
  })),
  response: object({
    app: object({ name: string, redirect_uri: string, redirect_host: string, redirect_kind: string }),
    defaults: object({ name: string, budget: number, expiry_days: integer, private_only: bool }),
    expiry_days: array(integer),
    max_budget: number,
    private_models: integer,
  }),
  description: "Signed in. The same checks as /oauth/authorize; any failure is a 400 and nothing is redirected. For a known client and redirect URI with another error, the 400 body also has app and return_to (the error redirect the user may follow).",
});
route("post", "/api/connections/approve", "Approve an app: create the connection and its single-use code", {
  body: object(
    {
      request: authorizationRequest,
      name: { ...string, maxLength: 60 },
      budget: { ...number, minimum: 1, maximum: 1000000, description: "Credits the app may spend." },
      expiry_days: { enum: [1, 7, 30, 90] },
      private_only: { ...bool, description: "Zero-data-retention models only. Anything but false keeps it on." },
    },
    ["request", "budget", "expiry_days"],
  ),
  response: object({ redirect: { ...string, description: "redirect_uri with code, state and iss; navigate the browser to it." } }),
  description: "Signed in, same origin. Up to 20 active connections and 30 approvals per hour.",
});
route("post", "/api/connections/deny", "Decline an app authorization", {
  body: object({ request: authorizationRequest }, ["request"]),
  response: object({ redirect: string }),
  description: "Returns redirect_uri with error=access_denied, state and iss.",
});
route("get", "/api/connections", "List connected apps", {
  response: object({ data: array(connection) }),
});
route("post", "/api/connections/{id}/pause", "Pause a connected app's spending", { response: connection });
route("post", "/api/connections/{id}/resume", "Resume a connected app", { response: connection });
route("delete", "/api/connections/{id}", "Revoke a connected app now", {
  response: ref("Ok"),
  description: "Revokes its key and deletes its access and refresh tokens at once.",
});
route("get", "/api/connections/{id}/activity", "A connected app's ledger rows (metadata only)", {
  response: object({
    data: array(
      object({
        id: string,
        created: integer,
        model: string,
        credits: number,
        receipt_id: string,
        signed: bool,
      }),
    ),
  }),
  description: "The latest 100 charges: time, model, credits and the request/receipt id. No prompts or answers are stored for a connection.",
});
// The anonyma extension on every /v1 media response.
const mediaExtension = object({
  credits_charged: number,
  request_id: string,
  signed_receipt: {
    ...ref("SignedReceipt"),
    description: "Present only when the receipts update is released.",
  },
});
const keyRefusals =
  " Every request holds its worst-case cost against the key first: a paused key (403 key_paused), an expired allowance (403 key_expired), a used-up allowance (402 allowance_exhausted), the rolling 24-hour cap (429 key_cap_exceeded) or the account's own spending limits (402 spending_limit, once Spending Limits is released) refuses it before any provider work. Idempotency-Key or requestId works as on chat completions.";
route(
  "post",
  "/v1/images/generations",
  "OpenAI-style image generation",
  {
    auth: "bearer",
    body: object(
      {
        model: string,
        prompt: { ...string, maxLength: 48000 },
        n: { ...integer, minimum: 1, maximum: 4, default: 1 },
        size: string,
        response_format: { enum: ["url", "b64_json"], default: "url" },
      },
      ["model", "prompt"],
    ),
    response: object({
      created: integer,
      data: array(object({ url: string, b64_json: string })),
      anonyma: mediaExtension,
      testMode: bool,
      partial: bool,
      warning: string,
    }),
    description:
      "Same pipeline, pricing and media store as /api/images. Choose a published size for the model; unpublished sizes are refused before any hold is created. url responses are signed and expire 24 hours after generation; b64_json inlines the bytes instead. A later batch failure (n > 1) returns the images saved so far with partial and warning, charging only delivered progress." +
      keyRefusals,
  },
);
route("post", "/v1/audio/speech", "OpenAI-style text to speech", {
  auth: "bearer",
  body: object(
    {
      model: string,
      input: { ...string, maxLength: 5000 },
      voice: string,
      response_format: { enum: ["mp3", "opus", "aac", "flac", "wav", "pcm"] },
    },
    ["model", "input"],
  ),
  response: { type: "string", format: "binary" },
  description:
    "Same per-character pricing and voice catalog as /api/audio/speech. Returns raw audio bytes with the provider's Content-Type. Since the body carries only audio, the extension travels in response headers: X-Anonyma-Credits-Charged, X-Anonyma-Request-Id, X-Anonyma-Media-Id (the saved copy expires after 24 hours) and, once receipts are released, X-Anonyma-Signed-Receipt (base64 JSON of a SignedReceipt)." +
    keyRefusals,
});
paths["/v1/audio/speech"].post.responses[200].content = {
  "application/octet-stream": { schema: { type: "string", format: "binary" } },
};
route(
  "post",
  "/v1/audio/transcriptions",
  "OpenAI-style speech to text",
  {
    auth: "bearer",
    body: object(
      {
        file: { type: "string", format: "binary" },
        model: { ...string, default: "nova-3" },
        language: string,
      },
      ["file"],
    ),
    response: object({
      text: string,
      anonyma: mediaExtension,
    }),
    description:
      "multipart/form-data upload, up to 10 MB, same limits and per-minute pricing as /api/audio/transcriptions. Holds the cost of 10 minutes and charges the transcribed duration." +
      keyRefusals,
  },
);
paths["/v1/audio/transcriptions"].post.requestBody.content = {
  "multipart/form-data": {
    schema: object(
      {
        file: { type: "string", format: "binary" },
        model: { ...string, default: "nova-3" },
        language: string,
      },
      ["file"],
    ),
  },
};
// Files intentionally implements the user_data subset, not Assistants/vector storage.
const storedFile = object({ id:string, object:{const:"file"}, bytes:integer, created_at:integer, filename:string, purpose:{const:"user_data"}, expires_at:integer, status:{const:"processed"}, anonyma:object({kind:{enum:["document","audio"]},characters:integer,truncated:bool,transcribed:{const:false}}) });
for(const [prefix,auth] of [["/api/files","session"],["/v1/files","bearer"]]) {
  route("get",prefix,"List your unexpired saved uploads",{auth,response:object({object:{const:"list"},data:array(storedFile),has_more:bool,first_id:nullableString,last_id:nullableString}),query:[{name:"limit",in:"query",schema:{type:"integer",minimum:1,maximum:50}},{name:"after",in:"query",schema:string},{name:"order",in:"query",schema:{enum:["asc","desc"]}},{name:"purpose",in:"query",schema:{const:"user_data"}}]});
  route("get",prefix+"/{id}","Retrieve owned file metadata",{auth,response:storedFile});
  route("get",prefix+"/{id}/content","Download original owned bytes",{auth,description:"Authenticated attachment download; not a public URL. Expired/deleted or other-owner IDs return 404."});
  paths[prefix+"/{id}/content"].get.responses[200].content={"application/octet-stream":{schema:{type:"string",format:"binary"}}};
  route("delete",prefix+"/{id}","Delete your saved original and extraction",{auth,response:object({id:string,object:{const:"file"},deleted:{const:true}}),description:"Does not erase copies already sent in conversations. Account deletion and expiry also delete uploads."});
}
route("post","/api/files","Explicitly save a reusable upload",{status:201,body:object({filename:string,data:{...string,description:"Base64 original bytes; up to 10 MB."},consent:{const:true},retention_seconds:{type:"integer",minimum:3600,maximum:2592000,default:604800}},["filename","data","consent"]),response:storedFile,description:"Modern Office/UTF-8 text/code and supported audio only. No automatic transcription or charge. Refuses private/ephemeral/Veil flags. Owner quota: 50 files/50 MB."});
route("get","/api/files/{id}/text","Read owned extracted document text",{response:object({name:string,text:string,chars:integer,truncated:bool}),description:"Text only, up to 100,000 extracted characters. Audio must be transcribed explicitly through the audio endpoint."});
route("post","/v1/files","Upload a user_data file (compatible subset)",{auth:"bearer",body:object(),response:storedFile,description:"Multipart file + purpose=user_data only. Optional expires_after[anchor]=created_at and expires_after[seconds] 3600–2592000; defaults to 7 days. 10 MB/file and 50 files/50 MB/owner. No Assistants, batch, fine-tuning, vector stores or automatic indexing. Personal active API keys only. Reuse document IDs in user chat content parts {type:file,file:{file_id:ID}} alongside text parts. No audio auto-transcription."});
paths["/v1/files"].post.requestBody.content={"multipart/form-data":{schema:object({file:{type:"string",format:"binary"},purpose:{const:"user_data"},"expires_after[anchor]":{const:"created_at"},"expires_after[seconds]":{type:"integer",minimum:3600,maximum:2592000}},["file","purpose"])}};
route("post", "/v1/videos", "Submit a durable video job", {
  auth: "bearer",
  body: object(
    {
      model: string,
      prompt: { ...string, maxLength: 2000 },
      aspect_ratio: string,
      duration: { type: ["string", "number"] },
      quality: string,
      image_url: string,
    },
    ["model", "prompt"],
  ),
  response: object({ id: string, status: string }),
  status: 202,
  description:
    "Same pipeline, pricing and hold as /api/videos. Choose a published variant from model pricing; image-to-video requires a public HTTPS image_url. Poll GET /v1/videos/{id}." +
    keyRefusals,
});
route("get", "/v1/videos/{id}", "Poll a submitted video job", {
  auth: "bearer",
  response: object({
    id: string,
    status: string,
    url: string,
    error: string,
    anonyma: {
      ...mediaExtension,
      description: "Present once completed and settled.",
    },
  }),
  description:
    "Owner-scoped to the API key's account. status mirrors /api/videos (submitting, pending, processing, completed, failed, reconciliation). url is a signed link, present once completed, that expires 24 hours after the job finished.",
});
for (const path of ["/v1/images/generations", "/v1/audio/speech", "/v1/videos"])
  (paths[path].post.parameters ||= []).push(seedGuardHeader);
for (const [path, summary] of [
  ["/install.sh", "POSIX CLI installer"],
  ["/install.ps1", "PowerShell CLI installer"],
  ["/cli.mjs", "Standalone CLI configured for this installation"],
  ["/llms.txt", "Short API discovery document"],
  ["/llms-full.txt", "Full build and API discovery document"],
]) {
  route("get", path, summary, { auth: null });
  paths[path].get.responses[200].content = { "text/plain": { schema: string } };
}
route("get", "/api/openapi.json", "Machine-readable frontend API contract", {
  auth: null,
});
export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Anonyma Backend API",
    version: "1.0.0",
    description:
      "Check /api/config and /roadmap for feature availability before integrating. Cookie routes must be served behind the same public origin as the frontend; no CORS is enabled. Use credentials: include and Content-Type: application/json for writes. Cookies are HttpOnly, SameSite=Lax, Secure on HTTPS. Timestamps are epoch milliseconds except OpenAI-compatible created seconds. USD 1 = 1000 displayed credits = 10000000 integer ledger subunits. Configuration is not live-service verification. Contract documents supported behavior; it is not a runtime schema validator.",
  },
  servers: [{ url: "/" }],
  paths,
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "anonyma_session" },
      bearer: { type: "http", scheme: "bearer" },
      ipn: { type: "apiKey", in: "header", name: "x-nowpayments-sig" },
    },
    schemas,
  },
};

// Publish the routes allowed by the same gate used for incoming requests.
// Body-dependent gates (code/search) still apply to individual requests.
export function openapiForConfig(cfg) {
  const enabled = isReleased(cfg, "api");
  const availablePaths = Object.fromEntries(
    Object.entries(openapi.paths).flatMap(([path, methods]) => {
      const available = Object.fromEntries(
        Object.entries(methods).filter(([method]) => {
          // Every gate, so a route that needs two updates (an allowance
          // needs api and allowances) stays unlisted until both are live.
          // Team Treasury's view and withdrawal stay reachable while it's
          // switched off only to rescue existing balances; they're listed
          // only once it's released.
          const needs = featuresFor({
            path,
            method: method.toUpperCase(),
            body: {},
          });
          if (/\/treasury(\/|$)/.test(path)) needs.push("treasury");
          // Two-Step Sign-in's sign-in step answers always, but is listed
          // only once the update is live.
          if (path === "/api/auth/two-step") needs.push("twostep");
          return needs.every((id) => isReleased(cfg, id));
        }),
      );
      return Object.keys(available).length ? [[path, available]] : [];
    }),
  );
  return {
    ...openapi,
    info: {
      ...openapi.info,
      description: `Developer API & CLI: ${enabled ? "enabled" : "Coming soon; /v1, key creation and installers return 403 feature_unreleased"}. This document lists routes enabled for this installation. Model availability and body-dependent feature gates still apply. ${openapi.info.description}`,
    },
    paths: availablePaths,
    "x-anonyma-releases": releaseInfo(cfg),
    "x-anonyma-test-mode": cfg.testMode === true,
  };
}
