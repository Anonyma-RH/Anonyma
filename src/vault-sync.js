// Vault Sync: an opt-in, end-to-end-encrypted copy of Device Vault on
// ANONYMA's servers, so the same vault opens on every device.
//
// Everything here runs in the browser (and on Node's WebCrypto in tests).
// The vault's chats are already sealed by src/device-vault.js (PBKDF2 key,
// AES-GCM with the chat id as AAD); sync uploads those sealed records
// exactly as stored, so the server receives ids, versions and ciphertext,
// never a title, a message, the passphrase or the key. The synced vault's
// salt, iteration count and verifier (a fixed text sealed with the key) are
// kept with it so another device can derive the same key and tell a wrong
// passphrase before it writes anything.
//
// The protocol: pull every change since this device's cursor, then push
// what changed here. Each record has a server version; a push names the
// version it was based on, and the server refuses a stale one with the
// current record. When both sides changed a chat, the newer one (by the
// chat's own `updated` time, inside the ciphertext) keeps the id and the
// other is kept beside it as a conflict copy, so nothing is lost. A delete
// is a tombstone; an edit made elsewhere outlives it. Network and storage
// are injected (`remote`, `local`), so tests drive two simulated devices.
import {
  openChat,
  sealChat,
  keyOpensVerifier,
  unlockVault,
  vaultReleased,
  VaultError,
  VAULT_FORMAT,
  VAULT_VERSION,
  IDLE_CHOICES,
  DEFAULT_IDLE_MINUTES,
} from "./device-vault.js";
import { isReleased } from "./lib.js";
import {
  SYNC_ID,
  SYNC_PUSH_RECORDS,
  SYNC_PUSH_BYTES,
  SYNC_MAX_RECORD_BYTES,
  recordSize,
} from "./vault-sync-spec.js";

export { formatBytes, SYNC_MAX_BYTES, SYNC_MAX_RECORD_BYTES, SYNC_PAGE } from "./vault-sync-spec.js";

// Vault Sync needs Device Vault (and so Ephemeral Chats) released too.
export const vaultSyncReleased = (config) =>
  vaultReleased(config) && isReleased(config, "vaultsync");

// The honest limits, shown wherever sync is turned on or managed.
export const SYNC_LIMITS = [
  "If you forget the passphrase, nobody can recover these chats, including us.",
  "We can see how many records you store, their sizes and when they change.",
  "A strong passphrase matters: anyone who got the encrypted copy could try to guess it.",
];
// Why this device stopped syncing on its own. Its chats always stay.
export const SYNC_STOPPED = {
  forgotten: "The synced copy was deleted, so this device stopped syncing. Its chats are still here.",
  replaced: "Your synced vault was replaced on another device, so this device stopped syncing. Its chats are still here.",
  other_vault: "This vault isn't the synced one, so this device stopped syncing. Its chats are still here.",
};

// The synced vault's settings as a Device Vault's stored settings.
export function metaFromServer(vault, idleMinutes = DEFAULT_IDLE_MINUTES) {
  return {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: vault.kdf.iterations, salt: vault.kdf.salt },
    cipher: "AES-GCM-256",
    verifier: { iv: vault.verifier.iv, ct: vault.verifier.ct },
    idleMinutes: IDLE_CHOICES.includes(idleMinutes) ? idleMinutes : DEFAULT_IDLE_MINUTES,
  };
}
// What turning sync on uploads: the salt, the iteration count and the
// verifier. Never the passphrase or the key.
export const setupBody = (meta) => ({
  kdf: { name: meta.kdf.name, hash: meta.kdf.hash, iterations: meta.kdf.iterations, salt: meta.kdf.salt },
  verifier: { iv: meta.verifier.iv, ct: meta.verifier.ct },
});
// Whether this device's unlocked vault is the synced one: the same salt and
// iteration count, and its key opens the synced verifier.
export async function sameVault(key, meta, vault) {
  return (
    !!vault &&
    meta?.kdf?.salt === vault.kdf?.salt &&
    meta?.kdf?.iterations === vault.kdf?.iterations &&
    (await keyOpensVerifier(key, vault.verifier))
  );
}
// A device without this vault yet: the synced vault's settings and key from
// its passphrase, or VaultError "wrong_passphrase".
export async function openSynced(vault, passphrase, idleMinutes) {
  const meta = metaFromServer(vault, idleMinutes);
  return { meta, key: await unlockVault(meta, passphrase) };
}

