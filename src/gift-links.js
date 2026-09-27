// Gift Links: rules shared by the server (server/routes/gifts.js) and the
// browser (src/GiftLinks.jsx, src/GiftClaim.jsx). No DOM and no Node APIs
// here, so both sides and the tests read the same numbers.
//
// A gift code is 27 random Crockford base32 symbols (135 bits) and one check
// symbol, shown as seven groups of four: 7K3Q-M9XD-2HVA-PN4T-8RZC-W6BF-J1YE.
// The claim link carries it after the #, so it never reaches a server log or
// a Referer header. The server keeps only a hash of it.

export const GIFT_PATH = "/gift";
export const GIFT_MIN = 100; // credits
export const GIFT_MAX = 250_000; // credits
export const GIFT_PRESETS = [1000, 5000, 25_000];
export const GIFT_NOTE_MAX = 140;
export const GIFT_DAYS = 30;
// Unclaimed gifts one account may have out at once.
export const GIFT_OPEN_MAX = 25;

// Crockford's alphabet: no I, L, O or U, so a code reads aloud and types
// without lookalikes. 32 symbols, so a random byte's low five bits pick one
// without bias.
export const GIFT_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const GIFT_RANDOM_SYMBOLS = 27;
export const GIFT_SYMBOLS = GIFT_RANDOM_SYMBOLS + 1;
const VALUE = Object.fromEntries([...GIFT_ALPHABET].map((c, i) => [c, i]));

// The check symbol: a position-weighted sum modulo 31 (a prime, so every
// single wrong symbol and nearly every swap of two neighbours changes it).
// A typo is caught in the browser, and never counts as a wrong guess.
export function checkSymbol(symbols) {
  let sum = 0;
  for (let i = 0; i < GIFT_RANDOM_SYMBOLS; i++) sum += (i + 1) * VALUE[symbols[i]];
  return GIFT_ALPHABET[sum % 31];
}

// A new code from 27 random bytes (the server passes crypto.randomBytes).
export function codeFromBytes(bytes) {
  if (!bytes || bytes.length < GIFT_RANDOM_SYMBOLS) throw Error("Not enough random bytes.");
  const symbols = Array.from(bytes.slice(0, GIFT_RANDOM_SYMBOLS), (b) => GIFT_ALPHABET[b & 31]).join("");
  return formatCode(symbols + checkSymbol(symbols));
}

export const formatCode = (symbols) => symbols.match(/.{1,4}/g).join("-");

// What someone pasted or typed, as the 28 symbols of a code: a whole link
// (anything after its #), any case, spaces or dashes, and Crockford's
// lookalikes (O for 0, I or L for 1). { symbols } when it has the right
// shape, with `typo` when its check symbol doesn't match; null otherwise.
export function readCode(input) {
  let text = String(input ?? "");
  if (text.length > 400) return null;
  const hash = text.lastIndexOf("#");
  if (hash >= 0) text = text.slice(hash + 1);
  const symbols = text
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (symbols.length !== GIFT_SYMBOLS || [...symbols].some((c) => !(c in VALUE)))
    return null;
  return {
    symbols,
    code: formatCode(symbols),
    typo: checkSymbol(symbols) !== symbols[GIFT_RANDOM_SYMBOLS],
  };
}

export const giftLink = (origin, code) =>
  String(origin || "").replace(/\/+$/, "") + GIFT_PATH + "#" + code;

// The amount field: whole credits from GIFT_MIN to GIFT_MAX, or null.
export function parseGiftAmount(value) {
  const text = String(value ?? "").trim().replace(/[,\s]/g, "");
  if (!/^\d{1,7}$/.test(text)) return null;
  const n = Number(text);
  return n >= GIFT_MIN && n <= GIFT_MAX ? n : null;
}
export const AMOUNT_RULE = `Gift from ${GIFT_MIN.toLocaleString("en-US")} to ${GIFT_MAX.toLocaleString("en-US")} whole credits.`;

// A note is one short line: whitespace runs become one space.
export const normalizeGiftNote = (value) =>
  String(value ?? "").replace(/\s+/g, " ").trim();

// The words for a gift's state, as the giver's list shows it. The giver
// never learns who claimed a gift, only that it was and when.
export const GIFT_STATUS = {
  open: "Waiting to be claimed",
  claimed: "Claimed",
  revoked: "Cancelled · credits returned",
  expired: "Unclaimed after 30 days · credits returned",
};

// The code a /gift link carried, kept for this tab only (sessionStorage) so
// it survives signing in or creating an account on the way to claiming.
export const GIFT_STORE_KEY = "anonyma:gift-code";
export const GIFT_CODE_EVENT = "anonyma:gift-code";
// Runs before the app (src/gift-boot.js): on /gift, a #code leaves the
// address bar at once, so it isn't kept in history, bookmarks or anything
// else that reads the URL, and no other code ever sees it.
export function captureGiftCode(loc = globalThis.location, history = globalThis.history, store = globalThis.sessionStorage) {
  if (!loc || String(loc.pathname).replace(/\/+$/, "") !== GIFT_PATH) return null;
  const hash = String(loc.hash || "");
  if (hash.length < 2) return null;
  history?.replaceState?.(history.state ?? null, "", loc.pathname + loc.search);
  const read = readCode(hash);
  try {
    if (read) store?.setItem(GIFT_STORE_KEY, read.code);
  } catch {}
  return read ? read.code : null;
}
export function keptGiftCode(store = globalThis.sessionStorage) {
  try {
    const read = readCode(store?.getItem(GIFT_STORE_KEY));
    return read ? read.code : null;
  } catch {
    return null;
  }
}
export function forgetGiftCode(store = globalThis.sessionStorage) {
  try {
    store?.removeItem(GIFT_STORE_KEY);
  } catch {}
}
