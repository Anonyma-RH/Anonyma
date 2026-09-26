import React, { useState } from "react";
import { Icon, Notice } from "./ui.jsx";
import { uid } from "./lib.js";
import ReusableUploads from "./ReusableUploads.jsx";
import { extractOffice, browserInflate, textBytes } from "./file-formats.js";
import { unveil } from "./veil.js";
import { CleanNote } from "./CleanUploads.jsx";
import { pdfText } from "./pdf-text.js";
import { LinkCard } from "./LinkReader.jsx";
import {
  MAX_DOCUMENTS,
  MAX_FILE_BYTES,
  DOCUMENT_ACCEPT,
  documentKind,
  isSupportedDocument,
  formatBytes,
  formatChars,
  fitDocuments,
} from "./documents.js";
import "./documents.css";

// PDF text extraction lives in pdf-text.js (shared with Link Reader), which
// fetches pdfjs-dist only once a PDF is actually attached.
async function extractPdfText(file, withDetails = false) {
  return pdfText(await file.arrayBuffer(), withDetails);
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
  const hidden = doc.hidden?.length ? { status: "cleaned", details: doc.hidden } : null;
  return (
    <div className="document-chip">
      <details>
        <summary className={hidden ? "has-clean-note" : undefined}>
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
          {hidden && <CleanNote result={hidden} notSent />}
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
  filesEnabled = false,
  cleanEnabled = false,
  privateContext = false,
  audioEnabled = false,
  onRefresh,
  openRequest = 0,
  seedGuard = false,
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
    const unsupported = picked.find((f) => !isSupportedDocument(f) || (!filesEnabled && documentKind(f) === "office"));
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
          warning = "",
          hidden = null;
        try {
          if (kind === "pdf") {
            const r = await extractPdfText(file, cleanEnabled);
            text = r.text;
            pages = r.pages;
            hidden = r.hidden;
            if (!text)
              warning =
                "No extractable text found — this PDF may be a scanned image.";
          } else if (kind === "office") {
            const bytes = await file.arrayBuffer();
            const extension = file.name.split(".").at(-1).toLowerCase();
            const result = await extractOffice(bytes, extension, browserInflate);
            text = result.text;
            warning = result.warning + (result.truncated ? " Extracted text was trimmed." : "");
            if (cleanEnabled) {
              // Only the text is sent; the properties stay on this device.
              try {
                const { cleanOffice } = await import("./clean-uploads.js");
                hidden = (await cleanOffice(bytes, extension, { inspectOnly: true })).details;
              } catch {
                hidden = null;
              }
            }
          } else {
            text = textBytes(new Uint8Array(await file.arrayBuffer()));
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
          hidden,
        });
      }
      setDocuments((prev) => [...prev, ...added]);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
    <label
      className={"attachment-control" + (busy ? " busy" : "")}
      title={filesEnabled ? "Attach PDF, text, code, DOCX, XLSX or PPTX. Text is extracted locally and sent only with your message." : "Attach PDF, text, CSV or code files. Text is extracted in this browser and sent with your message."}
    >
      <Icon name="file" size={18} />
      <span className="sr-only">Attach document</span>
      <input
        type="file"
        multiple
        accept={filesEnabled ? DOCUMENT_ACCEPT : DOCUMENT_ACCEPT.replace(/,\.(docx|xlsx|pptx)/g, "")}
        disabled={disabled || busy}
        onChange={addFiles}
      />
    </label>
    {filesEnabled && <ReusableUploads documents={documents} setDocuments={setDocuments} disabled={disabled} privateContext={privateContext} audioEnabled={audioEnabled} cleanEnabled={cleanEnabled} onRefresh={onRefresh} openRequest={openRequest} seedGuard={seedGuard} />}
    </>
  );
}

// Chips for documents attached to the message being composed, plus a notice
// once their combined size would be trimmed before sending.
export function DocumentChips({ documents, setDocuments, prompt = "" }) {
  if (!documents.length) return null;
  const budget = fitDocuments(prompt, documents);
  return (
    <div className="document-list">
      {documents.map((doc, i) => {
        const remove = () => setDocuments((prev) => prev.filter((_, j) => j !== i));
        // A page read by Link Reader (src/LinkReader.jsx) shows as its card.
        return doc.source === "link" ? (
          <LinkCard key={doc.id} doc={doc} onRemove={remove} />
        ) : (
          <DocumentChip key={doc.id} doc={doc} onRemove={remove} />
        );
      })}
      {budget.truncated && (
        <Notice>
          Attached documents total {formatChars(budget.totalChars)}; only the
          first {formatChars(budget.budget)} will be sent to the model.
        </Notice>
      )}
    </div>
  );
}

// Collapsed, read-only chips for documents recovered from a saved message
// (see documents.js parseDocumentBlocks), used in conversation history.
// With Veil on, the saved text holds [TAG_n] placeholders; veilMap (this
// browser's tag -> value map) restores the real values on screen only.
// A page read by Link Reader shows as its card when `linkCards` is on (the
// update is released); Veil never masked its text, so there's nothing to
// restore in it.
export function MessageDocuments({ documents, veilMap, linkCards = false }) {
  if (!documents?.length) return null;
  const shown = veilMap
    ? documents.map((doc) => {
        if (linkCards && doc.source === "link") return doc;
        const text = unveil(doc.text, veilMap);
        return { ...doc, name: unveil(doc.name, veilMap), text, chars: text.length };
      })
    : documents;
  return (
    <div className="document-list document-list-history">
      {shown.map((doc, i) =>
        linkCards && doc.source === "link" ? (
          <LinkCard key={i} doc={doc} />
        ) : (
          <DocumentChip key={i} doc={doc} />
        ),
      )}
    </div>
  );
}
