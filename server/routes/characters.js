import { randomBytes } from "node:crypto";
import { uid, now, fail, transaction, callable } from "../core.js";
import { isReleased, modelReleased } from "../releases.js";
import { viewerOf } from "../early-models.js";
import { findSeedPhrase, findPrivateKey } from "../../src/seed-guard.js";
import { cleanAvatar } from "../character-avatar.js";
import {
  MAX_CHARACTERS,
  MAX_CHARACTER_NAME,
  MAX_CHARACTER_DESCRIPTION,
  MAX_CHARACTER_INSTRUCTIONS,
  MAX_CHARACTER_OPENING,
  MAX_ACTIVE_SHARES,
  MAX_SHARES_PER_CHARACTER,
  SHARE_DAYS,
  SHARE_TOKEN,
  SHARE_TOKEN_BYTES,
  parseShareDays,
  shareUrl,
} from "../../src/characters.js";

// Characters (update "characters"): AI characters an account makes for
// itself, each with a name, a short description, instructions (the
// personality), an opening message, a default model and a picture. They are
// the account's own and private: nothing here is listed anywhere public.
//
// The browser sends a character's instructions with every chat in it, as
// part of the one leading system message, exactly as a project's (see
// src/characters.js): the server doesn't add them, so Veil can mask them.
// Its opening message is the first assistant turn of a saved chat; the
// server writes it once, when the chat is filed, with no model and no charge.
// A saved chat is filed with its character (character_chats); off-the-record,
// Private and Device-only chats are never saved, so never filed.
//
// "Share a copy" makes a link another signed-in account can use to add a
// copy of the character as it was when the link was made: no chats, no
// account, nothing about its owner. The link is revocable, expires (30 days
// by default) and goes with its character. The release gate in releases.js
// refuses all of these routes while the update is unreleased.
const SEED_MESSAGE =
  "This looks like a wallet seed phrase. A character's text is saved and sent with its chats, so ANONYMA won't save one. Remove it to continue.";
const SHARE_SEED_MESSAGE =
  "This character holds what looks like a wallet seed phrase or private key, so ANONYMA won't share it. Remove it and try again.";
const DAY = 86400000;

// A saved chat with a character: its own, newest first. An auto-deleted one
// is gone at once, as everywhere else.
const filedChats = (db, character, user, take = 50) =>
  db
    .prepare(
      `SELECT c.id,c.title,c.mode,c.created,c.updated,c.expires FROM character_chats cc
       JOIN conversations c ON c.id=cc.conversation_id
       WHERE cc.character_id=? AND cc.user_id=? AND c.user_id=cc.user_id AND c.collab_id IS NULL
         AND (c.expires IS NULL OR c.expires>=?)
       ORDER BY c.updated DESC,c.rowid DESC LIMIT ?`,
    )
    .all(character, user, now(), take);
const chatCount = (db, character, user) =>
  db
    .prepare(
      `SELECT COUNT(*) n FROM character_chats cc JOIN conversations c ON c.id=cc.conversation_id
       WHERE cc.character_id=? AND cc.user_id=? AND c.user_id=cc.user_id AND c.collab_id IS NULL
         AND (c.expires IS NULL OR c.expires>=?)`,
    )
    .get(character, user, now()).n;
const view = (db, row, detail = false) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  instructions: row.instructions,
  opening: row.opening,
  model: row.model,
  avatar: row.avatar,
  chat_count: chatCount(db, row.id, row.user_id),
  created: row.created,
  updated: row.updated,
  ...(detail ? { chats: filedChats(db, row.id, row.user_id) } : {}),
});
export const listCharacters = (db, user) =>
  db
    .prepare("SELECT * FROM characters WHERE user_id=? ORDER BY created,rowid")
    .all(user)
    .map((row) => view(db, row));

// A link that hasn't expired, of a character that still exists, made by an
// account that is still open.
const LIVE_SHARE = `s.expires>? AND u.deleted IS NULL`;
const SHARE_FROM = `FROM character_shares s JOIN users u ON u.id=s.user_id`;

// For the account export: each character whole (its picture as the data URL
// it is stored as), the saved chats filed with it (by id; their messages are
// exported with the conversations) and its live copy links.
export function exportCharacters(db, user, base) {
  return db
    .prepare("SELECT * FROM characters WHERE user_id=? ORDER BY created,rowid")
    .all(user)
    .map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      opening: row.opening,
      model: row.model,
      avatar: row.avatar,
      created: row.created,
      updated: row.updated,
      conversations: filedChats(db, row.id, user, 100000).map((c) => c.id),
      share_links: db
        .prepare(
          `SELECT s.id,s.token,s.created,s.expires ${SHARE_FROM} WHERE s.character_id=? AND s.user_id=? AND ${LIVE_SHARE} ORDER BY s.created,s.rowid`,
        )
        .all(row.id, user, now())
        .map(({ token, ...s }) => ({ ...s, url: shareUrl(base, token) })),
    }));
}
// Account closure, Panic Wipe and Inactivity Wipe (eraseAccountContent in
// routes/account.js): the links first, then what filed each chat, then the
// characters (the chats themselves go with the conversations).
export function forgetCharacters(db, user) {
  db.prepare("DELETE FROM character_shares WHERE user_id=?").run(user);
  db.prepare("DELETE FROM character_chats WHERE user_id=?").run(user);
  db.prepare("DELETE FROM characters WHERE user_id=?").run(user);
}

