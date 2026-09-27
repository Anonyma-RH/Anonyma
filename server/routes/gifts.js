import { randomBytes, createHmac } from "node:crypto";
import {
  uid,
  hash,
  now,
  fail,
  credits,
  balance,
  hasDisputedCredit,
  transaction,
} from "../core.js";
import { isReleased } from "../releases.js";
import { requestIdentifier } from "../middleware.js";
import { assertSpendingRoom, limitsLive } from "../spending-limits.js";
import { findSeedPhrase, SEED_MESSAGE } from "../../src/seed-guard.js";
import {
  GIFT_DAYS,
  GIFT_MAX,
  GIFT_MIN,
  GIFT_NOTE_MAX,
  GIFT_OPEN_MAX,
  GIFT_RANDOM_SYMBOLS,
  AMOUNT_RULE,
  codeFromBytes,
  giftLink,
  normalizeGiftNote,
  readCode,
} from "../../src/gift-links.js";

// Gift Links: credits turned into a link anyone can claim once.
//
// Money. Creating a gift moves its credits off the giver's balance at once:
// one ledger debit (kind gift_out, ref "<gift>:out") under the same rules as
// sending credits (the dispute pause, the available balance and Spending
// Limits). The gift row then holds them. They leave it exactly once, by one
// of two ledger credits that share ONE ref, "<gift>:settle": gift_in to the
// account that claims it, or gift_return to the giver when it's cancelled,
// expires unclaimed after 30 days, or the giver erases their content. The
// ledger's unique ref makes a second payout impossible whatever code runs,
// on top of the conditional status change (open → one final state, enforced
// by a trigger) inside the same transaction.
//
// Privacy. The code is 135 random bits and only its hash is stored. The link
// carries it after the #, so it never reaches a server log or a referrer;
// the API takes it only in a POST body. Nobody's name is shown to the
// other side: the claimer sees the amount and note, the giver sees only that
// it was claimed and when. Who claimed a gift isn't stored on the gift; the
// ledger alone links the two credits, for audit. Wrong codes count toward a
// lockout per account and per address, keyed by an HMAC under the
// installation secret, so the table holds no address or account id.
//
// Gifts are not top-ups: they create no deposit, so referral rewards (paid
// only on confirmed deposits) and NYMA top-up bonuses never see them.

const UNIT = 10000; // integer subcredits per credit
const HOUR = 3600000;
export const GIFT_TTL = GIFT_DAYS * 24 * HOUR;
// Claim-attempt lockout: wrong codes within an hour, per account and per
// network address. Past the limit, every attempt (a right code too) is
// refused until the hour is up.
export const LOCK_WINDOW = HOUR;
export const ACCOUNT_FAILURES = 10;
export const ADDRESS_FAILURES = 30;

export const codeHash = (symbols) => hash("anonyma gift v1:" + symbols);
const LEDGER =
  "INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)";

// The giver's view of one of their gifts.
export const giftView = (g) => ({
  id: g.id,
  amount: credits(g.amount),
  note: g.note,
  status: g.status,
  created: g.created,
  expires: g.expires,
  claimed: g.status === "claimed" ? g.settled : null,
  returned: g.status === "revoked" || g.status === "expired" ? g.settled : null,
});

// Gives an open gift's credits back to its giver, inside the caller's
// transaction. False when it wasn't open (claimed or returned already).
function returnGift(db, gift, status, at, description) {
  const changed = db
    .prepare("UPDATE gifts SET status=?,settled=? WHERE id=? AND status='open'")
    .run(status, at, gift.id).changes;
  if (!changed) return false;
  db.prepare(LEDGER).run(
    uid("l_"),
    gift.user_id,
    gift.amount,
    "gift_return",
    gift.id + ":settle",
    null,
    description,
    at,
  );
  return true;
}

