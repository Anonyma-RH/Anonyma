// Screenshot to site, the browser's side: helpers only (the picture redrawn
// small, the payloads, versions, a saved page read back, file names). The
// page is src/ShotToSite.jsx; what the server and the browser share is
// src/site-spec.js. Nothing here touches the network; the functions that
// draw need a browser, the rest run in node (tests/shottosite.test.mjs).
import {
  IMAGE_MIMES,
  IMAGE_TARGET_CHARS,
  MAX_VERSIONS,
  codeFences,
  readPage,
  siteText,
} from "./site-spec.js";
import { dataUrlBlob, fitPlan } from "./photo-tools.js";

export const MODEL_KEY = "screenshot:model";
export const SAVE_KEY = "screenshot:save";

export class SiteImageError extends Error {}

// ---- The picture, redrawn small in this browser ----
//
// A picture in a chat is priced by its length (server/core.js quote), and a
// model reads a screenshot no better above about 1,600 px, so the copy that
// is sent is redrawn to fit IMAGE_TARGET_CHARS: a PNG stays a PNG while it
// is small (crisp text, flat colour), otherwise a JPEG, stepping down in size
// and quality until it fits. The redraw carries no metadata either.
const SIDES = [1600, 1280, 1024, 800];
const QUALITIES = [0.82, 0.7, 0.58];
const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
const readUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new SiteImageError("The picture couldn't be read."));
    reader.readAsDataURL(blob);
  });

export async function siteCopy(url, { target = IMAGE_TARGET_CHARS } = {}) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(dataUrlBlob(url));
  } catch {
    throw new SiteImageError("This picture couldn't be opened here. Try a PNG, JPEG or WebP.");
  }
  try {
    const first = /^data:image\/(?:png|webp)/i.test(url);
    for (const side of SIDES) {
      const plan = fitPlan(bitmap.width, bitmap.height, side);
      const canvas = document.createElement("canvas");
      canvas.width = plan.width;
      canvas.height = plan.height;
      const ctx = canvas.getContext("2d");
      // A JPEG has no transparency: a see-through picture goes onto white.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, plan.width, plan.height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, plan.width, plan.height);
      const tries = [...(first ? [["image/png"]] : []), ...QUALITIES.map((q) => ["image/jpeg", q])];
      for (const [type, quality] of tries) {
        const blob = await toBlob(canvas, type, quality);
        if (!blob || !IMAGE_MIMES.includes(blob.type)) continue;
        // Cheap test before reading it: base64 is 4 characters for 3 bytes.
        if (Math.ceil((blob.size * 4) / 3) + 30 > target) continue;
        const copy = await readUrl(blob);
        if (copy.length <= target)
          return {
            url: copy,
            mime: blob.type,
            chars: copy.length,
            width: plan.width,
            height: plan.height,
            original: { width: bitmap.width, height: bitmap.height },
          };
      }
    }
  } finally {
    bitmap.close?.();
  }
  throw new SiteImageError("This picture is too detailed to shrink enough to send. Try a smaller one.");
}

// An image from a paste event, when there is one.
export function pastedImage(event) {
  const items = event?.clipboardData?.items;
  for (const item of items || []) {
    if (item.kind === "file" && IMAGE_MIMES.includes(item.type)) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  const file = event?.clipboardData?.files?.[0];
  return file && IMAGE_MIMES.includes(file.type) ? file : null;
}

// ---- What is asked ----

export const labelFor = (task, { notes = "", instruction = "" } = {}) =>
  task === "make"
    ? (notes.trim() ? "From a picture: " + notes.trim() : "From a picture").replace(/\s+/g, " ").slice(0, 300)
    : ("Change: " + instruction.trim()).replace(/\s+/g, " ").slice(0, 300);

// The `shottosite` payload a run sends (the picture as itself) and the one an
// estimate sends (the picture as its kind and length only).
export function makePayload({ task, image, notes, html, instruction, quote = false }) {
  const picture = image ? (quote ? { mime: image.mime, chars: image.chars } : { url: image.url }) : undefined;
  if (task === "make") return { task, image: picture, ...(notes?.trim() ? { notes: notes.trim() } : {}) };
  return { task, page: { html }, instruction: instruction.trim(), ...(picture ? { image: picture } : {}) };
}
// What the model is sent as text, for "What the AI sees" (the picture rides
// beside it, and isn't shown here).
export const seenText = (payload) =>
  siteText({ ...payload, notes: payload.notes || "", image: payload.image ? { url: "" } : null });

// ---- Versions ----

export const newVersion = ({ html, label, model = null, credits = null, requestId = null, saved = false, notes = [] }) => ({
  id: "v" + (globalThis.crypto?.randomUUID?.().replace(/-/g, "").slice(0, 12) || Math.random().toString(36).slice(2, 14)),
  html,
  label,
  model,
  credits,
  requestId,
  saved,
  notes,
  at: Date.now(),
});
// Adds a version, keeping the newest MAX_VERSIONS. Returns the list.
export const addVersion = (list, version) => [...list, version].slice(-MAX_VERSIONS);

// A saved page read back from its conversation (GET /api/conversations/:id):
// one version per assistant message the tool wrote, oldest first, each with
// the words that asked for it.
export function versionsFromConversation(conversation) {
  const out = [];
  let ask = "";
  for (const m of conversation?.messages || []) {
    if (m.role === "user") {
      ask = typeof m.content === "string" ? m.content : "";
      continue;
    }
    const c = m.content;
    if (m.role !== "assistant" || !c || typeof c !== "object" || c.site == null || typeof c.text !== "string") continue;
    const fence = codeFences(c.text).find((f) => /^html\b/i.test(f.info) && f.closed) || codeFences(c.text).find((f) => f.closed);
    const read = fence ? readPage(fence.body) : null;
    if (!read?.html) continue;
    out.push(
      newVersion({
        html: read.html,
        label: ask || "Saved version",
        model: m.model || null,
        credits: Number.isFinite(m.credits) && m.credits > 0 ? m.credits : null,
        saved: true,
      }),
    );
    out.at(-1).id = m.id || out.at(-1).id;
    out.at(-1).at = m.created || out.at(-1).at;
  }
  return out.slice(-MAX_VERSIONS);
}

// A version's words for the list: the fixed beginnings the tool writes
// (in English, as it saves them) read in the reader's language; what the
// person typed is left as it was.
export function labelText(label, translate = (s) => s) {
  const m = /^(From a picture|Change|Removed the outside links)(?::\s*([\s\S]*))?$/.exec(String(label ?? ""));
  if (!m) return String(label ?? "");
  const head = translate(m[1] === "Change" ? "Requested change" : m[1]);
  return m[2] ? `${head}: ${m[2]}` : head;
}

// ---- Files ----

export const pageSlug = (title) =>
  String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "page";
export const pageFileName = (title) => pageSlug(title) + ".html";

// A byte count as people read it.
export const sizeText = (chars) => (chars >= 1000 ? `${Math.round(chars / 100) / 10} KB` : `${chars} B`);
