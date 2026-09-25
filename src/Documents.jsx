import React, { useState } from "react";
import { Icon, Notice } from "./ui.jsx";
import { uid } from "./lib.js";
import { unveil } from "./veil.js";
import {
  MAX_DOCUMENTS,
  MAX_TOTAL_CHARS,
  MAX_FILE_BYTES,
  DOCUMENT_ACCEPT,
  documentKind,
  isSupportedDocument,
  formatBytes,
  formatChars,
  applyBudget,
} from "./documents.js";
import "./documents.css";

// pdfjs-dist is only fetched once someone actually attaches a PDF, so it
// never lands in the main bundle. The worker URL is resolved the Vite way:
// a `?url` import hands back the hashed asset path to assign as workerSrc.
async function loadPdfjs() {
  const [pdfjs, workerUrl] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;
  return pdfjs;
}
async function extractPdfText(file) {
  const pdfjs = await loadPdfjs();
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .map((item) => item.str || "")
        .join(" ")
        .trim(),
    );
  }
  return { text: pages.join("\n\n").trim(), pages: doc.numPages };
}

// One document, attached in the composer or recovered from a saved message.
// onRemove is only passed for live attachments; history chips are read-only.
// The file name and its text are user content, so they carry
// data-i18n="off"; the size, count and notes around them are UI text.
function DocumentChip({ doc, onRemove }) {
  const meta = [
    doc.pages
      ? `${doc.pages} page${doc.pages === 1 ? "" : "s"}`
      : doc.size != null
        ? formatBytes(doc.size)
        : null,
    formatChars(doc.chars),
    doc.truncated ? "trimmed" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="document-chip">
      <details>
        <summary>
          <Icon name="file" size={14} />
          <span className="document-chip-name" data-i18n="off">
            {doc.name}
          </span>
          <span className="document-chip-meta">{meta}</span>
          {doc.warning && (
            <Icon
              name="warning"
              size={13}
              className="document-chip-warn-icon"
            />
          )}
        </summary>
        {doc.warning && <p className="document-chip-note">{doc.warning}</p>}
        {doc.truncated && !doc.warning && (
          <p className="document-chip-note">
            Only part of this file was sent — it was trimmed to fit the
            context budget.
          </p>
        )}
        {doc.text ? (
          <pre className="document-chip-preview" data-i18n="off">
            {doc.text}
          </pre>
        ) : (
          !doc.warning && (
            <p className="document-chip-note">
              No text was extracted from this file.
            </p>
          )
        )}
      </details>
      {onRemove && (
        <button
          type="button"
          className="document-chip-remove"
          aria-label={"Remove " + doc.name}
          onClick={onRemove}
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}

// The "Attach document" control: PDF and text extraction happen entirely in
// the browser before anything is sent.
export default function DocumentAttach({
  documents,
  setDocuments,
  disabled,
  onError,
}) {
  const [busy, setBusy] = useState(false);
  async function addFiles(e) {
    const picked = [...e.target.files];
    e.target.value = "";
    if (!picked.length) return;
    onError?.("");
    if (documents.length + picked.length > MAX_DOCUMENTS) {
      onError?.(`Attach up to ${MAX_DOCUMENTS} documents per message.`);
      return;
    }
    const unsupported = picked.find((f) => !isSupportedDocument(f));
    if (unsupported) {
      onError?.(`"${unsupported.name}" isn't a supported document type.`);
      return;
    }
    const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) {
      onError?.(
        `"${tooBig.name}" is larger than ${formatBytes(MAX_FILE_BYTES)}.`,
      );
      return;
    }
    setBusy(true);
    try {
      const added = [];
      for (const file of picked) {
        const kind = documentKind(file);
        let text = "",
          pages = null,
          warning = "";
        try {
          if (kind === "pdf") {
            const r = await extractPdfText(file);
            text = r.text;
            pages = r.pages;
            if (!text)
              warning =
                "No extractable text found — this PDF may be a scanned image.";
          } else {
            text = await file.text();
          }
        } catch (err) {
          warning =
            "Could not read this file" +
            (err?.message ? ": " + err.message : ".");
        }
        added.push({
          id: uid(),
          name: file.name,
          kind,
          pages,
          size: file.size,
          text,
          chars: text.length,
          warning,
        });
      }
      setDocuments((prev) => [...prev, ...added]);
    } finally {
      setBusy(false);
    }
  }
  return (
    <label
      className={"attachment-control" + (busy ? " busy" : "")}
      title="Attach PDF, text, CSV or code files. Their text is extracted in this browser, sent with your message and kept like the rest of the chat."
    >
      <Icon name="file" size={18} />
      <span className="sr-only">Attach document</span>
      <input
        type="file"
        multiple
        accept={DOCUMENT_ACCEPT}
        disabled={disabled || busy}
        onChange={addFiles}
      />
    </label>
  );
}

// Chips for documents attached to the message being composed, plus a notice
// once their combined size would be trimmed before sending.
export function DocumentChips({ documents, setDocuments }) {
  if (!documents.length) return null;
  const budget = applyBudget(documents, MAX_TOTAL_CHARS);
  return (
    <div className="document-list">
      {documents.map((doc, i) => (
        <DocumentChip
          key={doc.id}
          doc={doc}
          onRemove={() =>
            setDocuments((prev) => prev.filter((_, j) => j !== i))
          }
        />
      ))}
      {budget.truncated && (
        <Notice>
          Attached documents total {formatChars(budget.totalChars)}; only the
          first {formatChars(MAX_TOTAL_CHARS)} will be sent to the model.
        </Notice>
      )}
    </div>
  );
}

// Collapsed, read-only chips for documents recovered from a saved message
// (see documents.js parseDocumentBlocks), used in conversation history.
// With Veil on, the saved text holds [TAG_n] placeholders; veilMap (this
// browser's tag -> value map) restores the real values on screen only.
export function MessageDocuments({ documents, veilMap }) {
  if (!documents?.length) return null;
  const shown = veilMap
    ? documents.map((doc) => {
        const text = unveil(doc.text, veilMap);
        return { ...doc, name: unveil(doc.name, veilMap), text, chars: text.length };
      })
    : documents;
  return (
    <div className="document-list document-list-history">
      {shown.map((doc, i) => (
        <DocumentChip key={i} doc={doc} />
      ))}
    </div>
  );
}
