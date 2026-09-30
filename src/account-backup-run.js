// What happens after the person chooses what to back up, or what to restore.
// Kept free of React and of fetch (`api`, `engine` and `vault` are passed
// in), so the tests can check exactly what is read and what leaves the
// browser.
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  characterKey,
  memoryKey,
  projectKey,
  restoreShape,
  routineKey,
  subtitleKey,
  veilState,
  vaultKey,
  watchKey,
} from "./account-backup-spec.js";
import { planBatches } from "./chat-import.js";

const stopped = () => Object.assign(Error("Stopped."), { code: "stopped" });
const check = (signal) => {
  if (signal?.aborted) throw stopped();
};

// ---- Making a backup ----------------------------------------------------------------
// Reads the account's content (GET /api/account/backup/content and the
// chats page by page), writes it into the worker as JSON items and collects
// the sealed parts. `include` is the Set of kinds chosen; `vaultChats` the
// unlocked Device Vault's chats when those were chosen. Resolves the file's
// pieces (header first) for one Blob, and what went in.
// `veilFor(id)` is this browser's Veil map for a saved chat, if it has one.
export async function makeBackup({ api, engine, passphrase, include, vaultChats = [], veilFor = null, created = Date.now(), onProgress, signal }) {
  const counts = {};
  const pieces = [];
  await engine.start(passphrase, created);
  const push = async (items) => {
    if (!items.length) return;
    check(signal);
    for (const part of await engine.push(items)) pieces.push(part);
  };
  await push([{ t: "manifest", format: BACKUP_FORMAT, version: BACKUP_VERSION, created: new Date(created).toISOString() }]);
  const settings = ["projects", "scrolls", "instructions", "memory", "routines", "research", "watches", "bookmarks", "characters", "subtitles"];
  if (settings.some((k) => include.has(k))) {
    onProgress?.({ step: "content" });
    const c = await api("/api/account/backup/content", { signal });
    const add = async (kind, list, t) => {
      if (!include.has(kind) || !Array.isArray(list) || !list.length) return;
      for (let i = 0; i < list.length; i += 200) await push(list.slice(i, i + 200).map((x) => ({ t, ...x })));
      counts[kind] = list.length;
    };
    await add("projects", c.projects, "project");
    await add("scrolls", c.scrolls, "scroll");
    await add("instructions", c.instructions ? [c.instructions] : [], "instructions");
    await add("memory", c.memory, "memory");
    await add("routines", c.routines, "routine");
    await add("research", c.research, "research");
    await add("watches", c.watches, "watch");
    // Characters with their pictures (never their copy links), and saved
    // subtitle sets with their cues.
    await add("characters", c.characters, "character");
    await add("subtitles", c.subtitles, "subtitles");
    // Bookmarks point at messages, so they go only with the chats.
    if (include.has("chats")) await add("bookmarks", c.bookmarks, "bookmark");
  }
  if (include.has("chats")) {
    let after = null;
    counts.chats = 0;
    do {
      check(signal);
      const page = await api("/api/account/backup/chats" + (after != null ? "?after=" + encodeURIComponent(after) : ""), { signal });
      await push(
        page.chats.map((chat) => {
          const veil = veilState(veilFor?.(chat.id));
          return { t: "chat", ...chat, ...(veil ? { veil } : {}) };
        }),
      );
      counts.chats += page.chats.length;
      onProgress?.({ step: "chats", done: counts.chats });
      after = page.next ?? null;
    } while (after != null);
  }
  if (include.has("vault") && vaultChats.length) {
    for (let i = 0; i < vaultChats.length; i += 50) await push(vaultChats.slice(i, i + 50).map((chat) => ({ t: "vault", chat })));
    counts.vault = vaultChats.length;
  }
  check(signal);
  onProgress?.({ step: "sealing" });
  const done = await engine.finish();
  const file = [done.header, ...pieces, ...done.parts];
  return { pieces: file, counts, bytes: file.reduce((n, p) => n + p.byteLength, 0) };
}

// ---- Restoring -----------------------------------------------------------------------
// A request that can't go on: the network, the session, the rate limit or
// the server. Anything else (a 400, 403 or 409 about one item) skips that
// item with its reason and the restore carries on.
const fatal = (e) =>
  e?.name === "AbortError" || e?.code === "stopped" || !e?.status || e.status === 401 || e.status === 429 || e.status >= 500;
