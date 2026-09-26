// Privacy Screen (update "privacyscreen"): hide the screen at once, hide it
// when you switch away, and lock it after idle. It runs in this browser; the
// only server call is the idle lock's unlock check (POST /api/auth/unlock,
// server/routes/unlock.js), which never touches the session.
//
// Hiding takes the whole app out of the document: #root (and anything else
// the app put in <body>, such as the print view) is swapped for a comment
// marker and kept in memory, and a cover takes its place. React keeps
// running against the detached tree, so a reply that is streaming keeps
// streaming and is there on return, but none of it is in the DOM, the
// accessibility tree or an app-switcher snapshot meanwhile. It hides the
// screen from people nearby; it isn't encryption.
//
// Settings are per browser, in localStorage: "Hide when I switch away" and
// "Lock after idle" (off, 5, 15 or 60 minutes). A lock is kept in
// localStorage too, so a reload or another tab stays locked until the
// password (or email code or wallet signature) is checked again.
import { isReleased } from "./lib.js";

export const privacyScreenReleased = (config) =>
  isReleased(config, "privacyscreen");

// Esc, then Esc again within this long, hides the screen.
export const ESC_PAIR_MS = 400;
// Right after hiding, input doesn't bring the screen back, so a third quick
// Esc or a double tap on Hide doesn't undo it.
export const REVEAL_GRACE_MS = 500;
export const IDLE_CHOICES = [0, 5, 15, 60];
// Activity is shared with this browser's other tabs at most this often.
export const ACTIVE_WRITE_MS = 10000;
export const IDLE_CHECK_MS = 5000;
export const SETTINGS_KEY = "anonyma:privacy-screen";
export const LOCK_KEY = "anonyma:privacy-screen-lock";
export const ACTIVE_KEY = "anonyma:privacy-screen-active";

// ---- Pure helpers (unit tested) ----

export function normalizeSettings(raw) {
  const idle = Number(raw?.idle);
  return {
    blur: raw?.blur === true,
    idle: IDLE_CHOICES.includes(idle) ? idle : 0,
  };
}

// Keys that never count as "a key": pressed alone they don't return from the
// cover, and they don't break an Esc pair.
const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "OS",
  "Super",
  "Hyper",
  "Fn",
  "FnLock",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Dead",
  "Process",
  "Unidentified",
]);

// Returns a function of (keydown event, time) that is true when this Esc
// completes a pair: two plain Escs within `windowMs`, nothing in between.
// Held keys (auto-repeat), Esc with a modifier and Esc ending an input
// method's composition never count.
export function createEscPair(windowMs = ESC_PAIR_MS) {
  let last = null;
  return (e, at) => {
    if (e.key !== "Escape") {
      if (!MODIFIER_KEYS.has(e.key)) last = null;
      return false;
    }
    if (
      e.repeat ||
      e.isComposing ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey ||
      e.shiftKey
    ) {
      last = null;
      return false;
    }
    if (last !== null && at - last >= 0 && at - last <= windowMs) {
      last = null;
      return true;
    }
    last = at;
    return false;
  };
}

// "Press any key to return": any key but a lone modifier, and not a shortcut
// (⌘Tab, Ctrl+Tab and Alt+Tab switch away; they shouldn't show the screen).
export const revealsOnKey = (e) =>
  !e.repeat &&
  !e.isComposing &&
  !e.ctrlKey &&
  !e.metaKey &&
  !e.altKey &&
  !MODIFIER_KEYS.has(e.key);

export const idleDue = (lastActive, minutes, at) =>
  minutes > 0 &&
  Number.isFinite(lastActive) &&
  at - lastActive >= minutes * 60000;

// The kept lock: { user, at } while locked; { signedOut: true } after "Sign
// out instead", which sends this browser's other tabs to sign-in as well.
export function parseLock(raw) {
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    if (v.signedOut === true) return { signedOut: true };
    return typeof v.user === "string" && v.user
      ? { user: v.user, at: Number(v.at) || 0 }
      : null;
  } catch {
    return null;
  }
}
export const lockApplies = (lock, userId) =>
  !!lock && !lock.signedOut && !!userId && lock.user === userId;

// ---- The cover: taking the app out of the document and back ----

// Left in <body>: nothing here is content, and scripts must stay put.
const KEEP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "LINK",
  "META",
  "TEMPLATE",
  "NOSCRIPT",
  "BASE",
  "TITLE",
]);

// Puts `layer` in <body> and takes every other element out, each replaced
// by a comment marker so it goes back exactly where it was. Returns what
// uncoverDocument needs: the markers, scroll positions, open modal dialogs
// and the element that had focus.
export function coverDocument(doc, layer) {
  const body = doc.body;
  const win = doc.defaultView;
  const saved = {
    nodes: [],
    scroll: [],
    dialogs: [],
    x: win?.scrollX || 0,
    y: win?.scrollY || 0,
    focus: doc.activeElement,
  };
  for (const el of [...body.children]) {
    if (el === layer || KEEP_TAGS.has(el.tagName)) continue;
    for (const s of el.querySelectorAll?.("*") || []) {
      if (s.scrollTop || s.scrollLeft)
        saved.scroll.push([
          s,
          s.scrollTop,
          s.scrollLeft,
          s.scrollTop + s.clientHeight >= s.scrollHeight - 4,
        ]);
      if (s.tagName === "DIALOG" && s.open) {
        let modal = false;
        try {
          modal = s.matches(":modal");
        } catch {}
        if (modal) saved.dialogs.push(s);
      }
    }
    const mark = doc.createComment("privacy-screen");
    body.replaceChild(mark, el);
    saved.nodes.push([mark, el]);
  }
  if (layer.parentNode !== body) body.appendChild(layer);
  return saved;
}

