// Seed Guard: spots a wallet seed phrase or private key in text before it
// leaves the browser. Pure and DOM-free, so the workspace and the server
// (server/seed-guard.js) run the same detector. It never returns, logs or
// stores what it found: only the kind of secret.
//
// - Seed phrases: 12, 15, 18, 21 or 24 words in a row, all from the English
//   BIP39 wordlist, separated by spaces, new lines, commas or numbering
//   ("1. word", "2) word"), whose BIP39 checksum is valid. The checksum turns
//   away 15 of 16 random 12-word runs (255 of 256 at 24 words), so ordinary
//   prose that happens to use list words is left alone.
// - Private keys: a WIF key or an extended private key (xprv and friends),
//   both Base58Check-verified. Unambiguous, so like a seed phrase they are
//   blocked until the user confirms twice ("hard").
// - 64 hex characters (with or without 0x) in the secp256k1 key range: a
//   private key has the same shape as a transaction hash, so this is only a
//   soft notice with a one-click "It's not a key, send". A value in a URL, or
//   labelled as a hash, transaction, digest or storage slot, isn't flagged.
import { BIP39_ENGLISH } from "./bip39-english.js";

export const SEED_MESSAGE =
  "This looks like a wallet seed phrase. ANONYMA won't send it. Remove it to continue.";
export const KEY_MESSAGE =
  "This looks like a wallet private key. ANONYMA won't send it. Remove it to continue.";
export const HEX_MESSAGE =
  "This looks like a private key or a transaction hash. If it's a private key, remove it.";
export const seedGuardMessage = (hit) =>
  hit?.kind === "hex" ? HEX_MESSAGE : hit?.kind === "key" ? KEY_MESSAGE : SEED_MESSAGE;
// A soft finding asks once; a hard one (seed phrase, WIF, xprv) blocks until
// the user confirms twice.
export const isSoft = (hit) => hit?.kind === "hex";

// --- SHA-256 (FIPS 180-4), synchronous so detection needs no await -------
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
export function sha256(message) {
  const length = message.length,
    padded = new Uint8Array(((length + 72) >> 6) << 6);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length << 3) >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15],
        b = w[t - 2];
      w[t] =
        w[t - 16] +
        (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
        w[t - 7] +
        (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const t1 =
        (hh +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          K[t] +
          w[t]) |
        0;
      const t2 =
        ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32),
    outView = new DataView(out.buffer);
  h.forEach((v, i) => outView.setUint32(i * 4, v));
  return out;
}

// --- BIP39 mnemonics -----------------------------------------------------
let wordIndex = null;
const indexOf = (word) => {
  wordIndex ||= new Map(BIP39_ENGLISH.map((w, i) => [w, i]));
  return wordIndex.get(word);
};
export const MNEMONIC_LENGTHS = [24, 21, 18, 15, 12];

// Whether these word indices are a mnemonic with a valid checksum: the
// words' 11-bit values concatenate to the entropy plus the first
// (length / 3) bits of SHA-256(entropy).
export function mnemonicChecksumValid(indices) {
  const n = indices.length;
  if (!MNEMONIC_LENGTHS.includes(n)) return false;
  const bits = new Uint8Array(n * 11);
  indices.forEach((v, i) => {
    for (let b = 0; b < 11; b++) bits[i * 11 + b] = (v >> (10 - b)) & 1;
  });
  const checksumBits = n / 3,
    entropy = new Uint8Array((n * 11 - checksumBits) / 8);
  for (let i = 0; i < entropy.length; i++)
    for (let b = 0; b < 8; b++) entropy[i] |= bits[i * 8 + b] << (7 - b);
  const hash = sha256(entropy)[0];
  for (let b = 0; b < checksumBits; b++)
    if (((hash >> (7 - b)) & 1) !== bits[entropy.length * 8 + b]) return false;
  return true;
}

// What may sit between two words of a pasted phrase: white space, commas and
// similar list punctuation, quotes and brackets (a JSON array), and one
// number such as "7.", "7)" or "#7". A full stop after a word ends the run,
// so separate sentences never join into one.
const SEPARATOR =
  /^[\s,;|•·*\-–—'"`[\](){}]*(?:#?\d{1,2}[.):]?[\s,;|•·*\-–—'"`[\](){}]*)?$/;
const MAX_SEPARATOR = 64;

function mnemonicIn(run) {
  if (run.length < 12) return null;
  for (const size of MNEMONIC_LENGTHS)
    for (let start = 0; start + size <= run.length; start++)
      if (mnemonicChecksumValid(run.slice(start, start + size)))
        return { kind: "seed", words: size };
  return null;
}

export function findSeedPhrase(text) {
  if (typeof text !== "string" || text.length < 35) return null;
  const word = /[A-Za-z]+/g;
  let run = [],
    lastEnd = 0,
    m;
  while ((m = word.exec(text))) {
    const index = indexOf(m[0].toLowerCase());
    if (index === undefined) {
      const hit = mnemonicIn(run);
      if (hit) return hit;
      run = [];
    } else {
      if (run.length) {
        const gap = text.slice(lastEnd, m.index);
        if (gap.length > MAX_SEPARATOR || !SEPARATOR.test(gap)) {
          const hit = mnemonicIn(run);
          if (hit) return hit;
          run = [];
        }
      }
      run.push(index);
    }
    lastEnd = m.index + m[0].length;
  }
  return mnemonicIn(run);
}

// --- Private keys --------------------------------------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s) {
  const bytes = [];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}
