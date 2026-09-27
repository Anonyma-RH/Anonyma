import { uid, now, fail, transaction } from "../core.js";
import {
  SYNC_MAX_BYTES,
  SYNC_MAX_RECORD_BYTES,
  SYNC_MAX_RECORDS,
  SYNC_MAX_TOMBSTONES,
  SYNC_PAGE,
  SYNC_MAX_PAGE,
  SYNC_PUSH_RECORDS,
  SYNC_PUSH_BYTES,
  SYNC_ID,
  SYNC_IV_BYTES,
  SYNC_MIN_CT_BYTES,
  SYNC_SALT_MIN,
  SYNC_SALT_MAX,
  SYNC_MIN_ITERATIONS,
  SYNC_MAX_ITERATIONS,
  SETUP_FIELDS,
  KDF_FIELDS,
  BOX_FIELDS,
  PUSH_FIELDS,
  RECORD_FIELDS,
  TOMBSTONE_FIELDS,
  decodedLength,
} from "../../src/vault-sync-spec.js";

// Vault Sync: the server side of an end-to-end-encrypted Device Vault. The
// browser seals every chat before it's sent (src/vault-sync.js), so this
// file only ever sees, per account:
// - the synced vault's settings: a random id, the PBKDF2 salt and iteration
//   count (not secret) and the verifier, a fixed text sealed with the key so
//   another device can tell a wrong passphrase;
// - one row per chat: its random id, a version, the IV and ciphertext bytes,
//   their size and when it changed; a deleted chat keeps a tombstone (id,
//   version and time, no bytes).
// Never a title, a message, the passphrase or the key: a request with any
// field besides these is refused before anything is written, and nothing
// here is logged. Panic Wipe and account closure erase it all
// (eraseAccountContent in routes/account.js), "Forget synced copy" does too,
// and the account export carries the ciphertext as an importable vault file.
// The release gate (releases.js) refuses every route until Vault Sync and
// Device Vault are released.

const b64 = (bytes) => (bytes ? Buffer.from(bytes).toString("base64") : null);
// Standard, canonical base64 (what the browser's btoa writes), so a value
// read back is byte-for-byte the string that was sent.
function bytesOf(text, min, max) {
  const n = decodedLength(text);
  if (n < min || n > max) return null;
  const buf = Buffer.from(text, "base64");
  return buf.length === n && buf.toString("base64") === text ? buf : null;
}
const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const only = (v, fields, required = fields) =>
  plainObject(v) &&
  Object.keys(v).every((k) => fields.includes(k)) &&
  required.every((k) => Object.hasOwn(v, k));
const refuse = (message) => fail(400, message, "invalid_request");
const ONLY_SEALED = "Vault Sync accepts only sealed records: id, base, iv and ct, or id, base and deleted.";

function statsOf(db, user) {
  const r = db
    .prepare(
      "SELECT COALESCE(SUM(deleted=0),0) records,COALESCE(SUM(deleted=1),0) tombstones,COALESCE(SUM(size),0) bytes FROM vault_sync_records WHERE user_id=?",
    )
    .get(user);
  return { records: r.records, tombstones: r.tombstones, bytes: r.bytes };
}
function view(db, row) {
  const { records, tombstones, bytes } = statsOf(db, row.user_id);
  return {
    id: row.id,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: row.iterations, salt: row.salt },
    verifier: { iv: row.verifier_iv, ct: row.verifier_ct },
    created: row.created,
    updated: row.updated,
    records,
    tombstones,
    bytes,
    cursor: row.seq,
  };
}
const recordView = (r) => ({
  id: r.id,
  version: r.version,
  deleted: !!r.deleted,
  size: r.size,
  updated: r.updated,
  ...(r.deleted ? {} : { iv: b64(r.iv), ct: b64(r.ct) }),
});
const settingsOf = (db, user) => db.prepare("SELECT * FROM vault_sync WHERE user_id=?").get(user);

