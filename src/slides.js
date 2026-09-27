// Slides, the browser's side: pure helpers only (sources and payloads, Veil
// on a deck's text, editing, one slide's structure for both renderers, and
// the self-contained HTML export). No DOM, React or IndexedDB here, so tests
// run them in node; the page is src/Slides.jsx, storage src/slides-store.js.
import {
  LAYOUTS,
  LIMITS,
  MAX_PROMPT_CHARS,
  MAX_SAVED_SLIDES,
  MAX_SLIDES,
  MAX_SOURCE_BLOCK,
  MAX_SOURCE_CHARS,
  MIN_SLIDES,
  MIN_SOURCE_CHARS,
  THEMES,
  compactSlide,
  layoutFields,
  newSlideId,
  sourceBlock,
} from "./slides-spec.js";

// Whether the app offers it: released (the server gates the same way).
export const slidesLive = (config) => config?.releases?.features?.slides === true;

// ---- Sources ----

export function cleanSource(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}
export function cleanName(name, fallback = "Document") {
  const v = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITS.name)
    .trim();
  return v || fallback;
}
// The source as sent: at most MAX_SOURCE_CHARS characters (a prompt,
// MAX_PROMPT_CHARS), short enough that its escaped block fits the message
// cap. `total` is the full length.
export function fitSource(kind, name, text) {
  const all = cleanSource(text);
  if (kind === "prompt") {
    const kept = all.slice(0, MAX_PROMPT_CHARS).trim();
    return { text: kept, cut: kept.length < all.length, total: all.length };
  }
  let kept = all.slice(0, MAX_SOURCE_CHARS);
  const markup = sourceBlock(name, "").length;
  for (let i = 0; i < 12; i++) {
    const length = sourceBlock(name, kept).length;
    if (length <= MAX_SOURCE_BLOCK) break;
    const ratio = (length - markup) / Math.max(1, kept.length);
    const target = Math.floor((MAX_SOURCE_BLOCK - markup) / ratio) - 16 * (i + 1);
    kept = kept.slice(0, Math.max(0, Math.min(kept.length - 1, target)));
  }
  kept = kept.trim();
  return { text: kept, cut: kept.length < all.length, total: all.length };
}
export const tooShort = (kind, text) => cleanSource(text).length < (MIN_SOURCE_CHARS[kind] ?? 40);

// "10 slides on …" in a prompt: the number, when it's one the page offers.
export function countFromPrompt(text) {
  const m = /\b(\d{1,2})\s*(?:-|\s)?(?:slides?|pages?)\b|(\d{1,2})\s*(?:张|页)(?:幻灯片|的?演示)?/i.exec(String(text ?? ""));
  const n = Number(m?.[1] || m?.[2]);
  return Number.isInteger(n) && n >= MIN_SLIDES && n <= MAX_SLIDES ? n : null;
}

// The `slides` payload for making a deck. `mask` is Veil's (or the
// identity): it runs on the name and text before they're cut to size, so
// what's counted is what's sent.
export function deckPayload(source, count, mask = (s) => s) {
  const kind = source?.kind;
  const name = kind === "prompt" ? "Prompt" : cleanName(mask(cleanName(source?.name)));
  const fitted = fitSource(kind, name, mask(cleanSource(source?.text)));
  return {
    payload: { task: "deck", count, source: { kind, name, text: fitted.text } },
    cut: fitted.cut,
    total: fitted.total,
  };
}
// The `slides` payload for regenerating slide `index` of a deck, from its
// stored (wire) text: the deck's title and slide titles, and the slide.
export function slidePayload(deck, index, instruction = "") {
  return {
    task: "slide",
    deck: {
      title: deck.title,
      outline: deck.slides.map((s) => outlineTitle(s)),
    },
    index,
    slide: compactSlide(deck.slides[index]),
    instruction: String(instruction || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, LIMITS.instruction),
  };
}
// A slide's name in the outline: its title, or what it shows.
export function outlineTitle(s) {
  const t = s.title || s.quote || s.number || s.bullets?.[0] || s.left?.heading || "";
  return t.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, LIMITS.outline).trim();
}

// ---- Veil: every text of a deck, masked or restored ----

