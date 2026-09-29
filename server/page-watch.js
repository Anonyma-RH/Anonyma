import { chatLimits } from "../data/chat-limits.js";
import {
  now,
  uid,
  fail,
  hash,
  credits,
  callable,
  chatPrice,
  markupFactor,
  transaction,
} from "./core.js";
import { isReleased } from "./releases.js";
import { isPrivateModel } from "./private-mode.js";
import { fetchLink, bodyText, checkUrl, LinkError } from "./link-reader.js";
import { extractPlain } from "./link-extract.js";
import { runExtraction } from "./routes/link-reader.js";
import { findSeedPhrase } from "../src/seed-guard.js";
import { scanInvisible, cleanText, findPhrases, projectVisible } from "../src/shield.js";
import { composeMessageWithDocuments, escapeDocumentText } from "../src/documents.js";
import { monthWindow } from "../src/routines.js";
import {
  MAX_WATCHES,
  KEEP_REPORTS,
  HINT_LIMIT,
  URL_LIMIT,
  EVERY,
  EVERY_IDS,
  MAX_FAILURES,
  SUMMARY_TOKENS,
  MAX_DIFF_CHARS,
  MAX_BUDGET_CREDITS,
  MAX_UNREADABLE,
  WATCH_SYSTEM,
  comparableText,
  formatDiff,
  addedText,
  capBytes,
  nextCheck,
  failureDelay,
  readReply,
} from "../src/page-watch.js";

// Page Watch: the server checks a public page on a schedule and says what
// changed. Built on Routines (the same budget-and-inbox shape, and its
// reports land in the Routines inbox) and on Link Reader's fetcher
// (server/link-reader.js: public addresses only, DNS pinned, every redirect
// checked again, 10 seconds, 5 MB, no cookies, no Referer), whose test hooks
// it shares (cfg.linkReader, local test mode only).
//
// Each check:
// 1. fetches the page and extracts its readable text, as Link Reader does
//    (invisible characters removed, as Injection Shield does; at most
//    SNAPSHOT_BYTES kept);
// 2. compares it with the last version kept, after normalising both
//    (src/page-watch.js: whitespace, clock times, "5 minutes ago" and the
//    dates on "updated" lines don't count);
// 3. when nothing meaningful changed, stores nothing new and charges
//    nothing;
// 4. when something did, sends the model only the changed lines with a
//    little context (never the whole page, and only the site's name, never
//    the link), as data, through runChat's hold -> settle path (the same
//    pricing, balance, spending-limit checks, failure billing, ledger charge
//    and signed receipt as Routines). With an "only tell me if…" hint the
//    model answers yes or no in JSON first, and a summary is kept only for a
//    yes;
// 5. keeps the result in the Routines inbox (page_watch_reports).
//
// Fetches are free. A failed fetch is retried later and later
// (failureDelay); the fifth in a row pauses the watch with a note. A
// summary is refused, and nothing is charged, when the watch's monthly
// budget, the balance or the spending limits can't cover its worst case.
// A watch runs unattended, so only a reply it can use is paid for: one the
// model got wrong (unreadable, or cut short with nothing usable), or a
// request that failed or timed out, releases its hold (runChat's
// acceptOutput) and leaves a note. An unreadable reply keeps the last
// version, so the change is summarised again at the next check (with
// another model, say); the third in a row pauses the watch.
// Nothing here logs a URL, a host, page text, a hint or a summary.

const MAX_CONCURRENT = 4;
const live = (cfg) => isReleased(cfg, "pagewatch") && isReleased(cfg, "routines");
const SEED_HINT =
  "This looks like a wallet seed phrase. A watch's hint is saved and sent with every summary, so ANONYMA won't save one. Remove it to continue.";
const refusal = (status, message, code) =>
  Object.assign(new Error(message), { status, code });

// ---- Money ----

const requestIdFor = (watch, at) => `pagewatch_${watch.id}_${at}`;
const holdPrefix = (watch) => `${watch.user_id}:pagewatch_${watch.id}_`;
// What a watch has spent this calendar month (UTC), and has on hold now.
export function monthSpend(db, watch, at = now()) {
  const { start, end } = monthWindow("UTC", at);
  const prefix = holdPrefix(watch);
  const spent = db
    .prepare(
      "SELECT COALESCE(SUM(-amount),0) n FROM ledger WHERE user_id=? AND amount<0 AND created>=? AND created<? AND substr(ref,1,?)=?",
    )
    .get(watch.user_id, start, end, prefix.length, prefix).n;
  const held = db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) n FROM holds WHERE user_id=? AND status='held' AND substr(id,1,?)=?",
    )
    .get(watch.user_id, prefix.length, prefix).n;
  return { spent, held, start, end };
}

