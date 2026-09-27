import { uid, now, fail } from "../core.js";
import { isReleased } from "../releases.js";
import { findSeedPhrase, SEED_MESSAGE } from "../../src/seed-guard.js";
import { checkDeckRecord, slideTexts } from "../../src/slides-spec.js";

// Slides (update "slides"): the decks an account keeps, like its
// conversations: list, open, rename, edit, delete, erased and exported with
// the account. A deck is its title, theme and slides (the text on them and
// the speaker notes), with its dates. Never the source it was made from,
// the model that made it or anything about the request: making a deck is an
// off-the-record chat (server/slides.js), and only what the person saves
// arrives here. Decks made off the record or in Private Mode are kept in the
// browser only (src/slides-store.js) and never reach these routes. With Veil
// on, the text arrives with Veil's placeholders, and the values stay in the
// browser. The release gate in releases.js refuses these routes while the
// update is unreleased.
export const MAX_DECKS = 200;

const view = (r, full = true) => {
  const slides = JSON.parse(r.slides);
  return {
    id: r.id,
    title: r.title,
    theme: r.theme,
    slide_count: slides.length,
    ...(full ? { slides } : { first: slides[0] || null }),
    created: r.created,
    updated: r.updated,
  };
};

// Account export: every deck, whole (it's the account's own content).
export const exportSlideDecks = (db, user) =>
  db
    .prepare("SELECT * FROM slide_decks WHERE user_id=? ORDER BY created,rowid")
    .all(user)
    .map((r) => view(r));
// Account closure and Panic Wipe (eraseAccountContent in routes/account.js).
export const forgetSlideDecks = (db, user) => db.prepare("DELETE FROM slide_decks WHERE user_id=?").run(user);

export function slideRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const read = limit("slides-read", 240, 60000);
  // Autosave sends an edit about a second after typing stops.
  const write = limit("slides", 240, 60000);

  function checked(body, partial) {
    let deck;
    try {
      deck = checkDeckRecord(body, { partial });
    } catch (e) {
      fail(400, e.message, "invalid_deck");
    }
    // Seed Guard: a deck is stored, so a seed phrase is never saved in one.
    if (isReleased(cfg, "seedguard")) {
      const texts = [deck.title || "", ...(deck.slides || []).flatMap(slideTexts)];
      if (texts.some((t) => findSeedPhrase(t))) fail(400, SEED_MESSAGE, "seed_phrase_blocked");
    }
    return deck;
  }
  const one = (id, user) => {
    const r =
      typeof id === "string" &&
      id.length <= 100 &&
      db.prepare("SELECT * FROM slide_decks WHERE id=? AND user_id=?").get(id, user);
    if (!r) fail(404, "Deck not found.", "deck_not_found");
    return r;
  };

  app.get("/api/slides", requireUser, read, (req, res) => {
    const rows = db
      .prepare("SELECT * FROM slide_decks WHERE user_id=? ORDER BY updated DESC,rowid DESC LIMIT ?")
      .all(req.user.id, MAX_DECKS);
    res.json({ data: rows.map((r) => view(r, false)), limit: MAX_DECKS });
  });

  app.post("/api/slides", requireUser, write, (req, res) => {
    const deck = checked(req.body, false);
    const id = uid("deck_"),
      at = now();
    try {
      db.prepare(
        "INSERT INTO slide_decks(id,user_id,title,theme,slides,created,updated) VALUES(?,?,?,?,?,?,?)",
      ).run(id, req.user.id, deck.title, deck.theme, JSON.stringify(deck.slides), at, at);
    } catch (e) {
      if (String(e.message).includes("slides_limit"))
        fail(409, `You can keep up to ${MAX_DECKS} decks. Delete one to save another.`, "slides_limit");
      throw e;
    }
    res.status(201).json(view(one(id, req.user.id)));
  });

  app.get("/api/slides/:id", requireUser, read, (req, res) => res.json(view(one(req.params.id, req.user.id))));

  // Rename, change the theme or save the slides; any of the three.
  app.patch("/api/slides/:id", requireUser, write, (req, res) => {
    const row = one(req.params.id, req.user.id);
    const deck = checked(req.body, true);
    if (!Object.keys(deck).length) fail(400, "Send a title, a theme or the slides to save.", "invalid_deck");
    db.prepare("UPDATE slide_decks SET title=?,theme=?,slides=?,updated=? WHERE id=? AND user_id=?").run(
      deck.title ?? row.title,
      deck.theme ?? row.theme,
      deck.slides ? JSON.stringify(deck.slides) : row.slides,
      now(),
      row.id,
      req.user.id,
    );
    res.json(view(one(row.id, req.user.id)));
  });

  app.delete("/api/slides/:id", requireUser, write, (req, res) => {
    const r = db.prepare("DELETE FROM slide_decks WHERE id=? AND user_id=?").run(String(req.params.id), req.user.id);
    if (!r.changes) fail(404, "Deck not found.", "deck_not_found");
    res.json({ ok: true });
  });
}
