import { balance, credits, usdUnits, callable, now } from "../core.js";
import { isPrivateModel } from "../private-mode.js";
import { connectLive } from "../releases.js";
import { limitsLive, spendingRoom } from "../spending-limits.js";
import { SEED_GUARD_HEADER } from "../seed-guard.js";
import { apiRateLimit } from "../api-boost.js";
import { viewerOf } from "../early-models.js";
import {
  ACCESS_PREFIX,
  authenticateAccessToken,
  connectionBudget,
  budgetLeft,
  resourceMetadataUrl,
} from "../oauth.js";

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
// Over a connected app, the tools describe that connection: its own budget,
// and (while it's private-only) only zero-data-retention models.
const CONNECTION_TOOLS = TOOLS.map((t) =>
  t.name === "balance"
    ? {
        ...t,
        description:
          "Show this connection's budget: remaining, spent and in-flight credits, and when it expires.",
      }
    : t.name === "ask"
      ? {
          ...t,
          description:
            "Run one chat completion against an ANONYMA model, charged to this connection's budget. Holds an estimate, then settles the exact usage — charged once, refunded on failure. A private-only connection can use only models list_models returns.",
        }
      : t.name === "list_models"
        ? {
            ...t,
            description:
              "List the AI chat models this connection can call: id, name, context length, price per 1M input/output tokens in credits, and whether the model has zero data retention (private).",
          }
        : t,
);
const toolsFor = (req) => (req.appConnection ? CONNECTION_TOOLS : TOOLS);
// Refusals over a connection speak of the connection, and never let the app
// work out the account's balance. reserve() checks the account balance
// before the allowance, so an app varying max_tokens could otherwise tell
// "the account can't cover this" from "the budget can't" and home in on
// the balance. So:
// - an ask only runs while the account's available balance covers what's
//   left of the budget (one fixed yes/no, which the app's own spending
//   can't move, since it lowers both sides alike), and so does the room
//   left under the account's own spending limits, when it has any;
// - a request too big to reserve always gets the same answer, stated in
//   the budget's terms, whichever check refused it.
const USED_UP = "This connection has used its full budget.";
const PAUSED = "This connection is paused. Its owner can resume it in ANONYMA.";
const CANT_SPEND =
  "This connection can't spend right now. Its owner can check it in ANONYMA.";
const tooBig = (left) =>
  `This request could cost more than the ${credits(left)} credits left on this connection's budget. Try a smaller max_tokens.`;