// ---- What the model is sent ----

// Only the site's name goes with the changes: the link itself (which can
// carry private tokens) stays here.
export function watchMessages({ hint, site, diff }) {
  const ask = hint
    ? `The person asked to be told only about this: "${escapeDocumentText(hint)}"\n\nDecide whether the changes below matter for that. Reply with JSON only, no code fence, in exactly this shape: {"matters": true or false, "summary": "..."}. When matters is true, summary is 1 to 5 short markdown bullet points about the changes that matter, with the old and new values. When it's false, summary is "".`
    : "Summarise what changed on this page in 1 to 5 short markdown bullet points, the most important first. Give the old and new values (prices, dates, names, numbers) where they changed. Leave out layout and formatting. Reply with the bullet points only.";
  return [
    { role: "system", content: WATCH_SYSTEM },
    {
      role: "user",
      content: composeMessageWithDocuments(
        ask,
        [{ name: "changes", source: "link", site, text: diff }],
        { asData: true },
      ),
    },
  ];
}
// The reply budget: room for a reasoning model to think and still answer
// (at least SUMMARY_TOKENS where the model allows it).
export const replyTokens = (m) =>
  Math.max(1, Math.min(SUMMARY_TOKENS, chatLimits(m).maxOutputTokens));
// The most one summary can be held at with this model: the largest diff the
// model is ever sent, a hint at its longest and the full reply budget.
export function worstCase(m, factor) {
  const messages = watchMessages({
    hint: "x".repeat(HINT_LIMIT),
    site: "www.example.com",
    diff: "x".repeat(MAX_DIFF_CHARS + 200),
  });
  return chatPrice(m, messages, replyTokens(m), 0, factor);
}

// ---- Input ----

const units = (value, what) => {
  const n = Math.round(value * 10000);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_BUDGET_CREDITS ||
    Math.abs(n - value * 10000) > 1e-6
  )
    fail(
      400,
      `Set the ${what} in credits, above 0 and up to ${MAX_BUDGET_CREDITS.toLocaleString("en-US")}, with at most four decimals.`,
      "invalid_watch",
    );
  return n;
};
const bool = (value, name) => {
  if (typeof value !== "boolean")
    fail(400, `${name} must be true or false.`, "invalid_watch");
  return value ? 1 : 0;
};
// A chat model this installation can run (and a private one when asked).
function watchModel(ctx, id, privateOnly) {
  const m = typeof id === "string" && id.length <= 200 ? ctx.models.find(id) : null;
  if (
    !m ||
    m.type !== "chat" ||
    !callable(m, ctx.cfg) ||
    (m.architecture?.output_modalities || []).includes("image")
  )
    fail(400, "Choose a chat model you can use.", "invalid_model");
  if (privateOnly && !isPrivateModel(m, ctx.cfg))
    fail(400, "Private models only needs a model with zero data retention.", "private_model_required");
  return m;
}

