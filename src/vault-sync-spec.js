// Vault Sync: the limits and record rules shared by the browser's sync
// (src/vault-sync.js) and the server that keeps the ciphertext
// (server/routes/vault-sync.js). No imports, so the server image can copy
// this one file.
//
// What the server keeps per account: the vault's salt, iteration count and
// verifier (a fixed text sealed with the vault key, so another device can
// tell a wrong passphrase), and one row per chat: its random id, a version,
// the sealed bytes (IV and AES-GCM ciphertext), their size and when it last
// changed. A deleted chat leaves a tombstone: id, version and time only.

// Ciphertext an account can keep synced, and one chat's share of it.
export const SYNC_MAX_BYTES = 50 * 1024 * 1024;
export const SYNC_MAX_RECORD_BYTES = 4 * 1024 * 1024;
// Live chats (Device Vault's own cap) and tombstones per account. Past the
// tombstone cap the oldest are dropped; a device that missed one may send
// that chat back once, which only ever keeps a chat, never loses one.
export const SYNC_MAX_RECORDS = 5000;
export const SYNC_MAX_TOMBSTONES = 20000;
// Records per pull page (the default and the most one request may ask for).
export const SYNC_PAGE = 200;
export const SYNC_MAX_PAGE = 500;
// One push: at most this many records and this many sealed bytes, which
// stays well inside the server's 18 MB JSON body limit once base64-encoded.
export const SYNC_PUSH_RECORDS = 100;
export const SYNC_PUSH_BYTES = 8 * 1024 * 1024;
// Vault chat ids are random UUIDs (crypto.randomUUID()); nothing else is
// accepted, so an id can't carry readable text.
export const SYNC_ID = /^[A-Za-z0-9_-]{1,100}$/;
export const SYNC_IV_BYTES = 12;
// An AES-GCM ciphertext is at least its 16-byte tag.
export const SYNC_MIN_CT_BYTES = 16;
export const SYNC_SALT_MIN = 16;
export const SYNC_SALT_MAX = 64;
// Device Vault's PBKDF2 bounds (src/device-vault.js): a synced vault can't
// ask another device for a weaker key, or hang it deriving one.
export const SYNC_MIN_ITERATIONS = 600000;
export const SYNC_MAX_ITERATIONS = 10000000;
// The only fields a request may carry. Anything else is refused, so a
// mistake can never upload a title, a message or a key.
export const SETUP_FIELDS = ["kdf", "verifier"];
export const KDF_FIELDS = ["name", "hash", "iterations", "salt"];
export const BOX_FIELDS = ["iv", "ct"];
export const PUSH_FIELDS = ["vault", "records"];
export const RECORD_FIELDS = ["id", "base", "iv", "ct"];
export const TOMBSTONE_FIELDS = ["id", "base", "deleted"];

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
// Bytes a standard base64 string decodes to, or -1 when it isn't one.
export function decodedLength(text) {
  if (typeof text !== "string" || text.length % 4 !== 0 || !B64.test(text)) return -1;
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return (text.length / 4) * 3 - pad;
}
// A record's size as the server counts it: its IV and ciphertext bytes.
export const recordSize = (iv, ct) => Math.max(0, decodedLength(iv)) + Math.max(0, decodedLength(ct));

// "184 KB", "1.2 MB", "50 MB".
export function formatBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${Math.max(1, Math.round(v / 1024))} KB`;
  const mb = v / (1024 * 1024);
  return `${mb >= 10 || Number.isInteger(mb) ? Math.round(mb) : mb.toFixed(1)} MB`;
}
