import { now, fail, credits, uid, callable, balance } from "../core.js";
import { isPrivateModel } from "../private-mode.js";
import {
  SCOPE,
  EXPIRY_DAYS,
  DEFAULT_EXPIRY_DAYS,
  DEFAULT_BUDGET,
  MAX_BUDGET,
  MAX_REDIRECT_URIS,
  MAX_CLIENT_NAME,
  MAX_CONNECTION_NAME,
  AUTHORIZE_PARAMS,
  OAuthError,
  issuerOf,
  resourceOf,
  redirectKind,
  redirectHost,
  cleanName,
  checkAuthorization,
  errorRedirect,
  approveConnection,
  exchangeCode,
  refreshTokens,
  revokeToken,
  revokeConnection,
  connectionBudget,
  budgetLeft,
} from "../oauth.js";

// Connect an App. Public, cross-origin endpoints an app calls (discovery,
// registration, token, revocation) and the signed-in, same-origin endpoints
// behind the consent page and Account → Connected apps. Release gating for
// all of it is in releases.js (CONNECT_UPDATES).
const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };
const str = (v) => (typeof v === "string" ? v : undefined);

// A plain page for a request whose client or redirect URI can't be trusted.
// Nothing is sent back to the app. English and Chinese, since the language
// switch lives in the web app and this page is served without it.
function errorPage(cfg) {
  const home = issuerOf(cfg) + "/";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Connection request refused — ANONYMA</title><style>body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#0135df;color:#0e1a3a;display:grid;min-height:100vh;place-items:center;padding:16px;box-sizing:border-box}main{background:#fff;max-width:560px;padding:40px;border-radius:3px}p.eyebrow{font-size:11px;letter-spacing:1.3px;color:#4f5b73;margin:0 0 12px}h1{font-size:26px;line-height:1.25;margin:0 0 14px}p{margin:0 0 14px;color:#4f5b73}hr{border:0;border-top:1px solid #e3e8f0;margin:24px 0}a{display:inline-block;margin-top:8px;background:#0135df;color:#fff;padding:12px 18px;text-decoration:none;font-weight:600;border-radius:3px}</style></head><body><main><p class="eyebrow">ANONYMA · CONNECT AN APP</p><h1>This connection request can't be used.</h1><p>The app sent a client ID ANONYMA doesn't know, or a return address it never registered. Nothing was approved and nothing was sent back. Start the connection again from the app.</p><hr><h1 lang="zh-CN">无法使用此连接请求。</h1><p lang="zh-CN">该应用发送了 ANONYMA 无法识别的客户端 ID，或未注册的返回地址。未批准任何授权，也未返回任何内容。请在应用中重新发起连接。</p><a href="${home}">ANONYMA</a></main></body></html>`;
}

