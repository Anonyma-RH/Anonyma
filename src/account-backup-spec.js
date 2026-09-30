// Encrypted Backup (update "backup"): what a backup file holds, how its
// items are read back, and the content keys that notice a restored item is
// already in the account. Pure and DOM-free, so the page, its worker
// (src/account-backup.worker.js), the tests and the server
// (server/routes/account-backup.js) all run the same code. The encryption
// itself is in src/account-backup.js.
//
// A backup is a stream of items, one JSON object per line, encrypted in the
// browser. Our server hands the browser the account's content in pages and
// never sees the passphrase, the key or the finished file.
import { findSeedPhrase, findPrivateKey } from "./seed-guard.js";

export const BACKUP_FORMAT = "anonyma-backup";
export const BACKUP_VERSION = 1;
export const BACKUP_EXTENSION = ".anonyma-backup";
// The plaintext is sealed in parts of this size, each with its own IV, so a
// large account never needs the whole file in memory at once.
export const CHUNK_BYTES = 4 * 1024 * 1024;
// The largest backup made or opened in a browser.
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
export const MAX_BACKUP_LABEL = "512 MB";
export const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_ITEMS = 200000;
// One item (a chat with all its messages) is at most this long as text.
export const MAX_ITEM_CHARS = 64 * 1024 * 1024;
export const MIN_BACKUP_PASSPHRASE = 12;
// A gentle reminder once, this many days after the last backup.
export const REMINDER_DAYS = 30;
// One page of saved chats from GET /api/account/backup/chats.
export const CHATS_PER_PAGE = 25;
export const PAGE_CHARS = 8 * 1024 * 1024;

// The file's name, by day: a YYYY-MM-DD (the page passes this browser's
// own day) or a Date (its UTC day).
export const backupFileName = (day = new Date()) =>
  `anonyma-backup-${typeof day === "string" ? day : day.toISOString().slice(0, 10)}${BACKUP_EXTENSION}`;
export const isoDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
export const validDay = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z"));

// What a backup can hold, in the order a restore adds them: projects first
// (so restored chats can be filed in them), then chats with their bookmarks,
// and the settings-like kinds after. Characters come with their pictures,
// never their copy links; saved subtitle sets with their cues. Device Vault
// chats go back into this browser's vault, never to the server.
export const BACKUP_KINDS = [
  "projects",
  "chats",
  "bookmarks",
  "scrolls",
  "instructions",
  "memory",
  "routines",
  "research",
  "watches",
  "characters",
  "subtitles",
  "vault",
];
// The line type each kind is written as.
export const KIND_TYPES = {
  projects: "project",
  chats: "chat",
  bookmarks: "bookmark",
  scrolls: "scroll",
  instructions: "instructions",
  memory: "memory",
  routines: "routine",
  research: "research",
  watches: "watch",
  characters: "character",
  subtitles: "subtitles",
  vault: "vault",
};
const TYPE_KINDS = Object.fromEntries(Object.entries(KIND_TYPES).map(([k, t]) => [t, k]));
// The updates each kind needs before it can be made or restored (the page
// offers only those that are live; the routes it calls check the same).
export const KIND_UPDATES = {
  projects: ["projects"],
  chats: [],
  bookmarks: ["bookmarks"],
  scrolls: ["scrolls"],
  instructions: ["scrolls"],
  memory: ["memory"],
  routines: ["routines"],
  research: ["researchwatch", "routines", "deepresearch", "search"],
  watches: ["pagewatch", "routines"],
  characters: ["characters"],
  subtitles: ["subtitles", "audio"],
  vault: ["vault", "ephemeral"],
};
export const kindLive = (kind, released) => (KIND_UPDATES[kind] || []).every((id) => released(id));
// "What goes in" when making a backup: the kinds this account has and the
// server has released, in order. Bookmarks go only with their chats.
const MAKE_ORDER = ["chats", "bookmarks", "projects", "scrolls", "instructions", "memory", "routines", "research", "watches", "characters", "subtitles"];
export const makeKinds = (counts, released) =>
  MAKE_ORDER.filter((k) => kindLive(k, released) && (counts?.[k] || 0) > 0 && (k !== "bookmarks" || (counts?.chats || 0) > 0));

