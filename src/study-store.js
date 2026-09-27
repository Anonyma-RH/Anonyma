// Study Mode's storage: one IndexedDB database per account in this browser
// ("anonyma-study:<account>"), holding decks with their review progress and
// the review log behind streaks (days and counts, nothing else). Nothing
// here is sent anywhere. It isn't encrypted: anyone using this browser
// profile can read it, like a downloaded file. Panic Wipe clears it with the
// rest of this browser's ANONYMA data (src/panic-wipe.js).
const VERSION = 1;
const dbName = (account) => "anonyma-study:" + account;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function openDb(account) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined")
      return reject(new Error("This browser can't store decks."));
    const req = indexedDB.open(dbName(account), VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("decks"))
        db.createObjectStore("decks", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Close other ANONYMA tabs and try again."));
  });
}
async function withStore(account, name, mode, run) {
  const db = await openDb(account);
  try {
    const tx = db.transaction([name], mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Deck storage was interrupted."));
    });
    const result = await run(tx.objectStore(name));
    await done;
    return result;
  } finally {
    db.close();
  }
}

export const listDecks = (account) =>
  withStore(account, "decks", "readonly", (s) => request(s.getAll())).then((list) =>
    (list || []).sort((a, b) => (b.updated || 0) - (a.updated || 0)),
  );
export const putDeck = (account, deck) =>
  withStore(account, "decks", "readwrite", (s) => request(s.put(deck)));
export const deleteDeck = (account, id) =>
  withStore(account, "decks", "readwrite", (s) => request(s.delete(id)));
export const loadLog = (account) =>
  withStore(account, "meta", "readonly", (s) => request(s.get("log"))).then(
    (v) => v || { days: {} },
  );
export const saveLog = (account, log) =>
  withStore(account, "meta", "readwrite", (s) => request(s.put(log, "log")));
// Every deck and the review log for this account, in this browser.
export function deleteAllDecks(account) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return resolve();
    const req = indexedDB.deleteDatabase(dbName(account));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
