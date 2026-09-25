import React, { useState } from "react";
import { Icon, Modal, Button } from "./ui.jsx";
import { extractVariables, fillTemplate, validateScroll, validateInstructions } from "./scrolls.js";
import "./scrolls.css";
import { SeedGuardNotice, useSeedScan } from "./SeedGuard.jsx";

// Manage saved scrolls and the standing instructions sent with every chat,
// code and Uncensored request. Opened from the composer's Scrolls button.
// Titles, bodies, variable names and typed values are the user's own words,
// so they carry data-i18n="off" and stay as written when Chinese is on
// (textareas are never translated; their placeholders are).
export function ScrollsPanel({
  scrolls,
  instructions,
  currentPrompt,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onSaveInstructions,
  // Seed Guard is live: scrolls and instructions are saved to the account
  // and sent with chats, so a seed phrase or key waits for "Save anyway".
  seedGuard = false,
}) {
  const [view, setView] = useState("list"); // "list" | "new" | a scroll id
  const [draft, setDraft] = useState({ title: "", body: "" });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [instructionsBody, setInstructionsBody] = useState(instructions.body);
  const [instructionsEnabled, setInstructionsEnabled] = useState(instructions.enabled);
  const [instructionsError, setInstructionsError] = useState("");
  const [instructionsSaved, setInstructionsSaved] = useState(false);
  const instructionsSeed = useSeedScan(seedGuard, instructionsBody);
  const draftSeed = useSeedScan(
    seedGuard && view !== "list",
    view !== "list" ? draft.title + "\n" + draft.body : "",
  );

  function startEdit(scroll) {
    setDraft({ title: scroll.title, body: scroll.body });
    setErrors({});
    setError("");
    setView(scroll.id);
  }
  function startNew(body = "") {
    setDraft({ title: "", body });
    setErrors({});
    setError("");
    setView("new");
  }
  async function saveDraft({ allowSeed = false } = {}) {
    if (draftSeed && !allowSeed) return;
    const errs = validateScroll(draft);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError("");
    try {
      if (view === "new") await onCreate(draft);
      else await onUpdate(view, draft);
      setView("list");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function removeScroll(id) {
    setBusy(true);
    setError("");
    try {
      await onDelete(id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function saveInstructions({ allowSeed = false } = {}) {
    if (instructionsSeed && !allowSeed) return;
    const err = validateInstructions(instructionsBody);
    setInstructionsError(err || "");
    if (err) return;
    setBusy(true);
    try {
      await onSaveInstructions({
        body: instructionsBody.trim(),
        enabled: instructionsEnabled,
      });
      setInstructionsSaved(true);
      setTimeout(() => setInstructionsSaved(false), 2000);
    } catch (e) {
      setInstructionsError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Scrolls" onClose={onClose}>
      {view === "list" ? (
        <>
          <section className="scrolls-instructions">
            <h3>Standing instructions</h3>
            <p className="scrolls-hint">
              Sent with every chat, code and Uncensored message while enabled. Veil masks
              them like the rest of your message.
            </p>
            <textarea
              value={instructionsBody}
              onChange={(e) => setInstructionsBody(e.target.value)}
              maxLength={4000}
              rows={4}
              placeholder="e.g. Answer concisely. Prefer plain language. Always include a short summary first."
            />
            <div className="scrolls-instructions-row">
              <label className="scrolls-toggle">
                <input
                  type="checkbox"
                  checked={instructionsEnabled}
                  onChange={(e) => setInstructionsEnabled(e.target.checked)}
                />
                Send with every request
              </label>
              <button
                type="button"
                className="small-button"
                onClick={() => saveInstructions()}
                disabled={busy || !!instructionsSeed}
              >
                <Icon name={instructionsSaved ? "check" : "settings"} size={14} />
                {instructionsSaved ? "Saved" : "Save instructions"}
              </button>
            </div>
            <SeedGuardNotice
              hit={instructionsSeed}
              verb="save"
              busy={busy}
              onProceed={() => saveInstructions({ allowSeed: true })}
            />
            {instructionsError && <p className="scrolls-error">{instructionsError}</p>}
          </section>
          <section className="scrolls-list-section">
            <div className="scrolls-list-head">
              <h3>Your scrolls</h3>
              <button type="button" className="small-button" onClick={() => startNew()}>
                <Icon name="plus" size={14} />
                New scroll
              </button>
            </div>
            {currentPrompt?.trim() && (
              <button
                type="button"
                className="small-button scrolls-save-current"
                onClick={() => startNew(currentPrompt)}
              >
                <Icon name="plus" size={14} />
                Save current prompt as a scroll
              </button>
            )}
            {error && <p className="scrolls-error">{error}</p>}
            {scrolls.length === 0 ? (
              <p className="scrolls-empty">
                No scrolls yet. Save a prompt to reuse it later. Use {"{{variables}}"} for
                anything you want to fill in each time.
              </p>
            ) : (
              <ul className="scrolls-items">
                {scrolls.map((s) => (
                  <li key={s.id}>
                    <div data-i18n="off">
                      <b>{s.title}</b>
                      <p>{s.body.length > 140 ? s.body.slice(0, 140) + "…" : s.body}</p>
                    </div>
                    <div className="scrolls-item-actions">
                      <button type="button" className="small-button" onClick={() => startEdit(s)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="small-button danger-text"
                        onClick={() => removeScroll(s.id)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : (
        <div className="scrolls-form">
          <label>
            Title
            <input
              data-i18n="off"
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              maxLength={80}
              autoFocus
            />
          </label>
          {errors.title && <p className="scrolls-error">{errors.title}</p>}
          <label>
            Prompt
            <textarea
              value={draft.body}
              onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
              maxLength={8000}
              rows={8}
              placeholder="Use {{variable}} for anything you want to fill in each time."
            />
          </label>
          {errors.body && <p className="scrolls-error">{errors.body}</p>}
          <SeedGuardNotice
            hit={draftSeed}
            verb="save"
            busy={busy}
            onProceed={() => saveDraft({ allowSeed: true })}
          />
          {error && <p className="scrolls-error">{error}</p>}
          <div className="inline-actions">
            <Button onClick={() => saveDraft()} disabled={busy || !!draftSeed}>
              {view === "new" ? "Save scroll" : "Save changes"}
            </Button>
            <Button secondary onClick={() => setView("list")} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// Fills a scroll's {{variables}} before it is inserted into the prompt. The
// dialog's title is fixed text; the scroll's own title sits below it,
// untranslated.
export function ScrollFillForm({ scroll, onInsert, onCancel }) {
  const variables = extractVariables(scroll.body);
  const [values, setValues] = useState(() =>
    Object.fromEntries(variables.map((v) => [v, ""])),
  );
  return (
    <Modal title="Fill in the blanks" onClose={onCancel}>
      <div className="scrolls-form">
        <p className="scrolls-fill-title" data-i18n="off">
          {scroll.title}
        </p>
        {variables.map((name, i) => (
          <label key={name}>
            <span data-i18n="off">{name}</span>
            <input
              data-i18n="off"
              value={values[name] || ""}
              onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
              autoFocus={i === 0}
            />
          </label>
        ))}
        <div className="inline-actions">
          <Button onClick={() => onInsert(fillTemplate(scroll.body, values))}>
            Insert
          </Button>
          <Button secondary onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
