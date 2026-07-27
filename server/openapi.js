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