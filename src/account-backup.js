// Encrypted Backup's file: made and opened in the browser, never on our
// server. Pure WebCrypto and DOM-free, so the worker
// (src/account-backup.worker.js), the page and the tests (on Node's
// WebCrypto) all run the same code.
//
// The passphrase becomes a non-extractable AES-256-GCM key through
// PBKDF2-SHA-256 with Device Vault's own parameters (600,000 iterations,
// a 16-byte random salt; deriveVaultKey in src/device-vault.js, which also
// refuses a file asking for fewer or for an absurd number).
//
// The file:
//   a small JSON header on one line: format, version, the KDF and its salt,
//   the cipher, the part size, how many parts, the day it was made, and a
//   known text sealed with the key (so a wrong passphrase is told apart
//   from a damaged file);
//   then the parts, each: 4 bytes (big-endian) of ciphertext length, a
//   12-byte random IV, and the AES-GCM ciphertext of up to 4 MB of the
//   plaintext (one JSON item per line; src/account-backup-spec.js).
// Each part's associated data is its index and whether it is the last one,
// so parts can't be reordered, swapped, dropped or cut short without the
// file failing to open (the STREAM construction). The header is not secret:
// nothing in it says what the backup holds.
import {
  VAULT_ITERATIONS,
  MIN_ITERATIONS,
  MAX_ITERATIONS,
  SALT_BYTES,
  IV_BYTES,
  deriveVaultKey,
  randomBytes,
  toBase64,
  fromBase64,
  sealJson,
  openJson,
} from "./device-vault.js";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  CHUNK_BYTES,
  MAX_BACKUP_BYTES,
  MAX_BACKUP_LABEL,
  MAX_HEADER_BYTES,
  MAX_ITEM_CHARS,
  MIN_BACKUP_PASSPHRASE,
  isoDay,
  validDay,
} from "./account-backup-spec.js";

export const BACKUP_CIPHER = "AES-256-GCM";
export const BACKUP_KDF = Object.freeze({ name: "PBKDF2", hash: "SHA-256", iterations: VAULT_ITERATIONS, saltBytes: SALT_BYTES });
const VERIFIER_TEXT = "ANONYMA backup";
const VERIFIER_AAD = "anonyma-backup:verifier";
export const chunkAad = (index, last) => `anonyma-backup:${BACKUP_VERSION}:part:${index}:${last ? "last" : "more"}`;
const TAG_BYTES = 16;
const PREFIX = 4 + IV_BYTES;
export const MAX_CHUNKS = Math.ceil(MAX_BACKUP_BYTES / CHUNK_BYTES) + 1;

export class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}
export const BACKUP_ERRORS = {
  wrong_passphrase: "That passphrase doesn't open this backup.",
  not_backup: "This isn't an ANONYMA backup file.",
  too_large: `A backup can be at most ${MAX_BACKUP_LABEL}. This one is larger.`,
  short_passphrase: `Use a passphrase of at least ${MIN_BACKUP_PASSPHRASE} characters.`,
  weak_passphrase: "Choose a stronger passphrase: a few unrelated words work well.",
  truncated: "This backup ends early, so it's incomplete. Copy the whole file again.",
  unsupported: "This browser can't encrypt a backup.",
};
export const damagedMessage = (part, total) =>
  `Part ${part} of ${total} of this backup can't be opened. The file is damaged or was changed after it was made.`;
const fail = (code, message = BACKUP_ERRORS[code]) => new BackupError(code, message);

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw fail("unsupported");
  return s;
};
const encoder = new TextEncoder();

// ---- The passphrase ---------------------------------------------------------------
// A rough strength estimate for the meter: the characters it draws from,
// with repeats, runs ("aaaa", "1234") and very common words counting for
// little. It is guidance; the minimum length and "not weak" are the rules.
const COMMON = ["password", "passphrase", "anonyma", "qwerty", "letmein", "welcome", "iloveyou", "admin", "123456", "abcdef"];
export const STRENGTH_LABELS = ["", "Weak", "Fair", "Strong", "Very strong"];
export function passphraseStrength(passphrase) {
  let p = String(passphrase ?? "").normalize("NFC");
  if (!p) return { score: 0, bits: 0, label: "" };
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/[0-9]/.test(p)) pool += 10;
  if (/[^A-Za-z0-9]/.test(p)) pool += 33;
  let penalty = 0;
  for (const word of COMMON) {
    const at = p.toLowerCase().indexOf(word);
    if (at >= 0) {
      penalty += word.length - 1;
      p = p.slice(0, at) + p.slice(at + word.length);
    }
  }
  const chars = [...p];
  let effective = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i].codePointAt(0),
      a = i > 0 ? chars[i - 1].codePointAt(0) : null,
      b = i > 1 ? chars[i - 2].codePointAt(0) : null;
    if (a === c) effective += 0.1;
    else if (a != null && b != null && Math.abs(c - a) === 1 && c - a === a - b) effective += 0.2;
    else effective += 1;
  }
  effective = Math.min(effective + (penalty ? 1 : 0), new Set(chars).size * 2.5 + (penalty ? 1 : 0));
  const bits = Math.round(effective * Math.log2(Math.max(pool, 2)));
  const score = bits < 50 ? 1 : bits < 70 ? 2 : bits < 90 ? 3 : 4;
  return { score, bits, label: STRENGTH_LABELS[score] };
}
// Why a passphrase can't lock a backup, or null.
export function backupPassphraseProblem(passphrase) {
  const p = typeof passphrase === "string" ? passphrase.normalize("NFC") : "";
  if ([...p].length < MIN_BACKUP_PASSPHRASE) return BACKUP_ERRORS.short_passphrase;
  if (passphraseStrength(p).score < 2) return BACKUP_ERRORS.weak_passphrase;
  return null;
}

