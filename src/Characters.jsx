import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, copyText } from "./lib.js";
import { Button, Empty, Icon, Modal, Notice } from "./ui.jsx";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import { SecretGuardNotice, useSecretGuard, useSecretScan } from "./SecretGuard.jsx";
import { maskSecrets, removeSecrets, secretGuardTurn } from "./secret-guard.js";
import { CharacterAvatar } from "./CharacterChat.jsx";
import { AvatarError, prepareAvatar } from "./character-avatar.js";
import {
  MAX_CHARACTERS,
  MAX_CHARACTER_NAME,
  MAX_CHARACTER_DESCRIPTION,
  MAX_CHARACTER_INSTRUCTIONS,
  MAX_CHARACTER_OPENING,
  MONOGRAMS,
  SHARE_DAYS,
  DEFAULT_SHARE_DAYS,
  charactersReleased,
  characterChatPath,
  characterProblems,
  hasOpening,
  monogramAvatar,
  parseAvatar,
  tokenFromLink,
} from "./characters.js";
import "./characters.css";

// The Characters page: make, edit, duplicate, delete and share the account's
// own AI characters (src/characters.js for the rules, server/routes/
// characters.js for storage). A character is private to the account; "Share a
// copy" makes a revocable link another signed-in account can use to add its
// own copy, after reading the whole character. Chatting with one happens in
// the workspace's chat (the composer's character line, src/CharacterChat.jsx).

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const day = (t) => new Date(t).toLocaleDateString();

// A copy link's token waits in this tab only (sessionStorage), so it survives
// signing in or creating an account on the way and never sits in the address
// bar, history or a log: it is taken out of the #fragment at once.
const COPY_KEY = "anonyma:character-copy";
const readCopy = () => {
  try {
    return sessionStorage.getItem(COPY_KEY);
  } catch {
    return null;
  }
};
const keepCopy = (token) => {
  try {
    if (token) sessionStorage.setItem(COPY_KEY, token);
    else sessionStorage.removeItem(COPY_KEY);
  } catch {}
};
function captureCopy() {
  try {
    const m = /^#copy=([A-Za-z0-9_-]{43})$/.exec(window.location.hash);
    if (!m) return false;
    keepCopy(m[1]);
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    return true;
  } catch {
    return false;
  }
}

const blank = () => ({
  name: "",
  description: "",
  instructions: "",
  opening: "",
  model: null,
  avatar: null,
});
const draftOf = (c) => ({
  id: c.id,
  name: c.name,
  description: c.description,
  instructions: c.instructions,
  opening: c.opening,
  model: c.model,
  avatar: c.avatar,
});

function Tags({ character, models }) {
  const model = character.model && (models.find((m) => m.id === character.model)?.name || character.model);
  return (
    <div className="character-tags">
      {model ? (
        <span className="character-tag" data-i18n="off">
          {model}
        </span>
      ) : (
        <span className="character-tag">No default model</span>
      )}
      {hasOpening(character) && <span className="character-tag">Opening message</span>}
      {character.instructions.trim() && <span className="character-tag">Instructions</span>}
      {character.chat_count > 0 && (
        <span className="character-tag">{count(character.chat_count, "saved chat", "saved chats")}</span>
      )}
    </div>
  );
}

// ---- The editor ----