// A watch's stored fields from a create (every field) or an update (the
// fields sent; the rest are kept). The URL is set once: a different page is
// a new watch.
export function watchInput(ctx, body, user, existing = null) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    fail(400, "Send the watch as a JSON object.", "invalid_watch");
  const has = (k) => Object.hasOwn(body, k);
  const next = existing ? { ...existing } : {};
  const need = (k) => {
    if (!existing && !has(k)) fail(400, `Add the watch's ${k}.`, "invalid_watch");
    return has(k);
  };
  if (existing && has("url") && body.url !== existing.url)
    fail(400, "A watch's page can't be changed. Delete it and watch the new page instead.", "invalid_watch");
  if (!existing) {
    if (typeof body.url !== "string" || !body.url.trim() || body.url.length > URL_LIMIT)
      fail(400, "Paste a full link that starts with http or https.", "link_invalid");
    // Link Reader's rules (LinkError: 400 link_invalid, link_blocked, ...).
    next.url = checkUrl(body.url).href;
  }
  if (need("every")) {
    if (!EVERY_IDS.includes(body.every))
      fail(400, "Check every 6 hours, daily or weekly.", "invalid_schedule");
    next.every = body.every;
  }
  if (has("hint") || !existing) {
    const hint = body.hint == null ? "" : body.hint;
    if (typeof hint !== "string" || hint.length > HINT_LIMIT)
      fail(400, `Keep “only tell me if…” to ${HINT_LIMIT} characters.`, "invalid_watch");
    // Seed Guard: a hint is stored and sent with every summary, so a seed
    // phrase is never saved in one, with no override (as for a routine).
    if (isReleased(ctx.cfg, "seedguard") && findSeedPhrase(hint))
      fail(400, SEED_HINT, "seed_phrase_blocked");
    next.hint = hint.trim() || null;
  }
  if (need("model")) {
    if (typeof body.model !== "string" || body.model.length > 200)
      fail(400, "Choose a model.", "invalid_watch");
    next.model = body.model;
  }
  next.private_only = has("private_only")
    ? bool(body.private_only, "private_only")
    : (next.private_only ?? 0);
  next.enabled = has("enabled") ? bool(body.enabled, "enabled") : (next.enabled ?? 1);
  if (need("monthly_budget_credits"))
    next.monthly_budget = units(body.monthly_budget_credits, "monthly budget");
  if (!existing || has("model") || has("private_only") || has("monthly_budget_credits")) {
    const m = watchModel(ctx, next.model, next.private_only);
    // A budget smaller than one summary could ever cost would refuse every
    // change it finds: say so now instead.
    const most = worstCase(m, markupFactor(user, ctx.cfg));
    if (next.monthly_budget < most)
      fail(
        400,
        `Set a monthly budget of at least ${credits(most)} credits: one summary with this model can cost up to that.`,
        "watch_budget_too_small",
      );
  }
  return next;
}

// ---- Views ----

const json = (v) => (v == null ? null : JSON.parse(v));
const siteOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};
export function watchView(db, row, at = now()) {
  const month = monthSpend(db, row, at);
  return {
    id: row.id,
    url: row.url,
    site: siteOf(row.url),
    hint: row.hint,
    model: row.model,
    private_only: !!row.private_only,
    every: row.every,
    monthly_budget_credits: credits(row.monthly_budget),
    enabled: !!row.enabled,
    paused: row.paused,
    failures: row.failures,
    // Model replies in a row that couldn't be read (never charged).
    unreadable: row.unreadable,
    next_check_at: row.enabled ? row.next_check : null,
    running: row.running_since != null,
    last_check_at: row.last_check,
    last_status: row.last_status,
    last_code: row.last_code,
    last_change_at: row.last_change,
    // The one copy of the page kept: when it was taken and its size.
    kept: row.snapshot_hash
      ? {
          at: row.snapshot_at,
          bytes: Buffer.byteLength(row.snapshot || ""),
          truncated: !!row.snapshot_truncated,
        }
      : null,
    month: {
      spent: credits(month.spent),
      held: credits(month.held),
      remaining: credits(Math.max(0, row.monthly_budget - month.spent - month.held)),
      resets_at: month.end,
    },
    created: row.created,
    updated: row.updated,
  };
}
export function reportView(row) {
  return {
    id: row.id,
    watch_id: row.watch_id,
    url: row.url ?? null,
    site: row.url ? siteOf(row.url) : null,
    checked_at: row.checked,
    status: row.status,
    summary: row.summary,
    model: row.model,
    private_only: !!row.private_only,
    hint: row.hint,
    request_id: row.request_id,
    credits_charged: credits(row.charged),
    finish_reason: row.finish_reason,
    signed_receipt: json(row.receipt),
    added: row.added,
    removed: row.removed,
    flagged: row.flagged,
    code: row.code,
    message: row.message,
    seen: !!row.seen,
  };
}
export const listWatches = (db, user, at = now()) =>
  db
    .prepare("SELECT * FROM page_watches WHERE user_id=? ORDER BY created,rowid")
    .all(user)
    .map((r) => watchView(db, r, at));

