import https from "node:https";
import http from "node:http";
import { hash, now, settle, usdUnits, tokenCost, credits } from "./core.js";
import { isReleased } from "./releases.js";
import { chatLimits } from "../data/chat-limits.js";
import {
  isSealedModel,
  enclaveModelId,
  sealedHoldUsd,
  responseByteCap,
  parseUsageMetrics,
  INPUT_OVERHEAD_TOKENS,
} from "../src/sealed.js";

// Sealed Mode, server side: relaying, holds and settlement. The browser
// encrypts each request to an attested enclave (src/sealed-client.js); this
// server only ever handles ciphertext, which it forwards to PPQ's private
// endpoint with ANONYMA's gateway key and streams back unread. It never logs
// or stores a body.
//
// Billing, since the model's usage is inside the ciphertext:
// - The hold covers the worst case at the model's catalog price: every
//   ciphertext byte as an input token, plus the sealed output cap. A request
//   whose worst case is above SEALED_MAX_HOLD_USD is refused before anything
//   is sent.
// - SEALED_BILLING=trailer settles from Tinfoil's X-Tinfoil-Usage-Metrics
//   trailer (its token counts, at the catalog price). Node's fetch can't read
//   trailers, hence node:https.
// - With no usable trailer (or SEALED_BILLING=reconcile) the hold is KEPT,
//   neither released nor charged in full, and the request is marked
//   reconcile_pending until PPQ's query history settles it (SEALED_RECONCILE).
// - As in chat, a request the provider never accepted (an attestation-key
//   mismatch, an error, no answer) is released with no charge, and one that
//   was accepted is charged, including after Stop.

// Whether Sealed Mode can run here: billing configured, and a gateway key
// (or local test mode, whose fixtures stand in for PPQ).
export function sealedReady(cfg) {
  return (
    ["trailer", "reconcile"].includes(cfg.sealedBilling) &&
    (!!cfg.sealedGatewayKey || cfg.testMode)
  );
}
export const sealedLive = (cfg) => isReleased(cfg, "sealed") && sealedReady(cfg);

// The reply budget a sealed request is held for, and the client asks for.
export const sealedOutputCap = (m, cfg) =>
  Math.min(chatLimits(m).maxOutputTokens, cfg.sealedMaxOutputTokens);

// The hold for `ciphertextBytes` of sealed request to model `m`, in integer
// subcredits at the account's rate `factor`.
export function sealedHold(m, cfg, ciphertextBytes, factor) {
  const outputCap = sealedOutputCap(m, cfg);
  const usd = sealedHoldUsd(m, ciphertextBytes, outputCap);
  return {
    inputBound: ciphertextBytes + INPUT_OVERHEAD_TOKENS,
    outputCap,
    amount: Math.ceil(usdUnits(usd) * factor),
    cap: Math.ceil(usdUnits(cfg.sealedMaxHoldUsd) * factor),
  };
}

const base = (cfg) => cfg.sealedGateway.replace(/\/$/, "");

// ---- The attestation passthrough ----
// The bundle is public and the browser verifies it itself, so the relay only
// fetches and forwards it (no key is sent), cached for a minute. PPQ serves
// it at /private/attestation (Tinfoil's router enclave).
export function createAttestationCache(cfg, ttl = 60000) {
  let cached = null;
  // `fresh` skips the cache: the browser asks for it after the enclave
  // rotated its key, when the cached bundle names the old one.
  return async function attestation({ fresh = false } = {}) {
    if (!fresh && cached && now() - cached.at < ttl) return cached.bundle;
    const response = await fetch(base(cfg) + "/private/attestation", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw Object.assign(Error("attestation " + response.status), { status: response.status });
    const text = await response.text();
    if (text.length > 512 * 1024) throw Error("attestation too large");
    const bundle = JSON.parse(text);
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
      throw Error("attestation is not an object");
    cached = { at: now(), bundle };
    return bundle;
  };
}

// ---- The relay ----
// POSTs the sealed body to PPQ's private endpoint and resolves with the
// upstream response (an IncomingMessage), whose trailers are readable after
// its 'end'. The body and the Ehbp-* header pass through byte for byte.
export function relayUpstream(cfg, { body, model, encapsulatedKey, signal }) {
  const url = new URL(base(cfg) + "/private/v1/chat/completions");
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: "POST",
        signal,
        headers: {
          authorization: `Bearer ${cfg.sealedGatewayKey}`,
          "content-type": "application/json",
          "content-length": body.length,
          "ehbp-encapsulated-key": encapsulatedKey,
          "x-private-model": model,
          // Ask the enclave for its usage record, and say trailers are welcome.
          "x-tinfoil-request-usage-metrics": "true",
          te: "trailers",
          "x-query-source": "api",
        },
      },
      resolve,
    );
    req.on("error", reject);
    req.end(body);
  });
}
// Reads at most `limit` bytes of a (plaintext error) response.
export function readSmall(stream, limit = 65536) {
  return new Promise((resolve) => {
    const parts = [];
    let size = 0;
    stream.on("data", (c) => {
      if (size < limit) parts.push(c.subarray(0, limit - size));
      size += c.length;
    });
    stream.on("end", () => resolve(Buffer.concat(parts)));
    stream.on("error", () => resolve(Buffer.concat(parts)));
    stream.on("aborted", () => resolve(Buffer.concat(parts)));
  });
}
// The key-rotation refusal EHBP clients re-attest on (ehbp's
// KeyConfigMismatchError): passed to the browser as it came.
export const isKeyConfigProblem = (status, contentType) =>
  status === 422 && /^application\/problem\+json\b/i.test(contentType || "");

