import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "./ui.jsx";
import { isReleased, readStore, saveStore } from "./lib.js";
import { useLanguage, loadDictionary, translateText } from "./i18n.js";
import {
  ariaShortcut,
  flatten,
  isApplePlatform,
  isPaletteShortcut,
  moveActive,
  pushRecent,
  rankPalette,
  shortcutLabel,
  validRecent,
} from "./command-palette.js";
import "./command-palette.css";

// Command Palette: one keyboard-first search over the page's chats, models,
// scrolls and actions. The ranking and the list of actions are pure
// (src/command-palette.js); this file is the dialog, the ⌘K / Ctrl+K
// shortcut and the header button for touch screens.

// Another open dialog (rename, Scrolls, Memory, saved files…) keeps the
// keyboard: the shortcut doesn't open the palette on top of it.
function otherModalOpen() {
  try {
    return !!document.querySelector("dialog:modal:not(.palette)");
  } catch {
    return [...document.querySelectorAll("dialog[open]")].some(
      (d) => !d.classList.contains("palette"),
    );
  }
}

// The open state plus the global shortcut, which works from anywhere on the
// page, the composer included. Pressing it again closes the palette.
export function usePalette(enabled) {
  const [open, setOpen] = useState(false);
  const apple = useMemo(() => isApplePlatform(), []);
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e) => {
      if (!isPaletteShortcut(e, apple)) return;
      if (otherModalOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled, apple]);
  return { open: !!enabled && open, setOpen, apple };
}

// The visible way in, for touch screens and anyone who prefers a button.
export function PaletteButton({ onOpen, apple }) {
  return (
    <button
      type="button"
      className="palette-trigger"
      aria-haspopup="dialog"
      aria-keyshortcuts={ariaShortcut(apple)}
      aria-label="Open the command palette"
      title="Command palette"
      onClick={onOpen}
    >
      <Icon name="search" size={16} />
      <span className="palette-trigger-text">Search</span>
      <kbd data-i18n="off">{shortcutLabel(apple)}</kbd>
    </button>
  );
}

