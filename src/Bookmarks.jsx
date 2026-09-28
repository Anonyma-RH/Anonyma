import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Star } from "lucide-react";
import { api, isReleased } from "./lib.js";
import { Notice } from "./ui.jsx";
import { loadVeilState, unveil } from "./veil.js";
import { findSeedPhrase, SEED_MESSAGE } from "./seed-guard.js";
import {
  MAX_BOOKMARKS,
  MAX_NOTE,
  bookmarkLink,
  canBookmark,
  normalizeNote,
  savedIdAt,
} from "./bookmarks.js";
import { MathText, diagramsReleased } from "./RichMarkdown.jsx";
import "./bookmarks.css";

// Bookmarks (server/routes/bookmarks.js): a star under a saved message, an
// optional private note, and the Bookmarks tab in Your library that lists
// them and opens each one at its message. Signed-in accounts only, once the
// update is released; never in the demo, off the record, in Private Mode or
// in a Device Vault chat, none of which are saved on the server.
export const bookmarksReleased = (config) => isReleased(config, "bookmarks");
export const BOOKMARKS_TAB = { libraryTab: "bookmarks" };

function StarIcon({ on, size = 13 }) {
  return (
    <Star
      size={size}
      strokeWidth={1.8}
      fill={on ? "currentColor" : "none"}
      aria-hidden="true"
    />
  );
}

// A note's text, checked in this browser first: with Seed Guard live, a seed
// phrase never leaves it (the server refuses one too).
function noteProblem(text, config) {
  if (text.length > MAX_NOTE) return `Keep a note to ${MAX_NOTE} characters.`;
  if (isReleased(config, "seedguard") && findSeedPhrase(text)) return SEED_MESSAGE;
  return "";
}

function NoteForm({ initial, config, busy, onSave, onCancel }) {
  const [text, setText] = useState(initial || "");
  const clean = normalizeNote(text);
  const problem = noteProblem(clean, config);
  return (
    <form
      className="bookmark-note-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) onSave(clean);
      }}
    >
      <label>
        <span>Private note</span>
        <input
          value={text}
          maxLength={MAX_NOTE}
          autoFocus
          data-i18n="off"
          aria-label="Private note"
          placeholder="Why this one matters…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
        />
      </label>
      <small aria-live="polite">
        {clean.length}/{MAX_NOTE}
      </small>
      {problem && <p className="bookmark-error" role="alert">{problem}</p>}
      <div className="bookmark-note-actions">
        <button type="button" className="small-button" onClick={onCancel}>
          Cancel
        </button>
        <button className="small-button primary" disabled={busy || !!problem}>
          Save note
        </button>
      </div>
    </form>
  );
}

