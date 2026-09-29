import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Icon, Modal } from "./ui.jsx";
import { readStore, saveStore } from "./lib.js";
import { t, useLanguage } from "./i18n.js";
import { isSoft, scanSecrets } from "./seed-guard.js";
import {
  MAX_CARD_TEXT,
  PREFS_KEY,
  SIZES,
  TEMPLATES,
  cardFileName,
  cleanCardText,
  cleanPrefs,
  creditLine,
  plainFromMarkdown,
  shownCardText,
  sizeById,
  veiledTags,
} from "./quote-cards.js";
import { cardBlob, copyImage, drawCard, layoutOnDevice, loadCardFonts, loadMark, saveBlob } from "./quote-card-render.js";
import "./quote-cards.css";

// Quote Cards (update "quotecards"): turn a reply, or part of one, into an
// image card. `source` is { text } (a selection, already plain) or
// { markdown } (a whole reply), plus { model } when the reply says which
// model wrote it. The card is drawn on a canvas in this browser
// (src/quote-card-render.js) and leaves as a download or a clipboard image.
// Nothing is uploaded and there is no link back to the chat. `veilMap` is
// this browser's Veil map for the chat: placeholders stay masked on the card
// unless the person chooses to show the real values. `seedGuard` (Seed Guard
// released) adds a warning when the text looks like a seed phrase or key.
export const quoteCardsReleased = (config) => config?.releases?.features?.quotecards === true;

