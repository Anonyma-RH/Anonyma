// Slides' storage in this browser: decks made off the record or in Private
// Mode, which never reach ANONYMA's servers. One IndexedDB database per
// account in this browser ("anonyma-slides:<account>"), holding each deck
// (title, theme, slides, dates, and whether it was made in Private Mode).
// Nothing here is sent anywhere. It isn't encrypted: anyone using this
// browser profile can read it, like a downloaded file. Panic Wipe clears it
// with the rest of this browser's ANONYMA data (src/panic-wipe.js).
const VERSION = 1;
const dbName = (account) => "anonyma-slides:" + account;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function openDb(account) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("This browser can't store slide decks."));
    const req = indexedDB.open(dbName(account), VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("decks")) db.createObjectStore("decks", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Close other ANONYMA tabs and try again."));
  });
}
async function withStore(account, mode, run) {
  const db = await openDb(account);
  try {
    const tx = db.transaction(["decks"], mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Deck storage was interrupted."));
    });
    const result = await run(tx.objectStore("decks"));
    await done;
    return result;
  } finally {
    db.close();
  }
}

export const listLocalDecks = (account) =>
  withStore(account, "readonly", (s) => request(s.getAll())).then((list) =>
    (list || []).sort((a, b) => (b.updated || 0) - (a.updated || 0)),
  );
export const getLocalDeck = (account, id) => withStore(account, "readonly", (s) => request(s.get(id)));
export const putLocalDeck = (account, deck) => withStore(account, "readwrite", (s) => request(s.put(deck)));
export const deleteLocalDeck = (account, id) => withStore(account, "readwrite", (s) => request(s.delete(id)));
