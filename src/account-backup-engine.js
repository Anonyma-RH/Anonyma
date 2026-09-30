// Encrypted Backup's reader and writer sessions: what the worker
// (src/account-backup.worker.js) holds between the page's messages. Never
// makes a network request: an opened backup stays in this browser until the
// person chooses what to restore, and a backup being made only ever leaves
// as the file the page saves.
import { openBackup, startBackup, BackupError } from "./account-backup.js";
import {
  BACKUP_KINDS,
  MAX_ITEMS,
  chatKey,
  itemSeedFinding,
  kindOf,
  readItem,
} from "./account-backup-spec.js";

// ---- Opening ----------------------------------------------------------------------
// The backup's items by kind, each with its index as `n`, plus what the
// page shows before anything is chosen: counts, the dates the chats span,
// Seed Guard's holds (only when it's live) and lines that couldn't be read.
export async function loadBackup(source, passphrase, { seedGuard = false, onProgress } = {}) {
  const items = Object.fromEntries(BACKUP_KINDS.map((k) => [k, []]));
  let manifest = null,
    unreadable = 0,
    lines = 0;
  const header = await openBackup(source, passphrase, {
    onProgress,
    onLine(raw) {
      if (++lines > MAX_ITEMS) throw new BackupError("too_many", "This backup holds more items than a browser can restore at once.");
      const item = readItem(raw);
      if (!item) return void unreadable++;
      if (item.t === "manifest") {
        manifest ||= item;
        return;
      }
      const kind = kindOf(item);
      const list = items[kind];
      item.n = list.length;
      if (seedGuard && itemSeedFinding(item)) item.seed = true;
      list.push(item);
    },
  });
  // A chat whose words appear twice in the file is kept once.
  const seen = new Set();
  items.chats = items.chats.filter((c) => {
    const key = chatKey(c.messages);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  items.chats.forEach((c, i) => (c.n = i));
  // Bookmarks only mean something on a chat that is in the file.
  const messages = new Set(items.chats.flatMap((c) => c.messages.map((m) => m.id).filter(Boolean)));
  items.bookmarks = items.bookmarks.filter((b) => messages.has(b.message_id));
  items.bookmarks.forEach((b, i) => (b.n = i));
  // Standing instructions are one per account.
  items.instructions = items.instructions.slice(0, 1);
  return {
    overview() {
      const counts = {},
        seed = {};
      for (const kind of BACKUP_KINDS) {
        counts[kind] = items[kind].length;
        seed[kind] = items[kind].filter((i) => i.seed).length;
      }
      const times = items.chats.flatMap((c) => [c.created, c.updated]).filter((t) => t > 0);
      return {
        made: manifest?.created || header.created,
        counts,
        seed,
        range: times.length ? { from: Math.min(...times), to: Math.max(...times) } : null,
        unreadable,
        messages: items.chats.reduce((n, c) => n + c.messages.length, 0),
      };
    },
    // Items of one kind, `count` from `start`.
    get(kind, start = 0, count = 50) {
      const list = items[kind];
      if (!list) return [];
      return list.slice(start, start + count);
    },
  };
}

// ---- Making ----------------------------------------------------------------------
// A backup being made: the page pushes JSON items as it reads them from the
// account, and gets the sealed parts back.
export async function writerFor(passphrase, options) {
  const writer = await startBackup(passphrase, options);
  return {
    async push(items) {
      const text = items.map((i) => JSON.stringify(i) + "\n").join("");
      return writer.push(text);
    },
    finish: () => writer.finish(),
  };
}