export function connectRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const issuer = () => issuerOf(cfg);

  // ---- Discovery (RFC 9728, RFC 8414) ----
  const protectedResource = (req, res) =>
    res.json({
      resource: resourceOf(cfg),
      authorization_servers: [issuer()],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "ANONYMA",
    });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);
  // No OpenID Connect: no userinfo, no id_token, no identity scopes, so no
  // /.well-known/openid-configuration either. MCP clients ask for this RFC
  // 8414 document first and only fall back to the OpenID one without it.
  app.get("/.well-known/oauth-authorization-server", (req, res) =>
    res.json({
      issuer: issuer(),
      authorization_endpoint: issuer() + "/oauth/authorize",
      token_endpoint: issuer() + "/oauth/token",
      registration_endpoint: issuer() + "/oauth/register",
      revocation_endpoint: issuer() + "/oauth/revoke",
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
      // URL client IDs would need server-side fetches of app-chosen URLs.
      client_id_metadata_document_supported: false,
    }),
  );

  // Preflight for the endpoints apps call from a browser. The CORS headers
  // themselves are set in middleware.js, before any error can answer.
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/oauth/register",
    "/oauth/token",
    "/oauth/revoke",
  ])
    app.options(path, (req, res) => res.status(204).end());

  const oauthError = (res, e) =>
    res
      .status(e.status)
      .set(noStore)
      .json({ error: e.oauth, error_description: e.message });

  // ---- Dynamic client registration (RFC 7591), public clients only ----
  app.post(
    "/oauth/register",
    limit("oauth_register", 20, 3600000),
    (req, res) => {
      res.set(noStore);
      const b = req.body;
      const refuse = (code, message) =>
        res.status(400).json({ error: code, error_description: message });
      if (!req.is("application/json"))
        return refuse("invalid_client_metadata", "Send client metadata as JSON.");
      const uris = b.redirect_uris;
      if (
        !Array.isArray(uris) ||
        !uris.length ||
        uris.length > MAX_REDIRECT_URIS ||
        !uris.every((u) => redirectKind(u))
      )
        return refuse(
          "invalid_redirect_uri",
          `Register 1–${MAX_REDIRECT_URIS} redirect URIs: https, http on localhost, 127.0.0.1 or [::1], or a private app scheme. No fragments.`,
        );
      if (
        b.token_endpoint_auth_method !== undefined &&
        b.token_endpoint_auth_method !== "none"
      )
        return refuse(
          "invalid_client_metadata",
          "Only public clients can register: token_endpoint_auth_method must be none.",
        );
      if (
        b.grant_types !== undefined &&
        (!Array.isArray(b.grant_types) ||
          !b.grant_types.includes("authorization_code") ||
          b.grant_types.some(
            (g) => !["authorization_code", "refresh_token"].includes(g),
          ))
      )
        return refuse(
          "invalid_client_metadata",
          "grant_types may be authorization_code and refresh_token.",
        );
      if (
        b.response_types !== undefined &&
        (!Array.isArray(b.response_types) ||
          b.response_types.some((r) => r !== "code"))
      )
        return refuse("invalid_client_metadata", "response_types may only be code.");
      const name = cleanName(b.client_name, MAX_CLIENT_NAME) || "Unnamed app";
      // The consent page says the name is self-reported; it still may not
      // pose as ANONYMA itself.
      if (/anonyma/i.test(name.replace(/[^a-z]/gi, "")))
        return refuse(
          "invalid_client_metadata",
          "client_name can't claim to be ANONYMA.",
        );
      const redirectUris = [...new Set(uris)];
      const id = uid("client_");
      const created = now();
      db.prepare(
        "INSERT INTO oauth_clients(id,name,redirect_uris,created,authorized) VALUES(?,?,?,?,NULL)",
      ).run(id, name, JSON.stringify(redirectUris), created);
      // Only what was accepted is echoed; logos, URLs and contacts an app
      // sends are neither stored nor shown.
      res.status(201).json({
        client_id: id,
        client_id_issued_at: Math.floor(created / 1000),
        client_name: name,
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE,
      });
    },
  );

  // ---- Authorization endpoint ----
  // A bad client or redirect URI gets an error page and is never redirected
  // to. Everything else goes to the consent page, which needs a signed-in
  // user. Other errors are reported to the app from there, by the user's
  // click, never by an automatic redirect: anyone can register a client, so
  // an instant error redirect would make this origin an open redirector
  // (RFC 9700 section 4.11.2).
  app.get(
    "/oauth/authorize",
    limit("oauth_authorize", 60, 60000),
    (req, res) => {
      res.set({ ...noStore, "Referrer-Policy": "no-referrer" });
      const check = checkAuthorization(db, cfg, req.query);
      if (check.fatal) return res.status(400).type("html").send(errorPage(cfg));
      const params = new URLSearchParams();
      for (const k of AUTHORIZE_PARAMS)
        if (typeof req.query[k] === "string") params.set(k, req.query[k]);
      res.redirect(302, "/connect?" + params);
    },
  );

  // ---- Token endpoint ----
  // Public clients identify themselves with client_id (in the body, or as
  // the user name of a Basic header). There are no client secrets.
  function clientOf(req, p) {
    let fromHeader;
    const basic = req.headers.authorization?.match(/^Basic ([A-Za-z0-9+/=]+)$/)?.[1];
    if (basic) {
      try {
        fromHeader = decodeURIComponent(
          Buffer.from(basic, "base64").toString("utf8").split(":")[0],
        );
      } catch {}
    }
    const clientId = str(p.client_id) ?? fromHeader;
    if (fromHeader && str(p.client_id) && fromHeader !== p.client_id)
      throw new OAuthError(400, "invalid_request", "Two different client IDs were sent.");
    const client =
      clientId && clientId.length <= 100
        ? db.prepare("SELECT id FROM oauth_clients WHERE id=?").get(clientId)
        : null;
    if (!client) throw new OAuthError(401, "invalid_client", "Unknown client_id.");
    return client.id;
  }
  const bodyOf = (req) =>
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
  app.post("/oauth/token", limit("oauth_token", 60, 60000), (req, res) => {
    res.set(noStore);
    const p = bodyOf(req);
    try {
      const grant = str(p.grant_type);
      if (grant !== "authorization_code" && grant !== "refresh_token")
        throw new OAuthError(
          400,
          grant ? "unsupported_grant_type" : "invalid_request",
          "grant_type must be authorization_code or refresh_token.",
        );
      const clientId = clientOf(req, p);
      res.json(
        grant === "authorization_code"
          ? exchangeCode(db, cfg, clientId, p)
          : refreshTokens(db, cfg, clientId, p),
      );
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      oauthError(res, e);
    }
  });

  // ---- Revocation (RFC 7009): always 200, even for an unknown token ----
  app.post("/oauth/revoke", limit("oauth_revoke", 60, 60000), (req, res) => {
    res.set(noStore);
    const p = bodyOf(req);
    const token = str(p.token);
    if (!token)
      return oauthError(
        res,
        new OAuthError(400, "invalid_request", "token is required."),
      );
    revokeToken(db, str(p.client_id), token);
    res.status(200).end();
  });

  // Body parse failures and rate limits on the app-facing endpoints come
  // back in the OAuth error shape rather than the app's own.
  app.use("/oauth", (err, req, res, next) => {
    if (req.method === "GET") return next(err);
    // Any body the parsers refused: malformed, too large, too many fields.
    if (err?.type && err.status >= 400 && err.status < 500 && err.status !== 429)
      return oauthError(
        res,
        new OAuthError(400, "invalid_request", "The request body could not be read."),
      );
    if (err?.status === 429)
      return oauthError(
        res,
        new OAuthError(429, "temporarily_unavailable", err.message),
      );
    next(err);
  });

  // ---- Consent (signed in, same origin, the app's usual CSRF checks) ----
  const privateModels = () =>
    ctx.models.snapshot.data.filter(
      (m) => m.type === "chat" && callable(m, cfg) && isPrivateModel(m, cfg),
    ).length;
  const FATAL_MESSAGE =
    "This connection request can't be used: the app sent an unknown client or a return address it never registered. Start again from the app.";
  const errorMessage = (check) =>
    `This connection request can't be used (${check.error}). Start again from the app.`;
  function consentRequest(q) {
    const check = checkAuthorization(db, cfg, q);
    if (check.fatal) fail(400, FATAL_MESSAGE, check.fatal);
    if (check.error) fail(400, errorMessage(check), check.error);
    return check;
  }
  const appJSON = (check) => ({
    name: check.client.name,
    redirect_uri: check.redirectUri,
    redirect_host: redirectHost(check.redirectUri),
    redirect_kind: redirectKind(check.redirectUri),
  });
  app.get("/api/connections/authorize", requireUser, (req, res) => {
    const check = checkAuthorization(db, cfg, req.query);
    if (check.fatal) fail(400, FATAL_MESSAGE, check.fatal);
    // A request from a known client and address that is otherwise wrong:
    // the signed-in user may send the error back to the app.
    if (check.error)
      return res.status(400).json({
        error: {
          message: errorMessage(check),
          code: check.error,
          type: "invalid_request_error",
          param: null,
        },
        app: appJSON(check),
        return_to: errorRedirect(cfg, check),
      });
    // An app can spend only while the balance covers what's left of its
    // budget (so it never learns the balance): start from one it covers.
    const available = credits(balance(db, req.user.id).available);
    res.json({
      app: appJSON(check),
      available,
      defaults: {
        name: check.client.name.slice(0, MAX_CONNECTION_NAME),
        budget: Math.min(DEFAULT_BUDGET, Math.max(1, Math.floor(available))),
        expiry_days: DEFAULT_EXPIRY_DAYS,
        private_only: true,
      },
      expiry_days: EXPIRY_DAYS,
      max_budget: MAX_BUDGET,
      private_models: privateModels(),
    });
  });
  app.post(
    "/api/connections/approve",
    requireUser,
    limit("connect_approve", 30, 3600000),
    (req, res) => {
      const check = consentRequest(req.body.request);
      const budget = Number(req.body.budget);
      if (
        typeof req.body.budget !== "number" ||
        !Number.isFinite(budget) ||
        budget < 1 ||
        budget > MAX_BUDGET
      )
        fail(
          400,
          `Choose a budget from 1 to ${MAX_BUDGET.toLocaleString("en-US")} credits.`,
          "invalid_budget",
        );
      const expiryDays = Number(req.body.expiry_days);
      if (!EXPIRY_DAYS.includes(expiryDays))
        fail(400, "Choose an expiry of 1, 7, 30 or 90 days.", "invalid_expiry");
      const name =
        cleanName(req.body.name, MAX_CONNECTION_NAME) ||
        check.client.name.slice(0, MAX_CONNECTION_NAME);
      const { redirect } = approveConnection(db, cfg, req.user, check, {
        name,
        budget: Math.floor(budget * 10000) / 10000,
        expiryDays,
        // Only an explicit false turns the private-models switch off.
        privateOnly: req.body.private_only !== false,
      });
      res.json({ redirect });
    },
  );
  app.post("/api/connections/deny", requireUser, (req, res) => {
    const check = consentRequest(req.body.request);
    res.json({
      redirect: errorRedirect(cfg, {
        ...check,
        error: "access_denied",
        description: "The request was declined.",
      }),
    });
  });

  // ---- Account → Connected apps ----
  const owned = (req) => {
    const c = db
      .prepare(
        "SELECT * FROM oauth_connections WHERE id=? AND user_id=? AND revoked IS NULL",
      )
      .get(req.params.id, req.user.id);
    if (!c) fail(404, "Connection not found.");
    return c;
  };
  function connectionJSON(c) {
    const key = db.prepare("SELECT * FROM api_keys WHERE id=?").get(c.key_id);
    const signedIn = !!db
      .prepare(
        "SELECT 1 FROM oauth_tokens WHERE connection_id=? AND kind='refresh' AND rotated IS NULL AND expires>? LIMIT 1",
      )
      .get(c.id, now());
    return {
      id: c.id,
      name: c.name,
      app_name: c.client_name,
      redirect_host: redirectHost(c.redirect_uri),
      redirect_kind: redirectKind(c.redirect_uri),
      created: c.created,
      activated: c.activated,
      last_used: key.last_used,
      private_only: !!c.private_only,
      expired: c.expires <= now(),
      signed_in: signedIn,
      // The app can't spend while the balance is below what's left of its
      // budget (see mcp.js); the owner is told, the app isn't.
      balance_short:
        budgetLeft(db, key) > balance(db, c.user_id).available,
      ...connectionBudget(db, key, c),
    };
  }
  app.get("/api/connections", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT * FROM oauth_connections WHERE user_id=? AND revoked IS NULL ORDER BY created DESC",
        )
        .all(req.user.id)
        .map(connectionJSON),
    }),
  );
  app.post("/api/connections/:id/pause", requireUser, (req, res) => {
    const c = owned(req);
    db.prepare(
      "UPDATE api_keys SET paused_at=COALESCE(paused_at,?) WHERE id=?",
    ).run(now(), c.key_id);
    res.json(connectionJSON(c));
  });
  app.post("/api/connections/:id/resume", requireUser, (req, res) => {
    const c = owned(req);
    db.prepare("UPDATE api_keys SET paused_at=NULL WHERE id=?").run(c.key_id);
    res.json(connectionJSON(c));
  });
  app.delete("/api/connections/:id", requireUser, (req, res) => {
    const c = owned(req);
    revokeConnection(db, c.id);
    res.json({ ok: true });
  });
  // Metadata only: when, which model, what it cost and the receipt's id.
  // Prompts and answers are never stored for a connection.
  app.get("/api/connections/:id/activity", requireUser, (req, res) => {
    const c = db
      .prepare("SELECT * FROM oauth_connections WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!c) fail(404, "Connection not found.");
    const prefix = req.user.id + ":";
    res.json({
      data: db
        .prepare(
          `SELECT l.id,l.amount,l.created,l.ref,l.description,h.result,
             (SELECT 1 FROM receipt_signatures r WHERE r.receipt_id=l.ref) signed
           FROM ledger l LEFT JOIN holds h ON h.id=l.ref
           WHERE l.key_id=? AND l.user_id=? ORDER BY l.created DESC,l.rowid DESC LIMIT 100`,
        )
        .all(c.key_id, req.user.id)
        .map((r) => {
          let model = null;
          try {
            model = JSON.parse(r.result || "null")?.model || null;
          } catch {}
          return {
            id: r.id,
            created: r.created,
            model: model || r.description,
            credits: credits(-r.amount),
            receipt_id: r.ref.startsWith(prefix) ? r.ref.slice(prefix.length) : r.ref,
            signed: !!r.signed,
          };
        }),
    });
  });
}
