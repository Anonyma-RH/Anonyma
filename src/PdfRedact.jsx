import React, { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Icon, Modal, Notice } from "./ui.jsx";
import { isReleased, uid } from "./lib.js";
import { getLanguage } from "./i18n.js";
import { formatBytes } from "./documents.js";
import {
  CHAT_IMAGES,
  CHAT_OCR_PAGES,
  DEFAULT_DPI,
  DETECTORS,
  DPI_CHOICES,
  MAX_BOXES,
  MAX_FILE_BYTES,
  MAX_PAGES,
  PdfRedactError,
  addBoxes,
  addManualBox,
  blankEdit,
  boxCount,
  boxCovers,
  chatImageItem,
  chatTextDocument,
  commitEdit,
  countBySource,
  createHistory,
  detectPage,
  detectorSource,
  detectorTypes,
  downloadName,
  findTerm,
  hasText,
  hitBox,
  matchRects,
  moveBox,
  pagesWithBoxes,
  parsePageRange,
  rangeText,
  redactedName,
  redo,
  removeBoxAt,
  removeSource,
  resizeBox,
  snippet,
  termOf,
  termSource,
  undo,
} from "./pdf-redact.js";
import { closePdf, copyPagesAsImages, isAbort, makeMeasureFor, openPdf, pdfBlob, readPages, redactPdf, renderPreview, freeCanvas } from "./pdf-redact-canvas.js";
import "./pdf-redact.css";

// Redact a PDF: the page. Everything happens in this browser: the file is
// opened with pdf.js, matches are found in its text layer and drawn as
// boxes over each page, and "Make redacted copy" draws every page on a
// canvas, paints the boxes solid black and writes a new PDF from those
// pictures. Nothing here talks to the server.

const HANDLE = 12; // a corner handle, in screen pixels
const CORNERS = ["nw", "ne", "sw", "se"];
const MAX_MATCH_ROWS = 300;
const one = (n, single, many) => (n === 1 ? single : many);

// Preview pages are drawn one at a time, so a long PDF never has many pages
// rendering at once.
const queue = { chain: Promise.resolve() };
const enqueue = (job) => {
  queue.chain = queue.chain.then(job, job);
  return queue.chain;
};

const sameItems = (a, b) => a.length === b.length && a.every((x, i) => x.box === b[i].box && x.index === b[i].index);
const sameRects = (a, b) => a === b || (a.length === b.length && a.every((x, i) => x === b[i]));

const PageView = memo(
  function PageView({ n, size, width, doc, items, candidates, selected, tool, busy, handlers }) {
    const wrap = useRef(null),
      canvas = useRef(null);
    const [visible, setVisible] = useState(false),
      [failed, setFailed] = useState(false);
    const height = (width * size.height) / size.width;
    useEffect(() => {
      const el = wrap.current;
      if (!el || typeof IntersectionObserver === "undefined") return setVisible(true);
      const observer = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), { rootMargin: "900px 0px" });
      observer.observe(el);
      return () => observer.disconnect();
    }, []);
    useEffect(() => {
      const el = canvas.current;
      if (!visible || !el) {
        if (el) freeCanvas(el);
        return;
      }
      let job = null,
        dead = false;
      setFailed(false);
      enqueue(async () => {
        if (dead) return;
        job = renderPreview(doc, n, el, width, window.devicePixelRatio || 1);
        try {
          await job.done;
        } catch (e) {
          if (!dead && !isAbort(e)) setFailed(true);
        }
      });
      return () => {
        dead = true;
        job?.cancel();
      };
    }, [visible, doc, n, width]);
    useEffect(() => () => canvas.current && freeCanvas(canvas.current), []);
    const k = width / size.width;
    const handle = HANDLE / k;
    const sel = selected >= 0 ? items.find((x) => x.index === selected) : null;
    return (
      <div
        ref={wrap}
        id={"pdfr-page-" + n}
        className="pdfr-page"
        style={{ width, height }}
        aria-label={`Page ${n}`}
        role="group"
      >
        <canvas ref={canvas} aria-hidden="true" style={{ width: "100%", height: "100%" }} />
        {failed && <p className="pdfr-page-failed">This page couldn't be drawn.</p>}
        <svg
          className={"pdfr-overlay tool-" + tool}
          viewBox={`0 0 ${size.width} ${size.height}`}
          preserveAspectRatio="none"
          onPointerDown={(e) => handlers.down(e, n)}
          onPointerMove={(e) => handlers.move(e, n)}
          onPointerUp={(e) => handlers.up(e, n)}
          onPointerCancel={(e) => handlers.up(e, n)}
        >
          {candidates.map((r, i) => (
            <rect key={"c" + i} className="pdfr-candidate" x={r.x} y={r.y} width={r.w} height={r.h} vectorEffect="non-scaling-stroke" />
          ))}
          {items.map(({ box, index }) => (
            <rect key={index} className={"pdfr-box" + (index === selected ? " selected" : "")} x={box.x} y={box.y} width={box.w} height={box.h} vectorEffect="non-scaling-stroke" />
          ))}
          {sel &&
            tool === "draw" &&
            !busy &&
            CORNERS.map((c) => (
              <rect
                key={c}
                className="pdfr-handle"
                x={(c.endsWith("w") ? sel.box.x : sel.box.x + sel.box.w) - handle / 2}
                y={(c.startsWith("n") ? sel.box.y : sel.box.y + sel.box.h) - handle / 2}
                width={handle}
                height={handle}
                vectorEffect="non-scaling-stroke"
              />
            ))}
        </svg>
        <span className="pdfr-page-tag">{`Page ${n}`}</span>
      </div>
    );
  },
  (a, b) =>
    a.n === b.n &&
    a.width === b.width &&
    a.doc === b.doc &&
    a.selected === b.selected &&
    a.tool === b.tool &&
    a.busy === b.busy &&
    a.handlers === b.handlers &&
    sameItems(a.items, b.items) &&
    sameRects(a.candidates, b.candidates),
);

