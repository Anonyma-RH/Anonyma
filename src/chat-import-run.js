// What happens after the person chooses chats and a destination. Kept free
// of React and of the network (`post` and `vault` are passed in), so the
// tests can check exactly what would leave the browser.
import { planBatches, uploadShape, vaultMessages } from "./chat-import.js";
import { vaultChat } from "./device-vault.js";

// How many chats are asked of the reader at once.
const SLICE = 20;
// Chats written to Device Vault in one go.
const VAULT_SLICE = 50;

// To the account: only the chosen chats, in batches, each carrying only its
// words and dates (never the file, its name, or the chats that weren't
// chosen). `post(body)` sends one batch and resolves the route's answer
// ({ saved: [{ index, id }], skipped: [{ index, reason }] }). It stops at
// the first failure and reports what was done, so nothing is guessed.
export async function importToAccount({ engine, ids, source, allow = new Set(), post, onProgress, signal }) {
  const saved = [],
    skipped = [];
  let error = null,
    done = 0;
  outer: for (let i = 0; i < ids.length; i += SLICE) {
    const chats = await engine.get(ids.slice(i, i + SLICE));
    for (const batch of planBatches(chats)) {
      if (signal?.aborted) {
        error = "stopped";
        break outer;
      }
      let answer;
      try {
        answer = await post({ source, chats: batch.map((c) => uploadShape(c, allow.has(c.id))) });
      } catch (e) {
        error = e;
        break outer;
      }
      for (const s of answer?.saved || []) {
        const chat = batch[s.index];
        if (chat) saved.push({ chat: chat.id, conversation: s.id, title: chat.title });
      }
      for (const s of answer?.skipped || []) {
        const chat = batch[s.index];
        if (chat) skipped.push({ chat: chat.id, reason: s.reason });
      }
      done += batch.length;
      onProgress?.({ done, total: ids.length });
    }
  }
  const handled = new Set([...saved.map((s) => s.chat), ...skipped.map((s) => s.chat)]);
  return { saved, skipped, error, left: ids.filter((id) => !handled.has(id)) };
}

// A chat as Device Vault keeps it: sealed with the vault's key, on this
// device only. Its real title, its own dates, and where it came from (kept
// inside the sealed chat, with the id the export gave it, so importing the
// same export again can tell it's already here).
export function toVaultChat(chat, source, id = crypto.randomUUID()) {
  return vaultChat({
    id,
    mode: "chat",
    messages: vaultMessages(chat),
    veil: null,
    created: chat.created || chat.updated || Date.now(),
    now: chat.updated || chat.created || Date.now(),
    title: chat.title,
    importedFrom: source,
    importKey: chat.key,
  });
}
export async function importToVault({ engine, ids, source, vault, onProgress, signal }) {
  const saved = [];
  let error = null;
  for (let i = 0; i < ids.length; i += VAULT_SLICE) {
    if (signal?.aborted) {
      error = "stopped";
      break;
    }
    const chats = await engine.get(ids.slice(i, i + VAULT_SLICE));
    try {
      const made = chats.map((c) => toVaultChat(c, source));
      await vault.saveMany(made);
      chats.forEach((c, n) => saved.push({ chat: c.id, conversation: made[n].id, title: c.title }));
    } catch (e) {
      error = e;
      break;
    }
    onProgress?.({ done: Math.min(i + VAULT_SLICE, ids.length), total: ids.length });
  }
  const handled = new Set(saved.map((s) => s.chat));
  return { saved, skipped: [], error, left: ids.filter((id) => !handled.has(id)) };
}

// To Markdown files: made here, nothing saved and nothing sent. The chats
// are read a few at a time, and the page gets the finished file (one chat) or
// ZIP (several) to download.
export async function importToMarkdown({ engine, ids, source, label, onProgress, signal }) {
  const { markdownFiles, markdownDownload } = await import("./chat-import-markdown.js");
  const files = [],
    used = new Set(),
    done = [];
  let error = null;
  for (let i = 0; i < ids.length; i += SLICE) {
    if (signal?.aborted) {
      error = "stopped";
      break;
    }
    const chats = await engine.get(ids.slice(i, i + SLICE));
    try {
      files.push(...markdownFiles(chats, source, { label, used }));
      for (const c of chats) done.push(c.id);
    } catch (e) {
      error = e;
      break;
    }
    onProgress?.({ done: done.length, total: ids.length });
    // Let the page paint between slices.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const download = files.length ? await markdownDownload(files, source) : null;
  const handled = new Set(done);
  return { download, saved: done.map((chat) => ({ chat })), skipped: [], error, left: ids.filter((id) => !handled.has(id)) };
}
