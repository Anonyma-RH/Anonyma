import { uid, now, fail, hash, credits, transaction } from "../core.js";
import { isReleased } from "../releases.js";
import { capsFor } from "../holders.js";
import { listRoutines } from "../routines.js";
import { chatRoom, defaultExpiry, insertChat } from "./chat-import.js";
import { MAX_TITLE, MAX_BODY, MAX_SCROLLS } from "./scrolls.js";
import {
  MAX_CHATS_PER_REQUEST,
  MAX_REQUEST_CHARS,
  checkUploadedChat,
  uploadedSeedFinding,
} from "../../src/chat-import.js";
import { findSeedPhrase, findPrivateKey } from "../../src/seed-guard.js";
import {
  CHATS_PER_PAGE,
  PAGE_CHARS,
  REMINDER_DAYS,
  chatKey,
  isoDay,
  messageText,
  restoredMode,
  scrollKey,
  validDay,
} from "../../src/account-backup-spec.js";

// Encrypted Backup (update "backup", gated in featuresFor). The backup file
// is made and opened in the browser (src/account-backup.js): these routes
// only hand the browser the account's own content to put in it, keep the
// date of the last backup, and take back what a restore chose.
//
// - Our server never receives the passphrase, the key or the file. It learns
//   only that a backup was made on a day (account_backups.last_backup, a
//   date and nothing else) so Account → Data can show it, and whether the
//   one reminder 30 days later was seen.
// - A restore adds, never replaces or deletes: a chat goes through Chat
//   Import's checks and insert (checkUploadedChat, insertChat), filling the
//   same room under the account's saved-chat cap; one whose words are
//   already in the account is skipped by a hash of its words; Seed Guard
//   holds back a chat or scroll with a seed phrase or private key unless
//   that item is allowed. Restored chats are marked (backup_restores: the
//   chat, the hash of its words and when), so the list can say "Restored".
// - Projects, memory, routines and watches are restored by the browser
//   through their own routes, which keep their own limits and checks.
// - Nothing here logs titles, words, hashes or ids. The date and the marks
//   are erased with the account's content and exported with it.

const PERSONAL = "c.user_id=? AND c.collab_id IS NULL AND (c.expires IS NULL OR c.expires>=?)";
// The text of a saved message, in SQL (as the bookmarks list reads it).
const TEXT = `(CASE WHEN json_valid(m.content) THEN CASE json_type(m.content)
  WHEN 'text' THEN json_extract(m.content,'$')
  WHEN 'object' THEN json_extract(m.content,'$.text')
  WHEN 'array' THEN (SELECT group_concat(json_extract(p.value,'$.text'),char(10)) FROM json_each(m.content) p WHERE json_extract(p.value,'$.type')='text')
  END END)`;
const DAY = 86400000;

// ---- The date, the reminder and the marks ----------------------------------------

export function backupState(db, user, at = now()) {
  const row = db.prepare("SELECT last_backup,reminded FROM account_backups WHERE user_id=?").get(user);
  const last = row?.last_backup || null;
  const age = last ? Math.floor((Date.parse(isoDay(at) + "T00:00:00Z") - Date.parse(last + "T00:00:00Z")) / DAY) : null;
  return {
    last_backup: last,
    // Once per backup: 30 days after it, until seen.
    reminder: !!last && !row.reminded && age >= REMINDER_DAYS,
  };
}
// Account export: the day of the last backup and when its reminder was seen.
export function exportAccountBackup(db, user) {
  const row = db.prepare("SELECT last_backup,reminded FROM account_backups WHERE user_id=?").get(user);
  return row ? { last_backup: row.last_backup, reminder_seen: row.reminded } : null;
}
// A saved chat that came back from a backup, for the account export.
export function restoredExport(db, conversationId) {
  const r = db
    .prepare("SELECT content_hash,restored FROM backup_restores WHERE conversation_id=?")
    .get(conversationId);
  return r ? { restored_from_backup: { restored: r.restored, words_sha256: r.content_hash } } : {};
}
// Rows of the conversation list with `restored` on the ones from a backup.
export function withRestored(db, user, rows) {
  const ids = new Set(
    db.prepare("SELECT conversation_id FROM backup_restores WHERE user_id=?").all(user).map((r) => r.conversation_id),
  );
  if (!ids.size) return rows;
  return rows.map((r) => (ids.has(r.id) ? { ...r, restored: true } : r));
}
export const isRestored = (db, conversationId) =>
  !!db.prepare("SELECT 1 FROM backup_restores WHERE conversation_id=?").get(conversationId);