// ---- the page ----------------------------------------------------------------

export default function PdfRedact({ demo = false, user = null, config, veilWords = [], onSendToChat = null, sendBlocked = null }) {
  const input = useRef(null),
    docRef = useRef(null),
    abortRef = useRef(null),
    stageEl = useRef(null),
    gesture = useRef(null),
    draftRef = useRef(null),
    measureRef = useRef(null),
    resultRef = useRef(null);
  const [stage, setStage] = useState("start"),
    [dragging, setDragging] = useState(false),
    [file, setFile] = useState(null),
    [doc, setDoc] = useState(null),
    [pages, setPages] = useState([]),
    [sizes, setSizes] = useState([]),
    [encrypted, setEncrypted] = useState(false),
    [progress, setProgress] = useState(0),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [ask, setAsk] = useState(null),
    [history, setHistory] = useState(createHistory),
    [draft, setDraftState] = useState(null),
    [selected, setSelected] = useState(-1),
    [tool, setTool] = useState(() => (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? "scroll" : "draw")),
    [zoom, setZoom] = useState(100),
    [stageWidth, setStageWidth] = useState(720),
    [query, setQuery] = useState(""),
    [matchCase, setMatchCase] = useState(false),
    [whole, setWhole] = useState(false),
    [rows, setRows] = useState(12),
    [dpi, setDpi] = useState(DEFAULT_DPI),
    [job, setJob] = useState(null),
    [result, setResult] = useState(null),
    [name, setName] = useState(""),
    [sendOpen, setSendOpen] = useState(false),
    [sendMode, setSendMode] = useState("images"),
    [range, setRange] = useState(""),
    // Looking at the finished copy in place of the original: its own pages,
    // opened from its own bytes.
    [review, setReview] = useState(false),
    [copyDoc, setCopyDoc] = useState(null);
  const copyRef = useRef(null);

  const edit = draft || history.present;
  const setDraft = (next) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const busy = !!job;
  const ocrLive = !!config && isReleased(config, "ocr") && isReleased(config, "documents");
  const signedIn = !!user && !demo;
  // Every edit goes through `apply`, which works from the latest history, not
  // the one this render saw, so two edits in a row (two finders tapped
  // quickly) can't lose one.
  const historyRef = useRef(history);
  historyRef.current = history;
  const apply = useCallback((fn) => {
    const h = fn(historyRef.current);
    historyRef.current = h;
    setHistory(h);
  }, []);
  const change = (next) => apply((h) => commitEdit(h, next));
  const latest = () => historyRef.current.present;
  resultRef.current = result;

  // The page's undo of everything: what's held here is dropped when the
  // person leaves the page.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      closePdf(docRef.current);
      closePdf(copyRef.current);
      docRef.current = null;
      copyRef.current = null;
    },
    [],
  );
  function dropCopyView() {
    closePdf(copyRef.current);
    copyRef.current = null;
    setCopyDoc(null);
    setReview(false);
  }

  // ---- opening a file ----
  async function open(f) {
    if (!f || busy) return;
    setError("");
    setNote("");
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") return setError("Choose a PDF file.");
    if (f.size > MAX_FILE_BYTES) return setError("This file is larger than 200 MB. Split it first.");
    reset(false);
    setFile({ name: f.name, size: f.size });
    setStage("opening");
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const data = new Uint8Array(await f.arrayBuffer());
      const head = new TextDecoder("latin1").decode(data.subarray(0, 1024));
      if (!head.includes("%PDF-")) throw new PdfRedactError("This file isn't a PDF.");
      let asked = false;
      const opened = await openPdf(data, {
        askPassword: (reason) => {
          asked = true;
          return new Promise((resolve) => setAsk({ reason, resolve }));
        },
      });
      docRef.current = opened;
      setEncrypted(asked);
      const read = await readPages(opened, { signal: controller.signal, onProgress: setProgress });
      if (controller.signal.aborted) return;
      measureRef.current = makeMeasureFor();
      setDoc(opened);
      setPages(read.pages);
      setSizes(read.sizes);
      setRange(rangeText(Array.from({ length: Math.min(opened.numPages, CHAT_IMAGES) }, (_, i) => i + 1)));
      setSendMode(ocrLive ? "text" : "images");
      setStage("ready");
    } catch (e) {
      closePdf(docRef.current);
      docRef.current = null;
      if (isAbort(e)) return;
      setStage("start");
      setFile(null);
      setError(e instanceof PdfRedactError ? e.message : "This file can't be opened as a PDF.");
    }
  }
  function reset(clearFile = true) {
    abortRef.current?.abort();
    closePdf(docRef.current);
    docRef.current = null;
    setDoc(null);
    setPages([]);
    setSizes([]);
    apply(() => createHistory());
    setDraft(null);
    setSelected(-1);
    setQuery("");
    setResult(null);
    dropCopyView();
    setSendOpen(false);
    setJob(null);
    setEncrypted(false);
    if (clearFile) {
      setFile(null);
      setStage("start");
    }
  }

  // ---- what's on the pages ----
  const deferred = useDeferredValue(query);
  const measureFor = useMemo(() => (run) => measureRef.current?.(run) || null, [doc]);
  const words = useMemo(() => (veilWords || []).map((w) => String(w || "").trim()).filter(Boolean), [veilWords]);
  const found = useMemo(() => {
    const term = deferred.trim();
    if (!term || !pages.length) return { total: 0, pageCount: 0, list: [] };
    let total = 0,
      pageCount = 0;
    const list = [];
    pages.forEach((index, i) => {
      const hits = findTerm(index, term, { matchCase, whole });
      if (!hits.length) return;
      pageCount++;
      total += hits.length;
      for (const h of hits) if (list.length < MAX_MATCH_ROWS) list.push({ page: i + 1, index, ...h });
    });
    return { total, pageCount, list };
  }, [deferred, matchCase, whole, pages]);
  const candidates = useMemo(() => {
    const byPage = new Map();
    for (const m of found.list) {
      const rects = matchRects(m.index, m.start, m.end, { measureFor });
      m.rects = rects;
      byPage.set(m.page, [...(byPage.get(m.page) || []), ...rects]);
    }
    return byPage;
  }, [found, measureFor]);
  const detected = useMemo(() => pages.map((p) => detectPage(p, words)), [pages, words]);
  const detectorList = DETECTORS.filter((d) => d.id !== "words" || words.length > 0).map((d) => {
    const types = detectorTypes(d.id);
    let count = 0;
    detected.forEach((list) => list.forEach((m) => types.includes(m.type) && count++));
    return { ...d, count, on: countBySource(history.present, detectorSource(d.id)) > 0 };
  });
  const noText = useMemo(() => pages.filter((p) => !hasText(p)).length, [pages]);
  const finds = useMemo(() => {
    const map = new Map();
    for (const b of history.present.boxes) if (termOf(b.source) !== null) map.set(b.source, (map.get(b.source) || 0) + 1);
    return [...map].map(([source, n]) => ({ source, term: termOf(source), n }));
  }, [history.present]);

  const items = useMemo(() => {
    const byPage = new Map();
    edit.boxes.forEach((box, index) => {
      const list = byPage.get(box.page) || [];
      list.push({ box, index });
      byPage.set(box.page, list);
    });
    return byPage;
  }, [edit]);
  const noItems = useRef([]).current,
    noRects = useRef([]).current;
  // What a search finds is outlined until it's boxed; a match already under
  // a box shows nothing more. (From the committed boxes, so a drag in
  // progress doesn't redraw every page.)
  const shownCandidates = useMemo(() => {
    const byPage = new Map();
    for (const [n, rects] of candidates) {
      const own = history.present.boxes.filter((b) => b.page === n);
      const left = rects.filter((r) => !own.some((b) => boxCovers(b, r)));
      if (left.length) byPage.set(n, left);
    }
    return byPage;
  }, [candidates, history.present]);

  function boxesFor(getMatches, source) {
    const out = [];
    pages.forEach((index, i) => {
      for (const m of getMatches(index, i)) for (const r of matchRects(index, m.start, m.end, { measureFor })) out.push({ page: i + 1, ...r, source });
    });
    return out;
  }
  function addFound(list) {
    const { edit: next, added, skipped } = addBoxes(latest(), list);
    if (!added) {
      setNote(skipped ? "Those places already have boxes." : "Nothing new to box.");
      return;
    }
    change(next);
    setNote(
      skipped && next.boxes.length >= MAX_BOXES
        ? `Stopped at ${MAX_BOXES.toLocaleString("en-US")} boxes.`
        : `${added.toLocaleString("en-US")} ${one(added, "box added", "boxes added")}. Check every page before you share the copy.`,
    );
  }
  function redactAll() {
    const term = query.trim();
    if (!term) return;
    addFound(boxesFor((index) => findTerm(index, term, { matchCase, whole }), termSource(term, { matchCase, whole })));
  }
  function redactOne(m) {
    const term = query.trim();
    addFound(
      (m.rects || []).map((r) => ({ page: m.page, ...r, source: termSource(term, { matchCase, whole }) })),
    );
  }
  function toggleDetector(d) {
    if (d.on) {
      change(removeSource(latest(), detectorSource(d.id)));
      setNote("");
      return;
    }
    const types = detectorTypes(d.id);
    addFound(boxesFor((_, i) => detected[i].filter((m) => types.includes(m.type)), detectorSource(d.id)));
  }
  function jump(n) {
    const el = document.getElementById("pdfr-page-" + n);
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    el?.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
  }

  // ---- drawing and editing boxes ----
  useEffect(() => {
    const el = stageEl.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setStageWidth(Math.max(200, Math.floor(el.clientWidth))));
    observer.observe(el);
    setStageWidth(Math.max(200, Math.floor(el.clientWidth)));
    return () => observer.disconnect();
  }, [stage]);
  const pageWidth = Math.round(Math.min(stageWidth - 2, 900) * (zoom / 100));

  const stateRef = useRef({});
  stateRef.current = { history, tool, busy, sizes, edit };
  const handlers = useMemo(() => {
    const point = (e, n) => {
      const r = e.currentTarget.getBoundingClientRect();
      const s = stateRef.current.sizes[n - 1] || {};
      return { x: ((e.clientX - r.left) / r.width) * s.width, y: ((e.clientY - r.top) / r.height) * s.height, k: r.width / s.width };
    };
    return {
      down(e, n) {
        const s = stateRef.current;
        if (s.busy) return;
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const p = point(e, n),
          size = s.sizes[n - 1];
        const hit = hitBox(s.history.present, n, p, HANDLE / p.k);
        if (hit) {
          setSelected(hit.index);
          if (s.tool !== "draw") return;
          e.preventDefault();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          gesture.current = {
            kind: hit.handle === "move" ? "move" : "resize",
            handle: hit.handle,
            index: hit.index,
            page: n,
            start: p,
            base: s.history.present,
            id: e.pointerId,
            size,
          };
          return;
        }
        setSelected(-1);
        if (s.tool !== "draw") return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        gesture.current = { kind: "draw", page: n, start: p, base: s.history.present, id: e.pointerId, size };
      },
      move(e, n) {
        const g = gesture.current;
        if (!g || g.id !== e.pointerId || g.page !== n) return;
        const p = point(e, n),
          { size } = g;
        if (g.kind === "draw") setDraft(addManualBox(g.base, n, g.start, p, size.width, size.height));
        else if (g.kind === "move") setDraft(moveBox(g.base, g.index, p.x - g.start.x, p.y - g.start.y, size.width, size.height));
        else setDraft(resizeBox(g.base, g.index, g.handle, p, size.width, size.height));
      },
      up(e, n) {
        const g = gesture.current;
        if (!g || g.id !== e.pointerId || g.page !== n) return;
        gesture.current = null;
        const next = draftRef.current;
        setDraft(null);
        if (e.type === "pointercancel" || !next) return;
        apply((h) => commitEdit(h, next));
        if (g.kind === "draw") setSelected(next.boxes.length - 1);
      },
    };
  }, []);

  function removeSelected() {
    if (selected < 0 || !latest().boxes[selected]) return;
    change(removeBoxAt(latest(), selected));
    setSelected(-1);
  }
  const keys = useRef({});
  keys.current = { selected, history, busy, sizes };
  useEffect(() => {
    if (stage !== "ready") return;
    const onKey = (e) => {
      const s = keys.current;
      if (s.busy || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "") || e.target?.isContentEditable) return;
      if (document.querySelector("dialog[open]")) return;
      const mod = e.metaKey || e.ctrlKey,
        k = String(e.key || "").toLowerCase();
      let handled = true;
      if (mod && k === "z") apply(e.shiftKey ? redo : undo);
      else if (mod && k === "y") apply(redo);
      else if (!mod && (e.key === "Delete" || e.key === "Backspace") && s.selected >= 0) removeSelected();
      else if (!mod && k.startsWith("arrow") && s.selected >= 0 && s.history.present.boxes[s.selected]) {
        const step = e.shiftKey ? 10 : 1;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        const box = s.history.present.boxes[s.selected];
        const size = s.sizes[box.page - 1];
        change(moveBox(latest(), s.selected, d[0], d[1], size.width, size.height));
      } else if (e.key === "Escape" && s.selected >= 0) setSelected(-1);
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- the copy ----
  async function make() {
    if (!doc || busy) return;
    setError("");
    setNote("");
    setResult(null);
    dropCopyView();
    setSendOpen(false);
    const controller = new AbortController();
    abortRef.current = controller;
    const at = history.present;
    setJob({ kind: "make", page: 0, of: doc.numPages });
    try {
      const out = await redactPdf({
        doc,
        sizes,
        boxes: at.boxes,
        dpi,
        pages: Array.from({ length: doc.numPages }, (_, i) => i + 1),
        signal: controller.signal,
        onProgress: (p) => setJob({ kind: "make", ...p }),
      });
      if (!out.check.ok) throw new PdfRedactError("The copy didn't pass its own check, so it isn't offered. Nothing was saved. Try again.");
      setName(redactedName(file?.name));
      setResult({ ...out, at, dpi, size: out.bytes.length });
    } catch (e) {
      if (!isAbort(e)) setError(e instanceof PdfRedactError ? e.message : "The redacted copy couldn't be made.");
    } finally {
      setJob(null);
    }
  }
  const stale = !!result && result.at !== history.present;
  // Boxes changed after the copy was made: back to the original.
  useEffect(() => {
    if (stale && review) setReview(false);
  }, [stale, review]);
  async function lookAtCopy() {
    if (review) return setReview(false);
    if (!result || stale || busy) return;
    try {
      if (!copyRef.current) {
        const opened = await openPdf(result.bytes.slice());
        copyRef.current = opened;
        setCopyDoc(opened);
      }
      setReview(true);
      setSelected(-1);
    } catch {
      setError("The copy couldn't be shown.");
    }
  }
  function save() {
    if (!result || stale) return;
    const url = URL.createObjectURL(pdfBlob(result.bytes));
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName(name);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const chatLimit = sendMode === "text" ? CHAT_OCR_PAGES : CHAT_IMAGES;
  async function send() {
    if (!result || stale || busy || !onSendToChat) return;
    const pageList = parsePageRange(range, doc.numPages);
    if (!pageList) return setError(`Choose pages between 1 and ${doc.numPages}, like 1-3, 5.`);
    if (pageList.length > chatLimit)
      return setError(
        sendMode === "text" ? `The text of up to ${CHAT_OCR_PAGES} pages can be read at a time.` : `A chat takes up to ${CHAT_IMAGES} pictures. Choose fewer pages.`,
      );
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;
    const base = downloadName(name).replace(/\.pdf$/i, "");
    try {
      if (sendMode === "text") {
        const { readImageText } = await import("./ocr-engine.js");
        const { defaultOcrLanguage } = await import("./ocr.js");
        const language = defaultOcrLanguage(getLanguage());
        const texts = [];
        setJob({ kind: "read", page: 0, of: pageList.length });
        await copyPagesAsImages(result.bytes, pageList, {
          fit: "read",
          signal: controller.signal,
          onProgress: (p) => setJob({ kind: "read", ...p }),
          each: async ({ page, url }) => {
            const r = await readImageText(url, language, { signal: controller.signal });
            texts.push({ page, text: r.text });
          },
        });
        const document = chatTextDocument({ name: base + ".pdf", pages: texts, id: uid() });
        if (!document.text.trim()) throw new PdfRedactError("No text could be read on those pages. Send them as pictures instead.");
        onSendToChat({ images: [], documents: [document] });
      } else {
        const images = [];
        setJob({ kind: "prepare", page: 0, of: pageList.length });
        await copyPagesAsImages(result.bytes, pageList, {
          fit: "chat",
          signal: controller.signal,
          onProgress: (p) => setJob({ kind: "prepare", ...p }),
          each: ({ page, url }) => images.push(chatImageItem(`${base}-page-${page}.jpg`, url)),
        });
        onSendToChat({ images, documents: [] });
      }
    } catch (e) {
      if (!isAbort(e)) setError(e instanceof PdfRedactError ? e.message : "The pages couldn't be sent to a chat.");
      setJob(null);
    }
  }
  function cancelJob() {
    abortRef.current?.abort();
    setJob(null);
  }

  // ---- drop zone ----
  const dropProps = {
    onDragOver: (e) => {
      if (stage !== "start") return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e) => e.currentTarget.contains(e.relatedTarget) || setDragging(false),
    onDrop: (e) => {
      if (stage !== "start") return;
      e.preventDefault();
      setDragging(false);
      open(e.dataTransfer?.files?.[0]);
    },
  };

  const count = boxCount(edit);
  const pageCount = pagesWithBoxes(edit);
  const selectedBox = selected >= 0 ? edit.boxes[selected] : null;
  const jobText = !job
    ? ""
    : job.kind === "make"
      ? `Making page ${Math.max(1, job.page)} of ${job.of}…`
      : job.kind === "read"
        ? `Reading page ${Math.max(1, job.page)} of ${job.of} on this device…`
        : `Preparing page ${Math.max(1, job.page)} of ${job.of}…`;
  const blocked = sendBlocked || (!onSendToChat ? "Send to chat isn't available here. Download the copy instead." : null);

  return (
    <section className={"pdfr-page-root" + (dragging ? " dragging" : "")} {...dropProps}>
      <div className={"pdfr-head" + (stage === "start" ? "" : " compact")}>
        <div>
          <p className="eyebrow">REDACT A PDF</p>
          <h1>Redact a PDF</h1>
          <p>
            Black out names, numbers and anything else before you share a PDF. It's done on this device, and it's real removal, not a black box drawn on top.
          </p>
        </div>
        {stage === "ready" && (
          <button type="button" className="pdfr-secondary" onClick={() => reset()} disabled={busy}>
            <Icon name="plus" size={14} />
            Choose another PDF
          </button>
        )}
      </div>
      {error && <Notice type="error">{error}</Notice>}
      <input
        ref={input}
        type="file"
        hidden
        accept=".pdf,application/pdf"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          open(f);
        }}
      />

      {stage === "start" && (
        <>
          <div className={"pdfr-drop" + (dragging ? " dragging" : "")}>
            <span className="pdfr-drop-icon" aria-hidden="true">
              <Icon name="redact" size={22} />
            </span>
            <b>Drop a PDF here</b>
            <small>{`Up to ${MAX_PAGES} pages and 200 MB. It's opened on this device; nothing is uploaded.`}</small>
            <button type="button" className="button" onClick={() => input.current?.click()}>
              <Icon name="upload" size={15} />
              Choose a PDF
            </button>
          </div>
          <div className="pdfr-how">
            <div>
              <b>Real removal</b>
              <span>Each page is redrawn as a picture with your boxes painted solid black, then written into a new PDF. Nothing from the original file is copied, so the text under a box is gone.</span>
            </div>
            <div>
              <b>What it costs you</b>
              <span>The redacted PDF is pictures of your pages, so its text can't be selected or searched.</span>
            </div>
          </div>
          <ul className="pdfr-promises">
            <li>
              <b>On this device</b>
              <span>Your PDF is opened and redacted here. Nothing is uploaded unless you choose Send to chat.</span>
            </li>
            <li>
              <b>Find it or draw it</b>
              <span>Search for words, tap a finder for emails, phone numbers and more, or draw boxes yourself.</span>
            </li>
            <li>
              <b>Check before you share</b>
              <span>Look at every page. Scans and pictures have no text to find, so draw boxes over those.</span>
            </li>
          </ul>
        </>
      )}

      {stage === "opening" && (
        <div className="pdfr-panel" role="status">
          <div className="pdfr-file">
            <span className="pdfr-drop-icon" aria-hidden="true">
              <Icon name="redact" size={20} />
            </span>
            <div className="pdfr-file-text">
              <b data-i18n="off">{file?.name}</b>
              <small>{formatBytes(file?.size || 0)}</small>
            </div>
          </div>
          <p className="pdfr-phase">{ask ? "Waiting for the password…" : "Reading your PDF on this device…"}</p>
          <div className="pdfr-bar" aria-hidden="true">
            <span className={progress ? "" : "moving"} style={progress ? { width: Math.round(progress * 100) + "%" } : undefined} />
          </div>
          <p className="pdfr-fine">This all happens on your device. Nothing is uploaded.</p>
        </div>
      )}

      {stage === "ready" && doc && (
        <div className="pdfr-work">
          <aside className="pdfr-side">
            <div className="pdfr-file">
              <span className="pdfr-drop-icon" aria-hidden="true">
                <Icon name="redact" size={18} />
              </span>
              <div className="pdfr-file-text">
                <b data-i18n="off">{file?.name}</b>
                <small>{`${doc.numPages} ${one(doc.numPages, "page", "pages")} · ${formatBytes(file?.size || 0)}`}</small>
              </div>
            </div>

            <section className="pdfr-section">
              <h2>Find text</h2>
              <label className="pdfr-field">
                <span className="sr-only">Word, name or number to find</span>
                <span className="pdfr-search">
                  <Icon name="search" size={15} />
                  <input
                    type="text"
                    value={query}
                    maxLength={200}
                    placeholder="Word, name or number"
                    autoComplete="off"
                    spellCheck={false}
                    data-i18n="off"
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setRows(12);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && found.total && !busy && redactAll()}
                  />
                </span>
              </label>
              <div className="pdfr-checks">
                <label>
                  <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
                  Match case
                </label>
                <label>
                  <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} />
                  Whole word
                </label>
              </div>
              {query.trim() && (
                <p className="pdfr-status" role="status">
                  {found.total === 0
                    ? "No matches."
                    : found.total === 1
                      ? "1 match on 1 page"
                      : `${found.total.toLocaleString("en-US")} matches on ${found.pageCount} ${one(found.pageCount, "page", "pages")}`}
                </p>
              )}
              {found.total > 0 && (
                <>
                  <button type="button" className="pdfr-primary small" onClick={redactAll} disabled={busy}>
                    <Icon name="redact" size={14} />
                    {found.total === 1 ? "Redact this match" : `Redact all ${found.total.toLocaleString("en-US")} matches`}
                  </button>
                  <ul className="pdfr-matches">
                    {found.list.slice(0, rows).map((m, i) => {
                      const s = snippet(m.index, m.start, m.end);
                      return (
                        <li key={i}>
                          <button type="button" className="pdfr-match" onClick={() => jump(m.page)} title="Show this page">
                            <small>{`Page ${m.page}`}</small>
                            <span data-i18n="off">
                              {s.before ? "…" + s.before + " " : ""}
                              <mark>{s.match}</mark>
                              {s.after ? " " + s.after + "…" : ""}
                            </span>
                          </button>
                          <button type="button" className="pdfr-link" onClick={() => redactOne(m)} disabled={busy}>
                            Redact
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {found.list.length > rows && (
                    <button type="button" className="pdfr-link" onClick={() => setRows((n) => n + 24)}>
                      Show more matches
                    </button>
                  )}
                  {found.total > found.list.length && <p className="pdfr-fine">{`Listing the first ${MAX_MATCH_ROWS}. Redact all still covers every match.`}</p>}
                </>
              )}
              {finds.length > 0 && (
                <ul className="pdfr-chips" aria-label="Words you've redacted">
                  {finds.map((f) => (
                    <li key={f.source}>
                      <span data-i18n="off">{f.term}</span>
                      <small>{`${f.n} ${one(f.n, "box", "boxes")}`}</small>
                      <button
                        type="button"
                        aria-label="Remove the boxes for this find"
                        title="Remove the boxes for this find"
                        disabled={busy}
                        onClick={() => change(removeSource(latest(), f.source))}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="pdfr-section">
              <h2>Find automatically</h2>
              <ul className="pdfr-detectors">
                {detectorList.map((d) => (
                  <li key={d.id}>
                    <span>
                      <b>{d.label}</b>
                      <small>{d.count ? `${d.count.toLocaleString("en-US")} found` : "None found"}</small>
                    </span>
                    <button
                      type="button"
                      className={"pdfr-toggle" + (d.on ? " on" : "")}
                      aria-pressed={d.on}
                      disabled={busy || (!d.count && !d.on)}
                      onClick={() => toggleDetector(d)}
                    >
                      {d.on ? "Boxed" : "Box all"}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="pdfr-fine">Finders use the same checks as Veil. They don't find names; search for a name above, or add it to Veil's always-veil words.</p>
              {noText > 0 && (
                <p className="pdfr-fine warn">
                  {noText === 1
                    ? "1 page has no text to search (a scan or a picture). Draw boxes on it yourself."
                    : `${noText} pages have no text to search (scans or pictures). Draw boxes on them yourself.`}
                </p>
              )}
            </section>

            <section className="pdfr-section">
              <h2>Boxes</h2>
              <p className="pdfr-count" role="status">
                {count
                  ? `${count.toLocaleString("en-US")} ${one(count, "box", "boxes")} on ${pageCount} ${one(pageCount, "page", "pages")}`
                  : "No boxes yet. Search, tap a finder or draw on a page."}
              </p>
              <div className="pdfr-actions">
                <button type="button" className="pdfr-secondary" onClick={() => apply(undo)} disabled={!history.past.length || busy}>
                  <Icon name="undo" size={14} />
                  Undo
                </button>
                <button type="button" className="pdfr-secondary" onClick={() => apply(redo)} disabled={!history.future.length || busy}>
                  <Icon name="redo" size={14} />
                  Redo
                </button>
                <button
                  type="button"
                  className="pdfr-secondary"
                  onClick={() => {
                    change(blankEdit());
                    setSelected(-1);
                  }}
                  disabled={!count || busy}
                >
                  Clear all boxes
                </button>
              </div>
              {note && (
                <p className="pdfr-note" role="status">
                  {note}
                </p>
              )}
            </section>
          </aside>

          <div className="pdfr-main">
            <div className="pdfr-toolbar" role="toolbar" aria-label="Page tools">
              <div className="pdfr-group" role="group" aria-label="Tool">
                <button type="button" className={tool === "draw" ? "on" : ""} aria-pressed={tool === "draw"} onClick={() => setTool("draw")} title="Drag on a page to draw a box">
                  <Icon name="redact" size={15} />
                  <span>Draw</span>
                </button>
                <button type="button" className={tool === "scroll" ? "on" : ""} aria-pressed={tool === "scroll"} onClick={() => setTool("scroll")} title="Scroll with a finger; tap a box to select it">
                  <Icon name="hand" size={15} />
                  <span>Scroll</span>
                </button>
              </div>
              <div className="pdfr-group" role="group" aria-label="Zoom">
                <button type="button" aria-label="Zoom out" title="Zoom out" disabled={zoom <= 50} onClick={() => setZoom((z) => Math.max(50, z - 25))}>
                  <Icon name="zoomout" size={15} />
                </button>
                <button type="button" className="pdfr-zoom" title="Fit to width" onClick={() => setZoom(100)}>
                  <span data-i18n="off">{zoom + "%"}</span>
                </button>
                <button type="button" aria-label="Zoom in" title="Zoom in" disabled={zoom >= 200} onClick={() => setZoom((z) => Math.min(200, z + 25))}>
                  <Icon name="zoomin" size={15} />
                </button>
              </div>
              {selectedBox && (
                <button type="button" className="pdfr-secondary" onClick={removeSelected} disabled={busy}>
                  <Icon name="delete" size={14} />
                  Delete box
                </button>
              )}
            </div>
            <p className="pdfr-hint">
              {review
                ? "This is the redacted copy as it will be shared: pictures of your pages, with the boxes solid black. Nothing is drawn over it here."
                : tool === "draw"
                ? selectedBox
                  ? "Drag the box to move it or a corner to resize it. Delete removes it."
                  : "Drag on a page to draw a box. Click a box to move, resize or delete it."
                : "Scroll the pages, and tap a box to select it. Switch to Draw to add or move boxes."}
            </p>

            {result && (
              <div className={"pdfr-result" + (stale ? " stale" : "")} role="status">
                <b>{stale ? "This copy is out of date." : "Your redacted PDF is ready."}</b>
                <p>
                  {stale
                    ? "You changed the boxes after making it. Make the copy again before you download or send it."
                    : `${result.pages} ${one(result.pages, "page", "pages")} · ${formatBytes(result.size)} · ${result.dpi} dpi`}
                </p>
                {!stale && (
                  <>
                    <p className="pdfr-check">
                      <Icon name="check" size={14} />
                      Checked in the file itself: only page pictures. No text, fonts, metadata, annotations, form fields, attachments or scripts.
                    </p>
                    <p className="pdfr-fine">The redacted PDF is pictures of your pages, so its text can't be selected or searched.</p>
                    {result.limited > 0 && (
                      <p className="pdfr-fine">
                        {result.limited === 1
                          ? "1 very large page was drawn a little smaller than the quality you chose."
                          : `${result.limited} very large pages were drawn a little smaller than the quality you chose.`}
                      </p>
                    )}
                    {encrypted && <p className="pdfr-fine">The copy isn't password-protected.</p>}
                    <label className="pdfr-name">
                      <span>File name</span>
                      <input type="text" value={name} maxLength={120} data-i18n="off" onChange={(e) => setName(e.target.value)} />
                    </label>
                    <div className="pdfr-actions">
                      <button type="button" className="pdfr-secondary" onClick={lookAtCopy} disabled={busy} aria-pressed={review}>
                        <Icon name="eye" size={14} />
                        {review ? "Back to the original" : "Look at the copy"}
                      </button>
                      <button type="button" className="pdfr-primary" onClick={save} disabled={busy}>
                        <Icon name="download" size={15} />
                        Download
                      </button>
                      <button type="button" className="pdfr-secondary" onClick={() => setSendOpen((v) => !v)} disabled={busy || !!blocked} title={blocked || undefined} aria-expanded={sendOpen}>
                        <Icon name="send" size={14} />
                        Send to chat
                      </button>
                    </div>
                    {blocked && <p className="pdfr-fine">{blocked}</p>}
                    {sendOpen && !blocked && (
                      <div className="pdfr-send">
                        <p>
                          {sendMode === "text"
                            ? "The text is read from the redacted pages on this device and attached to a new chat as a document. Nothing is sent until you press Send there."
                            : "The redacted pages are attached to a new chat as pictures. Nothing is sent until you press Send there."}
                        </p>
                        <label className="pdfr-name">
                          <span>{`Pages to send (up to ${chatLimit})`}</span>
                          <input type="text" value={range} maxLength={60} data-i18n="off" onChange={(e) => setRange(e.target.value)} />
                        </label>
                        <div className="pdfr-actions">
                          <button type="button" className="pdfr-primary" onClick={send} disabled={busy}>
                            {sendMode === "text" ? "Read and attach" : "Attach pictures"}
                          </button>
                          {ocrLive && (
                            <button
                              type="button"
                              className="pdfr-link"
                              onClick={() => {
                                const next = sendMode === "text" ? "images" : "text";
                                setSendMode(next);
                                setRange(rangeText(Array.from({ length: Math.min(doc.numPages, next === "text" ? CHAT_OCR_PAGES : CHAT_IMAGES) }, (_, i) => i + 1)));
                              }}
                            >
                              {sendMode === "text" ? "Send pictures instead" : "Send the text instead"}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            <div className="pdfr-stage" ref={stageEl}>
              <div className={"pdfr-pages tool-" + tool}>
                {sizes.map((size, i) => (
                  <PageView
                    key={i}
                    n={i + 1}
                    size={size}
                    width={pageWidth}
                    doc={review && copyDoc ? copyDoc : doc}
                    items={review ? noItems : items.get(i + 1) || noItems}
                    candidates={review ? noRects : shownCandidates.get(i + 1) || noRects}
                    selected={!review && selectedBox && selectedBox.page === i + 1 ? selected : -1}
                    tool={review ? "review" : tool}
                    busy={busy}
                    handlers={handlers}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="pdfr-dock">
            <div className="pdfr-dock-info">
              <span role="status">
                {job
                  ? jobText
                  : count
                    ? `${count.toLocaleString("en-US")} ${one(count, "box", "boxes")} on ${pageCount} ${one(pageCount, "page", "pages")}`
                    : "No boxes yet"}
              </span>
              {job && (
                <div className="pdfr-bar slim" aria-hidden="true">
                  <span style={{ width: Math.round((job.page / job.of) * 100) + "%" }} />
                </div>
              )}
            </div>
            <label className="pdfr-quality">
              <span>Copy quality</span>
              <select value={dpi} aria-label="Copy quality" onChange={(e) => setDpi(Number(e.target.value))} disabled={busy}>
                {DPI_CHOICES.map((d) => (
                  <option key={d} value={d}>
                    {d === 150 ? "150 dpi (smaller file)" : d === 300 ? "300 dpi (sharper text)" : "200 dpi"}
                  </option>
                ))}
              </select>
            </label>
            {busy ? (
              <button type="button" className="pdfr-secondary" onClick={cancelJob}>
                Cancel
              </button>
            ) : (
              <button type="button" className="pdfr-primary" onClick={make}>
                <Icon name="lock" size={15} />
                Make redacted copy
              </button>
            )}
          </div>
        </div>
      )}

      {ask && (
        <Modal
          title="This PDF is password-protected"
          onClose={() => {
            ask.resolve(null);
            setAsk(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const value = new FormData(e.currentTarget).get("pdf-password");
              ask.resolve(String(value ?? ""));
              setAsk(null);
            }}
          >
            {ask.reason === "wrong" && <Notice type="error">That password didn't work. Try again.</Notice>}
            <label>
              Password
              <input name="pdf-password" type="password" autoComplete="off" autoFocus required data-i18n="off" />
            </label>
            <p className="pdfr-fine">The password opens the file here and isn't kept. The redacted copy is not password-protected.</p>
            <button type="submit" className="button">
              Open
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