function AvatarPicker({ draft, setDraft }) {
  const input = useRef(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const picture = parseAvatar(draft.avatar) || { kind: "none" };
  const chosen = picture.kind === "mono" ? picture.color : picture.kind === "none" ? "cobalt" : null;
  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const made = await prepareAvatar(file);
      setDraft((d) => ({ ...d, avatar: made.url }));
    } catch (err) {
      setError(err instanceof AvatarError ? err.message : "That picture couldn't be read. Try another image.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset className="character-field character-avatar-field">
      <legend>Picture</legend>
      <div className="character-avatar-row">
        <CharacterAvatar name={draft.name} avatar={draft.avatar} size={72} />
        <div className="character-avatar-choices">
          <div className="character-monograms" role="radiogroup" aria-label="Color">
            {MONOGRAMS.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={chosen === m.id}
                aria-label={m.label}
                title={m.label}
                className={chosen === m.id ? "active" : ""}
                style={{ background: m.hex, color: m.ink }}
                onClick={() => setDraft((d) => ({ ...d, avatar: monogramAvatar(m.id) }))}
              >
                <CharacterAvatar name={draft.name} avatar={monogramAvatar(m.id)} size={26} className="flat" />
              </button>
            ))}
          </div>
          <div className="character-avatar-actions">
            <button type="button" className="small-button" disabled={busy} onClick={() => input.current?.click()}>
              <Icon name="upload" size={14} />
              {picture.kind === "image" ? "Choose another picture" : "Upload a picture"}
            </button>
            {picture.kind === "image" && (
              <button type="button" className="small-button" onClick={() => setDraft((d) => ({ ...d, avatar: null }))}>
                Remove picture
              </button>
            )}
            <input ref={input} type="file" accept="image/*" hidden onChange={upload} />
          </div>
        </div>
      </div>
      <p className="character-help">
        A picture is cleaned of hidden details such as location, cut to a square and redrawn at 256 pixels in your
        browser before it's saved.
      </p>
      {error && <p className="character-error">{error}</p>}
    </fieldset>
  );
}