// Everything a watch keeps, for the account export: its settings, the last
// version of the page it kept (text and fingerprint) and its reports.
export function exportWatches(db, user) {
  return {
    watches: db
      .prepare("SELECT * FROM page_watches WHERE user_id=? ORDER BY created,rowid")
      .all(user)
      .map((r) => ({
        ...watchView(db, r),
        snapshot: r.snapshot_hash
          ? { text: r.snapshot, sha256: r.snapshot_hash, at: r.snapshot_at, truncated: !!r.snapshot_truncated }
          : null,
      })),
    reports: db
      .prepare(
        "SELECT x.*,w.url FROM page_watch_reports x JOIN page_watches w ON w.id=x.watch_id WHERE x.user_id=? ORDER BY x.checked,x.rowid",
      )
      .all(user)
      .map(reportView),
  };
}
// Account closure and Panic Wipe: the watches, their kept pages and their
// reports go. A check already under way finds its watch gone and keeps
// nothing (its reservation guard refuses a summary).
export function forgetWatches(db, user) {
  db.prepare("DELETE FROM page_watch_reports WHERE user_id=?").run(user);
  db.prepare("DELETE FROM page_watches WHERE user_id=?").run(user);
}

// ---- Reading a page ----

// One page's readable text, the way Link Reader reads it: { url, site,
// text, truncated }. PDFs aren't watched (their text is extracted in the
// browser). Errors are LinkErrors with fixed messages that never name the
// page.
export async function readPage(cfg, input) {
  try {
    return await read(cfg, input);
  } catch (e) {
    // Never an error's own message: it could name the host.
    if (e instanceof LinkError) throw e;
    throw new LinkError(502, "link_failed", "Couldn't read that page.");
  }
}
async function read(cfg, input) {
  const hooks = cfg.testMode ? cfg.linkReader || {} : {};
  const page = await fetchLink(input, {
    ...(hooks.lookup ? { lookup: hooks.lookup } : {}),
    ...(hooks.route ? { route: hooks.route } : {}),
    ...(hooks.timeoutMs ? { timeoutMs: hooks.timeoutMs } : {}),
  });
  if (page.type === "application/pdf")
    throw new LinkError(415, "link_type", "Page Watch reads web pages and plain text, not PDFs.");
  const site = page.url.hostname;
  const raw = bodyText(page.body, page);
  const read =
    page.type === "text/plain"
      ? extractPlain(raw, { host: site, path: page.url.pathname })
      : await runExtraction(raw, site);
  if (!read.words)
    throw new LinkError(422, "link_unreadable", "Couldn't find readable text on that page.");
  // Injection Shield: invisible characters (zero-width, bidi overrides, tag
  // characters) never reach the model or the kept copy.
  const visible = cleanText(read.text, { text: read.text, invisible: scanInvisible(read.text) });
  const capped = capBytes(visible);
  return {
    url: page.url.href,
    site,
    text: capped.text,
    truncated: capped.truncated || !!read.truncated,
  };
}

// ---- Checks ----

