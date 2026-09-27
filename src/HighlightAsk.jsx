import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isReleased, readStore, saveStore } from "./lib.js";
import { Icon } from "./ui.jsx";
import { formatCredits } from "./estimate.js";
import { hostOf } from "./deep-research.js";
import { getLanguage } from "./i18n.js";
import {
  HIGHLIGHT_UPDATE,
  LANGUAGES,
  MAX_CLAIM,
  MAX_QUOTE,
  VERDICTS,
  clipQuote,
  defaultLanguage,
  languageById,
  quotePrompt,
  tidySelection,
} from "./highlight-ask.js";
import "./highlight-ask.css";

// Highlight & Ask (update "highlight"): select text inside a reply and a
// small toolbar offers Ask about this, Explain, Simplify, Translate and
// Fact-check. The first four put a quote of the selection in the composer
// with a short instruction, to edit and send as an ordinary chat turn.
// Fact-check shows the most it can cost, then runs one web search on just
// the selection (server/routes/factcheck.js) and adds its verdict as a card.
//
// Replies opt in with a data-highlight-reply attribute: the workspace's
// assistant turns, Blind panes once revealed, Deep Research reports and
// Symposium's answers. Shared and public views never have it. On a touch
// screen, or a narrow one, the toolbar is a bottom sheet instead.
export const highlightReleased = (config) => isReleased(config, HIGHLIGHT_UPDATE);
export const factCheckReleased = (config) =>
  isReleased(config, HIGHLIGHT_UPDATE) && isReleased(config, "search");

// ---- Translate's language, remembered in this browser ----
const LANG_KEY = "highlight:lang";
export function loadTranslateLanguage() {
  const saved = readStore(LANG_KEY, null);
  if (languageById(saved)) return saved;
  let browser = [];
  try {
    browser = navigator.languages || [navigator.language];
  } catch {}
  return defaultLanguage(getLanguage(), browser);
}
export const saveTranslateLanguage = (id) => languageById(id) && saveStore(LANG_KEY, id);

// ---- The selection ----

// A selection's words as they read on screen. A veiled value is quoted as
// its placeholder (so Veil keeps masking it), typeset math as its TeX, and
// buttons, icons and diagram drawings are left out.
function rangeText(range) {
  const frag = range.cloneContents();
  // Media never go into the off-screen copy (nothing to load, nothing to read).
  frag.querySelectorAll("img, picture, video, audio, iframe, object, embed").forEach((el) => el.remove());
  frag.querySelectorAll(".katex").forEach((el) => {
    const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (tex == null) return;
    const display = !!el.parentElement?.classList?.contains("katex-display");
    el.replaceWith(document.createTextNode(display ? `$$${tex}$$` : `$${tex}$`));
  });
  frag.querySelectorAll(".katex-mathml").forEach((el) => el.remove());
  frag.querySelectorAll("mark.veil-mark[data-veil-tag]").forEach((el) => {
    el.replaceWith(document.createTextNode(`[${el.getAttribute("data-veil-tag")}]`));
  });
  frag
    .querySelectorAll("button, svg, .rich-tools, .rich-source, .rich-block-note, .copy-button")
    .forEach((el) => el.remove());
  // Laid out off screen so line breaks between paragraphs and list items
  // survive (innerText); never translated, and gone again at once.
  const box = document.createElement("div");
  box.setAttribute("data-i18n", "off");
  box.setAttribute("aria-hidden", "true");
  box.style.cssText =
    "position:fixed;left:-20000px;top:0;width:760px;opacity:0;pointer-events:none;white-space:normal";
  box.appendChild(frag);
  document.body.appendChild(box);
  const text = box.innerText;
  box.remove();
  return tidySelection(text);
}
const replyOf = (node) =>
  (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.("[data-highlight-reply]") || null;

// The selection, if it lies inside one reply under `root`: its text, where
// it is on screen, and the model that wrote it (when the reply says). An
// end that strays out of the reply (a triple-click, say) is pulled back in;
// a selection across two replies is ignored.
export function readSelection(root) {
  const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
  if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0).cloneRange();
  const start = replyOf(range.startContainer);
  const end = replyOf(range.endContainer);
  const reply = start || end;
  if (!reply || (start && end && start !== end) || !root.contains(reply)) return null;
  if (!start) range.setStart(reply, 0);
  if (!end) range.setEnd(reply, reply.childNodes.length);
  let text;
  try {
    text = rangeText(range);
  } catch {
    text = tidySelection(sel.toString());
  }
  if (!text) return null;
  return { text, range, model: reply.getAttribute("data-highlight-model") || null };
}
const boxOf = (range) => {
  const r = range.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
};
const sheetWanted = () => {
  try {
    return window.matchMedia("(pointer: coarse)").matches || window.innerWidth <= 640;
  } catch {
    return false;
  }
};

