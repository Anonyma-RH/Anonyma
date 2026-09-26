// Device Vault's storage: one IndexedDB database per account in this browser,
// holding the vault's settings ("meta": salt, iteration count, verifier, idle
// lock) and sealed chats ({ id, iv, ct }). Nothing here is ever sent anywhere
// and nothing readable is stored: see src/device-vault.js for the crypto.
const VERSION = 1;
const dbName = (account) => "anonyma-vault:" + account;

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
export function deleteVault(account) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbName(account));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
