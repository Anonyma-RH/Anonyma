// Documents in chat: pure helpers only (file-type detection, block building,
// parsing and budget math). No DOM, File or pdfjs access here — that lives in
// Documents.jsx, which is exempt from unit tests because it needs a browser.
// The server trims a conversation to ~120,000 characters (server/models.js);
// this keeps attached document text well under that on its own.

export const MAX_DOCUMENTS = 5;
export const MAX_TOTAL_CHARS = 100000;
// A soft guard so one huge upload can't freeze the tab before extraction
// even starts; the character budget above is what actually limits context.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const TEXT_EXTENSIONS = [
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".php",
  ".c",
  ".cpp",
  ".h",
  ".cs",
  ".swift",
  ".kt",
  ".sql",
  ".html",
  ".css",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
];
// Extension -> extraction kind. Detected by filename, not MIME type: browsers
// report inconsistent (or empty) types for code files.
export const DOCUMENT_KINDS = Object.fromEntries([
  [".pdf", "pdf"],
  ...TEXT_EXTENSIONS.map((ext) => [ext, "text"]),
]);
export const DOCUMENT_ACCEPT = Object.keys(DOCUMENT_KINDS).join(",");

export function extensionOf(name) {
  const m = /\.[^./\\]+$/.exec(String(name || ""));
  return m ? m[0].toLowerCase() : "";
}
export function documentKind(file) {
  return DOCUMENT_KINDS[extensionOf(file?.name)] || null;
}
export function isSupportedDocument(file) {
  return documentKind(file) !== null;
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
export function formatChars(n) {
  const v = Number(n) || 0;
  return v.toLocaleString() + (v === 1 ? " char" : " chars");
}

// XML-style escaping so a document's own text can never be mistaken for
// markup: "&" first, then the characters that form tags/attributes.
export function escapeDocumentText(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeDocumentText(s).replace(/"/g, "&quot;");
}
// Multi-character entities first, so a literal "&lt;" round-trips instead of
// being read as a nested "<".
export function unescapeDocumentText(s) {
  return String(s ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

// One <document> block. Only PDFs carry a page count, matching the example
// in the feature spec; "truncated" is set once budget trimming cuts a file.
export function buildDocumentBlock(doc) {
  const attrs = [`name="${escapeAttr(doc?.name || "document")}"`];
  if (doc?.pages) attrs.push(`pages="${Number(doc.pages)}"`);
  if (doc?.truncated) attrs.push(`truncated="true"`);
  return `<document ${attrs.join(" ")}>${escapeDocumentText(doc?.text)}</document>`;
}
export function buildDocumentsBlock(documents) {
  return (documents || []).map(buildDocumentBlock).join("\n\n");
}
// What actually gets sent: the typed prompt, then the delimited documents.
export function composeMessageWithDocuments(prompt, documents) {
  const base = String(prompt || "").trimEnd();
  const block = buildDocumentsBlock(documents);
  if (!block) return base;
  return base ? base + "\n\n" + block : block;
}

const BLOCK_RE = /<document\s+([^>]*)>([\s\S]*?)<\/document>/g;
const ATTR_RE = /([\w-]+)="([^"]*)"/g;
// Recovers { text, documents } from a saved message so history can render
// the prompt normally and the documents as collapsed chips.
export function parseDocumentBlocks(content) {
  if (typeof content !== "string" || !content.includes("<document"))
    return { text: content || "", documents: [] };
  const documents = [];
  let cleaned = "";
  let lastIndex = 0;
  let match;
  BLOCK_RE.lastIndex = 0;
  while ((match = BLOCK_RE.exec(content))) {
    cleaned += content.slice(lastIndex, match.index);
    lastIndex = BLOCK_RE.lastIndex;
    const attrs = {};
    let am;
    ATTR_RE.lastIndex = 0;
    while ((am = ATTR_RE.exec(match[1])))
      attrs[am[1]] = unescapeDocumentText(am[2]);
    const text = unescapeDocumentText(match[2]);
    documents.push({
      name: attrs.name || "document",
      pages: attrs.pages ? Number(attrs.pages) : null,
      truncated: attrs.truncated === "true",
      chars: text.length,
      text,
    });
  }
  cleaned += content.slice(lastIndex);
  return { text: cleaned.trim(), documents };
}

export function totalChars(documents) {
  return (documents || []).reduce(
    (n, d) => n + (d.chars ?? d.text?.length ?? 0),
    0,
  );
}
// Keeps attached text within maxTotal, cutting later files first (in list
// order) once the budget runs out, and marking what got cut.
export function applyBudget(documents, maxTotal = MAX_TOTAL_CHARS) {
  let used = 0;
  let truncated = false;
  const out = (documents || []).map((doc) => {
    const chars = doc.chars ?? doc.text?.length ?? 0;
    const remaining = maxTotal - used;
    if (remaining <= 0) {
      truncated = true;
      return { ...doc, text: "", chars: 0, truncated: true };
    }
    if (chars > remaining) {
      truncated = true;
      used = maxTotal;
      return { ...doc, text: String(doc.text || "").slice(0, remaining), chars: remaining, truncated: true };
    }
    used += chars;
    return { ...doc, truncated: !!doc.truncated };
  });
  return {
    documents: out,
    truncated,
    totalChars: totalChars(documents),
    keptChars: used,
  };
}
