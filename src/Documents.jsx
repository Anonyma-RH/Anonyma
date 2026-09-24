import React, { useState } from "react";
import { Icon, Notice } from "./ui.jsx";
import { uid } from "./lib.js";
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
function DocumentChip({ doc, onRemove }) {
  const meta = doc.pages
    ? `${doc.pages} page${doc.pages === 1 ? "" : "s"}`
    : doc.size != null
      ? formatBytes(doc.size)
      : null;
  return (
    <div className="document-chip">
      <details>
        <summary>
          <Icon name="file" size={14} />
          <span className="document-chip-name">{doc.name}</span>
          <span className="document-chip-meta">
            {meta ? meta + " · " : ""}
            {formatChars(doc.chars)}
            {doc.truncated ? " · trimmed" : ""}
          </span>
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
        <pre className="document-chip-preview">
          {doc.text || "No text was extracted from this file."}
        </pre>
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
      title="Attach a PDF, text or code file. Document text is sent to the model and saved with the conversation."
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
export function MessageDocuments({ documents }) {
  if (!documents?.length) return null;
  return (
    <div className="document-list document-list-history">
      {documents.map((doc, i) => (
        <DocumentChip key={i} doc={doc} />
      ))}
    </div>
  );
}
