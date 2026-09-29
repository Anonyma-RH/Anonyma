import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  TextSearch,
  WholeWord,
  X,
} from "lucide-react";
import { isReleased } from "./lib.js";
import { useLanguage } from "./i18n.js";
import { isApplePlatform } from "./command-palette.js";
import {
  CONTENT_SELECTOR,
  FIND_RELEASE,
  MAX_QUERY,
  cleanQuery,
  collectText,
  countLabel,
  findAriaShortcut,
  findMatches,
  findShortcutLabel,
  findStepKey,
  isFindShortcut,
  matchRange,
  prepareItem,
  sameOrNext,
  startIndex,
  step,
  takesShortcut,
} from "./find-in-chat.js";
import "./find-in-chat.css";

// Find in Chat (update "findinchat"): ⌘F / Ctrl+F, or the header's Find
// button, opens a bar that searches the conversation on screen. Matches are
// painted with the CSS Custom Highlight API, so the messages' DOM (markdown,
// code blocks, copy buttons) is never touched; nothing is sent anywhere.
// The pure parts are in src/find-in-chat.js.

export const findInChatReleased = (config) => isReleased(config, FIND_RELEASE);

const ALL = "anonyma-find";
const CURRENT = "anonyma-find-current";
const EDITABLE =
  "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
const supportsHighlights = () =>
  typeof CSS !== "undefined" &&
  !!CSS.highlights &&
  typeof Highlight === "function";

// Another open dialog (rename, Scrolls, the palette…) keeps the keyboard.
function otherModalOpen() {
  try {
    return !!document.querySelector("dialog:modal");
  } catch {
    return !!document.querySelector("dialog[open]");
  }
}
function refocus(el) {
  if (!el?.isConnected || typeof el.focus !== "function") return;
  if (document.activeElement === el) el.blur();
  el.focus({ preventScroll: true });
}

// Browsers without highlights (older Safari and Firefox) get the current
// match outlined by boxes laid over the page instead; the soft highlight on
// every other match is skipped there.
function fallbackLayer() {
  let layer = document.getElementById("find-in-chat-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "find-in-chat-layer";
    layer.setAttribute("aria-hidden", "true");
    document.body.append(layer);
  }
  return layer;
}
function clearPaint() {
  if (supportsHighlights()) {
    CSS.highlights.delete(ALL);
    CSS.highlights.delete(CURRENT);
  }
  document.getElementById("find-in-chat-layer")?.remove();
}
function paintCurrent(range) {
  if (supportsHighlights()) {
    const current = new Highlight();
    if (range) current.add(range);
    current.priority = 1;
    CSS.highlights.set(CURRENT, current);
    return;
  }
  const layer = fallbackLayer();
  layer.replaceChildren();
  if (!range) return;
  for (const r of range.getClientRects()) {
    const box = document.createElement("div");
    box.className = "find-in-chat-box";
    box.style.left = r.left + window.scrollX - 1 + "px";
    box.style.top = r.top + window.scrollY - 1 + "px";
    box.style.width = r.width + 2 + "px";
    box.style.height = r.height + 2 + "px";
    layer.append(box);
  }
}
function paintAll(ranges) {
  if (!supportsHighlights()) return;
  const all = new Highlight();
  for (const r of ranges) if (r) all.add(r);
  CSS.highlights.set(ALL, all);
}

// The chat's parts that are searched, outermost first, in page order.
function collect(rootSelector) {
  const root = document.querySelector(rootSelector);
  if (!root) return [];
  return [...root.querySelectorAll(CONTENT_SELECTOR)]
    .filter((el) => {
      const up = el.parentElement?.closest(CONTENT_SELECTOR);
      return !up || !root.contains(up);
    })
    .map((el) => prepareItem({ el, ...collectText(el) }));
}
function toRange(item, m) {
  const at = item && matchRange(item.segments, m.start, m.end);
  if (!at) return null;
  try {
    const range = document.createRange();
    range.setStart(at[0], at[1]);
    range.setEnd(at[2], at[3]);
    return range;
  } catch {
    return null;
  }
}

// Brings a match into view: inside a wide code block or a scrolling column
// first, then the page, between the Find bar and the composer that covers
// the bottom of the chat.
function reveal(range, barEl) {
  if (!range) return;
  let el = range.startContainer?.parentElement;
  while (el && el !== document.body && el !== document.documentElement) {
    const cs = getComputedStyle(el);
    const r = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (
      /(auto|scroll)/.test(cs.overflowX) &&
      el.scrollWidth > el.clientWidth + 1
    ) {
      if (r.left < box.left + 12 || r.right > box.right - 12)
        el.scrollLeft +=
          r.left - box.left - Math.max(12, (box.width - r.width) / 2);
    }
    if (
      /(auto|scroll)/.test(cs.overflowY) &&
      el.scrollHeight > el.clientHeight + 1
    ) {
      if (r.top < box.top + 12 || r.bottom > box.bottom - 12)
        el.scrollTop +=
          r.top - box.top - Math.max(12, (box.height - r.height) / 2);
    }
    el = el.parentElement;
  }
  const r = range.getBoundingClientRect();
  const { top, bottom } = band(barEl);
  if (r.top < top + 24 || r.bottom > bottom - 24)
    window.scrollBy({
      top: r.top - (top + (bottom - top) * 0.35),
      behavior: "instant",
    });
}
// The part of the window where the chat can be read.
function band(barEl) {
  const height = window.visualViewport?.height || window.innerHeight;
  const top = Math.max(0, barEl?.getBoundingClientRect().bottom || 0);
  const composer = document
    .querySelector(".workspace-body .composer-zone")
    ?.getBoundingClientRect();
  const bottom =
    composer && composer.top > top + 120 && composer.top < height
      ? composer.top
      : height;
  return { top, bottom };
}

