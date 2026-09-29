import { chatLimits } from "../data/chat-limits.js";
import { isReleased } from "./releases.js";
import { chatPrice, fail, now, transaction } from "./core.js";
import { cleanText, findPhrases, projectVisible, scanInvisible } from "../src/shield.js";
import {
  CHUNKER_EPOCH,
  FILE_SEARCH_BUDGET,
  LIMITS,
  bm25Rank,
  chunkText,
  fileSearchMessages,
  ftsMatch,
  scopeOf,
  segment,
} from "../src/file-search.js";

// File Search (update "filesearch"): an index over the text of an account's
// saved files, and what one answer can cost. The routes are in
// server/routes/file-search.js; what the browser shares is in
// src/file-search.js.
//
// The index is file_chunks (each file's text as passages, with a section
// label) and file_index (which files have been read into it), filled the
// first time someone searches or lists their files and kept per account:
// every query names the account. SQLite's FTS5 finds the passages that have
// a word of the question where Node's SQLite has it (file_chunks_fts, with
// each account's passages under one scope word), else every stored passage is
// a candidate; bm25Rank in src/file-search.js then ranks them, the same way
// for both. Deleting a file, its expiry and every erase remove its
// passages (a foreign key) and, by a trigger, its words from the FTS index.
// Hidden characters are taken out of a file's text before it is cut up
// (Injection Shield's own check), so a passage is exactly what is shown and
// sent. Nothing about a question is stored or logged.

// "fts5" when the full-text index exists (and isn't switched off for a
// test), else "js".
export const engineOf = (db, cfg) =>
  cfg?.fileSearchEngine === "js"
    ? "js"
    : db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='file_chunks_fts'").get()
      ? "fts5"
      : "js";

// Reads every one of the account's saved documents that isn't in the index
// yet (or isn't in the full-text index under the FTS5 engine, or was read
// before the passages were cut as they are now) into it. One
// transaction per file, each checked again inside, so it's safe to repeat.
export function ensureIndexed(db, cfg, user) {
  const engine = engineOf(db, cfg);
  const todo = db
    .prepare(
      `SELECT u.id FROM uploads u LEFT JOIN file_index i ON i.upload_id=u.id
       WHERE u.user_id=? AND u.kind='document' AND u.text IS NOT NULL AND u.expires>?
         AND (i.upload_id IS NULL OR i.indexed<? OR (i.fts=0 AND ?=1))`,
    )
    .all(user, now(), CHUNKER_EPOCH, engine === "fts5" ? 1 : 0);
  for (const { id } of todo)
    transaction(db, () => {
      const up = db
        .prepare("SELECT id,name,text FROM uploads WHERE id=? AND user_id=? AND kind='document' AND text IS NOT NULL AND expires>?")
        .get(id, user, now());
      if (!up) return;
      const have = db.prepare("SELECT fts,indexed FROM file_index WHERE upload_id=?").get(id);
      if (have && have.indexed >= CHUNKER_EPOCH && (have.fts === 1 || engine !== "fts5")) return;
      // A file read before under another engine, or before passages were cut
      // as they are now, is read again from scratch.
      db.prepare("DELETE FROM file_chunks WHERE upload_id=?").run(id);
      const text = cleanText(up.text, { text: up.text, invisible: scanInvisible(up.text) });
      const insert = db.prepare("INSERT INTO file_chunks(upload_id,user_id,ord,kind,section,text) VALUES(?,?,?,?,?,?)");
      const words = engine === "fts5" ? db.prepare("INSERT INTO file_chunks_fts(rowid,body,scope) VALUES(?,?,?)") : null;
      // Prose files (text, Markdown, Word) may have plain-text headings.
      const chunks = chunkText(text, { plain: /\.(txt|md|markdown|docx)$/i.test(up.name) });
      for (const c of chunks) {
        const { lastInsertRowid } = insert.run(id, user, c.ord, c.kind, c.section, c.text);
        words?.run(lastInsertRowid, segment(c.text), scopeOf(user));
      }
      db.prepare("INSERT OR REPLACE INTO file_index(upload_id,user_id,chunks,fts,indexed) VALUES(?,?,?,?,?)").run(
        id,
        user,
        chunks.length,
        engine === "fts5" ? 1 : 0,
        now(),
      );
    });
}

