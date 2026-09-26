// Math & Diagrams: drawing a ```mermaid block. This module (and Mermaid with
// it) is its own chunk, fetched only when a reply on screen has a finished
// diagram in it (src/RichMarkdown.jsx). Everything happens in this browser.
//
// - Mermaid runs with securityLevel "strict" and no HTML labels, in the house
//   theme (DIAGRAM_CONFIG). Directives and front-matter config are stripped
//   first, so a diagram can't restyle itself or switch settings back on.
// - What it draws is sanitised with DOMPurify's SVG profile, without links,
//   <foreignObject>, images or <use>, and its CSS may only point inside the
//   SVG (cleanDiagramCss). The component mounts the result as DOM nodes.
import mermaid from "mermaid";
import DOMPurify from "dompurify";
import latin400 from "@fontsource/gfs-neohellenic/files/gfs-neohellenic-latin-400-normal.woff2?url";
import latin700 from "@fontsource/gfs-neohellenic/files/gfs-neohellenic-latin-700-normal.woff2?url";
import greek400 from "@fontsource/gfs-neohellenic/files/gfs-neohellenic-greek-400-normal.woff2?url";
import {
  DIAGRAM_CONFIG,
  MAX_DIAGRAM_SOURCE,
  cleanDiagramCss,
  diagramSource,
} from "./rich-markdown.js";

const SVG_NS = "http://www.w3.org/2000/svg";
let initialised = false;
let queue = Promise.resolve();
let count = 0;

// Mermaid measures text in the page, so it draws in a box of its own, off
// screen, rather than at the end of <body> where it would flash. The page
// translator must never touch it: the labels are the model's, and they're
// measured while they're in there.
function stage() {
  const box = document.createElement("div");
  box.setAttribute("aria-hidden", "true");
  box.setAttribute("data-i18n", "off");
  box.style.cssText =
    "position:fixed;left:-20000px;top:0;width:720px;pointer-events:none;contain:layout style";
  document.body.append(box);
  return box;
}

// One diagram at a time (Mermaid keeps global state while it draws).
export function drawDiagram(source) {
  const job = queue.then(async () => {
    const text = diagramSource(source);
    if (!text || text.length > MAX_DIAGRAM_SOURCE) throw Error("diagram_too_long");
    if (!initialised) {
      mermaid.initialize(DIAGRAM_CONFIG);
      initialised = true;
    }
    // Labels are measured in the site's font, so wait for it.
    await document.fonts?.ready;
    const box = stage();
    try {
      const { svg } = await mermaid.render("anonyma-diagram-" + ++count, text, box);
      return sanitizeDiagram(svg);
    } finally {
      box.remove();
    }
  });
  queue = job.catch(() => {});
  return job;
}

export function sanitizeDiagram(svg) {
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      "a",
      "foreignObject",
      "image",
      "use",
      "script",
      "animate",
      "animateMotion",
      "animateTransform",
      "set",
    ],
    FORBID_ATTR: ["href", "xlink:href"],
  });
  const doc = new DOMParser().parseFromString(clean, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg" || doc.querySelector("parsererror"))
    throw Error("diagram_unreadable");
  for (const style of root.querySelectorAll("style"))
    style.textContent = cleanDiagramCss(style.textContent);
  for (const el of [root, ...root.querySelectorAll("[style]")])
    if (el.hasAttribute("style"))
      el.setAttribute("style", cleanDiagramCss(el.getAttribute("style")));
  // Presentation attributes may reference markers and gradients inside the
  // SVG (url(#…)) and nothing else.
  for (const el of [root, ...root.querySelectorAll("*")])
    for (const attr of [...el.attributes])
      if (/url\(/i.test(attr.value) && !/^\s*url\(\s*['"]?#[^)]*\)\s*$/i.test(attr.value))
        el.removeAttribute(attr.name);
  return new XMLSerializer().serializeToString(root);
}

// ---- Copy SVG and Download PNG ----

// The site font, embedded so the file looks the same anywhere: the same
// faces as src/fonts.css, read back from this site.
const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const GREEK = "U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF";
const FACES = [
  [latin400, 400, LATIN],
  [latin700, 700, LATIN],
  [greek400, 400, GREEK],
];
let fontCss = null;
async function dataUrl(url) {
  const blob = await (await fetch(url, { credentials: "same-origin" })).blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
function embeddedFonts() {
  fontCss ??= Promise.all(
    FACES.map(async ([url, weight, range]) => {
      const src = (await dataUrl(url)).replace(/^data:[^;,]*/, "data:font/woff2");
      return `@font-face{font-family:"GFS Neohellenic";font-style:normal;font-weight:${weight};size-adjust:118%;src:url(${src}) format("woff2");unicode-range:${range}}`;
    }),
  ).then(
    (faces) => faces.join(""),
    () => {
      fontCss = null;
      return "";
    },
  );
  return fontCss;
}

// The drawn diagram as a file of its own: its real size, a white ground and
// the font inside it.
export async function diagramFile(svg) {
  const css = await embeddedFonts();
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  const box = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  const [x, y, w, h] =
    box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0
      ? box
      : [0, 0, 800, 600];
  root.setAttribute("xmlns", SVG_NS);
  root.setAttribute("width", String(Math.ceil(w)));
  root.setAttribute("height", String(Math.ceil(h)));
  root.removeAttribute("style");
  const ground = doc.createElementNS(SVG_NS, "rect");
  for (const [k, v] of [["x", x], ["y", y], ["width", w], ["height", h], ["fill", "#ffffff"]])
    ground.setAttribute(k, String(v));
  root.insertBefore(ground, root.firstChild);
  if (css) {
    const style = doc.createElementNS(SVG_NS, "style");
    style.textContent = css;
    root.insertBefore(style, root.firstChild);
  }
  return {
    svg: '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(root),
    width: w,
    height: h,
  };
}

// A PNG at twice the drawn size, as large as a canvas safely allows.
export async function diagramPng(svg) {
  const file = await diagramFile(svg);
  const scale = Math.max(1, Math.min(2, 8000 / Math.max(file.width, file.height)));
  const url = URL.createObjectURL(new Blob([file.svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(file.width * scale);
    canvas.height = Math.ceil(file.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(Error("png_failed"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
