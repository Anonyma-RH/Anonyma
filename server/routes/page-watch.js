import { now, uid, fail, hash, credits, markupFactor, transaction } from "../core.js";
import {
  MAX_WATCHES,
  KEEP_REPORTS,
  createPageWatcher,
  watchInput,
  watchView,
  reportView,
  listWatches,
  readPage,
  replyTokens,
  worstCase,
  nextCheck,
} from "../page-watch.js";
import { EVERY, MAX_DIFF_CHARS, SNAPSHOT_BYTES, MAX_FAILURES, comparableText } from "../../src/page-watch.js";
import { viewerOf } from "../early-models.js";
import { isPrivateModel } from "../private-mode.js";

// Page Watch: the account's watches, and their reports in the Routines inbox
// (server/page-watch.js). The release gate in releases.js refuses these
// routes until Page Watch and Routines are released (and Private Mode, for a
// watch that asks for private models), and the worker checks nothing then.
//
// Creating a watch reads the page once, at once, the way Link Reader does
// (free; at most one read at a time per account and 4 across the server),
// and keeps that version as the first one to compare with. Nothing is
// logged: not the link, its host, the page, the hint or a summary.
const PER_ACCOUNT = 1,
  PER_SERVER = 4;

export function pageWatchRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const watcher = createPageWatcher(ctx);
  const read = limit("pagewatch-read", 120, 60000);
  const write = limit("pagewatch", 60, 3600000);
  const reading = new Map();
  let readingTotal = 0;
  const owned = (id, user) => {
    const row =
      typeof id === "string" &&
      db.prepare("SELECT * FROM page_watches WHERE id=? AND user_id=?").get(id, user);
    if (!row) fail(404, "Watch not found.", "watch_not_found");
    return row;
  };
  const view = (id) => watchView(db, db.prepare("SELECT * FROM page_watches WHERE id=?").get(id));

  app.get("/api/watches", requireUser, read, (req, res) =>
    res.json({
      watches: listWatches(db, req.user.id),
      max_watches: MAX_WATCHES,
      keep_reports: KEEP_REPORTS,
      every: EVERY,
      max_failures: MAX_FAILURES,
      snapshot_bytes: SNAPSHOT_BYTES,
    }),
  );
  // The most one summary can cost with a model, for the form: the largest
  // set of changes a model is ever sent and the full reply budget. Checks
  // that find no change are free.
  app.get("/api/watches/estimate", requireUser, read, (req, res) => {
    const m = typeof req.query.model === "string" ? ctx.models.find(req.query.model) : null;
    if (!m || m.type !== "chat") fail(400, "Choose a chat model you can use.", "invalid_model");
    ctx.earlyModels.check(viewerOf(req), "models", m.id);
    res.json({
      model: m.id,
      private: isPrivateModel(m, cfg),
      max_credits: credits(worstCase(m, markupFactor(req.user, cfg))),
      reply_tokens: replyTokens(m),
      max_diff_chars: MAX_DIFF_CHARS,
    });
  });
  app.post("/api/watches", requireUser, write, async (req, res) => {
    const user = req.user.id;
    const w = watchInput(ctx, req.body, req.user);
    // Early Model Access: a model in its early days needs Insider tier and up
    // to be chosen (and again at every summary, in runChat).
    ctx.earlyModels.check(viewerOf(req), "models", w.model);
    const count = () => db.prepare("SELECT COUNT(*) n FROM page_watches WHERE user_id=?").get(user).n;
    const tooMany = () =>
      fail(409, `You can watch up to ${MAX_WATCHES} pages. Delete a watch to add another.`, "watch_limit");
    const duplicate = () =>
      db.prepare("SELECT id FROM page_watches WHERE user_id=? AND url=?").get(user, w.url) &&
      fail(409, "You already watch this page.", "watch_exists");
    if (count() >= MAX_WATCHES) tooMany();
    duplicate();
    if ((reading.get(user) || 0) >= PER_ACCOUNT || readingTotal >= PER_SERVER)
      fail(429, "Another page is still being read. Try again in a moment.", "link_busy");
    reading.set(user, (reading.get(user) || 0) + 1);
    readingTotal++;
    let page;
    try {
      // The first version: read now, so a link that can't be watched is
      // refused before anything is saved.
      page = await readPage(cfg, w.url);
    } finally {
      const left = (reading.get(user) || 1) - 1;
      if (left > 0) reading.set(user, left);
      else reading.delete(user);
      readingTotal--;
    }
    const id = uid("pw_");
    transaction(db, () => {
      if (count() >= MAX_WATCHES) tooMany();
      duplicate();
      const at = now();
      db.prepare(
        "INSERT INTO page_watches(id,user_id,url,hint,model,private_only,every,monthly_budget,enabled,next_check,last_check,last_status,snapshot,snapshot_hash,snapshot_at,snapshot_truncated,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,'baseline',?,?,?,?,?,?)",
      ).run(
        id,
        user,
        w.url,
        w.hint,
        w.model,
        w.private_only,
        w.every,
        w.monthly_budget,
        w.enabled,
        w.enabled ? nextCheck({ every: w.every, last_check: at }, at) : null,
        at,
        page.text,
        hash(comparableText(page.text)),
        at,
        page.truncated ? 1 : 0,
        at,
        at,
      );
    });
    res.status(201).json(view(id));
  });
  app.patch("/api/watches/:id", requireUser, write, (req, res) => {
    const row = owned(req.params.id, req.user.id);
    const w = watchInput(ctx, req.body, req.user, row);
    if (Object.hasOwn(req.body || {}, "model"))
      ctx.earlyModels.check(viewerOf(req), "models", w.model);
    const at = now();
    const switchedOn = !!w.enabled && !row.enabled;
    // Switching on, or choosing another model, starts afresh after replies
    // that couldn't be read.
    const fresh = switchedOn || w.model !== row.model;
    // Switching on (a paused watch too) or a new schedule: the next check is
    // one interval after the last one, and never sooner than a minute from
    // now. Nothing is ever checked more often than every 6 hours.
    const reschedule = switchedOn || (w.enabled && w.every !== row.every);
    db.prepare(
      "UPDATE page_watches SET hint=?,model=?,private_only=?,every=?,monthly_budget=?,enabled=?,paused=?,failures=?,unreadable=?,next_check=?,updated=? WHERE id=? AND user_id=?",
    ).run(
      w.hint,
      w.model,
      w.private_only,
      w.every,
      w.monthly_budget,
      w.enabled,
      w.enabled ? null : row.paused,
      switchedOn ? 0 : row.failures,
      fresh ? 0 : row.unreadable,
      !w.enabled ? null : reschedule ? nextCheck({ ...row, every: w.every }, at) : row.next_check,
      at,
      row.id,
      req.user.id,
    );
    res.json(view(row.id));
  });
  app.delete("/api/watches/:id", requireUser, write, (req, res) => {
    const row = owned(req.params.id, req.user.id);
    if (row.running_since != null || watcher.isRunning(row.id))
      fail(409, "This page is being checked. Delete the watch once the check finishes.", "watch_running");
    // Its kept page goes with the row, and its reports with it (ON DELETE
    // CASCADE).
    db.prepare("DELETE FROM page_watches WHERE id=? AND user_id=?").run(row.id, req.user.id);
    res.json({ ok: true });
  });
  // The watches' part of the Routines inbox, newest first.
  app.get("/api/watches/reports", requireUser, read, (req, res) => {
    const filter = req.query.watch;
    if (filter != null) owned(filter, req.user.id);
    const before = req.query.before == null ? null : Number(req.query.before);
    if (before != null && !Number.isSafeInteger(before))
      fail(400, "before must be a report's checked_at time.", "invalid_request");
    const rows = db
      .prepare(
        `SELECT x.*,w.url FROM page_watch_reports x JOIN page_watches w ON w.id=x.watch_id
          WHERE x.user_id=? ${filter != null ? "AND x.watch_id=?" : ""} ${before != null ? "AND x.checked<?" : ""}
          ORDER BY x.checked DESC,x.rowid DESC LIMIT ?`,
      )
      .all(
        req.user.id,
        ...(filter != null ? [filter] : []),
        ...(before != null ? [before] : []),
        KEEP_REPORTS + 1,
      );
    res.json({ reports: rows.slice(0, KEEP_REPORTS).map(reportView), more: rows.length > KEEP_REPORTS });
  });
  app.delete("/api/watches/reports/:id", requireUser, write, (req, res) => {
    const r = db
      .prepare("SELECT id FROM page_watch_reports WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!r) fail(404, "Report not found.", "report_not_found");
    db.prepare("DELETE FROM page_watch_reports WHERE id=?").run(r.id);
    res.json({ ok: true });
  });
  // The workspace badge: reports not yet seen in the inbox.
  app.get("/api/watches/unseen", requireUser, read, (req, res) =>
    res.json({
      count: db
        .prepare("SELECT COUNT(*) n FROM page_watch_reports WHERE user_id=? AND seen=0")
        .get(req.user.id).n,
    }),
  );
  app.post("/api/watches/seen", requireUser, read, (req, res) => {
    const before = req.body?.before;
    if (before != null && !Number.isSafeInteger(before))
      fail(400, "before must be a report's checked_at time.", "invalid_request");
    db.prepare(
      `UPDATE page_watch_reports SET seen=1 WHERE user_id=? AND seen=0 ${before != null ? "AND checked<=?" : ""}`,
    ).run(req.user.id, ...(before != null ? [before] : []));
    res.json({ ok: true });
  });
  return watcher;
}
