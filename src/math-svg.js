// Math & Diagrams: an equation as a standalone SVG, for "Copy SVG". KaTeX
// draws math as HTML, so this reads the equation as the browser laid it out
// and redraws it in vector shapes that paste anywhere, fonts or not:
// - every character becomes a <path>, outlined from the same KaTeX font file
//   the page used (opentype.js reads it), at the position the browser put it;
// - fraction bars, rules, boxes and colour boxes (CSS borders and fills)
//   become <rect>s;
// - the SVG pieces KaTeX already uses (roots, stretchy arrows and braces)
//   are copied in, clipped as on screen.
// Loaded only when someone copies an equation (src/RichMarkdown.jsx); the
// fonts come from this site. Nothing is sent anywhere.
import { parse as parseFont } from "opentype.js";
import AMS from "katex/dist/fonts/KaTeX_AMS-Regular.woff?url";
import CaligraphicBold from "katex/dist/fonts/KaTeX_Caligraphic-Bold.woff?url";
import Caligraphic from "katex/dist/fonts/KaTeX_Caligraphic-Regular.woff?url";
import FrakturBold from "katex/dist/fonts/KaTeX_Fraktur-Bold.woff?url";
import Fraktur from "katex/dist/fonts/KaTeX_Fraktur-Regular.woff?url";
import MainBold from "katex/dist/fonts/KaTeX_Main-Bold.woff?url";
import MainBoldItalic from "katex/dist/fonts/KaTeX_Main-BoldItalic.woff?url";
import MainItalic from "katex/dist/fonts/KaTeX_Main-Italic.woff?url";
import Main from "katex/dist/fonts/KaTeX_Main-Regular.woff?url";
import MathBoldItalic from "katex/dist/fonts/KaTeX_Math-BoldItalic.woff?url";
import MathItalic from "katex/dist/fonts/KaTeX_Math-Italic.woff?url";
import SansBold from "katex/dist/fonts/KaTeX_SansSerif-Bold.woff?url";
import SansItalic from "katex/dist/fonts/KaTeX_SansSerif-Italic.woff?url";
import Sans from "katex/dist/fonts/KaTeX_SansSerif-Regular.woff?url";
import Script from "katex/dist/fonts/KaTeX_Script-Regular.woff?url";
import Size1 from "katex/dist/fonts/KaTeX_Size1-Regular.woff?url";
import Size2 from "katex/dist/fonts/KaTeX_Size2-Regular.woff?url";
import Size3 from "katex/dist/fonts/KaTeX_Size3-Regular.woff?url";
import Size4 from "katex/dist/fonts/KaTeX_Size4-Regular.woff?url";
import Typewriter from "katex/dist/fonts/KaTeX_Typewriter-Regular.woff?url";

// family → { "": regular, b: bold, i: italic, bi: bold italic }
const FILES = {
  KaTeX_AMS: { "": AMS },
  KaTeX_Caligraphic: { "": Caligraphic, b: CaligraphicBold },
  KaTeX_Fraktur: { "": Fraktur, b: FrakturBold },
  KaTeX_Main: { "": Main, b: MainBold, i: MainItalic, bi: MainBoldItalic },
  KaTeX_Math: { i: MathItalic, bi: MathBoldItalic },
  KaTeX_SansSerif: { "": Sans, b: SansBold, i: SansItalic },
  KaTeX_Script: { "": Script },
  KaTeX_Size1: { "": Size1 },
  KaTeX_Size2: { "": Size2 },
  KaTeX_Size3: { "": Size3 },
  KaTeX_Size4: { "": Size4 },
  KaTeX_Typewriter: { "": Typewriter },
};
const SVG_NS = "http://www.w3.org/2000/svg";
// The copied equation is scaled so its base text is this size (px).
const BASE_SIZE = 24;

// The KaTeX file the browser would pick for this style, or null.
export function fontFileFor(style) {
  const family = String(style.fontFamily || "")
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");
  const faces = FILES[family];
  if (!faces) return null;
  const bold = Number(style.fontWeight) >= 600 || style.fontWeight === "bold";
  const italic = /italic|oblique/.test(style.fontStyle || "");
  const want = (bold ? "b" : "") + (italic ? "i" : "");
  return faces[want] ?? faces[bold ? "b" : ""] ?? faces[italic ? "i" : ""] ?? faces[""] ?? Object.values(faces)[0];
}

