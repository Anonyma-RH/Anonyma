import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  createVault,
  unlockVault,
  openChat,
  sealChat,
  vaultChat,
  keyOpensVerifier,
  fromBase64,
  VaultError,
  VAULT_ERRORS,
  VAULT_ITERATIONS,
  SALT_BYTES,
  IV_BYTES,
} from "../src/device-vault.js";
import {
  decoyReleased,
  DECOY_LIMITS,
  DECOY_ERRORS,
  openEither,
  standInSlot,
  validSlot,
  createDecoy,
  decoyProblem,
} from "../src/decoy-vault.js";
import { sampleChats } from "../src/decoy-samples.js";
import { syncVault } from "../src/vault-sync.js";
import { altStore, vaultDbNames } from "../src/device-vault-store.js";
import { clearBrowserData } from "../src/panic-wipe.js";

// Decoy Vault: a second passphrase that opens a separate, harmless vault
// instead of the real one. These tests cover the crypto on Node's WebCrypto
// (both stores open with their own passphrase, nothing crosses, the KDF work
// is identical whichever passphrase is typed), then the real Device Vault
// hook driven against an in-memory IndexedDB (unlocking, saving, locking,
// setting and removing the decoy, Vault Sync ignoring it, deleting and
// wiping both), then the screens rendered for the decoy and for a real vault
// side by side (no markers), the release gate and the Chinese copy.
//
// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const src = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const han = /\p{Script=Han}/u;
const REAL = "correct horse battery staple";
const DECOY = "blue kettle on a quiet sunday";
const OTHER = "a different vault passphrase";
const rejectsWith = (promise, code) =>
  assert.rejects(promise, (e) => e instanceof VaultError && e.code === code);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const realChat = (id, text) =>
  vaultChat({
    id,
    mode: "chat",
    privateMode: false,
    messages: [
      { role: "user", content: text, images: [] },
      { role: "assistant", content: "Noted: " + text, model: "m" },
    ],
    veil: null,
    created: 1000,
    now: 2000,
  });

// ---------------------------------------------------------------------------
// Crypto: two independent stores, equal work
// ---------------------------------------------------------------------------

test("both passphrases unlock their own store, and a wrong one opens neither", async () => {
  const { meta: main, key: realKey } = await createVault(REAL);
  const secret = await sealChat(realKey, realChat(crypto.randomUUID(), "Meet the lawyer at nine"));
  const decoy = await createDecoy(main, DECOY, { model: "google/gemini-2.5-flash" });
  assert.equal(decoy.records.length, 4);

  const r = await openEither({ main, alt: decoy.meta }, REAL);
  assert.equal(r.slot, "main");
  assert.equal(r.meta, main);
  assert.equal((await openChat(r.key, secret)).messages[0].content, "Meet the lawyer at nine");

  const d = await openEither({ main, alt: decoy.meta }, DECOY);
  assert.equal(d.slot, "alt");
  assert.equal(d.meta, decoy.meta);
  const opened = [];
  for (const rec of decoy.records) opened.push(await openChat(d.key, rec));
  assert.deepEqual(opened, decoy.chats);

  for (const wrong of [OTHER, REAL + " ", DECOY.toUpperCase(), ""]) {
    await rejectsWith(openEither({ main, alt: decoy.meta }, wrong), "wrong_passphrase");
  }
  // Without a decoy, the decoy's passphrase is just a wrong one.
  await rejectsWith(openEither({ main }, DECOY), "wrong_passphrase");
  assert.equal((await openEither({ main }, REAL)).slot, "main");
  // A damaged decoy never stops the real vault opening: it's left out.
  const broken = { ...decoy.meta, kdf: { ...decoy.meta.kdf, iterations: 5 } };
  assert.equal(validSlot(broken), false);
  assert.equal((await openEither({ main, alt: broken }, REAL)).slot, "main");
  await rejectsWith(openEither({ main, alt: broken }, DECOY), "wrong_passphrase");
});

test("no cross-leak: neither vault's key opens the other's verifier or chats", async () => {
  const { meta: main, key: realKey } = await createVault(REAL);
  const secrets = [realChat(crypto.randomUUID(), "Meet the lawyer at nine"), realChat(crypto.randomUUID(), "Account 4471")];
  const realRecords = [];
  for (const c of secrets) realRecords.push(await sealChat(realKey, c));
  const decoy = await createDecoy(main, DECOY);
  // Separate salts, verifiers and keys.
  assert.notEqual(decoy.meta.kdf.salt, main.kdf.salt);
  assert.notDeepEqual(decoy.meta.verifier, main.verifier);
  assert.equal(await keyOpensVerifier(realKey, decoy.meta.verifier), false);
  assert.equal(await keyOpensVerifier(decoy.key, main.verifier), false);
  for (const rec of decoy.records) await rejectsWith(openChat(realKey, rec), "damaged");
  for (const rec of realRecords) await rejectsWith(openChat(decoy.key, rec), "damaged");
  // The decoy holds none of the real vault's words, ids or ciphertext.
  const decoyText = JSON.stringify(decoy);
  for (const c of secrets) {
    assert.ok(!decoyText.includes(c.id));
    assert.ok(!decoyText.includes(c.messages[0].content));
  }
  for (const rec of realRecords) assert.ok(!decoyText.includes(rec.ct.slice(0, 40)));
  // Its records are sealed like any vault's: only the id is readable.
  for (const rec of decoy.records) {
    assert.deepEqual(Object.keys(rec).sort(), ["ct", "id", "iv"]);
    const raw = Buffer.from(fromBase64(rec.ct)).toString("latin1");
    for (const c of decoy.chats) assert.ok(!raw.includes(c.messages[0].content.slice(0, 12)));
  }
  // The decoy passphrase must differ from the vault's.
  assert.equal(decoyProblem(REAL, REAL), DECOY_ERRORS.same);
  assert.equal(decoyProblem(REAL.normalize("NFD"), REAL.normalize("NFC")), DECOY_ERRORS.same);
  assert.match(decoyProblem("short", REAL), /at least 10 characters/);
  assert.equal(decoyProblem(DECOY, REAL), null);
});