export default function QuoteCardDialog({ source, modelName = "", veilMap = null, seedGuard = false, onClose }) {
  const language = useLanguage();
  const [prefs, setPrefs] = useState(() => cleanPrefs(readStore(PREFS_KEY, null)));
  const [text, setText] = useState(() =>
    cleanCardText(source?.markdown != null ? plainFromMarkdown(source.markdown) : source?.text || ""),
  );
  const [reveal, setReveal] = useState(false);
  const [state, setState] = useState({ status: "loading", truncated: false, shown: 0 });
  const [flash, setFlash] = useState("");
  const canvas = useRef(null);
  const run = useRef(0);
  const flashTimer = useRef(null);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const map = veilMap && typeof veilMap === "object" ? veilMap : null;
  const masked = useMemo(() => veiledTags(text, map), [text, map]);
  const shown = shownCardText(text, { reveal: reveal && masked.length > 0, map });
  const size = sizeById(prefs.size) || SIZES[0];
  // Seed Guard, once released: a wallet seed phrase or key on a card would be
  // shown to everyone the image is sent to. Nothing about the match is kept,
  // and the notice never repeats it.
  const secret = useMemo(() => {
    const hit = seedGuard ? scanSecrets(shown) : null;
    return hit && !isSoft(hit);
  }, [seedGuard, shown]);
  const credit = creditLine({
    asked: prefs.asked,
    model: prefs.model,
    brand: t("Asked on ANONYMA"),
    modelName,
  });

  const choose = (patch) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      saveStore(PREFS_KEY, next);
      return next;
    });

  // Draw the card whenever anything on it changes. Typing waits a moment.
  useEffect(() => {
    const mine = ++run.current;
    setState((s) => ({ ...s, status: "loading" }));
    const timer = setTimeout(async () => {
      try {
        const [mark] = await Promise.all([loadMark(), loadCardFonts(shown, credit)]);
        if (mine !== run.current || !canvas.current) return;
        const layout = layoutOnDevice({ template: prefs.template, size: prefs.size, text: shown, credit });
        drawCard(canvas.current, layout, mark);
        setState({
          status: "ready",
          truncated: layout.text.truncated,
          shown: layout.text.shown,
          total: layout.text.total,
        });
      } catch {
        if (mine === run.current) setState({ status: "error", truncated: false, shown: 0 });
      }
    }, 80);
    return () => clearTimeout(timer);
  }, [shown, credit, prefs.template, prefs.size, language]);

  const say = (message) => {
    clearTimeout(flashTimer.current);
    setFlash(message);
    flashTimer.current = setTimeout(() => setFlash(""), 3500);
  };
  const ready = state.status === "ready" && !!shown.trim();
  async function save() {
    if (!ready || !canvas.current) return;
    try {
      saveBlob(await cardBlob(canvas.current), cardFileName(prefs.size));
      say("Saved as a PNG.");
    } catch {
      say("The image couldn't be made.");
    }
  }
  async function copy() {
    if (!ready || !canvas.current) return;
    try {
      await copyImage(cardBlob(canvas.current));
      say("Copied the image.");
    } catch {
      say("This browser can't copy an image. Use Save PNG.");
    }
  }

  return (
    <Modal title="Quote card" onClose={onClose}>
      <div className="quote-card">
        <div className="quote-card-side">
          <div className="quote-card-stage">
            <canvas
              ref={canvas}
              width={size.width}
              height={size.height}
              role="img"
              aria-label="Card preview"
              data-size={prefs.size}
              data-template={prefs.template}
              data-state={state.status}
            />
          </div>
          {reveal && masked.length > 0 && (
            <p className="quote-card-alert" role="alert">
              <Icon name="warning" size={14} />
              <span>The card now shows the real details. Anyone you send the image to will be able to read them.</span>
            </p>
          )}
          {secret && (
            <p className="quote-card-alert" role="alert">
              <Icon name="lock" size={14} />
              <span>This text looks like a wallet seed phrase or key. The card would show it to anyone you send the image to.</span>
            </p>
          )}
        </div>
        <div className="quote-card-controls">
          <fieldset className="quote-card-group">
            <legend>Template</legend>
            <div className="quote-card-swatches" role="radiogroup" aria-label="Template">
              {TEMPLATES.map((tpl) => (
                <button
                  type="button"
                  key={tpl.id}
                  role="radio"
                  aria-checked={prefs.template === tpl.id}
                  className={prefs.template === tpl.id ? "on" : ""}
                  onClick={() => choose({ template: tpl.id })}
                >
                  <span className={"quote-card-swatch " + tpl.id} style={{ background: tpl.bg, color: tpl.accent, borderColor: tpl.edge || tpl.bg }} aria-hidden="true">
                    {"“"}
                  </span>
                  <span>{tpl.name}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="quote-card-group">
            <legend>Size</legend>
            <div className="quote-card-sizes" role="radiogroup" aria-label="Size">
              {SIZES.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  role="radio"
                  aria-checked={prefs.size === s.id}
                  className={prefs.size === s.id ? "on" : ""}
                  onClick={() => choose({ size: s.id })}
                >
                  <b data-i18n="off">{s.label}</b>
                  <small data-i18n="off">{s.detail}</small>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="quote-card-text">
            <label htmlFor="quote-card-text">Card text</label>
            <textarea
              id="quote-card-text"
              data-i18n="off"
              rows={5}
              maxLength={MAX_CARD_TEXT}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {state.status === "error" && (
              <p className="quote-card-warn" role="alert">
                The image couldn't be made.
              </p>
            )}
            {state.truncated && state.status === "ready" && (
              <p className="quote-card-warn" role="status">
                {`Too long for one card. The first ${state.shown} characters fit; the rest is left off.`}
              </p>
            )}
          </div>
          <fieldset className="quote-card-options">
            <legend>Lines under the quote</legend>
            <label>
              <input type="checkbox" checked={prefs.asked} onChange={(e) => choose({ asked: e.target.checked })} />
              <span>Asked on ANONYMA</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={prefs.model && !!modelName}
                disabled={!modelName}
                onChange={(e) => choose({ model: e.target.checked })}
              />
              <span>
                The model's name
                {modelName ? <small data-i18n="off">{modelName}</small> : <small>Not known for this text</small>}
              </span>
            </label>
            {masked.length > 0 && (
              <label className="quote-card-reveal">
                <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
                <span>
                  Show the real details Veil masked
                  <small>
                    {reveal
                      ? "Untick this to mask them again."
                      : masked.length === 1
                        ? "1 masked detail stays as a tag like [EMAIL_1] unless you tick this."
                        : `${masked.length} masked details stay as tags like [EMAIL_1] unless you tick this.`}
                  </small>
                </span>
              </label>
            )}
          </fieldset>
          <div className="quote-card-actions">
            <Button onClick={save} disabled={!ready}>
              <Icon name="download" size={15} />
              Save PNG
            </Button>
            <Button secondary onClick={copy} disabled={!ready}>
              <Icon name="copy" size={15} />
              Copy image
            </Button>
            <span className="quote-card-flash" role="status" aria-live="polite">
              {flash}
            </span>
          </div>
          <p className="quote-card-fine">
            Made on this device. Nothing is uploaded, and the image has no link back to your chat.
          </p>
        </div>
      </div>
    </Modal>
  );
}