// The open conversation's bookmarks, and the star and note under each message.
// `context` is what decides whether a star can show at all (see canBookmark).
export function useBookmarks({ enabled, account, conversation, context, config }) {
  const [list, setList] = useState([]),
    // Ids of just-sent messages, looked up on their first star.
    [resolved, setResolved] = useState({}),
    [editing, setEditing] = useState(null),
    [problem, setProblem] = useState(null),
    [flash, setFlash] = useState(null),
    [pending, setPending] = useState(null);
  const lock = useRef(false),
    flashTimer = useRef();
  const key = enabled && conversation ? account + ":" + conversation : null;
  useEffect(() => {
    setList([]);
    setResolved({});
    setEditing(null);
    setProblem(null);
    setFlash(null);
    if (!key) return;
    const ctl = new AbortController();
    api(
      `/api/bookmarks?conversation=${encodeURIComponent(conversation)}&limit=${MAX_BOOKMARKS}`,
      { signal: ctl.signal },
    )
      .then((r) => setList(r.data))
      .catch(() => {});
    return () => ctl.abort();
  }, [key]);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const byMessage = useMemo(
    () => new Map(list.map((b) => [b.message_id, b])),
    [list],
  );
  const idOf = (m, i) => m.id || resolved[i] || null;
  const shows = (m, i) =>
    !!key &&
    canBookmark({ ...context, message: m, conversation }) &&
    // A just-sent message's id can only be looked up once its reply is saved.
    !!(idOf(m, i) || !context.busy);

  async function toggle(m, i, messages) {
    if (lock.current || !key) return;
    lock.current = true;
    setPending(i);
    setProblem(null);
    try {
      let id = idOf(m, i);
      const existing = id && byMessage.get(id);
      if (existing) {
        await api("/api/bookmarks/" + encodeURIComponent(existing.id), { method: "DELETE" });
        setList((l) => l.filter((b) => b.id !== existing.id));
        setEditing((e) => (e === id ? null : e));
        setFlash(null);
        return;
      }
      if (!id) {
        const saved = await api("/api/conversations/" + encodeURIComponent(conversation));
        id = savedIdAt(messages, saved.messages, i);
        if (!id) throw Error("Reopen this chat to bookmark this message.");
        setResolved(Object.fromEntries(saved.messages.map((x, j) => [j, x.id])));
      }
      const b = await api("/api/bookmarks", { method: "POST", body: { message_id: id } });
      setList((l) => [b, ...l.filter((x) => x.id !== b.id)]);
      setFlash(id);
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), 6000);
    } catch (e) {
      setProblem({ index: i, text: e.message });
    } finally {
      lock.current = false;
      setPending(null);
    }
  }
  async function saveNote(b, i, note) {
    if (lock.current) return;
    lock.current = true;
    setPending(i);
    setProblem(null);
    try {
      const next = await api("/api/bookmarks/" + encodeURIComponent(b.id), {
        method: "PATCH",
        body: { note },
      });
      setList((l) => l.map((x) => (x.id === next.id ? next : x)));
      setEditing(null);
    } catch (e) {
      setProblem({ index: i, text: e.message });
    } finally {
      lock.current = false;
      setPending(null);
    }
  }

  // The star (and, once starred, the note button) for a message's action row.
  function actions(m, i, messages) {
    if (!shows(m, i)) return null;
    const id = idOf(m, i);
    const b = id ? byMessage.get(id) : null;
    return (
      <>
        <button
          type="button"
          className={"bookmark-star" + (b ? " on" : "")}
          aria-pressed={!!b}
          disabled={pending === i}
          title={b ? "Remove this bookmark" : "Bookmark this message"}
          onClick={() => toggle(m, i, messages)}
        >
          <StarIcon on={!!b} />
          {b ? "Bookmarked" : "Bookmark"}
        </button>
        {b && editing !== id && (
          <button type="button" className="bookmark-note-button" onClick={() => setEditing(id)}>
            {b.note ? "Edit note" : "Add note"}
          </button>
        )}
      </>
    );
  }
  // Below the actions: the note, its form, a problem, or where to find it.
  function details(m, i) {
    if (!key) return null;
    const id = idOf(m, i);
    const b = id ? byMessage.get(id) : null;
    const trouble = problem?.index === i ? problem.text : "";
    if (!b && !trouble) return null;
    return (
      <div className="bookmark-details">
        {trouble && <p className="bookmark-error" role="alert">{trouble}</p>}
        {b && editing === id ? (
          <NoteForm
            initial={b.note}
            config={config}
            busy={pending === i}
            onSave={(note) => saveNote(b, i, note)}
            onCancel={() => setEditing(null)}
          />
        ) : b?.note ? (
          <p className="bookmark-note">
            <StarIcon on size={12} />
            <span data-i18n="off">{b.note}</span>
          </p>
        ) : null}
        {b && flash === id && editing !== id && (
          <p className="bookmark-flash" role="status">
            Saved to your bookmarks.{" "}
            <Link to="/workspace/library" state={BOOKMARKS_TAB}>
              See all bookmarks
            </Link>
          </p>
        )}
      </div>
    );
  }
  return { actions, details, count: list.length };
}

const FILTERS = [
  ["all", "All"],
  ["assistant", "Answers"],
  ["user", "Prompts"],
  ["noted", "With notes"],
];

// A bookmark as a card: what was said, where, when, and your note.
export function BookmarkCard({ b, modelName, demo, busy, editing, config, onEdit, onCancel, onSave, onRemove }) {
  const veilMap = useMemo(() => loadVeilState(b.conversation_id).map, [b.conversation_id]);
  const excerpt = unveil(b.excerpt, veilMap);
  // Math & Diagrams: equations in an answer's excerpt are typeset, and a
  // diagram (left out of the excerpt by the server) shows as a tag.
  const rich = b.role === "assistant" && diagramsReleased(config);
  const diagram = rich && b.diagram === true;
  return (
    <article className="bookmark-card">
      <div className="bookmark-card-head">
        <span className="bookmark-kind">
          <StarIcon on size={14} />
          {b.role === "assistant" ? (
            "Answer"
          ) : b.author ? (
            <>
              Prompt by <span data-i18n="off">{b.author}</span>
            </>
          ) : (
            "Your prompt"
          )}
          {diagram && <span className="bookmark-diagram-tag">Diagram</span>}
        </span>
        {b.role === "assistant" && b.model && (
          <span className="bookmark-model" data-i18n="off">
            {modelName || b.model}
          </span>
        )}
        <time dateTime={new Date(b.message_created).toISOString()}>
          {new Date(b.message_created).toLocaleDateString()}
        </time>
      </div>
      {excerpt ? (
        <p className="bookmark-excerpt" data-i18n="off">
          <MathText text={excerpt} live={rich} />
        </p>
      ) : diagram ? null : (
        <p className="bookmark-excerpt empty">An image or attachment, without text.</p>
      )}
      {editing ? (
        <NoteForm initial={b.note} config={config} busy={busy} onSave={onSave} onCancel={onCancel} />
      ) : (
        b.note && (
          <p className="bookmark-note">
            <span className="bookmark-note-label">Note</span>
            <span data-i18n="off">{b.note}</span>
          </p>
        )
      )}
      <div className="bookmark-card-foot">
        <span className="bookmark-where">
          <span>In</span> <strong data-i18n="off">{b.conversation_title}</strong>
          {b.collab && (
            <>
              {" · "}
              <span>Shared in</span> <span data-i18n="off">{b.collab.name}</span>
            </>
          )}
        </span>
        {b.expires && (
          <span className="bookmark-expires">
            Auto-deletes with its chat on {new Date(b.expires).toLocaleDateString()}
          </span>
        )}
        <span className="bookmark-card-actions">
          <Link className="small-button primary" to={bookmarkLink(b, { demo })}>
            Open at message
          </Link>
          {!editing && (
            <button type="button" className="small-button" disabled={busy} onClick={onEdit}>
              {b.note ? "Edit note" : "Add note"}
            </button>
          )}
          <button type="button" className="small-button" disabled={busy} onClick={onRemove}>
            Remove
          </button>
        </span>
      </div>
    </article>
  );
}