// The payload of a Base58Check string, or null if its checksum is wrong.
function base58Check(s) {
  const raw = base58Decode(s);
  if (!raw || raw.length < 5) return null;
  const payload = raw.subarray(0, raw.length - 4),
    check = sha256(sha256(payload));
  for (let i = 0; i < 4; i++) if (check[i] !== raw[raw.length - 4 + i]) return null;
  return payload;
}
const B58_CHARS = "1-9A-HJ-NP-Za-km-z";
// WIF: version 0x80 (mainnet) or 0xef (testnet), 32 key bytes, then 0x01
// for a compressed key.
const WIF = new RegExp(`(?<![${B58_CHARS}])[5KLc9][${B58_CHARS}]{50,51}(?![${B58_CHARS}])`, "g");
const wifValid = (s) => {
  const p = base58Check(s);
  return (
    !!p &&
    (p[0] === 0x80 || p[0] === 0xef) &&
    (p.length === 33 || (p.length === 34 && p[33] === 0x01))
  );
};
// BIP32 extended private keys: 78 bytes whose key data starts with 0x00.
const XPRV = new RegExp(`(?<![${B58_CHARS}])[xtyzuvYZ]prv[${B58_CHARS}]{100,112}(?![${B58_CHARS}])`, "g");
const xprvValid = (s) => {
  const p = base58Check(s);
  return !!p && p.length === 78 && p[45] === 0;
};
// A secp256k1 private key is 1 to n - 1.
const CURVE_ORDER = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);
const HEX64 = /(?<![0-9A-Za-z])(?:0x)?([0-9a-fA-F]{64})(?![0-9A-Za-z])/g;
// Labels just before a value, on the same line (lowercased).
const KEY_LABEL =
  /(?:^|[^a-z])(?:priv(?:ate)?[\s_-]*key|privkey|secret|seed|mnemonic|signer|deployer|wallet[\s_-]*key)/;
const HASH_LABEL =
  /hash|(?:^|[^a-z])(?:tx|txn|txid)(?:[^a-z]|$)|transaction|sha-?(?:256|3)|keccak|digest|checksum|commit|topic|slot|merkle|root|block|nonce/;
function hexKeyLike(text, m) {
  const digits = m[1];
  if (new Set(digits.toLowerCase()).size < 6) return false;
  const value = BigInt("0x" + digits);
  if (value === 0n || value >= CURVE_ORDER) return false;
  const lineStart = text.lastIndexOf("\n", m.index) + 1,
    before = text.slice(Math.max(lineStart, m.index - 48), m.index).toLowerCase();
  if (KEY_LABEL.test(before)) return true;
  // Part of a link or path (an explorer URL names a transaction, not a key).
  const tokenStart = Math.max(
    text.lastIndexOf(" ", m.index),
    text.lastIndexOf("\n", m.index),
    text.lastIndexOf("\t", m.index),
  );
  if (text.slice(tokenStart + 1, m.index).includes("/")) return false;
  return !HASH_LABEL.test(before);
}

// WIF or xprv: { kind: "key" }, a hard block.
export function findPrivateKey(text) {
  if (typeof text !== "string" || text.length < 51) return null;
  for (const m of text.matchAll(WIF)) if (wifValid(m[0])) return { kind: "key" };
  for (const m of text.matchAll(XPRV)) if (xprvValid(m[0])) return { kind: "key" };
  return null;
}
// Bare 64-hex: { kind: "hex" }, a soft notice (a key or a transaction hash).
export function findHexKey(text) {
  if (typeof text !== "string" || text.length < 64) return null;
  for (const m of text.matchAll(HEX64)) if (hexKeyLike(text, m)) return { kind: "hex" };
  return null;
}

// Everything a surface is about to send: strings, or arrays of them (nested
// arrays are flattened; anything else is ignored). The most serious find is
// named: a seed phrase, then a WIF or xprv key, then 64-hex.
export function scanSecrets(...parts) {
  const texts = parts.flat(Infinity).filter((t) => typeof t === "string" && t);
  for (const find of [findSeedPhrase, findPrivateKey, findHexKey])
    for (const t of texts) {
      const hit = find(t);
      if (hit) return hit;
    }
  return null;
}
