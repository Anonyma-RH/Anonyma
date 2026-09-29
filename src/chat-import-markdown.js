// Chat Import's third destination: Markdown files, made here from the chats
// the person chose. Nothing is saved anywhere and nothing leaves the
// browser. Each chat goes through Chat Export's own Markdown writer
// (src/chat-export.js), so raw HTML is shown as text, links a chat wouldn't
// follow lose their address, and an open code block is closed.
import { buildChatExport, exportMarkdown, exportFilename } from "./chat-export.js";
import { sourceName } from "./chat-import.js";

// One chat as a Markdown document. `label` translates the fixed labels the
// same way Chat Export does (the chat's own words are never translated).
export function chatMarkdown(chat, source, { label = (s) => s } = {}) {
  const doc = buildChatExport({
    conversation: { id: null, title: chat.title, mode: "chat", saved: false },
    messages: chat.messages.map((m) => ({
      role: m.role,
      content: m.text,
      created: m.at,
      ...(m.role === "assistant" ? { model: sourceName(source) } : {}),
    })),
  });
  const written = `- ${label("Written in")} ${sourceName(source)}`;
  return exportMarkdown(doc, { label }).replace(/^(# [^\n]*\n\n)/, `$1${written}\n`);
}

// Files for these chats: names carry each chat's own date, and repeats get
// a number, so they sort by when the chat happened and never overwrite.
// `used` is the set of names already taken (shared across calls).
export function markdownFiles(chats, source, { label, used = new Set() } = {}) {
  return chats.map((chat) => {
    const base = exportFilename(chat.title, "md", chat.updated || chat.created || Date.now());
    let name = base,
      n = 1;
    while (used.has(name)) name = base.replace(/\.md$/, `-${++n}.md`);
    used.add(name);
    return { name, text: chatMarkdown(chat, source, { label }) };
  });
}

// One file for one chat, a ZIP of files for several. Returns { name, blob }.
export async function markdownDownload(files, source) {
  if (files.length === 1)
    return { name: files[0].name, blob: new Blob([files[0].text], { type: "text/markdown;charset=utf-8" }), count: 1 };
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.text);
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const day = new Date().toISOString().slice(0, 10);
  return { name: `anonyma-${source}-import-${day}.zip`, blob, count: files.length };
}
