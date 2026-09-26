import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import { useApp } from "./context.jsx";
import { isReleased } from "./lib.js";
import { Icon } from "./ui.jsx";
import { useLanguage, loadDictionary, t } from "./i18n.js";
import {
  DIAGRAMS_UPDATE,
  DIAGRAM_FILENAME,
  KATEX_OPTIONS,
  MAX_DIAGRAM_SOURCE,
  prepareMath,
  rehypeRichRemember,
  rehypeRichWrap,
  remarkFenceClosed,
  remarkMathTidy,
  splitMath,
} from "./rich-markdown.js";
import "./diagrams.css";

// Math & Diagrams (the "diagrams" update): replies typeset LaTeX with KaTeX
// and draw ```mermaid blocks, wherever replies are shown (the workspace,
// Symposium, shared and sealed-shared chats, the print view, Double-check,
// task tools, Routines, the history preview and bookmarks). Until the update
// is released, and for what people type themselves, it's the plain Markdown
// renderer exactly as before: code blocks and raw TeX.
//
// KaTeX and Mermaid are separate chunks, fetched only when a reply on screen
// has math or a finished diagram in it. Everything is drawn in the browser;
// nothing is sent to the server or charged. Math and diagrams are the
// model's, so they're never translated (data-i18n="off"); their buttons
// translate themselves, since they sit inside the reply.

export const diagramsReleased = (config) => isReleased(config, DIAGRAMS_UPDATE);

// ---- KaTeX, loaded once, when first needed ----
let katexKit = null;
let katexLoad = null;
const katexWatchers = new Set();
export function loadKatex() {
  katexLoad ??= import("./math-katex.js").then(
    (kit) => {
      katexKit = kit;
      katexWatchers.forEach((fn) => fn());
      return kit;
    },
    (e) => {
      katexLoad = null;
      throw e;
    },
  );
  return katexLoad;
}
const watchKatex = (fn) => {
  katexWatchers.add(fn);
  return () => katexWatchers.delete(fn);
};
function useKatex(needed) {
  const kit = useSyncExternalStore(watchKatex, () => katexKit, () => katexKit);
  useEffect(() => {
    if (needed && !katexKit) loadKatex().catch(() => {});
  }, [needed]);
  return kit;
}

// ---- Mermaid, loaded once, when a finished diagram is on screen ----
let diagramKit = null;
function loadDiagrams() {
  diagramKit ??= import("./diagram-render.js").catch((e) => {
    diagramKit = null;
    throw e;
  });
  return diagramKit;
}
// Drawn diagrams by source, so a remount (or the same diagram twice) never
// draws again: the drawing in progress, and once it's done, its result.
const drawn = new Map();
const settled = new Map();
const DRAWN_LIMIT = 60;
export function drawDiagramOnce(source) {
  if (drawn.has(source)) return drawn.get(source);
  const job = loadDiagrams()
    .then((kit) => kit.drawDiagram(source))
    .then(
      (svg) => ({ status: "ok", svg }),
      () => ({ status: "failed" }),
    )
    .then((result) => {
      if (drawn.get(source) === job) settled.set(source, result);
      return result;
    });
  drawn.set(source, job);
  if (drawn.size > DRAWN_LIMIT) {
    const oldest = drawn.keys().next().value;
    drawn.delete(oldest);
    settled.delete(oldest);
  }
  return job;
}

// The prepared text of recent replies (see prepareMath).
const prepared = new Map();
function prepare(text) {
  const hit = prepared.get(text);
  if (hit) {
    prepared.delete(text);
    prepared.set(text, hit);
    return hit;
  }
  const result = prepareMath(text);
  prepared.set(text, result);
  if (prepared.size > 300) prepared.delete(prepared.keys().next().value);
  return result;
}