export function characterRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const read = limit("characters-read", 240, 60000);
  const write = limit("characters", 240, 3600000);
  const shareWrite = limit("character-shares", 30, 3600000);
  const shareRead = limit("character-share-view", 60, 60000);
  const base = () => String(cfg.publicUrl || cfg.origin).replace(/\/+$/, "");
  // A copy link's data and the address of the page it opens: kept out of
  // search indexes and caches, and the token never travels on as a referrer.
  const privatePage = (res) =>
    res.set({
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
  const owned = (id, user) => {
    const row =
      typeof id === "string" &&
      id.length <= 100 &&
      db.prepare("SELECT * FROM characters WHERE id=? AND user_id=?").get(id, user);
    if (!row) fail(404, "Character not found.", "character_not_found");
    return row;
  };
  // Unknown, revoked, expired and deleted all look the same.
  const missing = () => fail(404, "This character link isn't available.", "share_not_found");
  // Seed Guard: a character's text is saved and sent with its chats, so a
  // seed phrase is never saved in it, with no override.
  const seedGuard = (...texts) => {
    if (isReleased(cfg, "seedguard") && texts.some((t) => findSeedPhrase(t)))
      fail(400, SEED_MESSAGE, "seed_phrase_blocked");
  };
  // A link hands the text to other people, so it also refuses a private
  // key, which the browser only asks to confirm.
  const shareGuard = (...texts) => {
    if (isReleased(cfg, "seedguard") && texts.some((t) => findSeedPhrase(t) || findPrivateKey(t)))
      fail(400, SHARE_SEED_MESSAGE, "seed_phrase_blocked");
  };
  // A chat model this installation offers and can run.
  const chatModel = (id) => {
    const m = typeof id === "string" && id.length <= 200 && ctx.models.find(id);
    if (
      !m ||
      m.type !== "chat" ||
      (m.architecture?.output_modalities || []).includes("image") ||
      !modelReleased(m, cfg)
    )
      return null;
    return m;
  };
  // A character's fields from a request body; `existing` keeps what a PATCH
  // leaves out.
  function input(body, existing = null) {
    const has = (k) => Object.hasOwn(body || {}, k);
    const need = (k) => !existing || has(k);
    const next = existing
      ? {
          name: existing.name,
          description: existing.description,
          instructions: existing.instructions,
          opening: existing.opening,
          model: existing.model,
          avatar: existing.avatar,
        }
      : { description: "", instructions: "", opening: "", model: null, avatar: null };
    if (need("name")) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > MAX_CHARACTER_NAME)
        fail(400, `Give the character a name of 1–${MAX_CHARACTER_NAME} characters.`, "invalid_character");
      next.name = name;
    }
    const text = (key, max, label) => {
      if (!has(key)) return;
      if (typeof body[key] !== "string" || body[key].length > max)
        fail(400, `${label} cannot exceed ${max} characters.`, "invalid_character");
      next[key] = key === "description" ? body[key].trim() : body[key];
    };
    text("description", MAX_CHARACTER_DESCRIPTION, "The description");
    text("instructions", MAX_CHARACTER_INSTRUCTIONS, "Instructions");
    text("opening", MAX_CHARACTER_OPENING, "The opening message");
    seedGuard(next.description, next.instructions, next.opening);
    if (has("model")) {
      if (body.model === null || body.model === "") next.model = null;
      else {
        const m = chatModel(body.model);
        if (!m) fail(400, "Choose a chat model, or no default.", "invalid_model");
        next.model = m.id;
      }
    }
    if (has("avatar")) next.avatar = cleanAvatar(body.avatar);
    return next;
  }
  // A model in its early days needs Insider tier and up.
  const earlyCheck = (req, model) => {
    if (model) ctx.earlyModels.check(viewerOf(req), "models", model);
  };
  function insert(user, next) {
    const id = uid("chr_");
    transaction(db, () => {
      const n = db.prepare("SELECT COUNT(*) n FROM characters WHERE user_id=?").get(user).n;
      if (n >= MAX_CHARACTERS)
        fail(
          409,
          `You can have up to ${MAX_CHARACTERS} characters. Delete one to add another.`,
          "character_limit",
        );
      const at = now();
      db.prepare(
        "INSERT INTO characters(id,user_id,name,description,instructions,opening,model,avatar,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(id, user, next.name, next.description, next.instructions, next.opening, next.model, next.avatar, at, at);
    });
    return id;
  }

  app.get("/api/characters", requireUser, read, (req, res) =>
    res.json({
      characters: listCharacters(db, req.user.id),
      max_characters: MAX_CHARACTERS,
      limits: {
        name: MAX_CHARACTER_NAME,
        description: MAX_CHARACTER_DESCRIPTION,
        instructions: MAX_CHARACTER_INSTRUCTIONS,
        opening: MAX_CHARACTER_OPENING,
        active_shares: MAX_ACTIVE_SHARES,
        shares_per_character: MAX_SHARES_PER_CHARACTER,
        share_days: SHARE_DAYS,
      },
    }),
  );
  app.post("/api/characters", requireUser, write, (req, res) => {
    const next = input(req.body || {});
    earlyCheck(req, next.model);
    const id = insert(req.user.id, next);
    res.status(201).json(view(db, owned(id, req.user.id), true));
  });
  app.get("/api/characters/:id", requireUser, read, (req, res) =>
    res.json(view(db, owned(req.params.id, req.user.id), true)),
  );
  app.patch("/api/characters/:id", requireUser, write, (req, res) => {
    const row = owned(req.params.id, req.user.id);
    const next = input(req.body || {}, row);
    if (Object.hasOwn(req.body || {}, "model")) earlyCheck(req, next.model);
    db.prepare(
      "UPDATE characters SET name=?,description=?,instructions=?,opening=?,model=?,avatar=?,updated=? WHERE id=? AND user_id=?",
    ).run(
      next.name,
      next.description,
      next.instructions,
      next.opening,
      next.model,
      next.avatar,
      now(),
      row.id,
      req.user.id,
    );
    res.json(view(db, owned(row.id, req.user.id), true));
  });
  // Deleting a character keeps its chats, as plain chats; its copy links stop
  // working with it (they hold only the copy they made).
  app.delete("/api/characters/:id", requireUser, write, (req, res) => {
    const row = owned(req.params.id, req.user.id);
    db.prepare("DELETE FROM characters WHERE id=? AND user_id=?").run(row.id, req.user.id);
    res.json({ ok: true });
  });
  // A copy of one of your own characters: the same fields, none of its chats
  // and none of its links.
  app.post("/api/characters/:id/duplicate", requireUser, write, (req, res) => {
    const row = owned(req.params.id, req.user.id);
    const suffix = " (copy)";
    const id = insert(req.user.id, {
      name: row.name.slice(0, MAX_CHARACTER_NAME - suffix.length) + suffix,
      description: row.description,
      instructions: row.instructions,
      opening: row.opening,
      model: row.model,
      avatar: row.avatar,
    });
    res.status(201).json(view(db, owned(id, req.user.id), true));
  });

  // ---- Share a copy ----
  const shareView = (s) => ({
    id: s.id,
    character_id: s.character_id,
    url: shareUrl(base(), s.token),
    created: s.created,
    expires: s.expires,
  });
  const liveShares = (user, character = null) =>
    db
      .prepare(
        `SELECT s.id,s.character_id,s.token,s.created,s.expires ${SHARE_FROM}
         WHERE s.user_id=? AND ${LIVE_SHARE} ${character ? "AND s.character_id=?" : ""}
         ORDER BY s.created DESC,s.rowid DESC`,
      )
      .all(...[user, now(), ...(character ? [character] : [])]);
  app.get("/api/characters/:id/shares", requireUser, read, (req, res) => {
    const row = owned(req.params.id, req.user.id);
    res.json({
      data: liveShares(req.user.id, row.id).map(shareView),
      limits: { active: MAX_ACTIVE_SHARES, per_character: MAX_SHARES_PER_CHARACTER, days: SHARE_DAYS },
    });
  });
  app.post("/api/characters/:id/shares", requireUser, shareWrite, (req, res) => {
    const row = owned(req.params.id, req.user.id);
    const expiry = parseShareDays(req.body?.expires_in_days);
    if (!expiry.ok) fail(400, "expires_in_days must be 1, 7 or 30.", "invalid_request");
    // What the link would hold, checked again: a character saved before Seed
    // Guard was released may still carry a phrase.
    shareGuard(row.name, row.description, row.instructions, row.opening);
    const made = transaction(db, () => {
      const t = now();
      const all = liveShares(req.user.id);
      if (all.length >= MAX_ACTIVE_SHARES)
        fail(400, `You can have up to ${MAX_ACTIVE_SHARES} active copy links. Revoke one first.`, "share_limit");
      if (all.filter((s) => s.character_id === row.id).length >= MAX_SHARES_PER_CHARACTER)
        fail(
          400,
          `A character can have up to ${MAX_SHARES_PER_CHARACTER} active copy links. Revoke one first.`,
          "share_limit",
        );
      const id = uid("chs_"),
        token = randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
      db.prepare(
        "INSERT INTO character_shares(id,user_id,character_id,token,snapshot,created,expires) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        req.user.id,
        row.id,
        token,
        JSON.stringify({
          name: row.name,
          description: row.description,
          instructions: row.instructions,
          opening: row.opening,
          model: row.model,
          avatar: row.avatar,
        }),
        t,
        t + expiry.days * DAY,
      );
      return { id, token, created: t, expires: t + expiry.days * DAY };
    });
    res.status(201).json(shareView({ ...made, character_id: row.id }));
  });
  // Revoking deletes the copy: the link stops working at once.
  app.delete("/api/character-shares/:id", requireUser, write, (req, res) => {
    const r = db
      .prepare("DELETE FROM character_shares WHERE id=? AND user_id=?")
      .run(String(req.params.id), req.user.id);
    if (!r.changes) fail(404, "Copy link not found.", "not_found");
    res.json({ ok: true });
  });
  // What a link holds, for a signed-in account to read before it adds a copy:
  // the whole character, so its instructions can be read in full. Nothing
  // about who made it.
  function shared(token) {
    if (typeof token !== "string" || !SHARE_TOKEN.test(token)) return null;
    const s = db
      .prepare(`SELECT s.snapshot,s.created,s.expires ${SHARE_FROM} WHERE s.token=? AND ${LIVE_SHARE}`)
      .get(token, now());
    return s ? { ...JSON.parse(s.snapshot), created: s.created, expires: s.expires } : null;
  }
  // Whether this account can run the character's model as it is: released,
  // callable and (for an early model) open to it.
  function usable(req, id) {
    const m = id && chatModel(id);
    if (!m || !callable(m, cfg)) return null;
    try {
      ctx.earlyModels.check(viewerOf(req), "models", m.id);
    } catch {
      return null;
    }
    return m;
  }
  app.get("/api/character-shares/:token", requireUser, shareRead, (req, res) => {
    privatePage(res);
    const s = shared(req.params.token);
    if (!s) missing();
    const m = usable(req, s.model);
    res.json({
      name: s.name,
      description: s.description,
      instructions: s.instructions,
      opening: s.opening,
      avatar: s.avatar,
      model: s.model,
      model_name: m?.name || null,
      model_available: !!m,
      created: s.created,
      expires: s.expires,
    });
  });
  app.post("/api/character-shares/:token/import", requireUser, shareWrite, (req, res) => {
    privatePage(res);
    const s = shared(req.params.token);
    if (!s) missing();
    // Secret Guard (src/SecretGuard.jsx): the browser may send the copy's
    // instructions and opening message with passwords, keys or tokens
    // masked as placeholders like [SECRET_1]. Nothing else can change here.
    const edits = req.body || {};
    const own = (key, max, label) => {
      if (edits[key] === undefined) return s[key];
      if (typeof edits[key] !== "string" || edits[key].length > max)
        fail(400, `${label} cannot exceed ${max} characters.`, "invalid_character");
      return edits[key];
    };
    const instructions = own("instructions", MAX_CHARACTER_INSTRUCTIONS, "Instructions");
    const opening = own("opening", MAX_CHARACTER_OPENING, "The opening message");
    // Seed Guard again: it may have been released since the link was made.
    seedGuard(s.description, instructions, opening);
    const m = usable(req, s.model);
    const id = insert(req.user.id, {
      name: s.name,
      description: s.description,
      instructions,
      opening,
      // A model this account can't run isn't carried over: the copy starts
      // with no default and says so.
      model: m ? m.id : null,
      avatar: s.avatar,
    });
    res.status(201).json({ ...view(db, owned(id, req.user.id), true), model_kept: !!m || !s.model });
  });

  return {
    // The character a new chat is filed with: the account's own, checked
    // before anything is reserved. Only saved chats are filed (see runChat).
    forChat(user, id) {
      if (typeof id !== "string" || !id)
        fail(400, "character must be a character id.", "invalid_request");
      return owned(id, user);
    },
    // Files a conversation the chat just created with its character, and
    // writes the opening message as its first turn: an assistant message with
    // no model and no charge, marked so the workspace shows it as the
    // character's greeting rather than a reply.
    file(conversation, character, user) {
      db.prepare(
        "INSERT INTO character_chats(conversation_id,character_id,user_id,added) VALUES(?,?,?,?)",
      ).run(conversation, character.id, user, now());
      const opening = String(character.opening || "").trim();
      if (opening)
        db.prepare(
          "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
        ).run(uid("m_"), conversation, "assistant", JSON.stringify({ text: opening, opening: true }), null, 0, now(), null);
    },
  };
}
