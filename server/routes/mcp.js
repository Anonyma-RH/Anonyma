import { balance, credits, usdUnits, callable } from "../core.js";

// Remote MCP server (Streamable HTTP transport, JSON-RPC 2.0) at /mcp.
// No SDK: the protocol is small enough to implement directly here. Every
// request is stateless — no Mcp-Session-Id, no SSE stream — so GET and
// DELETE simply refuse with 405 and POST answers each message in full.
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];
const SERVER_VERSION = "1.0.0";
const MAX_BATCH = 20;

const TOOLS = [
  {
    name: "list_models",
    description:
      "List the AI chat models callable on this ANONYMA account: id, name, context length and price per 1M input/output tokens in credits.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ask",
    description:
      "Run one chat completion against an ANONYMA model, charged to the account's prepaid balance. Holds an estimate, then settles the exact usage — charged once, refunded on failure.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: "A callable chat model id. See list_models.",
        },
        prompt: { type: "string", description: "The user prompt." },
        system: {
          type: "string",
          description: "Optional system instruction.",
        },
        max_tokens: {
          type: "integer",
          minimum: 1,
          maximum: 8192,
          description: "Output token limit. Clamped to 8192.",
        },
      },
      required: ["model", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "balance",
    description: "Show the account's available and on-hold credit balance.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});
const validId = (id) =>
  id === null || typeof id === "string" || typeof id === "number";
const envelopeId = (msg) =>
  msg && typeof msg === "object" && !Array.isArray(msg) && validId(msg.id)
    ? msg.id
    : null;

function initializeResult(params) {
  const requested = params?.protocolVersion;
  return {
    protocolVersion: PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "anonyma", version: SERVER_VERSION },
  };
}
function toolBalance(ctx, req) {
  const b = balance(ctx.db, req.user.id);
  const data = { available: credits(b.available), held: credits(b.held) };
  return {
    content: [
      {
        type: "text",
        text: `Available: ${data.available} credits. On hold: ${data.held} credits.`,
      },
    ],
    structuredContent: data,
  };
}
function toolListModels(ctx) {
  const data = ctx.models.snapshot.data
    .filter((m) => m.type === "chat" && callable(m, ctx.cfg))
    .map((m) => ({
      id: m.id,
      name: m.name,
      context_length: m.context_length ?? null,
      input_price_per_1m_credits: credits(
        usdUnits(m.pricing?.input_per_1M_tokens || 0),
      ),
      output_price_per_1m_credits: credits(
        usdUnits(m.pricing?.output_per_1M_tokens || 0),
      ),
    }));
  return {
    content: [
      {
        type: "text",
        text: data.length
          ? data
              .map(
                (m) =>
                  `${m.id} — ${m.name} (${m.context_length ?? "?"} ctx, ${m.input_price_per_1m_credits}/${m.output_price_per_1m_credits} credits per 1M in/out)`,
              )
              .join("\n")
          : "No callable chat models right now.",
      },
    ],
    structuredContent: { models: data },
  };
}
// Runs the prompt through the exact same hold -> settle path as
// /v1/chat/completions (runChat with api=true, non-streaming), by handing it
// a synthetic req/res instead of a real HTTP response. Validation, pricing,
// gateway failover, failure billing, the ledger charge and the signed
// receipt are all the real thing; only the transport is faked. An MCP call
// is never private or ephemeral: runChat ignores both flags when api=true.
async function toolAsk(ctx, req, res, args) {
  const messages = [
    ...(typeof args.system === "string" && args.system.trim()
      ? [{ role: "system", content: args.system }]
      : []),
    { role: "user", content: args.prompt },
  ];
  const fakeReq = {
    body: {
      model: args.model,
      messages,
      max_tokens: args.max_tokens,
      stream: false,
    },
    user: req.user,
    apiKey: req.apiKey,
    headers: {},
  };
  let captured = null;
  // runChat watches the response for a client that leaves early (held until
  // the provider accepts, then stopped like /v1). Those listeners go on the
  // real MCP response and come off again once this call is done.
  const closeListeners = [];
  const fakeRes = {
    set() {
      return this;
    },
    flushHeaders() {},
    write() {},
    end() {},
    on(event, fn) {
      if (event === "close") {
        res.on("close", fn);
        closeListeners.push(fn);
      }
      return this;
    },
    json(payload) {
      captured = payload;
    },
    get destroyed() {
      return res.destroyed;
    },
    get writableEnded() {
      return res.writableEnded;
    },
  };
  try {
    await ctx.runChat(fakeReq, fakeRes, true);
  } catch (e) {
    return {
      isError: true,
      content: [
        { type: "text", text: e.message || "The request could not be completed." },
      ],
      ...(e.receipt
        ? { structuredContent: { credits_charged: e.receipt.credits_charged } }
        : {}),
    };
  } finally {
    for (const fn of closeListeners) res.off("close", fn);
  }
  const answer = captured?.choices?.[0]?.message?.content || "";
  const extension = captured?.anonyma || {};
  const after = balance(ctx.db, req.user.id);
  return {
    content: [{ type: "text", text: answer }],
    structuredContent: {
      model: captured?.model,
      usage: captured?.usage,
      credits_charged: extension.credits_charged,
      balance_after: credits(after.available),
      request_id: extension.request_id,
      // Present once Signed Receipts is released; verifiable at
      // /api/receipts/verify against the published key.
      ...(extension.signed_receipt
        ? { signed_receipt: extension.signed_receipt }
        : {}),
    },
  };
}
async function callTool(ctx, req, res, params) {
  const name = params?.name;
  if (!TOOL_NAMES.has(name)) {
    const e = new Error("Unknown tool: " + name);
    e.rpcCode = -32602;
    throw e;
  }
  const args =
    params?.arguments &&
    typeof params.arguments === "object" &&
    !Array.isArray(params.arguments)
      ? params.arguments
      : {};
  try {
    if (name === "balance") return toolBalance(ctx, req);
    if (name === "list_models") return toolListModels(ctx);
    return await toolAsk(ctx, req, res, args);
  } catch (e) {
    // Insufficient credits, model errors and provider refusals are tool
    // failures, not protocol errors: the call succeeded, the model didn't.
    return {
      isError: true,
      content: [{ type: "text", text: e.message || "Tool call failed." }],
    };
  }
}
async function handleOne(ctx, req, res, msg) {
  const invalid =
    typeof msg !== "object" ||
    msg === null ||
    Array.isArray(msg) ||
    msg.jsonrpc !== "2.0" ||
    typeof msg.method !== "string" ||
    (Object.hasOwn(msg, "id") && !validId(msg.id));
  if (invalid) return rpcError(envelopeId(msg), -32600, "Invalid Request");
  const notification = !Object.hasOwn(msg, "id");
  const id = msg.id;
  try {
    let result;
    switch (msg.method) {
      case "initialize":
        result = initializeResult(msg.params);
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call":
        result = await callTool(ctx, req, res, msg.params);
        break;
      default:
        // A notification for a method we don't know still gets no reply;
        // only a request (one with an id) is owed a protocol error.
        if (notification) return null;
        return rpcError(id, -32601, "Method not found: " + msg.method);
    }
    return notification ? null : rpcResult(id, result);
  } catch (e) {
    if (notification) return null;
    return rpcError(id, e.rpcCode || -32603, e.message || "Internal error");
  }
}

