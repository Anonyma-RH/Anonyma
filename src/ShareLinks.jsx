import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Icon, Button, Modal, CopyButton, Notice } from "./ui.jsx";
import { api, isReleased } from "./lib.js";
import { useApp } from "./context.jsx";
import {
  SHARE_EXPIRY_DAYS,
  DEFAULT_SHARE_DAYS,
  SHARE_BLOCK_MESSAGES,
  MAX_SHARE_TITLE,
  SEALED_FACTS,
  SNAPSHOT_PROBLEMS,
  deviceSnapshot,
  sealedLink,
  snapshotProblem,
  snapshotSummary,
} from "./share-links.js";
import { sealSnapshot } from "./sealed-share.js";
import "./share-links.css";

// Share a Chat, the owner's side: the Share dialog in the workspace and the
// list of every live link in Account → Settings. The server decides what a
// snapshot holds (src/share-links.js); these only choose, show and revoke.
//
// Sealed Share: a sealed link's snapshot is sealed here, in the browser
// (src/sealed-share.js), and only the ciphertext is uploaded. Its key exists
// only in the link shown once after it's made; nothing here stores it.
export const sealedShareLive = (config) =>
  isReleased(config, "sharelinks") && isReleased(config, "sealedshare");
const date = (ms) => new Date(ms).toLocaleDateString();
const expiryLabel = (days) => (days == null ? "Never" : days === 1 ? "1 day" : `${days} days`);
function Expires({ link }) {
  if (link.expires == null) return <>Never expires</>;
  return (
    <>
      Expires {date(link.expires)}
      {link.ends_with_conversation ? " · ends with its conversation" : ""}
    </>
  );
}

// One live link: its address, when it ends, and Open / Copy / Revoke. A
// sealed link's key isn't kept anywhere, so it can only be revoked here.
function LinkRow({ link, busy, onRevoke, showTitle = false }) {
  if (link.sealed)
    return (
      <li className="share-link-row">
        <div className="share-link-text">
          {showTitle &&
            (link.device_only ? (
              <b>Device-only chat</b>
            ) : (
              <b data-i18n="off">{link.conversation_title}</b>
            ))}
          <small>
            <span className="share-sealed-tag">
              <Icon name="lock" size={11} />
              Sealed
            </span>{" "}
            Created {date(link.created)} · <Expires link={link} />
          </small>
          <small className="share-sealed-note">
            Its key is only in the link you copied.
          </small>
        </div>
        <div className="share-link-actions">
          <button
            type="button"
            className="small-button danger-text"
            disabled={busy}
            onClick={() => onRevoke(link)}
          >
            Revoke
          </button>
        </div>
      </li>
    );
  return (
    <li className="share-link-row">
      <div className="share-link-text">
        {showTitle && (
          <b data-i18n="off">{link.conversation_title || link.title}</b>
        )}
        <small>
          Created {date(link.created)} · <Expires link={link} /> ·{" "}
          {link.messages === 1 ? "1 message" : `${link.messages} messages`}
        </small>
        <code data-i18n="off">{link.url}</code>
      </div>
      <div className="share-link-actions">
        <a
          className="small-button"
          href={link.path}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Icon name="external" size={13} />
          Open
        </a>
        <CopyButton text={link.url} label="Copy link" />
        <button
          type="button"
          className="small-button danger-text"
          disabled={busy}
          onClick={() => onRevoke(link)}
        >
          Revoke
        </button>
      </div>
    </li>
  );
}