export function uncoverDocument(doc, layer, saved) {
  for (const [mark, el] of saved?.nodes || [])
    if (mark.parentNode) mark.parentNode.replaceChild(el, mark);
  if (layer.parentNode) layer.parentNode.removeChild(layer);
  if (!saved) return;
  // A modal dialog taken out of the document stops being modal; it goes
  // back as it was, without the close event a close() would send.
  for (const d of saved.dialogs) {
    if (!d.isConnected || !d.hasAttribute("open")) continue;
    try {
      d.removeAttribute("open");
      d.showModal();
    } catch {
      d.setAttribute("open", "");
    }
  }
  for (const [el, top, left, atEnd] of saved.scroll) {
    if (!el.isConnected) continue;
    // A pane that was at its end (a chat following its reply) follows
    // whatever arrived meanwhile.
    el.scrollTop = atEnd ? el.scrollHeight : top;
    el.scrollLeft = left;
  }
  doc.defaultView?.scrollTo?.(saved.x, saved.y);
  const f = saved.focus;
  if (f && f !== doc.body && f.isConnected && typeof f.focus === "function")
    try {
      f.focus({ preventScroll: true });
    } catch {}
}

// ---- This browser's settings, and the lock kept for its other tabs ----

const store = () => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
};
function read(key) {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(key, value) {
  try {
    if (value === null) store()?.removeItem(key);
    else store()?.setItem(key, value);
  } catch {}
}

let settings;
export function getSettings() {
  if (!settings) {
    let raw = null;
    try {
      raw = JSON.parse(read(SETTINGS_KEY));
    } catch {}
    settings = normalizeSettings(raw);
  }
  return settings;
}
export function saveSettings(next) {
  settings = normalizeSettings({ ...getSettings(), ...next });
  write(SETTINGS_KEY, JSON.stringify(settings));
  lastActive = Date.now();
  emit();
  schedule();
}

// ---- State ----

// "shown", "hidden" (Esc Esc, Hide, switching away) or "locked" (idle).
let view = "shown";
// The signed-in account while a page with the Privacy Screen is open; null
// when none is (or it isn't released).
let current = null;
let layer = null;
let saved = null;
let hiddenAt = 0;
let lastActive = Date.now();
let lastShared = 0;
let timer = null;
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());

export const getView = () => view;
export const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const subscribeSettings = subscribe;

// The element the cover is rendered into (by React, through a portal) and
// that goes into <body> while the screen is hidden or locked.
export function coverLayer() {
  if (!layer && typeof document !== "undefined") {
    layer = document.createElement("div");
    layer.className = "privacy-layer";
  }
  return layer;
}
// While covered, the tab's title is just the name (a print view names its
// chat there), and a reply being read aloud pauses: hiding the screen
// shouldn't leave it speaking to the room.
let title = null;
let speaking = false;
function cover() {
  const el = coverLayer();
  if (!el) return;
  if (!saved) {
    saved = coverDocument(document, el);
    title = document.title;
    document.title = "ANONYMA";
    try {
      const synth = window.speechSynthesis;
      if (synth?.speaking && !synth.paused) {
        synth.pause();
        speaking = true;
      }
    } catch {}
  } else if (el.parentNode !== document.body) document.body.appendChild(el);
  // Keyboard and screen-reader focus moves onto the cover.
  if (!el.contains(document.activeElement))
    el.querySelector("button, input")?.focus({ preventScroll: true });
}
function uncover() {
  if (!layer || (!saved && !layer.parentNode)) return;
  const s = saved;
  saved = null;
  uncoverDocument(document, layer, s);
  if (s && title !== null && document.title === "ANONYMA") document.title = title;
  title = null;
  if (speaking) {
    speaking = false;
    try {
      window.speechSynthesis?.resume();
    } catch {}
  }
}
function setView(next) {
  if (view === next) return;
  view = next;
  if (next === "shown") uncover();
  else cover();
  emit();
}