test("equal KDF parameters: every unlock derives two keys with the same settings, whichever passphrase", async (t) => {
  const { meta: main } = await createVault(REAL);
  const decoy = await createDecoy(main, DECOY);
  // The decoy copies the real vault's KDF and idle lock; only the salt differs.
  assert.deepEqual({ ...decoy.meta.kdf, salt: 0 }, { ...main.kdf, salt: 0 });
  assert.equal(fromBase64(decoy.meta.kdf.salt).length, fromBase64(main.kdf.salt).length);
  assert.equal(fromBase64(decoy.meta.verifier.ct).length, fromBase64(main.verifier.ct).length);
  assert.equal(decoy.meta.idleMinutes, main.idleMinutes);
  // Even a real vault with a stronger (imported) iteration count.
  const strong = await createVault(REAL, { iterations: VAULT_ITERATIONS + 1000, idleMinutes: 60 });
  const strongDecoy = await createDecoy(strong.meta, DECOY);
  assert.equal(strongDecoy.meta.kdf.iterations, VAULT_ITERATIONS + 1000);
  assert.equal(strongDecoy.meta.idleMinutes, 60);
  // Without a decoy, a stand-in of the same shape takes its place.
  const stand = standInSlot(main);
  assert.deepEqual({ ...stand.kdf, salt: 0 }, { ...main.kdf, salt: 0 });
  assert.equal(fromBase64(stand.kdf.salt).length, SALT_BYTES);
  assert.equal(fromBase64(stand.verifier.iv).length, IV_BYTES);
  assert.equal(fromBase64(stand.verifier.ct).length, fromBase64(main.verifier.ct).length);
  assert.notEqual(standInSlot(main).kdf.salt, stand.kdf.salt);

  // Count the work: the same derivations and verifier checks every time.
  const subtle = globalThis.crypto.subtle;
  const derive = subtle.deriveKey.bind(subtle),
    decrypt = subtle.decrypt.bind(subtle);
  let log = [];
  subtle.deriveKey = (algo, ...rest) => {
    log.push(`derive ${algo.name} ${algo.hash} ${algo.iterations} ${algo.salt.length}`);
    return derive(algo, ...rest);
  };
  subtle.decrypt = (algo, ...rest) => {
    log.push(`check ${algo.name} ${algo.iv.length}`);
    return decrypt(algo, ...rest);
  };
  t.after(() => {
    delete subtle.deriveKey;
    delete subtle.decrypt;
  });
  const work = async (slots, pass) => {
    log = [];
    await openEither(slots, pass).catch(() => {});
    return log.sort().join("\n");
  };
  const expected = await work({ main, alt: decoy.meta }, REAL);
  assert.equal(expected.split("\n").filter((l) => l.startsWith("derive")).length, 2);
  assert.equal(expected.split("\n").filter((l) => l.startsWith("check")).length, 2);
  assert.equal(await work({ main, alt: decoy.meta }, DECOY), expected, "decoy passphrase");
  assert.equal(await work({ main, alt: decoy.meta }, OTHER), expected, "wrong passphrase");
  assert.equal(await work({ main }, REAL), expected, "no decoy set");
  assert.equal(await work({ main }, OTHER), expected, "no decoy, wrong passphrase");
});

test("a decoy starts with ordinary chats saved like any other, in the app's language", () => {
  const now = Date.UTC(2026, 8, 29, 12);
  const en = sampleChats({ now, model: "google/gemini-2.5-flash" });
  assert.equal(en.length, 4);
  assert.deepEqual(en.map((c) => c.title), [
    "What can I cook tonight with eggs, spinach and a bit of feta?",
    "Help me write a short message to my landlord about a dripping kitchen tap.",
    "Make me a packing list for a long weekend by the sea.",
    "How often should I water tomato plants on a balcony?",
  ]);
  for (const c of en) {
    assert.match(c.id, UUID, "ids like a real vault chat's");
    assert.equal(c.mode, "chat");
    assert.equal(c.private, false);
    assert.ok(c.updated < now && c.created < c.updated);
    assert.ok(now - c.updated < 20 * 86400000);
    assert.equal(c.messages.length, 2);
    assert.equal(c.messages[1].model, "google/gemini-2.5-flash");
    // Not marked in any way: vaultChat keeps them, and nothing names them.
    assert.ok(c.messages.every((m) => !("sample" in m)));
    assert.deepEqual(vaultChat({ ...c, privateMode: c.private, now: c.updated }), c);
    assert.doesNotMatch(JSON.stringify(c), /decoy|sample|example|demo/i);
  }
  // Spread over the past weeks, newest first as listed.
  const times = en.map((c) => c.updated);
  assert.deepEqual([...times].sort((a, b) => b - a), times);
  assert.ok(times[0] - times[3] > 10 * 86400000);
  assert.equal(new Set(sampleChats({ now }).map((c) => c.id)).size, 4);
  // In Chinese when the app is shown in Chinese; English otherwise.
  const zh = sampleChats({ lang: "zh", now });
  assert.ok(zh.every((c) => han.test(c.title) && han.test(c.messages[1].content)));
  assert.ok(zh.every((c) => !("model" in c.messages[1])), "no model when none is picked");
  assert.deepEqual(sampleChats({ lang: "xx", now }).map((c) => c.title), en.map((c) => c.title));
  assert.doesNotMatch(JSON.stringify(zh), /诱饵|示例|演示/);
});

// ---------------------------------------------------------------------------
// The hook, against an in-memory IndexedDB
// ---------------------------------------------------------------------------