function ModelSelect({ draft, set, models, config }) {
  const uncensoredIds = config?.releases?.uncensoredModels || [];
  const uncensoredLive = config?.releases?.features?.uncensored === true;
  const usable = models.filter(
    (m) => m.type === "chat" && m.callable && !(m.architecture?.output_modalities || []).includes("image"),
  );
  const plain = usable.filter((m) => !uncensoredIds.includes(m.id));
  const wild = uncensoredLive ? usable.filter((m) => uncensoredIds.includes(m.id)) : [];
  const listed = usable.some((m) => m.id === draft.model);
  const privateLive = config?.releases?.features?.private === true;
  const chosen = models.find((m) => m.id === draft.model);
  return (
    <label className="character-field">
      <span>Default model</span>
      <select value={draft.model || ""} onChange={(e) => set("model")(e.target.value || null)}>
        <option value="">No default</option>
        {draft.model && !listed && (
          <option value={draft.model} data-i18n="off">
            {chosen?.name || draft.model}
          </option>
        )}
        {plain.length > 0 && (
          <optgroup label="Chat models">
            {plain.map((m) => (
              <option key={m.id} value={m.id} data-i18n="off">
                {m.name}
              </option>
            ))}
          </optgroup>
        )}
        {wild.length > 0 && (
          <optgroup label="Uncensored models">
            {wild.map((m) => (
              <option key={m.id} value={m.id} data-i18n="off">
                {m.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {draft.model && uncensoredIds.includes(draft.model) && (
        <small className="character-help">This model is in the Uncensored section, so chats with this character open there.</small>
      )}
      {privateLive && chosen && !chosen.private && (
        <small className="character-help">
          Private Mode offers only models with zero data retention, and this isn't one: a Private Mode chat with this
          character uses a model you pick.
        </small>
      )}
    </label>
  );
}

export function CharacterEditor({ draft, setDraft, config, models, busy, error, onSave, onCancel, onDelete, secretLive = false }) {
  const [confirming, setConfirming] = useState(false);
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));
  const texts = useMemo(() => [draft.instructions, draft.opening, draft.description], [draft.instructions, draft.opening, draft.description]);
  const seedHit = useSeedScan(seedGuardLive(config), texts);
  // Secret Guard: a password, key or token in the instructions or the
  // opening message holds Save, after Seed Guard, until it's masked, removed
  // or saved anyway (this save only). The instructions go to the model with
  // every message in a chat with this character, so a masked value stays a
  // placeholder like [SECRET_1]: the real one isn't kept anywhere.
  const secretTexts = useMemo(() => [draft.instructions, draft.opening], [draft.instructions, draft.opening]);
  const secretFinds = useSecretScan(secretLive, secretTexts);
  const [secretOk, setSecretOk] = useState(false),
    [seedAnswered, setSeedAnswered] = useState(false);
  useEffect(() => {
    setSecretOk(false);
    setSeedAnswered(false);
  }, [draft.instructions, draft.opening, draft.description]);
  const secretHeld = secretFinds.length > 0 && !secretOk;
  const turn = secretGuardTurn({ seedHit, finds: secretHeld ? secretFinds : [], seedAnswered });
  const problems = characterProblems(draft);
  const hasProblem = !!(problems.name || problems.description || problems.instructions || problems.opening);
  function maskAndSave() {
    const state = {};
    const next = {
      ...draft,
      instructions: maskSecrets(draft.instructions, state).text,
      opening: maskSecrets(draft.opening, state).text,
    };
    setDraft(next);
    onSave(next);
  }
  return (
    <form
      className="character-editor"
      onSubmit={(e) => {
        e.preventDefault();
        // Seed Guard holds Save until the find is removed (a seed phrase) or
        // confirmed with "Save anyway" (a key or 64-hex); then Secret Guard.
        if (!seedHit && !secretHeld) onSave();
      }}
    >
      <div className="character-editor-head">
        <h2>{draft.id ? "Edit character" : "New character"}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={onCancel}>
          <Icon name="close" size={17} />
        </button>
      </div>
      <div className="character-editor-grid">
        <div className="character-editor-col">
          <label className="character-field">
            <span>Name</span>
            <input
              value={draft.name}
              maxLength={MAX_CHARACTER_NAME}
              placeholder="For example, Ada"
              onChange={(e) => set("name")(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="character-field">
            <span>Short description</span>
            <input
              value={draft.description}
              maxLength={MAX_CHARACTER_DESCRIPTION}
              placeholder="A stern but kind librarian"
              onChange={(e) => set("description")(e.target.value)}
            />
          </label>
          <label className="character-field">
            <span>Instructions</span>
            <textarea
              rows={9}
              value={draft.instructions}
              maxLength={MAX_CHARACTER_INSTRUCTIONS}
              placeholder="Who they are and how they talk. Start with “You are …”."
              onChange={(e) => set("instructions")(e.target.value)}
            />
            <small className="character-count">{`${draft.instructions.length}/${MAX_CHARACTER_INSTRUCTIONS}`}</small>
          </label>
          <p className="character-note">
            <Icon name="eyeoff" size={15} />
            <span>
              Sent with every message in a chat with this character, after your standing instructions and the
              project's. With Veil on, they're masked in your browser before sending. They change how a model talks,
              not what it can do.
            </span>
          </p>
          <SeedGuardNotice
            hit={turn === "seed" || !secretHeld ? seedHit : null}
            verb="save"
            busy={busy}
            hardOverride={seedHit?.kind !== "seed"}
            onProceed={() => (secretHeld ? setSeedAnswered(true) : onSave())}
          />
          <SecretGuardNotice
            finds={turn === "secret" ? secretFinds : []}
            verb="save"
            busy={busy}
            note="Mask swaps each one for a placeholder like [SECRET_1]. A character's instructions go to the model with every message, so the placeholder stays and the real value isn't kept anywhere."
            onMask={maskAndSave}
            onRemove={() =>
              setDraft((d) => ({ ...d, instructions: removeSecrets(d.instructions).text, opening: removeSecrets(d.opening).text }))
            }
            onProceed={() => {
              setSecretOk(true);
              onSave(draft);
            }}
          />
        </div>
        <div className="character-editor-col">
          <AvatarPicker draft={draft} setDraft={setDraft} />
          <label className="character-field">
            <span>Opening message</span>
            <textarea
              rows={3}
              value={draft.opening}
              maxLength={MAX_CHARACTER_OPENING}
              placeholder="What they say first. Optional."
              onChange={(e) => set("opening")(e.target.value)}
            />
            <small className="character-count">{`${draft.opening.length}/${MAX_CHARACTER_OPENING}`}</small>
          </label>
          <p className="character-help">
            It's shown as the first message of a chat. It isn't written by a model, so it costs nothing.
          </p>
          <ModelSelect draft={draft} set={set} models={models} config={config} />
        </div>
      </div>
      {error && <Notice type="error">{error}</Notice>}
      {confirming ? (
        <div className="character-confirm" role="group" aria-label="Delete character">
          <span>Delete this character? Its chats stay saved, as plain chats, and its copy links stop working.</span>
          <button type="button" className="small-button danger" onClick={onDelete} disabled={busy}>
            Delete character
          </button>
          <button type="button" className="small-button" onClick={() => setConfirming(false)} disabled={busy}>
            Keep it
          </button>
        </div>
      ) : (
        <div className="character-editor-actions">
          <Button type="submit" disabled={busy || hasProblem || !!seedHit || secretHeld}>
            {draft.id ? "Save character" : "Create character"}
          </Button>
          <button type="button" className="small-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {draft.id && (
            <button type="button" className="character-delete" onClick={() => setConfirming(true)} disabled={busy}>
              <Icon name="delete" size={14} />
              Delete character
            </button>
          )}
        </div>
      )}
    </form>
  );
}

// ---- Share a copy ----

// The share dialog's content, from its state (also what the tests render).
export function ShareView({ character, links, days, setDays, busy, error, copied, onCreate, onRevoke, onCopy }) {
  return (
    <div className="character-share">
      <div className="character-share-who">
        <CharacterAvatar name={character.name} avatar={character.avatar} size={40} />
        <b data-i18n="off">{character.name}</b>
      </div>
      <p>
        Anyone signed in to ANONYMA who has the link can read this character and add their own copy: its name,
        description, instructions, opening message, default model and picture. The link carries no chats and nothing
        about you.
      </p>
      <p className="character-help">
        A copy is the character as it is now: later edits don't reach it. Revoke a link and it stops working at once.
        There's no public gallery or directory.
      </p>
      <div className="character-share-make">
        <label>
          <span>Link lasts</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {SHARE_DAYS.map((d) => (
              <option key={d} value={d}>
                {count(d, "day", "days")}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" onClick={onCreate} disabled={busy || links === null}>
          Make a link
        </Button>
      </div>
      {error && <Notice type="error">{error}</Notice>}
      {links === null ? (
        <p className="character-help">Loading…</p>
      ) : links.length ? (
        <ul className="character-links">
          {links.map((l) => (
            <li key={l.id}>
              <input readOnly value={l.url} aria-label="Copy link" onFocus={(e) => e.target.select()} />
              <button type="button" className="small-button" onClick={() => onCopy(l)}>
                {copied === l.id ? "Copied" : "Copy"}
              </button>
              <button type="button" className="small-button" disabled={busy} onClick={() => onRevoke(l)}>
                Revoke
              </button>
              <small>{`Expires ${day(l.expires)}`}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="character-help">No live links.</p>
      )}
    </div>
  );
}
function ShareDialog({ character, onClose }) {
  const [links, setLinks] = useState(null),
    [days, setDays] = useState(DEFAULT_SHARE_DAYS),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [copied, setCopied] = useState("");
  useEffect(() => {
    let live = true;
    api(`/api/characters/${encodeURIComponent(character.id)}/shares`)
      .then((r) => live && setLinks(r.data))
      .catch((e) => live && (setLinks([]), setError(e.message)));
    return () => {
      live = false;
    };
  }, [character.id]);
  async function create() {
    setBusy(true);
    setError("");
    try {
      const link = await api(`/api/characters/${encodeURIComponent(character.id)}/shares`, {
        method: "POST",
        body: { expires_in_days: days },
      });
      setLinks((l) => [link, ...(l || [])]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(link) {
    setBusy(true);
    setError("");
    try {
      await api("/api/character-shares/" + encodeURIComponent(link.id), { method: "DELETE" });
      setLinks((l) => l.filter((x) => x.id !== link.id));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function copy(link) {
    if (await copyText(link.url)) {
      setCopied(link.id);
      setTimeout(() => setCopied((c) => (c === link.id ? "" : c)), 1600);
    }
  }
  return (
    <Modal title="Share a copy" onClose={onClose}>
      <ShareView
        character={character}
        links={links}
        days={days}
        setDays={setDays}
        busy={busy}
        error={error}
        copied={copied}
        onCreate={create}
        onRevoke={revoke}
        onCopy={copy}
      />
    </Modal>
  );
}

// ---- Adding a copy ----

export const GONE =
  "This link isn't available. It may have expired or been revoked. Ask the person who sent it for a new one.";
// What a copy link holds, for reading before anything is added (also what the
// tests render).
export function ImportView({ view, gone, error, busy, atLimit, onAdd, onClose, secretFinds = [], onMask, onProceed }) {
  const secretHeld = secretFinds.length > 0;
  return (
    <div className="character-import">
      {gone ? (
        <Notice type="error">{GONE}</Notice>
      ) : !view ? (
        error ? (
          <Notice type="error">{error}</Notice>
        ) : (
          <p className="character-help">Loading…</p>
        )
      ) : (
        <>
          <div className="character-import-head">
            <CharacterAvatar name={view.name} avatar={view.avatar} size={64} />
            <div>
              <h3 data-i18n="off">{view.name}</h3>
              {view.description && <p data-i18n="off">{view.description}</p>}
              <div className="character-tags">
                {view.model ? (
                  <span className="character-tag" data-i18n="off">
                    {view.model_name || view.model}
                  </span>
                ) : (
                  <span className="character-tag">No default model</span>
                )}
              </div>
            </div>
          </div>
          <Notice>
            Read the instructions first. They're sent to the model with every message in a chat with this character.
            You'll get your own copy, and can edit or delete it. Nothing about who made it is shown.
          </Notice>
          <h4>Instructions</h4>
          {view.instructions.trim() ? (
            <pre className="character-import-text" data-i18n="off">
              {view.instructions}
            </pre>
          ) : (
            <p className="character-help">No instructions.</p>
          )}
          {view.opening.trim() && (
            <>
              <h4>Opening message</h4>
              <pre className="character-import-text short" data-i18n="off">
                {view.opening}
              </pre>
            </>
          )}
          {view.model && !view.model_available && (
            <p className="character-help">
              Its default model isn't available to your account, so your copy starts with no default model.
            </p>
          )}
          {atLimit && (
            <p className="character-help">{`You have the most characters an account can keep (${MAX_CHARACTERS}). Delete one to add this.`}</p>
          )}
          {!atLimit && (
            <SecretGuardNotice
              finds={secretFinds}
              verb="add"
              busy={busy}
              note="Mask swaps each one for a placeholder like [SECRET_1] in your copy. Its instructions go to the model with every message, so the placeholder stays and the real value isn't kept in your account."
              onMask={onMask}
              onProceed={onProceed}
            />
          )}
          {error && <Notice type="error">{error}</Notice>}
          <div className="character-editor-actions">
            <Button type="button" onClick={onAdd} disabled={busy || atLimit || secretHeld}>
              Add to my characters
            </Button>
            <button type="button" className="small-button" onClick={onClose} disabled={busy}>
              Not now
            </button>
          </div>
        </>
      )}
      {gone && (
        <div className="character-editor-actions">
          <button type="button" className="small-button" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
function ImportDialog({ token, atLimit, onDone, onClose, secretLive = false }) {
  const [view, setView] = useState(null),
    [error, setError] = useState(""),
    [gone, setGone] = useState(false),
    [busy, setBusy] = useState(false);
  // Secret Guard: a password, key or token in the shared instructions or
  // opening message would go to the model with every message in a chat with
  // this character, so adding waits until it's masked or added anyway.
  const secretTexts = useMemo(() => (view ? [view.instructions, view.opening] : []), [view]);
  const secretFinds = useSecretScan(secretLive && !!view, secretTexts);
  useEffect(() => {
    let live = true;
    api("/api/character-shares/" + encodeURIComponent(token))
      .then((r) => live && setView(r))
      .catch((e) => {
        if (!live) return;
        if (e.status === 404) setGone(true);
        else setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [token]);
  async function add(body = {}) {
    setBusy(true);
    setError("");
    try {
      const made = await api(`/api/character-shares/${encodeURIComponent(token)}/import`, { method: "POST", body });
      onDone(made);
    } catch (e) {
      if (e.status === 404) setGone(true);
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Add a character" onClose={onClose}>
      <ImportView
        view={view}
        gone={gone}
        error={error}
        busy={busy}
        atLimit={atLimit}
        onAdd={() => add()}
        onClose={onClose}
        secretFinds={secretFinds}
        onMask={() => {
          const state = {};
          add({ instructions: maskSecrets(view.instructions, state).text, opening: maskSecrets(view.opening, state).text });
        }}
        onProceed={() => add()}
      />
    </Modal>
  );
}

export const PASTE_ERROR = "That isn't a character link. Paste the whole link you were sent.";
export function PasteDialog({ onToken, onClose }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  return (
    <Modal title="Add from a link" onClose={onClose}>
      <form
        className="character-paste"
        onSubmit={(e) => {
          e.preventDefault();
          const token = tokenFromLink(value);
          if (!token) return setError(PASTE_ERROR);
          onToken(token);
        }}
      >
        <label className="character-field">
          <span>Character link</span>
          <input
            value={value}
            autoComplete="off"
            spellCheck="false"
            placeholder="Paste the link"
            onChange={(e) => {
              setValue(e.target.value);
              setError("");
            }}
            autoFocus
          />
        </label>
        {error && <Notice type="error">{error}</Notice>}
        <div className="character-editor-actions">
          <Button type="submit" disabled={!value.trim()}>
            Read it
          </Button>
          <button type="button" className="small-button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

// One character's own page: who it is, what it says, and its saved chats.
export function CharacterDetail({ c, models, busy, atLimit, editor = null, onChat, onEdit, onDuplicate, onShare, onOpenChat }) {
  return (
    <>
      <div className="character-hero">
        <CharacterAvatar name={c.name} avatar={c.avatar} size={84} />
        <div className="character-hero-text">
          <p className="eyebrow">CHARACTER</p>
          <h1 data-i18n="off">{c.name}</h1>
          {c.description && (
            <p className="character-hero-desc" data-i18n="off">
              {c.description}
            </p>
          )}
          <Tags character={c} models={models} />
        </div>
        <div className="character-hero-actions">
          <Button type="button" onClick={onChat}>
            Chat <Icon name="chat" size={16} />
          </Button>
          <button
            type="button"
            className="small-button"
            disabled={busy}
            onClick={onEdit}
          >
            <Icon name="settings" size={14} />
            Edit
          </button>
          <button type="button" className="small-button" disabled={busy || atLimit} onClick={onDuplicate}>
            <Icon name="copy" size={14} />
            Duplicate
          </button>
          <button type="button" className="small-button" onClick={onShare}>
            <Icon name="share" size={14} />
            Share a copy
          </button>
        </div>
      </div>
      {editor}
      <div className="character-columns">
        <section className="character-panel">
          <h2>Instructions</h2>
          {c.instructions.trim() ? (
            <p className="character-text" data-i18n="off">
              {c.instructions}
            </p>
          ) : (
            <p className="character-help">No instructions yet. Add some to shape how this character talks.</p>
          )}
        </section>
        <section className="character-panel">
          <h2>Opening message</h2>
          {hasOpening(c) ? (
            <p className="character-text" data-i18n="off">
              {c.opening}
            </p>
          ) : (
            <p className="character-help">None. A chat starts empty, waiting for you.</p>
          )}
        </section>
      </div>
      <section className="character-panel">
        <h2>
          Chats <span className="character-count-inline">{c.chats.length}</span>
        </h2>
        {c.chats.length ? (
          <ul className="character-chats">
            {c.chats.map((x) => (
              <li key={x.id}>
                <button type="button" className="character-chat-title" data-i18n="off" onClick={() => onOpenChat(x)}>
                  {x.title || "Untitled"}
                </button>
                <span className="character-chat-meta">{day(x.updated)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="character-help">
            No saved chats yet. Chats in Private Mode or off the record aren't saved; the character is.
          </p>
        )}
      </section>
    </>
  );
}

// ---- The page ----

export default function Characters({ demo, user, config, models, characters }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selected = params.get("id");
  const editing = params.get("edit") === "1";
  const creating = params.get("new") === "1";
  const [draft, setDraft] = useState(null),
    [detail, setDetail] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [formError, setFormError] = useState(""),
    [info, setInfo] = useState(""),
    [share, setShare] = useState(null),
    [token, setToken] = useState(() => (captureCopy(), readCopy())),
    [paste, setPaste] = useState(false);
  const live = !demo && !!user && charactersReleased(config);
  // Secret Guard, for instructions and opening messages (saved and imported).
  const secretLive = useSecretGuard(config, user, demo);
  // What the list shows (chat counts) is read again on every visit.
  useEffect(() => {
    if (live) characters.reload();
  }, [live]);
  const uncensoredIds = config?.releases?.uncensoredModels || [];
  const atLimit = characters.list.length >= characters.max;

  // A link pasted over the open page changes only the fragment: it is taken
  // out the same way.
  useEffect(() => {
    const onHash = () => {
      if (captureCopy()) setToken(readCopy());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const loadDetail = useCallback(async () => {
    if (!live || !selected) return setDetail(null);
    try {
      setDetail(await api("/api/characters/" + encodeURIComponent(selected)));
      setError("");
    } catch (e) {
      setDetail(null);
      setError(e.status === 404 ? "That character wasn't found." : e.message);
    }
  }, [live, selected]);
  useEffect(() => {
    loadDetail();
    setDraft(null);
    setInfo("");
  }, [loadDetail]);
  // ?new=1 and ?edit=1 keep the editor open across a reload.
  useEffect(() => {
    if (creating && !draft) setDraft(blank());
    else if (editing && selected && detail && !draft) setDraft(draftOf(detail));
  }, [creating, editing, selected, detail]);
  const closeEditor = () => {
    setDraft(null);
    setFormError("");
    if (creating || editing) {
      const next = new URLSearchParams(params);
      next.delete("new");
      next.delete("edit");
      setParams(next, { replace: true });
    }
  };

  // `d` is the draft to save: Secret Guard's Mask and save passes the masked
  // one, before the state update lands.
  async function save(d = draft) {
    const problems = characterProblems(d);
    const first = problems.name || problems.description || problems.instructions || problems.opening;
    if (first) return setFormError(first);
    setBusy(true);
    setFormError("");
    const body = {
      name: d.name.trim(),
      description: d.description,
      instructions: d.instructions,
      opening: d.opening,
      model: d.model || null,
      avatar: d.avatar ?? null,
    };
    try {
      const saved = d.id
        ? await api("/api/characters/" + encodeURIComponent(d.id), { method: "PATCH", body })
        : await api("/api/characters", { method: "POST", body });
      setDraft(null);
      await characters.reload();
      if (d.id) {
        setDetail(saved);
        const next = new URLSearchParams(params);
        next.delete("edit");
        setParams(next, { replace: true });
      } else setParams({ id: saved.id });
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!draft?.id) return;
    setBusy(true);
    try {
      await api("/api/characters/" + encodeURIComponent(draft.id), { method: "DELETE" });
      setDraft(null);
      await characters.reload();
      setParams({});
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function duplicate(c) {
    setBusy(true);
    setError("");
    try {
      const copy = await api(`/api/characters/${encodeURIComponent(c.id)}/duplicate`, { method: "POST", body: {} });
      await characters.reload();
      setParams({ id: copy.id });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const chat = (c) => navigate(characterChatPath(c, uncensoredIds));
  const openChat = (c) => navigate("/workspace/" + (["code", "uncensored"].includes(c.mode) ? c.mode : "chat") + "?c=" + encodeURIComponent(c.id));
  const dropCopy = () => {
    keepCopy(null);
    setToken(null);
  };

  if (demo || !user)
    return (
      <div className="library-page">
        <Empty icon="users" title="Make AI characters of your own.">
          {demo
            ? "Characters are kept on your account, so they aren't part of the demo. Sign in to make one."
            : "Give an AI a name, a picture and a personality, and pick the model it talks through. Sign in to make characters."}
        </Empty>
        {token && !demo && (
          <div className="character-signin">
            <Notice>You opened a character link. Sign in, or create an account, to read it and add a copy.</Notice>
            <div className="character-editor-actions">
              <Button to={"/login?next=" + encodeURIComponent("/workspace/characters")}>Sign in</Button>
              <Button secondary to={"/register?next=" + encodeURIComponent("/workspace/characters")}>
                Create account
              </Button>
            </div>
          </div>
        )}
      </div>
    );

  const editor = draft && (
    <CharacterEditor
      draft={draft}
      setDraft={setDraft}
      config={config}
      models={models}
      busy={busy}
      error={formError}
      onSave={save}
      onCancel={closeEditor}
      onDelete={remove}
      secretLive={secretLive}
    />
  );
  const dialogs = (
    <>
      {share && <ShareDialog character={share} onClose={() => setShare(null)} />}
      {paste && (
        <PasteDialog
          onClose={() => setPaste(false)}
          onToken={(t) => {
            keepCopy(t);
            setToken(t);
            setPaste(false);
          }}
        />
      )}
      {token && (
        <ImportDialog
          token={token}
          atLimit={atLimit}
          secretLive={secretLive}
          onClose={dropCopy}
          onDone={async (made) => {
            dropCopy();
            await characters.reload();
            setParams({ id: made.id });
            setInfo(
              made.model_kept
                ? "Added. This is your own copy: edit it as you like."
                : "Added. Its default model isn't available to you, so it has none: choose one with Edit.",
            );
          }}
        />
      )}
    </>
  );

  if (selected) {
    const c = detail;
    return (
      <section className="characters-page">
        <button type="button" className="character-back" onClick={() => setParams({})}>
          <Icon name="arrow" size={13} />
          All characters
        </button>
        {error && <Notice type="error">{error}</Notice>}
        {info && <Notice>{info}</Notice>}
        {c && (
          <CharacterDetail
            c={c}
            models={models}
            busy={busy}
            atLimit={atLimit}
            editor={editor}
            onChat={() => chat(c)}
            onEdit={() => setParams({ id: c.id, edit: "1" })}
            onDuplicate={() => duplicate(c)}
            onShare={() => setShare(c)}
            onOpenChat={openChat}
          />
        )}
        {dialogs}
      </section>
    );
  }

  return (
    <section className="characters-page">
      <div className="characters-head">
        <div>
          <p className="eyebrow">YOUR OWN AI CHARACTERS</p>
          <h1>Characters</h1>
          <p>
            Give an AI a name, a picture and a personality, and pick the model it talks through. Characters are private
            to your account; sharing a copy is the only way one leaves it, and it carries no chats.
          </p>
        </div>
        <div className="characters-head-actions">
          <Button
            type="button"
            onClick={() => setParams({ new: "1" })}
            disabled={atLimit || busy || !!draft}
          >
            New character <Icon name="plus" size={16} />
          </Button>
          <button type="button" className="small-button" onClick={() => setPaste(true)}>
            <Icon name="link" size={14} />
            Add from a link
          </button>
        </div>
      </div>
      {error && <Notice type="error">{error}</Notice>}
      {info && <Notice>{info}</Notice>}
      {atLimit && (
        <p className="character-help">{`You have the most characters an account can keep (${characters.max}). Delete one to add another.`}</p>
      )}
      {editor}
      {characters.list.length ? (
        <>
          <p className="characters-count">{`${characters.list.length}/${characters.max}`}</p>
          <div className="character-grid">
            {characters.list.map((c) => (
              <article className="character-card" key={c.id}>
                <button type="button" className="character-card-main" onClick={() => setParams({ id: c.id })}>
                  <CharacterAvatar name={c.name} avatar={c.avatar} size={56} />
                  <span className="character-card-text">
                    <h2 data-i18n="off">{c.name}</h2>
                    {c.description && <span className="character-card-desc" data-i18n="off">{c.description}</span>}
                  </span>
                </button>
                <Tags character={c} models={models} />
                <div className="character-actions">
                  <button type="button" className="small-button primary" onClick={() => chat(c)}>
                    <Icon name="chat" size={13} />
                    Chat
                  </button>
                  <button type="button" className="small-button" onClick={() => setParams({ id: c.id, edit: "1" })}>
                    Edit
                  </button>
                  <button type="button" className="small-button" onClick={() => setShare(c)}>
                    Share a copy
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : (
        !draft &&
        characters.loaded && (
          <Empty
            icon="users"
            title="No characters yet."
            action={<Button type="button" onClick={() => setParams({ new: "1" })}>New character</Button>}
          >
            A character is a name, a picture and a personality on the model you pick. Chat with it from your
            workspace; nothing is shared unless you make a copy link.
          </Empty>
        )
      )}
      {dialogs}
    </section>
  );
}
