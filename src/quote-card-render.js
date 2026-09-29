// Quote Cards (update "quotecards"): drawing a card on a canvas, in this
// browser, with the site's own fonts. Nothing here reads or writes anything
// outside the page: the only file it loads is the Ionic mark from this site,
// and the PNG it makes goes to a download or the clipboard, never to a server.
import { MARK_URL, layoutCard, sansFont, serifFont } from "./quote-cards.js";

let markLoad = null;
// The Ionic mark, or null if it can't be loaded (the card is drawn without).
export function loadMark() {
  markLoad ||= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = MARK_URL;
  }).then((img) => {
    if (!img) markLoad = null;
    return img;
  });
  return markLoad;
}

// Waits (briefly) for the site's fonts the card uses, so what is measured is
// what is drawn. A font that doesn't arrive falls back to the next in the
// stack, and the card is still made.
export async function loadCardFonts(text = "", credit = "") {
  const fonts = typeof document !== "undefined" ? document.fonts : null;
  if (!fonts?.load) return;
  const loading = Promise.all([
    fonts.load(serifFont(48), String(text).slice(0, 400) + "“"),
    fonts.load(sansFont(28), String(credit || "Aa").slice(0, 200)),
  ]).catch(() => {});
  await Promise.race([loading, new Promise((resolve) => setTimeout(resolve, 3000))]);
}

// Text measuring for the layout: the quote's serif and the credit's sans.
export function measurers() {
  const ctx = document.createElement("canvas").getContext("2d");
  let current = "";
  const use = (font) => {
    if (font !== current) ctx.font = current = font;
  };
  return {
    measure: (s, px) => (use(serifFont(px)), ctx.measureText(s).width),
    measureCredit: (s, px) => (use(sansFont(px)), ctx.measureText(s).width),
  };
}

// The layout for a card's text on this device.
export function layoutOnDevice({ template, size, text, credit }) {
  return layoutCard({ template, size, text, credit, ...measurers() });
}

// A fluted column with the Ionic mark as its capital.
function drawColumn(ctx, layout, mark) {
  const { column: c, template: t } = layout;
  const capH = c.capital.h;
  const shaftTop = c.y + Math.round(capH * 0.78);
  const baseH = Math.round(c.w * 0.24);
  const shaftBottom = c.y + c.h - baseH * 2;
  ctx.fillStyle = t.accent;
  ctx.fillRect(c.x, shaftTop, c.w, shaftBottom - shaftTop);
  // Flutes: pale channels running the length of the shaft.
  const flutes = 5;
  const inset = Math.round((shaftBottom - shaftTop) * 0.05);
  for (let i = 0; i < flutes; i++) {
    const fx = c.x + (c.w * (i + 0.5)) / flutes;
    const fw = Math.max(3, Math.round(c.w * 0.05));
    ctx.fillStyle = "rgba(255,255,255,0.26)";
    ctx.fillRect(Math.round(fx - fw / 2), shaftTop + inset, fw, shaftBottom - shaftTop - inset * 2);
    ctx.fillStyle = "rgba(0,0,0,0.16)";
    ctx.fillRect(Math.round(fx - fw / 2) + fw, shaftTop + inset, Math.max(2, Math.round(fw / 2)), shaftBottom - shaftTop - inset * 2);
  }
  // The slab under the capital, and the two steps of the base.
  ctx.fillStyle = t.accent;
  ctx.fillRect(c.x - Math.round(c.w * 0.08), shaftTop - Math.round(c.w * 0.07), Math.round(c.w * 1.16), Math.round(c.w * 0.1));
  ctx.fillRect(c.x - Math.round(c.w * 0.1), shaftBottom, Math.round(c.w * 1.2), baseH);
  ctx.fillRect(c.x - Math.round(c.w * 0.2), shaftBottom + baseH, Math.round(c.w * 1.4), baseH);
  const cx = c.x + c.w / 2;
  if (mark) ctx.drawImage(mark, Math.round(cx - c.capital.w / 2), c.y, c.capital.w, c.capital.h);
}

// Draws `layout` (from layoutCard) onto `canvas`, at the layout's pixel size.
export function drawCard(canvas, layout, mark = null) {
  const { width: w, height: h, template: t } = layout;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, w, h);
  if (layout.band) {
    ctx.fillStyle = t.band;
    ctx.fillRect(layout.band.x, layout.band.y, layout.band.w, layout.band.h);
  }
  if (t.edge) {
    ctx.strokeStyle = t.edge;
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, w - 4, h - 4);
  }
  if (layout.column) drawColumn(ctx, layout, mark);
  ctx.textAlign = "left";
  // The opening mark, its top edge on the line the layout gives it.
  ctx.fillStyle = t.accent;
  ctx.font = serifFont(layout.glyph.size);
  ctx.textBaseline = "alphabetic";
  const open = "“";
  const ascent = ctx.measureText(open).actualBoundingBoxAscent || layout.glyph.size * 0.7;
  ctx.fillText(open, layout.glyph.x, layout.glyph.y + ascent);
  // The quote.
  ctx.fillStyle = t.ink;
  ctx.font = serifFont(layout.text.size);
  ctx.textBaseline = "middle";
  for (const line of layout.text.lines) ctx.fillText(line.text, line.x, line.y + line.h / 2);
  // The footer: a hairline, the credit, the mark.
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = t.ink;
  ctx.fillRect(layout.box.x, layout.footer.ruleY, layout.box.width, 2);
  ctx.globalAlpha = 1;
  const credit = layout.footer.credit;
  if (credit) {
    ctx.fillStyle = t.quiet;
    ctx.font = sansFont(credit.size);
    ctx.textBaseline = "middle";
    ctx.fillText(credit.text, credit.x, credit.y);
  }
  const m = layout.footer.mark;
  if (m && mark) ctx.drawImage(mark, m.x, m.y, m.w, m.h);
  return canvas;
}

// The card as a PNG (canvas output carries no metadata: no text chunks, no
// time, no address).
export function cardBlob(canvas) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(Error("The image couldn't be made."))), "image/png");
    } catch (e) {
      reject(e);
    }
  });
}

// Puts a PNG on the clipboard. The blob may still be being made: browsers
// that need the click's permission take the promise itself.
export async function copyImage(making) {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw Error("unsupported");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": Promise.resolve(making) })]);
}

// Saves a blob as a file: an <a download> on a temporary object URL.
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