const REASONS = {
  duplicate: "duplicate",
  already: "duplicate",
  watch_exists: "duplicate",
  seed_phrase_blocked: "seed",
  conversation_limit: "limit",
  scroll_limit: "limit",
  project_limit: "limit",
  routine_limit: "limit",
  watch_limit: "limit",
  memory_full: "limit",
  bookmark_limit: "limit",
  character_limit: "limit",
  subtitles_limit: "limit",
};
async function all(engine, kind) {
  const out = [];
  for (let start = 0; ; start += 200) {
    const slice = await engine.get(kind, start, 200);
    out.push(...slice);
    if (slice.length < 200) return out;
  }
}

// Adds the chosen kinds to this account (and Device Vault chats to this
// browser's vault), in order: projects, chats with their bookmarks,
// scrolls, standing instructions, memory, routines, research watches, page
// watches, vault chats. Never replaces or deletes anything: what's already
// here is skipped. Routines and watches come back switched off. Resolves a
// report per kind ({ added, duplicate, seed, limit, failed, message }) and
// the error that stopped it, if one did. Chats also say how many came back
// as ordinary chats because their mode isn't live here (fallback, and which
// modes), and bookmarks how many were skipped because their chat wasn't
// restored (unlinked).
// `saveVeil(id, state)` puts a restored chat's Veil map back in this browser
// under its new id (never sent anywhere).
export async function restoreBackup({ api, engine, choice, allowSeed = new Set(), vault = null, saveVeil = null, onProgress, signal }) {
  const report = {};
  const tally = (kind) => (report[kind] ||= { added: 0, duplicate: 0, seed: 0, limit: 0, failed: 0, message: null });
  const skip = (kind, e) => {
    const r = tally(kind);
    const why = REASONS[e?.code];
    if (why) r[why]++;
    else {
      r.failed++;
      r.message ||= e?.message || null;
    }
  };
  const held = (kind, item) => item.seed && !allowSeed.has(kind);
  const step = (kind) => onProgress?.({ kind, ...tally(kind) });
  let error = null;
  const projectIds = new Map();
  try {
    // Projects first, so chats can go back into them.
    if (choice.has("projects")) {
      const r = tally("projects");
      const have = new Map(((await api("/api/projects", { signal })).projects || []).map((p) => [projectKey(p), p.id]));
      for (const p of await all(engine, "projects")) {
        check(signal);
        const key = projectKey(p);
        if (have.has(key)) {
          r.duplicate++;
          if (p.id) projectIds.set(p.id, have.get(key));
          continue;
        }
        if (held("projects", p)) {
          r.seed++;
          continue;
        }
        const full = { name: p.name.trim(), color: p.color, instructions: p.instructions, privacy: p.starts, model: p.model };
        let made = null;
        for (const body of [full, { name: p.name.trim(), instructions: p.instructions }]) {
          try {
            made = await api("/api/projects", { method: "POST", body, signal });
            break;
          } catch (e) {
            if (fatal(e)) throw e;
            // A default model, color or start that this account can't use
            // any more: once more with the name and instructions alone.
            if (body === full && ["invalid_model", "invalid_project", "feature_unreleased", "private_model_required"].includes(e.code)) continue;
            skip("projects", e);
            break;
          }
        }
        if (made?.id) {
          r.added++;
          have.set(key, made.id);
          if (p.id) projectIds.set(p.id, made.id);
        }
        step("projects");
      }
    }

    if (choice.has("chats")) {
      const r = tally("chats");
      r.fallback = 0;
      r.modes = [];
      // Bookmarks ride on the message they marked, so each lands on that
      // message of its restored chat. One whose chat isn't restored (already
      // here, held back, over the limit) is skipped and counted.
      const notes = new Map();
      if (choice.has("bookmarks"))
        for (const b of await all(engine, "bookmarks")) if (!notes.has(b.message_id)) notes.set(b.message_id, b.note || "");
      const marks = choice.has("bookmarks") ? tally("bookmarks") : null;
      if (marks) marks.unlinked = 0;
      const marked = (c) => c.messages.filter((m) => m.id && notes.has(m.id)).length;
      for (let start = 0; ; start += 40) {
        const slice = await engine.get("chats", start, 40);
        if (!slice.length) break;
        const going = [];
        for (const c of slice) {
          if (held("chats", c)) {
            r.seed++;
            if (marks) marks.unlinked += marked(c);
          } else going.push(c);
        }
        const from = new Map();
        const shaped = going.map((c) => {
          const shape = restoreShape(c, { project: projectIds.get(c.project) || null, notes, allowSeed: !!c.seed });
          from.set(shape, c);
          return shape;
        });
        for (const batch of planBatches(shaped)) {
          check(signal);
          const answer = await api("/api/account/backup/restore/chats", { method: "POST", body: { chats: batch }, signal });
          for (const s of answer.saved || []) {
            r.added++;
            const item = from.get(batch[s.index]);
            if (item?.veil && s.id) saveVeil?.(s.id, item.veil);
            // Kept as an ordinary chat: its mode isn't live on this server.
            if (s.mode_fallback) {
              r.fallback++;
              if (!r.modes.includes(s.mode_fallback)) r.modes.push(s.mode_fallback);
            }
            if (marks) {
              const sent = batch[s.index].messages.filter((m) => m.bookmark != null).length;
              marks.added += s.bookmarks || 0;
              // The account's bookmark limit.
              marks.limit += Math.max(0, sent - (s.bookmarks || 0));
            }
          }
          for (const s of answer.skipped || []) {
            skip("chats", { code: s.reason });
            if (marks) marks.unlinked += batch[s.index].messages.filter((m) => m.bookmark != null).length;
          }
          step("chats");
        }
        if (slice.length < 40) break;
      }
    }

    if (choice.has("scrolls")) {
      const list = await all(engine, "scrolls");
      const r = tally("scrolls");
      const going = list.filter((s) => (held("scrolls", s) ? (r.seed++, false) : true));
      for (let i = 0; i < going.length; i += 100) {
        check(signal);
        const batch = going.slice(i, i + 100);
        const answer = await api("/api/account/backup/restore/scrolls", {
          method: "POST",
          body: { scrolls: batch.map((s) => ({ title: s.title, body: s.body, created: s.created, ...(s.seed ? { allow_seed_phrase: true } : {}) })) },
          signal,
        });
        r.added += (answer.saved || []).length;
        for (const s of answer.skipped || []) skip("scrolls", { code: s.reason });
        step("scrolls");
      }
    }

    if (choice.has("instructions")) {
      const [mine] = await all(engine, "instructions");
      const r = tally("instructions");
      if (mine) {
        const here = await api("/api/instructions", { signal });
        // One per account: yours stay if you have some.
        if (here.body?.trim()) r.duplicate++;
        else if (held("instructions", mine)) r.seed++;
        else {
          try {
            await api("/api/instructions", { method: "PUT", body: { body: mine.body, enabled: mine.enabled }, signal });
            r.added++;
          } catch (e) {
            if (fatal(e)) throw e;
            skip("instructions", e);
          }
        }
      }
    }

    // One item at a time through the kind's own route.
    const oneByOne = async (kind, { list: listPath, key, have, post, body }) => {
      const r = tally(kind);
      const keys = new Set(have(await api(listPath, { signal })).map(key));
      for (const item of await all(engine, kind)) {
        check(signal);
        if (keys.has(key(item))) {
          r.duplicate++;
          continue;
        }
        if (held(kind, item)) {
          r.seed++;
          continue;
        }
        try {
          await api(post, { method: "POST", body: body(item), signal });
          r.added++;
          keys.add(key(item));
        } catch (e) {
          if (fatal(e)) throw e;
          skip(kind, e);
          // The account is full: the rest won't fit either.
          if (REASONS[e.code] === "limit") break;
        }
        step(kind);
      }
    };
    if (choice.has("memory"))
      await oneByOne("memory", {
        list: "/api/memory",
        have: (a) => a.facts || [],
        key: memoryKey,
        post: "/api/memory/facts",
        body: (f) => ({ text: f.text, enabled: f.enabled }),
      });
    // Routines and watches come back switched off, so nothing runs or
    // spends until the person turns them on again.
    if (choice.has("routines"))
      await oneByOne("routines", {
        list: "/api/routines",
        have: (a) => a.routines || [],
        key: routineKey,
        post: "/api/routines",
        body: (x) => ({
          name: x.name,
          prompt: x.prompt,
          model: x.model,
          web_search: x.web_search,
          private_only: x.private_only,
          schedule: x.schedule,
          per_run_credits: x.per_run_credits,
          monthly_budget_credits: x.monthly_budget_credits,
          enabled: false,
        }),
      });
    if (choice.has("research"))
      await oneByOne("research", {
        list: "/api/research-watches",
        have: (a) => a.watches || [],
        key: routineKey,
        post: "/api/research-watches",
        body: (x) => ({
          ...(x.name ? { name: x.name } : {}),
          topic: x.topic,
          model: x.model,
          depth: x.depth,
          new_only: x.new_only,
          private_only: x.private_only,
          schedule: x.schedule,
          monthly_budget_credits: x.monthly_budget_credits,
          enabled: false,
        }),
      });
    if (choice.has("watches"))
      await oneByOne("watches", {
        list: "/api/watches",
        have: (a) => a.watches || [],
        key: watchKey,
        post: "/api/watches",
        body: (x) => ({
          url: x.url,
          hint: x.hint || "",
          model: x.model,
          private_only: x.private_only,
          every: x.every,
          monthly_budget_credits: x.monthly_budget_credits,
          enabled: false,
        }),
      });

    // Characters, through their own route: added, never replacing one that's
    // here (the same name and words), with their pictures and never a copy
    // link. A default model or picture this account can't use is left off.
    if (choice.has("characters")) {
      const r = tally("characters");
      const have = new Set(((await api("/api/characters", { signal })).characters || []).map(characterKey));
      const without = ["invalid_model", "early_model", "feature_unreleased", "private_model_required", "invalid_avatar"];
      for (const c of await all(engine, "characters")) {
        check(signal);
        const key = characterKey(c);
        if (have.has(key)) {
          r.duplicate++;
          continue;
        }
        if (held("characters", c)) {
          r.seed++;
          continue;
        }
        const full = { name: c.name.trim(), description: c.description, instructions: c.instructions, opening: c.opening, model: c.model || null, avatar: c.avatar ?? null };
        const tries = [full, { ...full, model: null }, { ...full, model: null, avatar: null }];
        let added = false,
          accountFull = false;
        for (const body of tries) {
          try {
            await api("/api/characters", { method: "POST", body, signal });
            added = true;
            break;
          } catch (e) {
            if (fatal(e)) throw e;
            if (without.includes(e.code) && body !== tries[tries.length - 1]) continue;
            skip("characters", e);
            accountFull = REASONS[e.code] === "limit";
            break;
          }
        }
        if (added) {
          r.added++;
          have.add(key);
        }
        step("characters");
        // The account is full: the rest won't fit either.
        if (accountFull) break;
      }
    }

    // Saved subtitle sets, through their own route: added, never replacing
    // one that's here (the same title, length and cues). Only a set here
    // with the same title and length is read whole to compare.
    if (choice.has("subtitles")) {
      const r = tally("subtitles");
      const list = (await api("/api/subtitles/sets", { signal })).data || [];
      const near = (x) => `${String(x.title ?? "").replace(/\s+/g, " ").trim().toLowerCase()}\u0000${Math.round(Number(x.duration) * 1000)}`;
      const unread = new Map();
      for (const x of list) unread.set(near(x), [...(unread.get(near(x)) || []), x.id]);
      const keys = new Set();
      for (const set of await all(engine, "subtitles")) {
        check(signal);
        for (const id of unread.get(near(set)) || [])
          keys.add(subtitleKey(await api("/api/subtitles/sets/" + encodeURIComponent(id), { signal })));
        unread.delete(near(set));
        const key = subtitleKey(set);
        if (keys.has(key)) {
          r.duplicate++;
          continue;
        }
        if (held("subtitles", set)) {
          r.seed++;
          continue;
        }
        try {
          await api("/api/subtitles/sets", {
            method: "POST",
            body: { title: set.title, duration: set.duration, language: set.language, tracks: set.tracks },
            signal,
          });
          r.added++;
          keys.add(key);
        } catch (e) {
          if (fatal(e)) throw e;
          skip("subtitles", e);
          if (REASONS[e.code] === "limit") break;
        }
        step("subtitles");
      }
    }

    // Device Vault chats go back into this browser's vault, sealed with its
    // key; nothing is sent.
    if (choice.has("vault") && vault?.unlocked) {
      const r = tally("vault");
      const ids = new Set(vault.chats.map((c) => c.id));
      const keys = new Set(vault.chats.map(vaultKey));
      const fresh = [];
      for (const { chat } of await all(engine, "vault")) {
        const key = vaultKey(chat);
        if (ids.has(chat.id) || keys.has(key)) r.duplicate++;
        else {
          fresh.push(chat);
          ids.add(chat.id);
          keys.add(key);
        }
      }
      for (let i = 0; i < fresh.length; i += 50) {
        check(signal);
        await vault.saveMany(fresh.slice(i, i + 50));
        r.added += Math.min(50, fresh.length - i);
        step("vault");
      }
    }
  } catch (e) {
    error = e;
  }
  return { report, error };
}
