import { uid, now, fail, transaction } from "../core.js";
import { isReleased } from "../releases.js";
import { findSeedPhrase, SEED_MESSAGE } from "../../src/seed-guard.js";
import { MAX_VERSIONS, readPage } from "../../src/site-spec.js";

// Screenshot to site ("shottosite"): the pages an account keeps. A saved page
// is an ordinary conversation in Code & Build's mode, one message pair per
// version: what was asked ("Change: make it blue") and the page, as one
// fenced block named index.html. So it is listed, searched, exported,
// bookmarked, shared, auto-deleted, wiped and closed with the account like
// any other conversation, opens in Code & Build with its Files and Preview,
// and costs nothing to keep. What is saved is only the words and the pages:
// never the picture it was made from (making a page is an off-the-record
// chat, server/shot-to-site.js), and nothing about the request beyond the
// model's id and what the request cost, read from the account's own hold.
// Pages made off the record or in Private Mode never reach these routes. The
// release gate in releases.js refuses them while the update is unreleased.
//
// - Seed Guard (once released): a page or a line of words holding a valid
//   seed phrase or a wallet private key is not saved. Nothing about a match
//   is logged or kept.
// - Only the newest 12 versions of a page are kept, oldest first out.
// - The account's saved-chat cap and auto-delete default apply, as they do
//   to any new chat. Nothing here logs titles, words or pages.
export const LABEL_MAX = 1100;
const TITLE_MAX = 70;

// One fenced block whose fence is longer than any run of backticks in the
// page, named for Code & Build's Files panel.
export function fencedPage(html) {
  const longest = Math.max(0, ...(String(html).match(/`+/g) || []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}html index.html\n${html}\n${fence}`;
}

export function shotToSiteRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const { newConversation, accessConversation } = ctx.conversations;
  const read = limit("site-pages-read", 120, 60000);
  const write = limit("site-pages", 120, 60000);

  // A page is a conversation of the account's own with at least one version.
  const siteMarked = (id) =>
    !!db
      .prepare(
        "SELECT 1 FROM messages WHERE conversation_id=? AND role='assistant' AND json_valid(content) AND json_extract(content,'$.site') IS NOT NULL LIMIT 1",
      )
      .get(id);
  const ownPage = (id, user) => {
    let c;
    try {
      c = typeof id === "string" && id.length <= 100 ? accessConversation(id, user) : null;
    } catch {
      c = null;
    }
    if (!c || c.collab_id || c.user_id !== user || !siteMarked(c.id)) fail(404, "Page not found.", "page_not_found");
    return c;
  };
  // What a request cost: the account's own settled hold, never the body.
  const costOf = (user, requestId) => {
    if (typeof requestId !== "string" || !requestId || requestId.length > 200) return { cost: 0, model: null };
    const row = db.prepare("SELECT status,result FROM holds WHERE id=?").get(user + ":" + requestId);
    if (row?.status !== "settled" || !row.result) return { cost: 0, model: null };
    try {
      const r = JSON.parse(row.result);
      return {
        cost: Number.isSafeInteger(r.charged) && r.charged > 0 ? r.charged : 0,
        model: typeof r.model === "string" ? r.model.slice(0, 100) : null,
      };
    } catch {
      return { cost: 0, model: null };
    }
  };

  app.get("/api/site-pages", requireUser, read, (req, res) => {
    const rows = db
      .prepare(
        `SELECT c.id,c.title,c.created,c.updated,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.role='assistant' AND json_valid(m.content) AND json_extract(m.content,'$.site') IS NOT NULL) versions
         FROM conversations c
         WHERE c.user_id=? AND c.collab_id IS NULL AND (c.expires IS NULL OR c.expires>=?)
           AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.role='assistant' AND json_valid(m.content) AND json_extract(m.content,'$.site') IS NOT NULL)
         ORDER BY c.updated DESC,c.rowid DESC LIMIT 30`,
      )
      .all(req.user.id, now());
    res.json({ data: rows, limit: 30, max_versions: MAX_VERSIONS });
  });

  // Save versions: as a new page, or added to one already saved (`id`).
  //   { id?, versions: [{ label, html, model?, request_id?, from? }] }
  app.post("/api/site-pages", requireUser, write, (req, res) => {
    const body = req.body;
    const invalid = (message) => fail(400, message, "invalid_page");
    if (!body || typeof body !== "object" || Array.isArray(body)) invalid("Send the versions to save.");
    const { id, versions } = body;
    if (!Array.isArray(versions) || !versions.length || versions.length > MAX_VERSIONS)
      invalid(`Send 1 to ${MAX_VERSIONS} versions to save.`);
    const checked = versions.map((v) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) invalid("A version is malformed.");
      if (typeof v.label !== "string" || !v.label.trim() || v.label.length > LABEL_MAX || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v.label))
        invalid("A version needs a short description.");
      if (typeof v.html !== "string") invalid("A version needs its page.");
      const page = readPage(v.html);
      if (!page.html) invalid("A version's page isn't one this tool can show.");
      const from = v.from == null ? null : v.from;
      if (from !== null && !(Number.isInteger(from) && from >= 0 && from < 1000)) invalid("A version's source is malformed.");
      return { label: v.label.replace(/\s+/g, " ").trim(), html: page.html, title: page.title, request_id: v.request_id, from };
    });
    // Seed Guard: a page is stored, so a seed phrase is never saved in one.
    if (isReleased(cfg, "seedguard") && checked.some((v) => findSeedPhrase(v.label) || findSeedPhrase(v.html)))
      fail(400, SEED_MESSAGE, "seed_phrase_blocked");
    const user = req.user.id;
    const existing = id == null ? null : ownPage(id, user);
    const conversation = transaction(db, () => {
      const cid = existing ? existing.id : newConversation(user, checked[0].title.slice(0, TITLE_MAX), "code");
      let n = db
        .prepare(
          "SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND role='assistant' AND json_valid(content) AND json_extract(content,'$.site') IS NOT NULL",
        )
        .get(cid).n;
      const add = db.prepare(
        "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
      );
      for (const v of checked) {
        n++;
        const paid = costOf(user, v.request_id);
        add.run(uid("m_"), cid, "user", JSON.stringify(v.label), null, 0, now(), user);
        add.run(
          uid("m_"),
          cid,
          "assistant",
          JSON.stringify({
            text: `Version ${n}: ${v.label}\n\n${fencedPage(v.html)}\n`,
            site: { v: 1, n, from: v.from },
          }),
          paid.model,
          paid.cost,
          now(),
          user,
        );
      }
      // Only the newest MAX_VERSIONS stay: the oldest pair goes first.
      const all = db
        .prepare("SELECT id,role,content FROM messages WHERE conversation_id=? ORDER BY created,rowid")
        .all(cid);
      const marked = (m) => {
        try {
          return m.role === "assistant" && JSON.parse(m.content)?.site != null;
        } catch {
          return false;
        }
      };
      let extra = all.filter(marked).length - MAX_VERSIONS;
      for (let i = 0; i < all.length && extra > 0; i++)
        if (marked(all[i])) {
          db.prepare("DELETE FROM messages WHERE id=?").run(all[i].id);
          if (i > 0 && all[i - 1].role === "user") db.prepare("DELETE FROM messages WHERE id=?").run(all[i - 1].id);
          extra--;
        }
      db.prepare("UPDATE conversations SET updated=? WHERE id=?").run(now(), cid);
      return cid;
    });
    const title = db.prepare("SELECT title FROM conversations WHERE id=?").get(conversation)?.title || "";
    res.status(existing ? 200 : 201).json({ id: conversation, title, saved: checked.length });
  });
}
