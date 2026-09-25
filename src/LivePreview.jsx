import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Maximize2, Monitor, Tablet, Smartphone } from "lucide-react";
import { Icon, Modal } from "./ui.jsx";
import { useLanguage, loadDictionary, t } from "./i18n.js";
import {
  PREVIEW_FRAME_PATH,
  PREVIEW_MESSAGE,
  PREVIEW_SANDBOX,
  VIEWPORTS,
  CONSOLE_KEEP,
  appendConsole,
  assemblePreview,
  isShimNotice,
  latestFiles,
  noteText,
  readConsoleMessage,
  readOpenMessage,
} from "./live-preview.js";
import "./live-preview.css";

// Live Preview (the "preview" update). The page runs in an iframe sandboxed
// with allow-scripts only (PREVIEW_SANDBOX), on the app's preview frame
// document (server/routes/preview.js): an opaque origin whose network
// requests are refused, and which can't read this page, its cookies, storage
// or API. The document is built here in the browser (src/live-preview.js)
// and handed to the frame by postMessage; nothing is sent to the server and
// nothing is charged.

const VIEWPORT_ICONS = {
  fit: Maximize2,
  desktop: Monitor,
  tablet: Tablet,
  phone: Smartphone,
};
const LEVEL_LABELS = {
  log: "Log",
  info: "Info",
  debug: "Debug",
  warn: "Warning",
  error: "Error",
  blocked: "Blocked",
};
// How long a changed project waits before the preview reloads.
const REFRESH_DELAY = 600;