// The account export: the synced ciphertext as a Device Vault file (import
// it on any device with the vault's passphrase), and each record's version,
// size and dates, tombstones included. Null when nothing is synced.
export function exportVaultSync(db, user) {
  const row = settingsOf(db, user);
  if (!row) return null;
  const rows = db
    .prepare(
      "SELECT id,version,iv,ct,size,deleted,updated FROM vault_sync_records WHERE user_id=? ORDER BY seq,rowid",
    )
    .all(user);
  return {
    note: "Encrypted in your browser before it was synced. Only your Device Vault passphrase opens these chats; ANONYMA can't. To read them, save `file` as a .json file and import it in Device Vault (Manage vault → Import a vault file).",
    created: row.created,
    updated: row.updated,
    file: {
      format: "anonyma-device-vault",
      version: 1,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: row.iterations, salt: row.salt },
      cipher: "AES-GCM-256",
      verifier: { iv: row.verifier_iv, ct: row.verifier_ct },
      idleMinutes: 15,
      chats: rows.filter((r) => !r.deleted).map((r) => ({ id: r.id, iv: b64(r.iv), ct: b64(r.ct) })),
    },
    records: rows.map(({ id, version, size, deleted, updated }) => ({
      id,
      version,
      size,
      deleted: !!deleted,
      updated,
    })),
  };
}
// Account closure, Panic Wipe and "Forget synced copy".
export function forgetVaultSync(db, user) {
  db.prepare("DELETE FROM vault_sync_records WHERE user_id=?").run(user);
  return db.prepare("DELETE FROM vault_sync WHERE user_id=?").run(user).changes > 0;
}

