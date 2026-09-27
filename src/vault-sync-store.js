// Vault Sync's bookkeeping in this browser: whether this device syncs, with
// which synced vault, how far it has pulled, and for each chat the version
// and IV it last synced. A chat whose IV differs from its synced one has
// changed here (every seal uses a fresh random IV); a synced chat that's
// gone from the vault was deleted here. Nothing readable is kept: ids,
// numbers and IVs only. One IndexedDB database per account, deleted with
// the vault (deleteVault in src/device-vault-store.js).
import { syncDbName, listRecords, getRecords, putRecords, deleteRecord, exclusive } from "./device-vault-store.js";

const VERSION = 1;
const OFF = { enabled: false, vault: null, salt: null, cursor: 0, last: null, reason: null };

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function openDb(account) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("This browser can't store a vault."));
    const req = indexedDB.open(syncDbName(account), VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("known")) db.createObjectStore("known", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Close other ANONYMA tabs and try again."));
  });
}
async function tx(account, mode, run) {
  const db = await openDb(account);
  try {
    const t = db.transaction(["meta", "known"], mode);
    const done = new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("Vault storage was interrupted."));
    });
    const result = await run(t.objectStore("meta"), t.objectStore("known"));
    await done;
    return result;
  } finally {
    db.close();
  }
}

// The sync state: { meta, known: [{ id, v, iv }] }.
export const loadSyncState = (account) =>
  tx(account, "readonly", async (meta, known) => ({
    meta: { ...OFF, ...((await request(meta.get("sync"))) || {}) },
    known: (await request(known.getAll())) || [],
  }));
// `meta` replaces the settings; `reset` forgets every known version first;
// `put` and `del` change single chats' known versions.
export const saveSyncState = (account, { meta, reset = false, put = [], del = [] }) =>
  tx(account, "readwrite", async (m, known) => {
    if (reset) await request(known.clear());
    for (const id of del) await request(known.delete(id));
    for (const k of put) await request(known.put({ id: k.id, v: k.v, iv: k.iv }));
    if (meta) await request(m.put({ ...OFF, ...meta }, "sync"));
  });

// What src/vault-sync.js reads and writes on this device: the vault's
// sealed records and the sync state above.
export function localSyncStore(account) {
  return {
    records: () => listRecords(account),
    get: (ids) => getRecords(account, ids),
    put: (records) => putRecords(account, records),
    remove: async (ids) => {
      for (const id of ids) await deleteRecord(account, id);
    },
    exclusive: (fn) => exclusive(account, fn),
    loadState: () => loadSyncState(account),
    saveState: (change) => saveSyncState(account, change),
  };
}
