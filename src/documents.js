// Documents in chat: pure helpers only (file-type detection, block building,
// parsing and budget math). No DOM, File or pdfjs access here — that lives in
// Documents.jsx, which is exempt from unit tests because it needs a browser.
// The server refuses a workspace message over 48,000 characters
// (server/models.js), so what's attached is fitted to that together with
// the typed prompt; see fitDocuments.

export const MAX_DOCUMENTS = 5;
export const MAX_TOTAL_CHARS = 100000;
// The server's per-message cap for the workspace, and room left for Veil's
// tags (a masked value can be a little longer than the original).
export const MESSAGE_LIMIT = 48000;
const MESSAGE_HEADROOM = 1000;
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
  [".docx", "office"],
  [".xlsx", "office"],
  [".pptx", "office"],
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
// A page read by Link Reader (src/link-reader.js) is marked source="link"
// and carries its URL, host and word count.
export function buildDocumentBlock(doc) {
  const attrs = [`name="${escapeAttr(doc?.name || "document")}"`];
  if (doc?.source === "link") {
    attrs.push(`source="link"`);
    if (doc.url) attrs.push(`url="${escapeAttr(doc.url)}"`);
    if (doc.site) attrs.push(`site="${escapeAttr(doc.site)}"`);
    if (doc.words) attrs.push(`words="${Number(doc.words) || 0}"`);
  }
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
      ...(attrs.source === "link"
        ? {
            source: "link",
            url: attrs.url || "",
            site: attrs.site || "",
            words: Number(attrs.words) || 0,
          }
        : {}),
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
      return {
        ...doc,
        text: String(doc.text || "").slice(0, remaining),
        chars: remaining,
        truncated: true,
      };
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

// The documents, trimmed so the whole message (prompt, block markup and
// escaping included) stays within the server's per-message cap. `budget` is
// how many characters of document text that leaves.
export function fitDocuments(prompt, documents, limit = MESSAGE_LIMIT) {
  const room = limit - MESSAGE_HEADROOM;
  // The message with every document empty: prompt, tags and separators.
  const markup = composeMessageWithDocuments(
    prompt,
    (documents || []).map((d) => ({ ...d, text: "", truncated: true })),
  ).length;
  let budget = Math.min(MAX_TOTAL_CHARS, totalChars(documents));
  let fitted = applyBudget(documents, budget);
  for (let i = 0; i < 8; i++) {
    const length = composeMessageWithDocuments(prompt, fitted.documents).length;
    if (length <= room) break;
    // Escaping can make text longer than its character count, so scale by
    // the ratio actually seen, and step down a little more each round.
    const text = Math.max(1, length - markup);
    const next = Math.floor(((room - markup) * budget) / text) - 16 * (i + 1);
    budget = Math.max(0, Math.min(budget - 1, next));
    fitted = applyBudget(documents, budget);
  }
  return { ...fitted, budget };
}

// Each asynchronous saved-upload action belongs to one composer context.
// Returning to a prior context never revives an older action.
export function createUploadActivity() {
  let alive = true,
    blocked = false,
    context,
    epoch = 0;
  return {
    update(privateContext, disabled) {
      const next = `${!!privateContext}:${!!disabled}`;
      if (next !== context) {
        context = next;
        epoch++;
      }
      blocked = !!privateContext || !!disabled;
    },
    mount() {
      alive = true;
    },
    dispose() {
      alive = false;
      epoch++;
    },
    capture() {
      const started = epoch;
      return () => alive && !blocked && epoch === started;
    },
  };
}
