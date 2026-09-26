// Device Vault: chats kept only in this browser, encrypted with a key derived
// from a passphrase the user sets. A device-only chat is sent exactly like an
// off-the-record one (the server stores nothing); this browser keeps the
// history in IndexedDB (src/device-vault-store.js).
//
// Pure WebCrypto helpers and the vault file format, kept free of React and of
// IndexedDB so tests run them on Node's WebCrypto. PBKDF2-SHA256 turns the
// passphrase into a non-extractable AES-GCM key; every record is sealed with
// its own random IV and bound to its id. Only the salt and a verifier (a known
// text sealed with the key) are stored: never the passphrase, never the key.

import { isReleased } from "./lib.js";

// A device-only chat takes the off-the-record request path, so the app needs
// Ephemeral Chats released too. The server gates it as "ephemeral" only.
export const vaultReleased = (config) =>
  isReleased(config, "vault") && isReleased(config, "ephemeral");

export const VAULT_FORMAT = "anonyma-device-vault";
export const VAULT_VERSION = 1;
// OWASP's 2023 figure for PBKDF2-HMAC-SHA256. A vault or file asking for
// fewer is refused, so an imported file can't weaken the key.
export const VAULT_ITERATIONS = 600000;
export const MIN_ITERATIONS = 600000;
// An upper bound too, so a hostile file can't hang the tab deriving a key.
export const MAX_ITERATIONS = 10000000;
export const MIN_PASSPHRASE = 10;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
// Lock after this many idle minutes; the user picks one.
export const IDLE_CHOICES = [5, 15, 30, 60];
export const DEFAULT_IDLE_MINUTES = 15;
// Whether an unlocked vault has been idle long enough to lock.
export const idleExpired = (last, now, minutes) =>
  now - last >= (IDLE_CHOICES.includes(minutes) ? minutes : DEFAULT_IDLE_MINUTES) * 60000;
export const MAX_VAULT_CHATS = 5000;
// The honest limits, shown wherever the vault is set up, unlocked or managed.
export const VAULT_LIMITS = [
  "Lose the passphrase and these chats are gone; ANONYMA can't recover them.",
  "Anyone using this browser unlocked can read them.",
  "The model provider still receives what you send.",
];
const VERIFIER_TEXT = "ANONYMA Device Vault";
const VERIFIER_AAD = "anonyma-vault:verifier";
const chatAad = (id) => "anonyma-vault:chat:" + id;

export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}
export const VAULT_ERRORS = {
  wrong_passphrase: "That passphrase doesn't open this vault.",
  short_passphrase: `Use a passphrase of at least ${MIN_PASSPHRASE} characters.`,
  bad_file: "This isn't a Device Vault file, or it's damaged.",
  damaged: "A chat in this vault couldn't be read. It may be damaged.",
};
const vaultError = (code) => new VaultError(code, VAULT_ERRORS[code]);

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new VaultError("unsupported", "This browser can't encrypt a vault.");
  return s;
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}
export function toBase64(bytes) {
  let s = "";
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000)
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text))
    throw vaultError("bad_file");
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// The passphrase exactly as typed, apart from Unicode normalisation, so the
// same words typed on another device open the same vault.
export function passphraseProblem(passphrase) {
  return typeof passphrase === "string" &&
    [...passphrase.normalize("NFC")].length >= MIN_PASSPHRASE
    ? null
    : VAULT_ERRORS.short_passphrase;
}

export async function deriveVaultKey(passphrase, salt, iterations = VAULT_ITERATIONS) {
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < MIN_ITERATIONS ||
    iterations > MAX_ITERATIONS
  )
    throw vaultError("bad_file");
  if (!(salt instanceof Uint8Array) || salt.length < SALT_BYTES)
    throw vaultError("bad_file");
  const base = await subtle().importKey(
    "raw",
    encoder.encode(String(passphrase).normalize("NFC")),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// Seals a JSON value with a fresh random IV. `aad` binds the ciphertext to
// where it belongs, so a record can't be moved under another id.
export async function sealJson(key, value, aad) {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}
export async function openJson(key, box, aad, code = "damaged") {
  let plain;
  try {
    plain = await subtle().decrypt(
      { name: "AES-GCM", iv: fromBase64(box?.iv), additionalData: encoder.encode(aad) },
      key,
      fromBase64(box?.ct),
    );
  } catch {
    throw vaultError(code);
  }
  return JSON.parse(decoder.decode(plain));
}

// A new vault: its stored settings (salt, iteration count, verifier and the
// idle lock) and the unlocked key, which is only ever held in memory.
export async function createVault(passphrase, { idleMinutes = DEFAULT_IDLE_MINUTES } = {}) {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new VaultError("short_passphrase", problem);
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveVaultKey(passphrase, salt, VAULT_ITERATIONS);
  const meta = {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: VAULT_ITERATIONS, salt: toBase64(salt) },
    cipher: "AES-GCM-256",
    verifier: await sealJson(key, VERIFIER_TEXT, VERIFIER_AAD),
    idleMinutes: IDLE_CHOICES.includes(idleMinutes) ? idleMinutes : DEFAULT_IDLE_MINUTES,
  };
  return { meta, key };
}
// The key for a vault, or VaultError "wrong_passphrase".
export async function unlockVault(meta, passphrase) {
  const key = await deriveVaultKey(passphrase, fromBase64(meta.kdf.salt), meta.kdf.iterations);
  const text = await openJson(key, meta.verifier, VERIFIER_AAD, "wrong_passphrase");
  if (text !== VERIFIER_TEXT) throw vaultError("wrong_passphrase");
  return key;
}

