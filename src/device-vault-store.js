// Device Vault's storage: one IndexedDB database per account in this browser,
// holding the vault's settings ("meta": salt, iteration count, verifier, idle
// lock) and sealed chats ({ id, iv, ct }). Nothing here is ever sent anywhere
// and nothing readable is stored: see src/device-vault.js for the crypto.
const VERSION = 1;
const dbName = (account) => "anonyma-vault:" + account;
// Vault Sync's own bookkeeping (src/vault-sync-store.js): which version of
// each chat was last synced. Deleted with the vault.
export const syncDbName = (account) => "anonyma-vault-sync:" + account;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function openDb(account) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined")
      return reject(new Error("This browser can't store a vault."));
    const req = indexedDB.open(dbName(account), VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("chats"))
        db.createObjectStore("chats", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Close other ANONYMA tabs and try again."));
  });
}
async function withStores(account, names, mode, run) {
  const db = await openDb(account);
  try {
    const tx = db.transaction(names, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Vault storage was interrupted."));
    });
    const result = await run(...names.map((n) => tx.objectStore(n)));
    await done;
    return result;
  } finally {
    db.close();
  }
}

export const loadMeta = (account) =>
  withStores(account, ["meta"], "readonly", (meta) => request(meta.get("vault"))).then(
    (m) => m || null,
  );
export const saveMeta = (account, value) =>
  withStores(account, ["meta"], "readwrite", (meta) => request(meta.put(value, "vault")));
export const listRecords = (account) =>
  withStores(account, ["chats"], "readonly", (chats) => request(chats.getAll()));
// Only these records (missing ones are left out).
export const getRecords = (account, ids) =>
  withStores(account, ["chats"], "readonly", async (chats) => {
    const found = [];
    for (const id of ids) {
      const r = await request(chats.get(id));
      if (r) found.push(r);
    }
    return found;
  });
export const putRecords = (account, records) =>
  withStores(account, ["chats"], "readwrite", async (chats) => {
    for (const r of records) await request(chats.put({ id: r.id, iv: r.iv, ct: r.ct }));
  });
export const deleteRecord = (account, id) =>
  withStores(account, ["chats"], "readwrite", (chats) => request(chats.delete(id)));
// A whole vault in one transaction: its settings and every record.
export const replaceVault = (account, value, records) =>
  withStores(account, ["meta", "chats"], "readwrite", async (meta, chats) => {
    await request(chats.clear());
    for (const r of records) await request(chats.put({ id: r.id, iv: r.iv, ct: r.ct }));
    await request(meta.put(value, "vault"));
  });
function deleteDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
export async function deleteVault(account) {
  await deleteDb(dbName(account));
  await deleteDb(syncDbName(account));
}

// One writer at a time: this tab's saves and Vault Sync's changes take
// turns, and so do other tabs of the same account where the browser offers
// Web Locks. Never nest: a call inside `fn` would wait for itself.
const chains = new Map();
export function exclusive(account, fn) {
  const locks = globalThis.navigator?.locks;
  if (locks?.request) return locks.request("anonyma-vault-write:" + account, () => fn());
  const run = (chains.get(account) || Promise.resolve()).then(fn, fn);
  chains.set(account, run.catch(() => {}));
  return run;
}