// `fn` runs on each text field of a slide; the shape is kept.
export function mapSlideText(s, fn) {
  const out = { ...s };
  for (const f of ["title", "subtitle", "quote", "attribution", "number", "label", "notes"])
    if (typeof out[f] === "string" && out[f]) out[f] = fn(out[f]);
  if (Array.isArray(out.bullets)) out.bullets = out.bullets.map((b) => (b ? fn(b) : b));
  for (const c of ["left", "right"])
    if (out[c]) out[c] = { heading: out[c].heading ? fn(out[c].heading) : "", bullets: out[c].bullets.map((b) => (b ? fn(b) : b)) };
  return out;
}
export const mapDeckText = (deck, fn) => ({
  ...deck,
  title: deck.title ? fn(deck.title) : deck.title,
  slides: deck.slides.map((s) => mapSlideText(s, fn)),
});
// A Veil placeholder such as [EMAIL_1] (src/veil.js).
const VEIL_TAG = /\[(?:EMAIL|KEY|WALLET|IBAN|CARD|PHONE|IP|PRIVATE)_\d+\]/;
export const hasVeilTags = (text) => VEIL_TAG.test(String(text || ""));

// ---- Editing ----

export const blankSlide = (layout = "bullets") =>
  compactSlide({ id: newSlideId(), layout, title: "", bullets: [""], notes: "" });

