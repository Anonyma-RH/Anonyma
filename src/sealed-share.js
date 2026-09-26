// Sealed Share, the browser's side (update "sealedshare"). A snapshot is
// sealed here with a fresh random 256-bit AES-GCM key and only the ciphertext
// is uploaded. The key goes in the link's #k= fragment: browsers never send a
// fragment to a server, so ANONYMA stores and serves bytes it can't read.
//
// Pure WebCrypto, no React and no network, so tests run it on Node's
// WebCrypto. Nothing here logs, stores or sends a key.
import {
  SEALED_KEY,
  SEALED_KEY_BYTES,
  SEALED_IV_BYTES,
  SEALED_TAG_BYTES,
  MAX_SEALED_BYTES,
  SHARE_TOKEN,
  sealedPayload,
  readSealedPayload,
} from "./share-links.js";

export class SealedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SealedError";
    this.code = code;
  }
}
export const SEALED_ERRORS = {
  unsupported: "This browser can't seal or open a sealed link.",
  too_large: "This conversation is too long to share as one sealed link.",
  no_key: "This link is missing its key. Ask for the full link: everything after the # is part of it.",
  wrong_key: "This link's key doesn't open this conversation. Check that you copied the whole link.",
  damaged: "This sealed conversation couldn't be read. It may be damaged.",
};
const sealedError = (code) => new SealedError(code, SEALED_ERRORS[code]);

// Binds every ciphertext to this format, so it can't be mistaken for another.
const AAD = new TextEncoder().encode("anonyma-sealed-share:v1");
const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw sealedError("unsupported");
  return s;
};

export function toBase64Url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromBase64Url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1)
    throw sealedError("damaged");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Seals { title, messages }: returns the ciphertext to upload (IV, then the
// AES-GCM ciphertext and tag, as base64url) and the key for the link. The raw
// key never leaves this function except as that link text.
export async function sealSnapshot(snapshot) {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(SEALED_KEY_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(SEALED_IV_BYTES));
  const key = await subtle().importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const plain = new TextEncoder().encode(JSON.stringify(sealedPayload(snapshot)));
  const sealed = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, plain),
  );
  const box = new Uint8Array(iv.length + sealed.length);
  box.set(iv);
  box.set(sealed, iv.length);
  if (box.length > MAX_SEALED_BYTES) throw sealedError("too_large");
  const link = toBase64Url(raw);
  raw.fill(0);
  return { ciphertext: toBase64Url(box), key: link, bytes: box.length };
}

// Opens a sealed snapshot with the key from its link: { title, messages },
// checked field by field. SealedError "no_key", "wrong_key" or "damaged".
export async function openSnapshot(ciphertext, keyText) {
  if (typeof keyText !== "string" || !SEALED_KEY.test(keyText)) throw sealedError("no_key");
  const raw = fromBase64Url(keyText);
  if (raw.length !== SEALED_KEY_BYTES) throw sealedError("no_key");
  const box = fromBase64Url(ciphertext);
  if (box.length < SEALED_IV_BYTES + SEALED_TAG_BYTES + 1) throw sealedError("damaged");
  const key = await subtle().importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  raw.fill(0);
  let plain;
  try {
    plain = await subtle().decrypt(
      { name: "AES-GCM", iv: box.subarray(0, SEALED_IV_BYTES), additionalData: AAD },
      key,
      box.subarray(SEALED_IV_BYTES),
    );
  } catch {
    // A wrong key and a tampered ciphertext look the same to AES-GCM.
    throw sealedError("wrong_key");
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
  } catch {
    throw sealedError("damaged");
  }
  const snapshot = readSealedPayload(value);
  if (!snapshot) throw sealedError("damaged");
  return snapshot;
}

// ---- The key in the address bar ----
// sealed-boot.js calls captureShareKey before any other module runs (and
// again if a new #k= is pasted over the open page), so no other code ever
// sees the fragment. The key is taken out of the address bar at
// once (history.replaceState) and kept in this tab's history entry, which a
// reload keeps and no request carries; the page rebuilds the full link only
// when asked to copy it.
const STATE_KEY = "anonymaSealedKey";
// Sent on window when a new key arrives while the page is open.
export const SEALED_KEY_EVENT = "anonyma:sealed-key";
const SHARE_PATH = /^\/s\/([A-Za-z0-9_-]{32})\/?$/;
let captured = null;
export function keyFromHash(hash) {
  const m = /^#k=([A-Za-z0-9_-]{43})$/.exec(hash || "");
  return m ? m[1] : null;
}
export function captureShareKey(loc = globalThis.location, history = globalThis.history) {
  const path = SHARE_PATH.exec(loc?.pathname || "");
  if (!path || !SHARE_TOKEN.test(path[1])) return null;
  const token = path[1];
  if (String(loc.hash || "").startsWith("#k=")) {
    const key = keyFromHash(loc.hash);
    const state = { ...(history.state || {}) };
    if (key) state[STATE_KEY] = { token, key };
    else delete state[STATE_KEY];
    history.replaceState(state, "", loc.pathname + loc.search);
    captured = key ? { token, key } : null;
    return captured;
  }
  const kept = keptKey(token, history);
  captured = kept ? { token, key: kept } : null;
  return captured;
}
function keptKey(token, history) {
  const kept = history?.state?.[STATE_KEY];
  return kept?.token === token && typeof kept.key === "string" && SEALED_KEY.test(kept.key)
    ? kept.key
    : null;
}
// The key read for this share's page, or null.
export function shareKeyFor(token, history = globalThis.history) {
  if (captured?.token === token) return captured.key;
  return keptKey(token, history);
}
