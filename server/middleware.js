import express from "express";
import cookieParser from "cookie-parser";
import { uid, fail } from "./core.js";

import {
  securityHeaders,
  PREVIEW_FRAME_PATH,
} from "../src/security-headers.js";
import { isReleased } from "./releases.js";
import { SEALED_MAX_BODY_BYTES } from "../src/sealed.js";
export { createLimiter } from "./rate-limit.js";

// The Connect an App endpoints that apps call from anywhere: discovery,
// registration, token and revocation. They take no cookies and read no
// session, so they allow any origin without credentials.
export const PUBLIC_OAUTH_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
];
// Security headers, body parsing and same-origin checks for mutations.
export function applyMiddleware(app, cfg) {
  app.disable("x-powered-by");
  // Rate limits key on req.ip, which is the proxy's address unless the
  // proxy is trusted to report the client in X-Forwarded-For.
  app.set("trust proxy", cfg.trustProxy);
  app.use((req, res, next) => {
    // Live Preview's frame document is the only page the app may frame, and
    // only once that update is live (src/security-headers.js).
    res.set(
      securityHeaders({
        previewFrame: isReleased(cfg, "preview")
          ? cfg.origin + PREVIEW_FRAME_PATH
          : null,
      }),
    );
    // Routing ignores case, so these checks do too.
    const path = req.path.toLowerCase();
    if (
      req.path.startsWith("/api") ||
      req.path.startsWith("/v1") ||
      req.path === "/mcp" ||
      path.startsWith("/oauth/")
    )
      res.set("Cache-Control", "no-store");
    // The consent page and the authorization endpoint carry the request
    // (and, on the way back, the code) in their URLs: never send them on.
    if (path === "/connect" || path.startsWith("/oauth/"))
      res.set("Referrer-Policy", "no-referrer");
    if (PUBLIC_OAUTH_PATHS.includes(path))
      res.set({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, MCP-Protocol-Version",
        "Access-Control-Max-Age": "600",
      });
    next();
  });
  app.use((req, res, next) => {
    if (!cfg.production) return next();
    if (req.secure) {
      res.set("Strict-Transport-Security", "max-age=31536000");
      return next();
    }
    // The private platform health probe exposes no account data or session cookie.
    if (req.path === "/health" && ["GET", "HEAD"].includes(req.method))
      return next();
    if (["GET", "HEAD"].includes(req.method))
      return res.redirect(308, cfg.origin + req.originalUrl);
    return res.status(426).json({
      error: {
        message: "Use HTTPS for this request.",
        code: "https_required",
        type: "invalid_request_error",
        param: null,
      },
    });
  });
  app.use("/v1", express.json({ limit: "256kb" }));
  // The MCP server runs the same requests as /v1, under the same body limit.
  app.use("/mcp", express.json({ limit: "256kb" }));
  // OAuth token and revocation requests are form-encoded (JSON also works).
  app.use(
    ["/oauth/token", "/oauth/revoke"],
    express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 20 }),
  );
  app.use("/oauth", express.json({ limit: "16kb" }));
  // Sealed Mode's relay takes EHBP ciphertext as it is: read raw (it still
  // declares application/json, as EHBP keeps the original type), never parsed.
  app.use(
    "/api/sealed/chat",
    express.raw({ type: () => true, limit: SEALED_MAX_BODY_BYTES }),
  );
  app.use(express.json({ limit: "18mb" }));
  app.use((req, res, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      if (req.body == null) req.body = {};
      // /mcp accepts a single JSON-RPC message or a batch array.
      const arrayOk = req.path === "/mcp" && Array.isArray(req.body);
      if (!arrayOk && (Array.isArray(req.body) || typeof req.body !== "object"))
        return next(
          Object.assign(new Error("Send a JSON object."), {
            status: 400,
            code: "invalid_body",
          }),
        );
    }
    next();
  });
  app.use(cookieParser());
  app.use((req, res, next) => {
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      !req.path.startsWith("/v1") &&
      req.path !== "/mcp" &&
      !PUBLIC_OAUTH_PATHS.includes(req.path.toLowerCase()) &&
      req.path !== "/api/payments/ipn"
    ) {
      if (req.headers.origin && req.headers.origin !== cfg.origin)
        return next(
          Object.assign(new Error("Request origin is not allowed."), {
            status: 403,
          }),
        );
      if (req.method !== "DELETE" && !req.is("application/json"))
        return next(
          Object.assign(new Error("Use application/json."), { status: 415 }),
        );
    }
    next();
  });
}
export function requestIdentifier(req) {
  const value = req.headers["idempotency-key"] ?? req.body.requestId ?? uid();
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    fail(
      400,
      "Request ID must contain 1–200 characters.",
      "invalid_request_id",
    );
  return value;
}
export function errorHandler(cfg) {
  return (e, req, res, next) => {
    if (res.headersSent) return next(e);
    res.status(e.status || 500).json({
      error: {
        message: e.status
          ? e.message
          : cfg.testMode
            ? e.message
            : "An internal error occurred. Please try again.",
        code: e.code || "server_error",
        type:
          e.status === 401
            ? "authentication_error"
            : e.status === 402
              ? "insufficient_quota"
              : e.status === 429
                ? "rate_limit_error"
                : e.status >= 500
                  ? "api_error"
                  : "invalid_request_error",
        param: null,
      },
      ...(e.billing ? { billing: e.billing } : {}),
      // Spending Limits: which limit refused the request and when room frees.
      ...(e.spendingLimit ? { spending_limit: e.spendingLimit } : {}),
      ...(e.receipt
        ? {
            askr: { credits_charged: e.receipt.credits_charged },
            anonyma: { credits_charged: e.receipt.credits_charged },
          }
        : {}),
    });
    if (!e.status) console.error(e.message);
  };
}