// Turns sync on for this device's unlocked vault, making it the synced vault
// when the account has none. Refused (VaultError "other_vault") when the
// account already syncs a vault with another key: join that one instead.
export async function turnOn({ key, meta, remote, local }) {
  let { vault } = await remote.status();
  if (!vault) {
    try {
      vault = (await remote.setup(setupBody(meta))).vault;
    } catch (e) {
      if (e?.code !== "vault_sync_exists") throw e;
      vault = (await remote.status()).vault;
    }
  }
  if (!(await sameVault(key, meta, vault)))
    throw new VaultError("other_vault", "Another of your devices syncs a different vault.");
  await local.saveState({
    meta: { enabled: true, vault: vault.id, salt: meta.kdf.salt, cursor: 0, last: null, reason: null },
    reset: true,
  });
  return vault;
}
// Stops syncing on this device. The synced copy stays for other devices.
export const turnOff = ({ local, reason = null }) =>
  local.saveState({ meta: { enabled: false, reason }, reset: true });

const sealed = (r) => ({ id: r.id, iv: r.iv, ct: r.ct });
const sameChat = (a, b) => JSON.stringify({ ...a, updated: 0 }) === JSON.stringify({ ...b, updated: 0 });
async function tryOpen(key, record) {
  try {
    return await openChat(key, record);
  } catch {
    return null;
  }
}

// Which way one pulled change goes, given this device's copy (or none) and
// what it last synced for that id (or nothing):
// skip: already had it; same: this device holds that very ciphertext;
// apply: unchanged here, so take it; conflict: changed on both sides.
export function decide(remote, local, known) {
  if (known && remote.version <= known.v) return "skip";
  if (local && !remote.deleted && local.iv === remote.iv) return "same";
  const changedHere = local ? !known || known.iv !== local.iv : !!known;
  return changedHere ? "conflict" : "apply";
}

// Both sides changed one chat. Returns the sealed records to write here, the
// chats to show, and the id's new known entry: { v, iv } (iv "" means this
// device's copy wins and goes up next, based on that version) or null.
export async function resolveConflict({ key, remote, local, newId }) {
  const out = { put: [], shown: [], known: null, conflict: false, damaged: 0 };
  const take = (chat) => {
    out.put.push(sealed(remote));
    out.shown.push(chat);
    out.known = { v: remote.version, iv: remote.iv };
  };
  const keepOurs = () => (out.known = { v: remote.version, iv: "" });
  if (!local) {
    // Deleted on both sides: nothing left to track. Deleted here but
    // changed elsewhere: the change comes back, since a delete can't be
    // undone and an edit may hold new messages.
    if (remote.deleted) return out;
    const theirs = await tryOpen(key, remote);
    if (theirs) take(theirs);
    else out.damaged = 1;
    return out;
  }
  // Changed here, deleted elsewhere: this device's chat stays and goes up.
  if (remote.deleted) {
    keepOurs();
    return out;
  }
  const ours = await tryOpen(key, local),
    theirs = await tryOpen(key, remote);
  if (!theirs) {
    out.damaged = 1;
    keepOurs();
    return out;
  }
  if (!ours || sameChat(ours, theirs)) {
    take(theirs);
    return out;
  }
  const t = theirs.updated || 0,
    o = ours.updated || 0;
  const theirsWins = t > o || (t === o && remote.iv > local.iv);
  const copy = { ...(theirsWins ? ours : theirs), id: newId(), conflictCopy: true };
  const copied = await sealChat(key, copy);
  if (theirsWins) take(theirs);
  else keepOurs();
  out.put.push(copied);
  out.shown.push(copy);
  out.conflict = true;
  return out;
}