// While 中文 is on, action labels are shown (and searchable) in Chinese from
// the site's own dictionary. Chat titles, model names and scrolls are
// content and stay exactly as written.
function useTranslate(config) {
  const zh = useLanguage() === "zh" && isReleased(config, "zh");
  const [dict, setDict] = useState(null);
  useEffect(() => {
    if (!zh) return setDict(null);
    let live = true;
    loadDictionary().then(
      (d) => live && setDict(d),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [zh]);
  return useMemo(
    () => (zh && dict ? (s) => translateText(s, dict) : null),
    [zh, dict],
  );
}

// Focus goes back where it was once the event that closed the palette is
// over. Chrome's own dialog close already focuses that element, but without
// a caret: typing in the composer afterwards would go nowhere. A real blur
// and focus puts the caret back.
function refocus(el) {
  if (!el?.isConnected || typeof el.focus !== "function") return;
  if (document.activeElement === el) el.blur();
  el.focus({ preventScroll: true });
}

function Highlight({ text, ranges }) {
  if (!ranges?.length) return text;
  const parts = [];
  let at = 0;
  ranges.forEach(([start, end], i) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={i}>{text.slice(start, end)}</mark>);
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

// `items` is a list, or a function of the query for items that depend on
// it. `onRun(item, query)` runs the chosen item after the palette closes and
// focus is back where it was. Recents are item keys in this browser only.
export default function CommandPalette({
  items,
  onRun,
  onClose,
  config,
  apple = false,
  recentKey,
  record = true,
  placeholder = "Search chats, models, scrolls and actions…",
}) {
  const dialog = useRef(null),
    input = useRef(null),
    closeButton = useRef(null),
    list = useRef(null),
    previous = useRef(null),
    closing = useRef(false),
    restored = useRef(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent] = useState(() => validRecent(readStore(recentKey, [])));
  const tr = useTranslate(config);
  const id = useId();
  const source = typeof items === "function" ? items(query) : items || [];
  const prepared = tr
    ? source.map((it) => (it.i18n ? { ...it, alt: tr(it.label) || undefined } : it))
    : source;
  const { groups, total } = rankPalette(prepared, query, { recent });
  const flat = flatten(groups);
  const activeIndex = flat.length ? Math.max(0, Math.min(active, flat.length - 1)) : -1;

  useEffect(() => {
    closing.current = false;
    restored.current = false;
    previous.current = document.activeElement;
    const el = dialog.current;
    try {
      if (!el.open) el.showModal();
    } catch {
      el.setAttribute("open", "");
    }
    input.current?.focus();
    return () => {
      if (el.open) el.close();
      // Closed from outside (⌘K again): give focus back all the same.
      if (!restored.current) {
        const prev = previous.current;
        setTimeout(() => refocus(prev), 0);
      }
    };
  }, []);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, query]);

  // Closes, then (after this event) returns focus and runs `after`, so an
  // action that moves focus itself (the composer, a panel) has the last word.
  function finish(after) {
    if (closing.current) return;
    closing.current = true;
    restored.current = true;
    const prev = previous.current;
    input.current?.blur();
    if (dialog.current?.open) dialog.current.close();
    onClose();
    setTimeout(() => {
      refocus(prev);
      after?.();
    }, 0);
  }
  function run(item) {
    if (!item) return;
    if (record && !item.noRecent && recentKey)
      saveStore(recentKey, pushRecent(validRecent(readStore(recentKey, [])), item.key));
    const q = query.trim();
    finish(() => onRun(item, q));
  }
  function onInputKey(e) {
    if (e.nativeEvent?.isComposing) return;
    if (
      ["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(e.key) ||
      (["Home", "End"].includes(e.key) && !e.shiftKey && flat.length)
    ) {
      e.preventDefault();
      setActive((i) => moveActive(Math.min(i, flat.length - 1), e.key, flat.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(flat[activeIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish();
    }
  }
  // Focus stays inside: Tab and Shift+Tab move between the search field and
  // the close button. Results are reached with the arrow keys.
  function onDialogKey(e) {
    if (e.key !== "Tab") return;
    const stops = [input.current, closeButton.current].filter(Boolean);
    const at = stops.indexOf(document.activeElement);
    e.preventDefault();
    const next = e.shiftKey
      ? at <= 0
        ? stops.length - 1
        : at - 1
      : (at + 1) % stops.length;
    stops[next]?.focus();
  }

  const listId = id + "-list";
  const label = (it) => {
    if (it.id === "history-search")
      return (
        <>
          {it.alt || it.label} <q data-i18n="off">{it.query}</q>
        </>
      );
    const shown = it.alt || it.label;
    const ranges =
      (it.field === "alt" && it.alt) || (it.field === "label" && !it.alt) ? it.ranges : [];
    return <Highlight text={shown} ranges={ranges} />;
  };
  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-labelledby={id + "-title"}
      onCancel={(e) => {
        e.preventDefault();
        finish();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) finish();
      }}
      onKeyDown={onDialogKey}
    >
      <div className="palette-box">
        <h2 className="sr-only" id={id + "-title"}>
          Command palette
        </h2>
        <div className="palette-search">
          <Icon name="search" size={18} />
          <label className="sr-only" htmlFor={id + "-input"}>
            {placeholder}
          </label>
          <input
            ref={input}
            id={id + "-input"}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? `${id}-o-${activeIndex}` : undefined}
            aria-describedby={id + "-help"}
            placeholder={placeholder}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={160}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
          />
          <button
            ref={closeButton}
            type="button"
            className="palette-close"
            aria-label="Close the command palette"
            onClick={() => finish()}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <p className="sr-only" id={id + "-help"}>
          Use the up and down arrow keys to move through the results, Enter to choose, and Escape to close.
        </p>
        <div ref={list} id={listId} className="palette-list" role="listbox" aria-label="Results">
          {groups.map((g) => (
            <div role="group" key={g.id} aria-labelledby={`${id}-g-${g.id}`}>
              <div role="presentation" className="palette-group" id={`${id}-g-${g.id}`}>
                {g.label}
              </div>
              {g.items.map((it) => (
                <div
                  key={it.key}
                  id={`${id}-o-${it.index}`}
                  role="option"
                  aria-selected={it.index === activeIndex}
                  data-index={it.index}
                  data-key={it.key}
                  className={"palette-option" + (it.index === activeIndex ? " active" : "")}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => it.index !== activeIndex && setActive(it.index)}
                  onClick={() => run(it)}
                >
                  <Icon name={it.icon || "command"} size={16} />
                  <span className="palette-text">
                    <span className="palette-label" data-i18n="off">
                      {label(it)}
                    </span>
                    {(it.detail || it.time || it.tags?.length > 0) && (
                      <span className="palette-detail">
                        {it.detail && (
                          <span data-i18n={it.group === "models" ? "off" : undefined}>{it.detail}</span>
                        )}
                        {it.time && <span>{it.time}</span>}
                        {it.tags?.map((t) => (
                          <span className="palette-tag" key={t}>
                            {t}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  {it.current ? (
                    <span className="palette-badge current">Current</span>
                  ) : it.toggle ? (
                    <span className={"palette-badge" + (it.on ? " on" : "")}>{it.on ? "On" : "Off"}</span>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
        {!total && (
          <p className="palette-empty">
            {query.trim() ? "Nothing matches. Try fewer letters or another word." : "Nothing to show here yet."}
          </p>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {query.trim() ? (total === 1 ? "1 result" : `${total} results`) : ""}
        </p>
        <div className="palette-hints" aria-hidden="true">
          <span>
            <kbd data-i18n="off">↑</kbd>
            <kbd data-i18n="off">↓</kbd> Move
          </span>
          <span>
            <kbd data-i18n="off">Enter</kbd> Choose
          </span>
          <span>
            <kbd data-i18n="off">Esc</kbd> Close
          </span>
          <span className="palette-hint-shortcut">
            <kbd data-i18n="off">{shortcutLabel(apple)}</kbd> Open or close
          </span>
        </div>
      </div>
    </dialog>
  );
}