// The worker: every gift still open at its deadline goes back to its giver,
// each in its own transaction. Runs whether or not the update is released,
// so switching it off again never strands credits. Nothing is logged.
export function expireGifts(db, at = now(), batch = 200) {
  let returned = 0;
  for (const g of db
    .prepare("SELECT * FROM gifts WHERE status='open' AND expires<=? ORDER BY expires LIMIT ?")
    .all(at, batch))
    transaction(db, () => {
      if (returnGift(db, g, "expired", at, `Gift returned: unclaimed after ${GIFT_DAYS} days`))
        returned++;
    });
  db.prepare("DELETE FROM gift_lockouts WHERE window_end<=?").run(at);
  return returned;
}

// The account export: every gift this account made (amounts, notes, dates
// and states). Never a code (none is kept) and never who claimed one.
export const exportGifts = (db, user) =>
  db
    .prepare("SELECT * FROM gifts WHERE user_id=? ORDER BY created,rowid")
    .all(user)
    .map(giftView);

// Account closure and Panic Wipe (eraseAccountContent in routes/account.js),
// inside their transaction: every unclaimed gift is cancelled first and its
// credits come back to the balance (a wipe keeps them; closure forfeits them
// with the rest), then the account's gift rows go. Their ledger entries stay
// with the ledger.
export function forgetGifts(db, user, at = now()) {
  for (const g of db
    .prepare("SELECT * FROM gifts WHERE user_id=? AND status='open'")
    .all(user))
    returnGift(db, g, "revoked", at, "Gift cancelled: account content erased");
  db.prepare("DELETE FROM gifts WHERE user_id=?").run(user);
}

// Claiming, in one transaction: exactly one account gets an open gift's
// credits (gift_in, ref "<gift>:settle"). Null when no gift has this code
// (the caller counts that as a wrong guess); refused (thrown) for the
// giver's own gift, one already claimed or returned, or while the giver has
// a payment under reconciliation. `symbols` is a code's 28 symbols.
export function claimGift(db, user, symbols) {
  return transaction(db, () => {
    const g = db.prepare("SELECT * FROM gifts WHERE code_hash=?").get(codeHash(symbols));
    if (!g) return null;
    if (g.user_id === user)
      fail(
        400,
        "This is your own gift. Send the link to someone else, or cancel the gift to get the credits back.",
        "gift_own",
      );
    const at = now();
    if (g.status === "claimed")
      fail(410, "This gift has already been claimed.", "gift_claimed");
    if (g.status !== "open" || g.expires <= at)
      fail(
        410,
        "This gift is no longer available. Its credits went back to the person who sent it.",
        "gift_returned",
      );
    // While the giver has a credited payment under reconciliation, the gift
    // waits, as a transfer would. The message says nothing about the
    // giver's payments.
    if (hasDisputedCredit(db, g.user_id))
      fail(409, "This gift can't be claimed right now. Try again later.", "gift_paused");
    const won = db
      .prepare("UPDATE gifts SET status='claimed',settled=? WHERE id=? AND status='open' AND expires>?")
      .run(at, g.id, at).changes;
    if (!won) fail(410, "This gift has already been claimed.", "gift_claimed");
    db.prepare(LEDGER).run(uid("l_"), user, g.amount, "gift_in", g.id + ":settle", null, "Gift claimed", at);
    return g;
  });
}

// Cancelling an open gift: its credits come back to the giver at once.
export function revokeGift(db, user, id) {
  return transaction(db, () => {
    const g = db.prepare("SELECT * FROM gifts WHERE id=? AND user_id=?").get(id, user);
    if (!g) fail(404, "Gift not found.", "gift_not_found");
    if (!returnGift(db, g, "revoked", now(), "Gift cancelled"))
      fail(
        409,
        g.status === "claimed"
          ? "This gift was already claimed, so it can't be cancelled."
          : "This gift was already returned.",
        "gift_not_open",
      );
    return db.prepare("SELECT * FROM gifts WHERE id=?").get(g.id);
  });
}

