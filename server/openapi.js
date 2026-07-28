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
    mode: { enum: ["chat", "code"] },
    stream: bool,
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
    ...chat.properties,
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
  }),
  Session: object({ user: { oneOf: [ref("User"), { type: "null" }] } }, [
    "user",
  ]),
  ChatRequest: chat,
  ApiChatRequest: apiChat,
  Media: object({
    id: string,
    kind: { enum: ["image", "video"] },
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
    credited: integer,
    created: integer,
    updated: integer,
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
    anonyma: object({ credits_charged: number, request_id: string }),
    askr: object(),
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
};
const paths = {};
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
for (const [path, summary] of [
  [
    "/api/config",
    "Public service availability; configured does not mean verified",
  ],
  ["/api/models", "Model catalog including capability and pricing metadata"],
  ["/api/market", "Public cryptocurrency market feed"],
  ["/api/rates", "Crypto units per USD; validated rates cached for 60 seconds"],
  ["/health", "Process health; HTTP 200 does not certify upstream readiness"],
])
  route("get", path, summary, { auth: null });
route("get", "/api/conversations", "List latest 300 conversations", {
  response: object({ data: array(object()) }),
});
route("post", "/api/conversations", "Create conversation", {
  body: object({ title: string, mode: string }),
  response: object({ id: string }),
  status: 201,
});
route(
  "get",
  "/api/conversations/export",
  "Download all saved conversations as JSON",
);
route("delete", "/api/conversations", "Delete all owned conversations", {
  response: ref("Ok"),
});
route(
  "get",
  "/api/conversations/{id}",
  "Read conversation and decoded messages",
);
route("patch", "/api/conversations/{id}", "Rename conversation", {
  body: object({ title: string }, ["title"]),
  response: ref("Ok"),
});
route("delete", "/api/conversations/{id}", "Delete conversation", {
  response: ref("Ok"),
});
route("post", "/api/quote", "Estimate maximum reserved credits", {
  body: object(
    {
      ...chat.properties,
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
    "Estimate only. Final charge follows usage and the documented failure-billing policy.",
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
route("post", "/api/chat", "Stream chat, code or compatible image output", {
  body: ref("ChatRequest"),
  stream: true,
  description:
    "Always SSE via fetch POST, not EventSource. Retains latest 20 messages. Parse data events across arbitrary byte boundaries; final usage event includes conversationId, askr and anonyma receipt, followed by [DONE]. Abort cancels work and settles delivered usage. Errors can follow HTTP 200. Use a stable requestId or Idempotency-Key; duplicates return 409, not a new charge.",
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
  "get",
  "/api/deposits/{id}",
  "Read invoice and refresh pending processor status",
  { response: ref("Deposit") },
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
route("post", "/api/support", "Persist operator support ticket", {
  body: object(
    {
      subject: { ...string, maxLength: 200 },
      body: { ...string, maxLength: 10000 },
    },
    ["subject", "body"],
  ),
  status: 201,
  response: object({ id: string, message: string }),
  description:
    "Stored locally for operator review; no external email is sent by this endpoint.",
});
route(
  "get",
  "/api/account/export",
  "Download account JSON; financial raw fields use ledger subunits",
);
route("delete", "/api/account", "Close account and forfeit unused credits", {
  body: object({ confirm: { const: "DELETE" } }, ["confirm"]),
  response: ref("Ok"),
  description:
    "409 while holds or unresolved invoices exist. Revokes sessions and keys, removes content, retains immutable financial records under a tombstone ID.",
});