// Labels inside a reply are fenced off from the page translator along with
// the reply, so they translate themselves (as Live Preview's button does).
function useUiText() {
  const language = useLanguage();
  const [, redraw] = useState(0);
  useEffect(() => {
    if (language !== "zh") return;
    let current = true;
    loadDictionary().then(
      () => setTimeout(() => current && redraw((n) => n + 1), 0),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [language]);
  return (text) => (language === "zh" ? t(text) : text);
}

// Copies an SVG that may still be being made, keeping the click's
// permission in browsers that need it: as plain text (the SVG's markup), and
// as an SVG image where the browser can put one on the clipboard.
async function copyLater(making) {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    const kinds = ["text/plain", "image/svg+xml"].filter(
      (k) => k === "text/plain" || ClipboardItem.supports?.(k),
    );
    const item = Object.fromEntries(
      kinds.map((k) => [k, making.then((s) => new Blob([s], { type: k }))]),
    );
    try {
      await navigator.clipboard.write([new ClipboardItem(item)]);
      return;
    } catch {
      // Fall through to plain text.
    }
  }
  await navigator.clipboard.writeText(await making);
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Tool({ icon, label, onClick, pressed }) {
  return (
    <button
      type="button"
      className="small-button rich-tool"
      aria-pressed={pressed}
      onClick={onClick}
    >
      <Icon name={icon} size={13} />
      <span aria-live="polite">{label}</span>
    </button>
  );
}
// A button whose label says how the action went for a moment.
function useFlash() {
  const [flash, setFlash] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (key, text) => {
    clearTimeout(timer.current);
    setFlash({ key, text });
    timer.current = setTimeout(() => setFlash(null), 2500);
  };
  return [flash, show];
}

// ---- Inline and display math ----

function InlineMath({ node, children }) {
  return (
    <span className="rich-math" data-i18n="off">
      {children}
    </span>
  );
}

function MathBlock({ node, children, "data-tex": tex = "", "data-error": error }) {
  const L = useUiText();
  const body = useRef(null);
  const [source, setSource] = useState(false);
  const [flash, show] = useFlash();
  // Until KaTeX's chunk arrives the block holds its TeX as a code block.
  const typeset = !node?.children?.some((c) => c.tagName === "pre");
  const failed = error === "true";
  const copy = () => {
    const making = import("./math-svg.js").then((m) => m.equationSvg(body.current));
    copyLater(making).then(
      () => show("copy", L("Copied")),
      () => show("copy", L("Couldn't copy this equation.")),
    );
  };
  return (
    <figure className="rich-block rich-math-block" data-i18n="off">
      <div className="rich-block-body" ref={body}>
        {children}
      </div>
      {failed && <p className="rich-block-note">{L("Couldn't typeset this equation.")}</p>}
      {source && (
        <pre className="rich-source" aria-label={L("Equation source")}>
          <code>{tex}</code>
        </pre>
      )}
      {typeset && (
        <div className="rich-tools">
          <Tool
            icon="code"
            pressed={source}
            label={L(source ? "Hide source" : "Show source")}
            onClick={() => setSource((v) => !v)}
          />
          {!failed && (
            <Tool
              icon={flash?.key === "copy" && flash.text === L("Copied") ? "check" : "copy"}
              label={flash?.key === "copy" ? flash.text : L("Copy SVG")}
              onClick={copy}
            />
          )}
        </div>
      )}
    </figure>
  );
}

// ---- Diagrams ----

function DiagramBlock({ node, children, "data-source": source = "", "data-closed": closedFlag }) {
  const L = useUiText();
  const closed = closedFlag === "true";
  const tooLong = source.length > MAX_DIAGRAM_SOURCE;
  const [state, setState] = useState(() =>
    closed && settled.has(source) ? { source, ...settled.get(source) } : null,
  );
  const [showSource, setShowSource] = useState(false);
  const [flash, show] = useFlash();
  const canvas = useRef(null);
  useEffect(() => {
    if (!closed || tooLong || !source.trim()) return;
    let current = true;
    setState((s) => (s?.source === source ? s : { source, status: "drawing" }));
    drawDiagramOnce(source).then((r) => current && setState({ source, ...r }));
    return () => {
      current = false;
    };
  }, [source, closed, tooLong]);
  const ok = state?.source === source && state.status === "ok";
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!ok || !el) return;
    const doc = new DOMParser().parseFromString(state.svg, "image/svg+xml");
    if (doc.documentElement.nodeName !== "svg") return;
    const svg = document.importNode(doc.documentElement, true);
    // A wide diagram shrinks to fit, but not below 60% of its drawn size
    // (its labels would be too small to read); past that it scrolls.
    const width = Number((svg.getAttribute("viewBox") || "").split(/[\s,]+/)[2]);
    if (width > 0) svg.style.minWidth = Math.round(width * 0.6) + "px";
    el.replaceChildren(svg);
  }, [ok, state]);
  if (!ok) {
    const status = state?.source === source ? state.status : null;
    return (
      <div className="rich-diagram-pending" data-i18n="off">
        {children}
        {status === "drawing" && <p className="rich-block-note quiet">{L("Drawing the diagram…")}</p>}
        {status === "failed" && <p className="rich-block-note">{L("Couldn't draw this diagram.")}</p>}
        {closed && tooLong && <p className="rich-block-note">{L("This diagram is too long to draw here.")}</p>}
      </div>
    );
  }
  const copy = () => {
    const making = loadDiagrams()
      .then((kit) => kit.diagramFile(state.svg))
      .then((f) => f.svg);
    copyLater(making).then(
      () => show("copy", L("Copied")),
      () => show("copy", L("Couldn't copy this diagram.")),
    );
  };
  const png = () => {
    loadDiagrams()
      .then((kit) => kit.diagramPng(state.svg))
      .then(
        (blob) => {
          saveBlob(blob, DIAGRAM_FILENAME);
          show("png", L("Downloaded"));
        },
        () => show("png", L("Couldn't make a PNG in this browser.")),
      );
  };
  return (
    <figure className="rich-block rich-diagram" data-i18n="off">
      <div className="rich-diagram-canvas" ref={canvas} role="img" aria-label={L("Diagram")} />
      {showSource && <div className="rich-source-block">{children}</div>}
      <div className="rich-tools">
        <Tool
          icon="code"
          pressed={showSource}
          label={L(showSource ? "Hide source" : "Show source")}
          onClick={() => setShowSource((v) => !v)}
        />
        <Tool
          icon={flash?.key === "copy" && flash.text === L("Copied") ? "check" : "copy"}
          label={flash?.key === "copy" ? flash.text : L("Copy SVG")}
          onClick={copy}
        />
        <Tool
          icon="download"
          label={flash?.key === "png" ? flash.text : L("Download PNG")}
          onClick={png}
        />
      </div>
    </figure>
  );
}