// The mode a restored chat keeps. A saved chat's mode decides where it opens
// (Code & Build, Uncensored, Symposium runs); a restore keeps it when the
// restoring server has that update live, and otherwise saves the chat as an
// ordinary one and says so. Any other mode comes back as an ordinary chat
// too. (A new batch's conversation mode is added here with its update.)
export const RESTORE_MODES = {
  chat: [],
  code: ["code"],
  uncensored: ["uncensored"],
  symposium: ["symposium"],
};
export function restoredMode(mode, released) {
  const wanted = typeof mode === "string" && mode ? mode : "chat";
  const needs = Object.hasOwn(RESTORE_MODES, wanted) ? RESTORE_MODES[wanted] : null;
  return needs && needs.every((id) => released(id)) ? { mode: wanted, fallback: false } : { mode: "chat", fallback: true };
}

// ---- Words -------------------------------------------------------------------

// The text of a saved message, whatever shape it was saved in: a string, an
// array of text and image parts, or a reply object { text, reasoning, ... }
// (the same reading as the bookmarks list). Images and files are left out.
export function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}
// The same cleaning Chat Import gives an uploaded message, so a chat's key
// is the same before and after a round trip.
export const cleanText = (text) =>
  String(text ?? "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim();
const oneLine = (s) =>
  String(s ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// ---- Content keys --------------------------------------------------------------
// What makes two items "the same" for a restore: their words, never their
// ids, dates or titles (a renamed chat is still the same chat). The server
// hashes these (SHA-256) to skip what the account already has.
const ROLES = ["user", "assistant"];
export function chatKey(messages) {
  return JSON.stringify(
    (Array.isArray(messages) ? messages : [])
      .filter((m) => m && ROLES.includes(m.role))
      .map((m) => [m.role, cleanText(typeof m.text === "string" ? m.text : messageText(m.content))])
      .filter(([, text]) => text),
  );
}
export const scrollKey = (s) => JSON.stringify([oneLine(s?.title), cleanText(s?.body)]);
export const projectKey = (p) => JSON.stringify([oneLine(p?.name).toLowerCase(), cleanText(p?.instructions)]);
export const memoryKey = (f) => oneLine(f?.text).toLowerCase();
export const routineKey = (r) => JSON.stringify([oneLine(r?.name).toLowerCase(), cleanText(r?.prompt ?? r?.topic)]);
export const watchKey = (w) => String(w?.url ?? "").trim();
// A character: its name and the words it's given (not its picture or model).
export const characterKey = (c) =>
  JSON.stringify([oneLine(c?.name).toLowerCase(), cleanText(c?.instructions), cleanText(c?.opening)]);
// A saved subtitle set: its title, length and every track's cues.
export const subtitleKey = (set) =>
  JSON.stringify([
    oneLine(set?.title).toLowerCase(),
    Math.round(Number(set?.duration) * 1000) / 1000,
    (Array.isArray(set?.tracks) ? set.tracks : []).map((t) => [
      String(t?.lang ?? ""),
      t?.source === true,
      (Array.isArray(t?.cues) ? t.cues : []).map((c) => [Math.round(Number(c?.start) * 1000), Math.round(Number(c?.end) * 1000), cleanText(c?.text)]),
    ]),
  ]);
// A Device Vault chat: its id, or the words of its messages.
export const vaultKey = (chat) =>
  chatKey((chat?.messages || []).map((m) => ({ role: m?.role, text: typeof m?.content === "string" ? m.content : messageText(m?.content) })));

// ---- Seed Guard ------------------------------------------------------------------
// Seed Guard's hard finds (a seed phrase, a WIF or extended private key) in
// an item's words, as Chat Import checks a chat. The soft 64-hex notice
// isn't used: bare hex is far more often a hash than a key.
const hit = (t) => typeof t === "string" && t && (!!findSeedPhrase(t) || !!findPrivateKey(t));
export function itemSeedFinding(item) {
  switch (item?.t) {
    case "chat":
      return hit(item.title) || (item.messages || []).some((m) => hit(m.text));
    case "scroll":
      return hit(item.title) || hit(item.body);
    case "project":
      return hit(item.name) || hit(item.instructions);
    case "instructions":
      return hit(item.body);
    case "memory":
      return hit(item.text);
    case "routine":
      return hit(item.name) || hit(item.prompt);
    case "research":
      return hit(item.name) || hit(item.topic);
    case "watch":
      return hit(item.hint);
    case "character":
      return hit(item.name) || hit(item.description) || hit(item.instructions) || hit(item.opening);
    case "subtitles":
      return hit(item.title) || item.tracks.some((t) => t.cues.some((c) => hit(c.text)));
    default:
      return false;
  }
}

// ---- Reading items back ------------------------------------------------------------
// Every line of a backup that was opened with the right passphrase came from
// this person's own browser, but a file can still be edited by hand, so
// each item is checked for shape and size here, and again by the server
// route that saves it.
const str = (v, max) => (typeof v === "string" && v.length <= max ? v : null);
const optStr = (v, max) => (v == null ? null : str(v, max));
const time = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const flag = (v) => v === true || v === 1;
const idOf = (v) => (typeof v === "string" && v.length > 0 && v.length <= 100 ? v : null);
function schedule(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const out = { repeat: str(s.repeat, 20), time: str(s.time, 5), timezone: str(s.timezone ?? "UTC", 100) };
  if (!out.repeat || !out.time || !out.timezone) return null;
  if (s.day != null) {
    if (!Number.isInteger(s.day) || s.day < 0 || s.day > 6) return null;
    out.day = s.day;
  }
  return out;
}
const credit = (v) => (Number.isFinite(v) && v > 0 && v <= 1e9 ? v : null);

// Veil: the map that shows a saved chat's masked details again. It lives
// only in the browser that sent the chat, so a backup made there carries it
// (encrypted like everything else) and a restore puts it back in the
// restoring browser under the chat's new id. It is never sent to the server.
const plainMap = (m) =>
  m && typeof m === "object" && !Array.isArray(m) && Object.values(m).every((v) => typeof v === "string" || Number.isFinite(v));
export function veilState(v) {
  if (!v || typeof v !== "object" || !plainMap(v.map) || !Object.keys(v.map).length) return null;
  if (JSON.stringify(v).length > 200000) return null;
  return {
    map: { ...v.map },
    counters: plainMap(v.counters) ? { ...v.counters } : {},
    valueToTag: plainMap(v.valueToTag) ? { ...v.valueToTag } : {},
  };
}

export function readItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  switch (raw.t) {
    case "manifest":
      return raw.format === BACKUP_FORMAT && typeof raw.created === "string" && !Number.isNaN(Date.parse(raw.created))
        ? { t: "manifest", created: raw.created }
        : null;
    case "chat": {
      if (!Array.isArray(raw.messages)) return null;
      const messages = [];
      for (const m of raw.messages) {
        if (!m || typeof m !== "object" || !ROLES.includes(m.role) || typeof m.text !== "string") return null;
        messages.push({
          id: idOf(m.id),
          role: m.role,
          text: m.text,
          model: optStr(m.model, 200),
          created: time(m.created),
        });
      }
      return {
        t: "chat",
        id: idOf(raw.id),
        mode: optStr(raw.mode, 40) || "chat",
        title: typeof raw.title === "string" ? raw.title.slice(0, 200) : "",
        created: time(raw.created),
        updated: time(raw.updated),
        project: idOf(raw.project),
        messages,
        ...(veilState(raw.veil) ? { veil: veilState(raw.veil) } : {}),
      };
    }
    case "project": {
      const name = str(raw.name, 200);
      if (!name || !name.trim()) return null;
      return {
        t: "project",
        id: idOf(raw.id),
        name,
        color: optStr(raw.color, 40),
        instructions: str(raw.instructions ?? "", 100000) ?? "",
        starts: optStr(raw.starts, 20) || "normal",
        model: optStr(raw.model, 200),
        created: time(raw.created),
      };
    }
    case "bookmark": {
      const message = idOf(raw.message_id);
      if (!message) return null;
      return { t: "bookmark", message_id: message, conversation_id: idOf(raw.conversation_id), note: str(raw.note ?? "", 140) ?? "", created: time(raw.created) };
    }
    case "scroll": {
      const title = str(raw.title, 200),
        body = str(raw.body, 100000);
      return title && body ? { t: "scroll", title, body, created: time(raw.created) } : null;
    }
    case "instructions": {
      const body = str(raw.body, 100000);
      return body && body.trim() ? { t: "instructions", body, enabled: raw.enabled !== false && raw.enabled !== 0 } : null;
    }
    case "memory": {
      const text = str(raw.text, 2000);
      return text && text.trim() ? { t: "memory", text, enabled: raw.enabled !== false && raw.enabled !== 0, created: time(raw.created) } : null;
    }
    case "routine": {
      const name = str(raw.name, 200),
        prompt = str(raw.prompt, 100000),
        model = str(raw.model, 200),
        when = schedule(raw.schedule),
        run = credit(raw.per_run_credits),
        budget = credit(raw.monthly_budget_credits);
      if (!name || !prompt || !model || !when || !run || !budget) return null;
      return {
        t: "routine",
        name,
        prompt,
        model,
        web_search: flag(raw.web_search),
        private_only: flag(raw.private_only),
        schedule: when,
        per_run_credits: run,
        monthly_budget_credits: budget,
        created: time(raw.created),
      };
    }
    case "research": {
      const topic = str(raw.topic, 100000),
        model = str(raw.model, 200),
        when = schedule(raw.schedule),
        budget = credit(raw.monthly_budget_credits),
        depth = str(raw.depth, 20);
      if (!topic || !model || !when || !budget || !depth) return null;
      return {
        t: "research",
        name: str(raw.name ?? "", 200) ?? "",
        topic,
        model,
        depth,
        new_only: flag(raw.new_only),
        private_only: flag(raw.private_only),
        schedule: when,
        monthly_budget_credits: budget,
        created: time(raw.created),
      };
    }
    case "watch": {
      const url = str(raw.url, 4096),
        model = str(raw.model, 200),
        every = str(raw.every, 20),
        budget = credit(raw.monthly_budget_credits);
      if (!url || !model || !every || !budget) return null;
      return {
        t: "watch",
        url,
        hint: optStr(raw.hint, 4000),
        model,
        private_only: flag(raw.private_only),
        every,
        monthly_budget_credits: budget,
        created: time(raw.created),
      };
    }
    case "character": {
      const name = str(raw.name, 200);
      if (!name || !name.trim()) return null;
      return {
        t: "character",
        name,
        description: str(raw.description ?? "", 2000) ?? "",
        instructions: str(raw.instructions ?? "", 100000) ?? "",
        opening: str(raw.opening ?? "", 100000) ?? "",
        model: optStr(raw.model, 200),
        // A built-in monogram or a small picture as a data URL; the server
        // checks it again.
        avatar: optStr(raw.avatar, 262144),
        created: time(raw.created),
      };
    }
    case "subtitles": {
      const title = str(raw.title, 200),
        duration = Number(raw.duration);
      if (!title || !title.trim() || !Number.isFinite(duration) || duration <= 0) return null;
      if (!Array.isArray(raw.tracks) || !raw.tracks.length || JSON.stringify(raw.tracks).length > 1024 * 1024) return null;
      const tracks = [];
      for (const t of raw.tracks) {
        if (!t || typeof t !== "object" || Array.isArray(t) || !Array.isArray(t.cues)) return null;
        const cues = [];
        for (const c of t.cues) {
          if (!c || typeof c !== "object" || typeof c.text !== "string" || !Number.isFinite(c.start) || !Number.isFinite(c.end)) return null;
          cues.push({ start: c.start, end: c.end, text: c.text });
        }
        tracks.push({ lang: typeof t.lang === "string" ? t.lang.slice(0, 40) : "", source: t.source === true, cues });
      }
      return {
        t: "subtitles",
        title,
        duration,
        language: optStr(raw.language, 40) || "",
        tracks,
        created: time(raw.created),
      };
    }
    case "vault": {
      const c = raw.chat;
      if (!c || typeof c !== "object" || Array.isArray(c) || !idOf(c.id) || !Array.isArray(c.messages)) return null;
      return { t: "vault", chat: c };
    }
    default:
      return null;
  }
}
export const kindOf = (item) => TYPE_KINDS[item?.t] || null;

// ---- What a restore sends for a chat ----------------------------------------------
// A backup chat as the restore route takes it: its words, dates, mode and
// which model answered, the project it goes back into (the new project's
// id), and the notes of the bookmarks on its messages. Never its old ids:
// a bookmark rides on the very message it marked in the file, so it lands
// on that message of the restored chat.
export function restoreShape(chat, { project = null, notes = null, allowSeed = false } = {}) {
  return {
    title: chat.title,
    created: chat.created,
    updated: chat.updated,
    ...(chat.mode && chat.mode !== "chat" ? { mode: chat.mode } : {}),
    ...(project ? { project } : {}),
    messages: chat.messages.map((m) => ({
      role: m.role,
      text: m.text,
      created: m.created,
      ...(m.role === "assistant" && m.model ? { model: m.model } : {}),
      ...(notes && m.id && notes.has(m.id) ? { bookmark: notes.get(m.id) } : {}),
    })),
    ...(allowSeed ? { allow_seed_phrase: true } : {}),
  };
}