// An upstream refusal in the service's words. Nothing was accepted, so
// nothing is charged; the gateway account's own problems (401/402/403) are
// never described to the user.
export function refusal(status) {
  if ([401, 402, 403].includes(status)) {
    console.error(
      `Sealed relay: the private endpoint refused the gateway account (${status}). Check the sealed gateway key and its funding.`,
    );
    return { status: 503, code: "provider_unavailable", message: "The AI provider is temporarily unavailable. Nothing was charged." };
  }
  if (status === 429)
    return { status: 503, code: "provider_busy", message: "The AI provider is busy. Nothing was charged; try again shortly." };
  if (status >= 500)
    return { status: 502, code: "provider_down", message: `The private endpoint is having trouble (${status}). Nothing was charged.` };
  return { status: 400, code: "provider_rejected", message: `The private endpoint rejected this sealed request (${status}). Nothing was charged.` };
}

// ---- Settlement ----
const SELECT = "SELECT * FROM sealed_requests WHERE hold_id=?";
// Settles a relayed request from the enclave's usage record, or marks it
// reconcile_pending with its hold kept. Returns the updated row.
export function finishSealed(db, cfg, m, holdId, { outcome, metrics, responseBytes }) {
  const row = db.prepare(SELECT).get(holdId);
  const at = now();
  const mismatch =
    metrics?.model != null &&
    metrics.model !== enclaveModelId(m.id) &&
    metrics.model !== m.id;
  if (
    cfg.sealedBilling === "trailer" &&
    outcome === "complete" &&
    metrics &&
    !mismatch
  ) {
    const dollars = tokenCost(m, metrics.prompt, metrics.completion);
    const usage = {
      prompt_tokens: metrics.prompt,
      completion_tokens: metrics.completion,
      total_tokens: metrics.prompt + metrics.completion,
    };
    const receipt = settle(db, holdId, usdUnits(dollars * row.factor), m.name, {
      model: m.id,
      usage,
      sealed: true,
    });
    db.prepare(
      "UPDATE sealed_requests SET status='settled',reason='trailer',usage=?,charged=?,response_bytes=?,finished=?,settled=? WHERE hold_id=?",
    ).run(
      JSON.stringify({ ...usage, cost_usd: metrics.cost_usd }),
      receipt.charged,
      responseBytes,
      at,
      at,
      holdId,
    );
  } else {
    const reason =
      cfg.sealedBilling === "reconcile" && outcome === "complete"
        ? "reconcile_mode"
        : mismatch
          ? "model_mismatch"
          : outcome === "complete"
            ? "no_trailer"
            : outcome;
    db.prepare(
      "UPDATE sealed_requests SET status='reconcile_pending',reason=?,usage=?,response_bytes=?,finished=? WHERE hold_id=?",
    ).run(
      reason,
      metrics ? JSON.stringify({ prompt_tokens: metrics.prompt, completion_tokens: metrics.completion, cost_usd: metrics.cost_usd, model: metrics.model }) : null,
      responseBytes,
      at,
      holdId,
    );
  }
  return db.prepare(SELECT).get(holdId);
}

// What the browser (and the account export) may see about a sealed request.
export function sealedView(row, requestId = row?.request_id) {
  if (!row) return null;
  const usage = row.usage ? JSON.parse(row.usage) : null;
  return {
    requestId,
    status: row.status,
    model: row.model,
    held: credits(row.held),
    charged: row.charged == null ? null : credits(row.charged),
    usage: usage && row.status === "settled"
      ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens }
      : null,
    reason: row.reason || null,
    ciphertextBytes: row.ciphertext_bytes,
    responseBytes: row.response_bytes,
    created: row.created,
    finished: row.finished,
  };
}

// ---- Reconciliation against PPQ's query history ----
// GET /queries/history (Bearer key) returns { data: [{ timestamp, model,
// input_count, output_count, price_in_usd, query_source, api_key_id, … }],
// pagination: { page, total_pages } } for the key's own queries. It carries
// no request id, so a held request settles only from a row that matches it
// alone and that no other held request could claim: its model, a timestamp
// between the request's start (less a minute) and its end (plus five), and
// input tokens no more than its ciphertext allows. Anything ambiguous stays
// held for the next pass, or for the operator.
export const RECONCILE_DELAY_MS = 60000;
export const WINDOW_BEFORE_MS = 60000;
export const WINDOW_AFTER_MS = 300000;
const STALE_RELAY_MS = 900000;
const MAX_PAGES = 20;