// Account closure, Panic Wipe and Inactivity Wipe (eraseAccountContent).
export function forgetAccountBackup(db, user) {
  db.prepare("DELETE FROM backup_restores WHERE user_id=?").run(user);
  db.prepare("DELETE FROM account_backups WHERE user_id=?").run(user);
}

// ---- Routes ------------------------------------------------------------------------------

export function accountBackupRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const read = limit("account-backup-read", 240, 60000);
  const write = limit("account-backup", 300, 3600000);
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;

  // Account → Data: the last backup's date, the reminder, and how much a
  // backup would hold (counts only).
  app.get("/api/account/backup", requireUser, read, (req, res) => {
    const user = req.user.id,
      at = now();
    res.json({
      ...backupState(db, user, at),
      counts: {
        chats: count(`SELECT COUNT(*) n FROM conversations c WHERE ${PERSONAL}`, user, at),
        bookmarks: count(
          `SELECT COUNT(*) n FROM bookmarks b JOIN messages m ON m.id=b.message_id JOIN conversations c ON c.id=m.conversation_id WHERE b.user_id=? AND ${PERSONAL}`,
          user,
          user,
          at,
        ),
        projects: count("SELECT COUNT(*) n FROM projects WHERE user_id=?", user),
        scrolls: count("SELECT COUNT(*) n FROM scrolls WHERE user_id=?", user),
        instructions: count("SELECT COUNT(*) n FROM user_instructions WHERE user_id=? AND trim(body)<>''", user),
        memory: count("SELECT COUNT(*) n FROM memory_facts WHERE user_id=?", user),
        routines: count("SELECT COUNT(*) n FROM routines WHERE user_id=? AND kind='prompt'", user),
        research: count("SELECT COUNT(*) n FROM routines WHERE user_id=? AND kind='research'", user),
        watches: count("SELECT COUNT(*) n FROM page_watches WHERE user_id=?", user),
      },
      seed_guard: isReleased(cfg, "seedguard"),
    });
  });

  // Everything but the chats, for a backup being made: projects with their
  // instructions, scrolls, standing instructions, memory facts, the
  // settings of routines and watches (never their results or the pages they
  // read), and bookmarks by message.
  app.get("/api/account/backup/content", requireUser, read, (req, res) => {
    const user = req.user.id,
      at = now();
    const definition = (r) => ({
      name: r.name,
      model: r.model,
      private_only: r.private_only,
      schedule: r.schedule,
      monthly_budget_credits: r.monthly_budget_credits,
      created: r.created,
    });
    const instructions = db.prepare("SELECT body,enabled FROM user_instructions WHERE user_id=?").get(user);
    res.json({
      projects: db
        .prepare("SELECT id,name,color,instructions,starts,model,created FROM projects WHERE user_id=? ORDER BY created,rowid")
        .all(user),
      scrolls: db.prepare("SELECT title,body,created FROM scrolls WHERE user_id=? ORDER BY created,rowid").all(user),
      instructions: instructions?.body?.trim() ? { body: instructions.body, enabled: !!instructions.enabled } : null,
      memory: db
        .prepare("SELECT text,enabled,created FROM memory_facts WHERE user_id=? ORDER BY created,rowid")
        .all(user)
        .map((f) => ({ ...f, enabled: !!f.enabled })),
      routines: listRoutines(db, user, at, "prompt").map((r) => ({
        ...definition(r),
        prompt: r.prompt,
        web_search: r.web_search,
        per_run_credits: r.per_run_credits,
      })),
      research: listRoutines(db, user, at, "research").map((r) => ({
        ...definition(r),
        topic: r.topic,
        depth: r.depth,
        new_only: r.new_only,
      })),
      watches: db
        .prepare("SELECT url,hint,model,private_only,every,monthly_budget,created FROM page_watches WHERE user_id=? ORDER BY created,rowid")
        .all(user)
        .map(({ monthly_budget, private_only, ...w }) => ({
          ...w,
          private_only: !!private_only,
          monthly_budget_credits: credits(monthly_budget),
        })),
      bookmarks: db
        .prepare(
          `SELECT b.message_id,m.conversation_id,b.note,b.created FROM bookmarks b JOIN messages m ON m.id=b.message_id JOIN conversations c ON c.id=m.conversation_id
           WHERE b.user_id=? AND ${PERSONAL} ORDER BY b.created,b.rowid`,
        )
        .all(user, user, at),
    });
  });

  // The account's saved personal chats, a page at a time (at most 25 chats,
  // and about 8 MB of words unless one chat is larger): each chat's title,
  // dates, project and its messages' words, with which model wrote each
  // reply. Images and files in messages are left out. `next` continues.
  app.get("/api/account/backup/chats", requireUser, read, (req, res) => {
    const user = req.user.id,
      at = now();
    const after = req.query.after == null ? 0 : Number(req.query.after);
    if (!Number.isSafeInteger(after) || after < 0) fail(400, "after must be the next value of the last page.", "invalid_request");
    const rows = db
      .prepare(
        `SELECT c.rowid cursor,c.id,c.title,c.mode,c.created,c.updated,pc.project_id project FROM conversations c
         LEFT JOIN project_chats pc ON pc.conversation_id=c.id AND pc.user_id=c.user_id
         WHERE ${PERSONAL} AND c.rowid>? ORDER BY c.rowid LIMIT ?`,
      )
      .all(user, at, after, CHATS_PER_PAGE + 1);
    const messagesOf = db.prepare(
      "SELECT id,role,content,model,created FROM messages WHERE conversation_id=? AND role IN ('user','assistant') ORDER BY created,rowid",
    );
    const chats = [];
    let size = 0,
      next = null;
    for (const [i, row] of rows.entries()) {
      if (i === CHATS_PER_PAGE || (chats.length && size > PAGE_CHARS)) {
        next = rows[i - 1].cursor;
        break;
      }
      const { cursor, ...chat } = row;
      const messages = messagesOf.all(chat.id).map((m) => {
        let content = null;
        try {
          content = JSON.parse(m.content);
        } catch {
          content = null;
        }
        const text = messageText(content);
        size += text.length;
        return { id: m.id, role: m.role, text, model: m.role === "assistant" ? m.model || null : null, created: m.created };
      });
      chats.push({ ...chat, mode: chat.mode || "chat", title: chat.title || "", messages });
    }
    res.json({ chats, next });
  });

  // A backup was saved: only today's date is kept (the browser's own day
  // when it sends one within a day of ours, so "Last backup" matches its
  // calendar), and the reminder starts over.
  app.post("/api/account/backup/made", requireUser, limit("account-backup-made", 30, 3600000), (req, res) => {
    const user = req.user.id,
      at = now();
    const sent = req.body?.day;
    const day =
      validDay(sent) && Math.abs(Date.parse(sent + "T12:00:00Z") - at) <= 1.5 * DAY ? sent : isoDay(at);
    db.prepare(
      "INSERT INTO account_backups(user_id,last_backup,reminded) VALUES(?,?,NULL) ON CONFLICT(user_id) DO UPDATE SET last_backup=excluded.last_backup,reminded=NULL",
    ).run(user, day);
    res.json(backupState(db, user));
  });
  // The reminder was seen (made a backup from it, or "Not now"): it doesn't
  // come back until 30 days after the next backup.
  app.post("/api/account/backup/reminder", requireUser, read, (req, res) => {
    const user = req.user.id;
    db.prepare("UPDATE account_backups SET reminded=? WHERE user_id=?").run(isoDay(now()), user);
    res.json(backupState(db, user));
  });

  // Restoring chats: each through Chat Import's checks and insert, in the
  // mode it was saved in when this server has that mode's update live (else
  // as an ordinary chat, marked mode_fallback), filed in a (restored)
  // project of this account when one is given, with the notes of its
  // bookmarks. Symposium runs fill the Symposium cap, everything else the
  // saved-chat cap. Skipped, with a reason, rather than refused: invalid,
  // empty, too_large, duplicate, seed_phrase_blocked, conversation_limit.
  app.post("/api/account/backup/restore/chats", requireUser, write, (req, res) => {
    const { chats } = req.body ?? {};
    if (!Array.isArray(chats) || !chats.length || chats.length > MAX_CHATS_PER_REQUEST)
      fail(400, `Send 1 to ${MAX_CHATS_PER_REQUEST} chats at a time.`, "invalid_request");
    let size = 0;
    for (const c of chats)
      if (Array.isArray(c?.messages))
        for (const m of c.messages) if (typeof m?.text === "string") size += m.text.length;
    if (size > MAX_REQUEST_CHARS)
      fail(413, "That is too much text for one request. Send fewer chats at a time.", "import_too_large");
    const user = req.user.id,
      at = now(),
      seedGuard = isReleased(cfg, "seedguard");
    const expires = defaultExpiry(db, user, at);
    let { room } = chatRoom(db, cfg, user);
    let runRoom = Math.max(
      0,
      capsFor(db, cfg, user).symposium -
        count("SELECT COUNT(*) n FROM conversations WHERE user_id=? AND collab_id IS NULL AND mode='symposium'", user),
    );
    const released = (id) => isReleased(cfg, id);
    // Chats already here, by how many messages with words they have: only
    // those with the same number are read and hashed, once each.
    const byLength = new Map();
    for (const r of db
      .prepare(
        `SELECT c.id,COUNT(CASE WHEN length(trim(coalesce(${TEXT},'')))>0 THEN 1 END) n FROM conversations c
         JOIN messages m ON m.conversation_id=c.id AND m.role IN ('user','assistant')
         WHERE c.user_id=? AND c.collab_id IS NULL GROUP BY c.id`,
      )
      .all(user))
      byLength.set(r.n, [...(byLength.get(r.n) || []), r.id]);
    const hashed = new Map();
    const wordsOf = db.prepare(
      "SELECT role,content FROM messages WHERE conversation_id=? AND role IN ('user','assistant') ORDER BY created,rowid",
    );
    const keyOf = (id) => {
      if (!hashed.has(id))
        hashed.set(
          id,
          hash(
            chatKey(
              wordsOf.all(id).map((m) => {
                let content = null;
                try {
                  content = JSON.parse(m.content);
                } catch {
                  content = null;
                }
                return { role: m.role, text: messageText(content) };
              }),
            ),
          ),
        );
      return hashed.get(id);
    };
    const restoredBefore = db.prepare("SELECT 1 FROM backup_restores WHERE user_id=? AND content_hash=?");
    const ownProject = db.prepare("SELECT id FROM projects WHERE id=? AND user_id=?");
    const mark = db.prepare("INSERT INTO backup_restores(conversation_id,user_id,content_hash,restored) VALUES(?,?,?,?)");
    const file = db.prepare("INSERT INTO project_chats(conversation_id,project_id,user_id,added) VALUES(?,?,?,?)");
    const star = db.prepare("INSERT INTO bookmarks(id,user_id,message_id,note,created,updated) VALUES(?,?,?,?,?,?)");
    const inRequest = new Set();
    const saved = [],
      skipped = [];
    const carry = (m) => ({
      ...(m.role === "assistant" && typeof m.model === "string" && m.model.length <= 200 ? { model: m.model } : {}),
      ...(typeof m.bookmark === "string" && m.bookmark.length <= 140 ? { bookmark: m.bookmark.trim() } : {}),
    });
    chats.forEach((raw, index) => {
      const checked = checkUploadedChat(raw, at, { carry });
      if (!checked.chat) return skipped.push({ index, reason: checked.reason });
      const chat = checked.chat;
      const key = hash(chatKey(chat.messages));
      if (
        inRequest.has(key) ||
        restoredBefore.get(user, key) ||
        (byLength.get(chat.messages.length) || []).some((id) => keyOf(id) === key)
      )
        return skipped.push({ index, reason: "duplicate" });
      if (seedGuard && !chat.allowSeed && uploadedSeedFinding(chat))
        return skipped.push({ index, reason: "seed_phrase_blocked" });
      const wanted = typeof raw.mode === "string" ? raw.mode.slice(0, 40) : "chat";
      const { mode, fallback } = restoredMode(wanted, released);
      const run = mode === "symposium";
      if ((run ? runRoom : room) <= 0) return skipped.push({ index, reason: "conversation_limit" });
      const project = typeof raw.project === "string" && ownProject.get(raw.project, user) ? raw.project : null;
      const result = transaction(db, () => {
        const made = insertChat(db, user, chat, expires, mode);
        mark.run(made.id, user, key, at);
        if (project) file.run(made.id, project, user, at);
        let starred = 0;
        chat.messages.forEach((m, i) => {
          if (m.bookmark == null) return;
          try {
            star.run(uid("bm_"), user, made.messages[i], m.bookmark, at, at);
            starred++;
          } catch {
            // The account's bookmark limit: the chat is still restored.
          }
        });
        return { id: made.id, bookmarks: starred };
      });
      inRequest.add(key);
      if (run) runRoom--;
      else room--;
      saved.push({
        index,
        id: result.id,
        mode,
        ...(fallback ? { mode_fallback: wanted } : {}),
        ...(project ? { project } : {}),
        bookmarks: result.bookmarks,
      });
    });
    res.json({ saved, skipped, room });
  });

  // Restoring scrolls, with the same limits as saving one; skipped with a
  // reason: invalid, duplicate, seed_phrase_blocked, scroll_limit.
  app.post("/api/account/backup/restore/scrolls", requireUser, write, (req, res) => {
    const { scrolls } = req.body ?? {};
    if (!Array.isArray(scrolls) || !scrolls.length || scrolls.length > 100)
      fail(400, "Send 1 to 100 scrolls at a time.", "invalid_request");
    const user = req.user.id,
      at = now(),
      seedGuard = isReleased(cfg, "seedguard");
    const have = db.prepare("SELECT title,body FROM scrolls WHERE user_id=?").all(user);
    const keys = new Set(have.map((s) => hash(scrollKey(s))));
    let total = have.length;
    const add = db.prepare("INSERT INTO scrolls(id,user_id,title,body,created,updated) VALUES(?,?,?,?,?,?)");
    const saved = [],
      skipped = [];
    scrolls.forEach((raw, index) => {
      const title = typeof raw?.title === "string" ? raw.title.trim() : "";
      const body = typeof raw?.body === "string" ? raw.body : "";
      if (!title || title.length > MAX_TITLE || !body.trim() || body.length > MAX_BODY)
        return skipped.push({ index, reason: "invalid" });
      const key = hash(scrollKey({ title, body }));
      if (keys.has(key)) return skipped.push({ index, reason: "duplicate" });
      const seed = [title, body].some((t) => !!findSeedPhrase(t) || !!findPrivateKey(t));
      if (seedGuard && raw.allow_seed_phrase !== true && seed)
        return skipped.push({ index, reason: "seed_phrase_blocked" });
      if (total >= MAX_SCROLLS) return skipped.push({ index, reason: "scroll_limit" });
      const created = Number.isFinite(raw.created) && raw.created > 0 && raw.created <= at ? Math.round(raw.created) : at;
      const id = uid("scroll_");
      add.run(id, user, title, body, created, created);
      keys.add(key);
      total++;
      saved.push({ index, id });
    });
    res.json({ saved, skipped });
  });
}