export function vaultSyncRoutes(ctx) {
  const { app, db, limit, requireUser } = ctx;
  // A pull reads up to 500 records a page (a full 5,000-chat vault in ten
  // requests); a push carries up to 100. Setting up and forgetting are rare.
  const read = limit("vault-sync-read", 600, 600000);
  const write = limit("vault-sync-write", 240, 600000);
  const manage = limit("vault-sync-manage", 30, 3600000);
  const limits = { bytes: SYNC_MAX_BYTES, recordBytes: SYNC_MAX_RECORD_BYTES, records: SYNC_MAX_RECORDS };

  // The synced vault this account keeps, if any: what another device needs
  // to derive the key and check its passphrase, and how much is stored.
  app.get("/api/vault-sync", requireUser, read, (req, res) => {
    const row = settingsOf(db, req.user.id);
    res.json({ vault: row ? view(db, row) : null, limits });
  });

  // Turning sync on for the first device: only the salt, the iteration
  // count and the verifier are uploaded. One synced vault per account.
  app.post("/api/vault-sync", requireUser, manage, (req, res) => {
    const body = req.body;
    if (!only(body, SETUP_FIELDS) || !only(body.kdf, KDF_FIELDS) || !only(body.verifier, BOX_FIELDS))
      refuse("Send only kdf { name, hash, iterations, salt } and verifier { iv, ct }.");
    const { kdf, verifier } = body;
    if (
      kdf.name !== "PBKDF2" ||
      kdf.hash !== "SHA-256" ||
      !Number.isSafeInteger(kdf.iterations) ||
      kdf.iterations < SYNC_MIN_ITERATIONS ||
      kdf.iterations > SYNC_MAX_ITERATIONS ||
      !bytesOf(kdf.salt, SYNC_SALT_MIN, SYNC_SALT_MAX) ||
      !bytesOf(verifier.iv, SYNC_IV_BYTES, SYNC_IV_BYTES) ||
      !bytesOf(verifier.ct, SYNC_MIN_CT_BYTES, 256)
    )
      refuse(
        `Use PBKDF2 with SHA-256 and ${SYNC_MIN_ITERATIONS.toLocaleString("en-US")} to ${SYNC_MAX_ITERATIONS.toLocaleString("en-US")} iterations, a ${SYNC_SALT_MIN}–${SYNC_SALT_MAX} byte salt and a sealed verifier.`,
      );
    const row = transaction(db, () => {
      if (settingsOf(db, req.user.id))
        fail(409, "This account already syncs a vault. Join it, or forget it first.", "vault_sync_exists");
      const at = now();
      db.prepare(
        "INSERT INTO vault_sync(user_id,id,salt,iterations,verifier_iv,verifier_ct,seq,created,updated) VALUES(?,?,?,?,?,?,0,?,?)",
      ).run(req.user.id, uid("vs_"), kdf.salt, kdf.iterations, verifier.iv, verifier.ct, at, at);
      return settingsOf(db, req.user.id);
    });
    res.status(201).json({ vault: view(db, row), limits });
  });

  // Forget synced copy: every record and the settings, overwritten in the
  // database file rather than left in its free pages. Devices keep their own
  // copies and stop syncing when they next check.
  app.delete("/api/vault-sync", requireUser, manage, (req, res) => {
    const secure = db.prepare("PRAGMA secure_delete").get().secure_delete;
    db.exec("PRAGMA secure_delete=ON");
    let forgotten;
    try {
      forgotten = transaction(db, () => forgetVaultSync(db, req.user.id));
    } finally {
      db.exec(`PRAGMA secure_delete=${Number(secure) || 0}`);
    }
    res.json({ ok: true, forgotten });
  });

  // The account's synced vault by id: a device only ever reads or writes the
  // vault it joined, never one created after it was forgotten.
  function synced(user, id) {
    const row = settingsOf(db, user);
    if (!row) fail(404, "This account doesn't sync a vault.", "vault_sync_missing");
    if (id !== row.id)
      fail(409, "The synced vault was replaced on another device.", "vault_sync_changed");
    return row;
  }

  // Pull: records changed after `since` (a cursor from an earlier pull), in
  // change order. `cursor` is where the next pull starts.
  app.get("/api/vault-sync/records", requireUser, read, (req, res) => {
    const since = Number(req.query.since ?? 0),
      take = Number(req.query.limit ?? SYNC_PAGE),
      id = req.query.vault;
    if (
      typeof id !== "string" ||
      id.length > 100 ||
      !Number.isSafeInteger(since) ||
      since < 0 ||
      !Number.isInteger(take) ||
      take < 1 ||
      take > SYNC_MAX_PAGE
    )
      refuse(`Send vault, a since cursor of 0 or more and a limit of 1–${SYNC_MAX_PAGE}.`);
    const row = synced(req.user.id, id);
    const rows = db
      .prepare(
        "SELECT id,version,seq,iv,ct,size,deleted,updated FROM vault_sync_records WHERE user_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(req.user.id, since, take + 1);
    const more = rows.length > take;
    const page = rows.slice(0, take);
    const { records, bytes } = statsOf(db, req.user.id);
    res.json({
      vault: row.id,
      records: page.map(recordView),
      cursor: more ? page.at(-1).seq : row.seq,
      more,
      stats: { records, bytes },
    });
  });

  // Push: each record names the version it was based on (0 for a new one).
  // A stale base is answered with the current record for the browser to
  // merge; the rest are stored as sent. Checked whole before anything is
  // written: a request carrying anything but sealed records is refused.
  app.post("/api/vault-sync/records", requireUser, write, (req, res) => {
    const body = req.body;
    if (!only(body, PUSH_FIELDS) || typeof body.vault !== "string" || body.vault.length > 100)
      refuse(ONLY_SEALED);
    const list = body.records;
    if (!Array.isArray(list) || !list.length || list.length > SYNC_PUSH_RECORDS)
      refuse(`Send 1–${SYNC_PUSH_RECORDS} records at a time.`);
    const seen = new Set();
    let total = 0;
    const changes = list.map((r) => {
      const tomb = plainObject(r) && Object.hasOwn(r, "deleted");
      if (
        !(tomb ? only(r, TOMBSTONE_FIELDS) && r.deleted === true : only(r, RECORD_FIELDS)) ||
        typeof r.id !== "string" ||
        !SYNC_ID.test(r.id) ||
        seen.has(r.id) ||
        !Number.isSafeInteger(r.base) ||
        r.base < 0
      )
        refuse(ONLY_SEALED);
      seen.add(r.id);
      if (tomb) return { id: r.id, base: r.base, deleted: true };
      const iv = bytesOf(r.iv, SYNC_IV_BYTES, SYNC_IV_BYTES),
        ct = bytesOf(r.ct, SYNC_MIN_CT_BYTES, Number.MAX_SAFE_INTEGER);
      if (!iv || !ct) refuse(ONLY_SEALED);
      total += iv.length + ct.length;
      return { id: r.id, base: r.base, iv, ct, size: iv.length + ct.length };
    });
    if (total > SYNC_PUSH_BYTES)
      refuse(`Send at most ${SYNC_PUSH_BYTES / 1024 / 1024} MB of records at a time.`);
    const out = transaction(db, () => {
      const row = synced(req.user.id, body.vault);
      let seq = row.seq,
        { records: live, tombstones, bytes } = statsOf(db, req.user.id);
      const at = now();
      const current = db.prepare(
        "SELECT id,version,iv,ct,size,deleted,updated FROM vault_sync_records WHERE user_id=? AND id=?",
      );
      const upsert = db.prepare(
        `INSERT INTO vault_sync_records(user_id,id,version,seq,iv,ct,size,deleted,updated) VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id,id) DO UPDATE SET version=excluded.version,seq=excluded.seq,iv=excluded.iv,
           ct=excluded.ct,size=excluded.size,deleted=excluded.deleted,updated=excluded.updated`,
      );
      const results = [];
      for (const c of changes) {
        const cur = current.get(req.user.id, c.id);
        const version = cur?.version || 0;
        // Changed since this device last saw it (or gone from here: a
        // tombstone past the cap reads as deleted at version 0).
        if (c.base !== version) {
          results.push({ id: c.id, conflict: cur ? recordView(cur) : { version: 0, deleted: true } });
          continue;
        }
        if (c.deleted) {
          if (!cur || cur.deleted) {
            results.push({ id: c.id, version });
            continue;
          }
          upsert.run(req.user.id, c.id, version + 1, ++seq, null, null, 0, 1, at);
          live--;
          tombstones++;
          bytes -= cur.size;
          results.push({ id: c.id, version: version + 1 });
          continue;
        }
        const was = cur && !cur.deleted ? cur.size : 0;
        if (c.size > SYNC_MAX_RECORD_BYTES) {
          results.push({ id: c.id, error: "too_large" });
          continue;
        }
        if (bytes - was + c.size > SYNC_MAX_BYTES) {
          results.push({ id: c.id, error: "storage_full" });
          continue;
        }
        if ((!cur || cur.deleted) && live >= SYNC_MAX_RECORDS) {
          results.push({ id: c.id, error: "record_limit" });
          continue;
        }
        upsert.run(req.user.id, c.id, version + 1, ++seq, c.iv, c.ct, c.size, 0, at);
        if (!cur || cur.deleted) live++;
        if (cur?.deleted) tombstones--;
        bytes += c.size - was;
        results.push({ id: c.id, version: version + 1 });
      }
      if (seq !== row.seq) {
        db.prepare("UPDATE vault_sync SET seq=?,updated=? WHERE user_id=?").run(seq, at, req.user.id);
        // The oldest tombstones go past the cap.
        if (tombstones > SYNC_MAX_TOMBSTONES)
          db.prepare(
            `DELETE FROM vault_sync_records WHERE rowid IN (SELECT rowid FROM vault_sync_records
               WHERE user_id=? AND deleted=1 ORDER BY seq LIMIT ?)`,
          ).run(req.user.id, tombstones - SYNC_MAX_TOMBSTONES);
      }
      return { results, cursor: seq, stats: { records: live, bytes } };
    });
    res.json(out);
  });
}