export function createPageWatcher(ctx) {
  const { db, cfg } = ctx;
  const running = new Map();
  let closed = false;
  // A check the service was restarting through can't finish; it runs again
  // at its next time.
  db.prepare("UPDATE page_watches SET running_since=NULL WHERE running_since IS NOT NULL").run();

  function claim(id, at) {
    return transaction(db, () => {
      const w = db
        .prepare(
          "SELECT w.* FROM page_watches w JOIN users u ON u.id=w.user_id AND u.deleted IS NULL WHERE w.id=? AND w.enabled=1 AND w.running_since IS NULL AND w.next_check<=?",
        )
        .get(id, at);
      if (!w) return null;
      db.prepare("UPDATE page_watches SET running_since=? WHERE id=?").run(at, w.id);
      return w;
    });
  }

  // The model's part of a check that found a change.
  async function summarise(w, at, page, diff, closeListeners) {
    const user = db.prepare("SELECT * FROM users WHERE id=? AND deleted IS NULL").get(w.user_id);
    if (!user)
      throw refusal(409, "This watch was switched off or deleted before its summary.", "watch_gone");
    if (w.private_only && !isReleased(cfg, "private"))
      throw refusal(403, "Private Mode isn't available right now.", "private_unavailable");
    // A hint saved before Seed Guard was released is checked here too.
    if (w.hint && isReleased(cfg, "seedguard") && findSeedPhrase(w.hint))
      throw refusal(400, SEED_HINT, "seed_phrase_blocked");
    const m = ctx.models.getModel(w.model);
    if (m.type !== "chat")
      throw refusal(400, "This endpoint supports chat models.", "unsupported_model");
    if (w.private_only && !isPrivateModel(m, cfg))
      throw refusal(400, "Private mode needs a model with zero data retention.", "private_model_required");
    const messages = watchMessages({ hint: w.hint, site: page.site, diff: diff.text });
    // Checked with the reservation, atomically (core.js reserve()): the watch
    // is still there and on, and its monthly budget covers the hold.
    const reserveGuard = (held) => {
      const alive = db
        .prepare(
          "SELECT w.* FROM page_watches w JOIN users u ON u.id=w.user_id AND u.deleted IS NULL WHERE w.id=? AND w.enabled=1",
        )
        .get(w.id);
      if (!alive)
        fail(409, "This watch was switched off or deleted before its summary.", "watch_gone");
      const month = monthSpend(db, alive);
      if (month.spent + month.held + held > alive.monthly_budget)
        fail(402, "This watch's monthly budget can't cover this summary.", "watch_budget");
    };
    let captured = null,
      unusable = null;
    const fakeReq = {
      body: { model: m.id, messages, max_tokens: replyTokens(m), stream: false },
      user,
      headers: {
        "idempotency-key": requestIdFor(w, at),
        // The changes are public page text the server fetched, not something
        // the person typed, so Seed Guard doesn't scan them (as for Link
        // Reader); the hint was checked when it was saved and above.
        "x-anonyma-seed-guard": "off",
      },
      privateOnly: !!w.private_only,
      discardMedia: true,
      reserveGuard,
      // Paid for only when it can be read: runChat releases the hold
      // otherwise (and for any failure).
      acceptOutput: (text, finish) => {
        const reply = readReply(w.hint, text, finish);
        unusable = reply.error ? { code: reply.error, finish_reason: finish } : null;
        return !reply.error;
      },
    };
    const fakeRes = {
      set() {
        return this;
      },
      flushHeaders() {},
      write() {},
      end() {},
      on(event, fn) {
        if (event === "close") closeListeners.add(fn);
        return this;
      },
      json(payload) {
        captured = payload;
      },
      destroyed: false,
      writableEnded: false,
    };
    try {
      await ctx.runChat(fakeReq, fakeRes, true);
    } catch (e) {
      // The model's reply couldn't be used: nothing was charged.
      if (e?.code === "unusable_output" && unusable)
        throw Object.assign(refusal(502, "The model's reply couldn't be read.", unusable.code), {
          unusable: true,
          finish_reason: unusable.finish_reason,
        });
      throw e;
    }
    const message = captured?.choices?.[0]?.message || {};
    const extension = captured?.anonyma || {};
    const finish = extension.finish_reason || null;
    return {
      reply: readReply(w.hint, typeof message.content === "string" ? message.content : "", finish),
      receipt: extension.signed_receipt || null,
      finish_reason: finish,
    };
  }

  async function check(w, at, closeListeners) {
    let page;
    try {
      page = await readPage(cfg, w.url);
    } catch (e) {
      return { kind: "fetch_failed", code: e?.code || "link_failed", message: e?.message };
    }
    const fingerprint = hash(comparableText(page.text));
    if (!w.snapshot_hash) return { kind: "baseline", page, fingerprint };
    if (fingerprint === w.snapshot_hash) return { kind: "unchanged" };
    const diff = formatDiff(w.snapshot || "", page.text);
    if (!diff.text) return { kind: "unchanged" };
    // Injection Shield's phrase check on what was added: the reply is still
    // made (the changes go as data), and the report says what was found.
    const flagged = findPhrases(projectVisible(addedText(diff.text)).visible).length;
    const base = { kind: "changed", page, fingerprint, diff, flagged };
    try {
      return { ...base, ...(await summarise(w, at, page, diff, closeListeners)) };
    } catch (e) {
      return { ...base, error: e };
    }
  }

  function chargeOf(w, at) {
    const h = db
      .prepare("SELECT status,result FROM holds WHERE id=?")
      .get(`${w.user_id}:${requestIdFor(w, at)}`);
    return {
      held: !!h,
      charged: h?.status === "settled" ? JSON.parse(h.result).charged || 0 : 0,
    };
  }

  function record(w, at, outcome) {
    transaction(db, () => {
      const row = db.prepare("SELECT * FROM page_watches WHERE id=?").get(w.id);
      // Deleted (or the account closed) during the check: nothing to keep.
      if (!row) return;
      const interval = EVERY[row.every];
      const next = (ms) => (row.enabled ? at + ms : null);
      const report = (fields) => {
        db.prepare(
          "INSERT INTO page_watch_reports(id,watch_id,user_id,checked,status,summary,model,private_only,hint,request_id,charged,finish_reason,receipt,added,removed,flagged,code,message) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          uid("wr_"),
          row.id,
          row.user_id,
          at,
          fields.status,
          fields.summary ?? null,
          fields.model ?? null,
          row.private_only,
          row.hint,
          fields.request_id ?? null,
          fields.charged ?? 0,
          fields.finish_reason ?? null,
          fields.receipt ? JSON.stringify(fields.receipt) : null,
          fields.added ?? null,
          fields.removed ?? null,
          fields.flagged ?? 0,
          fields.code ?? null,
          fields.message ? String(fields.message).slice(0, 1000) : null,
        );
        // The inbox keeps each watch's newest KEEP_REPORTS reports.
        db.prepare(
          `DELETE FROM page_watch_reports WHERE watch_id=? AND id NOT IN
            (SELECT id FROM page_watch_reports WHERE watch_id=? ORDER BY checked DESC,rowid DESC LIMIT ${KEEP_REPORTS})`,
        ).run(row.id, row.id);
      };
      // A reply that could be used, or a page back to its kept version,
      // ends a run of unreadable replies. (A failed fetch, a refusal or a
      // provider failure asks nothing of the model, so it leaves the run.)
      if (outcome.kind === "unchanged" || outcome.kind === "baseline" || (outcome.kind === "changed" && !outcome.error))
        db.prepare("UPDATE page_watches SET unreadable=0 WHERE id=?").run(row.id);
      if (outcome.kind === "fetch_failed") {
        const failures = row.failures + 1;
        if (failures >= MAX_FAILURES) {
          db.prepare(
            "UPDATE page_watches SET failures=?,enabled=0,paused='failures',next_check=NULL,running_since=NULL,last_check=?,last_status='paused',last_code=? WHERE id=?",
          ).run(failures, at, outcome.code, row.id);
          report({ status: "paused", code: outcome.code, message: outcome.message });
          ctx.push?.notify(row.user_id, "pagewatch_paused");
        } else
          db.prepare(
            "UPDATE page_watches SET failures=?,next_check=?,running_since=NULL,last_check=?,last_status='fetch_failed',last_code=? WHERE id=?",
          ).run(failures, next(failureDelay(row.every, failures)), at, outcome.code, row.id);
        return;
      }
      if (outcome.kind === "unchanged") {
        // Nothing new is stored: the kept version stays as it was.
        db.prepare(
          "UPDATE page_watches SET failures=0,next_check=?,running_since=NULL,last_check=?,last_status='unchanged',last_code=NULL WHERE id=?",
        ).run(next(interval), at, row.id);
        return;
      }
      const keep = (status, code = null) =>
        db.prepare(
          "UPDATE page_watches SET failures=0,next_check=?,running_since=NULL,last_check=?,last_status=?,last_code=?,last_change=?,snapshot=?,snapshot_hash=?,snapshot_at=?,snapshot_truncated=? WHERE id=?",
        ).run(
          next(interval),
          at,
          status,
          code,
          status === "baseline" ? row.last_change : at,
          outcome.page.text,
          outcome.fingerprint,
          at,
          outcome.page.truncated ? 1 : 0,
          row.id,
        );
      if (outcome.kind === "baseline") {
        keep("baseline");
        return;
      }
      // A change.
      const { charged, held } = chargeOf(row, at);
      const common = {
        model: row.model,
        request_id: held ? requestIdFor(row, at) : null,
        charged,
        added: outcome.diff.added,
        removed: outcome.diff.removed,
        flagged: outcome.flagged,
      };
      if (outcome.error?.unusable) {
        // The model's reply couldn't be read: nothing was charged (the hold
        // was released) and the last version stays, so the change is
        // summarised again at the next check. The third in a row pauses the
        // watch until its model is changed or it's switched back on.
        const streak = row.unreadable + 1;
        const code = outcome.error.code;
        if (streak >= MAX_UNREADABLE) {
          db.prepare(
            "UPDATE page_watches SET unreadable=?,enabled=0,paused='unreadable',next_check=NULL,running_since=NULL,last_check=?,last_status='paused',last_code=?,last_change=? WHERE id=?",
          ).run(streak, at, code, at, row.id);
          report({ ...common, status: "paused", code, finish_reason: outcome.error.finish_reason });
          ctx.push?.notify(row.user_id, "pagewatch_paused");
        } else {
          db.prepare(
            "UPDATE page_watches SET unreadable=?,failures=0,next_check=?,running_since=NULL,last_check=?,last_status='unreadable',last_code=?,last_change=? WHERE id=?",
          ).run(streak, next(interval), at, code, at, row.id);
          report({ ...common, status: "unreadable", code, finish_reason: outcome.error.finish_reason });
        }
        return;
      }
      // Otherwise the new version is kept whatever happened, so the same
      // change is never summarised (or charged) twice.
      if (outcome.error) {
        const e = outcome.error;
        const status = held ? "failed" : "refused";
        keep(status, e.code || null);
        // One note per reason: a watch refused again for the same reason
        // (its budget, say) doesn't add another.
        const last = db
          .prepare("SELECT status,code FROM page_watch_reports WHERE watch_id=? ORDER BY checked DESC,rowid DESC LIMIT 1")
          .get(row.id);
        if (status === "refused" && last?.status === "refused" && last.code === (e.code || null)) return;
        // Switched off during the check: that was the person's own doing.
        if (e.code === "watch_gone") return;
        report({
          ...common,
          status,
          code: e.code || null,
          message: String(e.message || "The summary failed."),
        });
        return;
      }
      if (!outcome.reply.matters) {
        // Not what the person asked about: no report, only the charge.
        keep("not_relevant");
        return;
      }
      keep("changed");
      report({
        ...common,
        status: "changed",
        summary: outcome.reply.summary,
        finish_reason: outcome.finish_reason,
        receipt: outcome.receipt,
      });
      // Push Alerts: "Your page watch found a change." Never the page, the
      // site or the summary.
      ctx.push?.notify(row.user_id, "pagewatch");
    });
  }

  async function execute(w, at, closeListeners) {
    let outcome;
    try {
      outcome = await check(w, at, closeListeners);
    } catch (e) {
      outcome = { kind: "fetch_failed", code: e?.code || "link_failed", message: null };
    }
    try {
      record(w, at, outcome);
    } catch (e) {
      // The database may be closing with the service; a lock left behind is
      // cleared at the next start.
      if (closed) return;
      console.error("Page Watch check not recorded.");
      try {
        db.prepare("UPDATE page_watches SET running_since=NULL WHERE id=?").run(w.id);
      } catch {}
    }
  }

  // Starts every due check there's room for; returns without waiting.
  function startDue() {
    if (closed || !live(cfg)) return;
    const at = now();
    const due = db
      .prepare(
        "SELECT w.id FROM page_watches w JOIN users u ON u.id=w.user_id AND u.deleted IS NULL WHERE w.enabled=1 AND w.next_check<=? AND w.running_since IS NULL ORDER BY w.next_check LIMIT ?",
      )
      .all(at, MAX_CONCURRENT * 2);
    for (const { id } of due) {
      if (running.size >= MAX_CONCURRENT) break;
      if (running.has(id)) continue;
      const w = claim(id, at);
      if (!w) continue;
      const closeListeners = new Set();
      const promise = execute(w, at, closeListeners).finally(() => running.delete(id));
      running.set(id, {
        promise,
        user: w.user_id,
        cancel: () => closeListeners.forEach((fn) => fn()),
      });
    }
  }
  const idle = () => Promise.allSettled([...running.values()].map((r) => r.promise));
  return {
    startDue,
    idle,
    isRunning: (id) => running.has(id),
    cancelFor(user) {
      for (const r of running.values()) if (r.user === user) r.cancel();
    },
    async stop() {
      closed = true;
      for (const r of running.values()) r.cancel();
      await idle();
    },
  };
}

export { MAX_WATCHES, KEEP_REPORTS, nextCheck };
