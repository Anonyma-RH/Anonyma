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
    auto: {
      ...object({
        prefer: { enum: ["cheaper", "balanced", "stronger"], default: "balanced" },
        helper: { ...bool, default: true },
      }),
      description:
        "Auto Model, in place of model (sending both is 400 invalid_request; needs the automodel update released, 403 feature_unreleased otherwise): the model is chosen for this message from the models the request may use (its section, Private Mode, released, not Down, never a router), by rules first and, only when they are unsure and helper isn't false, one small helper call on the same hold. prefer moves close calls toward the fast or reasoning tier; with helper: false an unsure message goes where prefer sends it. The helper is the cheapest reviewed fast model the request may use, sent only the newest message's typed text and a few counts; a failed or unusable answer leaves the message on Balanced and costs nothing. An `auto` event before the reply and the final event's anonyma.auto carry { model, tier, reason, via, prefer, helper }. Workspace chat, code and Uncensored messages only: 400 auto_not_offered for Study, Document Compare, Sheets, Catch me up, Double-check, Symposium and task tools; 400 auto_unavailable when no model qualifies. POST /api/quote prices the same body: the chosen model's price once the rules decide, else the most it can cost (the dearest model it could land on plus the helper), which is what the chat holds.",
    },
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
    character: {
      ...string,
      description:
        "Characters: file the new saved conversation this request creates with one of your characters, and write the character's opening message as its first turn (an assistant message with no model and no charge). Needs the characters update released (403 feature_unreleased otherwise); 404 character_not_found for a character that isn't yours. Refused (400 invalid_request) with ephemeral or private, which store nothing and so are never filed, with conversationId (a saved chat keeps the character it began with) and outside the chat, code and uncensored modes. The character's instructions aren't added by the server: the workspace sends them in the leading system message, after the account's standing instructions and the project's, so Veil can mask them.",
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
        helper: {
          ...object({ model: string, provider: nullableString }),
          description: "Auto Model only: present when Auto's rules were unsure and a small model was sent the newest message's typed text to choose the tier. Its catalog id and owned_by. It was sent with the same routing as the request, so retention applies to it too.",
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
// Passkeys (update "passkeys"). WebAuthn with user verification required,
// resident (discoverable) credentials and "none" attestation. The RP ID is
// APP_ORIGIN's host and responses must come from exactly APP_ORIGIN.
const webauthnOptions = {
  type: "object",
  description: "WebAuthn options for navigator.credentials (JSON form, base64url fields). The challenge is single-use and expires after 5 minutes.",
};
const webauthnResponse = {
  type: "object",
  description: "The browser's PublicKeyCredential as JSON (base64url fields), e.g. from @simplewebauthn/browser",
};
const passkeyEntry = object({
  id: string,
  name: string,
  created: integer,
  lastUsed: { type: ["integer", "null"] },
  synced: { ...bool, description: "Backed up to a passkey manager (multi-device)" },
});
const passkeyStatus = {
  data: array(passkeyEntry),
  max: integer,
  available: { ...bool, description: "False when APP_ORIGIN is an IP address or plain HTTP other than localhost" },
  methods: object({ password: bool, email: bool, wallet: bool, passkeys: integer }),
  reauthMethods: array({ enum: ["password", "email", "wallet", "passkey"] }),
  reauthUntil: { type: ["integer", "null"] },
};
const passkeyReauth =
  " Needs this session to have confirmed it's you within the last 10 minutes (POST /api/account/two-step/reauth, or POST /api/account/passkeys/reauth), otherwise 403 passkey_reauth_required.";
const passkeyCommon =
  " 400 passkey_invalid_response for a malformed response; 400 passkey_expired for an unknown, expired or already used challenge (every challenge is deleted when answered); 401 passkey_invalid when the origin, RP ID, challenge, signature or user verification is wrong; 503 passkeys_unavailable when APP_ORIGIN can't be a WebAuthn RP.";
route("post", "/api/auth/passkey/options", "Start signing in with a passkey", {
  auth: null,
  body: object(),
  response: object({ options: webauthnOptions }),
  description:
    "Usernameless: no allowCredentials, so the browser offers any passkey for this site. Sets a short-lived HttpOnly, SameSite=Strict pending cookie (path /api/auth/passkey) that the answer must come back with. 30 per 15 minutes per IP.",
});
route("post", "/api/auth/passkey/verify", "Finish signing in with a passkey", {
  auth: null,
  body: object({ response: webauthnResponse }, ["response"]),
  response: object({ user: ref("User"), passkey: object({ name: string }) }),
  description:
    "Sets the HttpOnly session cookie. User verification is required, so this counts as both steps of Two-Step Sign-in: no code is asked. The user handle must match the passkey's account, and the sign counter must go up (0 stays allowed for synced passkeys; 401 passkey_counter otherwise). 401 passkey_unknown for a passkey this service doesn't know. Five failed answers from one passkey within 15 minutes lock it for 15 minutes (429 passkey_locked with Retry-After). 20 per 15 minutes per IP." + passkeyCommon,
});
route("post", "/api/auth/passkey/signup/options", "Start creating an account with a passkey", {
  auth: null,
  body: object({ username: { ...string, pattern: "^\\w[\\w.-]{2,31}$" } }, ["username"]),
  response: object({ options: webauthnOptions }),
  description:
    "No password and no email. The authenticator stores the username and a random user handle, never an email or wallet address. 409 when the username is taken. Sets the pending cookie. 20 an hour per IP.",
});
route("post", "/api/auth/passkey/signup/verify", "Finish creating an account with a passkey", {
  auth: null,
  body: object({ response: webauthnResponse, name: { ...string, maxLength: 40 } }, ["response"]),
  status: 201,
  response: object({ user: ref("User"), passkey: object({ name: string }) }),
  description:
    "Creates the account with the passkey as its only sign-in method and sets the session cookie. 409 when the username was taken meanwhile. Shares the password sign-up's 10 accounts an hour per IP." + passkeyCommon,
});
route("get", "/api/account/passkeys", "Your passkeys", {
  response: object(passkeyStatus),
  description: "Names, dates and whether each is synced; never credential ids or public keys.",
});
route("post", "/api/account/passkeys/reauth/options", "Start confirming it's you with a passkey", {
  body: object(),
  response: object({ options: webauthnOptions }),
  description: "Offers only this account's passkeys; bound to this session. 400 passkey_none without any. 10 per 15 minutes.",
});
route("post", "/api/account/passkeys/reauth", "Confirm it's you with a passkey", {
  body: object({ response: webauthnResponse }, ["response"]),
  response: object({ reauthUntil: integer }),
  description:
    "Marks this session, and only this session, as confirmed for 10 minutes, for adding and removing passkeys. 10 per 15 minutes." + passkeyCommon,
});
route("post", "/api/account/passkeys/options", "Start adding a passkey", {
  body: object(),
  response: object({ options: webauthnOptions }),
  description:
    "Excludes the account's existing passkeys. 409 passkey_limit at 10. 10 an hour." + passkeyReauth,
});
route("post", "/api/account/passkeys", "Add a passkey", {
  body: object({ response: webauthnResponse, name: { ...string, maxLength: 40 } }, ["response"]),
  status: 201,
  response: object({ id: string, ...passkeyStatus }),
  description:
    "Stores the credential id, public key, sign counter and name. 400 passkey_name; 400 passkey_not_discoverable when the browser reports a key that can't sign in on its own; 409 passkey_exists." + passkeyCommon + passkeyReauth,
});
route("patch", "/api/account/passkeys/{id}", "Rename a passkey", {
  body: object({ name: { ...string, maxLength: 40 } }, ["name"]),
  response: object(passkeyStatus),
  description: "1 to 40 characters. 404 passkey_not_found.",
});
route("delete", "/api/account/passkeys/{id}", "Remove a passkey", {
  response: object(passkeyStatus),
  description:
    "409 passkey_last_method when it's the account's only way to sign in (no password, email or wallet, and no other passkey). The passkey stays on the device until removed there. 404 passkey_not_found." + passkeyReauth,
});
// Recovery Kit (update "recovery"). Ten one-time codes kept only as scrypt
// digests; the username and one code start a recovery that must set a new
// password or add a passkey before any session exists.
const recoveryKitView = {
  type: ["object", "null"],
  properties: {
    created: integer,
    total: integer,
    unused: integer,
    lastUsed: { type: ["integer", "null"] },
  },
  description: "The kit, or null without one. Never a code or its digest.",
};
const recoveryKitStatus = {
  kit: recoveryKitView,
  username: { ...bool, description: "Recovering takes the username, so a kit needs one" },
  nudge: { ...bool, description: "Show the one-time nudge: no email or wallet, one kind of way in (a password, or passkeys), no kit, never dismissed" },
  reauthMethods: array({ enum: ["password", "email", "wallet", "passkey"] }),
  reauthUntil: { type: ["integer", "null"] },
};
const recoveryReauth =
  " Needs this session to have confirmed it's you within the last 10 minutes (POST /api/account/two-step/reauth, or POST /api/account/passkeys/reauth), otherwise 403 recovery_reauth_required: a stolen session can't make itself a way back in.";
const recoverySession = object({
  user: ref("User"),
  recovery: object({
    method: { enum: ["password", "passkey"] },
    codesLeft: integer,
    twoStep: { ...bool, description: "Two-Step Sign-in is still on: the next password sign-in asks for its code" },
  }),
});
const recoveryPending =
  " Needs the token from /api/auth/recovery-kit/redeem (400 recovery_expired when it's unknown, used or older than 15 minutes; the code stays spent). Sets the HttpOnly session cookie without a two-step or email code, signs out every session again and ends the recovery. API keys and connected apps keep working. 20 per 15 minutes per IP.";
route("get", "/api/account/recovery-kit", "Your recovery kit", {
  response: object(recoveryKitStatus),
});
route("post", "/api/account/recovery-kit", "Make a recovery kit", {
  body: object({ replace: { ...bool, description: "true to replace an existing kit; its codes stop working at once" } }),
  status: 201,
  response: object({
    ...recoveryKitStatus,
    codes: { ...array(string), description: "Ten codes like 7K3Q-M9XD-2HVA-PN4T-8RZC, shown only in this response" },
  }),
  description:
    "Stores each code only as a scrypt digest under a new random salt. A recovery waiting on an old code ends. 409 recovery_kit_exists without replace; 409 recovery_kit_username for an account without a username. 10 an hour." + recoveryReauth,
});
route("delete", "/api/account/recovery-kit", "Delete your recovery kit", {
  response: object(recoveryKitStatus),
  description: "Its codes stop working at once. 10 an hour." + recoveryReauth,
});
route("delete", "/api/account/recovery-kit/nudge", "Dismiss the recovery kit nudge", {
  response: object(recoveryKitStatus),
  description: "Stores only when it was dismissed; it isn't shown again.",
});
route("post", "/api/auth/recovery-kit/redeem", "Use a recovery kit code", {
  auth: null,
  body: object({ username: string, code: { ...string, description: "Case, spaces and dashes are ignored; O reads as 0, I and L as 1" } }, ["username", "code"]),
  response: object({
    recovery: object({
      token: { ...string, description: "Send with a new password or passkey within 15 minutes. Single use." },
      expires: integer,
      codesLeft: integer,
      passkey: { ...bool, description: "The account can finish by adding a passkey here" },
    }),
  }),
  description:
    "A right, unused code is spent, and every session, sign-in waiting for a two-step code, confirmation and pending email sign-in code of the account is revoked; no session starts yet. 400 recovery_code_format when it isn't a kit code (a two-step recovery code is named as such) and 400 recovery_code_typo when its check symbol is wrong: neither counts as a try. 401 recovery_invalid for an unknown username, a username without a kit or a wrong code, alike; 401 recovery_code_used for a spent code. Five tries per username and ten per IP an hour (a right code gives its try back); past that, 429 recovery_locked with Retry-After, a right code too. 20 requests an hour per IP.",
});
route("post", "/api/auth/recovery-kit/password", "Finish a recovery with a new password", {
  auth: null,
  body: object({ token: string, password: { ...string, minLength: 10, maxLength: 256 } }, ["token", "password"]),
  response: recoverySession,
  description: "400 recovery_password unless 10–256 characters." + recoveryPending,
});
route("post", "/api/auth/recovery-kit/passkey/options", "Start finishing a recovery with a passkey", {
  auth: null,
  body: object({ token: string }, ["token"]),
  response: object({ options: webauthnOptions }),
  description:
    "Passkeys' own registration options for the account, bound to this recovery. 409 passkey_limit at 10 passkeys; 503 passkeys_unavailable where passkeys can't work. Needs the passkeys update too.",
});
route("post", "/api/auth/recovery-kit/passkey", "Finish a recovery with a new passkey", {
  auth: null,
  body: object({ token: string, response: webauthnResponse, name: string }, ["token", "response"]),
  response: object({ ...recoverySession.properties, passkey: object({ name: string }) }),
  description: "Adds the passkey as Account → Security does." + passkeyCommon + recoveryPending,
});
// Privacy Screen (update "privacyscreen"): the idle lock is a screen in the
// browser; these routes only re-check it's the account's owner.
const unlockNote =
  " Never creates, rotates or ends a session. Five wrong attempts for one account within 15 minutes refuse unlocking for 15 minutes (429 unlock_locked with Retry-After); signing out always works. Only wrong attempts are counted, under a hashed key that expires on its own.";
route("get", "/api/auth/unlock", "How this account unlocks the Privacy Screen", {
  response: object({
    methods: {
      ...array({ enum: ["password", "email", "wallet", "passkey"] }),
      description: "The account's password when it has one, otherwise an email code and/or a wallet signature; and a passkey when Passkeys is released and the account has one",
    },
    retryAfter: { type: ["integer", "null"], description: "Seconds until unlocking is allowed again after too many wrong attempts; null when it is" },
  }),
});
route("post", "/api/auth/unlock/start", "Start unlocking with an email code or a wallet signature", {
  body: object({ method: { enum: ["email", "wallet"] } }, ["method"]),
  response: object({
    id: string,
    message: { ...string, description: "wallet: the one-time message to sign (it authorizes no transaction and can't be used to sign in); email: a notice" },
    testCode: { ...string, description: "Local test mode only" },
  }),
  description:
    "Only for accounts without a password (400 unlock_method otherwise). email sends a 6-digit code to the account's own address (five per address per hour, 10-minute expiry); wallet returns a message for the linked wallet. Either is bound to this session. 10 an hour." + unlockNote,
});
route("post", "/api/auth/unlock", "Unlock the Privacy Screen", {
  body: object({
    method: {
      enum: ["password", "email", "wallet", "passkey"],
      description: "passkey (needs the passkeys update too): after this session confirmed it's you with one of the account's passkeys (POST /api/account/passkeys/reauth) in the last 2 minutes; 400 unlock_expired otherwise",
    },
    password: { ...string, description: "method password" },
    id: { ...string, description: "method email or wallet: from /api/auth/unlock/start" },
    code: { ...string, description: "method email" },
    signature: { ...string, description: "method wallet: the linked wallet's signature of the message" },
  }, ["method"]),
  response: object({ ok: bool, unlocked: integer }),
  description:
    "The account's password when it has one; otherwise a fresh email code or wallet signature started by this session (400 unlock_method for another method). 401 unlock_failed for a wrong password, code or signature; 400 unlock_expired for an unknown, expired, used or other session's code or message. 30 requests per 15 minutes." + unlockNote,
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
    "Each entry includes expires (epoch ms, or null for no auto-delete). An expired-but-not-yet-purged conversation is already excluded. Once Projects is released each entry also has project_id (null when the chat is in no project); GET /api/conversations/{id} includes it for a personal chat too. Once Characters is released each entry also has character_id (null when the chat is with no character), and GET /api/conversations/{id} includes it too. Once Chat Import is released, a chat brought from an export also has imported_from (chatgpt or claude).",
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
// Push Alerts (update "pushalerts", which also needs "app").
const pushEvents = object({
  pagewatch: { ...bool, description: "A Page Watch found a change, or paused (needs Page Watch and Routines)" },
  routines: { ...bool, description: "A routine has a new result (needs Routines)" },
  lowbalance: { ...bool, description: "The settled balance dropped below the Low-Balance Alerts level (needs Low-Balance Alerts and a level)" },
  gifts: { ...bool, description: "A gift was claimed, or came back unclaimed (needs Gift Links)" },
  inactivity: { ...bool, description: "Inactivity Wipe's reminder, 7 days before the deadline (needs Inactivity Wipe on)" },
  research: { ...bool, description: "A research watch has a new briefing in the Routines inbox (needs Research Watch, Routines, Deep Research and Live Web Search)" },
});
const pushView = object({
  available: { ...bool, description: "This server has a valid VAPID key pair and contact (the same as /api/config's services.push)" },
  publicKey: { ...nullableString, description: "The VAPID public key (base64url, uncompressed P-256) to subscribe with; null when unavailable" },
  devices: array(
    object({
      id: string,
      service: { enum: ["google", "mozilla", "apple", "microsoft"] },
      tag: { ...string, description: "The first 16 hex characters of SHA-256 of the endpoint, so a page can recognise its own browser; the endpoint itself is never returned" },
      lang: { enum: ["en", "zh", "es"] },
      created: integer,
      lastSuccess: { type: ["integer", "null"], description: "When a push service last accepted a notification for it" },
      stale: { ...bool, description: "Subscribed with an older VAPID key; nothing is sent until that browser subscribes again" },
    }),
  ),
  events: { ...pushEvents, description: "Only the kinds whose updates are live. True by default." },
  lowBalanceLevel: { ...bool, description: "A Low-Balance Alerts level is set" },
  inactivityOn: { ...bool, description: "Inactivity Wipe is on" },
  max: integer,
});
route("get", "/api/push", "Your Push Alerts browsers and switches", {
  response: pushView,
  description:
    "Push Alerts sends browser notifications through Web Push, with no email. Each notification is one fixed sentence (a page watch found a change, a routine has a result, the balance is low, a gift was claimed or came back, Inactivity Wipe is 7 days away, a research watch has a new briefing, or a test) and a link to the page to open: never chat or page text, amounts or names. The push service (Google, Mozilla, Apple or Microsoft) receives only the endpoint and an encrypted, fixed-size message. Account export includes pushAlerts (each browser's push service host, dates and language, and the switches); Panic Wipe, Inactivity Wipe and closing the account delete all of it.",
});
route("post", "/api/push/subscriptions", "Turn on notifications in this browser", {
  body: object(
    {
      endpoint: { ...string, description: "PushSubscription.endpoint: https, on a known push service" },
      keys: object({ p256dh: string, auth: string }, ["p256dh", "auth"]),
      lang: { enum: ["en", "zh", "es"], description: "The language notifications are written in (default en)" },
    },
    ["endpoint", "keys"],
  ),
  status: 201,
  response: pushView,
  description:
    "Adds this browser, or refreshes it (the same endpoint). An endpoint another account had moves to this one. The response adds device, the new id. 400 push_endpoint, push_service (not Google, Mozilla, Apple or Microsoft), push_keys or push_limit (10 browsers); 503 push_unavailable without VAPID keys. 30 an hour.",
});
route("delete", "/api/push/subscriptions/{id}", "Remove a browser", {
  response: pushView,
  description: "It gets no more notifications from this account. The switches go with the last browser. 404 push_not_found.",
});
route("post", "/api/push/subscriptions/{id}/test", "Send a test notification to a browser", {
  status: 202,
  response: {
    ...pushView,
    properties: {
      ...pushView.properties,
      queued: bool,
      outcome: {
        enum: ["accepted", "pending", "gone", "stale"],
        description: "What the push service said: accepted it; didn't yet (it's retried with backoff); the subscription had ended (the browser was removed); or nothing was sent because the browser subscribed with an older key",
      },
    },
  },
  description: "Sends one test notification to that browser at once and answers with the outcome and the refreshed list. 404 push_not_found; 503 push_unavailable. 10 an hour.",
});
route("patch", "/api/push/settings", "Switch kinds of notification on or off", {
  body: pushEvents,
  response: pushView,
  description: "Omitted switches keep their value. 400 push_no_devices before any browser is subscribed, or invalid_request. 120 changes an hour.",
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
  burn: { ...bool, description: "Burn After Reading: the link opens once. Its url and path are null here: only the reply that created it has them (the server keeps only its token's SHA-256)." },
  opened: { type: ["integer", "null"], description: "Burn After Reading: when it was opened (null: not yet). Once opened, title and messages are null and nothing of the snapshot is left." },
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
      burn: { ...bool, default: false, description: "Burn After Reading (needs burnlinks released): the link opens once, with POST /api/s/{token}/open, and its snapshot or ciphertext is deleted then. The reply is the only place its url is given." },
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
    burn: { ...bool, description: "Burn After Reading: only burn and sealed are sent. A GET never opens the link; POST /api/s/{token}/open does, once." },
  }),
  description:
    "No sign-in. Rate-limited per address. Unknown, revoked, expired and deleted links (and a Burn After Reading link once opened) all return the same 404 share_not_found. Sent with X-Robots-Tag: noindex, nofollow and Referrer-Policy: no-referrer.",
});
route("post", "/api/s/{token}/open", "Open a Burn After Reading link, once (public)", {
  auth: null,
  body: object({}),
  response: object({
    title: string,
    created: integer,
    opened: { ...integer, description: "When this request opened it" },
    messages: array(sharedMessage),
    sealed: bool,
    ciphertext: { ...string, description: "Sealed: base64url IV + AES-GCM ciphertext + tag, for the page to open with the key in its link" },
  }),
  description:
    "Burn After Reading (needs burnlinks released). No sign-in; rate-limited per address. In one transaction the link is marked opened and its snapshot returned (a sealed link's ciphertext); the stored copy and title are then overwritten. Every later request, including one racing this one, gets the same 404 share_not_found as an unknown, revoked or expired link. The viewer can still copy or screenshot what they're shown.",
});
route("get", "/s/{token}", "The shared conversation page (public)", {
  auth: null,
  description: "The web app's page for a share link, with the same headers and the same 404 as /api/s/{token}. The page is the same generic app shell for every link, sealed or not: link previews never show a snapshot's title or text, and never open a Burn After Reading link.",
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
  kind: { enum: ["research"], description: "Present only on a research watch's report (see /api/research-watches)" },
  research: { type: ["object", "null"], description: "A research report's record: depth, whether it compared with the last report (previous), the sub-questions searched, what each step did and cost (status done, failed, stopped or skipped, and with Privacy Trail released the route that served it), and the total charged. Never the report itself (that is answer). A report that couldn't be written has finish_reason interrupted and a code and message, with the searches' results as its answer." },
});
route("get", "/api/routines", "Your routines", {
  response: object({ routines: array(routine), max_routines: integer, keep_runs: integer }),
  description: "Prompt routines only, oldest first (research watches are at /api/research-watches). month is this calendar month in each routine's own time zone: settled charges and open holds. 120 reads a minute.",
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
// Research Watch (update "researchwatch", which also needs "routines",
// "deepresearch" and "search"; a watch on private models needs "private").
// A watch is a routine of kind "research"; its reports are runs in the
// Routines inbox (GET /api/routines/runs, run.kind "research").
const researchWatchFields = {
  topic: { ...string, minLength: 1, maxLength: 500, description: "Sent to the model and, as sub-questions, to web search on every run, as written (Veil can't mask a scheduled run). A seed phrase is refused (400 seed_phrase_blocked)." },
  name: { ...string, maxLength: 80, description: "Defaults to the topic, shortened" },
  model: { ...string, description: "A text chat model this installation can run" },
  depth: { enum: ["quick", "thorough"], description: "3 or 6 web searches per run" },
  new_only: { ...bool, default: false, description: "Only what is new since last time: the newest finished report's key points (at most 3,000 characters, without citation numbers or addresses) are sent with the next run, as data. Deleting that report from the inbox makes the watch forget it." },
  private_only: { ...bool, default: false, description: "Needs Private Mode released. Steps route like Private Mode: zero data retention models only, never the backup gateway. Reports are still kept in the inbox." },
  schedule: object(
    {
      repeat: { enum: ["daily", "weekly"] },
      time: { ...string, pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "Wall-clock time, 24-hour HH:MM" },
      day: { ...integer, minimum: 0, maximum: 6, description: "Weekly only: 0 = Sunday … 6 = Saturday" },
      timezone: { ...string, default: "UTC", description: "IANA time zone" },
    },
    ["repeat", "time"],
  ),
  monthly_budget_credits: { ...number, exclusiveMinimum: 0, maximum: 1000000, description: "Per calendar month in the watch's time zone, at most four decimals, and at least what one run can cost (400 watch_budget_too_small)" },
  enabled: { ...bool, default: true },
};
const researchWatch = object({
  id: string,
  kind: { enum: ["research"] },
  ...researchWatchFields,
  per_run_credits: { ...number, description: "The most one run can cost, as quoted when the watch was saved. A run that would now cost more is refused (routine_run_cap) until the watch is saved again." },
  next_run_at: { type: ["integer", "null"], description: "null while off" },
  running: bool,
  last_run_at: { type: ["integer", "null"] },
  last_status: { type: ["string", "null"], enum: ["done", "refused", "failed", null] },
  month: object({ spent: number, held: number, remaining: number, resets_at: integer }),
  created: integer,
  updated: integer,
});
route("get", "/api/research-watches", "Your research watches", {
  response: object({ watches: array(researchWatch), max_watches: integer, keep_runs: integer }),
  description: "Oldest first. month is this calendar month in each watch's own time zone: settled charges and open holds. 120 reads a minute.",
});
route("post", "/api/research-watches/quote", "The most one research run can cost", {
  body: object(
    {
      model: researchWatchFields.model,
      depth: researchWatchFields.depth,
      topic: { ...string, maxLength: 500, description: "Optional; without one the quote assumes the longest topic" },
      new_only: researchWatchFields.new_only,
      private_only: researchWatchFields.private_only,
    },
    ["model", "depth"],
  ),
  response: object({
    credits: { ...number, description: "The maximum: the plan, every search with its web search fee, and the report. It is also what a run holds." },
    usd: number,
    available: number,
    spending_limit: object({ remaining: number }),
    model: string,
    depth: string,
    searches: integer,
    steps: object({ plan: number, search: { ...number, description: "Each search" }, write: number }),
    min_monthly_budget_credits: number,
    estimate: bool,
  }),
  description: "Reserves and charges nothing. The same checks as saving a watch (model, Private Mode, context allowance). Auto Model isn't offered: 400 auto_not_offered with auto. 120 quotes a minute.",
});
route("post", "/api/research-watches", "Create a research watch", {
  status: 201,
  body: object(researchWatchFields, ["topic", "model", "depth", "schedule", "monthly_budget_credits"]),
  response: researchWatch,
  description:
    "At most 5 per account (409 watch_limit), apart from the 10 prompt routines. The first run is the next slot after now; saving never runs a watch at once. Each run is Deep Research's steps (a plan, one web search per sub-question and a sourced report; every step's instructions say today's date in UTC, and with only_new the previous report's date goes with its key points), every step held at its maximum before anything runs and settled on its own usage as it finishes. It is refused, with nothing reserved or charged, when the balance, the account's spending limits, the watch's per-run maximum or what is left of the month's budget can't cover the whole run. A step whose output can't be used, or that fails, costs nothing, and the plan is charged only once a search has produced something. The report lands in the Routines inbox with its numbered sources; if the report can't be written, the inbox gets what the searches found instead, and the report step is not charged. One run at a time per watch; after downtime only the latest missed slot runs. 400 invalid_watch, invalid_schedule, invalid_model, private_model_required, watch_budget_too_small or seed_phrase_blocked. 120 changes an hour.",
});
route("patch", "/api/research-watches/{id}", "Change, switch on or switch off a research watch", {
  body: object(researchWatchFields),
  response: researchWatch,
  description: "Omitted fields keep their value. Anything but switching off re-prices the watch, so per_run_credits is what a run would hold now. A new schedule, or switching on, moves the next run to the next slot after now. A watch runs on the model chosen: 400 auto_not_offered with auto.",
});
route("delete", "/api/research-watches/{id}", "Delete a research watch and its reports", {
  response: ref("Ok"),
  description: "409 routine_running while a run is in flight. The ledger entries stay.",
});
// Page Watch (update "pagewatch", which also needs "routines"; a watch on
// private models needs "private").
const watchFields = {
  every: { enum: ["6h", "daily", "weekly"], description: "How often the server checks the page; never more often than every 6 hours" },
  hint: { type: ["string", "null"], maxLength: 300, description: "Optional \"only tell me if…\": with one, the model first says whether a change matters for it, and a report is kept only when it does. Sent as written (Veil can't mask it); a seed phrase is refused (400 seed_phrase_blocked)." },
  model: { ...string, description: "A text chat model this installation can run; it summarises the changes" },
  private_only: { ...bool, default: false, description: "Needs Private Mode released. Summaries route like Private Mode: zero data retention models only, never the backup gateway. Reports are still kept in the inbox." },
  monthly_budget_credits: { ...number, exclusiveMinimum: 0, maximum: 1000000, description: "Per calendar month (UTC), at most four decimals, and at least what one summary with the model can cost (400 watch_budget_too_small; see /api/watches/estimate)" },
  enabled: { ...bool, default: true, description: "Switching a paused watch back on resets its failure count" },
};
const pageWatch = object({
  id: string,
  url: { ...string, description: "The page, without tracking parameters. Set once: another page is another watch." },
  site: string,
  ...watchFields,
  paused: { type: ["string", "null"], enum: ["failures", "unreadable", null], description: "failures: switched off after 5 failed checks in a row; unreadable: after 3 model replies in a row that couldn't be read (choose another model)" },
  failures: { ...integer, description: "Failed checks in a row" },
  unreadable: { ...integer, description: "Model replies in a row that couldn't be read; none is charged" },
  next_check_at: { type: ["integer", "null"], description: "null while off" },
  running: bool,
  last_check_at: { type: ["integer", "null"] },
  last_status: { type: ["string", "null"], enum: ["baseline", "unchanged", "changed", "not_relevant", "refused", "failed", "unreadable", "fetch_failed", "paused", null] },
  last_code: { type: ["string", "null"] },
  last_change_at: { type: ["integer", "null"] },
  kept: { type: ["object", "null"], description: "The one version of the page kept, to spot changes: when it was taken, its size (at most 200 KB of text) and whether the page was longer. Deleting the watch deletes it." },
  month: object({ spent: number, held: number, remaining: number, resets_at: integer }),
  created: integer,
  updated: integer,
});
const watchReport = object({
  id: string,
  watch_id: string,
  url: string,
  site: string,
  checked_at: integer,
  status: { enum: ["changed", "refused", "failed", "unreadable", "paused"], description: "Only changed is ever charged. refused: nothing was reserved; failed: the request failed or timed out; unreadable: the model's reply couldn't be used (code length: it ran out of room), so its hold was released and the change is tried again at the next check; paused: 5 failed fetches or 3 unreadable replies in a row" },
  summary: { type: ["string", "null"], description: "What changed, in markdown bullet points (changed only). The page and the diff themselves are never kept." },
  model: { type: ["string", "null"] },
  private_only: bool,
  hint: { type: ["string", "null"] },
  request_id: { type: ["string", "null"] },
  credits_charged: number,
  finish_reason: { type: ["string", "null"] },
  signed_receipt: { type: ["object", "null"] },
  added: { type: ["integer", "null"], description: "Lines added" },
  removed: { type: ["integer", "null"], description: "Lines removed" },
  flagged: { ...integer, description: "Instruction-like phrases Injection Shield found in the added lines (they were sent as data)" },
  code: { type: ["string", "null"] },
  message: { type: ["string", "null"] },
  seen: bool,
});
route("get", "/api/watches", "Your page watches", {
  response: object({ watches: array(pageWatch), max_watches: integer, keep_reports: integer, every: object({}), max_failures: integer, snapshot_bytes: integer }),
  description: "Oldest first. The kept page text itself is in the account export, not here. 120 reads a minute.",
});
route("get", "/api/watches/estimate", "The most one change summary can cost", {
  query: [{ name: "model", in: "query", required: true, schema: string, description: "A chat model" }],
  response: object({ model: string, private: bool, max_credits: number, reply_tokens: integer, max_diff_chars: integer }),
  description: "The worst case with the largest set of changes a model is sent and the full reply budget; you're charged only what a summary uses. A check with no change is free.",
});
route("post", "/api/watches", "Watch a page", {
  status: 201,
  body: object({ url: { ...string, maxLength: 2048 }, ...watchFields }, ["url", "every", "model", "monthly_budget_credits"]),
  response: pageWatch,
  description:
    "Reads the page once now (free), with Link Reader's rules and errors (400 link_invalid, link_blocked, link_userinfo, link_port; 413; 415 link_type, PDFs included; 422 link_unreadable; 502; 504; 429 link_busy), and keeps its readable text to compare with. The first check is one interval later. Each check is fetched by the server (no cookies, no Referer, never your IP); when the text changed beyond whitespace, clock times and \"updated\" dates, the model gets only the changed lines with two lines of context, and the site's name, never the link. At most 20 per account (409 watch_limit); 409 watch_exists for a page you already watch. 400 invalid_watch, invalid_schedule, invalid_model, private_model_required or watch_budget_too_small. 60 changes an hour.",
});
route("patch", "/api/watches/{id}", "Change, switch on or switch off a watch", {
  body: object(watchFields),
  response: pageWatch,
  description: "Omitted fields keep their value. Switching on or a new schedule moves the next check to one interval after the last (and at least a minute from now).",
});
route("delete", "/api/watches/{id}", "Stop watching a page", {
  response: ref("Ok"),
  description: "Deletes the watch, the version of the page it kept and its reports. The ledger entries and signed receipts stay. 409 watch_running while a check is in flight.",
});
route("get", "/api/watches/reports", "Page Watch's part of the Routines inbox", {
  query: [
    { name: "watch", in: "query", required: false, schema: string, description: "Only this watch's reports" },
    { name: "before", in: "query", required: false, schema: integer, description: "Only reports checked before this time, for the next page" },
  ],
  response: object({ reports: array(watchReport), more: bool }),
  description: "Newest first, 50 at a time. Each watch keeps its newest 50 reports. A change that didn't match a watch's hint, or a check that found nothing, adds none.",
});
route("delete", "/api/watches/reports/{id}", "Delete one report", {
  response: ref("Ok"),
  description: "The ledger entry and signed receipt stay.",
});
route("get", "/api/watches/unseen", "Reports not seen yet", {
  response: object({ count: integer }),
  description: "For the workspace badge.",
});
route("post", "/api/watches/seen", "Mark reports as seen", {
  body: object({ before: { ...integer, description: "Only reports checked at or before this time" } }),
  response: ref("Ok"),
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
// Characters (update "characters"; a default model in the Uncensored section
// also needs "uncensored").
const characterChat = object({
  id: string,
  title: string,
  mode: string,
  created: integer,
  updated: integer,
  expires: { type: ["integer", "null"] },
});
const characterFields = {
  name: { ...string, minLength: 1, maxLength: 60 },
  description: { ...string, maxLength: 200, default: "" },
  instructions: {
    ...string,
    maxLength: 4000,
    default: "",
    description:
      "The personality. Sent by the workspace with every chat with the character, after the account's standing instructions and the project's, as part of the leading system message; Veil masks them in the browser. Once Seed Guard is released a wallet seed phrase is refused (400 seed_phrase_blocked), with no override.",
  },
  opening: {
    ...string,
    maxLength: 1000,
    default: "",
    description:
      "The first message of a chat with the character. It is shown as the first assistant turn and written once as a saved chat's first message, with no model and no charge; it is never sent to a model as a reply, and the model is told about it in the character's instructions instead.",
  },
  model: { type: ["string", "null"], description: "A default chat model id the account can use, or null for none. A model in the Uncensored section also needs that update released (403 feature_unreleased otherwise)." },
  avatar: {
    type: ["string", "null"],
    description:
      'null, "mono:<colour>" (cobalt, navy, amber, ink, slate or mist) or a data URL of a PNG, JPEG or WebP picture of at most 256 by 256 pixels and 48 KB. The server reads the bytes, removes every hidden detail (EXIF, text, XMP, comments, timestamps) and refuses anything else (400 invalid_avatar).',
  },
};
const character = object({
  id: string,
  name: string,
  description: string,
  instructions: string,
  opening: string,
  model: { type: ["string", "null"] },
  avatar: { type: ["string", "null"] },
  chat_count: integer,
  created: integer,
  updated: integer,
});
const characterDetail = {
  ...character,
  properties: { ...character.properties, chats: array(characterChat) },
};
const characterShare = object({
  id: string,
  character_id: string,
  url: { ...string, description: "The copy link. Its token sits after the #, so it never reaches a server log or a referrer." },
  created: integer,
  expires: integer,
});
route("get", "/api/characters", "Your characters", {
  response: object({ characters: array(character), max_characters: integer, limits: object() }),
  description: "Oldest first. Private to the account: there is no public list.",
});
route("post", "/api/characters", "Make a character", {
  status: 201,
  body: object(characterFields, ["name"]),
  response: characterDetail,
  description:
    "At most 50 per account (409 character_limit). 400 invalid_character, invalid_model or invalid_avatar. 240 changes an hour.",
});
route("get", "/api/characters/{id}", "A character with its saved chats", {
  response: characterDetail,
  description: "404 character_not_found for a character that isn't yours.",
});
route("patch", "/api/characters/{id}", "Change a character", {
  body: object(characterFields),
  response: characterDetail,
  description: "Omitted fields keep their value. A change applies to the next message, in chats already begun too.",
});
route("delete", "/api/characters/{id}", "Delete a character", {
  response: ref("Ok"),
  description: "Its chats stay saved, as plain chats. Its copy links stop working.",
});
route("post", "/api/characters/{id}/duplicate", "Duplicate a character", {
  status: 201,
  response: characterDetail,
  description: 'The same fields, named "… (copy)". No chats and no links come with it.',
});
route("get", "/api/characters/{id}/shares", "A character's copy links", {
  response: object({ data: array(characterShare), limits: object() }),
  description: "Live links only, newest first.",
});
route("post", "/api/characters/{id}/shares", "Share a copy", {
  status: 201,
  body: object({ expires_in_days: { enum: [1, 7, 30], default: 30 } }),
  response: characterShare,
  description:
    "Makes a link another signed-in account can use to add a copy of the character as it is now: name, description, instructions, opening message, default model and picture, with no chats and nothing about you. Revocable, and it expires (30 days unless expires_in_days says 1 or 7). Up to 20 active links per account and 5 per character (400 share_limit). Once Seed Guard is released, a character holding a seed phrase or private key is refused (400 seed_phrase_blocked).",
});
route("delete", "/api/character-shares/{id}", "Revoke a copy link", {
  response: ref("Ok"),
  description: "The link stops working at once and its copy is deleted.",
});
route("get", "/api/character-shares/{token}", "Read a copy link", {
  response: object({
    name: string,
    description: string,
    instructions: string,
    opening: string,
    avatar: { type: ["string", "null"] },
    model: { type: ["string", "null"] },
    model_name: { type: ["string", "null"] },
    model_available: bool,
    created: integer,
    expires: integer,
  }),
  description:
    "For a signed-in account to read the whole character, instructions included, before adding a copy. 404 share_not_found looks the same for an unknown, revoked, expired or deleted link. Never cached or indexed; nothing about the account that made it.",
});
route("post", "/api/character-shares/{token}/import", "Add a copy of a shared character", {
  status: 201,
  body: object({
    instructions: { ...string, description: "The copy's instructions with Secret Guard's placeholders (like [SECRET_1]) in place of passwords, keys or tokens. Leave out to keep them as shared." },
    opening: { ...string, description: "The copy's opening message, masked the same way. Leave out to keep it as shared." },
  }),
  response: { ...characterDetail, properties: { ...characterDetail.properties, model_kept: bool } },
  description:
    "Adds the character as a new one on this account. A default model this account can't run isn't carried over (model_kept is false). 409 character_limit at 50 characters; Seed Guard applies again.",
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
// Chat Import (update "chatimport"): the account destination.
const importSource = { enum: ["chatgpt", "claude"] };
route("get", "/api/import/status", "Chat Import: what the account can take", {
  response: object({
    cap: { ...integer, description: "Saved personal chats the account keeps (300; 600 at the Holder tier)" },
    have: { ...integer, description: "Saved personal chats it holds now" },
    room: { ...integer, description: "cap minus have: chats an import can still save" },
    retention_days: { type: ["integer", "null"], description: "The account's auto-delete default, which applies to imported chats too; null for none" },
    seed_guard: { ...bool, description: "Whether Seed Guard is live, so chats holding a seed phrase are held back" },
    limits: object({
      chats_per_request: integer,
      messages_per_chat: integer,
      message_chars: integer,
      chat_chars: integer,
      request_chars: integer,
    }),
    imported: object({ chatgpt: array(string), claude: array(string) }),
  }),
  description:
    "Which chats were already imported, by the id their export gave them (so the same chat isn't imported twice), and how much room is left. The export itself is read in the browser; nothing about it is uploaded until POST /api/import/chats.",
});
route("post", "/api/import/chats", "Chat Import: save chosen chats to the account", {
  body: object(
    {
      source: importSource,
      chats: {
        ...array(
          object(
            {
              source_id: { ...string, maxLength: 100, description: "The id the export gave the conversation; used only to notice a repeat" },
              title: { ...string, maxLength: 200, description: "Shortened to 70 characters" },
              created: { ...integer, description: "Epoch milliseconds" },
              updated: { ...integer, description: "Epoch milliseconds" },
              messages: {
                ...array(
                  object(
                    {
                      role: { enum: ["user", "assistant"] },
                      text: { ...string, maxLength: 200000 },
                      created: { ...integer, description: "Epoch milliseconds; never later than now" },
                    },
                    ["role", "text"],
                  ),
                ),
                maxItems: 4000,
              },
              allow_seed_phrase: { ...bool, description: "Seed Guard: send true only for a chat the person confirmed twice they want saved despite a seed phrase or private key in it" },
            },
            ["messages"],
          ),
        ),
        minItems: 1,
        maxItems: 20,
      },
    },
    ["source", "chats"],
  ),
  response: object({
    saved: array(object({ index: integer, id: string }, ["index", "id"])),
    skipped: array(
      object(
        {
          index: integer,
          reason: { enum: ["already_imported", "seed_phrase_blocked", "too_large", "empty", "invalid", "conversation_limit"] },
        },
        ["index", "reason"],
      ),
    ),
    room: { ...integer, description: "Chats the account can still keep" },
  }),
  description:
    "Each saved chat becomes an ordinary saved conversation marked as imported (Chat, no model, no charge) and is listed, searched, exported and erased like any other, with the account's auto-delete default applied. A chat is skipped rather than failing the request: already_imported (its export id was imported before), seed_phrase_blocked (Seed Guard is live and it holds a valid seed phrase or private key, unless allow_seed_phrase), too_large (over 4,000 messages, 200,000 characters in a message or 2,000,000 in the chat), empty, invalid, or conversation_limit (the cap is never pruned by an import). At most 20 chats and 4,000,000 characters per request (413 import_too_large). Nothing about titles, text or ids is logged.",
});
// Encrypted Backup (update "backup"): the file is made and opened in the
// browser; these routes hand over the account's own content, keep the day
// of the last backup, and take back what a restore chose.
const backupDay = { type: ["string", "null"], description: "YYYY-MM-DD (UTC), or null before the first backup" };
const backupState = {
  last_backup: backupDay,
  reminder: { ...bool, description: "Whether the one reminder is due: 30 days after the last backup, until seen" },
};
const backupSkip = (reasons) =>
  array(object({ index: integer, reason: { enum: reasons } }, ["index", "reason"]));
route("get", "/api/account/backup", "Encrypted Backup: the last backup and what a backup would hold", {
  response: object({
    ...backupState,
    counts: object({
      chats: integer,
      bookmarks: integer,
      projects: integer,
      scrolls: integer,
      instructions: { ...integer, description: "1 when standing instructions are saved" },
      memory: integer,
      routines: integer,
      research: integer,
      watches: integer,
      characters: { ...integer, description: "0 until Characters is live" },
      subtitles: { ...integer, description: "Saved subtitle sets; 0 until Subtitles is live" },
    }),
    seed_guard: { ...bool, description: "Whether Seed Guard is live, so a restore holds back items with a seed phrase or private key" },
  }),
  description: "Counts only. The backup file is made in the browser; the server never receives it, its passphrase or its key.",
});
route("get", "/api/account/backup/content", "Encrypted Backup: everything but the chats", {
  response: object({
    projects: array(object({ id: string, name: string, color: string, instructions: string, starts: string, model: nullableString, created: integer })),
    scrolls: array(object({ title: string, body: string, created: integer })),
    instructions: { type: ["object", "null"], properties: { body: string, enabled: bool } },
    memory: array(object({ text: string, enabled: bool, created: integer })),
    routines: array(object({ name: string, prompt: string, model: string, web_search: bool, private_only: bool, schedule: object(), per_run_credits: number, monthly_budget_credits: number, created: integer })),
    research: array(object({ name: string, topic: string, model: string, depth: string, new_only: bool, private_only: bool, schedule: object(), monthly_budget_credits: number, created: integer })),
    watches: array(object({ url: string, hint: nullableString, model: string, private_only: bool, every: string, monthly_budget_credits: number, created: integer })),
    bookmarks: array(object({ message_id: string, conversation_id: string, note: string, created: integer })),
    characters: {
      ...array(object({ name: string, description: string, instructions: string, opening: string, model: nullableString, avatar: nullableString, created: integer })),
      description: "Once Characters is live: each with its picture (a monogram id or a small image data URL), never its copy links or chats",
    },
    subtitles: {
      ...array(object({ title: string, duration: number, language: string, tracks: array(object({ lang: string, source: bool, cues: array(object({ start: number, end: number, text: string })) })), created: integer })),
      description: "Once Subtitles is live: saved subtitle sets, their cues and times, never a video or its sound",
    },
  }),
  description: "Routines and watches are their settings only, never their results or the pages they read. Bookmarks point at messages in the account's own saved chats. Burn After Reading links are never included.",
});
route("get", "/api/account/backup/chats", "Encrypted Backup: saved chats, a page at a time", {
  query: [{ name: "after", in: "query", schema: integer, description: "The previous page's next value" }],
  response: object({
    chats: array(
      object({
        id: string,
        title: string,
        mode: { ...string, description: "chat, code, uncensored or symposium: where the chat opens" },
        created: integer,
        updated: integer,
        project: nullableString,
        messages: array(object({ id: string, role: { enum: ["user", "assistant"] }, text: string, model: nullableString, created: integer })),
      }),
    ),
    next: { type: ["integer", "null"], description: "Pass as after for the next page; null at the end" },
  }),
  description: "The account's own saved personal chats (not shared team chats), up to 25 a page and about 8 MB of words. Each message is its words; images and files are left out.",
});
route("post", "/api/account/backup/made", "Encrypted Backup: note that a backup was saved today", {
  body: object({ day: { ...string, description: "The browser's own day, YYYY-MM-DD; used when it's within a day of the server's, else the server's UTC day" } }),
  response: object(backupState),
  description: "Keeps only today's date (UTC), and starts the 30-day reminder over. Nothing about the file is sent.",
});
route("post", "/api/account/backup/reminder", "Encrypted Backup: the reminder was seen", {
  response: object(backupState),
});
route("post", "/api/account/backup/restore/chats", "Encrypted Backup: restore chosen chats", {
  body: object(
    {
      chats: {
        ...array(
          object(
            {
              title: { ...string, maxLength: 200 },
              created: integer,
              updated: integer,
              project: { ...string, description: "A project of this account to file the chat in (needs Projects)" },
              mode: { ...string, maxLength: 40, description: "The mode it was saved in; kept when this server has that mode's update live (code, uncensored, symposium), else saved as an ordinary chat and reported as mode_fallback" },
              messages: {
                ...array(
                  object(
                    {
                      role: { enum: ["user", "assistant"] },
                      text: { ...string, maxLength: 200000 },
                      created: integer,
                      model: { ...string, maxLength: 200, description: "The model that wrote a reply" },
                      bookmark: { ...string, maxLength: 140, description: "A bookmark's note on this message (needs Bookmarks)" },
                    },
                    ["role", "text"],
                  ),
                ),
                maxItems: 4000,
              },
              allow_seed_phrase: { ...bool, description: "Seed Guard: true only for a chat the person confirmed they want restored despite a seed phrase or private key in it" },
            },
            ["messages"],
          ),
        ),
        minItems: 1,
        maxItems: 20,
      },
    },
    ["chats"],
  ),
  response: object({
    saved: array(
      object(
        {
          index: integer,
          id: string,
          mode: { ...string, description: "The mode it was saved in here" },
          mode_fallback: { ...string, description: "The mode it asked for, when that isn't available here and it was saved as an ordinary chat" },
          project: string,
          bookmarks: integer,
        },
        ["index", "id", "mode"],
      ),
    ),
    skipped: backupSkip(["duplicate", "seed_phrase_blocked", "too_large", "empty", "invalid", "conversation_limit"]),
    room: integer,
  }),
  description:
    "Each chat is checked and saved the way Chat Import saves one, marked as restored, with the account's auto-delete default, in the mode it was saved in when that mode's update is live here (else as an ordinary chat, reported as mode_fallback). Symposium runs fill the Symposium cap. A restore adds and never replaces: duplicate (its words are already in the account), seed_phrase_blocked, too_large, empty, invalid and conversation_limit (the cap is never pruned) are skipped, not refused. At most 20 chats and 4,000,000 characters per request (413 import_too_large). Nothing about titles, words or hashes is logged.",
});
route("post", "/api/account/backup/restore/scrolls", "Encrypted Backup: restore chosen scrolls", {
  body: object(
    {
      scrolls: {
        ...array(object({ title: { ...string, maxLength: 80 }, body: { ...string, maxLength: 8000 }, created: integer, allow_seed_phrase: bool }, ["title", "body"])),
        minItems: 1,
        maxItems: 100,
      },
    },
    ["scrolls"],
  ),
  response: object({
    saved: array(object({ index: integer, id: string }, ["index", "id"])),
    skipped: backupSkip(["duplicate", "seed_phrase_blocked", "invalid", "scroll_limit"]),
  }),
  description: "Scrolls keep the limits of saving one (80-character title, 8,000-character body, 200 per account). Needs Scrolls.",
});
// Vault Sync (update "vaultsync", which also needs "vault"): Device Vault's
// end-to-end-encrypted sync. The browser seals every chat before it's sent.
const vaultSyncBox = object({ iv: { ...string, description: "Vault Sync: base64 of the 12-byte AES-GCM IV" }, ct: { ...string, description: "Vault Sync: base64 of the AES-GCM ciphertext and tag" } }, ["iv", "ct"]);
const vaultSyncSettings = object({
  id: { ...string, description: "The synced vault's random id (Vault Sync)" },
  kdf: object({ name: { enum: ["PBKDF2"] }, hash: { enum: ["SHA-256"] }, iterations: { ...integer, minimum: 600000, maximum: 10000000 }, salt: { ...string, description: "Base64, 16–64 bytes; not secret" } }),
  verifier: { ...vaultSyncBox, description: "Vault Sync: a fixed text sealed with the vault key, so a device can tell a wrong passphrase" },
  created: integer,
  updated: integer,
  records: { ...integer, description: "Synced chats" },
  tombstones: { ...integer, description: "Deleted chats' markers" },
  bytes: { ...integer, description: "Ciphertext stored (IV and ciphertext bytes)" },
  cursor: { ...integer, description: "The newest change's position" },
});
const vaultSyncLimits = object({ bytes: integer, recordBytes: integer, records: integer });
const vaultSyncRecord = object({
  id: string,
  version: integer,
  deleted: bool,
  size: integer,
  updated: integer,
  iv: { ...string, description: "Vault Sync: absent on a tombstone" },
  ct: { ...string, description: "Vault Sync: absent on a tombstone" },
});
const vaultSyncStats = object({ records: integer, bytes: integer });
route("get", "/api/vault-sync", "Your synced vault (Vault Sync)", {
  response: object({ vault: { oneOf: [vaultSyncSettings, { type: "null" }] }, limits: vaultSyncLimits }),
  description:
    "Vault Sync: the synced vault's settings (salt, iteration count and sealed verifier, none of them secret) and how much is stored, or null when this account doesn't sync one. 600 reads per 10 minutes, shared with pulls.",
});
route("post", "/api/vault-sync", "Turn on Vault Sync", {
  status: 201,
  body: object({ kdf: object({ name: { enum: ["PBKDF2"] }, hash: { enum: ["SHA-256"] }, iterations: integer, salt: string }, ["name", "hash", "iterations", "salt"]), verifier: vaultSyncBox }, ["kdf", "verifier"]),
  response: object({ vault: vaultSyncSettings, limits: vaultSyncLimits }),
  description:
    "Vault Sync: makes this vault the account's synced vault. Only the salt, iteration count and verifier are sent: never the passphrase or the key. Any other field is refused (400 invalid_request). One per account: 409 vault_sync_exists when one is already synced. 30 changes an hour, shared with DELETE.",
});
route("delete", "/api/vault-sync", "Forget the synced copy (Vault Sync)", {
  response: object({ ok: bool, forgotten: bool }),
  description:
    "Vault Sync: deletes every synced record, tombstone and the settings, overwritten in the database file. Devices keep their own vaults and stop syncing when they next check. Backups are separate copies; without the passphrase they can't be read. Account closure and Panic Wipe do the same.",
});
route("get", "/api/vault-sync/records", "Pull synced changes (Vault Sync)", {
  query: [
    { name: "vault", in: "query", required: true, schema: string, description: "Vault Sync: the synced vault's id (409 vault_sync_changed when it was replaced; 404 vault_sync_missing when there is none)" },
    { name: "since", in: "query", required: false, schema: { ...integer, minimum: 0, default: 0 }, description: "The cursor from the last pull" },
    { name: "limit", in: "query", required: false, schema: { ...integer, minimum: 1, maximum: 500, default: 200 } },
  ],
  response: object({ vault: string, records: array(vaultSyncRecord), cursor: integer, more: bool, stats: vaultSyncStats }),
  description: "Vault Sync: records changed after since, oldest change first, tombstones included. Start the next pull at cursor while more is true.",
});
route("post", "/api/vault-sync/records", "Push sealed changes (Vault Sync)", {
  body: object(
    {
      vault: { ...string, description: "Vault Sync: the synced vault's id (409 vault_sync_changed when it was replaced)" },
      records: array({
        oneOf: [
          object({ id: string, base: integer, iv: string, ct: string }, ["id", "base", "iv", "ct"]),
          object({ id: string, base: integer, deleted: { enum: [true] } }, ["id", "base", "deleted"]),
        ],
      }),
    },
    ["vault", "records"], // Vault Sync
  ),
  response: object({
    results: array(object({ id: string, version: integer, conflict: vaultSyncRecord, error: { enum: ["too_large", "storage_full", "record_limit"] } })),
    cursor: integer,
    stats: vaultSyncStats,
  }),
  description:
    "Vault Sync: 1–100 sealed records (at most 8 MB of IV and ciphertext bytes), each naming the version it was based on (0 for a new one). Ids are random: letters, digits, - and _, up to 100. A record whose base is stale comes back as conflict with the current record, to merge in the browser; the rest get their new version. Per account: 50 MB of ciphertext, 4 MB per record, 5,000 chats. Only id, base, iv and ct (or id, base and deleted: true) are accepted: anything else refuses the whole request (400 invalid_request) and nothing is written. 240 pushes per 10 minutes.",
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
// Repo Reader (update "reporeader"). Asking is an /api/chat request (and
// /api/quote estimate) carrying `repo`, described on POST
// /api/repos/{id}/excerpts below.
const repoSummary = {
  id: string,
  repo: { ...string, description: "owner/name" },
  ref: { ...nullableString, description: "The branch, tag or commit from a /tree/ link; null for the default branch" },
  commit: { ...nullableString, description: "The commit the archive was made from, when GitHub says" },
  url: string,
  file_count: { ...integer, description: "Text files kept (at most 5,000)" },
  text_bytes: integer,
  skipped: object({
    vendored: { ...integer, description: "Files in vendored, build and tool folders (node_modules, vendor, dist, build, ...)" },
    generated: { ...integer, description: "Lock files, minified files and source maps" },
    binary: { ...integer, description: "By extension, a NUL byte or invalid UTF-8" },
    large: { ...integer, description: "Files over 256 KB" },
    links: { ...integer, description: "Symbolic and hard links, never followed" },
    unsafe: { ...integer, description: "Absolute or traversing paths, control characters, or outside the archive's folder" },
    other: { ...integer, description: "Devices, FIFOs and unknown entry types" },
    limit: { ...integer, description: "Past 5,000 files or 8 MB of text" },
  }),
  skipped_dirs: { ...array(string), description: "Up to 12 of the vendored or build folders skipped" },
  truncated: { ...bool, description: "The file or text limit was reached, so some files weren't read" },
  hidden_removed: { ...integer, description: "Injection Shield's invisible characters taken out of the text" },
  read_at: integer,
  forgotten_at: { ...integer, description: "When the cache drops it: 30 minutes after it was read" },
  forgotten_in: { ...integer, description: "Milliseconds until then, by the server's clock" },
};
const repoView = object({
  ...repoSummary,
  files: array(object({ path: string, lines: integer, bytes: integer })),
  cached: { ...bool, description: "Already open for this account, so it wasn't fetched again (POST only)" },
});
const repoSnippet = object({
  path: string,
  start: { ...integer, minimum: 1 },
  end: integer,
  text: { ...string, maxLength: 16000, description: "Lines start to end, exactly (end - start + 1 lines), unnumbered" },
});
route("post", "/api/repos", "Read a public GitHub repo", {
  body: object(
    { url: { ...string, maxLength: 2048, description: "https://github.com/<owner>/<repo>, optionally /tree/<branch, tag or commit>" } },
    ["url"],
  ),
  status: 201,
  response: repoView,
  description:
    "The server downloads the repo's tarball from codeload.github.com (GitHub sees this server, never your browser or IP: no token, no cookies, a generic User-Agent) through Link Reader's SSRF-safe fetcher in host allowlist mode: every hop, redirects included, must be https on codeload.github.com, and every address it resolves to must be public. 50 MB (413 repo_too_large), 30 seconds (504 repo_timeout). Unpacked in memory, never on disk: more than 300 MB unpacked (413 repo_unpacked_too_large), more than 60,000 entries (413 repo_too_many_entries) or a damaged archive (422 repo_corrupt) is refused whole; links, unsafe paths, vendored and build folders, lock and minified files, binaries and files over 256 KB are skipped and counted; 5,000 files and 8 MB of text at most. Public repos only: a private or missing repo, branch or tag is 404 repo_not_found. Other refusals: 400 repo_url; 422 repo_no_text; 502 repo_unavailable, repo_unreachable, repo_redirect, repo_not_archive; 429 repo_busy (one at a time) or rate_limit (20 an hour; a mistyped link or a repo already open doesn't count). Free. Kept in this server's memory for this account for 30 minutes, 3 repos at most, then forgotten; never logged or stored. All accounts share a 128 MB memory budget: the least recently used repo is forgotten first when it's full, and a read that can't fit even then is 503 repo_cache_full (“Busy, try again in a moment.”). Returned as it is, with cached: true, when the same repo and ref are already open.",
});
route("get", "/api/repos", "Repos open now", {
  response: object({ data: array(object(repoSummary)), limit: { ...integer, description: "Repos open at once (3)" } }),
  description: "Newest first. Only this account's, and only for 30 minutes after each was read.",
});
route("get", "/api/repos/{id}", "One open repo and its files", {
  response: repoView,
  description: "404 repo_gone once it's forgotten (30 minutes after it was read, or after DELETE).",
});
route("get", "/api/repos/{id}/file", "One file's text", {
  query: [{ name: "path", in: "query", required: true, schema: string }],
  response: object({ path: string, lines: integer, bytes: integer, text: string }),
  description: "A file that was kept, as read (invisible characters removed). 404 repo_file_not_found or repo_gone.",
});
route("post", "/api/repos/{id}/excerpts", "The excerpts a question would send", {
  body: object({ question: { ...string, maxLength: 2000 } }, ["question"]),
  response: object({
    repo: object({
      repo: string,
      ref: nullableString,
      commit: nullableString,
      question: string,
      list: { ...array(string), description: "Up to 300 paths (6,000 characters) sent as the file list, shallow first" },
      total_files: integer,
      snippets: { ...array(repoSnippet), maxItems: 8 },
    }),
    flagged: { ...array(bool), description: "Per excerpt: Injection Shield found text that reads like instructions to an AI (it's sent as data either way)" },
    whole: { ...array(bool), description: "Per excerpt: the whole file (the top one or two source files go whole when they're 300 lines or less and fit)" },
    fallback: { ...bool, description: "No term matched, so the README and top-level manifest were chosen" },
  }),
  description:
    "Free; nothing is sent to a model. The question's terms are ranked against the files (BM25 over 40-line chunks, plus path and file-name matches): up to 8 excerpts, 3 from one file, 28,000 characters; the top one or two source files (not docs) go whole when they're 300 lines or less and fit. Asking is then POST /api/chat with ephemeral: true and repo: this `repo` object (the question may be masked by Veil; the rest as returned), and optionally private: true. The server numbers each excerpt's lines and builds the messages: a fixed system prompt, the question, the file list and the excerpts as escaped document blocks with Injection Shield's data notice (400 invalid_repo for a malformed payload, more than 44,000 characters, or one combined with other chat options: a conversation, project, memory, web search, Auto, another task or Seed Guard's override). A seed phrase in the question is refused (400 seed_phrase_blocked, no override); the excerpts aren't scanned. The answer budget is 8,000 tokens, lowered to the model's limits (400 repo_too_long when its context leaves under 2,000). POST /api/quote prices the same body, and the request holds exactly that price; an empty reply is released and charges nothing. Nothing about the question is stored.",
});
route("delete", "/api/repos/{id}", "Forget an open repo now", {
  response: object({ ok: bool }),
  description: "Drops it from the cache at once. 404 repo_gone when it isn't open.",
});
// Blind Compare (update "blind").
const blindSide = object({
  model: string,
  name: string,
  credits: { ...number, description: "What this reply was charged" },
  ms: { type: ["integer", "null"], description: "Milliseconds from sending to the last word" },
  request_id: { type: ["string", "null"], description: "This side's request id (its receipt, once Signed Receipts is released)" },
  privacy: { type: "object", description: "This side's Privacy Trail, once released" },
});
const blindReveal = object({
  outcome: { enum: ["a", "b", "tie", "bad", null], description: "null when a side failed, so the round was revealed without a vote" },
  a: blindSide,
  b: blindSide,
});
route("post", "/api/blind", "Compare two models' replies, names hidden", {
  body: object(
    {
      models: { ...array(string), minItems: 2, maxItems: 2, description: "Two different chat models; the order shown (A, B) is random" },
      messages: array(message),
      max_tokens: { ...integer, minimum: 1, description: "Each side's reply budget, checked against both models" },
      requestId: { ...requestId, maxLength: 190, description: "Each side runs as <requestId>:a and <requestId>:b" },
      conversationId: string,
      mode: { enum: ["chat", "code", "uncensored"] },
      ephemeral: bool,
      private: { ...bool, description: "Both models must be private (zero data retention)" },
      project: string,
      veil_masked: { type: ["integer", "null"] },
      allow_seed_phrase: bool,
    },
    ["models", "messages"],
  ),
  stream: true,
  description:
    "Always SSE via fetch POST. Each side is a chat request on the same hold/settle path as /api/chat (balance, Spending Limits, failure billing and receipts apply per side), and neither is sent until both are reserved: a side that is refused (402 insufficient_credits, 402 spending_limit, a validation error) releases the other, and the whole request fails before any stream starts, charging nothing. Events: { blind: { conversationId } } first; { side, delta: { content?, reasoning? } } while replying; { side, status: done|failed|stopped, error? } as each side ends; then { blind: { done: true, conversationId, message_id, credits_charged (both sides together), round, reveal, sides } } and [DONE]. No event names a model or a side's own charge before the vote: round is a sealed token for POST /api/blind/votes. A side that fails is charged by the usual failure policies and only it; such a round is revealed at once (reveal) and can't be voted on. Web search (400 blind_unsupported), Memory, Team pays and shared collab conversations are not supported. A saved chat stores the question and one reply holding both answers (and the reveal once voted); off-the-record and Private rounds store nothing. 400 blind_same_model, 400 private_model_required.",
});
route("post", "/api/blind/votes", "Vote on a blind round, then reveal it", {
  body: object(
    {
      round: { ...string, description: "The round token from the final /api/blind event (or a saved reply's blind.token)" },
      outcome: { enum: ["a", "b", "tie", "bad"] },
      message_id: { ...string, description: "The saved reply to update with the reveal (optional)" },
    },
    ["round", "outcome"],
  ),
  response: object({
    reveal: blindReveal,
    counted: { ...bool, description: "false when this round was already voted on; the first vote stands" },
    message_id: { type: ["string", "null"] },
    arena: object({
      ask: { ...bool, description: "The first vote once Blind Arena is live: ask whether to add votes to it (PUT /api/arena/consent)" },
      contributing: bool,
      added: { ...bool, description: "Whether this vote was added to the Arena's anonymous aggregate" },
    }),
  }),
  description:
    "arena is present once Blind Arena is released. Stores the two model ids, the outcome and the date for your rankings, and nothing else. Only the account that ran the round can vote (404 blind_round_not_found otherwise, or for a token that isn't valid). Rounds can be voted on for 30 days (410 blind_vote_closed).",
});
route("get", "/api/blind/rankings", "Your Blind Compare rankings", {
  response: object({
    votes: integer,
    data: array(
      object({
        model: string,
        name: string,
        rounds: integer,
        wins: integer,
        ties: integer,
        losses: { ...integer, description: "Includes both_bad" },
        both_bad: integer,
        win_rate: { ...number, description: "(wins + ties / 2) / rounds, 0 to 1" },
      }),
    ),
  }),
  description: "From this account's own votes only; best win rate first.",
});
route("delete", "/api/blind/rankings", "Reset your Blind Compare rankings", {
  response: object({ deleted: integer }),
  description: "Deletes every vote. Saved chats keep their reveals.",
});
// Blind Arena (update "arena", which also needs "blind"; server/arena.js).
const arenaChoiceView = {
  contribute: { ...bool, description: "Whether this account's Blind votes are added to the Arena. Off unless the account said yes" },
  asked: { ...bool, description: "Whether the account has been asked (after its first vote once the Arena is live)" },
};
route("get", "/api/arena", "The Blind Arena leaderboard", {
  auth: null,
  response: object({
    computedAt: { ...integer, description: "When the leaderboard was computed (epoch ms)" },
    nextUpdate: { ...integer, description: "The earliest it's recomputed (epoch ms)" },
    votes: { ...integer, description: "All contributed votes" },
    minVotes: { ...integer, description: "Votes a model needs before it's listed" },
    waiting: { ...integer, description: "Models with votes but fewer than minVotes; not named" },
    models: array(
      object({
        rank: integer,
        id: string,
        name: string,
        score: { ...integer, description: "Bradley–Terry score on an Elo-like scale; the average model is 1000, and 400 points is 10-to-1 odds" },
        ci: { ...array(integer), minItems: 2, maxItems: 2, description: "The 95% interval for the score, from a bootstrap" },
        votes: integer,
        win_rate: { ...number, description: "(wins + ties / 2) / votes, 0 to 1; both bad counts as a tie" },
      }),
    ),
    method: object({
      model: { enum: ["bradley-terry"] },
      ties: { enum: ["half"] },
      bothBad: { enum: ["tie"] },
      prior: { ...number, description: "Virtual ties each model has with an average model" },
      interval: object({ confidence: number, bootstrap: integer }),
    }),
  }),
  description:
    "Public and the same for everyone; recomputed at most once an hour (Cache-Control: public, max-age up to 3600). From the anonymous aggregate only: votes from accounts that opted in, counted per UTC day and model pair, with no account id. Only saved chat and code rounds are added; off-the-record (device-only chats included), Private Mode and Uncensored rounds never are. A model is listed once at least minVotes votes involve it.",
});
route("get", "/api/arena/consent", "Your Blind Arena choice", {
  response: object(arenaChoiceView),
});
route("put", "/api/arena/consent", "Add your Blind votes to the Arena, or stop", {
  body: object(
    {
      contribute: bool,
      round: { ...string, description: "With a yes to the question asked after a vote: that vote's round token, so it's added too" },
    },
    ["contribute"],
  ),
  response: object({ ...arenaChoiceView, added: { ...bool, description: "Whether the vote in round was added" } }),
  description:
    "Yes adds your future Blind votes (saved chat and code rounds) to the anonymous aggregate: the two model ids, the outcome and the UTC day, never the account. No stops future ones; votes already added stay, since nothing in the aggregate says whose they were. round adds that one vote only when answering the question asked after it. Panic Wipe and closing the account erase the choice.",
});
// Secret Guard (update "secretguard"; server/secret-guard.js). The guard
// runs in the browser; these read and change the account's switch.
const secretGuardView = {
  enabled: { ...bool, description: "Whether the workspace checks what this account sends for passwords, API keys and tokens. On unless the account switched it off" },
};
route("get", "/api/secret-guard", "Your Secret Guard switch", {
  response: object(secretGuardView),
  description:
    "Secret Guard runs in the browser, in the chat composer (and Code & Build), attached text files and documents, Canvas, Routines, Research Watch, Characters (instructions and opening messages, saved or added from a copy link), Screenshot to site, Debate and subtitle translations: a match is masked ([SECRET_1] goes instead and the reply is restored in that browser only), removed, or sent anyway. It's a soft guard: the server never checks messages for secrets and stores nothing about a match. The developer API (/v1) and MCP are never checked, since their callers are programs.",
});
route("put", "/api/secret-guard", "Switch Secret Guard on or off", {
  body: object({ enabled: bool }, ["enabled"]),
  response: object(secretGuardView),
  description:
    "Only an account that switched it off keeps a row (with when). Panic Wipe, Inactivity Wipe and closing the account erase it, which turns the guard back on; the account export includes it as secretGuard.",
});
// Deep Research (update "deepresearch", which also needs "search").
const researchRequest = object(
  {
    model: { ...string, description: "A callable text model; it plans, searches and writes" },
    question: { ...string, minLength: 1, maxLength: 2000 },
    depth: { enum: ["quick", "thorough"], description: "quick runs at most 3 web searches, thorough at most 6" },
    mode: { enum: ["chat", "code"], default: "chat" },
    requestId: { ...string, maxLength: 200, description: "Or the Idempotency-Key header; a repeat is refused with 409 duplicate_request" },
    conversationId: { ...string, description: "Add the run to this saved conversation" },
    ephemeral: { ...bool, description: "Off the record: nothing is saved (needs ephemeral)" },
    private: { ...bool, description: "Private Mode: a zero-data-retention model, ZDR routing on every step, nothing saved (needs private and ephemeral)" },
    project: { ...string, description: "File a new saved run in this project (needs projects)" },
    memory: { ...array(object({ id: string, text: string, updated: integer })), description: "As on /api/chat; used for the plan and the report, never sent as a search (needs memory)" },
    veil_masked: { type: ["integer", "null"], description: "The browser's Veil mask count for the question (needs trail); anything above 0 is refused with 400 research_veiled" },
  },
  ["model", "question", "depth"],
);
route("post", "/api/research/quote", "The most a Deep research run can cost", {
  body: researchRequest,
  response: object({
    credits: { ...number, description: "The maximum: the plan, every search with its web search fee, and the report" },
    usd: number,
    available: number,
    spending_limit: object({ remaining: number }),
    model: string,
    depth: string,
    searches: integer,
    steps: object({ plan: number, search: { ...number, description: "Each search" }, write: number }),
    web_search_fee: number,
    estimate: bool,
  }),
  description:
    "Reserves and charges nothing. The same checks as a run (Seed Guard with no override, Veil, Private Mode, Early Model Access (403 early_model), context allowance), so a quote that succeeds describes exactly what a run would hold.",
});
route("post", "/api/research", "Run Deep research", {
  body: researchRequest,
  stream: true,
  description:
    "Workspace only (session). Plans up to 3 or 6 sub-questions (strict JSON; invalid output falls back to the question itself, and that plan step is released, not charged; every step's instructions say today's date in UTC and the planner and searches prefer recent items), runs one web search per sub-question and writes a Markdown report whose [n] citations map only to the pages those searches returned; other URLs and out-of-range numbers are removed. Before anything runs, every step is held at its maximum (402 insufficient_credits or spending_limit, 409 research_running for a second run, with nothing charged). Each step settles on its own usage as it finishes; a step that fails, is stopped (closing the stream) or never starts is released, so only finished steps are charged. SSE events: research.stage planning, planned (questions), searching / searched (index, status, sources, credits), writing, then done with message { text, citations, research } and anonyma { credits_charged, request_id, private?, privacy?, memory? }, or error with whatever finished. A saved run adds the question and the report to the conversation as ordinary messages.",
});
// Translate Documents (update "doctranslate").
route("post", "/api/translate/quote", "The most translating a document's parts can cost", {
  body: object(
    {
      model: { ...string, description: "A callable text model" },
      sizes: {
        ...array(object({ json: integer, bytes: integer }, ["json", "bytes"])),
        maxItems: 150,
        description: "One entry per part to be translated: the serialised length and context estimate of the part's longest request (src/translate-spec.js measure of pricedMessages). The parts' text is never sent to a quote (400 invalid_request with parts or glossary).",
      },
      private: { ...bool, description: "Private Mode: a zero-data-retention model only (needs private and ephemeral)" },
    },
    ["model", "sizes"],
  ),
  response: object({
    credits: { ...number, description: "The maximum for all the parts: what a run holds" },
    units: { ...integer, description: "The same maximum in integer ledger units; send it back as max_units" },
    part_units: { ...array(integer), description: "Each part's maximum, in the order sent" },
    parts: array(number),
    available: number,
    spending_limit: object({ remaining: number }),
    model: string,
    estimate: bool,
  }),
  description: "Reserves, charges, stores and sends nothing. 400 context_limit_exceeded when a part leaves the model less than 2,000 tokens of reply room.",
});
route("post", "/api/translate", "Translate a document's parts", {
  body: object(
    {
      model: { ...string, description: "A callable text model" },
      target: { ...string, description: "The language code to translate into (35 languages, e.g. zh-CN, es, fr, de, ja, ko, pt, ru, ar, hi)" },
      tone: { enum: ["formal", "plain"] },
      of: { ...integer, minimum: 1, maximum: 150, description: "How many parts the whole document has" },
      parts: {
        ...array(object({ index: integer, text: { ...string, maxLength: 8000 } }, ["index", "text"])),
        description: "The parts to translate now (all, the rest after Stop, or one to retry), each as Markdown, masked by Veil in the browser when it's on",
      },
      glossary: {
        ...array(object({ term: { ...string, maxLength: 80 }, as: { ...string, maxLength: 80 } }, ["term"])),
        maxItems: 40,
        description: "Terms to keep as written, or to translate as `as`. Each part is sent only the terms it contains.",
      },
      max_units: { ...integer, description: "The quote's units for exactly these parts; any other figure is refused with 409 estimate_changed, nothing held" },
      requestId: { ...string, maxLength: 200, description: "Or the Idempotency-Key header; a repeat is refused with 409 duplicate_request" },
      private: { ...bool, description: "Private Mode: a zero-data-retention model with ZDR routing and no failover (needs private and ephemeral)" },
      veil_masked: { type: ["integer", "null"], description: "The browser's Veil mask count for these parts (needs trail)" },
      allow_seed_phrase: { ...bool, description: "Seed Guard's Send anyway (needs seedguard); otherwise a part or term holding a seed phrase is refused with 400 seed_phrase_blocked" },
    },
    ["model", "target", "tone", "of", "parts", "max_units"],
  ),
  stream: true,
  description:
    "Workspace only (session), always off the record: nothing is stored and nothing is logged, and the model never sees the file's name. Every part's maximum is held before anything runs, exactly the quoted total (402 insufficient_credits or spending_limit, 409 translate_running for a second run, with nothing charged). Up to 3 parts run at once, each one model call told to return only its translation with the same Markdown structure; a part whose answer drops or changes a Veil placeholder is retried once with the missing ones named. A part settles on its own usage when its translation is usable; one that fails, comes back empty, is cut off at its reply budget, loses a placeholder twice, is stopped or never starts is released and charged nothing. SSE events: translate.stage started (parts, reserved), part (index, status running, done with text and credits, failed with code and message, or stopped), then done (status done, partial or stopped; done, not_done, credits_charged) with anonyma { credits_charged, request_id, stored: false, private?, privacy? }.",
});
route("post", "/api/translate/stop", "Stop the running translation", {
  body: object({ requestId: { ...string, description: "The run to stop; omitted, the account's running translation" } }),
  response: object({ stopped: bool }),
  description: "Parts in flight and not yet started are released and charged nothing; the run's stream then reports what finished, and ends.",
});
// Model Debate (update "debate", which also needs "symposium").
const debateRequest = object(
  {
    question: { ...string, minLength: 2, maxLength: 1000, description: "The question or claim, masked by Veil in the browser when it's on" },
    format: { enum: ["for_against", "positions"], default: "for_against", description: "for_against: Side A argues for it and Side B against it. positions: each side argues the position given in stance_a and stance_b" },
    stance_a: { ...string, maxLength: 240, description: "Side A's position (positions only)" },
    stance_b: { ...string, maxLength: 240, description: "Side B's position (positions only)" },
    rounds: { ...integer, minimum: 1, maximum: 4, description: "One turn each per round: the first round is the opening, the last (when there are two or more) the closing, any between are rebuttals" },
    model_a: { ...string, description: "A callable text model for Side A (never Auto, an image or a Sealed Mode model)" },
    model_b: { ...string, description: "A callable text model for Side B (the same model is allowed)" },
    judge_model: { ...nullableString, description: "A callable text model to judge, or omitted for no judge" },
    private: { ...bool, description: "Private Mode: every model must be zero-data-retention, ZDR routing and no failover, nothing saved (needs private and ephemeral)" },
    ephemeral: { ...bool, description: "Off the record: nothing is saved (needs ephemeral)" },
    lang: { enum: ["en", "es", "zh"], description: "The language of the labels in the saved conversation" },
    veil_masked: { type: ["integer", "null"], description: "The browser's Veil mask count for the question and positions (needs trail)" },
    allow_seed_phrase: { ...bool, description: "Seed Guard's Send anyway (needs seedguard); otherwise a question or position holding a seed phrase is refused with 400 seed_phrase_blocked" },
  },
  ["question", "rounds", "model_a", "model_b"],
);
route("post", "/api/debate/quote", "The most a debate can cost", {
  body: debateRequest,
  response: object({
    credits: { ...number, description: "The maximum for every turn and the judge: exactly what a run holds" },
    units: { ...integer, description: "The same maximum in integer ledger units; send it back as max_units" },
    turns: array(object({ n: integer, side: { enum: ["a", "b"] }, credits: number })),
    judge: { type: ["number", "null"] },
    available: number,
    spending_limit: object({ remaining: number }),
    models: object({ a: string, b: string, judge: nullableString }),
    estimate: bool,
  }),
  description: "Reserves, charges, stores and sends nothing. Each turn is priced on the largest request it could send (every earlier turn at the 2,400-character limit), with a reply budget of 2,048 tokens; the judge has 8,000. Refuses what a run would refuse (Seed Guard aside): Early Model Access (403 early_model), Private Mode (400 private_model_required), context allowance (400 context_limit_exceeded).",
});
route("post", "/api/debate", "Run a debate", {
  body: object(
    {
      ...debateRequest.properties,
      max_units: { ...integer, description: "The quote's units; any other figure is refused with 409 estimate_changed, nothing held" },
      requestId: { ...string, maxLength: 200, description: "Or the Idempotency-Key header; a repeat is refused with 409 duplicate_request" },
    },
    ["question", "rounds", "model_a", "model_b", "max_units"],
  ),
  stream: true,
  description:
    "Workspace only (session). Every step is held at its maximum before anything runs, exactly the quoted total (402 insufficient_credits or spending_limit, 409 debate_running for a second run, with nothing charged). Turns run one at a time, Side A then Side B in each round, each one model call on the transcript so far with a word limit; the judge is sent the sides as A and B and never a model name. Each step settles on its own usage when it finishes. A turn that fails, comes back empty, is cut off with nothing usable, is stopped or never starts is released; the debate stops at the first turn that can't be used and releases the turns and the judge after it. A judge reply that can't be read is released. SSE events: debate.stage started (turns, judge, reserved), turn (n, status speaking, done with text and credits, failed with code and message, or stopped), delta (n, text: the turn as it is written), judge (status judging, done with verdict and credits, failed or stopped), then done (status done, partial or stopped; turns_done, turns_planned, judged, credits_charged, saved) with conversationId and anonyma { credits_charged, request_id, stored, private? }. A finished debate is saved as an ordinary conversation (the question, one reply per turn under its own model, then the judge) unless it was off the record or in Private Mode.",
});
route("post", "/api/debate/stop", "Stop the running debate", {
  body: object({ requestId: { ...string, description: "The run to stop; omitted, the account's running debate" } }),
  response: object({ stopped: bool }),
  description: "The turn in flight and every step after it are released and charged nothing; the run's stream then reports what finished, saves it, and ends.",
});
// File Search (update "filesearch", which also needs "files" and "documents").
const searchPassage = object({
  id: { ...integer, description: "The passage's id in the index; send it back with its text to keep it" },
  file_id: string,
  file: string,
  kind: { enum: ["heading", "slide", "sheet", "page", "part"], description: "What section is: a heading path with the file's own words in it (\"Plan › Launch\"), Slide n, Worksheet n, Page n, or Part n of m. A passage's text starts with its path." },
  section: string,
  text: string,
  flagged: { ...integer, description: "Instruction-like phrases Injection Shield found in the passage (it is still sent, as data)" },
});
const fileSearchBody = {
  model: { ...string, description: "A callable text model (never Auto, an image or a Sealed Mode model)" },
  question: { ...string, minLength: 2, maxLength: 1000, description: "The question, masked by Veil in the browser when it's on" },
  passages: {
    ...array(object({ id: integer, text: { ...string, maxLength: 1800 } }, ["id", "text"])),
    minItems: 1,
    maxItems: 8,
    description: "The passages to send, from a search: each the stored passage exactly, or with details replaced by Veil's tags (400 passage_changed otherwise; 404 passage_unavailable when its file is gone)",
  },
  private: { ...bool, description: "Private Mode: a zero-data-retention model with ZDR routing and no failover (needs private and ephemeral)" },
  ephemeral: { ...bool, description: "Off the record: nothing is saved (needs ephemeral)" },
};
route("get", "/api/file-search/files", "The saved files File Search can search", {
  response: object({
    files: array(object({ id: string, name: string, bytes: integer, truncated: bool, expires: integer, passages: { ...integer, description: "How many passages the file's text is cut into (0 when it holds no text)" } })),
    projects: array(object({ id: string, name: string, color: string, privacy: string, files: array(string) })),
    passages: integer,
    top: integer,
    most: integer,
  }),
  description:
    "Workspace only (session). The account's saved documents (text, DOCX, XLSX, PPTX) that have not expired, newest first. The first call after a file is saved reads its text into the index, per account. projects lists each project's pinned files once Projects is live. Nothing is sent to a model and nothing is logged.",
});
route("post", "/api/file-search/search", "Look up the best passages for a question", {
  body: object(
    {
      question: { ...string, minLength: 2, maxLength: 1000 },
      files: { ...array(string), maxItems: 50, description: "Search only these saved files (404 if one isn't the account's)" },
      project: { ...string, description: "Or only this project's pinned files (needs projects; not with files)" },
    },
    ["question"],
  ),
  response: object({
    passages: { ...array(searchPassage), maxItems: 6, description: "The best passages, most relevant first; only matches, so possibly none" },
    searched: object({ files: integer, passages: integer }),
    top: integer,
  }),
  description:
    "Workspace only (session). SQLite FTS5 selects the passages that have a word of the question (every passage, where FTS5 isn't available) and BM25 in JS ranks them: a rare word outweighs a common one, a match in a passage's heading path counts extra, and a passage with more of the question's words ranks higher. Sends nothing to a model, holds and charges nothing, stores nothing about the question and logs nothing. 400 no_search_terms when the question has nothing to look for.",
});
route("post", "/api/file-search/quote", "The most an answer can cost", {
  body: object(fileSearchBody, ["model", "question", "passages"]),
  response: object({
    credits: { ...number, description: "The maximum: what a run holds" },
    units: { ...integer, description: "The same maximum in integer ledger units; send it back as max_units" },
    available: number,
    spending_limit: object({ remaining: number }),
    model: string,
    passages: integer,
    estimate: bool,
  }),
  description: "Reserves, charges and stores nothing. The question and passages are priced exactly as they will be sent, with the model's reply budget.",
});
route("post", "/api/file-search", "Answer a question from the passages kept", {
  body: object(
    {
      ...fileSearchBody,
      max_units: { ...integer, description: "The quote's units; any other figure is refused with 409 estimate_changed, nothing held" },
      requestId: { ...string, maxLength: 200, description: "Or the Idempotency-Key header; a repeat is refused with 409 duplicate_request" },
      veil_masked: { type: ["integer", "null"], description: "The browser's Veil mask count for the question and passages (needs trail)" },
      allow_seed_phrase: { ...bool, description: "Seed Guard's Send anyway (needs seedguard); otherwise a question or passage holding a seed phrase is refused with 400 seed_phrase_blocked" },
    },
    ["model", "question", "passages", "max_units"],
  ),
  response: object({
    conversationId: { type: ["string", "null"], description: "The saved conversation, or null off the record and in Private Mode" },
    user_message: object({ id: string, text: string }),
    message: object({
      id: string,
      text: { ...string, description: "The answer, with citations [n] that name only passages that were sent" },
      sources: array(object({ n: integer, passage: integer, file_id: string, file: string, kind: string, section: string, cited: bool })),
      cut_short: { ...bool, description: "The reply ran out of room after a usable start; it was charged for what it used" },
    }),
    anonyma: object({ credits_charged: number, request_id: string, finish_reason: string, stored: bool, private: object(), privacy: object() }),
  }),
  description:
    "Workspace only (session). The question, the kept passages and fixed instructions (as data, with Injection Shield's notice) go to one model call: never the files, their names or their other text. The maximum is held before anything is sent, exactly the quoted units (402 insufficient_credits or spending_limit with nothing charged). It settles on actual usage when the answer can be used; a provider failure, an empty answer, an answer cut off with nothing in it and a stopped request are released and charged nothing (502 file_search_failed, file_search_empty, file_search_cut_short). A saved answer is one ordinary conversation (the question, the answer and the files and places it cites, never the passage text); off the record and Private Mode keep nothing.",
});
// Prompt Sharpen (update "sharpen"; Private Mode needs "private" too).
route("post", "/api/sharpen/quote", "What sharpening a prompt costs", {
  body: object(
    {
      model: { ...string, description: "A callable text model" },
      chars: { ...integer, minimum: 0, maximum: 7000, description: "The prompt's length (plus any answers) in characters. The prompt itself is never sent to a quote." },
      private: { ...bool, description: "Private Mode: a zero-data-retention model only" },
    },
    ["model", "chars"],
  ),
  response: object({
    credits: { ...number, description: "About what a sharpen of this length costs (an estimate)" },
    max: { ...number, description: "The most it can cost: what is held while it runs" },
    available: number,
    spending_limit: object({ remaining: number }),
    model: string,
    estimate: bool,
  }),
  description: "Reserves, charges, stores and sends nothing.",
});
route("post", "/api/sharpen", "Sharpen a prompt", {
  body: object(
    {
      model: { ...string, description: "A callable text model" },
      prompt: { ...string, minLength: 12, maxLength: 6000, description: "The prompt, as Veil masked it in the browser" },
      answers: { ...array(object({ question: string, answer: string }, ["question", "answer"])), maxItems: 2, description: "Answers to the sharpener's own questions (each up to 500 characters); the prompt is sharpened again with them" },
      private: { ...bool, description: "Private Mode: a zero-data-retention model with ZDR routing (needs private)" },
      requestId: { ...string, maxLength: 200, description: "Or the Idempotency-Key header; a repeat is refused with 409 duplicate_request" },
    },
    ["model", "prompt"],
  ),
  response: object({
    prompt: { ...string, description: "The improved prompt" },
    notes: { ...array(string), maxItems: 3, description: "What changed and why" },
    questions: { ...array(string), maxItems: 2, description: "Clarifying questions; answering them sharpens again" },
    unchanged: bool,
    model: string,
    credits_charged: number,
    finish_reason: string,
    request_id: string,
    private: object({ privacy: string, stored: bool }),
    stored: bool,
  }),
  description:
    "Workspace only (session). Sends only the prompt (and answers) with the sharpener's instructions: never a conversation, files, memory, standing or project instructions (400 invalid_request if any are passed). Always off the record: nothing is stored or logged. The most it can cost is held first (402 insufficient_credits or spending_limit, nothing charged) and a usable result settles on actual usage. The model must answer in strict JSON with up to 8,000 tokens of room; every Veil placeholder sent ([EMAIL_1] and the like) must come back exactly, with none added. An unreadable reply (502 sharpen_unreadable), one cut short by its room (502 sharpen_length), one that lost or changed a placeholder (502 sharpen_placeholders), a provider failure or Stop charges nothing. Seed Guard refuses a seed phrase with no override (400 seed_phrase_blocked).",
});
// Audio Overview (update "audiooverview", which also needs "audio").
const overviewRequest = object(
  {
    model: { ...string, description: "A callable text model; it writes the script" },
    tts: { ...string, description: "A speech model from /api/audio/models" },
    voices: object({ A: string, B: string }, ["A", "B"]),
    length: { enum: ["short", "long"], description: "About 3 minutes (at most 4,500 characters voiced) or about 8 (at most 11,000)" },
    language: { enum: ["auto", "en", "zh", "es", "fr", "de", "pt", "it", "nl", "pl", "tr", "ru", "ja", "ko", "hi", "ar"], default: "auto", description: "The script's language; auto follows the source" },
    source: object(
      {
        kind: { enum: ["document", "chat", "research"] },
        title: { ...string, maxLength: 120 },
        text: { ...string, minLength: 200, maxLength: 120000 },
      },
      ["kind", "text"],
    ),
    ephemeral: { ...bool, description: "Off the record: nothing is saved; the audio comes back in the response only (needs ephemeral)" },
    private: { ...bool, description: "Always refused with 400 overview_private_unavailable: no voice model offers zero data retention" },
    veil_masked: { type: ["integer", "null"], description: "The browser's Veil mask count for the source (needs veil); above 0, or Veil placeholders left in the source, is refused with 400 overview_veiled" },
    requestId: { ...string, maxLength: 200, description: "Or the Idempotency-Key header; a repeat is refused with 409 duplicate_request" },
  },
  ["model", "tts", "voices", "length", "source"],
);
route("post", "/api/audio/overview/quote", "The most an audio overview can cost", {
  body: overviewRequest,
  response: object({
    credits: { ...number, description: "The maximum, and exactly what a run holds: the script (prompt plus its whole reply budget) and the voices for the length's character cap" },
    usd: number,
    available: number,
    spending_limit: object({ remaining: number }),
    model: string,
    tts: string,
    length: string,
    max_characters: integer,
    source_characters: integer,
    steps: object({ script: number, voices: number }),
    voice_models: {
      ...array(object({ id: string, credits: number })),
      description: "The same maximum with each speech model this account is offered, for choosing one",
    },
    estimate: bool,
  }),
  description:
    "Reserves and charges nothing. The same checks as a run (Seed Guard with no override, Veil, Private Mode, voices, context allowance), so a quote that succeeds describes exactly what a run would hold.",
});
route("post", "/api/audio/overview", "Make an audio overview", {
  body: overviewRequest,
  stream: true,
  description:
    "Workspace only (session). The source goes to the text model as one data-only document; the model writes a two-host script as strict JSON ({ title, chapters: [{ title, turn }], turns: [{ speaker: A|B, text }] }), cut at the length's character cap. Each turn is then voiced with the chosen voice, and the clips are joined into one file (MP3 or WAV) and saved to the library with its script, unless off the record. Before anything runs, exactly the quote's maximum is held, the script's and the voices' parts with no extra margin (402 insufficient_credits or spending_limit, 409 overview_running for a second run, with nothing charged). The script settles on its usage once written; a script cut off by its budget (overview_script_length) or not in the expected shape (overview_script_invalid) stops the run with only the script charged. The voices settle once, on the characters voiced; a failed turn stops the run, keeps what was voiced and charges nothing further. SSE events: overview.stage writing, script (title, chapters, turns), voiced (index, of, credits), then done with result { title, chapters, turns (with start seconds), duration, status complete|partial|stopped, saved, media? | audio? { mime, data base64 } | clips? } and anonyma { credits_charged, steps { script, voices }, request_id }, or error with whatever was made.",
});
route("get", "/api/audio/overview", "List saved audio overviews", {
  response: object({
    data: array(
      object({
        id: { ...string, description: "The audio file's media id" },
        title: string,
        created: integer,
        duration: { type: ["number", "null"] },
        chapters: integer,
        turns: integer,
        status: { enum: ["complete", "partial", "stopped"] },
        url: string,
        cost: number,
      }),
    ),
  }),
  description: "The newest first. Deleting the audio file (DELETE /api/media/{id}) deletes its overview too.",
});
route("get", "/api/audio/overview/{id}", "One saved audio overview with its script", {
  response: object({
    id: string,
    title: string,
    chapters: array(object({ title: string, turn: integer })),
    turns: array(object({ speaker: { enum: ["A", "B"] }, text: string, start: { type: ["number", "null"] } })),
    duration: { type: ["number", "null"] },
    status: string,
    voices: object({ A: string, B: string }),
    media: ref("Media"),
  }),
  description: "The script as voiced, with each turn's start in seconds, for the transcript and chapter jumps. 404 not_found for anyone else's.",
});
// Meeting Notes (update "meetingnotes", which also needs "audio").
const meetingRequest = object(
  {
    duration: { ...number, description: "The recording's length in seconds (2 to 10,800), as read in the browser" },
    chunks: {
      ...array(number),
      description: "Each piece's length in seconds, at most 300 (only the last may be under 285), adding up to duration; at most 39 pieces",
    },
    stt: { ...string, description: "A transcription model from /api/audio/models (stt); default nova-3" },
    language: { ...string, description: "The spoken language for the transcription model: en, zh, es, fr, de, pt, it, nl, ja, ko, hi, ru or multi; omit for the model's default" },
    model: { ...string, description: "A callable text model; it writes the notes" },
    notes_language: { ...string, description: "The notes' language, or auto (the transcript's own); the same list as Audio Overview's" },
    ephemeral: { ...bool, description: "Off the record: nothing is saved (needs ephemeral)" },
    project: { ...string, description: "File the saved notes in this project (needs projects)" },
    private: { ...bool, description: "Always refused with 400 meeting_private_unavailable: no transcription model offers zero data retention" },
    requestId: { ...string, maxLength: 200, description: "Or the Idempotency-Key header; a repeat is refused with 409 duplicate_request" },
  },
  ["duration", "chunks", "model"],
);
const meetingSteps = object({ transcription: number, notes: number });
route("post", "/api/meeting-notes/quote", "The most meeting notes can cost", {
  body: meetingRequest,
  response: object({
    credits: { ...number, description: "The maximum, and exactly what a run holds: every piece at the transcription model's per-minute price, plus the notes (the prompt with the longest transcript this recording can have and the whole reply budget)" },
    usd: number,
    available: number,
    spending_limit: object({ remaining: number }),
    steps: meetingSteps,
    pieces: integer,
    minutes: number,
    credits_per_minute: number,
    stt: object({ id: string, name: string, provider: { type: ["string", "null"] } }),
    model: string,
    reply_budget: integer,
    max_transcript_characters: integer,
    covers_seconds: { type: ["integer", "null"], description: "About how much of the recording the notes can cover when the model can't take the longest transcript; null for all of it" },
    estimate: bool,
  }),
  description: "Reserves and charges nothing. The same checks as a start (plan, models, Private Mode, context), so a quote that succeeds describes exactly what a start would hold.",
});
route("post", "/api/meeting-notes", "Start meeting notes", {
  body: meetingRequest,
  status: 201,
  response: object({
    id: string,
    pieces: array(object({ index: integer, start: number, seconds: number })),
    reserved: number,
    steps: meetingSteps,
    stt: object({ id: string, name: string, provider: { type: ["string", "null"] } }),
    idle_minutes: integer,
  }),
  description:
    "Workspace only (session). An upscale takes a photo up to max_side px on its long side (400 image_too_large_for_upscale before anything is held; the page shrinks a bigger one to a copy that size first). Holds exactly the quote's maximum, one hold per piece and one for the notes, with no extra margin (402 insufficient_credits or spending_limit with nothing held). One run per account: a new one ends the last, releasing what it still held. A run nobody touches for 30 minutes ends the same way. Nothing about the recording is stored; the run keeps only its plan and holds, in memory.",
});
route("post", "/api/meeting-notes/{id}/pieces/{index}", "Transcribe one piece", {
  body: object(
    { audio: { ...string, description: "data:audio/wav;base64,… mono 16-bit PCM at 16 kHz, under 10 MB, exactly the planned length (±0.05 s). Only its format and samples are forwarded" } },
    ["audio"],
  ),
  response: object({
    index: integer,
    segments: array(object({ start: number, end: number, text: string, speaker: string, untimed: { ...bool, description: "true when the provider gave no usable timing for this line (its start is only where its piece starts); notes never cite a time for it" } })),
    seconds: number,
    credits: number,
    charged: number,
    done: integer,
    of: integer,
  }),
  description:
    "Sends the piece to the transcription model and settles its hold on its length (or the provider's, if shorter). Segment times are in the whole recording; speaker appears only when the provider returns one. Word and segment timings are requested; a coarse line (over 30 seconds) is split into lines of about 10 seconds at most (at sentence ends and pauses) by the reply's word timings where it has them, keeping the segment's own punctuated text and using the words only for time, else marked untimed, as is a piece the provider returned no timings for. A failed piece is charged nothing and stays open for a retry (409 piece_done once it's transcribed, 409 meeting_busy while another step runs, 404 meeting_not_found once the run ended).",
});
route("post", "/api/meeting-notes/{id}/finish", "Write and save the notes", {
  body: object({
    segments: { ...array(object({ start: number, end: number, text: string, speaker: string, untimed: bool })), description: "The transcript, Veil-masked in the browser when Veil is on; send each line's untimed flag back as received" },
    veil_masked: { type: ["integer", "null"], description: "The browser's Veil mask count for the transcript (needs trail)" },
    skip_notes: { ...bool, description: "Save the transcript alone: no model call, and the notes' hold is released" },
    headings: { enum: ["en", "zh"], description: "The saved document's headings" },
  }),
  stream: true,
  description:
    "Ends transcription (pieces not transcribed are released), then sends the transcript to the notes model as one data-only document, cut at the length that was held for. The notes come back as strict JSON (read tolerantly); an owner is kept only when the transcript names them. Usable notes settle on their usage; notes that fail, are unusable (notes_invalid) or cut short (notes_length) are charged nothing, and error.retry says whether another try is left (three in all). Seed Guard refuses a transcript with a seed phrase or private key (seed_phrase_blocked) and ends the run. Unless off the record, the notes and the timed transcript are saved as one conversation. SSE events: meeting.stage writing, then done with result { title, notes { title, summary, decisions, actions, questions }, saved, conversationId, cut_at, lines_sent, owners_dropped } and anonyma { credits_charged, steps { transcription, notes }, privacy? { transcription, notes } }, or error.",
});
route("delete", "/api/meeting-notes/{id}", "Discard meeting notes", {
  response: object({ ended: bool, credits_charged: number }),
  description: "Releases everything the run still holds; pieces already transcribed stay charged. Answers the same for a run that already ended.",
});
// Subtitles (update "subtitles", which also needs "audio").
const subtitlesRequest = object(
  {
    duration: { ...number, description: "The video's length in seconds (2 to 10,800), as read in the browser" },
    chunks: {
      ...array(number),
      description: "Each piece's length in seconds, at most 300 (only the last may be under 285), adding up to duration; at most 39 pieces",
    },
    stt: { ...string, description: "A transcription model from /api/audio/models (stt); default nova-3" },
    language: { ...string, description: "The spoken language for the transcription model: en, zh, es, fr, de, pt, it, nl, ja, ko, hi, ru or multi; omit for the model's default" },
    ephemeral: { ...bool, description: "Off the record: only what billing already shows (needs ephemeral)" },
    max_units: { ...integer, description: "The quote's units; a start whose maximum differs is refused with 409 estimate_changed" },
    private: { ...bool, description: "Always refused with 400 subtitles_private_unavailable: no transcription model offers zero data retention" },
    requestId: { ...string, maxLength: 200, description: "Or the Idempotency-Key header; a repeat is refused with 409 duplicate_request" },
  },
  ["duration", "chunks"],
);
const subtitleTrack = object({
  lang: { ...string, description: "The source track's spoken language (or empty), or a translation's language code from Translate docs' list" },
  source: { ...bool, description: "true for the first track only: the words as they were heard" },
  cues: array(object({ start: number, end: number, text: { ...string, description: "One to two lines, separated by a line feed" } })),
});
route("post", "/api/subtitles/quote", "The most subtitles can cost", {
  body: subtitlesRequest,
  response: object({
    credits: { ...number, description: "The maximum, and exactly what a run holds: every piece at the transcription model's per-minute price" },
    units: integer,
    usd: number,
    available: number,
    spending_limit: object({ remaining: number }),
    pieces: integer,
    minutes: number,
    credits_per_minute: number,
    stt: object({ id: string, name: string, provider: { type: ["string", "null"] } }),
    estimate: bool,
  }),
  description: "Reserves and charges nothing. The same checks as a start (plan, model, Private Mode), so a quote that succeeds describes exactly what a start would hold.",
});
route("post", "/api/subtitles", "Start subtitles", {
  body: subtitlesRequest,
  status: 201,
  response: object({
    id: string,
    pieces: array(object({ index: integer, start: number, seconds: number })),
    reserved: number,
    stt: object({ id: string, name: string, provider: { type: ["string", "null"] } }),
    idle_minutes: integer,
  }),
  description:
    "Workspace only (session). Holds exactly the quote's maximum, one hold per piece, with no extra margin (402 insufficient_credits or spending_limit with nothing held). One run per account: a new one ends the last, releasing what it still held. A run nobody touches for 30 minutes ends the same way. Nothing about the video is stored; the run keeps only its plan and holds, in memory.",
});
route("post", "/api/subtitles/{id}/pieces/{index}", "Transcribe one piece", {
  body: object(
    { audio: { ...string, description: "data:audio/wav;base64,… mono 16-bit PCM at 16 kHz, under 10 MB, exactly the planned length (±0.05 s). Only its format and samples are forwarded" } },
    ["audio"],
  ),
  response: object({
    index: integer,
    tokens: array(object({ text: { ...string, description: "The word as written, punctuation kept" }, start: number, end: number })),
    seconds: number,
    credits: number,
    charged: number,
    done: integer,
    of: integer,
  }),
  description:
    "Sends the piece to the transcription model, asking for word and segment timings, and settles its hold on its length (or the provider's, if shorter). Token times are in the whole video. A piece whose reply has no usable timing is refused with 502 subtitles_no_timings and charged nothing, like a failed one; either stays open for a retry (409 piece_done once it's transcribed, 409 subtitles_busy while another step runs, 404 subtitles_not_found once the run ended). The last piece ends the run.",
});
route("delete", "/api/subtitles/{id}", "Discard or finish subtitles", {
  response: object({ ended: bool, credits_charged: number }),
  description: "Releases everything the run still holds; pieces already transcribed stay charged. Answers the same for a run that already ended.",
});
const translateFields = {
  target: { ...string, description: "A language code from Translate docs' list (35 languages)" },
  model: { ...string, description: "A callable text model" },
  private: { ...bool, description: "Private Mode: only a zero-data-retention model (400 private_model_required; needs private and ephemeral)" },
};
route("post", "/api/subtitles/translate/quote", "The most a translation can cost", {
  body: object({ ...translateFields, sizes: { ...array(object({ json: integer, bytes: integer })), description: "Each part's size (never its text), from the same messages a run sends" } }, ["target", "model", "sizes"]),
  response: object({ credits: number, units: integer, part_units: array(integer), parts: array(number), available: number, spending_limit: object({ remaining: number }), model: string, estimate: bool }),
  description: "Reserves and charges nothing.",
});
route("post", "/api/subtitles/translate", "Translate a subtitle track", {
  body: object(
    {
      ...translateFields,
      of: { ...integer, description: "How many parts the track is in (1 to 150)" },
      batches: { ...array(object({ index: integer, items: array(object({ n: integer, text: string })) })), description: "The parts to translate: up to 40 cues each, numbered by their place in the track; Veil-masked in the browser when Veil is on" },
      max_units: { ...integer, description: "The quote's units; a run whose total differs is refused with 409 estimate_changed" },
      veil_masked: { type: ["integer", "null"], description: "The browser's Veil mask count (needs trail)" },
    },
    ["target", "model", "of", "batches", "max_units"],
  ),
  stream: true,
  description:
    "Holds every part's maximum, exactly the quoted total. One off-the-record model call a part, three at a time; the cues go as one data-only document and come back as strict JSON (read tolerantly), every cue once, timings untouched. A usable part settles on its usage; a part that fails, is cut short, loses a cue or loses a Veil placeholder is released and charged nothing. Seed Guard refuses a cue holding a seed phrase (seed_phrase_blocked). SSE events: translate.stage started, part (running, then done with cues [{ n, text }], failed or stopped), then done, and anonyma { credits_charged, stored: false, privacy? }.",
});
route("post", "/api/subtitles/translate/stop", "Stop a translation", {
  response: object({ stopped: bool }),
  description: "Aborts the account's running translation; parts not finished are released.",
});
route("get", "/api/subtitles/sets", "Your saved subtitle sets", {
  response: object({ data: array(object({ id: string, title: string, duration: number, language: string, track_list: array(object({ lang: string, source: bool, cues: integer })), created: integer, updated: integer })), limit: integer }),
  description: "Without the tracks' cues. At most 100 sets.",
});
route("post", "/api/subtitles/sets", "Save a subtitle set", {
  body: object({ title: string, duration: number, language: string, tracks: array(subtitleTrack) }, ["title", "duration", "tracks"]),
  status: 201,
  response: object({ id: string, title: string, duration: number, language: string, tracks: array(subtitleTrack), created: integer, updated: integer }),
  description:
    "Stores the title, the video's length, the spoken language and the tracks (each cue's times and text, at most 512 KB in all): never the video, its sound or its name. The first track is the one that was heard; each other track is a translation into a language Translate docs knows, once each. Seed Guard refuses a set holding a seed phrase (seed_phrase_blocked). 409 subtitles_limit at 100 sets.",
});
route("get", "/api/subtitles/sets/{id}", "Open a subtitle set", {
  response: object({ id: string, title: string, duration: number, language: string, tracks: array(subtitleTrack), created: integer, updated: integer }),
  description: "404 subtitles_set_not_found for anyone else's.",
});
route("patch", "/api/subtitles/sets/{id}", "Rename or edit a subtitle set", {
  body: object({ title: string, tracks: array(subtitleTrack) }),
  response: object({ id: string, title: string, duration: number, language: string, tracks: array(subtitleTrack), created: integer, updated: integer }),
  description: "Send a title, the tracks, or both.",
});
route("delete", "/api/subtitles/sets/{id}", "Delete a subtitle set", {
  response: object({ ok: bool }),
  description: "Erases the set. Account closure, Panic Wipe and Inactivity Wipe erase every set; the account export lists them whole.",
});
// Photo Tools (update "phototools", which also needs "images").
const photoRequest = {
  tool: { enum: ["edit", "background", "upscale"], description: "edit (change a photo with words), background (cut the subject out as a transparent PNG) or upscale. extend is refused with 400 tool_unavailable" },
  model: { ...string, description: "A model /api/photo-tools lists for the tool" },
  ephemeral: { ...bool, description: "Off the record: the result is returned in the reply and saved nowhere (needs ephemeral)" },
  private: { ...bool, description: "Private Mode: only a zero-data-retention model, and off the record (400 private_model_required when the model isn't one; needs private and ephemeral)" },
};
route("get", "/api/photo-tools", "The photo tools, their models and prices", {
  response: object({
    tools: array(
      object({
        id: string,
        default: { type: ["string", "null"] },
        models: array(object({ id: string, name: string, provider: { type: ["string", "null"] }, credits: { ...number, description: "The most one run can cost: exactly what a run holds" }, units: { ...integer, description: "The same in ledger units (credits x 10,000)" }, private: bool, max_side: { ...integer, description: "Upscalers only: the longest side, in pixels, a photo may have (an upscaler makes it 4x bigger, and its result must stay a returnable size)" } })),
      }),
    ),
    unavailable: array(object({ tool: string, reason: string })),
    private_available: bool,
    limits: object({ image_bytes: integer, prompt_characters: integer }),
    available: number,
    testMode: bool,
  }),
  description: "Read from the live catalog's own capability fields: a model is listed only when the catalog says it takes a photo (and, for edit, a prompt). Extend is listed as unavailable. Nothing is reserved.",
});
route("post", "/api/photo-tools/quote", "The most a photo run can cost", {
  body: object(photoRequest, ["tool", "model"]),
  response: object({
    credits: { ...number, description: "The maximum, and exactly what a run holds: the highest price the catalog publishes for the model, at the account's rate" },
    units: { ...integer, description: "The same in ledger units: the max_units a run sends" },
    usd: number,
    available: number,
    spending_limit: object({ remaining: number }),
    tool: string,
    model: string,
    estimate: bool,
  }),
  description: "Reserves and charges nothing. The same checks as a run, so a quote that succeeds describes exactly what a run would hold. A photo tool runs on the model chosen: 400 auto_not_offered with auto.",
});
route("post", "/api/photo-tools/run", "Run a photo tool", {
  body: object(
    {
      ...photoRequest,
      image: { ...string, description: "The photo as a PNG, JPEG, WebP or GIF data URL, at most 1.5 MiB. Metadata is removed and any redaction is done in the browser first" },
      prompt: { ...string, maxLength: 2000, description: "edit only: what to change. Ignored (never sent) by the other tools" },
      max_units: { ...integer, description: "The quote's maximum in ledger units (credits x 10,000). A run whose price differs is refused with 409 estimate_changed" },
      source: { ...string, description: "A library image this photo came from, kept from the library's cap while the result is saved" },
      veil_masked: { type: ["integer", "null"], description: "The browser's Veil mask count for the words (needs trail)" },
      allow_seed_phrase: { ...bool, description: "Seed Guard's \"Send anyway\" (needs seedguard)" },
      requestId: { ...string, maxLength: 200, description: "Or the Idempotency-Key header; a repeat is refused with 409 duplicate_request" },
    },
    ["tool", "model", "image", "max_units"],
  ),
  response: object({
    tool: string,
    model: string,
    saved: bool,
    media: { ...ref("Media"), description: "The saved library image; null off the record" },
    image: { type: ["string", "null"], description: "Off the record only: the result as a data URL" },
    mime: string,
    receipt: object({ charged: number, credits_charged: number, released: number, model: string }),
    testMode: bool,
    privacy: { type: "object", description: "Privacy Trail's object for the run, once released" },
  }),
  description:
    "Workspace only (session). Holds exactly the quote's maximum (402 insufficient_credits or spending_limit with nothing held), sends the photo, and checks the result: it must be a picture, and a cut-out must be able to be transparent. Only a checked result is charged, at the provider's reported cost and never above the hold; a provider failure, a timeout, a result that can't be used (photo_unusable, photo_not_transparent, photo_too_large) or one that can't be saved releases the hold and charges nothing. Saved results are library images with no request settings kept. Nothing about the photo or the words is logged.",
});
// Highlight & Ask's fact-check (update "highlight", which also needs "search").
const factCheckRequest = object(
  {
    model: { ...string, description: "A callable text model; it runs the web search and writes the verdict" },
    claim: { ...string, minLength: 1, maxLength: 1000, description: "The text selected in a reply (400 claim_too_long above 1,000 characters)" },
    requestId: { ...string, maxLength: 200, description: "Or the Idempotency-Key header; a repeat is refused with 409 duplicate_request" },
    conversationId: { ...string, description: "Add the check to this saved conversation (not a Symposium run)" },
    ephemeral: { ...bool, description: "Off the record: nothing is saved (needs ephemeral)" },
    private: { ...bool, description: "Private Mode: a zero-data-retention model, ZDR routing, nothing saved (needs private and ephemeral)" },
    project: { ...string, description: "File a new saved check in this project (needs projects)" },
    veil_masked: { type: ["integer", "null"], description: "The browser's Veil mask count for the claim (needs trail); anything above 0, or a Veil placeholder such as [EMAIL_1] in the claim, is refused with 400 factcheck_veiled" },
  },
  ["model", "claim"],
);
route("post", "/api/factcheck/quote", "The most a fact-check can cost", {
  body: factCheckRequest,
  response: object({
    credits: { ...number, description: "The maximum: the claim, the whole reply budget and the web search fee" },
    usd: number,
    available: number,
    spending_limit: object({ remaining: number }),
    model: string,
    web_search_fee: number,
    estimate: bool,
  }),
  description:
    "Reserves and charges nothing. The same checks as a fact-check (Seed Guard with no override, Veil, Private Mode, context allowance), so a quote that succeeds describes exactly what a check would hold.",
});
route("post", "/api/factcheck", "Fact-check selected text against the web", {
  body: factCheckRequest,
  response: object({
    conversationId: { type: ["string", "null"] },
    user_message: object({ id: string, text: string }),
    message: object({
      id: string,
      text: { ...string, description: "The card as Markdown: the verdict and the reason" },
      citations: array(object({ url: string, title: string })),
      factcheck: object({
        verdict: { enum: ["supported", "disputed", "mixed", "unverified"] },
        reason: string,
        named: { ...bool, description: "False when the model named none of the pages the search returned, so the search's first pages are shown" },
        lang: { enum: ["en", "zh"] },
        credits_charged: number,
      }),
    }),
    anonyma: object({ credits_charged: number, request_id: string, finish_reason: string }),
  }),
  description:
    "Workspace only (session). One web search through Live Web Search's plugin and fee, with a reply budget of 8,000 tokens (within the model's output limit) for a strict JSON verdict. Only the claim is sent, as delimited data, never the rest of the chat. Sources are 1 to 3 pages the search returned; an address the search didn't return is never shown, and a search that returned no pages is always unverified. The maximum is held first (402 insufficient_credits or spending_limit with nothing charged) and settled on actual usage once a verdict is read. A failed, stopped or unreadable check is released and charges nothing: 502 factcheck_cut_short when the model ran out of room, factcheck_unreadable for any other answer that isn't the verdict JSON, factcheck_failed when the provider failed. A saved check adds two ordinary messages to the conversation (the quote, then the card's text with its sources as citations) or starts a new one; off the record and Private Mode store nothing.",
});
// Canvas (update "canvas"). A suggestion is an /api/chat request (and
// /api/quote estimate) carrying `canvas`, described under POST /api/canvas.
const canvasDoc = object({
  id: string,
  title: { ...string, maxLength: 200 },
  content: { ...string, maxLength: 200000, description: "The canvas's Markdown text" },
  revision: { ...integer, description: "Goes up by one with each saved change" },
  created: integer,
  updated: integer,
  expires: { type: ["integer", "null"], description: "The auto-delete time it took from the account's default when it was made; null keeps it until deleted" },
});
route("get", "/api/canvas", "Your canvases", {
  response: object({
    data: array(object({ id: string, title: string, chars: integer, revision: integer, created: integer, updated: integer, expires: { type: ["integer", "null"] } })),
    limit: { ...integer, description: "Canvases an account can keep (200)" },
  }),
  description: "Newest first, without their text. Only canvases kept on the account: ones kept only in the browser (off the record in one tab, or encrypted on the device) never reach the server. A canvas past its auto-delete time is never listed. 240 reads a minute.",
});
route("post", "/api/canvas", "Keep a new canvas on your account", {
  status: 201,
  body: object({
    title: { ...string, maxLength: 200, description: "Default \"Untitled canvas\"" },
    content: { ...string, maxLength: 200000, description: "Markdown text; line breaks and tabs are the only control characters allowed" },
  }),
  response: canvasDoc,
  description:
    "Takes the account's auto-delete default, as a new conversation does. At most 200 per account (409 canvas_limit); more than 200,000 characters is 413 canvas_too_large. With Seed Guard live, a seed phrase in the title or text is refused (400 seed_phrase_blocked, no override). Suggestions on a canvas are POST /api/chat with ephemeral: true and canvas: { action: improve | shorten | expand | tone | grammar | custom | summarize | consistent, scope: selection | document, text, before?, after?, tone?: formal | friendly | plain, instruction? } (a selection up to 12,000 characters with up to 600 characters of context on each side, or a document up to 40,000 characters; 400 invalid_canvas), whose messages and reply budget (8,000 tokens plus room for the rewrite, lowered to the model's limits; 400 canvas_too_long when the rewrite can't fit) the server builds. They're never saved, and only a usable reply is charged: a reply that can't be read (502 canvas_unreadable) or was cut off by its budget (502 canvas_length) releases its hold. POST /api/quote prices the same body.",
});
route("get", "/api/canvas/{id}", "One canvas, with its text", {
  response: canvasDoc,
  description: "404 canvas_not_found for another account's canvas, a deleted one or one past its auto-delete time.",
});
route("patch", "/api/canvas/{id}", "Rename a canvas or save its text", {
  body: object({
    title: { ...string, maxLength: 200 },
    content: { ...string, maxLength: 200000 },
    base: { ...integer, minimum: 1, description: "The revision the change was made from: if the canvas has changed since, nothing is saved (409 canvas_conflict)" },
  }),
  response: canvasDoc,
  description: "Send a title, text or both. An unchanged canvas keeps its revision. Seed Guard applies as for a new canvas. 1,200 writes per 10 minutes, for autosave.",
});
route("delete", "/api/canvas/{id}", "Delete a canvas", {
  response: ref("Ok"),
  description: "Deleted at once. Panic Wipe and closing the account delete every canvas; the account export lists them with their text.",
});
// Summarize & Continue (update "catchup"). Catch me up is an /api/chat
// request (and /api/quote estimate) carrying `catchup`, documented there.
route("post", "/api/catchup/continue", "Continue a saved chat fresh from its summary", {
  body: object(
    {
      from: { ...string, description: "The saved chat, code or Uncensored conversation to continue from (one you can open)" },
      summary: { ...string, minLength: 1, maxLength: 12000, description: "The summary the new chat carries, as the user edited it" },
      title: { ...string, maxLength: 70, description: "The new chat's title; default \"Continued · \" and the source's title" },
    },
    ["from", "summary"],
  ),
  status: 201,
  response: object({
    id: string,
    title: string,
    mode: string,
    continued: object({
      from: object({ id: string, title: string, mode: string }),
      summary: string,
      created: integer,
    }),
  }),
  description:
    "Creates an empty conversation linked to the source, in the source's mode, collab and project, and never outliving an auto-deleting source. Nothing is copied from the source and it isn't changed. The summary is stored with the new conversation only (GET /api/conversations/{id} returns it as continued, with from null once the source can't be opened) and the browser sends it as the leading system context of every message in it. A seed phrase in the summary is refused with 400 seed_phrase_blocked (no override). Free: messages in the new chat bill as usual. Catch me up itself is a POST /api/chat with ephemeral: true and catchup: { transcript: [{ role: user | assistant, text }] } (2 to 400 turns, at least 8 or about 6,000 tokens of text, at most 200,000 characters; 400 catchup_too_short or invalid_catchup), whose messages and reply budget (8,000 tokens, lowered to the model's limits; 400 catchup_too_long when the transcript leaves too little room) the server builds; POST /api/quote prices the same body.",
});
// Slides (update "slides"). Making a deck, or regenerating one slide, is an
// /api/chat request (and /api/quote estimate) carrying `slides`, described
// on POST /api/slides below.
const slideColumn = object({ heading: { ...string, maxLength: 80 }, bullets: array({ ...string, maxLength: 200 }) });
const slide = object(
  {
    id: { ...string, pattern: "^[A-Za-z0-9_-]{1,40}$" },
    layout: { enum: ["title", "section", "bullets", "two-column", "quote", "big-number"] },
    title: { ...string, maxLength: 140, description: "title, section, bullets, two-column and big-number" },
    subtitle: { ...string, maxLength: 240, description: "title and section" },
    bullets: { ...array({ ...string, maxLength: 200 }), maxItems: 6, description: "bullets" },
    left: { ...slideColumn, description: "two-column (up to 6 bullets)" },
    right: { ...slideColumn, description: "two-column (up to 6 bullets)" },
    quote: { ...string, maxLength: 400, description: "quote" },
    attribution: { ...string, maxLength: 120, description: "quote" },
    number: { ...string, maxLength: 24, description: "big-number" },
    label: { ...string, maxLength: 160, description: "big-number" },
    notes: { ...string, maxLength: 1500, description: "Speaker notes; line breaks allowed" },
  },
  ["id", "layout"],
);
const deck = object({
  id: string,
  title: string,
  theme: { enum: ["cobalt", "white", "dark"] },
  slide_count: integer,
  slides: array(slide),
  created: integer,
  updated: integer,
});
const deckBody = (required) =>
  object(
    {
      title: { ...string, minLength: 1, maxLength: 120 },
      theme: { enum: ["cobalt", "white", "dark"] },
      slides: { ...array(slide), minItems: 1, maxItems: 40, description: "Only the fields of each slide's layout, plus id, layout and notes; at most 256 KB as JSON" },
    },
    required,
  );
route("get", "/api/slides", "Your saved decks", {
  response: object({
    data: array(
      object({ id: string, title: string, theme: string, slide_count: integer, first: { ...slide, description: "The first slide, for a thumbnail" }, created: integer, updated: integer }),
    ),
    limit: { ...integer, description: "Decks an account can keep (200)" },
  }),
  description: "Newest edit first. Only decks saved on the account: decks made off the record or in Private Mode stay in the browser that made them and never reach the server.",
});
route("post", "/api/slides", "Save a deck", {
  status: 201,
  body: deckBody(["title", "theme", "slides"]),
  response: deck,
  description:
    "Stores the deck's title, theme and slides (text and speaker notes) with its dates; never the source it was made from or the model that made it. Text made with Veil keeps its placeholders; the values stay in the browser. A seed phrase anywhere in it is refused (400 seed_phrase_blocked, no override) once Seed Guard is live. 400 invalid_deck; at most 200 decks (409 slides_limit). Erased by account closure and Panic Wipe, and in the account export as slideDecks. Making a deck is a POST /api/chat with ephemeral: true and slides: { task: \"deck\", count (3 to 20), source: { kind: prompt | document | chat, name, text } } (a prompt of 8 to 4,000 characters, a document or chat of 40 to 40,000); regenerating one slide is slides: { task: \"slide\", deck: { title, outline: [slide titles] }, index, slide, instruction (up to 300 characters) }. The server builds the messages (the source as delimited data) and a reply budget of 8,000 tokens plus 300 per slide, lowered to the model's limits (400 slides_too_long when the context leaves too little room); POST /api/quote prices the same body, and the request holds exactly that price. The reply is sent only once it reads as slides (JSON in the layouts above, read tolerantly); until then the stream carries { slides: { started } } counts. A reply that doesn't read as slides releases the hold and charges nothing: 502 slides_cut_short (out of room), slides_refused (the model said the source had nothing for slides) or slides_unreadable. 400 invalid_slides for a malformed payload or one combined with other chat options (a conversation, project, memory, web search, another task or Seed Guard's override).",
});
route("get", "/api/slides/{id}", "One saved deck", {
  response: deck,
  description: "404 deck_not_found for another account's deck or one that was deleted.",
});
route("patch", "/api/slides/{id}", "Rename a deck, change its theme or save its slides", {
  body: deckBody([]),
  response: deck,
  description: "Any of title, theme and slides; slides replace the deck's slides whole. The same checks as POST /api/slides. The last save wins.",
});
route("delete", "/api/slides/{id}", "Delete a saved deck", {
  response: ref("Ok"),
  description: "Deletes it from the server. A copy exported as a PDF or HTML file is yours and isn't affected.",
});
// Screenshot to site (update "shottosite", which also needs "preview" and, for
// saved pages, "code"). Making a page from a picture, or changing one with
// words, is an /api/chat request (and /api/quote estimate) carrying
// `shottosite`, described on POST /api/site-pages below.
const sitePage = object({
  id: { ...string, description: "The conversation the page is saved as" },
  title: string,
  created: integer,
  updated: integer,
  versions: integer,
});
route("get", "/api/site-pages", "Your saved pages", {
  response: object({
    data: array(sitePage),
    limit: { ...integer, description: "Pages listed (30)" },
    max_versions: { ...integer, description: "Versions kept per page (12)" },
  }),
  description:
    "Newest edit first. A saved page is an ordinary conversation in Code & Build's mode (open it with GET /api/conversations/{id}, or in the workspace at /workspace/code?c={id}); this lists the ones that Screenshot to site made. Pages made off the record or in Private Mode are never saved.",
});
route("post", "/api/site-pages", "Save versions of a page", {
  status: 201,
  body: object(
    {
      id: { ...string, description: "A saved page to add these versions to; omit to save a new page" },
      versions: {
        ...array(
          object(
            {
              label: { ...string, minLength: 1, maxLength: 1100, description: "What asked for it, e.g. \"Change: make it blue\"" },
              html: { ...string, maxLength: 40000, description: "The page: one HTML document" },
              request_id: { ...string, description: "The request that made it: its cost is read from the account's own settled hold, never from this body" },
              from: { ...integer, description: "Optional: the version it was changed from (0-based)" },
            },
            ["label", "html"],
          ),
        ),
        minItems: 1,
        maxItems: 12,
      },
    },
    ["versions"],
  ),
  response: object({ id: string, title: string, saved: integer }),
  description:
    "Saves pages as one conversation in Code & Build's mode, a message pair per version (what was asked, then the page as one block named index.html). Only words and pages are stored: never the picture, and nothing about the request beyond the model's id and its cost. A page that isn't a document this tool can show is refused (400 invalid_page); so is one holding a seed phrase once Seed Guard is live (400 seed_phrase_blocked, no override). The newest 12 versions stay; the oldest go first. 200 when adding to an existing page, 201 for a new one; 404 page_not_found for another account's page or a conversation this tool didn't make. Erased by account closure and Panic Wipe, and in the account export, as any conversation. Making a page is a POST /api/chat with ephemeral: true and shottosite: { task: \"make\", image: { url }, notes? } (a PNG, JPEG or WebP data URL of at most 600,000 characters; notes up to 1,000) or { task: \"change\", page: { html }, instruction (3 to 1,000 characters), image? }; the current page goes to the model as delimited data. A vision model is required (400 Choose a model that accepts image input.). The server builds the messages and a reply budget of 12,000 tokens, lowered to the model's limits (400 site_too_long when its context leaves too little room); POST /api/quote prices the same body with the picture as { mime, chars } only (its kind and length, never the picture), and the request holds exactly that price. The reply is sent only once it reads as a page (an HTML document, read tolerantly from a code fence or prose around it); until then the stream carries { shottosite: { chars } } counts. A reply that doesn't releases the hold and charges nothing: 502 site_cut_short (out of room), site_too_long (over 40,000 characters), site_refused (the model said the picture had nothing to build) or site_unreadable. 400 invalid_shottosite for a malformed payload or one combined with other chat options (a conversation, project, memory, web search, Auto, another task or Seed Guard's override). Auto Model is never offered here.",
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
    "Any member. Moves available credits atomically as a linked treasury_contribution ledger pair; the treasury is a hidden ledger account created on the first contribution. Contributed credits belong to the treasury, which its owner controls, and can't be taken back. Repeats return 200. 402 insufficient_credits; 402 welcome_credits_locked when only unspent welcome credits could cover it (they can be spent on requests, not moved); 402 spending_limit when the contribution would go over the contributor's own spending limits (contributions count toward them); 409 payment_reconciliation_pending while the contributor has a credited payment under reconciliation.",
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
    "Moves available credits atomically as a linked transfer_out/transfer_in ledger pair. Reusing a requestId returns the original transfer instead of sending again. 402 welcome_credits_locked when only unspent welcome credits could cover it: they can be spent on requests, not sent. Paused while a credited payment is under reconciliation. Credits sent count toward the sender's own spending limits: 402 spending_limit when a transfer would go over one.",
});
// Gift Links (update "giftlinks").
const giftCode = {
  ...string,
  maxLength: 400,
  description:
    "The gift code (28 Crockford base32 symbols, dashes optional, any case), or the whole claim link: only what follows its # is read",
};
const gift = object({
  id: string,
  amount: { ...integer, description: "Credits" },
  note: { ...string, maxLength: 140 },
  status: { enum: ["open", "claimed", "revoked", "expired"] },
  created: integer,
  expires: { ...integer, description: "When an unclaimed gift goes back to you (30 days after it was made)" },
  claimed: { type: ["integer", "null"], description: "When it was claimed. Who claimed it is never shown" },
  returned: { type: ["integer", "null"], description: "When its credits came back to you (cancelled or unclaimed)" },
});
route("get", "/api/gifts", "Your gifts", {
  response: object({
    data: array(gift),
    open: { ...integer, description: "Gifts waiting to be claimed" },
    limits: object({ min: integer, max: integer, note: integer, open: integer, days: integer }),
  }),
  description: "Newest first, the latest 100. The account export has every one.",
});
route("post", "/api/gifts", "Make a gift link", {
  status: 201,
  body: object(
    {
      amount: { ...integer, minimum: 100, maximum: 250000, description: "Whole credits" },
      note: { ...string, maxLength: 140, description: "Optional, one line, shown to whoever opens the link. With Seed Guard live, a seed phrase is refused (400 seed_phrase_blocked)." },
      requestId,
    },
    ["amount"],
  ),
  response: {
    ...gift,
    properties: {
      ...gift.properties,
      code: { ...string, description: "Shown once: only its hash is stored" },
      link: { ...string, description: "The claim link, with the code after its #" },
      available: number,
      repeated: { ...bool, description: "The requestId was used already: the original gift, without its code (200)" },
    },
  },
  description:
    "The credits leave your balance at once as a gift_out ledger entry and the gift holds them. Same rules as sending credits: 402 insufficient_credits, 402 welcome_credits_locked, 402 spending_limit (a gift counts toward your spending limits), 409 payment_reconciliation_pending. At most 25 open gifts (409 gift_limit); 10 an hour per account and 30 per network address. Gift credits have no cash value and can't be refunded to cash.",
});
route("post", "/api/gifts/{id}/revoke", "Cancel an unclaimed gift", {
  response: { ...gift, properties: { ...gift.properties, available: number } },
  description:
    "Its credits come back at once (gift_return). 409 gift_not_open once it's claimed or returned; 404 gift_not_found for another account's gift. Unclaimed gifts also come back by themselves after 30 days, and when you wipe or close the account.",
});
route("post", "/api/gifts/peek", "Look at a gift before claiming it", {
  auth: null,
  body: object({ code: giftCode }, ["code"]),
  response: object({
    status: { enum: ["open", "claimed", "cancelled", "expired"] },
    amount: { ...integer, description: "Open gifts only" },
    note: { ...string, description: "Open gifts only" },
    expires: { ...integer, description: "Open gifts only" },
    own: { ...bool, description: "Open gifts only: you made it" },
  }),
  description:
    "No sign-in needed. The code goes in the body, never the URL. 400 gift_code_invalid or gift_code_typo (a wrong check symbol) never count as a guess; 404 gift_not_found does. 10 wrong codes an hour per account, or 30 per network address, lock out peeks and claims for the rest of that hour (429 gift_locked). 60 an hour per network address.",
});
route("post", "/api/gifts/claim", "Claim a gift", {
  body: object({ code: giftCode }, ["code"]),
  response: object({ status: { enum: ["claimed"] }, amount: integer, note: string, available: number }),
  description:
    "Exactly one account gets the credits (gift_in), in one transaction. 400 gift_own for your own gift; 410 gift_claimed or gift_returned; 409 gift_paused while the giver has a payment under reconciliation; 404 gift_not_found counts toward the lockout (429 gift_locked). The giver sees only that it was claimed and when, never by whom. 20 an hour per account and 60 per network address.",
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
    "Needs the insights update released (403 feature_unreleased otherwise); only the signed-in account's own ledger; 60 requests a minute. Days are UTC days, and the range is at most 366 of them (400 invalid_range or range_too_long). All sums are integer subcredits written as exact decimal strings, so net equals the ledger's own sum for the range and equals topups + received + rewards + team_transfers + other - spent - sent. spent is settled requests only (a released hold adds nothing), and daily, by_model, by_feature and by_source each add up to it. by_feature is chat, web_search, symposium, double_check, deep_research (chat requests labelled from this release on; off the record and Private only chat or web_search), image, video, speech, transcription. held is what is reserved right now, not a range figure. team_paid is what this account's Team pays requests cost Team Treasuries in the range: not this account's balance, so it is in no other figure and not exported. No prompts, replies or media are read.",
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
      "Authenticated account export: profile, ledger and deposits, request accounting, key metadata, session dates, connected apps, support tickets, accessible conversations, media metadata, uploads, reusable instructions and enabled account settings. Includes projects and pinned files, routines and reports, bookmarks, blind votes and Arena consent, audio scripts, canvases, slide decks, gifts, Inactivity Wipe settings, and Vault Sync ciphertext where present or released. Gift codes are never stored or exported. Vault Sync exports encrypted records and metadata, never a passphrase or plaintext. Sealed request records contain accounting metadata only. Two-step sign-in exports its enabled state, never its secret or recovery codes. Own shared contributions remain exportable after membership removal without other members' content. Passwords and key/session secrets are excluded. Media bytes are not embedded; download them before deletion. schemaVersion, exportedAt and units describe the format.",
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
// Inactivity Wipe (update "deadswitch", which also needs "wipe").
const nullableInt = { type: ["integer", "null"] };
const inactivityWipe = object({
  enabled: { ...bool, description: "Off (false) until the account chooses a period" },
  days: { type: ["integer", "null"], enum: [30, 90, 180, 365, null] },
  apiCounts: { ...bool, description: "Whether API keys and connected apps using the account count as activity (true unless unticked)" },
  lastActive: { ...nullableInt, description: "The last recorded activity: a sign-in, a signed-in request, or API use when apiCounts is on. Written at most once an hour, and only while the setting is on." },
  deadline: { ...nullableInt, description: "lastActive + days × 24 h + 1 h (the most a recorded time can lag). From then on the worker erases the account's content." },
  daysLeft: nullableInt,
  email: { ...bool, description: "The account has a verified email (the address itself isn't returned)" },
  emailReminders: { ...bool, description: "This server can send the reminder email: the same readiness as /api/config's services.email (test mode only records it). While false, no reminder is sent or recorded." },
  remindAt: { ...nullableInt, description: "When the one reminder email is due: 7 days before the deadline. Null unless emailReminders is true and the account has a verified email." },
  reminded: { ...nullableInt, description: "When this period's reminder was sent" },
  erased: { ...nullableInt, description: "When Inactivity Wipe last erased the account's content" },
  blocked: { type: ["object", "null"], properties: { code: { enum: ["requests_in_flight", "treasury_not_empty", "treasury_busy", "media_delete_failed", "failed"] }, at: integer }, description: "Why the last due erase is waiting; it's retried an hour later" },
  notice: { type: ["object", "null"], description: "The workspace's one-time notice: { kind: reset, deadline } after coming back in the last 7 days, or { kind: erased, at, days } after an erase" },
  options: array(integer),
  remindDays: integer,
  now: { ...integer, description: "The server's time for this answer" },
  push: {
    type: "object",
    properties: { remindAt: nullableInt, sent: bool },
    description: "Present only while Push Alerts is available and the account has a browser with the Inactivity Wipe reminder on: when the browser reminder is due (7 days before the deadline) and whether this period's was sent",
  },
});
route("get", "/api/inactivity-wipe", "Your Inactivity Wipe setting", {
  response: inactivityWipe,
  description:
    "Off until you choose a period. While it's on, the account's content is erased once it has gone the chosen number of days without a sign-in, a signed-in request or (if apiCounts) API or connected-app use. The erase is Panic Wipe's: the same content goes, API keys and connected apps are revoked, every session is signed out, and the account, balance, ledger, receipts and settings stay. It can't clear anything kept only in a browser. Scheduled Routines and Page Watch runs don't count as activity. While a request is running or a collab you own holds Team Treasury credits, the erase waits (blocked) and is retried hourly. Account export includes it as inactivityWipe; closing the account deletes it; Panic Wipe keeps it.",
});
route("put", "/api/inactivity-wipe", "Turn Inactivity Wipe on or off, or change it", {
  body: object({
    days: { type: ["integer", "null"], enum: [30, 90, 180, 365, null], description: "null turns it off and deletes the setting and its activity record" },
    api_counts: bool,
    confirm: { const: true, description: "Needed to turn it on or choose a shorter period (400 confirmation_required otherwise)" },
  }),
  response: inactivityWipe,
  description:
    "Omitted fields keep their value. Any change starts a new period from now and clears the reminder, a waiting erase and the notice. 400 invalid_days, invalid_api_counts, invalid_inactivity or confirmation_required. 60 changes an hour.",
});
route("delete", "/api/inactivity-wipe/notice", "Dismiss Inactivity Wipe's workspace notice", {
  response: inactivityWipe,
  description: "Clears the reset or erased notice; the setting is unchanged.",
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
// Model Status (update "status"; server/model-status.js).
const timing = (p90) => ({
  type: ["object", "null"],
  properties: { median: integer, ...(p90 ? { p90: integer } : {}) },
  description: "Milliseconds, rounded to 100; null with fewer than minSamples successful requests in the last hour",
});
const statusFields = {
  status: {
    enum: ["up", "degraded", "down", "unknown"],
    description: "From the share of requests that failed or timed out in the last 15 minutes (degraded from thresholds.degraded, down from thresholds.down); unknown with fewer than minSamples requests",
  },
  ttft: timing(true),
  total: { ...timing(false), description: "Median time to a complete reply or image, in milliseconds, rounded to 100; null with too few samples" },
};
route("get", "/api/status", "Model status", {
  auth: null,
  response: object({
    checkedAt: { ...integer, description: "When these numbers were computed (epoch ms), not when a model was last used" },
    windows: object({ statusMinutes: integer, timingMinutes: integer }),
    minSamples: integer,
    thresholds: object({ degraded: number, down: number }),
    families: array(
      object({
        name: { ...string, description: "The models' maker, as the catalog's owned_by" },
        ...statusFields,
        models: array(object({ id: string, name: string, type: string, ...statusFields })),
      }),
    ),
  }),
  description:
    "Public and the same for everyone; recomputed at most every 30 seconds (Cache-Control: public, max-age=30). Measured from this installation's own chat, image and video traffic, kept in memory for an hour and never per account: no account, prompt or reply is kept, and a restart clears it. Requests refused before sending, stopped by the person, or rejected by the provider as invalid (400, 413, 422) don't count. Every family with a released, callable model is listed; a family's models appear only once they have enough data. Not a promise from the provider.",
});
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
// Contract Reader (update "contractreader", with "onchain"; server/contract-
// reader.js). Explaining is an /api/chat request (and /api/quote estimate)
// carrying `contract`, described on POST /api/contracts.
const contractSummary = {
  id: string,
  chain: object({ id: integer, name: string }),
  address: { ...string, description: "The contract's address, checksummed" },
  name: { ...nullableString, description: "Its verified contract name, or its token name" },
  read_at: integer,
  forgotten_at: { ...integer, description: "When the cache drops it: 30 minutes after it was read" },
  forgotten_in: { ...integer, description: "Milliseconds until then, by the server's clock" },
};
const contractView = object({
  ...contractSummary,
  facts: {
    type: "object",
    description:
      "kind: contract; chain; address; name; token (name, symbol, decimals, supply); code_size; verified (via Sourcify or Blockscout, match, contract, compiler, files) or unverified: true; proxy (kind: EIP-1967, EIP-1967 beacon, ZeppelinOS, EIP-1167 clone or the verifier's own detection; implementation, implementation_name, implementation_verified); paused; control (who controls it, from live reads: owner, pending_owner, default_admin, upgrade_admin, admin_owner, beacon, role getters and default admin role members, each with address, type wallet, contract or none, renounced, via); bytecode (for unpublished code: size, selectors, and the functions matched in a built-in table with their group); checks (codes: unverified, implementation_unverified, upgradeable, paused, wallet_owner, wallet_admin, group); node (the host of the node read live); notes (no_live_reads, reads_incomplete, source_unavailable, sources_trimmed, proxy_source_skipped).",
  },
  files: array(
    object({
      path: string,
      lines: integer,
      bytes: integer,
      main: bool,
      flagged: { ...bool, description: "Injection Shield found text that reads like instructions to an AI (sent as data either way)" },
      sent: { ...bool, description: "Sent to the model when explaining" },
      functions: { ...array(object({ name: string, start: integer, end: integer })), description: "A sent file's function declarations, for citations" },
    }),
  ),
  sent: object({ files: integer, chars: integer, truncated: bool }),
  hidden_removed: { ...integer, description: "Injection Shield's invisible characters taken out of the source" },
  cached: { ...bool, description: "Already open for this account, so it wasn't read again (POST only)" },
});
route("post", "/api/contracts", "Read a contract", {
  body: object(
    {
      value: { ...string, maxLength: 2048, description: "A 0x address, or an explorer link to an address or token page (the link names the chain). Sent in the body so no access log records it." },
      chain: { enum: [4663, 1, 8453, 42161, 10], description: "Needed with a bare address" },
    },
    ["value"],
  ),
  status: 201,
  response: contractView,
  description:
    "Free and read only: nothing is signed, sent or connected. Read on the server from fixed public sources only (a fixed public JSON-RPC node per chain: Robinhood Chain's, ethereum-rpc.publicnode.com, mainnet.base.org, arb1.arbitrum.io and mainnet.optimism.io; sourcify.dev; and each chain's Blockscout but Robinhood Chain's), so the user's IP never reaches them; no user-supplied host, no redirects, JSON only, 8 seconds each, 1 MB from a node. A node is asked only eth_chainId, eth_getCode, eth_getStorageAt and eth_call; its chain id is checked once per 30 minutes and a mismatch is refused (502 contract_chain_mismatch). Code, the EIP-1967 and ZeppelinOS proxy slots and standard reads (owner(), getOwner(), pendingOwner(), defaultAdmin(), paused(), name(), symbol(), decimals(), totalSupply()) come from one JSON-RPC batch; a value is reported only when the contract's ABI or bytecode has the function. When a node doesn't answer, live reads are skipped with a note and the source is still read; facts.node names the node that was read. Verified source from Sourcify's v2 API, then the chain's Blockscout (not for Robinhood Chain); a proxy is followed one hop to its implementation's source. Unpublished code: its bytecode's PUSH4 selectors against a built-in table, never an online lookup. Source at most 1.5 MB and 400 files, the main contract and what it inherits from kept first. 400 contract_address, contract_chain; 404 contract_not_found; 502 contract_unavailable; 503 contract_busy; 429 contract_busy (one at a time) or rate_limit (8 a minute, 40 an hour; a mistyped address or a contract already open doesn't count). Kept in this server's memory for this account for 30 minutes, 3 at most; never logged or stored. Explaining is POST /api/chat with contract: { id, lang: en, zh or es }, a model and optionally ephemeral or private: the server builds the messages from this read (the facts and up to 90,000 characters of numbered code, comment lines left out, as escaped document blocks with Injection Shield's data notice), asks for a JSON reading with an 8,000-token reply budget lowered to the model's limits (400 contract_too_long), and holds exactly what POST /api/quote shows for the same body. Only a reply that reads as a reading is charged; a cut-short, unreadable or refused one is released (502 contract_cut_short, contract_unreadable, contract_refused). 400 invalid_contract when combined with other chat options; 404 contract_gone once forgotten. Saved as an ordinary conversation unless off the record or in Private Mode.",
});
route("get", "/api/contracts", "Contracts open now", {
  response: object({ data: array(object(contractSummary)), limit: { ...integer, description: "Contracts open at once (3)" } }),
  description: "Newest first. Only this account's, and only for 30 minutes after each was read.",
});
route("get", "/api/contracts/{id}", "One open contract", {
  response: contractView,
  description: "404 contract_gone once it's forgotten (30 minutes after it was read, or after DELETE).",
});
route("get", "/api/contracts/{id}/file", "One source file's text", {
  query: [{ name: "path", in: "query", required: true, schema: string }],
  response: object({ path: string, lines: integer, bytes: integer, text: string, sent: bool }),
  description: "A verified file that was kept, as read (invisible characters removed). 404 contract_file_not_found or contract_gone.",
});
route("delete", "/api/contracts/{id}", "Forget an open contract now", {
  response: object({ ok: bool }),
  description: "Drops it from the cache at once. 404 contract_gone when it isn't open.",
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