export function mcpRoutes(ctx) {
  const { app, limit, apiAuth } = ctx;
  // Same key authorization as /v1, plus the WWW-Authenticate header MCP
  // clients expect on a failed Bearer auth.
  function mcpAuth(req, res, next) {
    try {
      apiAuth(req, res, next);
    } catch (e) {
      if (e.status === 401) res.set("WWW-Authenticate", 'Bearer realm="anonyma"');
      throw e;
    }
  }
  const notAllowed = (req, res) =>
    res
      .set("Allow", "POST")
      .status(405)
      .json({
        error: {
          message: "The MCP endpoint only accepts POST.",
          code: "method_not_allowed",
        },
      });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
  app.post("/mcp", limit("api_ip", 120, 60000), mcpAuth, async (req, res) => {
    const body = req.body;
    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    if (!messages.length)
      return res.status(400).json(rpcError(null, -32600, "Invalid Request"));
    // The rate limit counts HTTP requests, so a batch is capped to keep one
    // request from carrying an unbounded number of paid calls.
    if (messages.length > MAX_BATCH)
      return res
        .status(400)
        .json(
          rpcError(
            null,
            -32600,
            `A batch can hold at most ${MAX_BATCH} messages.`,
          ),
        );
    // A client that hangs up mid-batch isn't sent the rest of its calls.
    let clientGone = false;
    res.once("close", () => (clientGone = !res.writableEnded));
    const results = [];
    for (const msg of messages) {
      if (clientGone) break;
      const r = await handleOne(ctx, req, res, msg);
      if (r) results.push(r);
    }
    // All notifications (including a lone notifications/initialized): no
    // JSON-RPC response is owed, so acknowledge with an empty 202.
    if (!results.length) return res.status(202).end();
    res.json(batch ? results : results[0]);
  });
  // A body that isn't valid JSON never reaches the handler above; the
  // shared parser rejects it first. Answer that as a JSON-RPC parse error
  // instead of the app's default JSON error shape.
  app.use("/mcp", (err, req, res, next) => {
    if (err?.type === "entity.parse.failed" || err instanceof SyntaxError)
      return res.status(400).json(rpcError(null, -32700, "Parse error"));
    next(err);
  });
}