// The account's searchable files: saved documents that hold text, newest
// first, with how many passages each has.
export function searchableFiles(db, cfg, user) {
  ensureIndexed(db, cfg, user);
  return db
    .prepare(
      `SELECT u.id,u.name,u.bytes,u.truncated,u.created,u.expires,i.chunks passages
       FROM uploads u JOIN file_index i ON i.upload_id=u.id
       WHERE u.user_id=? AND u.kind='document' AND u.expires>? ORDER BY u.created DESC,u.id`,
    )
    .all(user, now())
    .map((f) => ({ ...f, truncated: !!f.truncated }));
}

// The saved files a project pins (whether or not they hold text).
export function pinnedIds(db, user, project) {
  return db
    .prepare("SELECT upload_id FROM project_files WHERE project_id=? AND user_id=? ORDER BY added,rowid")
    .all(project, user)
    .map((r) => r.upload_id);
}

const inList = (list) => list.map(() => "?").join(",");
// A passage's fields for the page and the run.
const view = (r) => ({ id: r.id, file_id: r.file_id, file: r.file, kind: r.kind, section: r.section, text: r.text });

// The best passages for a question among the account's files (or only the
// named ones), most relevant first. Never more than `limit`. The engine finds
// the passages that have any word of the question (FTS5: up to CANDIDATES of
// them, best first by its own BM25; JS: all of the scope's passages); the
// same scoring then ranks them (bm25Rank in src/file-search.js), so a rare
// word outweighs a common one and a match in a heading counts, whichever
// engine found them.
const CANDIDATES = 500;
export function searchPassages(db, cfg, user, question, { files = null, limit = LIMITS.top } = {}) {
  ensureIndexed(db, cfg, user);
  if (files && !files.length) return [];
  const filter = files ? ` AND c.upload_id IN (${inList(files)})` : "";
  const args = [user, user, now(), ...(files || [])];
  const scan = () =>
    bm25Rank(
      db
        .prepare(
          `SELECT c.id,c.upload_id file_id,u.name file,c.kind,c.section,c.text
           FROM file_chunks c JOIN uploads u ON u.id=c.upload_id
           WHERE c.user_id=? AND u.user_id=? AND u.expires>?${filter} ORDER BY c.id`,
        )
        .all(...args),
      question,
      limit,
    );
  let rows;
  if (engineOf(db, cfg) === "fts5") {
    const match = ftsMatch(question, scopeOf(user));
    if (!match) return [];
    try {
      const found = db
        .prepare(
          `SELECT c.id,c.upload_id file_id,u.name file,c.kind,c.section,c.text
           FROM file_chunks_fts f JOIN file_chunks c ON c.id=f.rowid JOIN uploads u ON u.id=c.upload_id
           WHERE file_chunks_fts MATCH ? AND c.user_id=? AND u.user_id=? AND u.expires>?${filter}
           ORDER BY bm25(file_chunks_fts,1.0,0.0),c.id LIMIT ?`,
        )
        .all(match, ...args, CANDIDATES);
      rows = bm25Rank(found, question, limit, { total: scopeSize(db, user, files).passages, keepUnscored: true });
    } catch {
      // A query the index can't read: the same passages, ranked in JS.
      rows = scan();
    }
  } else rows = scan();
  return rows.map((r) => ({
    ...view(r),
    // Instruction-like wording in the passage, counted by Injection Shield's
    // own phrases. The passage is still sent, as data, with the count shown.
    flagged: findPhrases(projectVisible(r.text).visible).length,
  }));
}

