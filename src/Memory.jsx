import React, { useState, useRef, useEffect } from "react";
import { Icon, Modal, Button } from "./ui.jsx";
import {
  MAX_FACT_LENGTH,
  normalizeFact,
  factError,
  buildMemoryMessage,
  createMemoryGuard,
} from "./memory.js";
import "./memory.css";
import { api } from "./lib.js";

const EMPTY_MEMORY = { enabled: false, facts: [], limit: 50 };

export function useMemory(scope) {
  const guard = useRef(null);
  if (!guard.current) guard.current = createMemoryGuard();
  guard.current.update(scope);
  const [snapshot, setSnapshot] = useState({
    scope: null,
    value: EMPTY_MEMORY,
  });
  useEffect(() => {
    const current = guard.current.begin(scope);
    if (current())
      api("/api/memory")
        .then((value) => {
          if (current()) setSnapshot({ scope, value });
        })
        .catch(() => {});
    return () => guard.current.invalidate();
  }, [scope]);
  async function mutate(path, method, body) {
    const current = guard.current.begin(scope);
    if (!current()) throw new Error("Memory is unavailable in this context.");
    await api(path, { method, ...(body ? { body } : {}) });
    if (!current()) return;
    const value = await api("/api/memory");
    if (current()) setSnapshot({ scope, value });
  }
  return {
    memory:
      snapshot.scope === scope && scope != null ? snapshot.value : EMPTY_MEMORY,
    toggle: (enabled) => mutate("/api/memory/settings", "PUT", { enabled }),
    create: (body) => mutate("/api/memory/facts", "POST", body),
    update: (id, body) => mutate("/api/memory/facts/" + id, "PATCH", body),
    remove: (id) => mutate("/api/memory/facts/" + id, "DELETE"),
    clear: () => mutate("/api/memory", "DELETE"),
  };
}