export async function fetchHistory(cfg, { start, end }, fetchImpl = fetch) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(base(cfg) + "/queries/history");
    url.searchParams.set("start_date", new Date(start).toISOString());
    url.searchParams.set("end_date", new Date(end).toISOString());
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_count", "100");
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${cfg.sealedGatewayKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("query history " + response.status);
    const body = await response.json();
    if (!Array.isArray(body?.data)) throw Error("query history has no data");
    rows.push(...body.data);
    const pages = Number(body.pagination?.total_pages) || 1;
    if (page >= pages) break;
  }
  return rows;
}
const rowTime = (r) => Date.parse(r?.timestamp);
const rowRef = (r) =>
  hash(
    [r.timestamp, r.model, r.input_count, r.output_count, r.price_in_usd, r.api_key_id, r.query_source]
      .map((v) => String(v ?? ""))
      .join("|"),
  );
const validRow = (r) =>
  Number.isFinite(rowTime(r)) &&
  typeof r.model === "string" &&
  Number.isSafeInteger(r.input_count) &&
  r.input_count >= 0 &&
  Number.isSafeInteger(r.output_count) &&
  r.output_count >= 0 &&
  typeof r.price_in_usd === "number" &&
  Number.isFinite(r.price_in_usd) &&
  r.price_in_usd >= 0;

export function createSealedReconciler({ db, cfg, models, history = fetchHistory }) {
  let running = null;
  async function pass(at = now()) {
    const pending = db
      .prepare(
        "SELECT * FROM sealed_requests WHERE status='reconcile_pending' AND finished<? ORDER BY created LIMIT 200",
      )
      .all(at - RECONCILE_DELAY_MS);
    if (!pending.length) return { settled: 0, pending: 0 };
    const start = Math.min(...pending.map((p) => p.created)) - WINDOW_BEFORE_MS;
    const end = Math.max(...pending.map((p) => p.finished)) + WINDOW_AFTER_MS;
    const claimed = new Set(
      db
        .prepare("SELECT reconcile_ref FROM sealed_requests WHERE reconcile_ref IS NOT NULL")
        .all()
        .map((r) => r.reconcile_ref),
    );
    const rows = (await history(cfg, { start, end }))
      .filter(validRow)
      .map((r) => ({ ...r, ref: rowRef(r) }))
      .filter((r) => !claimed.has(r.ref));
    const fits = (p, r) => {
      const t = rowTime(r);
      return (
        (r.model === p.model || r.model === enclaveModelId(p.model)) &&
        t >= p.created - WINDOW_BEFORE_MS &&
        t <= p.finished + WINDOW_AFTER_MS &&
        r.input_count <= p.input_bound
      );
    };
    let settled = 0;
    for (const p of pending) {
      const mine = rows.filter((r) => fits(p, r));
      if (mine.length !== 1) continue;
      const [row] = mine;
      if (pending.filter((q) => fits(q, row)).length !== 1) continue;
      const m = models.find(p.model);
      const receipt = settle(
        db,
        p.hold_id,
        usdUnits(row.price_in_usd * p.factor),
        "Reconciled: " + (m?.name || p.model),
        {
          model: p.model,
          usage: {
            prompt_tokens: row.input_count,
            completion_tokens: row.output_count,
            total_tokens: row.input_count + row.output_count,
          },
          sealed: true,
        },
      );
      const t = now();
      db.prepare(
        "UPDATE sealed_requests SET status='settled',reason='reconciled',usage=?,charged=?,reconcile_ref=?,settled=? WHERE hold_id=? AND status='reconcile_pending'",
      ).run(
        JSON.stringify({
          prompt_tokens: row.input_count,
          completion_tokens: row.output_count,
          price_in_usd: row.price_in_usd,
        }),
        receipt.charged,
        row.ref,
        t,
        p.hold_id,
      );
      claimed.add(row.ref);
      settled++;
    }
    return { settled, pending: pending.length - settled };
  }
  // A relay cut short by a restart never finished: past the longest a relay
  // can run, it waits for reconciliation like any request without a trailer.
  function sweep(at) {
    db.prepare(
      "UPDATE sealed_requests SET status='reconcile_pending',reason='interrupted',finished=COALESCE(finished,?) WHERE status='relaying' AND created<?",
    ).run(at, at - STALE_RELAY_MS);
  }
  return {
    pass,
    // One pass at a time; the worker calls this every tick.
    tick(at = now()) {
      sweep(at);
      if (!cfg.sealedReconcile || running) return running;
      running = pass(at)
        .catch((e) => {
          // No content here to leak: history rows are metadata.
          console.error("Sealed reconciliation failed:", e.message);
          return { settled: 0, error: true };
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}
