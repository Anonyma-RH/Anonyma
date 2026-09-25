import express from "express";
import cookieParser from "cookie-parser";
import { uid, now, fail } from "./core.js";

// In-memory fixed-window limiter, keyed by account when signed in and by
// client address otherwise. Resets on restart and is per process.
export function createLimiter() {
  const rates = new Map();
  return (name, max, window) => (req, res, next) => {
    const key =
      name + ":" + (name === "api_ip" ? req.ip : req.user?.id || req.ip);
    let record = rates.get(key);
    if (!record || record.until < now())
      rates.set(key, (record = { count: 0, until: now() + window }));
    if (++record.count > max) {
      res.set("Retry-After", String(Math.ceil((record.until - now()) / 1000)));
      return next(
        Object.assign(new Error("Too many requests. Try again shortly."), {
          status: 429,
          code: "rate_limit",
        }),
      );
    }
    if (rates.size > 10000)
      for (const [key, r] of rates) if (r.until < now()) rates.delete(key);
    next();
  };
}

// Security headers, body parsing and same-origin checks for mutations.
export function applyMiddleware(app, cfg) {
  app.disable("x-powered-by");
  // Rate limits key on req.ip, which is the proxy's address unless the
  // proxy is trusted to report the client in X-Forwarded-For.
  app.set("trust proxy", cfg.trustProxy);
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
    });
    if (req.path.startsWith("/api") || req.path.startsWith("/v1"))
      res.set("Cache-Control", "no-store");
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
  app.use(express.json({ limit: "18mb" }));
  app.use((req, res, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      if (req.body == null) req.body = {};
      if (Array.isArray(req.body) || typeof req.body !== "object")
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