// A slide in another layout, carrying over what it can.
export function convertSlide(s, layout) {
  if (!LAYOUTS.includes(layout) || s.layout === layout) return s;
  const bullets = [
    ...(s.bullets || []),
    ...(s.left?.bullets || []),
    ...(s.right?.bullets || []),
  ].filter(Boolean);
  const words = [s.title, s.subtitle, s.quote, s.number && `${s.number} ${s.label || ""}`.trim(), ...bullets].filter(Boolean);
  const next = { id: s.id, layout, notes: s.notes || "", title: s.title || "" };
  if (layout === "title" || layout === "section") next.subtitle = s.subtitle || s.label || bullets[0] || "";
  if (layout === "bullets") next.bullets = bullets.length ? bullets.slice(0, LIMITS.bullets) : [s.subtitle || s.quote || s.label || ""];
  if (layout === "two-column") {
    const half = Math.ceil(bullets.length / 2);
    next.left = { heading: s.left?.heading || "", bullets: bullets.slice(0, half).slice(0, LIMITS.bullets) };
    next.right = { heading: s.right?.heading || "", bullets: bullets.slice(half).slice(0, LIMITS.bullets) };
    if (!next.left.bullets.length) next.left.bullets = [""];
    if (!next.right.bullets.length) next.right.bullets = [""];
  }
  if (layout === "quote") {
    next.quote = (s.quote || bullets[0] || s.label || s.subtitle || s.title || "").slice(0, LIMITS.quote);
    next.attribution = s.attribution || "";
  }
  if (layout === "big-number") {
    const figure = /((?:[$€£¥])?\d[\d,.]*\s?(?:%|×|x|k|m|bn)?)/i.exec(words.join(" "));
    next.number = s.number || figure?.[1]?.trim() || "";
    next.label = s.label || s.subtitle || bullets[0] || "";
  }
  return compactSlide(next);
}
// Clean text as typed into a slide: one line for most fields.
export function typed(text, field) {
  const max = LIMITS[field] ?? LIMITS.bullet;
  const s = String(text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return field === "notes"
    ? s.replace(/\r\n?/g, "\n").slice(0, max)
    : s.replace(/\s+/g, " ").trim().slice(0, max);
}
// Set one field by its path ("title", "bullets.2", "left.heading",
// "right.bullets.0").
export function setField(s, path, value) {
  const parts = path.split(".");
  const field = parts.at(-1).match(/^\d+$/) ? parts.at(-2) : parts.at(-1);
  const v = typed(value, field === "bullets" ? "bullet" : field);
  const next = structuredClone(s);
  let at = next;
  for (let i = 0; i < parts.length - 1; i++) at = at[parts[i]];
  at[parts.at(-1)] = v;
  return next;
}
export function addBullet(s, listPath, after = null) {
  const next = structuredClone(s);
  const list = listPath.split(".").reduce((o, k) => o[k], next);
  if (list.length >= LIMITS.bullets) return s;
  list.splice(after == null ? list.length : after + 1, 0, "");
  return next;
}
export function removeBullet(s, listPath, index) {
  const next = structuredClone(s);
  const list = listPath.split(".").reduce((o, k) => o[k], next);
  list.splice(index, 1);
  return next;
}
export function moveSlide(slides, from, to) {
  if (to < 0 || to >= slides.length || from === to) return slides;
  const next = [...slides];
  const [s] = next.splice(from, 1);
  next.splice(to, 0, s);
  return next;
}
export const canAddSlide = (slides) => slides.length < MAX_SAVED_SLIDES;
// Empty bullets (left by editing) out, before a deck is saved or exported.
export function tidySlide(s) {
  const out = compactSlide(s);
  if (out.bullets) out.bullets = out.bullets.map((b) => b.trim()).filter(Boolean);
  for (const c of ["left", "right"]) if (out[c]) out[c].bullets = out[c].bullets.map((b) => b.trim()).filter(Boolean);
  return out;
}
export const tidyDeck = (deck) => ({ ...deck, slides: deck.slides.map(tidySlide) });

// A deck as the server takes it (POST/PATCH /api/slides).
export const deckRecord = (deck) => ({
  title: typed(deck.title, "deckTitle") || "Untitled deck",
  theme: THEMES.includes(deck.theme) ? deck.theme : "cobalt",
  slides: tidyDeck(deck).slides,
});

// ---- One slide's structure, for the page (Slides.jsx) and the export ----
// A tree of { tag, cls, field?, text?, placeholder?, children? }. A node
// with `field` shows that field's text (the page makes it editable); `text`
// is fixed text. Empty optional fields are left out unless `editing`.
export const THEME_NAMES = { cobalt: "Cobalt", white: "White", dark: "Dark" };
export const LAYOUT_NAMES = {
  title: "Title",
  section: "Section",
  bullets: "Bullets",
  "two-column": "Two columns",
  quote: "Quote",
  "big-number": "Big number",
};
export const PLACEHOLDERS = {
  title: "Add a title",
  subtitle: "Add a subtitle",
  bullet: "Add a point",
  heading: "Add a heading",
  quote: "Add a quote",
  attribution: "Who said it",
  number: "42%",
  label: "What the number means",
};
function textNode(tag, cls, s, field, editing, placeholder) {
  const path = field;
  const value = path.split(".").reduce((o, k) => (o == null ? o : o[k]), s);
  if (!value && !editing) return null;
  return { tag, cls, field: path, placeholder };
}
function bulletList(s, path, editing) {
  const list = path.split(".").reduce((o, k) => o?.[k], s) || [];
  const items = list
    .map((b, i) => (b || editing ? { tag: "li", cls: "s-bullet", field: `${path}.${i}`, placeholder: PLACEHOLDERS.bullet } : null))
    .filter(Boolean);
  if (!items.length && !editing) return null;
  return { tag: "ul", cls: "s-bullets", list: path, children: items };
}
export function slideTree(s, { index = 0, total = 1, deckTitle = "", editing = false } = {}) {
  const t = (tag, cls, field, ph) => textNode(tag, cls, s, field, editing, ph);
  const chars = [...(s.bullets || []), ...(s.left?.bullets || []), ...(s.right?.bullets || [])].join(" ").length;
  const dense = chars > 330 || (s.bullets || []).length > 5 ? " dense" : "";
  let body = [];
  switch (s.layout) {
    case "title":
      body = [
        { tag: "div", cls: "s-body", children: [t("h1", "s-title", "title", PLACEHOLDERS.title), t("p", "s-subtitle", "subtitle", PLACEHOLDERS.subtitle)] },
        { tag: "div", cls: "s-steps", decor: true, children: [1, 2, 3, 4, 5].map(() => ({ tag: "i", cls: "" })) },
      ];
      break;
    case "section":
      body = [
        {
          tag: "div",
          cls: "s-body",
          children: [
            { tag: "span", cls: "s-kicker", text: String(index + 1).padStart(2, "0") },
            t("h2", "s-title", "title", PLACEHOLDERS.title),
            t("p", "s-subtitle", "subtitle", PLACEHOLDERS.subtitle),
          ],
        },
      ];
      break;
    case "bullets":
      body = [t("h2", "s-title", "title", PLACEHOLDERS.title), bulletList(s, "bullets", editing)];
      break;
    case "two-column":
      body = [
        t("h2", "s-title", "title", PLACEHOLDERS.title),
        {
          tag: "div",
          cls: "s-cols",
          children: ["left", "right"].map((side) => ({
            tag: "div",
            cls: "s-col",
            children: [t("h3", "s-heading", `${side}.heading`, PLACEHOLDERS.heading), bulletList(s, `${side}.bullets`, editing)],
          })),
        },
      ];
      break;
    case "quote":
      body = [
        { tag: "span", cls: "s-quote-mark", text: "“", decor: true },
        t("blockquote", "s-quote", "quote", PLACEHOLDERS.quote),
        t("p", "s-attribution", "attribution", PLACEHOLDERS.attribution),
      ];
      break;
    case "big-number":
      body = [
        t("h2", "s-title", "title", PLACEHOLDERS.title),
        { tag: "div", cls: "s-figure", children: [t("div", "s-number", "number", PLACEHOLDERS.number), t("p", "s-label", "label", PLACEHOLDERS.label)] },
      ];
      break;
  }
  const foot =
    s.layout === "title"
      ? null
      : {
          tag: "div",
          cls: "s-foot",
          children: [
            { tag: "span", cls: "s-foot-title", deck: true },
            { tag: "span", cls: "s-foot-num", text: `${index + 1} / ${total}` },
          ],
        };
  return {
    tag: "section",
    cls: `slide l-${s.layout}${dense}`,
    children: [...body, foot].filter(Boolean),
    deckTitle,
  };
}

// ---- The self-contained HTML export ----

export const escapeHTML = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
function nodeHTML(n, s, deckTitle) {
  if (!n) return "";
  const cls = n.cls ? ` class="${escapeHTML(n.cls)}"` : "";
  const aria = n.decor ? ' aria-hidden="true"' : "";
  let inner = "";
  if (n.field) inner = escapeHTML(n.field.split(".").reduce((o, k) => (o == null ? "" : o[k]), s) ?? "");
  else if (n.deck) inner = escapeHTML(deckTitle);
  else if (n.text != null) inner = escapeHTML(n.text);
  else inner = (n.children || []).map((c) => nodeHTML(c, s, deckTitle)).join("");
  return `<${n.tag}${cls}${aria}>${inner}</${n.tag}>`;
}
export function slideHTML(s, opts) {
  const tree = slideTree(s, opts);
  return nodeHTML(tree, s, opts?.deckTitle || "");
}
export const slug = (s) =>
  String(s || "deck")
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "deck";

// The export page's own rules: the slides stacked on screen, one at a time
// full screen after "Present" (or P), and one 16:9 page each when printed.
const EXPORT_CSS = `
*{box-sizing:border-box}
html,body{margin:0;background:#edf1f7;color:#18233f;font-family:var(--font)}
.x-bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;padding:10px 20px;background:#fff;border-bottom:1px solid #e2e6ee;font-size:14px}
.x-bar b{font-family:var(--serif);font-weight:400;font-size:18px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.x-bar button{font:inherit;font-size:13px;padding:7px 12px;border:1px solid #0135df;border-radius:2px;background:#0135df;color:#fff;cursor:pointer}
.x-bar span{color:#606a80;font-size:12px}
.x-deck{display:grid;gap:24px;max-width:1100px;margin:24px auto 60px;padding:0 20px}
.x-notes{margin:-12px 0 0;padding:10px 14px;background:#fff;border:1px solid #e2e6ee;font-size:13px;line-height:1.5;color:#606a80;white-space:pre-wrap}
.x-notes::before{content:attr(data-label) " · ";font-weight:700;color:#18233f}
body.x-present{background:#000;overflow:hidden}
body.x-present .x-bar,body.x-present .x-notes{display:none}
body.x-present .x-deck{margin:0;padding:0;max-width:none;height:100vh;display:block}
body.x-present .slide-frame{display:none;position:fixed;inset:0;margin:auto;width:min(100vw,calc(100vh*16/9))}
body.x-present .slide-frame.x-on{display:block}
@media print{
  @page{size:1280px 720px;margin:0}
  html,body{background:#fff}
  .x-bar,.x-notes{display:none}
  .x-deck{display:block;margin:0;padding:0;max-width:none}
  .slide-frame{width:1280px;height:720px;break-after:page;break-inside:avoid}
  .slide-frame:last-of-type{break-after:auto}
}`;
// A tiny script for the exported file: arrows, space and P to present, Esc
// to stop. Fixed code; the deck's text is only ever in escaped HTML above.
const EXPORT_JS = `(()=>{const f=[...document.querySelectorAll('.slide-frame')];let i=0,on=false;const show=()=>f.forEach((e,k)=>e.classList.toggle('x-on',k===i));const go=(n)=>{i=Math.max(0,Math.min(f.length-1,n));if(on)show();else f[i].scrollIntoView({block:'center'})};const present=()=>{on=true;document.body.classList.add('x-present');show();document.documentElement.requestFullscreen?.().catch(()=>{})};const stop=()=>{on=false;document.body.classList.remove('x-present');if(document.fullscreenElement)document.exitFullscreen();};document.getElementById('x-present').onclick=present;document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&on)stop()});document.addEventListener('keydown',(e)=>{if(e.key==='p'||e.key==='P')present();else if(e.key==='Escape')stop();else if(['ArrowRight','ArrowDown','PageDown',' '].includes(e.key)){e.preventDefault();go(i+1)}else if(['ArrowLeft','ArrowUp','PageUp'].includes(e.key)){e.preventDefault();go(i-1)}});document.addEventListener('click',(e)=>{if(on&&!e.target.closest('button'))go(i+1)})})();`;

// The whole deck as one HTML file: its fonts (as data: URLs in `fontCSS`),
// the slide styles (`slideCSS`, the same rules the page uses), the slides
// and, when `notes`, each slide's speaker notes under it. No remote
// requests: nothing in it loads anything from anywhere.
export function deckHTML(deck, { slideCSS = "", fontCSS = "", notes = true, lang = "en", labels = {} } = {}) {
  const theme = THEMES.includes(deck.theme) ? deck.theme : "cobalt";
  const total = deck.slides.length;
  const words = {
    count: `${total} ${total === 1 ? "slide" : "slides"}`,
    help: "arrows to move, P to present, Esc to stop",
    present: "Present",
    notes: "Notes",
    ...labels,
  };
  const slides = deck.slides
    .map((s, index) => {
      const frame = `<div class="slide-frame theme-${theme}">${slideHTML(s, { index, total, deckTitle: deck.title })}</div>`;
      return notes && s.notes
        ? frame + `<p class="x-notes" data-label="${escapeHTML(words.notes)}">${escapeHTML(s.notes)}</p>`
        : frame;
    })
    .join("\n");
  return [
    "<!doctype html>",
    `<html lang="${lang === "zh" ? "zh-CN" : "en"}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; img-src data:">`,
    `<title>${escapeHTML(deck.title)}</title>`,
    `<style>${fontCSS}\n${slideCSS}\n${EXPORT_CSS}</style>`,
    "</head>",
    "<body>",
    `<header class="x-bar"><b>${escapeHTML(deck.title)}</b><span>${escapeHTML(words.count)} · ${escapeHTML(words.help)}</span><button type="button" id="x-present">${escapeHTML(words.present)}</button></header>`,
    `<main class="x-deck">\n${slides}\n</main>`,
    `<script>${EXPORT_JS}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

// A starting deck from the model's reading, restored from Veil's map for
// display is done by the page; this only fills the gaps.
export function newDeckFrom(read, { theme = "cobalt", fallbackTitle = "Untitled deck" } = {}) {
  const slides = read.slides.map((s) => compactSlide({ ...s, id: s.id || newSlideId() }));
  return {
    title: typed(read.title, "deckTitle") || fallbackTitle,
    theme: THEMES.includes(theme) ? theme : "cobalt",
    slides,
  };
}
// How the list names a deck's size.
export const layoutsOf = (deck) => [...new Set(deck.slides.map((s) => s.layout))];
export { layoutFields };