export function giftRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const origin = () => cfg.publicUrl || cfg.origin;
  const byAddress = (req) => "address:" + req.ip;

  // ---- Claim-attempt lockout ----
  const lockKey = (subject) =>
    createHmac("sha256", cfg.secret).update("anonyma gift lockout v1:" + subject).digest("hex");
  const lockKeys = (req) => [
    { key: lockKey("address:" + req.ip), max: ADDRESS_FAILURES },
    ...(req.user ? [{ key: lockKey("account:" + req.user.id), max: ACCOUNT_FAILURES }] : []),
  ];
  function assertNotLocked(req, res) {
    const t = now();
    for (const { key, max } of lockKeys(req)) {
      const row = db
        .prepare("SELECT failures,window_end FROM gift_lockouts WHERE key=? AND window_end>?")
        .get(key, t);
      if (row && row.failures >= max) {
        const wait = row.window_end - t;
        res.set("Retry-After", String(Math.max(1, Math.ceil(wait / 1000))));
        fail(
          429,
          `Too many wrong gift codes. Try again in ${Math.max(1, Math.ceil(wait / 60000))} min.`,
          "gift_locked",
        );
      }
    }
  }
  const recordFailure = (req) => {
    const t = now();
    for (const { key } of lockKeys(req))
      db.prepare(
        `INSERT INTO gift_lockouts(key,failures,window_end) VALUES(?,1,?)
         ON CONFLICT(key) DO UPDATE SET
           failures=CASE WHEN window_end<=? THEN 1 ELSE failures+1 END,
           window_end=CASE WHEN window_end<=? THEN excluded.window_end ELSE window_end END`,
      ).run(key, t + LOCK_WINDOW, t, t);
  };
  // A code from the request body, in its canonical form. A malformed code
  // or one with a typo (its check symbol is wrong) can't match any gift, so
  // it's refused without counting as a guess.
  function codeFrom(req) {
    if (typeof req.body.code !== "string")
      fail(400, "Enter a gift code.", "gift_code_invalid");
    const read = readCode(req.body.code);
    if (!read)
      fail(400, "That isn't a gift code. A code has 28 letters and numbers.", "gift_code_invalid");
    if (read.typo)
      fail(400, "That code has a typo. Check it and try again.", "gift_code_typo");
    return read.symbols;
  }
  const notFound = () =>
    fail(404, "No gift matches this code. Check it and try again.", "gift_not_found");

  // ---- The giver ----
  app.get("/api/gifts", requireUser, (req, res) => {
    const rows = db
      .prepare("SELECT * FROM gifts WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT 100")
      .all(req.user.id);
    res.json({
      data: rows.map(giftView),
      open: db
        .prepare("SELECT COUNT(*) n FROM gifts WHERE user_id=? AND status='open'")
        .get(req.user.id).n,
      limits: {
        min: GIFT_MIN,
        max: GIFT_MAX,
        note: GIFT_NOTE_MAX,
        open: GIFT_OPEN_MAX,
        days: GIFT_DAYS,
      },
    });
  });
  app.post(
    "/api/gifts",
    requireUser,
    limit("gift_create", 10, HOUR),
    limit("gift_create_address", 30, HOUR, byAddress),
    (req, res) => {
      const amount = req.body.amount;
      if (!Number.isSafeInteger(amount) || amount < GIFT_MIN || amount > GIFT_MAX)
        fail(400, AMOUNT_RULE, "invalid_amount");
      if (req.body.note != null && typeof req.body.note !== "string")
        fail(400, "A note must be text.", "invalid_note");
      const note = normalizeGiftNote(req.body.note);
      if (note.length > GIFT_NOTE_MAX)
        fail(400, `Keep the note to ${GIFT_NOTE_MAX} characters.`, "note_too_long");
      // Seed Guard: anyone holding the link reads the note, so a seed phrase
      // never goes into one.
      if (isReleased(cfg, "seedguard") && findSeedPhrase(note))
        fail(400, SEED_MESSAGE, "seed_phrase_blocked");
      const units = amount * UNIT;
      const requestId = requestIdentifier(req);
      const user = req.user.id;
      const result = transaction(db, () => {
        const existing = db
          .prepare("SELECT * FROM gifts WHERE user_id=? AND request_id=?")
          .get(user, requestId);
        if (existing) {
          if (existing.amount !== units || existing.note !== note)
            fail(409, "That request ID was already used for a different gift.", "duplicate_request");
          return { gift: existing, repeated: true };
        }
        if (hasDisputedCredit(db, user))
          fail(
            409,
            "A credited payment is under reconciliation. Gifts are paused until it is confirmed.",
            "payment_reconciliation_pending",
          );
        if (balance(db, user).available < units)
          fail(402, "Not enough available credits for this gift.", "insufficient_credits");
        // A gift spends the balance, so it counts against the giver's own
        // spending limits, like sending credits (402 spending_limit).
        if (limitsLive(cfg)) assertSpendingRoom(db, user, units);
        if (
          db
            .prepare("SELECT COUNT(*) n FROM gifts WHERE user_id=? AND status='open'")
            .get(user).n >= GIFT_OPEN_MAX
        )
          fail(
            409,
            `You already have ${GIFT_OPEN_MAX} gifts waiting to be claimed. Cancel one, or wait for one to be claimed.`,
            "gift_limit",
          );
        const id = uid("gift_");
        const at = now();
        let code;
        for (let attempt = 0; ; attempt++) {
          code = codeFromBytes(randomBytes(GIFT_RANDOM_SYMBOLS));
          try {
            db.prepare(
              "INSERT INTO gifts(id,user_id,code_hash,amount,note,status,request_id,created,expires) VALUES(?,?,?,?,?,'open',?,?,?)",
            ).run(id, user, codeHash(readCode(code).symbols), units, note, requestId, at, at + GIFT_TTL);
            break;
          } catch (e) {
            // Two equal 135-bit codes won't happen; retry anyway, never reuse.
            if (!/UNIQUE/.test(e.message) || attempt >= 4) throw e;
          }
        }
        db.prepare(LEDGER).run(uid("l_"), user, -units, "gift_out", id + ":out", null, "Gift created", at);
        return {
          gift: db.prepare("SELECT * FROM gifts WHERE id=?").get(id),
          code,
        };
      });
      const available = credits(balance(db, user).available);
      if (result.repeated)
        return res.json({
          ...giftView(result.gift),
          repeated: true,
          message:
            "This gift was already made, and its link was shown only once. If you didn't keep it, cancel the gift to get the credits back.",
          available,
        });
      res.status(201).json({
        ...giftView(result.gift),
        code: result.code,
        link: giftLink(origin(), result.code),
        available,
      });
    },
  );
  app.post(
    "/api/gifts/:id/revoke",
    requireUser,
    limit("gift_revoke", 60, HOUR),
    (req, res) => {
      const gift = revokeGift(db, req.user.id, req.params.id);
      res.json({
        ...giftView(gift),
        available: credits(balance(db, req.user.id).available),
      });
    },
  );

  // ---- The person with the link ----
  // What the claim page shows before claiming, signed in or not. An open
  // gift shows its amount, note and deadline; any other only its state.
  app.post(
    "/api/gifts/peek",
    limit("gift_peek_address", 60, HOUR, byAddress),
    (req, res) => {
      const symbols = codeFrom(req);
      assertNotLocked(req, res);
      const g = db.prepare("SELECT * FROM gifts WHERE code_hash=?").get(codeHash(symbols));
      if (!g) {
        recordFailure(req);
        notFound();
      }
      const open = g.status === "open" && g.expires > now();
      res.json(
        open
          ? {
              status: "open",
              amount: credits(g.amount),
              note: g.note,
              expires: g.expires,
              own: req.user?.id === g.user_id,
            }
          : {
              status:
                g.status === "claimed"
                  ? "claimed"
                  : g.status === "revoked"
                    ? "cancelled"
                    : "expired",
            },
      );
    },
  );
  // Claiming: exactly one account gets the credits, in one transaction.
  app.post(
    "/api/gifts/claim",
    requireUser,
    limit("gift_claim", 20, HOUR),
    limit("gift_claim_address", 60, HOUR, byAddress),
    (req, res) => {
      const symbols = codeFrom(req);
      assertNotLocked(req, res);
      const user = req.user.id;
      const outcome = claimGift(db, user, symbols);
      if (!outcome) {
        recordFailure(req);
        notFound();
      }
      res.json({
        status: "claimed",
        amount: credits(outcome.amount),
        note: outcome.note,
        available: credits(balance(db, user).available),
      });
    },
  );

  return { expire: (at) => expireGifts(db, at) };
}
