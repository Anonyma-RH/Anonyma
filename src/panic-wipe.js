// Panic Wipe, the browser's side: the confirm dialog's lists and clearing
// what ANONYMA keeps in this browser once the server has wiped the account
// (server/routes/wipe.js). No DOM or React here, so tests can run it with
// stand-in storage.

export const WIPE_WORD = "WIPE";
export const WIPED_PATH = "/wiped";

// Plain words for the confirm dialog, kept in step with the server.
export const WIPE_GOES = [
  "All your chats and messages, including Symposium runs, branches and share links",
  "Saved images, videos and audio, and the files themselves",
  "Saved uploads and video jobs",
  "Memory facts, Scrolls and standing instructions",
  "Routines and their inbox",
  "Collabs you own, with everything shared in them",
  "Support requests you sent while signed in",
  "API keys and connected apps, revoked",
  "Every sign-in, on every device, including this one",
  "Unsent drafts and everything ANONYMA keeps in this browser, such as Device Vault chats, Veil words, recent searches and the offline copy",
];
export const WIPE_STAYS = [
  "Your account and every credit in it",
  "Your ledger, deposits and receipts",
  "Your settings, such as spending limits and auto-delete",
  "What you wrote in other people’s collabs. You leave those collabs.",
  "The records the data-controls guide says are always kept",
  "Your language choice in this browser",
];

const LANGUAGE_KEY = "anonyma.lang";
// A wallet payment this browser sent and is still confirming
// (WalletPayPanel in AccountFlows.jsx keeps its hash until it's credited).
export function walletPaymentPending(storage, userId) {
  try {
    const list = JSON.parse(
      storage?.getItem("anonyma:walletPending:" + (userId || "")) || "[]",
    );
    return Array.isArray(list) && list.length > 0;
  } catch {
    return false;
  }
}

// Clears localStorage, sessionStorage, IndexedDB, the service worker's caches
// and its registration for this origin, which is ANONYMA's alone. Only the
// language choice is put back. Every step is best effort: a browser that
// refuses one still gets the rest.
export async function clearBrowserData({
  local = globalThis.localStorage,
  session = globalThis.sessionStorage,
  idb = globalThis.indexedDB,
  cacheStorage = globalThis.caches,
  serviceWorker = globalThis.navigator?.serviceWorker,
} = {}) {
  let language = null;
  try {
    language = local?.getItem(LANGUAGE_KEY);
  } catch {}
  try {
    local?.clear();
  } catch {}
  try {
    if (language === "zh" || language === "en")
      local?.setItem(LANGUAGE_KEY, language);
  } catch {}
  try {
    session?.clear();
  } catch {}
  try {
    const list = (await idb?.databases?.()) || [];
    await Promise.all(
      list
        .filter((d) => d?.name)
        .map(
          (d) =>
            new Promise((done) => {
              const r = idb.deleteDatabase(d.name);
              if (!r) return done();
              r.onsuccess = r.onerror = r.onblocked = () => done();
            }),
        ),
    );
  } catch {}
  try {
    const names = (await cacheStorage?.keys()) || [];
    await Promise.all(names.map((n) => cacheStorage.delete(n)));
  } catch {}
  try {
    const regs = (await serviceWorker?.getRegistrations?.()) || [];
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {}
}