// ---- The header -----------------------------------------------------------------
export function headerBytes(header) {
  return encoder.encode(JSON.stringify(header) + "\n");
}
const isBox = (b) => {
  try {
    return typeof b?.ct === "string" && fromBase64(b.iv).length === IV_BYTES && fromBase64(b.ct).length >= TAG_BYTES;
  } catch {
    return false;
  }
};
// The header of a backup, checked before any key is derived. `bytes` is the
// start of the file.
export function readHeader(bytes) {
  const end = bytes.indexOf(10);
  if (end <= 0 || end > MAX_HEADER_BYTES) throw fail("not_backup");
  let h;
  try {
    h = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)));
  } catch {
    throw fail("not_backup");
  }
  let salt = null;
  try {
    salt = fromBase64(h?.kdf?.salt);
  } catch {
    salt = null;
  }
  const ok =
    h &&
    typeof h === "object" &&
    h.format === BACKUP_FORMAT &&
    h.version === BACKUP_VERSION &&
    h.kdf?.name === "PBKDF2" &&
    h.kdf.hash === "SHA-256" &&
    Number.isSafeInteger(h.kdf.iterations) &&
    h.kdf.iterations >= MIN_ITERATIONS &&
    h.kdf.iterations <= MAX_ITERATIONS &&
    salt?.length >= SALT_BYTES &&
    salt.length <= 64 &&
    h.cipher === BACKUP_CIPHER &&
    Number.isSafeInteger(h.chunk_bytes) &&
    h.chunk_bytes > 0 &&
    h.chunk_bytes <= CHUNK_BYTES &&
    Number.isSafeInteger(h.chunks) &&
    h.chunks >= 1 &&
    h.chunks <= MAX_CHUNKS &&
    validDay(h.created) &&
    isBox(h.verifier);
  if (!ok) throw fail("not_backup");
  return {
    header: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: h.kdf.iterations, salt: h.kdf.salt },
      cipher: BACKUP_CIPHER,
      chunk_bytes: h.chunk_bytes,
      chunks: h.chunks,
      created: h.created,
      verifier: { iv: h.verifier.iv, ct: h.verifier.ct },
    },
    length: end + 1,
  };
}

