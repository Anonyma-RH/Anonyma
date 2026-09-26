import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./ui.jsx";
import {
  DEFAULT_STYLE,
  MIN_BOX,
  addBox,
  clampCrop,
  commit,
  createHistory,
  dataUrlType,
  editorSource,
  fitView,
  hitTest,
  moveRect,
  rectFrom,
  redactedItem,
  redo,
  removeBox,
  replaceBox,
  resizeRect,
  styleBox,
  toImage,
  undo,
  zoomAt,
} from "./redact.js";
import {
  RedactError,
  bytesDataUrl,
  canFindText,
  decodeSource,
  encodeRedacted,
  findText,
  finishRedacted,
  paint,
  release,
} from "./redact-canvas.js";
import "./redact-editor.css";

// Redact Before You Send: the full-screen editor a composer image opens in.
// Draw boxes (Black or Pixelate), crop, undo and redo, zoom and pan with a
// mouse, a trackpad or two fingers. Apply hands back a redacted copy made
// in this browser; the original is never uploaded and is dropped from the
// composer once the copy replaces it.

// Handles and hit targets, in screen pixels.
const HANDLE = 12;
const CORNERS = ["nw", "ne", "sw", "se"];
const CURSORS = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", move: "move" };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export default function ImageRedact({ item, onApply, onCancel }) {
  const dialog = useRef(null),
    stage = useRef(null),
    canvas = useRef(null),
    gesture = useRef(null),
    pointers = useRef(new Map()),
    draftRef = useRef(null),
    fitted = useRef(true),
    frame = useRef(0),
    mounted = useRef(true);
  const [bitmap, setBitmap] = useState(null),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [history, setHistory] = useState(createHistory),
    [draft, setDraftState] = useState(null),
    [tool, setTool] = useState("box"),
    [style, setStyle] = useState(DEFAULT_STYLE),
    [selected, setSelected] = useState(null),
    [view, setView] = useState(null),
    [busy, setBusy] = useState(false),
    [finding, setFinding] = useState(false),
    [spaceHeld, setSpaceHeld] = useState(false);
  const edit = draft || history.present;
  const W = bitmap?.width || 0,
    H = bitmap?.height || 0;
  const setDraft = (next) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const viewRef = useRef(view);
  viewRef.current = view;

  // The dialog is modal: the app behind it is out of reach, and the browser
  // keeps focus inside. Focus goes back where it was on close.
  useEffect(() => {
    const el = dialog.current;
    const prev = document.activeElement;
    mounted.current = true;
    el.showModal();
    el.focus();
    return () => {
      mounted.current = false;
      if (el.open) el.close();
      prev?.focus?.();
    };
  }, []);

  // Decode the attachment. The bitmap is the only full copy the editor
  // holds; it's closed when the editor closes, applied or not.
  useEffect(() => {
    let alive = true,
      held = null;
    decodeSource(editorSource(item))
      .then((b) => {
        if (!alive) return b.close?.();
        held = b;
        setBitmap(b);
      })
      .catch((e) => alive && setError(e instanceof RedactError ? e.message : "This image can't be opened for redaction."));
    return () => {
      alive = false;
      held?.close?.();
    };
  }, [item]);
  // On close, the painted canvas's pixels are freed at once.
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      if (canvas.current) release(canvas.current);
    },
    [],
  );

  // Fit the image to the stage, and again when the stage changes size
  // until the user zooms or pans.
  useLayoutEffect(() => {
    if (!bitmap || !stage.current) return;
    const fit = () => {
      const r = stage.current.getBoundingClientRect();
      if (r.width && r.height) setView(fitView(bitmap.width, bitmap.height, r.width, r.height));
    };
    fit();
    const observer = new ResizeObserver(() => fitted.current && fit());
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, [bitmap]);

  // Repaint with the boxes applied, at most once a frame while dragging.
  // The canvas mounts once the view is known, so that counts as a change.
  const boxes = edit.boxes,
    shown = !!view;
  useEffect(() => {
    if (!bitmap || !shown || !canvas.current) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => canvas.current && paint(canvas.current, bitmap, boxes));
  }, [bitmap, boxes, shown]);

  // Trackpad pinch and Ctrl/⌘ + scroll zoom; plain scrolling pans.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const v = viewRef.current;
      if (!v) return;
      const r = el.getBoundingClientRect();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      fitted.current = false;
      if (e.ctrlKey || e.metaKey)
        setView(zoomAt(v, Math.exp(-e.deltaY * k * 0.01), e.clientX - r.left, e.clientY - r.top));
      else setView({ ...v, x: v.x - e.deltaX * k, y: v.y - e.deltaY * k });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const change = (next) => {
    setHistory((h) => commit(h, next));
  };
  const zoomBy = (factor) => {
    const r = stage.current?.getBoundingClientRect();
    if (!view || !r) return;
    fitted.current = false;
    setView(zoomAt(view, factor, r.width / 2, r.height / 2));
  };
  const fit = () => {
    const r = stage.current?.getBoundingClientRect();
    if (!bitmap || !r) return;
    fitted.current = true;
    setView(fitView(bitmap.width, bitmap.height, r.width, r.height));
  };
  const doUndo = () => {
    setSelected(null);
    setHistory(undo);
  };
  const doRedo = () => {
    setSelected(null);
    setHistory(redo);
  };
  const removeSelected = () => {
    if (selected == null || !history.present.boxes[selected]) return;
    change(removeBox(history.present, selected));
    setSelected(null);
  };
  // The toolbar's style is for new boxes only. A drawn box changes style
  // only from its own controls, once it's been clicked, so switching to
  // Pixelate for the next box can never soften one already drawn.
  const restyleSelected = (next) => {
    if (selected == null || !history.present.boxes[selected]) return;
    if (history.present.boxes[selected].style !== next) change(styleBox(history.present, selected, next));
  };
  const chooseTool = (next) => {
    setTool(next);
    if (next !== "box") setSelected(null);
  };

  // Keys: undo/redo, delete a box, nudge it with the arrows, hold Space to
  // pan, + / − / 0 to zoom. Escape clears a selection first; with nothing
  // drawn it closes the editor.
  const keyState = useRef({});
  keyState.current = { selected, history, tool, view, busy };
  useEffect(() => {
    const onKey = (e) => {
      const s = keyState.current;
      if (s.busy) return;
      const mod = e.metaKey || e.ctrlKey,
        k = String(e.key || "").toLowerCase();
      const onButton = e.target?.tagName === "BUTTON";
      let handled = true;
      if (mod && k === "z") (e.shiftKey ? doRedo : doUndo)();
      else if (mod && k === "y") doRedo();
      else if (!mod && (e.key === "Delete" || e.key === "Backspace") && s.selected != null) removeSelected();
      else if (!mod && k.startsWith("arrow") && s.selected != null && s.history.present.boxes[s.selected]) {
        const step = e.shiftKey ? 10 : 1;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        const box = s.history.present.boxes[s.selected];
        change(replaceBox(s.history.present, s.selected, moveRect(box, d[0], d[1], W, H)));
      } else if (!mod && k === " " && !onButton) setSpaceHeld(true);
      else if (!mod && (e.key === "+" || e.key === "=")) zoomBy(1.25);
      else if (!mod && e.key === "-") zoomBy(0.8);
      else if (!mod && e.key === "0") fit();
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onUp = (e) => {
      if (e.key === " ") setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
    };
  });
  const onDialogCancel = (e) => {
    e.preventDefault();
    if (busy) return;
    if (selected != null) setSelected(null);
    else if (tool !== "box") setTool("box");
    else if (!history.past.length && !history.future.length) onCancel();
  };

  // The browser can close a modal on a second Escape even when the first
  // was declined; that counts as Cancel.
  const onDialogClose = () => {
    if (mounted.current) onCancel();
  };

  // ---- pointers: one pointer draws, moves or pans; two pinch-zoom ----
  const stagePoint = (e) => {
    const r = stage.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  function onPointerDown(e) {
    if (!bitmap || !view || busy) return;
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    stage.current.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, stagePoint(e));
    if (pointers.current.size === 2) {
      // A second finger: whatever the first started is dropped.
      setDraft(null);
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: "pinch", dist: distance(a, b) || 1, mid: midpoint(a, b), view };
      return;
    }
    if (pointers.current.size > 2) return;
    const s = stagePoint(e),
      p = toImage(view, s.x, s.y),
      base = history.present;
    if (tool === "pan" || spaceHeld || e.button === 1) {
      gesture.current = { kind: "pan", start: s, view };
      return;
    }
    const tolerance = HANDLE / view.scale;
    if (tool === "crop") {
      const rect = base.crop || { x: 0, y: 0, w: W, h: H };
      // Before there's a crop, dragging across the image draws one; after,
      // dragging inside it moves it. Corners resize either way.
      const hit = hitTest([rect], p, tolerance);
      gesture.current =
        hit && (hit.handle !== "move" || base.crop)
          ? { kind: hit.handle === "move" ? "crop-move" : "crop-resize", handle: hit.handle, start: p, base, rect }
          : { kind: "crop-draw", start: p, base };
      return;
    }
    const hit = hitTest(base.boxes, p, tolerance);
    if (hit) {
      setSelected(hit.index);
      gesture.current = { kind: hit.handle === "move" ? "move" : "resize", handle: hit.handle, index: hit.index, start: p, base, rect: base.boxes[hit.index] };
    } else {
      setSelected(null);
      gesture.current = { kind: "draw", start: p, base };
    }
  }
  function onPointerMove(e) {
    if (!view || !bitmap) return;
    if (!pointers.current.has(e.pointerId)) {
      // Hovering: show what a press would do.
      if (e.pointerType !== "mouse" || !stage.current) return;
      const s = stagePoint(e),
        p = toImage(view, s.x, s.y);
      let cursor = tool === "pan" || spaceHeld ? "grab" : "crosshair";
      if (tool === "box") {
        const hit = hitTest(history.present.boxes, p, HANDLE / view.scale);
        if (hit) cursor = CURSORS[hit.handle];
      } else if (tool === "crop") {
        const hit = hitTest([history.present.crop || { x: 0, y: 0, w: W, h: H }], p, HANDLE / view.scale);
        if (hit) cursor = CURSORS[hit.handle];
      }
      stage.current.style.cursor = cursor;
      return;
    }
    pointers.current.set(e.pointerId, stagePoint(e));
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch") {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const mid = midpoint(a, b);
      const zoomed = zoomAt(g.view, distance(a, b) / g.dist, g.mid.x, g.mid.y);
      fitted.current = false;
      setView({ ...zoomed, x: zoomed.x + mid.x - g.mid.x, y: zoomed.y + mid.y - g.mid.y });
      return;
    }
    if (g.kind === "pan") {
      const s = stagePoint(e);
      fitted.current = false;
      setView({ ...g.view, x: g.view.x + s.x - g.start.x, y: g.view.y + s.y - g.start.y });
      return;
    }
    const s = stagePoint(e),
      p = toImage(view, s.x, s.y);
    const dx = p.x - g.start.x,
      dy = p.y - g.start.y;
    if (g.kind === "draw") setDraft(addBox(g.base, g.start, p, style, W, H));
    else if (g.kind === "move") setDraft(replaceBox(g.base, g.index, moveRect(g.rect, dx, dy, W, H)));
    else if (g.kind === "resize") setDraft(replaceBox(g.base, g.index, resizeRect(g.rect, g.handle, p, W, H)));
    else if (g.kind === "crop-draw") {
      const r = rectFrom(g.start, p);
      if (r.w >= MIN_BOX && r.h >= MIN_BOX) setDraft({ ...g.base, crop: clampCrop(r, W, H) });
    } else if (g.kind === "crop-move") setDraft({ ...g.base, crop: clampCrop(moveRect(g.rect, dx, dy, W, H), W, H) });
    else if (g.kind === "crop-resize") setDraft({ ...g.base, crop: clampCrop(resizeRect(g.rect, g.handle, p, W, H), W, H) });
  }
  function onPointerUp(e) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current,
      next = draftRef.current;
    if (pointers.current.size) {
      // Lifting one finger of a pinch ends it; the other does nothing.
      if (g?.kind === "pinch") gesture.current = { kind: "done" };
      return;
    }
    gesture.current = null;
    setDraft(null);
    if (e.type === "pointercancel" || !g || !next) return;
    if (["draw", "move", "resize", "crop-draw", "crop-move", "crop-resize"].includes(g.kind)) change(next);
  }

  async function apply() {
    if (!bitmap || busy || (!history.present.boxes.length && !history.present.crop)) return;
    setBusy(true);
    setError("");
    try {
      const out = await encodeRedacted(bitmap, history.present, dataUrlType(editorSource(item)));
      const done = await finishRedacted(out.bytes);
      onApply(redactedItem(item, bytesDataUrl(done.bytes, done.type), done));
    } catch (e) {
      setError(e instanceof RedactError ? e.message : "The redacted image couldn't be made.");
      setBusy(false);
    }
  }
  async function detectText() {
    if (!bitmap || finding) return;
    setFinding(true);
    setNote("");
    try {
      const found = await findText(bitmap);
      let next = history.present,
        added = 0;
      for (const r of found) {
        const more = addBox(next, { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, "black", W, H);
        if (more) {
          next = more;
          added++;
        }
      }
      if (added) change(next);
      setNote(
        added
          ? "Boxes added around the text this browser found. Check the whole image: it can miss text."
          : "No text found. Draw boxes yourself.",
      );
    } catch {
      setNote("Find text isn't working in this browser. Draw boxes yourself.");
    } finally {
      setFinding(false);
    }
  }

  const canApply = !!bitmap && !busy && (history.present.boxes.length > 0 || !!history.present.crop);
  const selectedBox = selected != null ? edit.boxes[selected] : null;
  const crop = edit.crop;
  const handle = view ? HANDLE / view.scale : 0;
  const showCrop = tool === "crop" ? crop || { x: 0, y: 0, w: W, h: H } : null;
  const hint =
    tool === "crop"
      ? "Drag a corner, or drag across the image, to crop. Only what's inside is sent."
      : tool === "pan"
        ? "Drag to move around. Pinch, or hold Ctrl and scroll, to zoom."
        : selectedBox
          ? "Drag the box to move it or a corner to resize it."
          : "Drag over anything you don't want to send. Use Black for text; Pixelate is for faces.";

  return createPortal(
    <dialog
      ref={dialog}
      className="redact-root"
      aria-label="Redact image"
      tabIndex={-1}
      onCancel={onDialogCancel}
      onClose={onDialogClose}
    >
      <header className="redact-bar">
        <div className="redact-title">
          <strong>Redact</strong>
          <span data-i18n="off">{item.name}</span>
        </div>
        <div className="redact-tools">
          <div className="redact-group" role="group" aria-label="Tool">
            <button type="button" className={tool === "box" ? "on" : ""} aria-pressed={tool === "box"} onClick={() => chooseTool("box")} title="Draw boxes">
              <Icon name="redact" size={16} />
              <span>Box</span>
            </button>
            <button type="button" className={tool === "crop" ? "on" : ""} aria-pressed={tool === "crop"} onClick={() => chooseTool("crop")} title="Crop">
              <Icon name="crop" size={16} />
              <span>Crop</span>
            </button>
            <button type="button" className={tool === "pan" ? "on" : ""} aria-pressed={tool === "pan"} onClick={() => chooseTool("pan")} title="Pan">
              <Icon name="hand" size={16} />
              <span>Pan</span>
            </button>
          </div>
          <div className="redact-group redact-styles" role="group" aria-label="Style for new boxes">
            <button type="button" className={style === "black" ? "on" : ""} aria-pressed={style === "black"} onClick={() => setStyle("black")}>
              <span className="redact-swatch black" aria-hidden="true" />
              <span>Black</span>
              <small>for text</small>
            </button>
            <button type="button" className={style === "pixelate" ? "on" : ""} aria-pressed={style === "pixelate"} onClick={() => setStyle("pixelate")}>
              <span className="redact-swatch pixelate" aria-hidden="true" />
              <span>Pixelate</span>
              <small>for faces</small>
            </button>
          </div>
          <div className="redact-group">
            <button type="button" className="redact-icon" aria-label="Undo" title="Undo" disabled={!history.past.length || busy} onClick={doUndo}>
              <Icon name="undo" size={16} />
            </button>
            <button type="button" className="redact-icon" aria-label="Redo" title="Redo" disabled={!history.future.length || busy} onClick={doRedo}>
              <Icon name="redo" size={16} />
            </button>
          </div>
          <div className="redact-group">
            <button type="button" className="redact-icon" aria-label="Zoom out" title="Zoom out" disabled={!view} onClick={() => zoomBy(0.8)}>
              <Icon name="zoomout" size={16} />
            </button>
            <button type="button" className="redact-zoom" title="Fit to screen" disabled={!view} onClick={fit}>
              <span data-i18n="off">{view ? Math.round(view.scale * 100) + "%" : "–"}</span>
            </button>
            <button type="button" className="redact-icon" aria-label="Zoom in" title="Zoom in" disabled={!view} onClick={() => zoomBy(1.25)}>
              <Icon name="zoomin" size={16} />
            </button>
          </div>
          {canFindText() && (
            <div className="redact-group">
              <button type="button" onClick={detectText} disabled={!bitmap || finding || busy} title="Add boxes around text this browser can find">
                <Icon name="scantext" size={16} />
                <span>Find text</span>
              </button>
            </div>
          )}
        </div>
        <div className="redact-actions">
          <button type="button" className="redact-cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="redact-apply" onClick={apply} disabled={!canApply} title={canApply ? undefined : "Draw a box or crop first"}>
            {busy ? "Applying…" : "Apply"}
          </button>
        </div>
      </header>
      <div
        ref={stage}
        className={"redact-stage tool-" + tool + (spaceHeld ? " panning" : "")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
      >
        {!bitmap && !error && <p className="redact-loading">Opening the image…</p>}
        {bitmap && view && (
          <div
            className={"redact-sheet" + (view.scale >= 2 ? " crisp" : "")}
            style={{
              width: W,
              height: H,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          >
            <canvas ref={canvas} width={W} height={H} aria-label="The image, with your boxes applied" role="img" />
            <svg className="redact-overlay" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
              {crop && (
                <path
                  className="redact-shade"
                  fillRule="evenodd"
                  d={`M0 0H${W}V${H}H0Z M${crop.x} ${crop.y}V${crop.y + crop.h}H${crop.x + crop.w}V${crop.y}Z`}
                />
              )}
              {edit.boxes.map((b, i) => (
                <g key={i} className={"redact-box" + (i === selected ? " selected" : "")}>
                  <rect x={b.x} y={b.y} width={b.w} height={b.h} className="halo" vectorEffect="non-scaling-stroke" />
                  <rect x={b.x} y={b.y} width={b.w} height={b.h} className="line" vectorEffect="non-scaling-stroke" />
                </g>
              ))}
              {tool === "box" && selectedBox &&
                CORNERS.map((c) => (
                  <rect
                    key={c}
                    className="redact-handle"
                    x={(c.endsWith("w") ? selectedBox.x : selectedBox.x + selectedBox.w) - handle / 2}
                    y={(c.startsWith("n") ? selectedBox.y : selectedBox.y + selectedBox.h) - handle / 2}
                    width={handle}
                    height={handle}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              {showCrop && (
                <>
                  <rect className="redact-crop" x={showCrop.x} y={showCrop.y} width={showCrop.w} height={showCrop.h} vectorEffect="non-scaling-stroke" />
                  {CORNERS.map((c) => (
                    <rect
                      key={c}
                      className="redact-handle crop"
                      x={(c.endsWith("w") ? showCrop.x : showCrop.x + showCrop.w) - handle / 2}
                      y={(c.startsWith("n") ? showCrop.y : showCrop.y + showCrop.h) - handle / 2}
                      width={handle}
                      height={handle}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </>
              )}
            </svg>
          </div>
        )}
      </div>
      <footer className="redact-foot">
        <div className="redact-hint">
          <span>{hint}</span>
          {tool === "box" && selectedBox && (
            <>
              <span className="redact-this" role="group" aria-label="This box">
                <button type="button" className={selectedBox.style === "black" ? "on" : ""} aria-pressed={selectedBox.style === "black"} onClick={() => restyleSelected("black")} disabled={busy}>
                  Black
                </button>
                <button type="button" className={selectedBox.style === "pixelate" ? "on" : ""} aria-pressed={selectedBox.style === "pixelate"} onClick={() => restyleSelected("pixelate")} disabled={busy}>
                  Pixelate
                </button>
              </span>
              <button type="button" className="redact-link" onClick={removeSelected} disabled={busy}>
                <Icon name="delete" size={14} />
                Delete box
              </button>
            </>
          )}
          {tool === "crop" && crop && (
            <button type="button" className="redact-link" onClick={() => change({ ...history.present, crop: null })} disabled={busy}>
              Reset crop
            </button>
          )}
        </div>
        {(error || note) && (
          <p className={"redact-note" + (error ? " error" : "")} role={error ? "alert" : "status"}>
            {error || note}
          </p>
        )}
        <p className="redact-promise">
          <Icon name="lock" size={13} />
          Only the redacted copy is sent. The original never leaves this device.
        </p>
      </footer>
    </dialog>,
    document.body,
  );
}