// One chat, sealed: only its id is readable without the key.
export async function sealChat(key, chat) {
  if (typeof chat?.id !== "string" || !chat.id) throw vaultError("damaged");
  return { id: chat.id, ...(await sealJson(key, chat, chatAad(chat.id))) };
}
export async function openChat(key, record) {
  const chat = await openJson(key, record, chatAad(record?.id));
  if (chat?.id !== record.id || !Array.isArray(chat.messages)) throw vaultError("damaged");
  return chat;
}

// A readable title for the sidebar, from the first thing typed (with Veil
// tags put back from this chat's own map), like a saved chat's title.
export function vaultTitle(messages = [], veilMap = {}) {
  const first = messages.find((m) => m.role === "user");
  const text = typeof first?.content === "string" ? first.content : "";
  const at = text.indexOf("\n\n<document ");
  let typed = text.startsWith("<document ") ? "" : at < 0 ? text : text.slice(0, at);
  typed = typed.replace(/\[([A-Z]+_\d+)\]/g, (full, tag) =>
    Object.prototype.hasOwnProperty.call(veilMap || {}, tag) ? veilMap[tag] : full,
  );
  typed = typed.replace(/\s+/g, " ").trim();
  if (typed) return typed.slice(0, 80);
  if (text.startsWith("<document ")) return /\bname="([^"]*)"/.exec(text)?.[1] || "Documents";
  return first?.images?.length ? "Image conversation" : "New chat";
}
// What a saved vault chat holds: the conversation as shown, the Veil map that
// unveils it, whether it ran in Private Mode, whether it was sealed (it
// reopens sealed and only ever goes on sealed) and, for a chat started in
// a project, that project's id: the vault groups project chats in this
// browser, since the server never learns a device-only chat exists.
export function vaultChat({ id, mode, privateMode, sealed = false, messages, veil, created, project = null, now = Date.now() }) {
  return {
    id,
    title: vaultTitle(messages, veil?.map),
    mode: ["chat", "code", "uncensored"].includes(mode) ? mode : "chat",
    private: !!privateMode,
    ...(typeof project === "string" && project ? { project } : {}),
    // Sealed Mode: it reopens sealed and only ever goes on sealed.
    ...(sealed ? { sealed: true } : {}),
    messages: messages.filter((m) => !m.sample),
    veil: veil
      ? { map: { ...veil.map }, counters: { ...veil.counters }, valueToTag: { ...veil.valueToTag } }
      : null,
    created: created || now,
    updated: now,
  };
}
export const newestFirst = (chats) => [...chats].sort((a, b) => b.updated - a.updated);

// ---- The vault file, for moving devices ----
// The stored settings and every sealed record exactly as kept here: still
// encrypted, so the file opens only with the passphrase it was made with.
export function vaultFile(meta, records) {
  return JSON.stringify(
    {
      format: VAULT_FORMAT,
      version: VAULT_VERSION,
      kdf: meta.kdf,
      cipher: meta.cipher,
      verifier: meta.verifier,
      idleMinutes: meta.idleMinutes,
      chats: records.map(({ id, iv, ct }) => ({ id, iv, ct })),
    },
    null,
    1,
  );
}
const isBox = (b, ivBytes = IV_BYTES) => {
  try {
    return (
      typeof b?.ct === "string" &&
      b.ct.length > 0 &&
      fromBase64(b.iv).length === ivBytes &&
      fromBase64(b.ct).length >= 16
    );
  } catch {
    return false;
  }
};
// A vault file's settings and records, checked before any key is derived.
export function readVaultFile(text) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw vaultError("bad_file");
  }
  const kdf = file?.kdf;
  let salt;
  try {
    salt = fromBase64(kdf?.salt);
  } catch {
    salt = null;
  }
  const ok =
    file?.format === VAULT_FORMAT &&
    file.version === VAULT_VERSION &&
    kdf?.name === "PBKDF2" &&
    kdf.hash === "SHA-256" &&
    Number.isSafeInteger(kdf.iterations) &&
    kdf.iterations >= MIN_ITERATIONS &&
    kdf.iterations <= MAX_ITERATIONS &&
    salt?.length >= SALT_BYTES &&
    salt.length <= 64 &&
    isBox(file.verifier) &&
    Array.isArray(file.chats) &&
    file.chats.length <= MAX_VAULT_CHATS &&
    file.chats.every(
      (c) => typeof c?.id === "string" && c.id.length > 0 && c.id.length <= 100 && isBox(c),
    ) &&
    new Set(file.chats.map((c) => c.id)).size === file.chats.length;
  if (!ok) throw vaultError("bad_file");
  return {
    meta: {
      format: VAULT_FORMAT,
      version: VAULT_VERSION,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: kdf.iterations, salt: kdf.salt },
      cipher: "AES-GCM-256",
      verifier: { iv: file.verifier.iv, ct: file.verifier.ct },
      idleMinutes: IDLE_CHOICES.includes(file.idleMinutes) ? file.idleMinutes : DEFAULT_IDLE_MINUTES,
    },
    records: file.chats.map(({ id, iv, ct }) => ({ id, iv, ct })),
  };
}
// Opens every chat in a vault file with that file's passphrase.
export async function openVaultFile(parsed, passphrase) {
  const key = await unlockVault(parsed.meta, passphrase);
  const chats = [];
  for (const r of parsed.records) chats.push(await openChat(key, r));
  return { key, chats };
}
// Which imported chats to keep next to the ones already here: new ids, and
// newer copies of chats this vault already has.
export function mergeChats(existing, incoming) {
  const have = new Map(existing.map((c) => [c.id, c]));
  return incoming.filter((c) => !have.has(c.id) || (c.updated || 0) > (have.get(c.id).updated || 0));
}
export const vaultFileName = (now = new Date()) =>
  `anonyma-device-vault-${now.toISOString().slice(0, 10)}.json`;
