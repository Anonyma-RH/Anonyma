import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Icon, Modal, Notice } from "./ui.jsx";
import { uid } from "./lib.js";
import { getLanguage } from "./i18n.js";
import { veil } from "./veil.js";
import { cloneVeilState, formatCredits } from "./estimate.js";
import { MAX_DOCUMENTS } from "./documents.js";
import {
  OCR_LANGUAGES,
  confidenceNote,
  defaultOcrLanguage,
  firstRunBytes,
  megabytes,
  ocrDocument,
  ocrSavings,
} from "./ocr.js";

// Local OCR's panel (lazy-loaded from LocalOcr.jsx): reads the image's text
// in this browser as soon as it opens, then lets the person check and edit
// it before "Use text" swaps the image for it. Nothing here sends anything;
// the estimate and Veil's count are worked out locally.
//
// `item` is the composer image. What's read is what Send would use: the
// redacted copy once Redact has been applied (or, for an image Clean
// Uploads holds back, its original: only the text leaves, never the file).
export default function OcrPanel({
  item,
  model = null,
  markup = 0,
  veilWith = null,
  documentsFull = false,
  onRedact = null,
  onUse,
  onCancel,
}) {
  const source = item.url || item.originalUrl;
  const [language, setLanguage] = useState(() => defaultOcrLanguage(getLanguage()));
  const [run, setRun] = useState(0);
  const [state, setState] = useState({ status: "reading", stage: "load", progress: 0 });
  const [text, setText] = useState("");
  const controller = useRef(null);

  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    setState({ status: "reading", stage: "load", progress: 0 });
    setText("");
    (async () => {
      try {
        const { readImageText } = await import("./ocr-engine.js");
        const result = await readImageText(source, language, {
          signal: c.signal,
          onProgress: ({ stage, progress }) => {
            if (!c.signal.aborted) setState((s) => (s.status === "reading" ? { ...s, stage, progress } : s));
          },
        });
        if (c.signal.aborted) return;
        setText(result.text);
        setState({ status: "done", ...result });
      } catch (e) {
        if (c.signal.aborted || e?.name === "AbortError") return;
        setState({
          status: "error",
          message:
            e?.message === "This image can't be read."
              ? e.message
              : "The text reader couldn't load. Check your connection and try again.",
        });
      }
    })();
    return () => c.abort();
  }, [source, language, run]);

  const done = state.status === "done";
  const note = done ? confidenceNote(state.confidence, text) : null;
  const savings = useMemo(
    () =>
      done && text.trim()
        ? ocrSavings({ model, markup, width: state.width, height: state.height, name: item.name, text })
        : null,
    [done, text, model, markup, state.width, state.height, item.name],
  );
  // Veil's count on a copy of this chat's map: the same tags Send would use,
  // without remembering anything for text that may never be sent.
  const masked = useMemo(
    () => (veilWith && done && text ? veil(text, cloneVeilState(veilWith.state), veilWith.words).count : 0),
    [veilWith, done, text],
  );
  const canUse = done && !!text.trim() && !documentsFull;
  // Loading the reader fills the first 30% of the bar; reading the rest.
  const percent = Math.round(
    (state.stage === "read" ? 30 + 70 * (state.progress || 0) : 30 * (state.progress || 0)),
  );
  const cancel = () => {
    controller.current?.abort();
    onCancel();
  };
  return (
    <Modal title="Text only" onClose={cancel}>
      <div className="ocr-panel">
        <p className="ocr-lede">
          Send the words, not the picture. The text is read in this browser; the image isn't uploaded.
        </p>
        <div className="ocr-body">
          <figure className="ocr-image">
            <img src={source} alt={item.name} data-i18n="off" />
            <figcaption>
              <span data-i18n="off">{item.name}</span>
              {item.redacted && <span className="redact-tag">Redacted</span>}
            </figcaption>
          </figure>
          <div className="ocr-main">
            <label className="ocr-language">
              <span>Language</span>
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {OCR_LANGUAGES.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
            {state.status === "reading" ? (
              <div className="ocr-progress" role="status" aria-live="polite">
                <p>
                  <b>{state.stage === "read" ? "Reading the text…" : "Loading the text reader…"}</b>
                  <span>{percent + "%"}</span>
                </p>
                <div className="ocr-bar" aria-hidden="true">
                  <span style={{ width: percent + "%" }} />
                </div>
                <small>
                  {`The first time, your browser downloads the text reader (about ${megabytes(firstRunBytes(language))} MB) from ANONYMA and keeps it.`}
                </small>
              </div>
            ) : state.status === "error" ? (
              <div className="ocr-error">
                <Notice type="error">{state.message}</Notice>
                <button type="button" className="small-button" onClick={() => setRun((n) => n + 1)}>
                  Try again
                </button>
              </div>
            ) : (
              <>
                <label className="ocr-edit">
                  <span>Text from the image</span>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={9}
                    spellCheck={false}
                    data-i18n="off"
                  />
                </label>
                <p className={"ocr-confidence " + note.tone}>
                  <Icon name={note.tone === "good" ? "check" : "warning"} size={13} />
                  <span>{note.text}</span>
                </p>
              </>
            )}
          </div>
        </div>
        <ul className="ocr-facts">
          <li>
            <Icon name="warning" size={14} />
            <span>OCR can misread text; check it before sending.</span>
          </li>
          <li>
            <Icon name="scantext" size={14} />
            <span>Use text replaces the image with this text. The image isn't sent or kept.</span>
          </li>
          {savings && (
            <li className="ocr-saving">
              <Icon name="coins" size={14} />
              <span>
                <b>
                  {`Input: image ≈ ${formatCredits(savings.image)} credits → text ≈ ${formatCredits(savings.text)} credits`}
                </b>
                <small>Estimated in this browser at this model's input rate. The provider's own count decides the charge.</small>
              </span>
            </li>
          )}
          {masked > 0 && (
            <li>
              <Icon name="eyeoff" size={14} />
              <span>
                {masked === 1
                  ? "Veil will mask 1 item in this text before it's sent."
                  : `Veil will mask ${masked} items in this text before it's sent.`}
              </span>
            </li>
          )}
          {item.redacted ? (
            <li>
              <Icon name="redact" size={14} />
              <span>Read from the redacted copy: what you blacked out stays out.</span>
            </li>
          ) : (
            onRedact && (
              <li className="ocr-redact">
                <Icon name="redact" size={14} />
                <span>To leave part of the image out, redact it first. The text is then read from the redacted copy.</span>
                <button type="button" className="small-button" onClick={onRedact}>
                  Redact first
                </button>
              </li>
            )
          )}
        </ul>
        {documentsFull && (
          <Notice>{`${MAX_DOCUMENTS} documents are already attached. Remove one to add this text.`}</Notice>
        )}
        <div className="inline-actions ocr-actions">
          <Button
            type="button"
            className="ocr-use"
            disabled={!canUse}
            onClick={() => canUse && onUse(ocrDocument(item, text.trim(), uid()))}
          >
            <Icon name="check" size={15} />
            Use text
          </Button>
          <Button type="button" secondary onClick={cancel}>
            Keep image
          </Button>
        </div>
      </div>
    </Modal>
  );
}