// Hide now: Esc twice, the header button or the Command Palette.
export function hideScreen() {
  if (!current || view !== "shown") return;
  hiddenAt = Date.now();
  setView("hidden");
}
export function revealScreen() {
  if (view !== "hidden" || Date.now() - hiddenAt < REVEAL_GRACE_MS) return;
  lastActive = Date.now();
  setView("shown");
}
export function lockScreen() {
  if (!current?.user) return;
  write(LOCK_KEY, JSON.stringify({ user: current.user, at: Date.now() }));
  setView("locked");
}
// After POST /api/auth/unlock succeeded. Other tabs see the lock go.
export function unlocked() {
  write(LOCK_KEY, null);
  lastActive = Date.now();
  shareActivity(true);
  setView("shown");
}
// "Sign out instead" (or a session that ended while locked): every tab in
// this browser goes to sign-in, with a full page load so nothing from this
// one stays in memory.
export function leaveToSignIn() {
  write(LOCK_KEY, JSON.stringify({ signedOut: true }));
  window.location.replace("/login");
}
// A successful sign-in proves who's there: an old lock doesn't apply.
export function clearLock() {
  write(LOCK_KEY, null);
}

// The page with the Privacy Screen tells it who is signed in ({ user }), or
// null when it closes or the update isn't released.
export function activate(next) {
  current = next;
  if (!current) {
    stopTimer();
    if (view !== "shown") {
      view = "shown";
      emit();
    }
    uncover();
    return;
  }
  const lock = parseLock(read(LOCK_KEY));
  if (lock?.signedOut && current.user) write(LOCK_KEY, null);
  lastActive = Date.now();
  if (lockApplies(lock, current.user)) setView("locked");
  else if (view !== "shown") cover();
  schedule();
}

// ---- Idle ----

function shareActivity(force = false) {
  const t = Date.now();
  if (!force && t - lastShared < ACTIVE_WRITE_MS) return;
  lastShared = t;
  write(ACTIVE_KEY, String(lastActive));
}
function noteActivity() {
  lastActive = Date.now();
  if (current && getSettings().idle) shareActivity();
}
export function checkIdle(at = Date.now()) {
  if (!current?.user || view === "locked") return;
  const minutes = getSettings().idle;
  const shared = Number(read(ACTIVE_KEY)) || 0;
  if (idleDue(Math.max(lastActive, shared), minutes, at)) lockScreen();
}
function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}
function schedule() {
  stopTimer();
  if (current?.user && getSettings().idle && typeof window !== "undefined")
    timer = setInterval(checkIdle, IDLE_CHECK_MS);
}

// ---- Browser events ----

const escPair = createEscPair();
const inLayer = (target) => !!layer && !!target && layer.contains(target);
function onKey(e) {
  if (!current) return;
  if (view === "shown") {
    if (e.type === "keydown" && escPair(e, Date.now())) {
      e.preventDefault();
      e.stopImmediatePropagation();
      hideScreen();
    }
    return;
  }
  // Covered: no key reaches the app behind (⌘K, shortcuts, typing). The
  // lock screen's own fields still get their characters, which are the
  // keys' default actions.
  e.stopImmediatePropagation();
  if (view === "hidden" && e.type === "keydown" && revealsOnKey(e)) {
    e.preventDefault();
    revealScreen();
  }
}
// Covered: paste, drop and the like never reach the app behind.
function onBlocked(e) {
  if (!current || view === "shown" || inLayer(e.target)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}
// "Hide when I switch away". Focus moving into a frame on this page (Live
// Preview) or a file picker opened from it isn't switching away.
let picking = false;
function switchedAway() {
  if (!current || !getSettings().blur || view !== "shown") return;
  hideScreen();
  // Switching away and back at once is still a hide: no grace needed.
  hiddenAt = 0;
}
function onBlur() {
  if (!current || !getSettings().blur) return;
  setTimeout(() => {
    if (picking || document.hasFocus()) return;
    if (document.activeElement?.tagName === "IFRAME") return;
    switchedAway();
  }, 0);
}
function onVisibility() {
  if (document.visibilityState === "hidden") {
    picking = false;
    switchedAway();
  } else checkIdle();
}
function onPickFile(e) {
  const t = e.target;
  if (t?.tagName === "INPUT" && t.type === "file") picking = true;
}
function onStorage(e) {
  if (e.key === LOCK_KEY) {
    const lock = parseLock(e.newValue);
    if (lock?.signedOut) {
      if (current) window.location.replace("/login");
      return;
    }
    if (!current) return;
    if (lockApplies(lock, current.user)) setView("locked");
    else if (!lock && view === "locked") {
      lastActive = Date.now();
      setView("shown");
    }
  } else if (e.key === SETTINGS_KEY) {
    settings = undefined;
    emit();
    schedule();
  }
}

if (typeof window !== "undefined") {
  // Registered once, when this module loads (before any page's own
  // listeners), so a covered screen gets every key first.
  for (const type of ["keydown", "keyup", "keypress"])
    window.addEventListener(type, onKey, true);
  for (const type of ["paste", "copy", "cut", "drop", "dragover"])
    window.addEventListener(type, onBlocked, true);
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"])
    window.addEventListener(type, noteActivity, { capture: true, passive: true });
  let moved = 0;
  window.addEventListener(
    "pointermove",
    () => {
      const t = Date.now();
      if (t - moved > 1000) {
        moved = t;
        noteActivity();
      }
    },
    { capture: true, passive: true },
  );
  window.addEventListener("click", onPickFile, true);
  window.addEventListener("focus", () => {
    picking = false;
    checkIdle();
  });
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("storage", onStorage);
}
