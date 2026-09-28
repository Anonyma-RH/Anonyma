// Bookmarks, shared by the workspace and the server (server/routes/bookmarks.js):
// the limits, the note rules, the excerpt a bookmark shows and the link that
// opens its message. No DOM or React here, so tests can run it directly.

// Bookmarks an account can keep, and a note's length.
export const MAX_BOOKMARKS = 1000;
export const MAX_NOTE = 140;
// Conversation modes whose messages can be bookmarked: the ones the workspace
// opens as a thread. Symposium runs have no thread to jump into, and
// off-the-record and Private chats are never saved at all.
export const BOOKMARK_MODES = ["chat", "code", "uncensored"];
// How much of a message a bookmark shows.
export const EXCERPT_LENGTH = 280;

// One line, no control characters, trimmed.
export function normalizeNote(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Markdown read as plain words, on one line: no code fences, heading, quote
// or list markers, emphasis, inline-code ticks or link addresses.
export function plain(text) {
  return String(text ?? "")
    .replace(/^```[^\n]*$/gm, " ")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(?=\S)|\d{1,3}[.)]\s+)/gm, "")
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// A reply's finished ```mermaid blocks, taken out: once Math & Diagrams is
// released, an excerpt doesn't show a diagram's source as words.
const DIAGRAM_BLOCK = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[`~]*[ \t]*$/gim;
export function withoutDiagrams(text) {
  let diagrams = 0;
  const rest = String(text ?? "").replace(DIAGRAM_BLOCK, () => {
    diagrams++;
    return " ";
  });
  return { text: rest, diagrams };
}

// The start of a message as one line: a prompt's typed words without the
// documents attached to it (as src/branches.js's promptParts splits them),
// or a reply's text. `more` says the message goes on past the excerpt.
// With `diagrams` (Math & Diagrams released), a reply's diagrams are left
// out and `diagram` says it has one.
export function excerptOf(text, role = "assistant", { diagrams = false } = {}) {
  let s = typeof text === "string" ? text : "";
  let diagram = false;
  if (role === "user") {
    if (s.startsWith("<document ")) s = "";
    const at = s.indexOf("\n\n<document ");
    if (at >= 0) s = s.slice(0, at);
  } else if (diagrams) {
    const cut = withoutDiagrams(s);
    s = cut.text;
    diagram = cut.diagrams > 0;
  }
  const extra = diagram ? { diagram: true } : {};
  s = plain(s);
  if (s.length <= EXCERPT_LENGTH) return { excerpt: s, more: false, ...extra };
  const cut = s.slice(0, EXCERPT_LENGTH);
  const space = cut.lastIndexOf(" ");
  return {
    excerpt: (space > EXCERPT_LENGTH * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…",
    more: true,
    ...extra,
  };
}

// The workspace link that opens a bookmark's conversation and scrolls to its
// message: /workspace/<mode>?c=<conversation>&m=<message>.
export function bookmarkLink(b, { demo = false } = {}) {
  const mode = BOOKMARK_MODES.includes(b?.conversation_mode) ? b.conversation_mode : "chat";
  const q = new URLSearchParams({
    ...(demo ? { demo: "1" } : {}),
    c: b.conversation_id,
    m: b.message_id,
  });
  return "/workspace/" + mode + "?" + q;
}

// Whether a message on screen can carry a star: a saved message (or one just
// saved, whose id is looked up on the first star) of a saved conversation,
// never off the record, in Private Mode, in a Device Vault chat, a prepared
// example or the demo.
export function canBookmark({ message, conversation, mode, ephemeral, privateMode, deviceOnly, demo }) {
  return (
    !demo &&
    !!conversation &&
    !ephemeral &&
    !privateMode &&
    !deviceOnly &&
    BOOKMARK_MODES.includes(mode) &&
    !!message &&
    !message.sample &&
    ["user", "assistant"].includes(message.role)
  );
}

// A just-sent exchange has no message ids in the browser yet. The saved
// conversation lists the same messages in the same order, so the one at
// `index` is the saved message at `index`, when the two lists still agree.
export function savedIdAt(local, saved, index) {
  if (!Array.isArray(local) || !Array.isArray(saved)) return null;
  if (local.length !== saved.length) return null;
  for (let i = 0; i < local.length; i++)
    if (local[i]?.role !== saved[i]?.role) return null;
  return saved[index]?.id || null;
}