function connectionMessage(ctx, req, e) {
  if (e.code === "key_paused") return PAUSED;
  if (e.code === "key_expired")
    return "This connection has expired. Connect the app again.";
  if (
    ["insufficient_credits", "allowance_exhausted", "spending_limit"].includes(
      e.code,
    )
  ) {
    const left = budgetLeft(ctx.db, req.apiKey);
    return left > 0 ? tooBig(left) : USED_UP;
  }
  if (e.code === "payment_reconciliation_pending") return CANT_SPEND;
  return e.message;
}

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
  // A connection sees its own allowance, never the account's balance.
  if (req.appConnection) {
    const data = connectionBudget(ctx.db, req.apiKey, req.appConnection);
    return {
      content: [
        {
          type: "text",
          text: `Remaining: ${data.remaining} of ${data.budget} credits. Spent: ${data.spent}. In flight: ${data.in_flight}. Expires: ${new Date(data.expires_at).toISOString()}.${data.paused ? " Paused." : ""}`,
        },
      ],
      structuredContent: data,
    };
  }
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
function toolListModels(ctx, req) {
  const privateOnly = !!req.appConnection?.private_only;
  // Early Model Access: the account's own key follows the account; a
  // connected app never sees a model in its early days.
  const early = ctx.earlyModels.view(viewerOf(req));
  const data = ctx.models.snapshot.data
    .filter((m) => m.type === "chat" && callable(m, ctx.cfg))
    .filter((m) => !early.hides(m.id))
    .filter((m) => !privateOnly || isPrivateModel(m, ctx.cfg))
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
      private: isPrivateModel(m, ctx.cfg),
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
          : privateOnly
            ? "No private (zero data retention) chat models are available right now."
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
// is never saved as a conversation (api=true), and any generated images are
// dropped rather than stored, since the tool returns text only. A connected
// app that is private-only routes like Private Mode: zero data retention
// models only, never the backup gateway.
const refusal = (text) => ({ isError: true, content: [{ type: "text", text }] });
async function toolAsk(ctx, req, res, args) {
  const privateOnly = !!req.appConnection?.private_only;
  // Decided before anything is reserved, so the answer never depends on
  // the account's balance beyond the one yes/no described above.
  if (req.appConnection) {
    if (req.apiKey.paused_at != null) return refusal(PAUSED);
    const left = budgetLeft(ctx.db, req.apiKey);
    if (left <= 0) return refusal(USED_UP);
    if (balance(ctx.db, req.user.id).available < left)
      return refusal(CANT_SPEND);
    const room = limitsLive(ctx.cfg)
      ? spendingRoom(ctx.db, req.user.id)
      : null;
    if (room != null && room < left) return refusal(CANT_SPEND);
  }
  if (privateOnly) {
    const m = ctx.models.find(args.model);
    if (m && !isPrivateModel(m, ctx.cfg))
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "This connection can use private models only (zero data retention). Pick one from list_models.",
          },
        ],
      };
  }
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
    // Seed Guard's API opt-out travels with the MCP request.
    headers: req.headers[SEED_GUARD_HEADER] != null
      ? { [SEED_GUARD_HEADER]: req.headers[SEED_GUARD_HEADER] }
      : {},
    privateOnly,
    // A connected app pays the standard rate, so its charges and the pace of
    // its budget say nothing about the account behind it.
    standardRate: !!req.appConnection,
    discardMedia: true,
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
    const text =
      (req.appConnection ? connectionMessage(ctx, req, e) : e.message) ||
      "The request could not be completed.";
    return {
      isError: true,
      content: [{ type: "text", text }],
      ...(e.receipt
        ? { structuredContent: { credits_charged: e.receipt.credits_charged } }
        : {}),
    };
  } finally {
    for (const fn of closeListeners) res.off("close", fn);
  }
  const answer = captured?.choices?.[0]?.message?.content || "";
  const extension = captured?.anonyma || {};
  return {
    content: [{ type: "text", text: answer }],
    structuredContent: {
      model: captured?.model,
      usage: captured?.usage,
      credits_charged: extension.credits_charged,
      // A connection learns what's left of its own budget, not the account.
      ...(req.appConnection
        ? {
            budget_remaining: connectionBudget(ctx.db, req.apiKey, req.appConnection)
              .remaining,
          }
        : { balance_after: credits(balance(ctx.db, req.user.id).available) }),
      request_id: extension.request_id,
      // Present once Signed Receipts is released; verifiable at
      // /api/receipts/verify against the published key.
      ...(extension.signed_receipt
        ? { signed_receipt: extension.signed_receipt }
        : {}),
      // Present once Privacy Trail is released: where this prompt went
      // (server/privacy-trail.js), the same object as /v1's anonyma.privacy.
      ...(extension.privacy ? { privacy: extension.privacy } : {}),
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
    if (name === "list_models") return toolListModels(ctx, req);
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
        result = { tools: toolsFor(req) };
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
  const { app, db, cfg, apiAuth } = ctx;
  // What a failed Bearer auth tells an MCP client. Once Connect an App is
  // live it points at the protected resource metadata, so a client can start
  // OAuth; before that it must not, so clients never try.
  function challenge(tokenSent) {
    const parts = ['realm="anonyma"'];
    if (connectLive(cfg))
      parts.push(`resource_metadata="${resourceMetadataUrl(cfg)}"`, 'scope="mcp"');
    if (tokenSent) parts.push('error="invalid_token"');
    return "Bearer " + parts.join(", ");
  }
  // An API key (same authorization as /v1), or once Connect an App is live,
  // an OAuth access token. Access tokens are only accepted here.
  function mcpAuth(req, res, next) {
    const sent = req.headers.authorization;
    try {
      const bearer = sent?.match(/^Bearer (\S+)$/)?.[1];
      if (bearer?.startsWith(ACCESS_PREFIX) && connectLive(cfg)) {
        const found = authenticateAccessToken(db, bearer);
        if (!found) {
          const e = new Error("The access token is invalid, expired or revoked.");
          e.status = 401;
          e.code = "invalid_token";
          throw e;
        }
        req.user = found.user;
        req.apiKey = found.key;
        req.appConnection = found.connection;
        db.prepare("UPDATE api_keys SET last_used=? WHERE id=?").run(
          now(),
          found.key.id,
        );
        return next();
      }
      apiAuth(req, res, next);
    } catch (e) {
      if (e.status === 401) res.set("WWW-Authenticate", challenge(!!sent));
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
  // Counted with /v1 (server/api-boost.js); a connected app's requests
  // count for the account that approved it.
  const rateLimit = apiRateLimit(ctx, { oauth: true });
  app.post("/mcp", rateLimit, mcpAuth, async (req, res) => {
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