const RICH_PARTS = {
  "rich-math": InlineMath,
  "rich-math-block": MathBlock,
  "rich-diagram": DiagramBlock,
};

// A reply's Markdown. `rich` says this text is a reply (a model's), not what
// someone typed; `live` overrides the release check (it defaults to the
// "diagrams" update in the app's config). Anything else goes to
// react-markdown as before, including the caller's plugins (Veil's among
// them) and components.
export function ReplyMarkdown({
  children,
  rich = true,
  live,
  remarkPlugins = [],
  rehypePlugins = [],
  components,
  ...rest
}) {
  const app = useApp();
  const on = rich && (live ?? diagramsReleased(app?.config));
  const text = typeof children === "string" ? children : children == null ? "" : String(children);
  const ready = useMemo(() => (on ? prepare(text) : null), [on, text]);
  const kit = useKatex(!!ready?.math);
  if (!on)
    return (
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        {...rest}
      >
        {children}
      </ReactMarkdown>
    );
  return (
    <ReactMarkdown
      remarkPlugins={[...remarkPlugins, remarkMath, remarkMathTidy, remarkFenceClosed]}
      rehypePlugins={[
        ...rehypePlugins,
        [rehypeRichWrap, { katex: !!kit }],
        ...(kit ? [[kit.rehypeKatex, KATEX_OPTIONS]] : []),
        rehypeRichRemember,
      ]}
      components={{ ...components, ...RICH_PARTS }}
      {...rest}
    >
      {ready.text}
    </ReactMarkdown>
  );
}

// ---- A line of plain text with math in it (a bookmark's excerpt) ----

function InlineTex({ tex, kit }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !kit) return;
    try {
      kit.katex.render(tex, el, { ...KATEX_OPTIONS, displayMode: false, throwOnError: true });
    } catch {
      el.textContent = tex;
    }
  }, [tex, kit]);
  return (
    <span ref={ref} className="rich-math" data-i18n="off">
      {kit ? null : tex}
    </span>
  );
}
// An excerpt cut off inside display math ends at the math instead of
// showing half its TeX.
function trimCutMath(parts) {
  const last = parts.at(-1);
  if (last?.type !== "text" || !last.value.endsWith("…")) return parts;
  const at = Math.max(last.value.lastIndexOf("$$"), last.value.lastIndexOf("\\["));
  if (at < 0) return parts;
  return [...parts.slice(0, -1), { type: "text", value: last.value.slice(0, at).trimEnd() + " …" }];
}
export function MathText({ text, live }) {
  const parts = useMemo(() => (live ? trimCutMath(splitMath(text)) : null), [live, text]);
  const hasMath = !!parts?.some((p) => p.type === "math");
  const kit = useKatex(hasMath);
  if (!parts) return text;
  if (!hasMath) return parts.map((p) => p.value).join("");
  return parts.map((p, i) =>
    p.type === "math" ? <InlineTex key={i} tex={p.value} kit={kit} /> : p.value,
  );
}