// Memory Across Models: facts the user writes and chooses to share with every
// model. Opened from the composer's Memory button, or from "Remember" under a
// message in a saved chat (which pre-fills a draft). Facts are the user's own
// words, so they carry data-i18n="off" and stay as written in Chinese.
export function MemoryPanel({
  memory,
  draft: initialDraft = null,
  excluded = "",
  previewFacts = [],
  onClose,
  onToggle,
  onCreate,
  onUpdate,
  onDelete,
  onDeleteAll,
}) {
  const [draft, setDraft] = useState(initialDraft?.text ?? "");
  const [source, setSource] = useState(initialDraft?.source ?? null);
  const [editing, setEditing] = useState(null); // { id, text }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);
  const [showSent, setShowSent] = useState(false);
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async (fn) => {
    if (lock.current || excluded || !alive.current) return false;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      return alive.current;
    } catch (e) {
      if (alive.current) setError(e.message);
      return false;
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  async function add() {
    const text = normalizeFact(draft);
    const err = factError(text);
    if (err) return setError(err);
    if (
      await run(() =>
        onCreate({ text, ...(source ? { source_conversation: source } : {}) }),
      )
    ) {
      setDraft("");
      setSource(null);
    }
  }
  async function saveEdit() {
    const text = normalizeFact(editing.text);
    const err = factError(text);
    if (err) return setError(err);
    if (await run(() => onUpdate(editing.id, { text }))) setEditing(null);
  }
  const preview = buildMemoryMessage(previewFacts.map((f) => f.text));
  return (
    <Modal title="Memory" onClose={onClose}>
      <div className="memory-panel">
        <section className="memory-switch">
          <label className="scrolls-toggle">
            <input
              type="checkbox"
              checked={memory.enabled}
              disabled={busy}
              onChange={(e) => run(() => onToggle(e.target.checked))}
            />
            Use my memory in chats
          </label>
          <p className="scrolls-hint">
            Off until you switch it on. When on, the facts below go with each
            chat, code and Uncensored message, to whichever model you pick. Only
            what you write here is remembered: chats never add to memory on
            their own.
          </p>
          <p className="scrolls-hint memory-never">
            Never used or saved off the record, in Private Mode, in shared
            (collab) chats, in Symposium or Double-check, or over the API. With
            Veil on, facts are masked in your browser before they're sent.
          </p>
          <p className="scrolls-hint">
            Deleting a fact stops future use. Copies in existing answers remain.
          </p>
          {excluded && <p className="memory-excluded">{excluded}</p>}
        </section>

        <section className="memory-add">
          <h3>{source ? "Remember from this chat" : "Add a fact"}</h3>
          <textarea
            data-i18n="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_FACT_LENGTH * 2}
            rows={2}
            placeholder="e.g. I'm vegetarian. I prefer metric units. I write in British English."
          />
          <div className="memory-add-row">
            <span className="memory-count">
              {normalizeFact(draft).length}/{MAX_FACT_LENGTH}
            </span>
            <span className="memory-hint">
              Don't store passwords, keys, card or bank numbers.
            </span>
            <button
              type="button"
              className="small-button primary"
              onClick={add}
              disabled={busy}
            >
              <Icon name="plus" size={14} />
              Remember
            </button>
          </div>
        </section>

        {error && <p className="scrolls-error">{error}</p>}

        <section className="memory-list">
          <div className="scrolls-list-head">
            <h3>
              Your facts{" "}
              <span className="memory-count">
                {memory.facts.length}/{memory.limit || 50}
              </span>
            </h3>
            {memory.facts.length > 0 &&
              (confirmAll ? (
                <span className="memory-confirm">
                  {`Delete all ${memory.facts.length}?`}
                  <button
                    type="button"
                    className="small-button danger-text"
                    disabled={busy}
                    onClick={async () =>
                      (await run(onDeleteAll)) && setConfirmAll(false)
                    }
                  >
                    Delete all
                  </button>
                  <button
                    type="button"
                    className="small-button"
                    onClick={() => setConfirmAll(false)}
                  >
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="small-button danger-text"
                  onClick={() => setConfirmAll(true)}
                >
                  Delete all
                </button>
              ))}
          </div>
          {memory.facts.length === 0 ? (
            <p className="scrolls-empty">
              No facts yet. Add one above, or use Remember under your message in
              a saved chat.
            </p>
          ) : (
            <ul className="memory-items">
              {memory.facts.map((f) => (
                <li key={f.id} className={f.enabled ? "" : "paused"}>
                  {editing?.id === f.id ? (
                    <div className="memory-edit">
                      <textarea
                        aria-label="Edit fact"
                        data-i18n="off"
                        value={editing.text}
                        autoFocus
                        rows={2}
                        onChange={(e) =>
                          setEditing({ id: f.id, text: e.target.value })
                        }
                      />
                      <div className="scrolls-item-actions">
                        <button
                          type="button"
                          className="small-button primary"
                          disabled={busy}
                          onClick={saveEdit}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="small-button"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div>
                        <p className="memory-text" data-i18n="off">
                          {f.text}
                        </p>
                        <span className="memory-meta">
                          {f.enabled ? "In use" : "Paused"}
                          {f.source && (
                            <>
                              {" · Saved from "}
                              <span data-i18n="off">
                                {f.source.title || "a chat"}
                              </span>
                            </>
                          )}
                        </span>
                      </div>
                      <div className="scrolls-item-actions">
                        <button
                          type="button"
                          className="small-button"
                          disabled={busy}
                          onClick={() =>
                            run(() => onUpdate(f.id, { enabled: !f.enabled }))
                          }
                        >
                          {f.enabled ? "Pause" : "Resume"}
                        </button>
                        <button
                          type="button"
                          className="small-button"
                          onClick={() => setEditing({ id: f.id, text: f.text })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="small-button danger-text"
                          disabled={busy}
                          onClick={() => run(() => onDelete(f.id))}
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="memory-sent">
          <button
            type="button"
            className="small-button"
            onClick={() => setShowSent((v) => !v)}
          >
            <Icon name={showSent ? "eyeoff" : "eye"} size={14} />
            {showSent
              ? "Hide what models receive"
              : "Show exactly what models receive"}
          </button>
          {showSent &&
            (preview ? (
              <pre className="memory-preview" data-i18n="off">
                {preview.content}
              </pre>
            ) : (
              <p className="scrolls-empty">Nothing: no fact is in use.</p>
            ))}
          {showSent && preview && (
            <p className="scrolls-hint">
              {memory.enabled
                ? "Sent as one system message after your standing instructions. With Veil on, detected details are replaced by tags first. Each reply lists the facts it was sent."
                : "Once memory is switched on, this is sent as one system message after your standing instructions. With Veil on, detected details are replaced by tags first. Each reply lists the facts it was sent."}
            </p>
          )}
        </section>
      </div>
      <div className="inline-actions">
        <Button secondary onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}

// Under a reply: which facts went with that request, exactly as sent.
export function MemoryUsedNote({ memory }) {
  if (!memory?.used) return null;
  return (
    <details className="memory-used">
      <summary>
        <Icon name="memory" size={13} />
        {memory.used === 1
          ? "1 memory fact sent"
          : `${memory.used} memory facts sent`}
      </summary>
      <ul>
        {memory.facts.map((f) => (
          <li key={f.id} data-i18n="off">
            {f.text}
          </li>
        ))}
      </ul>
    </details>
  );
}
