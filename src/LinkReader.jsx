import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./ui.jsx";
import { api, uid } from "./lib.js";
import { MAX_DOCUMENTS } from "./documents.js";
import { pdfText } from "./pdf-text.js";
import { pdfHiddenText } from "./shield.js";
import {
  capWords,
  countWords,
  findLinks,
  formatWords,
  linkHost,
} from "./link-reader.js";
import "./link-reader.css";

// Link Reader in the workspace composer. A link in the prompt offers "Read
// this page"; ANONYMA's server fetches it (POST /api/read, never this
// browser, so the site sees our server and not you) and the page's text is
// attached to the message like a document (src/documents.js, marked
// source="link"). The page title and text are the site's content, so they
// carry data-i18n="off"; the labels around them are UI text.

const THIN_WORDS = 60;
function fromBase64(b64) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Turns the server's answer into an attached document. A PDF comes back as
// bytes and is read here, with the same PDF reader Documents uses (and, with
// Injection Shield on, the same check for text too small to see).
async function toDocument(link, r, shieldHidden = false) {
  let text = r.text || "",
    words = r.words || 0,
    truncated = !!r.truncated,
    pages = null,
    hiddenText = [];
  if (r.kind === "pdf") {
    const bytes = fromBase64(r.pdf || "");
    const read = await pdfText(bytes, false, shieldHidden ? pdfHiddenText : null);
    hiddenText = read.hiddenText || [];
    const capped = capWords(read.text);
    ({ text, words, truncated } = capped);
    pages = read.pages;
    if (!words) throw Error("No readable text was found in that PDF. It may be a scanned image.");
  }
  return {
    id: uid(),
    source: "link",
    kind: "link",
    requested: link,
    url: r.url,
    site: r.host,
    siteName: r.site_name || "",
    byline: r.byline || "",
    name: r.title || r.host,
    words,
    truncated,
    pages,
    text,
    chars: text.length,
    ...(hiddenText.length ? { hiddenText } : {}),
  };
}

// The "Read this page" chips for the links in the prompt (up to three).
export function LinkReaderChips({
  prompt,
  documents,
  setDocuments,
  disabled = false,
  sealed = false,
  shieldHidden = false,
  onError,
}) {
  const [reading, setReading] = useState([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const read = new Set(
    documents.filter((d) => d.source === "link").flatMap((d) => [d.requested, d.url]),
  );
  const links = findLinks(prompt).filter((l) => !read.has(l));
  if (!links.length) return null;
  const full = documents.length >= MAX_DOCUMENTS;
  async function readPage(link) {
    onError?.("");
    setReading((r) => [...r, link]);
    try {
      const r = await api("/api/read", { method: "POST", body: { url: link } });
      const doc = await toDocument(link, r, shieldHidden);
      if (alive.current)
        setDocuments((prev) =>
          prev.some((d) => d.source === "link" && d.url === doc.url) || prev.length >= MAX_DOCUMENTS
            ? prev
            : [...prev, doc],
        );
    } catch (e) {
      if (alive.current) onError?.(e.message || "Couldn't read that page.");
    } finally {
      if (alive.current) setReading((r) => r.filter((x) => x !== link));
    }
  }
  return (
    <div className="link-reader-chips">
      {links.map((link) => {
        const busy = reading.includes(link);
        const host = linkHost(link);
        if (sealed)
          return (
            <span
              key={link}
              className="link-reader-chip off"
              title="Link Reader fetches pages through our server, which would see the link, so it's off in Sealed Mode."
            >
              <Icon name="link" size={14} />
              <span>Link Reader is off in Sealed Mode</span>
            </span>
          );
        return (
          <button
            key={link}
            type="button"
            className={"link-reader-chip" + (busy ? " busy" : "")}
            disabled={disabled || busy || full}
            aria-busy={busy}
            title={
              full
                ? `Attach up to ${MAX_DOCUMENTS} documents per message.`
                : "ANONYMA's server fetches the page, so the site sees our server, not you. Free."
            }
            onClick={() => readPage(link)}
          >
            <Icon name="link" size={14} />
            <span>{busy ? "Reading…" : "Read this page"}</span>
            {host && (
              <span className="link-reader-chip-host" data-i18n="off">
                {host}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// A page that was read, as a card: in the composer (with Remove) and in a
// saved message (read only). `children` go under the "Fetched by" line
// (Injection Shield's chip, in the composer).
export function LinkCard({ doc, onRemove, children }) {
  const [open, setOpen] = useState(false);
  const words = doc.words || 0;
  // What's attached of a long page: its first 30,000 words, or in a saved
  // message what was sent after fitting the message's size limit.
  const attached = useMemo(() => (doc.truncated ? countWords(doc.text) : 0), [doc.truncated, doc.text]);
  return (
    <div className="link-card">
      <div className="link-card-head">
        <span className="link-card-icon" aria-hidden="true">
          <Icon name="link" size={16} />
        </span>
        <div className="link-card-main">
          <div className="link-card-title" data-i18n="off">
            {doc.name}
          </div>
          <div className="link-card-meta">
            <span className="link-card-site" data-i18n="off">
              {doc.site}
            </span>
            <span className="link-card-dot" aria-hidden="true">·</span>
            <span>{formatWords(words)}</span>
            {doc.pages ? (
              <>
                <span className="link-card-dot" aria-hidden="true">·</span>
                <span>{doc.pages === 1 ? "1 page" : `${doc.pages} pages`}</span>
              </>
            ) : null}
          </div>
        </div>
        {onRemove && (
          <button
            type="button"
            className="link-card-remove"
            aria-label="Remove this page"
            onClick={onRemove}
          >
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
      <div className="link-card-fetched">
        <Icon name="shield" size={13} />
        <span>Fetched by ANONYMA, not your browser</span>
      </div>
      {children}
      {doc.truncated && (
        <div className="link-card-note">
          {`A long page: only the first ${attached.toLocaleString("en-US")} words are attached.`}
        </div>
      )}
      {words > 0 && words < THIN_WORDS && (
        <div className="link-card-note">
          Only a little text came back. Pages that need JavaScript to show their text can't be read.
        </div>
      )}
      <button
        type="button"
        className="link-card-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? "eyeoff" : "eye"} size={13} />
        <span>{open ? "Hide text" : "View text"}</span>
      </button>
      {open && (
        <div className="link-card-body">
          {doc.url && (
            <div className="link-card-url" data-i18n="off">
              {doc.url}
            </div>
          )}
          <pre className="link-card-text" data-i18n="off">
            {doc.text}
          </pre>
        </div>
      )}
    </div>
  );
}