// The whole feature for one page: `enabled` once the update is released;
// `findable` while a conversation is on screen. `resetKey` closes the bar
// when it changes (another workspace section).
export function useFindInChat({
  enabled,
  findable,
  config,
  resetKey,
  rootSelector = ".workspace-body > .chat-area",
  scope = ".app-shell",
}) {
  const live = !!enabled && !!findable;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [count, setCount] = useState({ index: -1, total: 0, capped: false });
  const apple = useMemo(() => isApplePlatform(), []);
  const language = useLanguage();
  const uiLang = language !== "en" && isReleased(config, language) ? language : false;
  const bar = useRef(null),
    input = useRef(null),
    previous = useRef(null),
    pending = useRef(null),
    found = useRef({ items: [], matches: [], ranges: [], index: -1 }),
    latest = useRef({});
  latest.current = { live, open, query, matchCase, wholeWord };

  function search(kind) {
    clearTimeout(pending.current);
    pending.current = null;
    const { query: q0, matchCase: mc, wholeWord: ww } = latest.current;
    const q = cleanQuery(q0);
    const items = q ? collect(rootSelector) : [];
    const { matches, capped } = findMatches(items, q, {
      matchCase: mc,
      wholeWord: ww,
    });
    const ranges = matches.map((m) => toRange(items[m.item], m));
    const before = found.current;
    const index =
      kind === "refresh"
        ? sameOrNext(matches, before.matches[before.index])
        : startIndex(
            matches.length,
            (i) => ranges[i]?.getBoundingClientRect(),
            band(bar.current).top,
          );
    found.current = { items, matches, ranges, index };
    paintAll(ranges);
    paintCurrent(ranges[index]);
    setCount({ index, total: matches.length, capped });
    if (kind === "fresh" && index >= 0) reveal(ranges[index], bar.current);
  }
  function move(direction) {
    if (pending.current) return search("fresh");
    let f = found.current;
    if (!f.matches.length) return;
    // The page changed under the matches (a reply streamed in): find again first.
    if (f.ranges.some((r) => r && !r.startContainer.isConnected)) {
      search("refresh");
      f = found.current;
      if (!f.matches.length) return;
    }
    f.index = step(f.index, f.matches.length, direction);
    paintCurrent(f.ranges[f.index]);
    setCount((c) => ({ ...c, index: f.index, total: f.matches.length }));
    reveal(f.ranges[f.index], bar.current);
  }
  function show() {
    const active = document.activeElement;
    if (!bar.current?.contains(active))
      previous.current = active && active !== document.body ? active : null;
    setOpen(true);
    setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 0);
  }
  function close({ restore = true } = {}) {
    clearTimeout(pending.current);
    pending.current = null;
    clearPaint();
    found.current = { items: [], matches: [], ranges: [], index: -1 };
    setCount({ index: -1, total: 0, capped: false });
    setOpen(false);
    const prev = previous.current;
    previous.current = null;
    if (restore) setTimeout(() => refocus(prev), 0);
  }
  const actions = useRef({});
  actions.current = { show, close, move, search };

  // The shortcut, from the page, the chat, the composer or the bar.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e) => {
      const { live: on, open: shown } = latest.current;
      if (isFindShortcut(e, apple)) {
        if (!on || otherModalOpen()) return;
        const active = document.activeElement;
        // Pressed again in the field: the browser's own find, as an escape hatch.
        if (shown && active && active === input.current) return;
        const body =
          !active ||
          active === document.body ||
          active === document.documentElement;
        const ok = takesShortcut({
          body,
          inBar: !!bar.current?.contains(active),
          composer:
            !!active?.closest?.(".composer-zone") &&
            !!active?.matches?.("textarea"),
          editable:
            !!active?.matches?.(EDITABLE) || !!active?.isContentEditable,
          inWorkspace: !!active?.closest?.(scope),
        });
        if (!ok) return;
        e.preventDefault();
        e.stopPropagation();
        actions.current.show();
        return;
      }
      if (!shown) return;
      const dir = findStepKey(e, apple);
      if (dir && !otherModalOpen()) {
        e.preventDefault();
        e.stopPropagation();
        actions.current.move(dir);
        return;
      }
      // Escape outside the bar closes it too, from the page or the chat.
      if (e.key === "Escape" && !e.isComposing && !otherModalOpen()) {
        const active = document.activeElement;
        if (bar.current?.contains(active)) return;
        const body = !active || active === document.body;
        const inChat =
          !!active?.closest?.(rootSelector) && !active.matches?.(EDITABLE);
        if (body || inChat) actions.current.close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled, apple, rootSelector, scope]);

  // Nothing to search any more, or another section: close quietly.
  useEffect(() => {
    if (!live && latest.current.open) actions.current.close({ restore: false });
  }, [live]);
  useEffect(() => {
    if (latest.current.open) actions.current.close({ restore: false });
  }, [resetKey]);
  useEffect(() => () => clearPaint(), []);

  // A new query or option: search again shortly after typing stops.
  useEffect(() => {
    if (!open) return;
    clearTimeout(pending.current);
    pending.current = setTimeout(() => actions.current.search("fresh"), 60);
    return () => clearTimeout(pending.current);
  }, [open, query, matchCase, wholeWord]);

  // The chat changed (a reply streaming, a chat opened, Reasoning opened,
  // the language switched): search again, keeping your place.
  useEffect(() => {
    if (!open) return;
    const target = document.querySelector(".workspace-main") || document.body;
    let timer = null;
    const observer = new MutationObserver((records) => {
      if (records.every((r) => bar.current?.contains(r.target))) return;
      if (timer || !cleanQuery(latest.current.query)) return;
      timer = setTimeout(() => {
        timer = null;
        if (latest.current.open && !pending.current)
          actions.current.search("refresh");
      }, 200);
    });
    observer.observe(target, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [open]);

  const label = countLabel({ ...count, query }, uiLang);
  const barElement =
    live && open ? (
      <FindBar
        barRef={bar}
        inputRef={input}
        query={query}
        setQuery={setQuery}
        matchCase={matchCase}
        setMatchCase={setMatchCase}
        wholeWord={wholeWord}
        setWholeWord={setWholeWord}
        label={label}
        total={count.total}
        apple={apple}
        onMove={(d) => actions.current.move(d)}
        onEnter={(d) => actions.current.move(d)}
        onClose={() => actions.current.close()}
      />
    ) : null;
  const button = live ? (
    <FindButton
      apple={apple}
      open={open}
      onOpen={() => actions.current.show()}
    />
  ) : null;
  return {
    live,
    open,
    show: () => live && actions.current.show(),
    close: () => actions.current.close(),
    bar: barElement,
    button,
  };
}

// The header's way in, for touch screens.
export function FindButton({ apple, open, onOpen }) {
  return (
    <button
      type="button"
      className="find-open"
      aria-label="Find in this chat"
      aria-keyshortcuts={findAriaShortcut(apple)}
      aria-expanded={open}
      title={`Find in this chat (${findShortcutLabel(apple)})`}
      onClick={onOpen}
    >
      <TextSearch size={15} strokeWidth={1.6} aria-hidden="true" />
      <span>Find</span>
    </button>
  );
}

export function FindBar({
  barRef,
  inputRef,
  query,
  setQuery,
  matchCase,
  setMatchCase,
  wholeWord,
  setWholeWord,
  label,
  total,
  onMove,
  onEnter,
  onClose,
}) {
  const id = useId();
  function onKeyDown(e) {
    if (e.nativeEvent?.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }
  return (
    <div
      className="find-bar"
      role="search"
      aria-label="Find in this chat"
      ref={barRef}
      onKeyDown={(e) => {
        if (
          e.key === "Escape" &&
          e.target !== inputRef.current &&
          !e.nativeEvent?.isComposing
        ) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="find-bar-inner">
        <label className="find-field">
          <TextSearch size={15} strokeWidth={1.6} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            maxLength={MAX_QUERY}
            aria-label="Find in this chat"
            aria-describedby={id + "-count"}
            placeholder="Find in this chat"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span
            id={id + "-count"}
            className={"find-count" + (label && !total ? " none" : "")}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-i18n="off"
          >
            {label}
          </span>
        </label>
        <div className="find-options">
          <button
            type="button"
            aria-label="Match case"
            title="Match case"
            aria-pressed={matchCase}
            onClick={() => setMatchCase((v) => !v)}
          >
            <CaseSensitive size={17} strokeWidth={1.6} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Whole word"
            title="Whole word"
            aria-pressed={wholeWord}
            onClick={() => setWholeWord((v) => !v)}
          >
            <WholeWord size={17} strokeWidth={1.6} aria-hidden="true" />
          </button>
        </div>
        <div className="find-steps">
          <button
            type="button"
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            disabled={!total}
            onClick={() => onMove(-1)}
          >
            <ChevronUp size={17} strokeWidth={1.6} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Next match"
            title="Next match (Enter)"
            disabled={!total}
            onClick={() => onMove(1)}
          >
            <ChevronDown size={17} strokeWidth={1.6} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Close find"
            title="Close (Esc)"
            onClick={onClose}
          >
            <X size={17} strokeWidth={1.6} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