// The Share dialog for the open conversation, or why it can't be shared.
// `device` is a Device-only chat ({ messages }), which can only be sealed:
// the server never had it. `modelName` names a reply's model for it.
export function ShareDialog({ conversation, device, blocked, modelName, onClose }) {
  const { config } = useApp() || {};
  const sealedOffered = !!device || sealedShareLive(config);
  const deviceDraft = useMemo(
    () => (device ? deviceSnapshot(device.messages, "", modelName) : null),
    [device],
  );
  const [title, setTitle] = useState(
      device ? deviceDraft?.title || "" : conversation?.title || "",
    ),
    [days, setDays] = useState(DEFAULT_SHARE_DAYS),
    // Sealed by default wherever it's offered.
    [sealed, setSealed] = useState(sealedOffered),
    [created, setCreated] = useState(null),
    [links, setLinks] = useState(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const id = device ? null : conversation?.id;
  const load = () =>
    api("/api/shares?conversation=" + encodeURIComponent(id)).then(
      (r) => setLinks(r.data),
      (e) => setError(e.message),
    );
  useEffect(() => {
    if (!blocked && id) load();
  }, [id, blocked]);
  // Seals the snapshot here and uploads only the ciphertext. A saved chat's
  // snapshot comes from the server, by the same rules as an open link; a
  // Device-only chat's is made from what this browser holds.
  async function createSealed() {
    const snapshot = device
      ? deviceSnapshot(device.messages, title, modelName)
      : await api("/api/shares/draft", {
          method: "POST",
          body: { conversationId: id, title },
        });
    const problem = snapshotProblem(snapshot.messages);
    if (problem) throw new Error(SNAPSHOT_PROBLEMS[problem]);
    const summary = snapshotSummary(snapshot.messages);
    const box = await sealSnapshot({ title: snapshot.title, messages: snapshot.messages });
    const r = await api("/api/shares", {
      method: "POST",
      body: {
        sealed: true,
        ...(device ? { device: true } : { conversationId: id }),
        ciphertext: box.ciphertext,
        expires_in_days: days,
      },
    });
    // The full link exists only here, in this dialog, until it's closed.
    return {
      ...r,
      title: snapshot.title,
      messages: summary.messages,
      withheld: summary.withheld,
      masked: summary.masked,
      fullUrl: sealedLink(r.url, box.key),
      fullPath: sealedLink(r.path, box.key),
    };
  }
  async function create(e) {
    e.preventDefault();
    setBusy("create");
    setError("");
    try {
      const r = sealed
        ? await createSealed()
        : await api("/api/shares", {
            method: "POST",
            body: { conversationId: id, title, expires_in_days: days },
          });
      setCreated(r);
      if (id) await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }
  async function revoke(link) {
    setBusy(link.id);
    setError("");
    try {
      await api("/api/shares/" + link.id, { method: "DELETE" });
      if (created?.id === link.id) setCreated(null);
      if (id) await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }
  const others = (links || []).filter((l) => l.id !== created?.id);
  const createdUrl = created?.sealed ? created.fullUrl : created?.url;
  return (
    <Modal title="Share a chat" onClose={onClose}>
      <div className="share-dialog">
        {blocked ? (
          <>
            <p className="share-blocked">{SHARE_BLOCK_MESSAGES[blocked]}</p>
            <div className="inline-actions">
              <Button secondary onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        ) : created ? (
          <div className="share-created" role="status">
            <p className="eyebrow">
              {created.sealed ? "SEALED LINK CREATED" : "LINK CREATED"}
            </p>
            <p className="share-created-title">
              Shared as <b data-i18n="off">{created.title}</b>
            </p>
            <div className="share-url">
              <input
                readOnly
                aria-label="Share link"
                data-i18n="off"
                value={createdUrl}
                onFocus={(e) => e.target.select()}
              />
            </div>
            {created.sealed && (
              <p className="share-sealed-warning">
                <Icon name="key" size={14} />
                <span>
                  {SEALED_FACTS.lost} Copy it now: it isn't saved anywhere
                  else, not even in your account.
                </span>
              </p>
            )}
            <div className="inline-actions">
              <CopyButton text={createdUrl} label="Copy link" />
              <a
                className="small-button"
                href={created.sealed ? created.fullPath : created.path}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="external" size={13} />
                Open
              </a>
              <button
                type="button"
                className="small-button danger-text"
                disabled={!!busy}
                onClick={() => revoke(created)}
              >
                Revoke
              </button>
            </div>
            <ul className="share-facts">
              {created.sealed && (
                <>
                  <li>
                    <Icon name="lock" size={14} />
                    <span>
                      Sealed in your browser: ANONYMA stores only the
                      encrypted copy.
                    </span>
                  </li>
                  <li>
                    <Icon name="eye" size={14} />
                    <span>{SEALED_FACTS.who}</span>
                  </li>
                  <li>
                    <Icon name="eyeoff" size={14} />
                    <span>{SEALED_FACTS.preview}</span>
                  </li>
                </>
              )}
              <li>
                <Icon name="check" size={14} />
                <span>
                  A snapshot of{" "}
                  {created.messages === 1
                    ? "1 message"
                    : `${created.messages} messages`}
                  . Messages you send later aren't added.
                </span>
              </li>
              <li>
                <Icon name="history" size={14} />
                <span>
                  <Expires link={created} />
                </span>
              </li>
              {created.masked > 0 && (
                <li>
                  <Icon name="shield" size={14} />
                  <span>
                    {created.masked === 1
                      ? "1 masked detail stays masked."
                      : `${created.masked} masked details stay masked.`}
                  </span>
                </li>
              )}
              {created.withheld > 0 && (
                <li>
                  <Icon name="file" size={14} />
                  <span>
                    {created.withheld === 1
                      ? "1 attachment replaced with a placeholder."
                      : `${created.withheld} attachments replaced with a placeholder.`}
                  </span>
                </li>
              )}
            </ul>
          </div>
        ) : (
          <form onSubmit={create}>
            {device ? (
              <div className="share-device-note" role="note">
                <Icon name="lock" size={16} />
                <p>
                  <b>This chat is kept only on this device.</b> Sharing it
                  copies it out: an encrypted copy is stored on our servers
                  until the link expires or you revoke it. Device-only chats
                  can only be shared sealed.
                </p>
              </div>
            ) : (
              sealedOffered && (
                <fieldset className="share-kind">
                  <legend>How it's shared</legend>
                  <label className={sealed ? "on" : ""}>
                    <input
                      type="radio"
                      name="share-kind"
                      checked={sealed}
                      onChange={() => setSealed(true)}
                    />
                    <span className="share-kind-text">
                      <b>
                        <Icon name="lock" size={14} />
                        Sealed <em>Recommended</em>
                      </b>
                      <small>
                        Encrypted in your browser. ANONYMA can't read it, and
                        there's no link preview.
                      </small>
                    </span>
                  </label>
                  <label className={!sealed ? "on" : ""}>
                    <input
                      type="radio"
                      name="share-kind"
                      checked={!sealed}
                      onChange={() => setSealed(false)}
                    />
                    <span className="share-kind-text">
                      <b>
                        <Icon name="eye" size={14} />
                        Unsealed
                      </b>
                      <small>
                        ANONYMA stores a readable copy, so apps can show its
                        title in a link preview.
                      </small>
                    </span>
                  </label>
                </fieldset>
              )
            )}
            <label>
              Title on the shared page
              <input
                value={title}
                maxLength={MAX_SHARE_TITLE}
                data-i18n="off"
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              Link expires after
              <select
                value={days == null ? "" : String(days)}
                onChange={(e) =>
                  setDays(e.target.value ? Number(e.target.value) : null)
                }
              >
                {SHARE_EXPIRY_DAYS.map((d) => (
                  <option key={String(d)} value={d == null ? "" : d}>
                    {expiryLabel(d)}
                  </option>
                ))}
              </select>
            </label>
            {conversation?.expires != null && !device && (
              <p className="fine-print">
                This conversation auto-deletes on {date(conversation.expires)}.
                Its links end then too.
              </p>
            )}
            <ul className="share-facts">
              <li>
                <Icon name="check" size={14} />
                <span>
                  A snapshot, not a window: messages you send later aren't
                  added.
                </span>
              </li>
              <li>
                <Icon name="shield" size={14} />
                <span>
                  Masked details stay masked: Veil tags like [EMAIL_1] are
                  shared as tags, never the real values.
                </span>
              </li>
              <li>
                <Icon name="file" size={14} />
                <span>
                  Attachments, images and files become a placeholder. Costs,
                  receipts and your account details are never shared.
                </span>
              </li>
              {sealed ? (
                <>
                  <li>
                    <Icon name="lock" size={14} />
                    <span>{SEALED_FACTS.who}</span>
                  </li>
                  <li>
                    <Icon name="key" size={14} />
                    <span>{SEALED_FACTS.lost}</span>
                  </li>
                  <li>
                    <Icon name="eyeoff" size={14} />
                    <span>{SEALED_FACTS.preview}</span>
                  </li>
                </>
              ) : (
                <li>
                  <Icon name="eye" size={14} />
                  <span>
                    Anyone with the link can read it. Revoke it any time.
                  </span>
                </li>
              )}
            </ul>
            {sealed && !device && (
              <p className="fine-print">
                The chat itself stays saved in your account as before; only
                the copy behind the link is sealed.
              </p>
            )}
            <div className="inline-actions">
              <Button type="submit" disabled={!!busy}>
                {busy === "create"
                  ? sealed
                    ? "Sealing…"
                    : "Creating…"
                  : sealed
                    ? "Seal and create link"
                    : "Create link"}
              </Button>
              <Button type="button" secondary onClick={onClose}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {error && <Notice type="error">{error}</Notice>}
        {!blocked && others.length > 0 && (
          <div className="share-existing">
            <h3>Live links to this conversation</h3>
            <ul className="share-link-list">
              {others.map((l) => (
                <LinkRow
                  key={l.id}
                  link={l}
                  busy={busy === l.id}
                  onRevoke={revoke}
                />
              ))}
            </ul>
          </div>
        )}
        {!blocked && (
          <Link
            className="text-link share-manage"
            to="/account/settings#share-links"
            onClick={onClose}
          >
            Manage all share links <Icon name="arrow" size={14} />
          </Link>
        )}
      </div>
    </Modal>
  );
}

// Account → Settings: every live link, newest first.
export function ShareLinksManager({ onError }) {
  const { config } = useApp() || {};
  const sealed = sealedShareLive(config);
  const [list, setList] = useState(null),
    [busy, setBusy] = useState("");
  const load = () =>
    api("/api/shares").then(
      (r) => setList(r.data),
      (e) => onError?.(e.message),
    );
  useEffect(() => {
    load();
  }, []);
  async function revoke(link) {
    setBusy(link.id);
    try {
      await api("/api/shares/" + link.id, { method: "DELETE" });
      await load();
    } catch (e) {
      onError?.(e.message);
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="share-links-manager" id="share-links">
      <div>
        <h2>Share links.</h2>
        <p>
          Read-only snapshots of your chats. Anyone with a link can read it
          until it expires or you revoke it. Deleting a conversation deletes
          its links.
        </p>
        {sealed && (
          <p>
            Sealed links can only be revoked here: their key is only in the
            link you copied, which ANONYMA never receives.
          </p>
        )}
      </div>
      {list === null ? null : !list.length ? (
        <p className="share-empty">
          No live share links. Open a saved chat and choose Share.
        </p>
      ) : (
        <ul className="share-link-list">
          {list.map((l) => (
            <LinkRow
              key={l.id}
              link={l}
              showTitle
              busy={busy === l.id}
              onRevoke={revoke}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
