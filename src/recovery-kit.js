// Recovery Kit: rules shared by the server (server/recovery-kit.js,
// server/routes/recovery-kit.js) and the browser (src/RecoveryKit.jsx). No
// DOM and no Node APIs here, so both sides and the tests read the same
// numbers.
//
// A kit is ten one-time codes. Each code is 19 random Crockford base32
// symbols (95 bits) and one check symbol, shown as five groups of four:
// 7K3Q-M9XD-2HVA-PN4T-8RZC. With the account's username, one code gets the
// account back in once: it signs out every session and asks for a new
// password or passkey before anything else. The server keeps only a scrypt
// digest of each code, so nobody can show a code again, ANONYMA included.

export const KIT_SIZE = 10;
// A code that was accepted waits this long for a new password or passkey.
export const KIT_PENDING_MINUTES = 15;
// Wrong codes allowed per username, and per network address, in an hour.
export const KIT_USERNAME_TRIES = 5;
export const KIT_ADDRESS_TRIES = 10;

// Crockford's alphabet: no I, L, O or U, so a code reads aloud and types
// without lookalikes. 32 symbols, so a random byte's low five bits pick one
// without bias.
export const KIT_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const KIT_RANDOM_SYMBOLS = 19;
export const KIT_SYMBOLS = KIT_RANDOM_SYMBOLS + 1;
const VALUE = Object.fromEntries([...KIT_ALPHABET].map((c, i) => [c, i]));

// The check symbol: a position-weighted sum modulo 31 (a prime larger than
// the number of positions, so nearly every single wrong symbol and swap of
// two neighbours changes it). A typo is caught before it reaches the
// server's check, so it never counts as a wrong guess.
export function kitCheckSymbol(symbols) {
  let sum = 0;
  for (let i = 0; i < KIT_RANDOM_SYMBOLS; i++) sum += (i + 1) * VALUE[symbols[i]];
  return KIT_ALPHABET[sum % 31];
}

export const formatKitCode = (symbols) => symbols.match(/.{1,4}/g).join("-");

// A new code from 19 random bytes (the server passes crypto.randomBytes).
export function kitCodeFromBytes(bytes) {
  if (!bytes || bytes.length < KIT_RANDOM_SYMBOLS) throw Error("Not enough random bytes.");
  const symbols = Array.from(bytes.slice(0, KIT_RANDOM_SYMBOLS), (b) => KIT_ALPHABET[b & 31]).join("");
  return formatKitCode(symbols + kitCheckSymbol(symbols));
}

// What someone typed, as the 20 symbols of a code: any case, spaces or
// dashes, and Crockford's lookalikes (O for 0, I or L for 1). { symbols,
// code } when it has the right shape, with `typo` when its check symbol
// doesn't match; null otherwise.
export function readKitCode(input) {
  const text = String(input ?? "");
  if (text.length > 200) return null;
  const symbols = text
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (symbols.length !== KIT_SYMBOLS || [...symbols].some((c) => !(c in VALUE)))
    return null;
  return {
    symbols,
    code: formatKitCode(symbols),
    typo: kitCheckSymbol(symbols) !== symbols[KIT_RANDOM_SYMBOLS],
  };
}

// Two-Step Sign-in's recovery codes (16 letters and digits 2–7) are a
// different thing: they stand in for the authenticator app after a
// password. Recognised only to say so.
export const looksLikeTwoStepCode = (input) =>
  /^[a-z2-7]{16}$/.test(String(input ?? "").toLowerCase().replace(/[\s-]/g, ""));

// What a code field keeps as someone types.
export const kitCodeInput = (value) =>
  String(value ?? "")
    .toUpperCase()
    .replace(/[^0-9A-Z\s-]/g, "")
    .slice(0, 29);

export const KIT_FORMAT_MESSAGE =
  "That isn’t a recovery kit code. A code has 20 letters and numbers, like 7K3Q-M9XD-2HVA-PN4T-8RZC.";
export const KIT_TWO_STEP_MESSAGE =
  "That looks like a two-step recovery code. Those work after your password, at the two-step step. A recovery kit code has 20 letters and numbers.";
export const KIT_TYPO_MESSAGE = "That code has a typo. Check it against your kit and try again.";

// Released: its sign-in step and the Account → Security section. Making or
// replacing a kit asks "confirm it's you", which is Two-Step Sign-in's.
export const recoveryKitReleased = (config) =>
  config?.releases?.features?.recovery === true &&
  config?.releases?.features?.twostep === true;

// The kit as a text file to keep. `t` translates each line (the language
// switch's own dictionary); dates are ISO so they read the same anywhere.
export function kitText({ codes, username, created, origin }, t = (s) => s) {
  const site = String(origin || "").replace(/\/+$/, "");
  return [
    t("ANONYMA recovery kit"),
    `${t("Username")}: ${username || ""}`,
    `${t("Made")}: ${new Date(created ?? Date.now()).toISOString().slice(0, 10)}`,
    "",
    t("Each code gets you back into your account once, if you lose your password or passkey."),
    t("On the sign-in page, choose “Use a recovery code”, then enter your username and one code."),
    t("Anyone with your username and one of these codes can get in, even with two-step sign-in on. Keep this offline and private."),
    ...(site ? [`${site}/login`] : []),
    "",
    ...codes.map((c, i) => `${String(i + 1).padStart(2, " ")}. ${c}`),
    "",
  ].join("\n");
}
