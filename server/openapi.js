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
              type: { enum: ["text", "image_url"] },
              text: string,
              image_url: object({ url: string }, ["url"]),
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
      description: "Clamped to 8192.",
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
    }),
    askr: object(),
  }),
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
      "Email/wallet linking requires an existing session. Sign-in responses set an HttpOnly session cookie. Codes and wallet challenges expire after 10 minutes.",
    response: path.endsWith("/send")
      ? object({ id: string, message: string })
      : path.endsWith("/challenge")
        ? object({ id: string, message: string })
        : ref("Session"),
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
  }),
  description:
    "The current tier is set by the lowest balance successful reads saw in the open 30-day cycle, with a read in the last 48 hours. cycle.due is what the cycle pays at its end at the current tier; waiting means it is due but needs a fresh read first.",
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
  }),
  description:
    "Credits paid and accounts rewarded over the 30 whole UTC days before today, and this month's roadmap vote counts per candidate. Never names or identifies an account.",
});
for (const [path, summary] of [
  [
    "/api/config",
    "Public service availability; configured does not mean verified",
  ],
  [
    "/api/models",
    "Model catalog including capability, pricing, private-mode and training metadata",
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
    "Each entry includes expires (epoch ms, or null for no auto-delete). An expired-but-not-yet-purged conversation is already excluded.",
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
    "Always SSE via fetch POST, not EventSource. Retains latest 20 messages. Parse data events across arbitrary byte boundaries; final usage event includes conversationId, askr and anonyma receipt, followed by [DONE]. Abort cancels work and settles delivered usage. Errors can follow HTTP 200. Use a stable requestId or Idempotency-Key; duplicates return 409, not a new charge. See the request body's private field for Private Mode.",
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
    "Any member. Moves available credits atomically as a linked treasury_contribution ledger pair; the treasury is a hidden ledger account created on the first contribution. Contributed credits belong to the treasury, which its owner controls, and can't be taken back. Repeats return 200. 402 insufficient_credits; 409 payment_reconciliation_pending while the contributor has a credited payment under reconciliation.",
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
  response: object({
    code: string,
    link: string,
    percent: number,
    invited: integer,
    earned: number,
  }),
  description:
    "Sign-ups through the link (the ref query parameter sets the anonyma_ref cookie) are attributed to you. You earn percent of each credited deposit they make; the reward is reversed if that deposit is reversed.",
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
    "Moves available credits atomically as a linked transfer_out/transfer_in ledger pair. Reusing a requestId returns the original transfer instead of sending again. Paused while a credited payment is under reconciliation.",
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
      "Authenticated account export: profile, full ledger and deposits, request accounting, video jobs, key metadata, active session dates, account-linked support tickets, media metadata and accessible conversations. Own shared contributions remain exportable after membership removal, without other members content. Passwords, key/session secrets and hashes are excluded. Media bytes are not embedded; download before deletion. schemaVersion, exportedAt and units describe the format.",
  },
);
route("delete", "/api/account", "Close account and forfeit unused credits", {
  body: object({ confirm: { const: "DELETE" } }, ["confirm"]),
  response: ref("Ok"),
  description:
    "409 while holds or unresolved invoices exist, or while an owned collab's Team Treasury holds any credits (treasury_not_empty: withdraw or spend them first) or has team-paid requests in progress (treasury_busy). Deletes personal content, saved media files, account-linked tickets, video jobs, sessions and owned collaborations. Clears profile identifiers and API-key hashes/names/prefixes. Other owners shared content, financial records and external copies remain. Retained accounting has no automatic expiry. Media removal errors prevent a success response and may require retry; deletion does not erase provider copies or existing backups.",
});
route("get", "/v1", "Free API connection check", {
  auth: null,
  description:
    "Optional Bearer key includes balance/key metadata. An absent or invalid key returns authenticated: false rather than 401. Terminal user agents receive plain text; other clients receive JSON. No credits are charged.",
});
route("get", "/v1/models", "List API-callable models", {
  auth: "bearer",
  description:
    "Returns {object: list, data: [{id, object: model, owned_by, created}]}. Includes callable chat and image entries; chat completions accepts chat models only. Use /api/models type metadata to choose a chat model. Once the Training Labels update is released, a model whose provider says it uses what you send to improve its products carries trains_on_prompts: true, plus untrained_alternative (the id of the listed version that isn't used that way) when there is one; /api/models carries the same as trainsOnPrompts and untrainedAlternative.",
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
    "stream=true returns SSE; false/default returns JSON. Retains latest 40 usable string-content messages; array content is skipped. Maximum total text 120,000 characters; body 256 KB. Other optional parameters such as temperature, tools and response_format are ignored. Tool calling, audio, embeddings and Responses are not implemented. web_search=true or plugins: [{id: web}] requests web search and its fee. Idempotency-Key (1–200 characters) overrides requestId; repeats return 409 duplicate_request without replaying output or charging again. Missing IDs generate a new request, so transport retries without an ID can create another charge. Errors use {error: {message, code, type, param}}. SSE errors may occur after HTTP 200; inspect every event through [DONE]. Timeouts and unreadable provider responses can charge the base estimate; see /docs/billing. Final SSE usage and JSON include askr.credits_charged and anonyma.credits_charged.",
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
      "Stateless: no Mcp-Session-Id, no SSE stream. Methods: initialize, ping, tools/list, tools/call (list_models, ask, balance). A notification (no id) is acknowledged with 202 and no body. Unknown methods return -32601; malformed input returns -32700/-32600. Same key authorization, rate limits and caps as /v1. Requires the api update released as well as mcp. Once Connect an App is live, an OAuth access token also works here (and only here): its tools report that connection's own budget, and a private-only connection lists and runs zero-data-retention models only. A 401 then carries WWW-Authenticate resource_metadata for OAuth discovery.",
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
  " Every request holds its worst-case cost against the key first: a paused key (403 key_paused), an expired allowance (403 key_expired), a used-up allowance (402 allowance_exhausted) or the rolling 24-hour cap (429 key_cap_exceeded) refuses it before any provider work. Idempotency-Key or requestId works as on chat completions.";
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