// Files & revisions / Preview, above Code & Build's side panel.
export function CodePanelTabs({ tab, onTab }) {
  return (
    <div className="code-panel-tabs" role="tablist" aria-label="Code panel">
      {[
        ["files", "file", "Files"],
        ["preview", "eye", "Preview"],
      ].map(([id, icon, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          className={tab === id ? "active" : ""}
          onClick={() => onTab(id)}
        >
          <Icon name={icon} size={14} />
          {label}
        </button>
      ))}
    </div>
  );
}

export function LivePreview({ files = [] }) {
  const latest = useMemo(() => latestFiles(files), [files]);
  // Same files, same document: rebuilt only when a path or its text changes.
  const signature = latest
    .map((f) => f.path + "\u0000" + f.content)
    .join("\u0001");
  const [entry, setEntry] = useState(null);
  const [viewport, setViewport] = useState("fit");
  const origin = typeof location === "undefined" ? "" : location.origin;
  const assembled = useMemo(
    () => assemblePreview({ files: latest, entry, origin }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature, entry, origin],
  );
  // What the frame shows. A new key is a fresh frame (and a fresh page).
  const [live, setLive] = useState(() => ({ html: assembled.html, key: 0 }));
  const immediate = useRef(false);
  useEffect(() => {
    if (assembled.html === live.html) return;
    const delay = immediate.current || live.html == null ? 0 : REFRESH_DELAY;
    immediate.current = false;
    const id = setTimeout(
      () => setLive((l) => ({ html: assembled.html, key: l.key + 1 })),
      delay,
    );
    return () => clearTimeout(id);
  }, [assembled.html, live.html]);
  const reload = () => setLive((l) => ({ ...l, key: l.key + 1 }));

  const [output, setOutput] = useState({ lines: [], dropped: 0 });
  const pending = useRef([]);
  const flush = useRef(null);
  const frameRef = useRef(null);
  const liveRef = useRef(live);
  const pagesRef = useRef(assembled.pages);
  const sends = useRef(0);
  liveRef.current = live;
  pagesRef.current = assembled.pages;
  // A fresh page: its console starts empty.
  useLayoutEffect(() => {
    sends.current = 0;
    pending.current = [];
    setOutput({ lines: [], dropped: 0 });
  }, [live.key]);
  // Only this component's own frame is listened to, and what it sends is
  // treated as plain text. Registered before the frame can load.
  useLayoutEffect(() => {
    const onMessage = (event) => {
      const frame = frameRef.current;
      if (!frame || !event.source || event.source !== frame.contentWindow)
        return;
      const data = event.data;
      if (
        data &&
        typeof data === "object" &&
        data.type === PREVIEW_MESSAGE.ready
      ) {
        // The frame asks once it's listening; a page that reloads itself
        // asks again, within reason.
        const html = liveRef.current.html;
        if (typeof html === "string" && sends.current++ < 20)
          frame.contentWindow.postMessage(
            { type: PREVIEW_MESSAGE.render, html },
            "*",
          );
        return;
      }
      const line = readConsoleMessage(data);
      if (line) {
        if (pending.current.length >= CONSOLE_KEEP) pending.current.shift();
        pending.current.push(line);
        flush.current ??= setTimeout(() => {
          flush.current = null;
          const lines = pending.current;
          pending.current = [];
          setOutput((s) => appendConsole(s, lines));
        }, 100);
        return;
      }
      const page = readOpenMessage(data, pagesRef.current);
      if (page) {
        immediate.current = true;
        setEntry(page);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(flush.current);
      flush.current = null;
    };
  }, []);

  // Scaled to fit: the page sees the preset's width, the pane shows it whole.
  const stageRef = useRef(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () =>
      setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const vp = VIEWPORTS.find((v) => v.id === viewport) || VIEWPORTS[0];
  const width = vp.width || stage.width || 800;
  const scale = stage.width ? Math.min(1, stage.width / width) : 1;
  const height = stage.height || vp.height || 600;

  const { pages, notes } = assembled;
  const count = output.lines.length + output.dropped;
  return (
    <section className="live-preview" aria-label="Live preview">
      <div className="live-preview-bar">
        {pages.length > 1 ? (
          <select
            aria-label="Page to preview"
            value={assembled.entry || ""}
            data-i18n="off"
            onChange={(e) => {
              immediate.current = true;
              setEntry(e.target.value);
            }}
          >
            {pages.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        ) : (
          assembled.entry && (
            <span className="live-preview-page" data-i18n="off">
              {assembled.entry}
            </span>
          )
        )}
        <div
          className="live-preview-viewports"
          role="group"
          aria-label="Viewport"
        >
          {VIEWPORTS.map((v) => {
            const Glyph = VIEWPORT_ICONS[v.id];
            return (
              <button
                key={v.id}
                type="button"
                aria-pressed={v.id === viewport}
                title={v.width ? `${v.label} · ${v.width} px` : v.label}
                onClick={() => setViewport(v.id)}
              >
                <Glyph size={14} aria-hidden="true" />
                <span>{v.label}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="small-button live-preview-reload"
          onClick={reload}
          disabled={!live.html}
        >
          <Icon name="refresh" size={13} />
          Reload
        </button>
      </div>
      <div className="live-preview-stage" ref={stageRef}>
        {live.html ? (
          <div
            className={"live-preview-device " + vp.id}
            style={{ width: Math.round(width * scale), height }}
          >
            <iframe
              key={live.key}
              ref={frameRef}
              title="Live preview"
              sandbox={PREVIEW_SANDBOX}
              src={PREVIEW_FRAME_PATH}
              style={{
                width,
                height: Math.round(height / scale),
                transform: `scale(${scale})`,
              }}
            />
          </div>
        ) : (
          <p className="live-preview-empty">
            {noteText(notes[0] || { kind: "no-html" })}
          </p>
        )}
      </div>
      <p className="live-preview-meta">
        <Icon name="shield" size={12} />
        <span>
          Sandboxed in your browser · network requests blocked · nothing charged
        </span>
        <span className="live-preview-size" data-i18n="off">
          {Math.round(width)} px
          {scale < 1 ? ` · ${Math.round(scale * 100)}%` : ""}
        </span>
      </p>
      {live.html && notes.length > 0 && (
        <details className="live-preview-notes">
          <summary>
            <Icon name="warning" size={13} />
            {notes.length === 1 ? "1 note" : `${notes.length} notes`}
          </summary>
          <ul>
            {notes.map((n, i) => (
              <li key={i}>{noteText(n)}</li>
            ))}
          </ul>
        </details>
      )}
      {live.html && (
        <details className="live-preview-console" open>
          <summary>
            Console
            <span className="live-preview-count">{count}</span>
          </summary>
          {count ? (
            <ol>
              {output.dropped > 0 && (
                <li className="level-info">
                  <span className="console-level">Info</span>
                  <span>{`${output.dropped} earlier lines not shown`}</span>
                </li>
              )}
              {output.lines.map((l, i) => (
                <li key={i} className={"level-" + l.level}>
                  <span className="console-level">{LEVEL_LABELS[l.level]}</span>
                  <span
                    className="console-text"
                    data-i18n={isShimNotice(l.text) ? undefined : "off"}
                  >
                    {l.text}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="fine-print">Nothing logged yet.</p>
          )}
          {count > 0 && (
            <button
              type="button"
              className="small-button"
              onClick={() => setOutput({ lines: [], dropped: 0 })}
            >
              Clear
            </button>
          )}
        </details>
      )}
    </section>
  );
}

// Text inside a reply is fenced off from the page translator (it's the
// model's), so the Preview button there translates itself.
function useUiText(text) {
  const language = useLanguage();
  const [, redraw] = useState(0);
  useEffect(() => {
    if (language !== "zh") return;
    let current = true;
    // After the translator itself has started on the same dictionary.
    loadDictionary().then(
      () => setTimeout(() => current && redraw((n) => n + 1), 0),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [language]);
  return language === "zh" ? t(text) : text;
}

const hastText = (node) =>
  node?.type === "text"
    ? node.value
    : (node?.children || []).map(hastText).join("");

// A reply's code block, with a Preview button when it's HTML.
function PreviewablePre({ node, onPreview, children, ...rest }) {
  const label = useUiText("Preview");
  const code = node?.children?.find(
    (c) => c.type === "element" && c.tagName === "code",
  );
  const classes = [].concat(code?.properties?.className || []).map(String);
  if (!classes.some((c) => /^language-(?:html|htm|xhtml)$/i.test(c)))
    return <pre {...rest}>{children}</pre>;
  return (
    <div className="preview-block">
      <pre {...rest}>{children}</pre>
      <button
        type="button"
        className="small-button preview-block-open"
        onClick={() => onPreview(hastText(code))}
      >
        <Icon name="eye" size={13} />
        {label}
      </button>
    </div>
  );
}

// Chat's Preview: markdown components that add the button to HTML blocks,
// and the dialog it opens (render `dialog` outside the reply).
export function useHtmlPreview(enabled) {
  const [html, setHtml] = useState(null);
  const components = useMemo(
    () =>
      enabled
        ? { pre: (props) => <PreviewablePre {...props} onPreview={setHtml} /> }
        : undefined,
    [enabled],
  );
  const dialog =
    enabled && html !== null ? (
      <Modal title="Preview" onClose={() => setHtml(null)}>
        <div className="live-preview-dialog">
          <LivePreview files={[{ path: "index.html", content: html }]} />
        </div>
      </Modal>
    ) : null;
  return { components, dialog };
}