const fonts = new Map();
function loadFont(url) {
  if (!fonts.has(url))
    fonts.set(
      url,
      fetch(url, { credentials: "same-origin" })
        .then((r) => {
          if (!r.ok) throw Error("font_unavailable");
          return r.arrayBuffer();
        })
        .then((buffer) => parseFont(buffer))
        .catch((e) => {
          fonts.delete(url);
          throw e;
        }),
    );
  return fonts.get(url);
}

const n = (v) => (Math.round(v * 100) / 100).toString();
const escapeXml = (s) =>
  String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
const visibleColor = (c) =>
  !!c && c !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(c.replace(/\s+/g, " "));

// The nearest ancestor (inside the equation) that clips what overflows it.
function clipFor(el, root) {
  for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.overflow === "hidden" || s.overflowX === "hidden" || s.overflowY === "hidden")
      return p.getBoundingClientRect();
  }
  return null;
}

// `host` holds one rendered equation (KaTeX's .katex or .katex-display).
export async function equationSvg(host) {
  const source = host.querySelector(".katex-display") || host.querySelector(".katex");
  if (!source?.querySelector(".katex-html")) throw Error("no_equation");
  // Measure a copy laid out off screen at the same width and font, so the
  // baseline markers added below never touch the page itself.
  const hostStyle = getComputedStyle(source.parentElement || source);
  const ghost = document.createElement("div");
  ghost.setAttribute("aria-hidden", "true");
  // The page translator must leave the copy's text alone while it's read.
  ghost.setAttribute("data-i18n", "off");
  ghost.style.cssText = `position:fixed;left:-30000px;top:0;width:${source.getBoundingClientRect().width}px;pointer-events:none`;
  ghost.style.fontSize = hostStyle.fontSize;
  ghost.style.fontFamily = hostStyle.fontFamily;
  ghost.style.lineHeight = hostStyle.lineHeight;
  ghost.style.color = getComputedStyle(source).color;
  const copy = source.cloneNode(true);
  copy.querySelectorAll(".katex-mathml").forEach((m) => m.remove());
  ghost.append(copy);
  document.body.append(ghost);
  try {
    const katexRoot = copy.classList.contains("katex") ? copy : copy.querySelector(".katex");
    const scale = BASE_SIZE / (parseFloat(getComputedStyle(katexRoot).fontSize) || BASE_SIZE);
    // A zero-size inline-block before each piece of text sits on its
    // baseline.
    const runs = [];
    const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode())
      if (t.nodeValue.replace(/[\s\u200b]/g, "")) runs.push(t);
    for (const t of runs) {
      const marker = document.createElement("span");
      marker.style.cssText = "display:inline-block;width:0;height:0;overflow:hidden;vertical-align:baseline";
      t.parentNode.insertBefore(marker, t);
      t.__marker = marker;
    }
    const shapes = [];
    const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    const grow = (x1, y1, x2, y2) => {
      box.x1 = Math.min(box.x1, x1);
      box.y1 = Math.min(box.y1, y1);
      box.x2 = Math.max(box.x2, x2);
      box.y2 = Math.max(box.y2, y2);
    };
    const rect = (x, y, w, h, fill) => {
      if (w <= 0 || h <= 0) return;
      shapes.push({ kind: "rect", x, y, w, h, fill });
      grow(x, y, x + w, y + h);
    };
    // Borders, fills and KaTeX's own SVG pieces.
    for (const el of copy.querySelectorAll("*")) {
      if (el.namespaceURI === SVG_NS && el.localName !== "svg") continue;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (el.localName === "svg" && el.namespaceURI === SVG_NS) {
        const clip = clipFor(el, copy) || r;
        const x1 = Math.max(r.left, clip.left),
          y1 = Math.max(r.top, clip.top);
        const x2 = Math.min(r.right, clip.right),
          y2 = Math.min(r.bottom, clip.bottom);
        if (x2 > x1 && y2 > y1) {
          shapes.push({ kind: "svg", el, r, clip: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, color: s.color, size: s.fontSize });
          grow(x1, y1, x2, y2);
        }
        continue;
      }
      if (visibleColor(s.backgroundColor)) rect(r.left, r.top, r.width, r.height, s.backgroundColor);
      const side = (w, style, color) => parseFloat(w) > 0 && style !== "none" && style !== "hidden" && visibleColor(color);
      if (side(s.borderTopWidth, s.borderTopStyle, s.borderTopColor))
        rect(r.left, r.top, r.width, parseFloat(s.borderTopWidth), s.borderTopColor);
      if (side(s.borderBottomWidth, s.borderBottomStyle, s.borderBottomColor))
        rect(r.left, r.bottom - parseFloat(s.borderBottomWidth), r.width, parseFloat(s.borderBottomWidth), s.borderBottomColor);
      if (side(s.borderLeftWidth, s.borderLeftStyle, s.borderLeftColor))
        rect(r.left, r.top, parseFloat(s.borderLeftWidth), r.height, s.borderLeftColor);
      if (side(s.borderRightWidth, s.borderRightStyle, s.borderRightColor))
        rect(r.right - parseFloat(s.borderRightWidth), r.top, parseFloat(s.borderRightWidth), r.height, s.borderRightColor);
    }
    // Characters, as outlines.
    const range = document.createRange();
    for (const t of runs) {
      const parent = t.parentElement;
      const s = getComputedStyle(parent);
      const size = parseFloat(s.fontSize);
      const baseline = t.__marker.getBoundingClientRect().bottom;
      const url = fontFileFor(s);
      const font = url ? await loadFont(url).catch(() => null) : null;
      const text = t.nodeValue;
      for (let i = 0; i < text.length; ) {
        const cp = text.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        range.setStart(t, i);
        range.setEnd(t, i + ch.length);
        i += ch.length;
        if (/[\s\u200b]/.test(ch)) continue;
        const r = range.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        if (font?.hasChar(ch)) {
          const path = font.charToGlyph(ch).getPath(r.left, baseline, size, {}, font);
          const bb = path.getBoundingBox();
          if (Number.isFinite(bb.x1)) grow(bb.x1, bb.y1, bb.x2, bb.y2);
          shapes.push({ kind: "path", d: path, fill: s.color });
        } else {
          // Not in a KaTeX font (e.g. Chinese inside \text{}): kept as text.
          shapes.push({ kind: "text", x: r.left, y: baseline, size, ch, fill: s.color, family: s.fontFamily });
          grow(r.left, r.top, r.right, r.bottom);
        }
      }
    }
    if (!shapes.length || !Number.isFinite(box.x1)) throw Error("no_equation");
    const pad = 2;
    const ox = box.x1 - pad,
      oy = box.y1 - pad;
    const w = box.x2 - box.x1 + pad * 2,
      h = box.y2 - box.y1 + pad * 2;
    const body = shapes.map((sh) => {
      if (sh.kind === "rect")
        return `<rect x="${n(sh.x - ox)}" y="${n(sh.y - oy)}" width="${n(sh.w)}" height="${n(sh.h)}" fill="${escapeXml(sh.fill)}"/>`;
      if (sh.kind === "path") {
        for (const c of sh.d.commands)
          for (const k of ["x", "x1", "x2"]) if (k in c) c[k] -= ox;
        for (const c of sh.d.commands)
          for (const k of ["y", "y1", "y2"]) if (k in c) c[k] -= oy;
        return `<path d="${sh.d.toPathData({ decimalPlaces: 2, flipY: false })}" fill="${escapeXml(sh.fill)}"/>`;
      }
      if (sh.kind === "text")
        return `<text x="${n(sh.x - ox)}" y="${n(sh.y - oy)}" font-size="${n(sh.size)}" font-family="${escapeXml(sh.family)}" fill="${escapeXml(sh.fill)}">${escapeXml(sh.ch)}</text>`;
      // A KaTeX SVG piece: its own viewport, clipped as on screen.
      const inner = sh.el.cloneNode(true);
      inner.setAttribute("x", n(sh.r.left - sh.clip.x));
      inner.setAttribute("y", n(sh.r.top - sh.clip.y));
      inner.setAttribute("width", n(sh.r.width));
      inner.setAttribute("height", n(sh.r.height));
      inner.removeAttribute("style");
      inner.removeAttribute("xmlns");
      inner.setAttribute("font-size", sh.size);
      inner.setAttribute("fill", sh.color);
      inner.setAttribute("stroke", sh.color);
      for (const p of inner.querySelectorAll("path")) p.setAttribute("stroke", "none");
      const xml = new XMLSerializer().serializeToString(inner).replace(/ xmlns="[^"]*"/g, "");
      return `<svg x="${n(sh.clip.x - ox)}" y="${n(sh.clip.y - oy)}" width="${n(sh.clip.w)}" height="${n(sh.clip.h)}" overflow="hidden">${xml}</svg>`;
    });
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<svg xmlns="${SVG_NS}" width="${n(w * scale)}" height="${n(h * scale)}" viewBox="0 0 ${n(w)} ${n(h)}">` +
      body.join("") +
      "</svg>"
    );
  } finally {
    ghost.remove();
  }
}
