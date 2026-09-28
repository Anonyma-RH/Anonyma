import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ReplyMarkdown } from "./RichMarkdown.jsx";
import remarkGfm from "remark-gfm";
import { Icon, Button, Modal, Notice } from "./ui.jsx";
import { api, download, isReleased, messageFromServer } from "./lib.js";
import { t } from "./i18n.js";
import {
  EXPORT_TYPES,
  SCREEN_NOTES,
  buildChatExport,
  exportFilename,
  exportJSON,
  exportMarkdown,
  localStamp,
  receiptLabel,
  restorableCount,
  speaker,
} from "./chat-export.js";
import "./chat-export.css";

// Chat Export (update "chatexport"): the Export dialog and the print page.
// Everything is built in this browser (src/chat-export.js says what a file
// holds). A saved conversation is read with the same request that opens it;
// a chat that was never saved is exported as it is on screen, with no
// request at all. Nothing is ever sent back.
export const chatExportReleased = (config) => isReleased(config, "chatexport");

// A chat that was never saved has no stored title: it's named for what it
// was, never after its first prompt.
export const SCREEN_TITLES = {
  device: "Device-only chat",
  private: "Private Mode chat",
  off_record: "Off-the-record chat",
  unsaved: "New conversation",
};
const FORMATS = [
  { id: "markdown", label: "Markdown", detail: ".md file" },
  { id: "json", label: "JSON", detail: ".json file" },
  { id: "print", label: "Print or PDF", detail: "Clean page" },
];