// Pushes grouped to stay inside the server's per-request limits.
export function batches(changes) {
  const out = [];
  let cur = [],
    bytes = 0;
  for (const c of changes) {
    if (cur.length && (cur.length >= SYNC_PUSH_RECORDS || bytes + c.size > SYNC_PUSH_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(c);
    bytes += c.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

// One sync of an unlocked vault: pull, then push (a few rounds while pushes
// meet conflicts). `remote` is { status, pull(vault, since), push(vault,
// records) }; `local` is src/vault-sync-store.js's localSyncStore. Returns
// what happened and the chats to show or drop in the open vault.
export async function syncVault({ key, meta, remote, local, newId = () => globalThis.crypto.randomUUID(), now = Date.now }) {
  const res = {
    status: "synced",
    pulled: 0,
    pushed: 0,
    removed: 0,
    conflicts: 0,
    damaged: 0,
    tooBig: 0,
    full: false,
    tooMany: false,
    shown: [],
    gone: [],
    stats: null,
  };
  const state = await local.loadState();
  const settings = state.meta;
  if (!settings?.enabled) return { ...res, status: "off" };
  const stop = async (reason) => {
    await local.saveState({ meta: { ...settings, enabled: false, reason }, reset: true });
    return { ...res, status: reason };
  };
  const { vault } = await remote.status();
  // The synced copy was deleted (Forget synced copy, Panic Wipe, account
  // closure) or replaced by another device: never upload this vault again
  // without the person turning sync on here.
  if (!vault) return stop("forgotten");
  if (vault.id !== settings.vault) return stop("replaced");
  if (settings.salt !== meta?.kdf?.salt || !(await sameVault(key, meta, vault))) return stop("other_vault");

  const known = new Map(state.known.map((k) => [k.id, { v: k.v, iv: k.iv }]));
  const put = new Map(),
    del = new Set();
  const setKnown = (id, k) => {
    known.set(id, k);
    put.set(id, { id, ...k });
    del.delete(id);
  };
  const forget = (id) => {
    known.delete(id);
    put.delete(id);
    del.add(id);
  };
  const flush = async (extra = {}) => {
    await local.saveState({ meta: { ...settings, ...extra }, put: [...put.values()], del: [...del] });
    put.clear();
    del.clear();
  };
  const shown = new Map(),
    gone = new Set();
  const show = (c) => {
    shown.set(c.id, c);
    gone.delete(c.id);
  };
  async function writeOut(id, out) {
    if (out.put.length) await local.put(out.put);
    for (const c of out.shown) show(c);
    if (out.known) setKnown(id, out.known);
    else forget(id);
    if (out.conflict) res.conflicts++;
    res.damaged += out.damaged;
  }

  // Pull everything changed since the last sync.
  let cursor = settings.cursor || 0;
  for (let pages = 0; pages < 10000; pages++) {
    const page = await remote.pull(settings.vault, cursor);
    res.stats = page.stats || res.stats;
    await local.exclusive(async () => {
      const here = new Map((await local.get(page.records.map((r) => r.id))).map((r) => [r.id, r]));
      for (const r of page.records) {
        const L = here.get(r.id);
        const way = decide(r, L, known.get(r.id));
        if (way === "skip") continue;
        if (way === "same") {
          setKnown(r.id, { v: r.version, iv: r.iv });
          continue;
        }
        if (way === "conflict") {
          await writeOut(r.id, await resolveConflict({ key, remote: r, local: L, newId }));
          continue;
        }
        if (r.deleted) {
          if (L) {
            await local.remove([r.id]);
            gone.add(r.id);
            shown.delete(r.id);
            res.removed++;
          }
          forget(r.id);
          continue;
        }
        // Only what opens with this vault's key, under this id, is kept.
        const chat = await tryOpen(key, r);
        if (!chat) {
          res.damaged++;
          continue;
        }
        await local.put([sealed(r)]);
        setKnown(r.id, { v: r.version, iv: r.iv });
        show(chat);
        res.pulled++;
      }
      cursor = page.cursor;
      await flush({ cursor });
    });
    if (!page.more) break;
  }

  // Push what changed here: new and edited chats, and deletes.
  const tooBig = new Set();
  for (let round = 0; round < 4; round++) {
    const all = await local.records();
    const ids = new Set(all.map((r) => r.id));
    const changes = [];
    for (const r of all) {
      // Vault chat ids are random UUIDs; anything else stays here.
      if (!SYNC_ID.test(r.id)) continue;
      const k = known.get(r.id);
      if (k && k.iv === r.iv) continue;
      const size = recordSize(r.iv, r.ct);
      if (size > SYNC_MAX_RECORD_BYTES) {
        tooBig.add(r.id);
        continue;
      }
      changes.push({ id: r.id, base: k?.v || 0, iv: r.iv, ct: r.ct, size });
    }
    for (const [id, k] of known) if (!ids.has(id)) changes.push({ id, base: k.v, deleted: true, size: 0 });
    // Deletes first: they free room.
    changes.sort((a, b) => (b.deleted ? 1 : 0) - (a.deleted ? 1 : 0));
    let conflicted = false;
    for (const batch of batches(changes)) {
      const send = res.full || res.tooMany ? batch.filter((c) => c.deleted) : batch;
      if (!send.length) continue;
      const reply = await remote.push(
        settings.vault,
        send.map(({ size, ...c }) => c),
      );
      res.stats = reply.stats || res.stats;
      const sent = new Map(send.map((c) => [c.id, c]));
      const conflicts = [];
      for (const x of reply.results || []) {
        const c = sent.get(x.id);
        if (!c) continue;
        if (Number.isSafeInteger(x.version)) {
          if (c.deleted) forget(x.id);
          else setKnown(x.id, { v: x.version, iv: c.iv });
          res.pushed++;
        } else if (x.conflict) conflicts.push(x);
        else if (x.error === "too_large") tooBig.add(x.id);
        else if (x.error === "storage_full") res.full = true;
        else if (x.error === "record_limit") res.tooMany = true;
      }
      if (conflicts.length) {
        conflicted = true;
        await local.exclusive(async () => {
          const here = new Map((await local.get(conflicts.map((x) => x.id))).map((r) => [r.id, r]));
          for (const x of conflicts)
            await writeOut(
              x.id,
              await resolveConflict({ key, remote: { id: x.id, ...x.conflict }, local: here.get(x.id), newId }),
            );
        });
      }
      await flush();
    }
    if (!conflicted) break;
  }
  res.tooBig = tooBig.size;
  await flush({ cursor, last: now(), reason: null });
  res.shown = [...shown.values()];
  res.gone = [...gone];
  return res;
}