// The live fact-check quote for a selection: { status, ... }.
function useQuote(check, claim, model, on) {
  const [state, setState] = useState({ status: "idle" });
  useEffect(() => {
    if (!on || !check) return setState({ status: "idle" });
    const block = check.block(claim, model);
    if (block) return setState({ status: "blocked", message: block });
    const controller = new AbortController();
    setState({ status: "loading" });
    check.quote(claim, model, controller.signal).then(
      (q) => setState({ status: "ready", ...q }),
      (e) => {
        if (e?.name !== "AbortError") setState({ status: "blocked", message: e?.message || "The estimate is unavailable." });
      },
    );
    return () => controller.abort();
  }, [on, claim, model]);
  return state;
}

// The toolbar, over whichever reply the selection is in. `onQuote(text,
// { clipped })` puts a quote in the composer; `factCheck`, when offered, is
// { modelName(model), block(claim, model), quote(claim, model, signal),
// run(claim, model) }, where `model` is the reply's own model if it says.
export function HighlightToolbar({ root, enabled = true, onQuote, factCheck = null }) {
  const [sel, setSel] = useState(null);
  const [step, setStep] = useState("actions");
  const [menu, setMenu] = useState(false);
  const [lang, setLang] = useState(() => loadTranslateLanguage());
  const [pos, setPos] = useState(null);
  const [sheet, setSheet] = useState(false);
  const box = useRef(null);
  const inside = useRef(false);
  const live = useRef({ sel: null, step: "actions", sheet: false });
  live.current = { sel, step, sheet };
  const claim = sel ? tidySelection(sel.text) : "";
  const quote = useQuote(factCheck, claim, sel?.model || null, step === "check" && !!sel);

  const close = (clear = false) => {
    setSel(null);
    setStep("actions");
    setMenu(false);
    if (clear) {
      try {
        window.getSelection()?.removeAllRanges();
      } catch {}
    }
  };
  useEffect(() => {
    if (!enabled) return close();
    const show = () => {
      const found = readSelection(root.current);
      if (!found) return;
      setSheet(sheetWanted());
      setStep("actions");
      setMenu(false);
      setSel(found);
    };
    let timer;
    // A mouse or keyboard selection shows the toolbar once it's made; on a
    // touch screen, once the long-press selection settles. A click on the
    // toolbar itself is left to the toolbar.
    const settle = (e) => {
      if (e?.target && box.current?.contains(e.target)) return;
      clearTimeout(timer);
      timer = setTimeout(show, 30);
    };
    // The toolbar goes when its selection does. The sheet, and the
    // fact-check step, stay until closed or tapped away from: a tap on a
    // phone can clear the selection before the button's click arrives.
    const onChange = () => {
      if (inside.current) return;
      const s = window.getSelection?.();
      if (!s || s.isCollapsed) {
        if (live.current.step !== "check" && !live.current.sheet) close();
        return;
      }
      if (sheetWanted()) {
        clearTimeout(timer);
        timer = setTimeout(show, 450);
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape" && live.current.sel) close(true);
      else if (e.shiftKey || e.key === "Shift") settle(e);
    };
    const onDown = (e) => {
      if (box.current?.contains(e.target)) return;
      if (live.current.step === "check" || live.current.sheet) close();
    };
    document.addEventListener("selectionchange", onChange);
    document.addEventListener("mouseup", settle);
    document.addEventListener("keyup", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
      document.removeEventListener("mouseup", settle);
      document.removeEventListener("keyup", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [enabled]);

  // Placed above the selection (below when there's no room), and kept
  // there as the thread scrolls.
  useLayoutEffect(() => {
    if (!sel || sheet) return setPos(null);
    const place = () => {
      const el = box.current;
      if (!el || !live.current.sel) return;
      // The reply it was over has gone (another chat, a new run).
      if (!live.current.sel.range.commonAncestorContainer?.isConnected) return close();
      const r = boxOf(live.current.sel.range);
      const w = el.offsetWidth,
        h = el.offsetHeight;
      const vw = window.innerWidth,
        vh = window.innerHeight;
      let top = r.top - h - 10;
      if (top < 8) top = r.bottom + 10;
      top = Math.min(Math.max(8, top), vh - h - 8);
      const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8);
      setPos({ top, left, hidden: r.bottom < 0 || r.top > vh });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [sel, sheet, step, menu, quote.status]);

  // The sheet sits on what's actually on screen (the visual viewport), so a
  // page that's wider than the phone, or zoomed, can't push it off the edge.
  const [view, setView] = useState(null);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!sel || !sheet || !vv) return setView(null);
    const fit = () =>
      setView({
        left: vv.offsetLeft,
        width: vv.width,
        bottom: Math.max(0, window.innerHeight - vv.offsetTop - vv.height),
      });
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => {
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
    };
  }, [sel, sheet]);

  if (!enabled || !sel) return null;
  const clipped = sel.text.length > MAX_QUOTE;
  const target = languageById(lang) || LANGUAGES[0];
  const act = (action, pick) => {
    const id = pick || lang;
    if (pick) {
      setLang(pick);
      saveTranslateLanguage(pick);
    }
    onQuote?.(quotePrompt(action, sel.text, { uiLang: getLanguage(), lang: id }), { clipped, action });
    close(true);
  };
  const tooLong = claim.length > MAX_CLAIM;
  // The maximum against the balance and the spending limit, as Deep
  // Research's estimate says it: a check that can't be held isn't offered.
  const over =
    quote.status !== "ready"
      ? null
      : quote.available != null && quote.credits > quote.available
        ? "over your balance"
        : quote.spending_limit?.remaining != null && quote.credits > Number(quote.spending_limit.remaining)
          ? "over your spending limit"
          : null;
  const runCheck = () => {
    if (quote.status !== "ready" || over) return;
    factCheck.run(claim, sel.model || null);
    close(true);
  };
  const actions = (
    <div className="hl-actions" role="group" aria-label="Ask about the selected text">
      <button type="button" onClick={() => act("ask")}>
        <Icon name="quote" size={15} />
        <span>Ask about this</span>
      </button>
      <button type="button" onClick={() => act("explain")}>
        <Icon name="lightbulb" size={15} />
        <span>Explain</span>
      </button>
      <button type="button" onClick={() => act("simplify")}>
        <Icon name="feather" size={15} />
        <span>Simplify</span>
      </button>
      <span className="hl-split">
        <button type="button" className="hl-translate" onClick={() => act("translate")}>
          <Icon name="languages" size={15} />
          <span>Translate</span>
          <span className="hl-lang" data-i18n="off">
            {target.native}
          </span>
        </button>
        <button
          type="button"
          className="hl-more"
          aria-label="Choose a language"
          aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}
        >
          <Icon name="down" size={13} />
        </button>
      </span>
      {factCheck && (
        <button
          type="button"
          className="hl-check"
          disabled={tooLong}
          title={tooLong ? "Select up to 1,000 characters to fact-check." : "Check this against the web"}
          onClick={() => setStep("check")}
        >
          <Icon name="factcheck" size={15} />
          <span>Fact-check</span>
        </button>
      )}
    </div>
  );
  const languages = menu && (
    <div className="hl-languages" role="group" aria-label="Translate into">
      {LANGUAGES.map((l) => (
        <button
          type="button"
          key={l.id}
          aria-pressed={l.id === lang}
          className={l.id === lang ? "on" : ""}
          onClick={() => act("translate", l.id)}
        >
          <span data-i18n="off">{l.native}</span>
        </button>
      ))}
    </div>
  );
  const check = step === "check" && factCheck && (
    <section className="hl-confirm" aria-label="Fact-check">
      <p className="hl-eyebrow">
        <Icon name="factcheck" size={14} />
        FACT-CHECK
      </p>
      <blockquote className="hl-claim" data-i18n="off">
        {claim}
      </blockquote>
      {quote.status === "blocked" ? (
        <p className="hl-block" role="alert">
          <Icon name="warning" size={14} />
          <span>{quote.message}</span>
        </p>
      ) : (
        <p className="hl-cost" role="status">
          {quote.status === "ready" ? (
            <>
              <b>{`Up to ≈${formatCredits(quote.credits)} credits`}</b>
              {over && <b className="hl-over">{over === "over your balance" ? " · over your balance" : " · over your spending limit"}</b>}
              <span>{` · web search fee included · `}</span>
              <span data-i18n="off">{factCheck.modelName(sel.model || null)}</span>
            </>
          ) : (
            "Working out the most it can cost…"
          )}
        </p>
      )}
      <p className="hl-fine">
        Only the selected text is sent, not the rest of the chat. You pay only if a verdict comes back.
      </p>
      <div className="hl-confirm-actions">
        <button type="button" className="hl-cancel" onClick={() => setStep("actions")}>
          Back
        </button>
        <button type="button" className="hl-go" disabled={quote.status !== "ready" || !!over} onClick={runCheck}>
          <Icon name="factcheck" size={15} />
          Check it
        </button>
      </div>
    </section>
  );
  const keep = {
    ref: box,
    // Clicks inside keep the selection (and the toolbar) where they are.
    onMouseDown: (e) => {
      if (!e.target.closest?.("input, textarea, select")) e.preventDefault();
    },
    onPointerDown: () => {
      inside.current = true;
    },
    onPointerUp: () => setTimeout(() => (inside.current = false), 0),
    onPointerCancel: () => (inside.current = false),
  };
  const content = sheet ? (
    <div
      className="hl-sheet"
      role="dialog"
      aria-label="Selected text"
      style={view ? { left: view.left, right: "auto", width: view.width, bottom: view.bottom } : undefined}
      {...keep}
    >
      <div className="hl-sheet-head">
        <p className="hl-eyebrow">SELECTED TEXT</p>
        <button type="button" className="hl-close" aria-label="Close" onClick={() => close(true)}>
          <Icon name="close" size={16} />
        </button>
      </div>
      {step === "check" ? (
        check
      ) : (
        <>
          <p className="hl-excerpt" data-i18n="off">
            {clipQuote(sel.text, 220).text}
          </p>
          {actions}
          {languages}
          {clipped && <p className="hl-fine">Long selection: only the first 6,000 characters are quoted.</p>}
        </>
      )}
    </div>
  ) : (
    <div
      className={"hl-toolbar" + (step === "check" ? " checking" : "")}
      role="toolbar"
      aria-label="Selected text"
      style={pos ? { top: pos.top, left: pos.left, visibility: pos.hidden ? "hidden" : undefined } : { visibility: "hidden" }}
      {...keep}
    >
      {step === "check" ? check : (
        <>
          {actions}
          {languages}
        </>
      )}
    </div>
  );
  return createPortal(content, document.body);
}

// ---- The fact-check card in the conversation ----

const VERDICT_TEXT = {
  supported: "Supported",
  disputed: "Disputed",
  mixed: "Mixed",
  unverified: "Couldn't verify",
};
const VERDICT_ICON = { supported: "check", disputed: "close", mixed: "scale", unverified: "search" };
const VERDICT_NOTE = {
  supported: "The pages found back this.",
  disputed: "The pages found contradict this.",
  mixed: "The pages back part of this, or disagree.",
  unverified: "The pages found don't settle this.",
};

export function FactCheckCard({ factcheck = {}, citations = [] }) {
  if (factcheck.live)
    return (
      <div className="factcheck-card live" role="status" aria-live="polite">
        <p className="factcheck-eyebrow">
          <Icon name="factcheck" size={14} />
          FACT-CHECK
        </p>
        <p className="factcheck-working">
          <span className="factcheck-dot" aria-hidden="true" />
          Searching the web and weighing what it finds…
        </p>
      </div>
    );
  const verdict = VERDICTS.includes(factcheck.verdict) ? factcheck.verdict : "unverified";
  const sources = (citations || []).filter((c) => typeof c?.url === "string");
  return (
    <div className={"factcheck-card verdict-" + verdict}>
      <div className="factcheck-head">
        <p className="factcheck-eyebrow">
          <Icon name="factcheck" size={14} />
          FACT-CHECK
        </p>
        <span className={"factcheck-verdict " + verdict}>
          <Icon name={VERDICT_ICON[verdict]} size={14} />
          {VERDICT_TEXT[verdict]}
        </span>
      </div>
      <p className="factcheck-note">{VERDICT_NOTE[verdict]}</p>
      {factcheck.reason && (
        <p className="factcheck-reason" data-i18n="off">
          {factcheck.reason}
        </p>
      )}
      {sources.length > 0 && (
        <ol className="factcheck-sources">
          {sources.map((c, i) => (
            <li key={c.url + i}>
              <span className="factcheck-n">{i + 1}</span>
              {/^https?:\/\//i.test(c.url) ? (
                <a data-i18n="off" href={c.url} target="_blank" rel="noopener noreferrer nofollow">
                  {c.title || hostOf(c.url)}
                </a>
              ) : (
                <span data-i18n="off">{c.title || "Page"}</span>
              )}
              <span className="factcheck-host" data-i18n="off">
                {hostOf(c.url)}
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="factcheck-fine">
        {sources.length && factcheck.named === false
          ? "The model didn't name its sources, so these are the first pages the search returned."
          : "Sources are only pages the web search returned. Check what matters at the source."}
        {factcheck.credits_charged != null && ` · ${formatCredits(factcheck.credits_charged) || "0"} credits`}
      </p>
    </div>
  );
}