// Just enough of IndexedDB for src/device-vault-store.js and
// src/vault-sync-store.js: databases of object stores, requests that answer
// on a later tick and transactions that complete once idle.
function fakeIndexedDB() {
  const dbs = new Map();
  const opened = [];
  const later = (fn) => setTimeout(fn, 0);
  const connect = (name, rec) => ({
    objectStoreNames: { contains: (n) => rec.stores.has(n) },
    createObjectStore: (n, opts = {}) => rec.stores.set(n, { keyPath: opts.keyPath || null, data: new Map() }),
    close() {},
    transaction(names, mode) {
      let pending = 0,
        done = false;
      const tx = {};
      const settle = () =>
        later(() => {
          if (!done && pending === 0) {
            done = true;
            tx.oncomplete?.();
          }
        });
      tx.objectStore = (n) => {
        if (![].concat(names).includes(n)) throw new Error("NotFoundError");
        const s = rec.stores.get(n);
        const op = (fn, write) => {
          if (write && mode !== "readwrite") throw new Error("ReadOnlyError");
          pending++;
          const req = {};
          later(() => {
            pending--;
            try {
              req.result = fn();
              req.onsuccess?.();
            } catch (e) {
              req.error = e;
              req.onerror?.();
            }
            settle();
          });
          return req;
        };
        return {
          get: (k) => op(() => structuredClone(s.data.get(k))),
          getAll: () => op(() => [...s.data.values()].map((v) => structuredClone(v))),
          put: (v, k) => op(() => s.data.set(s.keyPath ? v[s.keyPath] : k, structuredClone(v)), true),
          delete: (k) => op(() => void s.data.delete(k), true),
          clear: () => op(() => s.data.clear(), true),
        };
      };
      settle();
      return tx;
    },
  });
  return {
    dbs,
    opened,
    open(name) {
      opened.push(name);
      const req = {};
      later(() => {
        let rec = dbs.get(name);
        const fresh = !rec;
        if (fresh) dbs.set(name, (rec = { stores: new Map() }));
        req.result = connect(name, rec);
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
    deleteDatabase(name) {
      const req = {};
      later(() => {
        dbs.delete(name);
        req.onsuccess?.();
      });
      return req;
    },
    databases: async () => [...dbs.keys()].map((name) => ({ name })),
    // What a database holds: { store: [values] }.
    dump: (name) =>
      Object.fromEntries([...(dbs.get(name)?.stores || [])].map(([n, s]) => [n, [...s.data.values()]])),
  };
}

// A React stand-in that runs one hook: state, refs and effects, re-rendered
// on demand. Enough to drive useDeviceVault and useVaultSync as the
// workspace does, without a DOM.
const REACT_STUB = `
let cur = null;
export function useState(init) {
  const c = cur, i = c.i++;
  if (!(i in c.hooks)) c.hooks[i] = typeof init === "function" ? init() : init;
  return [c.hooks[i], (v) => {
    const next = typeof v === "function" ? v(c.hooks[i]) : v;
    if (!Object.is(next, c.hooks[i])) { c.hooks[i] = next; c.dirty = true; }
  }];
}
export function useRef(v) {
  const c = cur, i = c.i++;
  if (!(i in c.hooks)) c.hooks[i] = { current: v };
  return c.hooks[i];
}
export function useEffect(fn, deps) {
  const c = cur, i = c.i++;
  const prev = c.hooks[i];
  if (prev && deps && deps.length === prev.deps.length && deps.every((d, j) => Object.is(d, prev.deps[j]))) return;
  c.hooks[i] = { deps: deps || [], cleanup: prev?.cleanup };
  c.effects.push(() => {
    c.hooks[i].cleanup?.();
    const r = fn();
    c.hooks[i].cleanup = typeof r === "function" ? r : null;
  });
}
export const useLayoutEffect = useEffect;
export const useMemo = (fn) => fn();
export const useCallback = (fn) => fn;
export const useSyncExternalStore = (s, get) => get();
export default { createElement: () => null, Fragment: "fragment" };
export function mount(hook, props) {
  const c = { hooks: [], i: 0, effects: [], dirty: false, props, value: null };
  const render = () => {
    cur = c; c.i = 0; c.effects = []; c.dirty = false;
    c.value = hook(c.props);
    cur = null;
    for (const e of c.effects.splice(0)) e();
  };
  render();
  return {
    get value() { return c.value; },
    flush() { for (let n = 0; c.dirty && n < 50; n++) render(); return c.value; },
    rerender(p) { c.props = { ...c.props, ...p }; render(); return this.flush(); },
    async until(pred, ms = 30000) {
      const end = Date.now() + ms;
      for (;;) {
        this.flush();
        if (pred(c.value)) return c.value;
        if (Date.now() > end) throw new Error("timed out waiting for the hook");
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    unmount() { for (const h of c.hooks) if (h && typeof h.cleanup === "function") h.cleanup(); },
  };
}`;

// Every server call the Vault Sync hook makes, answered from `server`.
const LIB_STUB = `
export const calls = [];
export const server = { vault: null };
export async function api(path, opts = {}) {
  calls.push((opts.method || "GET") + " " + path);
  if (path === "/api/vault-sync" && !opts.method) return { vault: server.vault, limits: { bytes: 52428800, recordBytes: 4194304 } };
  throw Object.assign(new Error("not in this test"), { status: 500 });
}`;

// DeviceVault.jsx and VaultSync.jsx, transformed for Node. `hooks`: with the
// React stand-in (and the server stubbed) to run the hooks; otherwise with
// React itself to render the screens.
async function loadVault({ hooks }) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-decoy-"));
  const react = hooks ? pathToFileURL(join(dir, "react.mjs")).href : import.meta.resolve("react");
  writeFileSync(join(dir, "react.mjs"), REACT_STUB);
  writeFileSync(join(dir, "lib.mjs"), LIB_STUB);
  writeFileSync(
    join(dir, "ui.mjs"),
    `import React from "${react}";
     export const Icon = () => React.createElement("svg");
     export const Button = ({ children, secondary, ...rest }) => React.createElement("button", rest, children);
     export const Notice = ({ children }) => React.createElement("div", null, children);
     export const Modal = ({ title, children }) => React.createElement("div", { className: "modal" }, React.createElement("h2", null, title), children);`,
  );
  const load = async (name, extra = (c) => c) => {
    const file = new URL("../src/" + name, import.meta.url);
    const { code } = await transformWithEsbuild(readFileSync(file, "utf8"), file.pathname, { jsx: "transform", format: "esm" });
    const out = extra(code)
      .replace(/^import "\.\/[\w-]+\.css";$/gm, "")
      .replace(/from "\.\/ui\.jsx"/g, `from "${pathToFileURL(join(dir, "ui.mjs")).href}"`)
      .replace(/from "\.\/([\w-]+)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
      .replace(/from "react"/g, `from "${react}"`);
    const mod = join(dir, name.replace(/\.jsx$/, ".mjs"));
    writeFileSync(mod, out);
    return pathToFileURL(mod).href;
  };
  try {
    const libStub = pathToFileURL(join(dir, "lib.mjs")).href;
    const sync = await load("VaultSync.jsx", (c) => (hooks ? c.replace(/from "\.\/lib\.js"/, `from "${libStub}"`) : c));
    const vault = await import(await load("DeviceVault.jsx", (c) => c.replace(/from "\.\/VaultSync\.jsx"/g, `from "${sync}"`)));
    return {
      ...vault,
      sync: await import(sync),
      react: hooks ? await import(react) : null,
      lib: hooks ? await import(libStub) : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const idb = fakeIndexedDB();
const listeners = { addEventListener() {}, removeEventListener() {} };
globalThis.indexedDB = idb;
globalThis.window ??= listeners;
globalThis.document ??= { ...listeners, visibilityState: "visible" };
let H;
const hooked = async () => (H ??= await loadVault({ hooks: true }));
// Every hook mounted here, locked and unmounted at the end even when a test
// fails, so no idle timer or sync interval keeps the process alive.
const mounted = [];
after(() => {
  for (const m of mounted.splice(0)) {
    try {
      m.value?.lock?.();
      m.unmount();
    } catch {}
  }
});
const mountHook = (hook, props) => {
  const m = H.react.mount(hook, props);
  mounted.push(m);
  return m;
};
// A signed-in account's vault in this browser, as the workspace wires it.
async function vaultFor(account, { decoy = true } = {}) {
  const { useDeviceVault } = await hooked();
  const locks = [];
  const h = mountHook(useDeviceVault, { enabled: true, account, onLock: (r) => locks.push(r), decoy });
  await h.until((v) => !["off", "loading"].includes(v.status));
  return Object.assign(h, { locks });
}
const main = (account) => idb.dump("anonyma-vault:" + account);
const alt = (account) => idb.dump("anonyma-vault:" + altStore(account));

test("the hook opens whichever vault the passphrase belongs to, and reads and writes only that one", async () => {
  const h = await vaultFor("u-open");
  assert.equal(h.value.status, "none");
  await h.value.create(REAL, 15);
  let v = h.flush();
  assert.equal(v.unlocked, true);
  assert.equal(v.syncable, true);
  assert.deepEqual(v.decoy, { ...v.decoy, live: true, set: false });
  const secret = realChat(crypto.randomUUID(), "Meet the lawyer at nine");
  await v.save(secret);
  v = h.flush();
  // Set the decoy: it needs this vault's passphrase, and a different one.
  await rejectsWith(v.decoy.save(DECOY, OTHER), "wrong_passphrase");
  await rejectsWith(v.decoy.save(REAL, REAL), "decoy_passphrase");
  await v.decoy.save(DECOY, REAL, { lang: "en", model: "google/gemini-2.5-flash" });
  v = h.flush();
  assert.equal(v.decoy.set, true);
  assert.equal(v.chats.length, 1, "the real vault is unchanged");
  assert.equal(main("u-open").chats.length, 1);
  assert.equal(alt("u-open").chats.length, 4);
  assert.equal(alt("u-open").meta[0].kdf.iterations, main("u-open").meta[0].kdf.iterations);

  // Lock, then unlock with the decoy's passphrase: the decoy's chats only.
  v.lock();
  v = h.flush();
  assert.equal(v.status, "locked");
  await v.unlock(DECOY);
  v = h.flush();
  assert.equal(v.status, "unlocked");
  assert.equal(v.chats.length, 4);
  assert.ok(!v.chats.some((c) => c.id === secret.id));
  assert.equal(v.damaged, 0);
  assert.equal(v.decoy.set, false, "the decoy never says a decoy is set");
  assert.equal(v.syncable, false);
  assert.equal(v.meta.kdf.salt, alt("u-open").meta[0].kdf.salt);
  // A chat written inside the decoy stays in the decoy.
  const written = realChat(crypto.randomUUID(), "Groceries for Saturday");
  await v.save(written);
  v = h.flush();
  assert.equal(v.chats.length, 5);
  assert.equal(alt("u-open").chats.length, 5);
  assert.equal(main("u-open").chats.length, 1);
  await v.remove(v.chats.find((c) => c.id !== written.id).id);
  v = h.flush();
  assert.equal(alt("u-open").chats.length, 4);
  assert.equal(main("u-open").chats.length, 1);
  // The idle lock setting is the open vault's own.
  await v.setIdle(5);
  assert.equal(alt("u-open").meta[0].idleMinutes, 5);
  assert.equal(main("u-open").meta[0].idleMinutes, 15);

  // Locking goes back to the real vault's settings, so the real passphrase
  // still opens the real vault, with nothing from the decoy in it.
  h.flush().lock("idle");
  v = h.flush();
  assert.deepEqual(h.locks, ["manual", "idle"]);
  assert.equal(v.meta.kdf.salt, main("u-open").meta[0].kdf.salt);
  await v.unlock(REAL);
  v = h.flush();
  assert.deepEqual(v.chats.map((c) => c.id), [secret.id]);
  assert.equal(v.decoy.set, true);
  assert.equal(v.syncable, true);
  // A wrong passphrase opens neither.
  v.lock();
  await rejectsWith(h.flush().unlock(OTHER), "wrong_passphrase");
  assert.equal(h.flush().status, "locked");
  h.unmount();
});

test("changing or removing the decoy needs the real vault's passphrase; inside the decoy nothing changes", async () => {
  const h = await vaultFor("u-manage");
  await h.value.create(REAL, 15);
  await h.flush().decoy.save(DECOY, REAL);
  const first = alt("u-manage");
  let v = h.flush();
  v.lock();
  await h.flush().unlock(DECOY);
  v = h.flush();
  // Inside the decoy: a wrong passphrase is told apart first, as anywhere;
  // the real one doesn't open *this* vault; the decoy's own is refused.
  await rejectsWith(v.decoy.save("another decoy words", OTHER), "wrong_passphrase");
  await rejectsWith(v.decoy.save("another decoy words", REAL), "wrong_passphrase");
  await assert.rejects(v.decoy.save("another decoy words", DECOY), (e) => e.code === "decoy_here" && e.message === DECOY_ERRORS.here);
  await rejectsWith(v.decoy.remove(DECOY), "decoy_here");
  await rejectsWith(v.decoy.remove(REAL), "wrong_passphrase");
  assert.deepEqual(alt("u-manage").meta, first.meta, "nothing was changed");
  assert.equal(alt("u-manage").chats.length, 4);
  v.lock();
  await h.flush().unlock(REAL);
  v = h.flush();
  // Change: a new passphrase and fresh sample chats; the old one stops working.
  await rejectsWith(v.decoy.save("newer decoy words", DECOY), "wrong_passphrase");
  await v.decoy.save("newer decoy words", REAL);
  assert.notEqual(alt("u-manage").meta[0].kdf.salt, first.meta[0].kdf.salt);
  v.lock();
  await rejectsWith(h.flush().unlock(DECOY), "wrong_passphrase");
  await h.flush().unlock("newer decoy words");
  assert.equal(h.flush().syncable, false);
  h.flush().lock();
  await h.flush().unlock(REAL);
  // Remove: only with the real passphrase; the decoy's database goes.
  await rejectsWith(h.flush().decoy.remove("newer decoy words"), "wrong_passphrase");
  await h.flush().decoy.remove(REAL);
  assert.equal(h.flush().decoy.set, false);
  assert.ok(!idb.dbs.has("anonyma-vault:" + altStore("u-manage")));
  h.flush().lock();
  await rejectsWith(h.flush().unlock("newer decoy words"), "wrong_passphrase");
  h.unmount();
});

test("Vault Sync ignores the decoy: no key, no sync, no remote changes, and sync shows as off", async () => {
  const h = await vaultFor("u-sync");
  await h.value.create(REAL, 15);
  await h.flush().decoy.save(DECOY, REAL);
  const realKey = h.flush().key();
  assert.ok(realKey, "the real vault gives Vault Sync its key");
  h.flush().lock();
  await h.flush().unlock(DECOY);
  let v = h.flush();
  // The decoy's key is never handed out, re-keying is refused, and a sync
  // that finishes meanwhile never adds the real vault's chats to it.
  assert.throws(() => v.key(), (e) => e.code === "locked");
  await rejectsWith(v.rekey(v.meta, realKey), "locked");
  const before = v.chats.map((c) => c.id);
  v.applyRemote([realChat(crypto.randomUUID(), "Synced from my laptop")], []);
  v = h.flush();
  assert.deepEqual(v.chats.map((c) => c.id), before);
  assert.equal(v.remoteChanges.rev, 0);

  // The Vault Sync hook with this vault open: this device syncs the real
  // vault (its state says so), yet nothing is pulled, pushed or changed.
  const { useVaultSync, SYNC_PAUSED } = H.sync;
  const { saveSyncState, loadSyncState } = await import("../src/vault-sync-store.js");
  const salt = main("u-sync").meta[0].kdf.salt;
  await saveSyncState("u-sync", { meta: { enabled: true, vault: "vs_1", salt, cursor: 7, last: 1, reason: null } });
  H.lib.server.vault = { id: "vs_1", records: 3, bytes: 4096, kdf: {}, verifier: {} };
  H.lib.calls.length = 0;
  const s = mountHook(useVaultSync, { enabled: true, account: "u-sync", vault: v });
  await s.until((x) => x.server !== undefined);
  await new Promise((r) => setTimeout(r, 50));
  s.flush();
  s.rerender({ vault: { ...v, rev: 1 } });
  assert.equal(s.value.syncNow(), null);
  await new Promise((r) => setTimeout(r, 1500));
  s.flush();
  assert.ok(H.lib.calls.every((c) => c === "GET /api/vault-sync"), H.lib.calls.join(", "));
  const state = await loadSyncState("u-sync");
  assert.deepEqual(
    { enabled: state.meta.enabled, vault: state.meta.vault, cursor: state.meta.cursor, reason: state.meta.reason },
    { enabled: true, vault: "vs_1", cursor: 7, reason: null },
    "the real vault's sync setting is left alone",
  );
  // It looks like a vault that doesn't sync, and can't be turned on.
  assert.equal(s.value.live, true);
  assert.equal(s.value.on, false);
  assert.equal(s.value.synced, null);
  assert.equal(s.value.server.vault, null);
  await assert.rejects(s.value.turnOn(), (e) => e.message === SYNC_PAUSED);
  await assert.rejects(s.value.join(REAL), (e) => e.message === SYNC_PAUSED);
  await assert.rejects(s.value.forget(), (e) => e.message === SYNC_PAUSED);
  assert.ok(H.lib.calls.every((c) => c === "GET /api/vault-sync"));
  s.unmount();
  // Even if the decoy's key ever reached the sync, it would stop before
  // sending anything: its salt isn't the synced vault's.
  const pushed = [];
  const out = await syncVault({
    key: await unlockVault(v.meta, DECOY),
    meta: v.meta,
    remote: { status: async () => ({ vault: { id: "vs_1", kdf: { salt, iterations: VAULT_ITERATIONS }, verifier: main("u-sync").meta[0].verifier } }), pull: async () => pushed.push("pull"), push: async () => pushed.push("push") },
    local: { loadState: async () => ({ meta: { enabled: true, vault: "vs_1", salt }, known: [] }), saveState: async () => {} },
  });
  assert.equal(out.status, "other_vault");
  assert.deepEqual(pushed, []);
  h.flush().lock();
  h.unmount();
});

test("wipe clears both: deleting the vault, a new vault, Panic Wipe, and nothing is read before release", async () => {
  // "Forgot it? Delete this vault" deletes the decoy with it.
  const h = await vaultFor("u-wipe");
  await h.value.create(REAL, 15);
  await h.flush().decoy.save(DECOY, REAL);
  const names = vaultDbNames("u-wipe");
  assert.deepEqual(names, ["anonyma-vault:u-wipe", "anonyma-vault-sync:u-wipe", "anonyma-vault:u-wipe:b"]);
  assert.ok(idb.dbs.has(names[2]));
  h.flush().lock();
  await h.flush().destroy();
  for (const n of names) assert.ok(!idb.dbs.has(n), n);
  assert.equal(h.flush().status, "none");
  // A decoy left over from a vault lost some other way never outlives a new vault.
  await h.flush().create(REAL, 15);
  await h.flush().decoy.save(DECOY, REAL);
  idb.dbs.delete("anonyma-vault:u-wipe");
  h.flush().lock();
  h.rerender({ account: "someone-else" });
  h.rerender({ account: "u-wipe" });
  await h.until((v) => v.status === "none");
  await h.flush().create(OTHER, 15);
  assert.ok(!idb.dbs.has(names[2]) || !alt("u-wipe").meta?.length);
  h.flush().lock();
  await rejectsWith(h.flush().unlock(DECOY), "wrong_passphrase");
  h.unmount();

  // Panic Wipe clears every database, and names the vault's own even where
  // the browser can't list them.
  const listing = fakeIndexedDB();
  for (const n of [...names, "other"]) listing.open(n);
  await new Promise((r) => setTimeout(r, 10));
  await clearBrowserData({ local: null, session: null, idb: listing, cacheStorage: null, serviceWorker: null });
  assert.equal(listing.dbs.size, 0);
  const unlisted = fakeIndexedDB();
  for (const n of [...names, "other"]) unlisted.open(n);
  await new Promise((r) => setTimeout(r, 10));
  delete unlisted.databases;
  await clearBrowserData({ local: null, session: null, idb: unlisted, cacheStorage: null, serviceWorker: null, names });
  assert.deepEqual([...unlisted.dbs.keys()], ["other"]);
  assert.match(src("src/PanicWipe.jsx"), /await clearBrowserData\(\{ names: user\?\.id \? vaultDbNames\(user\.id\) : \[\] \}\);/);

  // Before release, unlocking never touches the decoy: one derivation, and
  // the decoy's passphrase opens nothing.
  const pre = await vaultFor("u-pre", { decoy: false });
  await pre.value.create(REAL, 15);
  const r = await vaultFor("u-pre2");
  await r.value.create(REAL, 15);
  await r.flush().decoy.save(DECOY, REAL);
  r.flush().lock();
  r.unmount();
  pre.flush().lock();
  pre.unmount();
  const off = await vaultFor("u-pre2", { decoy: false });
  idb.opened.length = 0;
  await rejectsWith(off.value.unlock(DECOY), "wrong_passphrase");
  await off.flush().unlock(REAL);
  assert.ok(!idb.opened.some((n) => n.endsWith(":b")), idb.opened.join(", "));
  assert.equal(off.flush().decoy.live, false);
  assert.equal(off.flush().decoy.set, false);
  off.flush().lock();
  off.unmount();
});

// ---------------------------------------------------------------------------
// The screens: nothing marks the decoy
// ---------------------------------------------------------------------------

const entities = (s) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function textsOf(html) {
  const VOID = new Set(["input", "br", "img", "hr"]);
  const stack = [],
    page = [];
  for (const [, tag, text] of html.matchAll(/(<[^>]+>)|([^<]+)/g)) {
    if (tag) {
      const m = /^<(\/?)([a-z0-9]+)/i.exec(tag);
      if (!m) continue;
      const off = /data-i18n="off"/.test(tag);
      for (const [, attr] of tag.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g))
        if (!off && !stack.some((x) => x.off)) page.push(entities(attr));
      if (m[1]) stack.pop();
      else if (!VOID.has(m[2].toLowerCase()) && !tag.endsWith("/>")) stack.push({ off });
    } else {
      const t = entities(text).trim();
      if (t && !stack.some((x) => x.off)) page.push(t);
    }
  }
  return page.filter((x) => /[A-Za-z]{2}/.test(x));
}

test("the UI shows no decoy markers: the open decoy renders exactly like a real vault without one", async () => {
  // Account A: a real vault with a decoy, open on the decoy. Account B: a
  // real vault without a decoy, holding the very same chats.
  const a = await vaultFor("u-look-a");
  await a.value.create(REAL, 15);
  await a.flush().save(realChat(crypto.randomUUID(), "Meet the lawyer at nine"));
  await a.flush().decoy.save(DECOY, REAL, { lang: "en", model: "m" });
  a.flush().lock();
  await a.flush().unlock(DECOY);
  const decoyOpen = a.flush();
  const b = await vaultFor("u-look-b");
  await b.value.create(OTHER, 15);
  for (const c of [...decoyOpen.chats].reverse()) await b.flush().save(c);
  const realOpen = b.flush();
  assert.deepEqual(realOpen.chats, decoyOpen.chats);
  // Their Vault Sync, as the workspace gets it: paused for the decoy, and
  // simply off for B.
  H.lib.server.vault = null;
  const syncA = mountHook(H.sync.useVaultSync, { enabled: true, account: "u-look-a", vault: decoyOpen });
  const syncB = mountHook(H.sync.useVaultSync, { enabled: true, account: "u-look-b", vault: realOpen });
  await syncA.until((x) => x.server !== undefined);
  await syncB.until((x) => x.server !== undefined && x.local);

  const ui = await loadVault({ hooks: false });
  const noop = () => {};
  const screens = (vault, sync) => {
    const r = (el) => renderToStaticMarkup(el);
    return [
      r(createElement(ui.VaultSection, { vault, currentId: vault.chats[0].id, onOpen: noop, onDialog: noop, sync })),
      r(createElement(ui.VaultDialog, { vault, dialog: { kind: "manage" }, onClose: noop, onUnlocked: noop, sync, sampleModel: "m" })),
      r(createElement(ui.VaultDialog, { vault, dialog: { kind: "delete", chat: vault.chats[1] }, onClose: noop, onUnlocked: noop, sync })),
      r(createElement(ui.DeviceOnlyNotice, { locked: false, synced: sync.on })),
      r(createElement(ui.DeviceOnlyToggle, { active: true, synced: sync.on })),
    ].join("\n");
  };
  const seenDecoy = screens(decoyOpen, syncA.value);
  const seenReal = screens(realOpen, syncB.value);
  assert.equal(seenDecoy, seenReal);
  // The manage dialog offers to set one, as for any vault without a decoy,
  // and the word "decoy" appears only in that shared block.
  assert.match(seenDecoy, /Set a decoy passphrase/);
  assert.doesNotMatch(seenDecoy, /A decoy passphrase is set|Remove decoy|Change decoy passphrase/);
  const withoutBlock = seenDecoy.replace(/<div class="vault-block vault-decoy">[\s\S]*?Set a decoy passphrase<\/button><\/div><\/div>/, "");
  assert.doesNotMatch(withoutBlock, /decoy|诱饵/i);
  // The same when both are locked: one unlock dialog for every vault.
  decoyOpen.lock();
  realOpen.lock();
  const unlockA = renderToStaticMarkup(createElement(ui.VaultDialog, { vault: a.flush(), dialog: { kind: "unlock" }, onClose: noop, onUnlocked: noop }));
  const unlockB = renderToStaticMarkup(createElement(ui.VaultDialog, { vault: b.flush(), dialog: { kind: "unlock" }, onClose: noop, onUnlocked: noop }));
  assert.equal(unlockA, unlockB);
  assert.doesNotMatch(unlockA, /decoy/i);
  // The real vault with a decoy says so, with the honest limits.
  await a.flush().unlock(REAL);
  const own = renderToStaticMarkup(createElement(ui.VaultDialog, { vault: a.flush(), dialog: { kind: "manage" }, onClose: noop, onUnlocked: noop, sync: syncA.value }));
  assert.match(own, /A decoy passphrase is set/);
  assert.match(own, /Remove decoy/);
  for (const line of DECOY_LIMITS) assert.ok(entities(own).includes(line), line);
  // Unreleased: no block at all.
  const pre = renderToStaticMarkup(createElement(ui.VaultDialog, { vault: { ...a.flush(), decoy: { live: false, set: true } }, dialog: { kind: "manage" }, onClose: noop, onUnlocked: noop }));
  assert.doesNotMatch(pre, /decoy/i);
  // Passphrase fields are the person's own words.
  const block = own.slice(own.indexOf('<div class="vault-block vault-decoy">'), own.indexOf("Move to another device"));
  assert.match(block, /Remove decoy/);
  assert.doesNotMatch(block, /type="password"/, "no fields until a button is pressed");
  assert.match(src("src/DeviceVault.jsx"), /<input\s*type="password"\s*data-i18n="off"/);
  a.flush().lock();
  syncA.unmount();
  syncB.unmount();
  a.unmount();
  b.unmount();
});

// ---------------------------------------------------------------------------
// Release gate, wiring and Chinese
// ---------------------------------------------------------------------------

function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-decoy-app-"));
  const svc = createApp({
    testMode: true,
    released: released ?? "all",
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: "http://localhost:5175",
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}

test("Decoy Vault is registered last, off until released, with an icon and honest points", () => {
  const i = UPDATES.findIndex((u) => u.id === "decoy");
  const entry = UPDATES[i];
  assert.ok(entry, "registered");
  assert.equal(UPDATES.filter((u) => u.id === "decoy").length, 1);
  assert.ok(i > UPDATES.findIndex((u) => u.id === "vaultsync"), "after Vault Sync");
  assert.equal(typeof committed[i], "boolean");
  assert.equal(entry.title, "Decoy Vault");
  assert.equal(entry.points.length, 3);
  assert.match(entry.points.join(" "), /not proof against an expert/);
  assert.equal(entry.early, undefined);
  assert.match(src("src/Pages.jsx"), /\n  decoy: "mask",\n/);
  assert.match(src("src/ui.jsx"), /\n  mask: VenetianMask,\n/);
});

test("gating: the app shows it only with Device Vault released, and the server has nothing to gate", async (t) => {
  for (const [released, shown] of [
    ["mvp,ephemeral,vault", false],
    ["mvp,decoy", false],
    ["mvp,ephemeral,decoy", false],
    ["mvp,ephemeral,vault,decoy", true],
    ["all", true],
  ]) {
    const s = fixture(t, released);
    const config = (await request(s.app).get("/api/config").expect(200)).body;
    assert.equal(config.releases.updates.find((u) => u.id === "decoy").released, released.includes("decoy") || released === "all");
    assert.equal(decoyReleased(config), shown, released);
  }
  assert.equal(decoyReleased(undefined), false);
  // Browser only: no route, field or server code knows about a decoy, and
  // nothing a vault or sync request carries asks for it.
  for (const path of ["/api/vault-sync", "/api/vault-sync/records", "/api/chat", "/api/decoy"])
    assert.ok(!featuresFor({ path, method: "POST", body: {} }).includes("decoy"), path);
  for (const f of readdirSync(new URL("../server/routes/", import.meta.url)))
    assert.doesNotMatch(src("server/routes/" + f), /decoy/i, f);
  for (const f of ["server/app.js", "server/core.js", "server/openapi.js"]) assert.doesNotMatch(src(f), /decoy/i, f);
  const s = fixture(t, "all");
  const { agent } = await (async () => {
    const agent = request.agent(s.app);
    await agent.post("/api/auth/register").send({ username: "decoy-gate", password: "test-password-long" }).expect(201);
    return { agent };
  })();
  await agent.get("/api/decoy").expect(404);
  // The workspace passes the release to the hook; the manage dialog shows
  // the block only then, and the pre-release unlock is unchanged.
  const ws = src("src/Workspace.jsx");
  assert.match(ws, /decoy: vaultLive && decoyReleased\(config\),/);
  assert.match(ws, /sampleModel=\{selected\?\.id \|\| null\}/);
  const jsx = src("src/DeviceVault.jsx");
  assert.match(jsx, /if \(!vault\.decoy\?\.live\) return null;/);
  assert.match(jsx, /if \(!decoyRef\.current\) return open\(await unlockVault\(meta, passphrase\), meta, forAccount\);/);
  assert.match(jsx, /<DecoySection vault=\{vault\} sampleModel=\{sampleModel\} \/>/);
  // No network, no plain storage, in the decoy's own module.
  for (const file of ["src/decoy-vault.js", "src/decoy-samples.js"])
    for (const call of [/\bapi\(/, /\bfetch\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /localStorage/, /sessionStorage/, /indexedDB/])
      assert.doesNotMatch(src(file), call, `${file}: ${call}`);
  // The sample chats' text loads only when a decoy is made.
  assert.match(src("src/decoy-vault.js"), /await import\("\.\/decoy-samples\.js"\)/);
  // Its database's name doesn't say "decoy".
  assert.doesNotMatch(src("src/device-vault-store.js").match(/export const altStore = .*/)[0], /decoy/i);
});

test("every string Decoy Vault shows has a Chinese translation", async () => {
  const dict = compileDictionary(JSON.parse(src("src/i18n/zh.json")));
  const entry = UPDATES.find((u) => u.id === "decoy");
  const ui = await loadVault({ hooks: false });
  const noop = () => {};
  const base = { status: "unlocked", unlocked: true, chats: [], meta: { idleMinutes: 15 }, damaged: 0, lock() {} };
  const rendered = [
    renderToStaticMarkup(createElement(ui.DecoySection, { vault: { ...base, decoy: { live: true, set: false } } })),
    renderToStaticMarkup(createElement(ui.DecoySection, { vault: { ...base, decoy: { live: true, set: true } } })),
    renderToStaticMarkup(createElement(ui.DecoyLimits)),
  ].join("");
  const flat = (f) => src(f).replace(/\s+/g, " ");
  const jsx = flat("src/DeviceVault.jsx");
  // The forms and notes, which need a click.
  const clicked = [
    "Decoy passphrase (at least 10 characters)",
    "Repeat the decoy passphrase",
    "The passphrases don't match.",
    "This vault's passphrase, to confirm",
    "Unlocking with a decoy passphrase opens a separate vault instead of this one. It starts with a few ordinary sample chats you can continue, delete or add to.",
    "Choose a new decoy passphrase. The decoy starts over with fresh sample chats.",
    "Saving…",
    "Set decoy passphrase",
    "Change decoy passphrase",
    "Cancel",
    "Remove the decoy passphrase? The decoy vault and its chats are deleted from this browser.",
    "Removing…",
    "Remove decoy",
    "Keep it",
    "Decoy passphrase set. Lock the vault and unlock with it to see the decoy.",
    "Decoy removed. Only this vault's passphrase unlocks now.",
    "Something went wrong.",
  ];
  for (const s of clicked.slice(1)) assert.ok(jsx.includes(s), "in the source: " + s);
  const dataControls = flat("src/DataControls.jsx").match(/Decoy Vault, if you set a decoy passphrase:[^<]+/)[0].trim();
  const lines = new Set([
    ...textsOf(rendered),
    ...clicked,
    ...DECOY_LIMITS,
    ...Object.values(DECOY_ERRORS),
    VAULT_ERRORS.wrong_passphrase,
    ui.sync.SYNC_PAUSED,
    dataControls,
    entry.title,
    entry.tagline,
    ...entry.points,
    "Decoy Vault is coming soon.",
  ]);
  for (const line of lines) {
    const zh = translateText(line, dict);
    assert.ok(zh && han.test(zh), `zh: ${line} → ${zh}`);
    const leftover = (zh.match(/[A-Za-z]{4,}/g) || []).filter((w) => !["ANONYMA"].includes(w));
    assert.deepEqual(leftover, [], `half-translated: ${line} → ${zh}`);
  }
  assert.equal(translateText("Decoy Vault", dict), "诱饵保险库");
  // Sample chats are content: never run through the translator.
  assert.match(src("src/DeviceVault.jsx"), /<span data-i18n="off">\s*\{mark\?\.\(c\)\}\s*\{c\.title\}/);
});