// Your library → Bookmarks: every bookmark this account can still read,
// newest first, with search and filters.
export default function BookmarksPanel({ user, demo, config, models = [] }) {
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [items, setItems] = useState([]),
    [next, setNext] = useState(null),
    [total, setTotal] = useState(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(null),
    [busy, setBusy] = useState(null);
  const ctl = useRef(null),
    mounted = useRef(true);
  const signedIn = !demo && !!user;
  useEffect(
    () => () => {
      mounted.current = false;
      ctl.current?.abort();
    },
    [],
  );
  async function load(offset = 0) {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ limit: "30", offset: String(offset) });
    if (query.trim()) params.set("q", query.trim().slice(0, 160));
    if (filter === "noted") params.set("noted", "1");
    else if (filter !== "all") params.set("role", filter);
    try {
      const r = await api("/api/bookmarks?" + params, { signal: c.signal });
      if (c.signal.aborted || !mounted.current) return;
      setItems((prev) => (offset ? [...prev, ...r.data] : r.data));
      setNext(r.nextOffset);
      setTotal(r.total);
    } catch (e) {
      if (!c.signal.aborted && mounted.current) setError(e.message);
    } finally {
      if (!c.signal.aborted && mounted.current) setLoading(false);
    }
  }
  // Typing searches after a short pause; a filter applies at once.
  useEffect(() => {
    if (!signedIn) return;
    const t = setTimeout(() => load(0), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, filter, signedIn, user?.id]);
  async function remove(b) {
    setBusy(b.id);
    setError("");
    try {
      await api("/api/bookmarks/" + encodeURIComponent(b.id), { method: "DELETE" });
      setItems((l) => l.filter((x) => x.id !== b.id));
      setTotal((n) => (n == null ? n : Math.max(0, n - 1)));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }
  async function saveNote(b, note) {
    setBusy(b.id);
    setError("");
    try {
      const saved = await api("/api/bookmarks/" + encodeURIComponent(b.id), {
        method: "PATCH",
        body: { note },
      });
      setItems((l) => l.map((x) => (x.id === saved.id ? saved : x)));
      setEditing(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }
  if (!signedIn)
    return (
      <div className="bookmarks-panel">
        <p>
          Sign in to bookmark messages. Bookmarks are kept with your account,
          and only you can see them.
        </p>
      </div>
    );
  const name = (id) => models.find((m) => m.id === id)?.name;
  return (
    <div className="bookmarks-panel">
      <p>
        Star any message in a saved chat to keep it here. Only you see your
        bookmarks and notes, even in shared Collab chats. Off-the-record and
        Private chats aren’t saved, so they can’t be bookmarked.
      </p>
      <form
        className="history-search bookmarks-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          load(0);
        }}
      >
        <label htmlFor="bookmark-query">Search bookmarks</label>
        <div>
          <input
            id="bookmark-query"
            value={query}
            maxLength={160}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="A word from the message, the chat or your note…"
          />
        </div>
      </form>
      <div className="filter-tabs bookmark-filters">
        {FILTERS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={filter === id ? "active" : ""}
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {total != null && (
        <p className="result-count bookmark-count">
          {total === 1
            ? `1 bookmark · up to ${MAX_BOOKMARKS.toLocaleString("en-US")}`
            : `${total.toLocaleString("en-US")} bookmarks · up to ${MAX_BOOKMARKS.toLocaleString("en-US")}`}
        </p>
      )}
      {error && <Notice type="error">{error}</Notice>}
      <div className="bookmark-list" aria-live="polite" aria-busy={loading}>
        {items.map((b) => (
          <BookmarkCard
            key={b.id}
            b={b}
            modelName={name(b.model)}
            demo={demo}
            config={config}
            busy={busy === b.id}
            editing={editing === b.id}
            onEdit={() => setEditing(b.id)}
            onCancel={() => setEditing(null)}
            onSave={(note) => saveNote(b, note)}
            onRemove={() => remove(b)}
          />
        ))}
      </div>
      {!loading && !items.length && total != null && (
        <p className="bookmark-empty">
          {total === 0
            ? "No bookmarks yet. Star a message in any saved chat and it will wait for you here."
            : "No bookmarks match."}
        </p>
      )}
      {next !== null && (
        <button className="button" disabled={loading} onClick={() => load(next)}>
          Load more bookmarks
        </button>
      )}
    </div>
  );
}