// `target`: { source: "server", id, title?, mode? } for a saved conversation,
// or { source: "screen", reason, mode, messages, collab? } for one that isn't.
// `veilMap` is this browser's Veil map for the chat (tag → value), used only
// if the person asks to restore masked details in the file.
export function ExportDialog({
  target,
  user,
  modelName,
  veilMap = null,
  testMode = false,
  onClose,
}) {
  const screen = target.source === "screen";
  const [chat, setChat] = useState(() =>
    screen
      ? {
          title: t(SCREEN_TITLES[target.reason] || SCREEN_TITLES.unsaved),
          fileTitle: SCREEN_TITLES[target.reason] || SCREEN_TITLES.unsaved,
          mode: target.mode,
          collab: target.collab || null,
          messages: target.messages || [],
        }
      : null,
  );
  const [error, setError] = useState(""),
    [format, setFormat] = useState("markdown"),
    [receipts, setReceipts] = useState(false),
    [citations, setCitations] = useState(true),
    [restore, setRestore] = useState(false),
    [printDoc, setPrintDoc] = useState(null),
    [saved, setSaved] = useState("");
  useEffect(() => {
    if (screen) return;
    const ctl = new AbortController();
    api("/api/conversations/" + encodeURIComponent(target.id), {
      signal: ctl.signal,
    }).then(
      (r) => {
        if (ctl.signal.aborted) return;
        setChat({
          title: r.title || "",
          fileTitle: r.title || "",
          mode: r.mode || target.mode,
          collab: r.collab || null,
          messages: (r.messages || []).map(messageFromServer),
        });
      },
      (e) => {
        if (!ctl.signal.aborted) setError(e.message);
      },
    );
    return () => ctl.abort();
  }, [screen, target.id]);
  const context = {
    userId: user?.id || null,
    username: user?.username || null,
    modelName,
  };
  const map = veilMap && typeof veilMap === "object" ? veilMap : null;
  const restorable = chat ? restorableCount(chat, map, context) : 0;
  const build = (options) =>
    buildChatExport({
      conversation: {
        id: screen ? null : target.id,
        saved: !screen,
        title: chat.title,
        mode: chat.mode,
        collab: chat.collab,
      },
      messages: chat.messages,
      ...context,
      testMode,
      ...options,
    });
  // What the file can hold, for the dialog's summary and toggles.
  const full = useMemo(
    () => (chat ? build({ receipts: true, citations: true }) : null),
    [chat],
  );
  const counts = full
    ? {
        messages: full.summary.messages,
        attachments: full.summary.attachments,
        masked: full.summary.masked_details,
        sources: full.messages.reduce(
          (n, m) => n + (m.citations?.length || 0),
          0,
        ),
        receipts: full.messages.filter((m) => m.receipt).length,
      }
    : null;
  const note = screen
    ? SCREEN_NOTES[target.reason] || SCREEN_NOTES.unsaved
    : "";
  function save() {
    const doc = build({
      receipts,
      citations,
      restore: restore && restorable ? map : null,
    });
    const name = (ext) => exportFilename(chat.fileTitle, ext);
    if (format === "print")
      return setPrintDoc({ doc, filename: name("pdf").replace(/\.pdf$/, "") });
    if (format === "json")
      download(name("json"), exportJSON(doc), EXPORT_TYPES.json.type);
    else
      download(
        name("md"),
        exportMarkdown(doc, { label: t, note }),
        EXPORT_TYPES.markdown.type,
      );
    setSaved(format === "json" ? name("json") : name("md"));
  }
  if (printDoc)
    return (
      <ChatPrintView
        doc={printDoc.doc}
        filename={printDoc.filename}
        note={note}
        onBack={() => setPrintDoc(null)}
        onClose={onClose}
      />
    );
  return (
    <Modal title="Export this chat" onClose={onClose}>
      <div className="chat-export">
        {error ? (
          <>
            <Notice type="error">{error}</Notice>
            <div className="inline-actions">
              <Button secondary onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        ) : !chat ? (
          <p className="chat-export-loading" role="status">
            Loading the conversation…
          </p>
        ) : !counts.messages ? (
          <>
            <p>There's nothing to export in this chat yet.</p>
            <div className="inline-actions">
              <Button secondary onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        ) : (
          <>
            <p
              className="chat-export-title"
              data-i18n={screen ? undefined : "off"}
            >
              {chat.title || "Untitled conversation"}
            </p>
            <p className="chat-export-lede">
              {screen
                ? "Made in this browser from what's on screen. Nothing is sent anywhere."
                : "Made in this browser from the saved conversation. Nothing is sent back."}
            </p>
            <fieldset className="chat-export-formats">
              <legend>Format</legend>
              {FORMATS.map((f) => (
                <label key={f.id} className={format === f.id ? "active" : ""}>
                  <input
                    type="radio"
                    name="chat-export-format"
                    value={f.id}
                    checked={format === f.id}
                    onChange={() => setFormat(f.id)}
                  />
                  <b>{f.label}</b>
                  <small>{f.detail}</small>
                </label>
              ))}
            </fieldset>
            <fieldset className="chat-export-options">
              <legend>Include</legend>
              <label>
                <input
                  type="checkbox"
                  checked={receipts && counts.receipts > 0}
                  disabled={!counts.receipts}
                  onChange={(e) => setReceipts(e.target.checked)}
                />
                <span>
                  Receipts: credits charged and receipt ID for each of your
                  replies
                  {!counts.receipts && <small>None in this chat</small>}
                </span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={citations && counts.sources > 0}
                  disabled={!counts.sources}
                  onChange={(e) => setCitations(e.target.checked)}
                />
                <span>
                  Web sources cited in replies
                  {!counts.sources && <small>None in this chat</small>}
                </span>
              </label>
              {restorable > 0 && (
                <label className="chat-export-restore">
                  <input
                    type="checkbox"
                    checked={restore}
                    onChange={(e) => setRestore(e.target.checked)}
                  />
                  <span>
                    Restore masked details in this download
                    <small>
                      <span>
                        {restorable === 1
                          ? "1 masked detail can be restored from what Veil keeps in this browser."
                          : `${restorable} masked details can be restored from what Veil keeps in this browser.`}
                      </span>{" "}
                      <span>
                        The restored values go only into the file, never to our
                        servers.
                      </span>
                    </small>
                  </span>
                </label>
              )}
            </fieldset>
            <ul className="chat-export-facts">
              <li>
                <Icon name="chat" size={14} />
                <span>
                  {counts.messages === 1
                    ? "1 message, with the model name on every reply."
                    : `${counts.messages} messages, with the model name on every reply.`}
                </span>
              </li>
              {note && (
                <li>
                  <Icon name="shield" size={14} />
                  <span>{note}</span>
                </li>
              )}
              {chat.collab && (
                <li>
                  <Icon name="users" size={14} />
                  <span>
                    Shared conversation: every message you can see now, with
                    members' names as shown here. Only your own replies have
                    receipts.
                  </span>
                </li>
              )}
              {counts.masked > 0 && !(restore && restorable) && (
                <li>
                  <Icon name="eyeoff" size={14} />
                  <span>
                    {counts.masked === 1
                      ? "1 masked detail stays masked, as a tag like [EMAIL_1]."
                      : `${counts.masked} masked details stay masked, as tags like [EMAIL_1].`}
                  </span>
                </li>
              )}
              {counts.attachments > 0 && (
                <li>
                  <Icon name="file" size={14} />
                  <span>
                    {counts.attachments === 1
                      ? "1 attachment appears as a placeholder with its name; its contents aren't included."
                      : `${counts.attachments} attachments appear as placeholders with their names; their contents aren't included.`}
                  </span>
                </li>
              )}
            </ul>
            {saved && (
              <p className="chat-export-saved" role="status">
                Downloaded <code data-i18n="off">{saved}</code>
              </p>
            )}
            <div className="inline-actions">
              <Button onClick={save}>
                <Icon
                  name={format === "print" ? "file" : "download"}
                  size={15}
                />
                {format === "markdown"
                  ? "Download Markdown"
                  : format === "json"
                    ? "Download JSON"
                    : "Open print view"}
              </Button>
              <Button secondary onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

const MARKDOWN_PLUGINS = [remarkGfm];
// A picture in a reply's own Markdown prints as a placeholder, like the
// file formats; nothing is fetched to print it.
const PRINT_COMPONENTS = {
  img: ({ alt }) => (
    <span className="chat-print-inline-image">
      <span>Image</span>
      {alt ? <span data-i18n="off">{alt}</span> : null}
    </span>
  ),
};

// The printable page: a clean document over the app, printed on its own by
// the print stylesheet (chat-export.css). "Print or save as PDF" opens the
// browser's print dialog, where Save as PDF keeps a copy.
export function ChatPrintView({ doc, filename, note = "", onBack, onClose }) {
  const printButton = useRef(null);
  useEffect(() => {
    const root = document.documentElement;
    const title = document.title;
    // The app behind the page is out of reach (keyboard and screen readers)
    // while it's open.
    const app = document.getElementById("root");
    root.classList.add("chat-printing");
    app?.setAttribute("inert", "");
    // The print dialog suggests the page title as the PDF's name.
    document.title = filename;
    printButton.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      root.classList.remove("chat-printing");
      app?.removeAttribute("inert");
      document.title = title;
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  const c = doc.conversation;
  return createPortal(
    <div
      className="chat-print-root"
      role="dialog"
      aria-modal="true"
      aria-label="Print view"
    >
      <div className="chat-print-toolbar">
        <button type="button" className="small-button" onClick={onBack}>
          Back
        </button>
        <span>In the print dialog, choose Save as PDF to keep a PDF copy.</span>
        <button
          ref={printButton}
          type="button"
          className="button chat-print-go"
          onClick={() => window.print()}
        >
          Print or save as PDF
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Close print view"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <article className="chat-print-page">
        <header className="chat-print-head">
          <p className="chat-print-brand">
            <span data-i18n="off">ANONYMA</span>
            <span>Chat Export</span>
          </p>
          <h1 data-i18n="off">{c.title}</h1>
          <dl>
            <dt>Exported</dt>
            <dd>{localStamp(doc.exported_at)}</dd>
            {c.started_at && (
              <>
                <dt>Conversation</dt>
                <dd>
                  {localStamp(c.started_at)}
                  {c.last_message_at && c.last_message_at !== c.started_at
                    ? " – " + localStamp(c.last_message_at)
                    : ""}
                </dd>
              </>
            )}
            <dt>Messages</dt>
            <dd>{doc.summary.messages}</dd>
            {c.collab && (
              <>
                <dt>Shared in</dt>
                <dd data-i18n="off">{c.collab.name}</dd>
              </>
            )}
          </dl>
          {(note ||
            doc.options.veil_restored ||
            doc.summary.masked_details > 0 ||
            doc.summary.attachments > 0) && (
            <ul className="chat-print-notes">
              {!c.saved && note && <li>{note}</li>}
              {doc.options.veil_restored ? (
                <li>
                  Masked details were restored in this browser for this page.
                </li>
              ) : (
                doc.summary.masked_details > 0 && (
                  <li>
                    Masked details stay masked, shown as tags like [EMAIL_1].
                  </li>
                )
              )}
              {doc.summary.attachments > 0 && (
                <li>
                  Attachments and images appear as placeholders; their contents
                  aren't included.
                </li>
              )}
              {doc.local_test && doc.options.receipts && (
                <li>Local test mode: receipts show fixture credits.</li>
              )}
            </ul>
          )}
        </header>
        {doc.messages.map((m, i) => (
          <section key={i} className={"chat-print-message " + m.role}>
            <header>
              <b
                data-i18n={m.role === "assistant" || !m.you ? "off" : undefined}
              >
                {speaker(m, (s) => s)}
              </b>
              {m.created_at && (
                <time dateTime={m.created_at}>{localStamp(m.created_at)}</time>
              )}
            </header>
            {m.text.trim() && (
              <div className="chat-print-body" data-i18n="off">
                <ReplyMarkdown
                  rich={m.role === "assistant"}
                  remarkPlugins={MARKDOWN_PLUGINS}
                  components={PRINT_COMPONENTS}
                >
                  {m.text}
                </ReplyMarkdown>
              </div>
            )}
            {m.attachments.map((a, j) =>
              a.type === "document" ? (
                <p key={j} className="chat-print-placeholder">
                  <span>Attached document</span>
                  <b data-i18n="off">{a.name}</b>
                  <span>Its text isn't included.</span>
                </p>
              ) : (
                <p key={j} className="chat-print-placeholder">
                  <span>Image</span>
                  <span>Not included.</span>
                </p>
              ),
            )}
            {m.interrupted && (
              <p className="chat-print-placeholder">Reply interrupted.</p>
            )}
            {m.citations?.length > 0 && (
              <div className="chat-print-sources">
                <b>Sources</b>
                <ol>
                  {m.citations.map((s) => (
                    <li key={s.url} data-i18n="off">
                      {s.title ? s.title + " · " : ""}
                      <span className="chat-print-url">{s.url}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {m.receipt && (
              <p className="chat-print-receipt">
                <span>{receiptLabel(m.receipt, doc.local_test)}</span>
                {m.receipt.id && (
                  <span>
                    <span>Receipt ID</span>{" "}
                    <code data-i18n="off">{m.receipt.id}</code>
                  </span>
                )}
                {m.receipt.signed && <span>Signed</span>}
              </p>
            )}
          </section>
        ))}
      </article>
    </div>,
    document.body,
  );
}