// How many files and passages a search covers, for "Searched 4 files".
export function scopeSize(db, user, files = null) {
  const filter = files ? ` AND c.upload_id IN (${inList(files)})` : "";
  const r = db
    .prepare(
      `SELECT COUNT(DISTINCT c.upload_id) files,COUNT(*) passages FROM file_chunks c JOIN uploads u ON u.id=c.upload_id
       WHERE c.user_id=? AND u.user_id=? AND u.expires>?${filter}`,
    )
    .get(user, user, now(), ...(files || []));
  return { files: r.files, passages: r.passages };
}

// The stored passages for these ids, if they're all the account's and their
// files are still there. Missing ones are left out of the map.
export function storedPassages(db, user, ids) {
  const rows = db
    .prepare(
      `SELECT c.id,c.upload_id file_id,u.name file,c.kind,c.section,c.text
       FROM file_chunks c JOIN uploads u ON u.id=c.upload_id
       WHERE c.id IN (${inList(ids)}) AND c.user_id=? AND u.user_id=? AND u.expires>?`,
    )
    .all(...ids, user, user, now());
  return new Map(rows.map((r) => [r.id, r]));
}

// Files the account names, checked: saved documents of its own, not expired.
export function ownedDocuments(db, user, ids) {
  if (
    !Array.isArray(ids) ||
    ids.length > LIMITS.files ||
    ids.some((id) => typeof id !== "string" || !id || id.length > 100) ||
    new Set(ids).size !== ids.length
  )
    fail(400, `Choose up to ${LIMITS.files} of your saved files.`, "invalid_request");
  if (!ids.length) return [];
  const found = db
    .prepare(`SELECT id FROM uploads WHERE id IN (${inList(ids)}) AND user_id=? AND kind='document' AND expires>?`)
    .all(...ids, user, now());
  if (found.length !== ids.length) fail(404, "File not found.");
  return ids;
}

// Every erase of an account's content (closure, Panic Wipe, Inactivity
// Wipe): the passages and the record of what was indexed. Their words leave
// the full-text index with them (a trigger, with the index's secure-delete
// option on).
export function forgetFileIndex(db, user) {
  db.prepare("DELETE FROM file_chunks WHERE user_id=?").run(user);
  db.prepare("DELETE FROM file_index WHERE user_id=?").run(user);
}

// The account export: each indexed file with its passages exactly as the
// index holds them (a copy of the text of the saved file, which is exported
// as an upload too).
export function exportFileIndex(db, user) {
  const chunks = db.prepare("SELECT ord,kind,section,text FROM file_chunks WHERE upload_id=? ORDER BY ord");
  return db
    .prepare(
      `SELECT u.id,u.name,i.indexed FROM file_index i JOIN uploads u ON u.id=i.upload_id
       WHERE i.user_id=? AND u.expires>? ORDER BY i.indexed,u.id`,
    )
    .all(user, now())
    .map((f) => ({
      file_id: f.id,
      name: f.name,
      indexed: f.indexed,
      passages: chunks.all(f.id).map((c) => ({ position: c.ord + 1, kind: c.kind, section: c.section, text: c.text })),
    }));
}

// ---- What an answer can cost ----

// The reply budget for this model: FILE_SEARCH_BUDGET within what /api/chat
// would allow it (its output limit once Longer Answers is live, else 8,192).
export function fileSearchBudget(cfg, m) {
  const cap = isReleased(cfg, "longanswers") ? chatLimits(m).maxOutputTokens : 8192;
  return Math.max(1, Math.min(FILE_SEARCH_BUDGET, cap));
}
// The most one answer can cost, in integer units at the account's rate: the
// question and passages as they are sent, and the whole reply budget. The
// quote, the "Up to" line, the checks and the hold all use this one figure.
// `passages` are { text, file }.
export function fileSearchCost({ cfg, m, question, passages, factor }) {
  const budget = fileSearchBudget(cfg, m);
  const messages = fileSearchMessages(question, passages);
  return { budget, messages, amount: chatPrice(m, messages, budget, 0, factor) };
}