// ---- Making a backup -----------------------------------------------------------------
// startBackup derives the key, then takes the plaintext in pieces (push) and
// seals each full 4 MB part as it fills; finish seals the rest as the last
// part and returns the header, which the page puts in front of the parts.
// A full part is sealed only once more text follows it, so the last part
// is always marked last.
export async function startBackup(passphrase, { created = Date.now(), chunkBytes = CHUNK_BYTES, maxBytes = MAX_BACKUP_BYTES } = {}) {
  const problem = backupPassphraseProblem(passphrase);
  if (problem) throw new BackupError("passphrase", problem);
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveVaultKey(passphrase, salt, VAULT_ITERATIONS);
  const verifier = await sealJson(key, VERIFIER_TEXT, VERIFIER_AAD);
  let pending = [],
    pendingBytes = 0,
    index = 0,
    total = 0,
    done = false;
  function take(n) {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const first = pending[0];
      const need = n - at;
      if (first.length <= need) {
        out.set(first, at);
        at += first.length;
        pending.shift();
      } else {
        out.set(first.subarray(0, need), at);
        pending[0] = first.subarray(need);
        at += need;
      }
    }
    pendingBytes -= n;
    return out;
  }
  async function seal(plain, last) {
    const iv = randomBytes(IV_BYTES);
    const ct = new Uint8Array(
      await subtle().encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(chunkAad(index, last)) }, key, plain),
    );
    const out = new Uint8Array(PREFIX + ct.length);
    new DataView(out.buffer).setUint32(0, ct.length);
    out.set(iv, 4);
    out.set(ct, PREFIX);
    index++;
    total += out.length;
    if (total > maxBytes) throw fail("too_large");
    return out;
  }
  return {
    // Adds plaintext; resolves the parts it filled (maybe none).
    async push(text) {
      if (done) throw fail("not_backup");
      const bytes = typeof text === "string" ? encoder.encode(text) : text;
      if (bytes.length) {
        pending.push(bytes);
        pendingBytes += bytes.length;
      }
      if (pendingBytes + total > maxBytes) throw fail("too_large");
      const out = [];
      while (pendingBytes > chunkBytes) out.push(await seal(take(chunkBytes), false));
      return out;
    },
    // Seals the last part and returns it with the header.
    async finish() {
      if (done) throw fail("not_backup");
      done = true;
      const last = await seal(take(pendingBytes), true);
      const header = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        kdf: { name: "PBKDF2", hash: "SHA-256", iterations: VAULT_ITERATIONS, salt: toBase64(salt) },
        cipher: BACKUP_CIPHER,
        chunk_bytes: chunkBytes,
        chunks: index,
        created: isoDay(created),
        verifier,
      };
      return { parts: [last], header: headerBytes(header), chunks: index };
    },
  };
}

// ---- Opening a backup ------------------------------------------------------------------
const sizeOf = (source) => source?.size ?? source?.byteLength ?? source?.length ?? 0;
async function readRange(source, start, end) {
  if (source instanceof Uint8Array) return source.subarray(start, end);
  if (source instanceof ArrayBuffer) return new Uint8Array(source, start, end - start);
  return new Uint8Array(await source.slice(start, end).arrayBuffer());
}
// Opens a backup (a File, Blob or bytes) with its passphrase and hands each
// item line to onLine, in order, as parsed JSON (or null for a line that
// isn't JSON). Only one part is held at a time. Throws BackupError:
// not_backup, too_large, wrong_passphrase, truncated, or "damaged" naming
// the part that failed.
export async function openBackup(source, passphrase, { onLine, onProgress } = {}) {
  const size = sizeOf(source);
  if (size > MAX_BACKUP_BYTES + MAX_HEADER_BYTES) throw fail("too_large");
  if (size < 2) throw fail("not_backup");
  const { header, length } = readHeader(await readRange(source, 0, Math.min(size, MAX_HEADER_BYTES + 1)));
  let key;
  try {
    key = await deriveVaultKey(String(passphrase ?? ""), fromBase64(header.kdf.salt), header.kdf.iterations);
  } catch {
    throw fail("not_backup");
  }
  try {
    if ((await openJson(key, header.verifier, VERIFIER_AAD)) !== VERIFIER_TEXT) throw Error();
  } catch {
    throw fail("wrong_passphrase");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const damaged = (i) => new BackupError("damaged", damagedMessage(i + 1, header.chunks));
  let carry = "",
    offset = length;
  for (let i = 0; i < header.chunks; i++) {
    const last = i === header.chunks - 1;
    if (offset + PREFIX > size) throw fail("truncated");
    const prefix = await readRange(source, offset, offset + PREFIX);
    const n = new DataView(prefix.buffer, prefix.byteOffset, PREFIX).getUint32(0);
    if (n < TAG_BYTES || n > header.chunk_bytes + TAG_BYTES) throw damaged(i);
    if (offset + PREFIX + n > size) throw fail("truncated");
    const ct = await readRange(source, offset + PREFIX, offset + PREFIX + n);
    let plain;
    try {
      plain = await subtle().decrypt(
        { name: "AES-GCM", iv: prefix.slice(4, PREFIX), additionalData: encoder.encode(chunkAad(i, last)) },
        key,
        ct,
      );
    } catch {
      throw damaged(i);
    }
    offset += PREFIX + n;
    let text;
    try {
      text = decoder.decode(plain, { stream: !last });
    } catch {
      throw damaged(i);
    }
    const lines = (carry + text).split("\n");
    carry = lines.pop();
    if (carry.length > MAX_ITEM_CHARS) throw damaged(i);
    for (const line of lines) {
      if (!line) continue;
      let item = null;
      try {
        item = JSON.parse(line);
      } catch {
        item = null;
      }
      onLine?.(item);
    }
    onProgress?.({ done: i + 1, total: header.chunks });
  }
  // Anything after the last part, or a last line cut off, means the file
  // isn't the one that was made.
  if (offset !== size || carry) throw damaged(header.chunks - 1);
  return header;
}
