import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { getLanguage, t } from "./i18n.js";
import { Icon, Notice } from "./ui.jsx";
import { api, download, isReleased, messageFromServer, readStore, saveStore, streamChat, uid } from "./lib.js";
import { createVeilState, loadVeilState, saveVeilState, unveil, veil } from "./veil.js";
import { VeilToggle } from "./Veil.jsx";
import { PrivateModeToggle, NoPrivateModelsNotice, privateModeReleased } from "./PrivateMode.jsx";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import { isSoft } from "./seed-guard.js";
import { useShieldLive } from "./Shield.jsx";
import { useCreditEstimate } from "./CreditEstimate.jsx";
import { formatCredits } from "./estimate.js";
import { pickPreset } from "./model-finder.js";
import { pdfText } from "./pdf-text.js";
import { extractOffice, browserInflate, textBytes } from "./file-formats.js";
import { cleanText, scanText, shieldSummary, summaryText } from "./shield.js";
import { DOCUMENT_ACCEPT, MAX_FILE_BYTES, documentKind, formatBytes } from "./documents.js";
import { chatTranscript } from "./study.js";
import {
  DEFAULT_SLIDES,
  LAYOUTS,
  LIMITS,
  MAX_PROMPT_CHARS,
  MAX_SLIDES,
  MAX_SOURCE_CHARS,
  MIN_SLIDES,
  THEMES,
  readDeck,
  readSlide,
  slidesText,
} from "./slides-spec.js";
import {
  LAYOUT_NAMES,
  THEME_NAMES,
  addBullet,
  blankSlide,
  canAddSlide,
  cleanName,
  convertSlide,
  countFromPrompt,
  deckHTML,
  deckPayload,
  deckRecord,
  mapDeckText,
  mapSlideText,
  moveSlide,
  newDeckFrom,
  removeBullet,
  setField,
  slidePayload,
  slideTree,
  slug,
  tidyDeck,
  tooShort,
  typed,
} from "./slides.js";
import { SLIDE_CSS, exportFontCSS } from "./slides-theme.js";
import { deleteLocalDeck, getLocalDeck, listLocalDecks, putLocalDeck } from "./slides-store.js";
import didotUrl from "@fontsource/gfs-didot/files/gfs-didot-latin-400-normal.woff2?url";
import neo400Url from "@fontsource/gfs-neohellenic/files/gfs-neohellenic-latin-400-normal.woff2?url";
import neo700Url from "@fontsource/gfs-neohellenic/files/gfs-neohellenic-latin-700-normal.woff2?url";
import "./slides.css";

// Slides: a deck from a prompt, a document or a saved chat, edited here,
// presented full screen and exported as a PDF (print) or one HTML file.
// Making a deck, and regenerating one slide, is one off-the-record chat
// request, billed like a message and held at exactly the maximum shown
// (server/slides.js). A deck is saved on the account (/api/slides), or, off
// the record or in Private Mode, only in this browser (src/slides-store.js).

const SOURCES = [
  ["prompt", "A prompt"],
  ["document", "A document"],
  ["chat", "A saved chat"],
];
const COUNTS = Array.from({ length: MAX_SLIDES - MIN_SLIDES + 1 }, (_, i) => i + MIN_SLIDES);
const PREVIEW_CHARS = 2400;
const MODEL_KEY = "slides:model";
const plural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const shortDate = (ms) => new Date(ms).toLocaleDateString("en-US");
const isLocalId = (id) => typeof id === "string" && id.startsWith("l_");
const veilKey = (id) => "slides:" + id;
const localId = () => "l_" + uid().replace(/-/g, "").slice(0, 20);
const hasMap = (state) => !!state && Object.keys(state.map || {}).length > 0;
const at = (o, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), o);

// PDF, Office and text files, read in this browser as Documents reads them.
async function readFile(file, officeOk) {
  const kind = documentKind(file);
  if (!kind || (kind === "office" && !officeOk)) throw Error(`"${file.name}" isn't a supported document type.`);
  if (file.size > MAX_FILE_BYTES) throw Error(`"${file.name}" is larger than ${formatBytes(MAX_FILE_BYTES)}.`);
  if (kind === "pdf") {
    const r = await pdfText(await file.arrayBuffer());
    if (!r.text) throw Error("No extractable text found — this PDF may be a scanned image.");
    return { name: file.name, text: r.text, pages: r.pages };
  }
  if (kind === "office") {
    const extension = file.name.split(".").at(-1).toLowerCase();
    const r = await extractOffice(await file.arrayBuffer(), extension, browserInflate);
    if (!r.text) throw Error(r.warning || "No text was extracted from this file.");
    return { name: file.name, text: r.text };
  }
  return { name: file.name, text: textBytes(new Uint8Array(await file.arrayBuffer())) };
}

// A hand-written deck, so the page can be tried with nothing sent or paid.
// It's the deck's own text (like a user's), so it comes in the page's
// language rather than being translated on screen.
function sampleDeck(lang = getLanguage()) {
  const s = (layout, fields) => ({ id: "s" + uid().replace(/-/g, "").slice(0, 12), layout, notes: "", ...fields });
  if (lang === "zh")
    return {
      title: "幻灯片如何工作",
      theme: "cobalt",
      slides: [
        s("title", { title: "幻灯片如何工作", subtitle: "一份手写的示例演示稿。上面的任何文字都可以修改。", notes: "点击幻灯片上的任意文字即可修改。" }),
        s("bullets", {
          title: "从来源到演示稿",
          bullets: ["从提示词、文档或已保存的会话开始", "选择幻灯片数量", "开始前先看到最多花费", "只有可用的演示稿才会扣费"],
          notes: "制作演示稿是一次不留记录的请求。",
        }),
        s("two-column", {
          title: "演示稿保存在哪里",
          left: { heading: "保存在你的账户中", bullets: ["在任何设备上打开", "紧急清除会将其删除"] },
          right: { heading: "不留记录", bullets: ["只保存在此浏览器中", "绝不存放在 ANONYMA 的服务器上"] },
        }),
        s("big-number", { title: "可选的版式", number: "6", label: "标题、章节、要点、双栏、引语和大数字" }),
        s("quote", { quote: "AI 也会出错，所以演示前请先通读一遍。", attribution: "本示例" }),
        s("section", { title: "演示或导出", subtitle: "带备注的全屏演示、PDF，或一个 HTML 文件" }),
      ],
    };
  return {
    title: "How Slides works",
    theme: "cobalt",
    slides: [
      s("title", { title: "How Slides works", subtitle: "A sample deck, written by hand. Edit anything on it.", notes: "Click any text on a slide to change it." }),
      s("bullets", {
        title: "From a source to a deck",
        bullets: ["Start from a prompt, a document or a saved chat", "Choose how many slides", "See the most it can cost before anything runs", "Only a usable deck is charged"],
        notes: "Making a deck is one off-the-record request.",
      }),
      s("two-column", {
        title: "Where a deck is kept",
        left: { heading: "On your account", bullets: ["Open it on any device", "Erased with Panic Wipe"] },
        right: { heading: "Off the record", bullets: ["Only in this browser", "Never on ANONYMA's servers"] },
      }),
      s("big-number", { title: "Layouts to choose from", number: "6", label: "Title, section, bullets, two columns, quote and big number" }),
      s("quote", { quote: "The AI can get things wrong, so read a deck before you present it.", attribution: "This sample" }),
      s("section", { title: "Present or export", subtitle: "Full screen with notes, a PDF, or one HTML file" }),
    ],
  };
}

// ---- Rendering a slide ----

// Plain text typed into a slide. The DOM holds the text while it's being
// edited (so the caret never jumps); it's written from `value` otherwise,
// always as text, never as HTML.
function Editable({ tag: Tag, className, field, value, placeholder, onCommit, onKey }) {
  const ref = useRef(null);
  const timer = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.textContent !== value) el.textContent = value;
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const commit = () => {
    clearTimeout(timer.current);
    onCommit(field, ref.current?.textContent || "");
  };
  return (
    <Tag
      ref={ref}
      className={className + " s-edit"}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      role="textbox"
      aria-label={placeholder}
      data-field={field}
      data-placeholder={placeholder}
      data-i18n="off"
      spellCheck
      onInput={() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(commit, 700);
      }}
      onBlur={commit}
      onKeyDown={(e) => onKey?.(e, field, ref.current, commit)}
    />
  );
}

function renderNode(n, key, ctx) {
  if (!n) return null;
  const { slide, show, editing } = ctx;
  if (n.field) {
    const text = show(at(slide, n.field) || "");
    if (editing)
      return (
        <Editable
          key={key}
          tag={n.tag}
          className={n.cls}
          field={n.field}
          value={text}
          placeholder={t(n.placeholder)}
          onCommit={ctx.onEdit}
          onKey={ctx.onKey}
        />
      );
    return React.createElement(n.tag, { key, className: n.cls, "data-i18n": "off" }, text);
  }
  if (n.deck) return React.createElement(n.tag, { key, className: n.cls, "data-i18n": "off" }, show(ctx.deckTitle || ""));
  if (n.text != null)
    return React.createElement(n.tag, { key, className: n.cls, "aria-hidden": n.decor || undefined }, n.text);
  const children = (n.children || []).map((c, i) => renderNode(c, i, ctx));
  if (n.list && editing && (at(slide, n.list) || []).length < LIMITS.bullets)
    children.push(
      <li key="add" className="s-add">
        <button type="button" onClick={() => ctx.onAddBullet(n.list)}>
          + Add a point
        </button>
      </li>,
    );
  return React.createElement(n.tag, { key, className: n.cls || undefined, "aria-hidden": n.decor || undefined }, children);
}

export function SlideFrame({ slide, show = (s) => s, theme = "cobalt", index = 0, total = 1, deckTitle = "", editing = false, onEdit, onKey, onAddBullet, className = "", hidden = false }) {
  const tree = slideTree(slide, { index, total, deckTitle, editing });
  return (
    <div className={`slide-frame theme-${theme} ${className}`} aria-hidden={hidden || undefined}>
      {renderNode(tree, "slide", { slide, show, editing, deckTitle, onEdit, onKey, onAddBullet })}
    </div>
  );
}
// The slide rules, once per page.
const SlideStyles = () => <style>{SLIDE_CSS}</style>;

// ---- The page ----

export default function Slides({ demo, user, models, config, refresh, veilOn, setVeilOn, veilWords }) {
  const [params, setParams] = useSearchParams();
  const account = demo ? "demo" : user?.id || "guest";
  const live = !demo && !!user;
  const deckParam = params.get("deck") || "";
  const [serverDecks, setServerDecks] = useState(null),
    [localDecks, setLocalDecks] = useState(null),
    [listError, setListError] = useState(""),
    [notice, setNotice] = useState(""),
    [open, setOpen] = useState(null),
    [opening, setOpening] = useState(false),
    [flash, setFlash] = useState(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // ---- The decks: on the account, and in this browser ----
  const loadLists = useCallback(async () => {
    setListError("");
    try {
      setLocalDecks(await listLocalDecks(account));
    } catch (e) {
      setLocalDecks([]);
      setListError(e?.message || "This browser can't store slide decks.");
    }
    if (!live) return setServerDecks([]);
    try {
      const r = await api("/api/slides");
      if (mounted.current) setServerDecks(r.data || []);
    } catch (e) {
      if (mounted.current) {
        setServerDecks([]);
        setListError(e?.message || "Your saved decks couldn't be loaded.");
      }
    }
  }, [account, live]);
  useEffect(() => {
    loadLists();
  }, [loadLists]);

  // ?deck= opens a deck, so a reload shows what was on screen.
  useEffect(() => {
    if (!deckParam) return setOpen(null);
    if (open?.id === deckParam) return;
    let stop = false;
    setOpening(true);
    (async () => {
      try {
        let entry;
        if (isLocalId(deckParam)) {
          const d = await getLocalDeck(account, deckParam);
          if (!d) throw Error("That deck isn't in this browser.");
          entry = { ...d, local: true };
        } else {
          if (!live) throw Error("Sign in to open your saved decks.");
          const d = await api("/api/slides/" + encodeURIComponent(deckParam));
          entry = { ...d, local: false };
        }
        if (!stop) setOpen(entry);
      } catch (e) {
        if (stop) return;
        setNotice(e?.message || "That deck couldn't be opened.");
        const next = new URLSearchParams(params);
        next.delete("deck");
        setParams(next, { replace: true });
      } finally {
        if (!stop) setOpening(false);
      }
    })();
    return () => {
      stop = true;
    };
  }, [deckParam, account, live]);

  const openDeck = (id, replace = false) => {
    setNotice("");
    const next = new URLSearchParams(params);
    next.delete("chat");
    next.set("deck", id);
    setParams(next, replace ? { replace: true } : undefined);
  };
  const closeDeck = () => {
    setFlash(null);
    const next = new URLSearchParams(params);
    next.delete("deck");
    setParams(next);
    setOpen(null);
    loadLists();
  };

  // A new deck from the form (or the sample): saved on the account, or in
  // this browser when made off the record or in Private Mode, or when the
  // account copy couldn't be saved (it's never lost once paid for).
  // `note` is what the page says once the deck opens: { made, charged }.
  async function keepDeck(deck, { local, privateDeck = false, state = null, note = null }) {
    const now = Date.now();
    let failed = "";
    if (!local && live) {
      try {
        const saved = await api("/api/slides", { method: "POST", body: deckRecord(deck) });
        if (hasMap(state)) saveVeilState(veilKey(saved.id), state);
        setFlash(note);
        setOpen({ ...saved, local: false });
        openDeck(saved.id);
        loadLists();
        return;
      } catch (e) {
        failed = e?.message || "The deck couldn't be saved to your account.";
      }
    }
    const id = localId();
    const entry = { id, ...deckRecord(deck), private: privateDeck, created: now, updated: now };
    let kept = true,
      localFailed = "";
    try {
      await putLocalDeck(account, entry);
    } catch (e) {
      kept = false;
      localFailed = e?.message || "This browser couldn't keep the deck.";
    }
    if (hasMap(state)) saveVeilState(veilKey(id), state);
    setFlash(note || failed || localFailed ? { ...note, failed, kept, localFailed } : null);
    setOpen({ ...entry, local: true });
    openDeck(id);
    loadLists();
  }

  if (deckParam)
    return (
      <section className="slides-page slides-editing">
        <SlideStyles />
        {notice && <Notice type="error">{notice}</Notice>}
        {flash && open?.id === deckParam && (
          <Notice>
            {/* Separate sentences, so each is translated on its own. */}
            <span className="slides-flash">
              {flash.made && <span>{flash.made}</span>}
              {flash.charged && <span>{flash.charged}</span>}
              {flash.failed && <span>{flash.failed}</span>}
              {flash.failed && flash.kept && <span>It's kept in this browser instead.</span>}
              {flash.localFailed && <span>{flash.localFailed}</span>}
              {flash.localFailed && <span>Export it before you leave this page.</span>}
            </span>
          </Notice>
        )}
        {open && open.id === deckParam ? (
          <DeckEditor
            key={open.id}
            entry={open}
            account={account}
            live={live}
            config={config}
            models={models}
            veilOn={veilOn}
            veilWords={veilWords}
            refresh={refresh}
            onClose={closeDeck}
          />
        ) : (
          <p className="slides-loading">{opening ? "Opening the slide deck…" : ""}</p>
        )}
      </section>
    );

  const all = [
    ...(serverDecks || []).map((d) => ({ ...d, local: false })),
    ...(localDecks || []).map((d) => ({ ...d, slide_count: d.slides?.length || 0, first: d.slides?.[0], local: true })),
  ].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const loaded = serverDecks !== null && localDecks !== null;
  return (
    <section className="slides-page">
      <SlideStyles />
      <div className="slides-head">
        <div>
          <p className="eyebrow">PRESENTATIONS</p>
          <h1>Slides</h1>
          <p>
            Turn a chat, a document or a prompt into a clean slide deck. Edit it here, present it full screen, or
            export it as a PDF or an HTML file.
          </p>
        </div>
      </div>
      {notice && <Notice>{notice}</Notice>}
      {listError && <Notice type="error">{listError}</Notice>}
      <div className="slides-grid">
        <MakeForm
          live={live}
          demo={demo}
          config={config}
          models={models}
          refresh={refresh}
          veilOn={veilOn}
          setVeilOn={setVeilOn}
          veilWords={veilWords}
          params={params}
          setParams={setParams}
          onMade={keepDeck}
        />
        <aside className="slides-decks">
          <div className="slides-decks-head">
            <h2>
              Your slide decks <span>{all.length}</span>
            </h2>
          </div>
          {!loaded ? (
            <p className="slides-empty">Opening your slide decks…</p>
          ) : !all.length ? (
            <div className="slides-empty">
              <p>No decks yet.</p>
              <button
                type="button"
                className="slides-secondary"
                onClick={() => keepDeck(sampleDeck(), { local: true })}
              >
                Try a sample slide deck
              </button>
              <small>The sample is written by hand, not by a model. It costs nothing and stays in this browser.</small>
            </div>
          ) : (
            <ul className="slides-deck-list">
              {all.map((d) => {
                const state = loadVeilState(veilKey(d.id));
                const show = hasMap(state) ? (s) => unveil(s, state.map) : (s) => s;
                return (
                  <li key={d.id}>
                    <button type="button" className="slides-deck-open" onClick={() => openDeck(d.id)}>
                      <span className="slides-deck-thumb">
                        {d.first && <SlideFrame slide={d.first} show={show} theme={d.theme} total={d.slide_count} deckTitle={d.title} hidden />}
                      </span>
                      <span className="slides-deck-text">
                        <b data-i18n="off">{show(d.title)}</b>
                        <small>
                          {plural(d.slide_count, "slide", "slides")} · {shortDate(d.updated)}
                        </small>
                        <span className="slides-tags">
                          {d.local ? (
                            <span className="slides-tag">{d.private ? "Private · this browser" : "This browser"}</span>
                          ) : (
                            <span className="slides-tag on">Saved</span>
                          )}
                          {hasMap(state) && <span className="slides-tag">Veiled</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="slides-fine">
            Saved decks are kept on your account with their text and speaker notes, and erased by Panic Wipe. Decks
            made off the record or in Private Mode stay in this browser only, unencrypted, like a downloaded file.
          </p>
        </aside>
      </div>
    </section>
  );
}

// ---- Making a deck ----

function MakeForm({ live, demo, config, models, refresh, veilOn, setVeilOn, veilWords, params, setParams, onMade }) {
  const [sourceKind, setSourceKind] = useState(params.get("chat") ? "chat" : "prompt"),
    [prompt, setPrompt] = useState(""),
    [doc, setDoc] = useState(null),
    [docBusy, setDocBusy] = useState(false),
    [chats, setChats] = useState(null),
    [chatId, setChatId] = useState(params.get("chat") || ""),
    [chat, setChat] = useState(null),
    [count, setCount] = useState(DEFAULT_SLIDES),
    [countSet, setCountSet] = useState(false),
    [theme, setTheme] = useState("cobalt"),
    [model, setModel] = useState(() => readStore(MODEL_KEY, "")),
    [privateOn, setPrivateOn] = useState(false),
    [offRecord, setOffRecord] = useState(false),
    [seedOk, setSeedOk] = useState(false),
    [formError, setFormError] = useState(""),
    [gen, setGen] = useState(null);
  const controller = useRef(null),
    mounted = useRef(true),
    fileInput = useRef(null),
    resultBox = useRef(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  // ---- Models, Veil, Private Mode ----
  const veilLive = isReleased(config, "veil");
  const veiling = veilLive && live && (veilOn || privateOn);
  const privateLive = privateModeReleased(config);
  const trailLive = isReleased(config, "trail");
  const offLive = isReleased(config, "ephemeral");
  const shieldOn = useShieldLive(config);
  const uncensored = config?.releases?.uncensoredModels || [];
  const choices = useMemo(
    () =>
      models.filter(
        (m) =>
          m.type === "chat" &&
          m.callable &&
          !m.imageCapable &&
          !m.sealed &&
          !uncensored.includes(m.id) &&
          (!privateOn || m.private),
      ),
    [models, privateOn, config],
  );
  useEffect(() => {
    setModel((prev) =>
      choices.some((m) => m.id === prev)
        ? prev
        : pickPreset(choices, "balanced", { mode: "chat" })?.id || choices[0]?.id || "",
    );
  }, [choices]);
  useEffect(() => {
    if (model) saveStore(MODEL_KEY, model);
  }, [model]);
  const modelName = (id) => models.find((m) => m.id === id)?.name || id;

  // ---- Sources ----
  const officeOk = isReleased(config, "files");
  async function openFile(file) {
    if (!file) return;
    setFormError("");
    setDocBusy(true);
    try {
      const read = await readFile(file, officeOk);
      if (mounted.current) setDoc(read);
    } catch (e) {
      if (mounted.current) setFormError(e?.message || "Could not read this file.");
    } finally {
      if (mounted.current) setDocBusy(false);
    }
  }
  useEffect(() => {
    if (!live || sourceKind !== "chat" || chats) return;
    api("/api/conversations")
      .then((r) => mounted.current && setChats(r.data || []))
      .catch(() => mounted.current && setChats([]));
  }, [live, sourceKind, chats]);
  useEffect(() => {
    if (!live || !chatId) return setChat(null);
    let stop = false;
    api("/api/conversations/" + encodeURIComponent(chatId))
      .then((c) => {
        if (stop) return;
        const text = chatTranscript((c.messages || []).map(messageFromServer));
        setChat({ id: c.id, name: cleanName(c.title, "Saved chat"), text });
      })
      .catch((e) => !stop && (setChat(null), setFormError(e?.message || "That chat couldn't be opened.")));
    return () => {
      stop = true;
    };
  }, [live, chatId]);
  // "10 slides on …" sets the count, until it's chosen by hand.
  useEffect(() => {
    if (sourceKind !== "prompt" || countSet) return;
    const n = countFromPrompt(prompt);
    if (n) setCount(n);
  }, [prompt, sourceKind, countSet]);
  const source =
    sourceKind === "prompt"
      ? { kind: "prompt", name: "Prompt", text: prompt }
      : sourceKind === "document"
        ? doc && { kind: "document", name: doc.name, text: doc.text }
        : chat && { kind: "chat", name: chat.name, text: chat.text };
  // Injection Shield: invisible characters come out of a document or chat;
  // it always goes as data (the server frames it). Checked here only.
  const shieldScan = useMemo(
    () => (shieldOn && source?.text && source.kind !== "prompt" ? scanText(source.text) : null),
    [shieldOn, source?.text, source?.kind],
  );
  const cleaned = useMemo(
    () => (source ? { ...source, text: shieldScan ? cleanText(source.text, shieldScan) : source.text } : null),
    [source?.kind, source?.name, source?.text, shieldScan],
  );
  // A saved chat's own Veil map: its placeholders stay as they are, and new
  // ones continue its numbering, so the deck restores with both.
  const baseVeil = () =>
    sourceKind === "chat" && chat ? structuredClone(loadVeilState(chat.id)) : createVeilState();
  const build = (state) => {
    let masked = 0;
    const mask = veiling
      ? (s) => {
          const r = veil(s, state, veilWords);
          masked += r.count;
          return r.text;
        }
      : (s) => s;
    const r = deckPayload(cleaned, count, mask);
    return { ...r, masked };
  };
  // What would be sent, masked with a copy of Veil's state (the real send
  // masks again with the same result).
  const built = useMemo(() => {
    if (!cleaned || tooShort(cleaned.kind, cleaned.text)) return null;
    const r = build(baseVeil());
    return { ...r, text: slidesText(r.payload) };
  }, [cleaned, count, veiling, veilWords, chat?.id]);
  const seedHit = useSeedScan(live && seedGuardLive(config), built?.text || "");
  useEffect(() => setSeedOk(false), [built?.text]);
  const seedBlocked = !!seedHit && !(isSoft(seedHit) && seedOk);
  const busy = gen?.status === "writing";
  const noPrivate = privateOn && !choices.length;
  const quoteBody = useMemo(
    () => (live && model && built && !seedBlocked && !busy ? { model, slides: built.payload } : null),
    [live, model, built, seedBlocked, busy],
  );
  const estimate = useCreditEstimate(quoteBody);
  const short = estimate.status === "ready" && estimate.available != null && estimate.credits > estimate.available;
  const limited = estimate.status === "ready" && !short && estimate.room != null && estimate.credits > estimate.room;
  const keepLocal = offRecord || privateOn;

  async function makeDeck(e) {
    e?.preventDefault();
    if (busy || !built || seedBlocked) return;
    if (!live) return setFormError("Sign in to make decks. The sample deck works without an account.");
    if (!model) return setFormError(privateOn ? "No private models are available right now." : "No callable chat model is available.");
    setFormError("");
    const state = baseVeil();
    const { payload, masked } = build(state);
    const ctl = new AbortController();
    controller.current = ctl;
    const started = { count, model, modelName: modelName(model), local: keepLocal, private: privateOn, masked };
    setGen({ status: "writing", ...started, progress: 0 });
    let text = "",
      receipt = null,
      failure = null;
    try {
      await streamChat(
        {
          slides: payload,
          model,
          ephemeral: true,
          requestId: uid(),
          ...(privateOn ? { private: true } : {}),
          ...(trailLive ? { veil_masked: veiling ? masked : null } : {}),
        },
        (event) => {
          if (Number.isInteger(event.slides?.started) && mounted.current)
            setGen((g) => (g?.status === "writing" ? { ...g, progress: event.slides.started } : g));
          const delta = event.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && text.length < 400000) text += delta;
          if (event.anonyma && Number.isFinite(event.anonyma.credits_charged)) receipt = event.anonyma;
          if (event.error) failure = event.error;
        },
        ctl.signal,
      );
      if (failure) throw Error(unveil(failure.message || "The model request failed.", state.map));
      const read = readDeck(text, { count, finishReason: receipt?.finish_reason ?? null });
      if (!read.deck) throw Error("The model's reply wasn't slides this page can read.");
      const deck = newDeckFrom(read.deck, { theme, fallbackTitle: cleanName(unveil(payload.source.name, state.map), "Untitled deck") });
      const charged = receipt?.credits_charged;
      const note = {
        made:
          read.dropped || deck.slides.length < count
            ? `Made ${plural(deck.slides.length, "slide", "slides")} of the ${count} asked for with ${started.modelName}.`
            : `Made ${plural(deck.slides.length, "slide", "slides")} with ${started.modelName}.`,
        charged: Number.isFinite(charged) ? `${formatCredits(charged)} credits charged.` : "",
      };
      setGen({ status: "done", ...started });
      await onMade(deck, { local: keepLocal, privateDeck: privateOn, state: veiling ? state : null, note });
    } catch (err) {
      const stopped = err.name === "AbortError";
      if (mounted.current)
        setGen({
          status: stopped ? "stopped" : "failed",
          ...started,
          error: stopped ? "Stopped. Nothing was made, and nothing was charged." : err.message,
        });
    } finally {
      if (controller.current === ctl) controller.current = null;
      refresh?.();
    }
  }
  useEffect(() => {
    resultBox.current?.scrollIntoView?.({ block: "nearest" });
  }, [gen?.status]);

  const shieldLine = shieldScan && !shieldSummary(shieldScan).clear ? summaryText(shieldSummary(shieldScan)) : "";
  return (
    <form className="slides-make" onSubmit={makeDeck}>
      <h2>Make a slide deck</h2>
      <div className="slides-tabs" role="tablist" aria-label="Slides source">
        {SOURCES.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={sourceKind === id}
            className={sourceKind === id ? "on" : ""}
            disabled={busy}
            onClick={() => {
              setSourceKind(id);
              setFormError("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {sourceKind === "prompt" && (
        <>
          <textarea
            className="slides-paste"
            rows={4}
            value={prompt}
            disabled={busy}
            maxLength={MAX_PROMPT_CHARS}
            data-i18n="off"
            aria-label="What the deck is about"
            placeholder={t("10 slides on how our onboarding works, for new customers…")}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <small className="slides-hint">
            From a prompt, the model writes from what it knows, so check facts before you present.
          </small>
        </>
      )}
      {sourceKind === "document" && (
        <div className="slides-source-box">
          <input
            ref={fileInput}
            type="file"
            hidden
            accept={officeOk ? DOCUMENT_ACCEPT : DOCUMENT_ACCEPT.replace(/,\.(docx|xlsx|pptx)/g, "")}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              openFile(file);
            }}
          />
          {doc ? (
            <div className="slides-source-file">
              <Icon name="file" size={18} />
              <span>
                <b data-i18n="off">{doc.name}</b>
                <small>
                  {plural(doc.text.length, "character", "characters")}
                  {doc.pages ? ` · ${plural(doc.pages, "page", "pages")}` : ""} · Read in this browser
                </small>
              </span>
              <button type="button" className="slides-secondary" disabled={busy || docBusy} onClick={() => fileInput.current?.click()}>
                Change
              </button>
            </div>
          ) : (
            <button type="button" className="slides-secondary" disabled={busy || docBusy} onClick={() => fileInput.current?.click()}>
              <Icon name="upload" size={15} />
              {docBusy ? "Reading…" : "Choose a file"}
            </button>
          )}
          <small>PDF, Word, text or Markdown. The text is read in this browser; the file isn't uploaded.</small>
        </div>
      )}
      {sourceKind === "chat" && (
        <div className="slides-source-box">
          {!live ? (
            <small>Sign in to make slides from your saved chats.</small>
          ) : chats === null ? (
            <small>Loading your saved chats…</small>
          ) : (
            <>
              <select
                value={chatId}
                disabled={busy}
                aria-label="Saved chat"
                onChange={(e) => {
                  setChatId(e.target.value);
                  setFormError("");
                  if (params.get("chat")) {
                    const next = new URLSearchParams(params);
                    next.delete("chat");
                    setParams(next, { replace: true });
                  }
                }}
              >
                <option value="">Choose a saved chat…</option>
                {chatId && !chats.some((c) => c.id === chatId) && chat && (
                  <option value={chatId} data-i18n="off">
                    {chat.name}
                  </option>
                )}
                {chats.map((c) => (
                  <option key={c.id} value={c.id} data-i18n="off">
                    {c.title || "Untitled chat"}
                  </option>
                ))}
              </select>
              {chat && (
                <small>
                  {plural(chat.text.length, "character", "characters")} from this chat: your messages, their attached
                  documents and the replies.
                </small>
              )}
              <small>
                Only chats saved on your account are listed. Off the record, Private Mode and Device Vault chats
                aren't.
              </small>
            </>
          )}
        </div>
      )}
      <div className="slides-options">
        <label className="slides-field">
          How many slides
          <select
            value={count}
            disabled={busy}
            onChange={(e) => {
              setCount(Number(e.target.value));
              setCountSet(true);
            }}
          >
            {COUNTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Theme</legend>
          <div className="slides-seg">
            {THEMES.map((id) => (
              <button key={id} type="button" className={theme === id ? "on" : ""} aria-pressed={theme === id} disabled={busy} onClick={() => setTheme(id)}>
                <i className={"slides-swatch " + id} aria-hidden="true" />
                {THEME_NAMES[id]}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="slides-controls">
        <label className="slides-field slides-model">
          Model
          <select value={model} disabled={busy || !choices.length} onChange={(e) => setModel(e.target.value)}>
            {choices.map((m) => (
              <option key={m.id} value={m.id} data-i18n="off">
                {m.name}
              </option>
            ))}
          </select>
        </label>
        {live && offLive && (
          <button
            type="button"
            className={"attachment-control web-toggle" + (keepLocal ? " on" : "")}
            aria-pressed={keepLocal}
            disabled={busy || privateOn}
            title={t("Off the record: the deck is kept in this browser only, never on ANONYMA's servers")}
            onClick={() => setOffRecord((v) => !v)}
          >
            <Icon name={keepLocal ? "eyeoff" : "eye"} size={17} />
            <span>Off the record</span>
          </button>
        )}
        {live && privateLive && (
          <PrivateModeToggle
            active={privateOn}
            disabled={busy}
            onToggle={() => {
              setPrivateOn((on) => !on);
              if (!privateOn && veilLive) setVeilOn(true);
            }}
          />
        )}
        {live && veilLive && (
          <VeilToggle
            on={veilOn || privateOn}
            onToggle={() => {
              if (!busy && !privateOn) setVeilOn((v) => !v);
            }}
          />
        )}
      </div>
      {noPrivate && <NoPrivateModelsNotice />}
      {keepLocal && (
        <p className="slides-hint">
          {privateOn
            ? "Private Mode: zero-data-retention models only, Veil on, and the deck is kept in this browser only."
            : "Off the record: the deck is kept in this browser only, never on ANONYMA's servers."}
        </p>
      )}
      {built && (
        <details className="slides-sees">
          <summary>
            What the AI sees <span>{plural(built.payload.source.text.length, "character", "characters")}</span>
          </summary>
          <p>
            This source and Slides' fixed instructions, nothing else: no other chats, memory, project or standing
            instructions.
            {built.masked ? ` Veil masked ${plural(built.masked, "detail", "details")}.` : ""}
          </p>
          <pre data-i18n="off">
            {built.text.length > PREVIEW_CHARS ? built.text.slice(0, PREVIEW_CHARS) + "\n…" : built.text}
          </pre>
        </details>
      )}
      {built?.cut && (
        <Notice>
          {sourceKind === "prompt"
            ? `Only the first ${MAX_PROMPT_CHARS.toLocaleString("en-US")} characters of the prompt are sent.`
            : `Only the first ${MAX_SOURCE_CHARS.toLocaleString("en-US")} of ${built.total.toLocaleString("en-US")} characters are sent. Use a shorter part to cover the rest.`}
        </Notice>
      )}
      {shieldLine && (
        <Notice>{`Injection Shield found ${shieldLine}. Invisible characters are removed, and the source is sent as data, not instructions.`}</Notice>
      )}
      {cleaned && cleaned.text.trim() && tooShort(cleaned.kind, cleaned.text) && (
        <Notice>{sourceKind === "prompt" ? "Say a little more about the deck you want." : "Add a few more sentences: the source is too short for slides."}</Notice>
      )}
      <SeedGuardNotice hit={seedHit} busy={busy} hardOverride={false} onProceed={() => setSeedOk(true)} />
      {formError && <Notice type="error">{formError}</Notice>}
      <div className="slides-send">
        {busy ? (
          <button type="button" className="slides-secondary" onClick={() => controller.current?.abort()}>
            <Icon name="stop" size={14} />
            Stop
          </button>
        ) : (
          <button type="submit" className="button" disabled={!live || !built || !model || noPrivate || seedBlocked}>
            Make slides
          </button>
        )}
        {quoteBody && estimate.status === "ready" && (
          <span
            className={"credit-estimate " + (short ? "short" : limited ? "limited" : "ready")}
            role="status"
            title={t("The most this deck can cost, and exactly what's held while it's made: the source and a full reply budget at the model's published rates. You're charged only for what's used, and nothing if the reply isn't usable slides.")}
          >
            <Icon name="coins" size={13} />
            {`Up to ${formatCredits(estimate.credits)} credits`}
            {short && <b> · over your balance</b>}
            {limited && <b> · over your spending limit</b>}
          </span>
        )}
        {quoteBody && estimate.status === "loading" && <span className="credit-estimate loading">Updating estimate…</span>}
        {quoteBody && estimate.status === "unavailable" && (
          <span className="credit-estimate unavailable" title={estimate.message}>
            Estimate unavailable
          </span>
        )}
      </div>
      {gen && (
        <div ref={resultBox}>
          <Result gen={gen} />
        </div>
      )}
      <p className="slides-fine">
        Made off the record: billed like a message, and the request itself isn't saved. Only a reply that reads as
        slides is charged. The AI can get things wrong, so read the deck before you present it.
        {demo ? " Sign in to make decks." : ""}
      </p>
    </form>
  );
}

function Result({ gen }) {
  if (gen.status === "writing")
    return (
      <div className="slides-result" role="status">
        <span className="slides-spinner" aria-hidden="true" />
        <span>
          <b>
            {gen.progress
              ? `Writing slide ${Math.min(gen.progress, gen.count)} of ${gen.count}…`
              : `Writing ${plural(gen.count, "slide", "slides")} with ${gen.modelName}…`}
          </b>
          <small>The deck appears once it's complete and reads as slides.</small>
        </span>
      </div>
    );
  if (gen.status === "done")
    return (
      <div className="slides-result" role="status">
        <Icon name="check" size={18} />
        <span>
          <b>Opening the deck…</b>
        </span>
      </div>
    );
  return (
    <div className={"slides-result " + (gen.status === "failed" ? "failed" : "")} role={gen.status === "failed" ? "alert" : "status"}>
      <Icon name={gen.status === "failed" ? "warning" : "stop"} size={18} />
      <span>
        <b>{gen.status === "failed" ? "No slides were made." : "Stopped."}</b>
        <small>{gen.error}</small>
      </span>
    </div>
  );
}

// ---- Editing a deck ----

function DeckEditor({ entry, account, live, config, models, veilOn, veilWords, refresh, onClose }) {
  const [deck, setDeck] = useState(() => ({ title: entry.title, theme: entry.theme, slides: entry.slides })),
    [current, setCurrent] = useState(0),
    [status, setStatus] = useState({ state: "saved" }),
    [titleDraft, setTitleDraft] = useState(null),
    [present, setPresent] = useState(null),
    [printing, setPrinting] = useState(false),
    [menu, setMenu] = useState(false),
    [regen, setRegen] = useState(false),
    [undo, setUndo] = useState(null),
    [message, setMessage] = useState("");
  const key = veilKey(entry.id);
  // This deck's Veil map, kept only in this browser. A deck made with Veil
  // stores placeholders (on the account or here) and shows the values.
  const veilState = useRef(loadVeilState(key));
  const privateDeck = entry.private === true;
  const veilLive = isReleased(config, "veil");
  const masking = () => veilLive && (veilOn || privateDeck || hasMap(veilState.current));
  const show = useCallback((s) => (hasMap(veilState.current) ? unveil(s, veilState.current.map) : s), [deck]);
  const store = (s) => {
    if (!s || !masking()) return s;
    const r = veil(s, veilState.current, veilWords);
    if (r.count) saveVeilState(key, veilState.current);
    return r.text;
  };
  const total = deck.slides.length;
  const index = Math.min(current, total - 1);
  const slide = deck.slides[index];

  // ---- Autosave ----
  const first = useRef(true);
  const saveTimer = useRef(null);
  const latest = useRef(deck);
  latest.current = deck;
  const save = useCallback(async () => {
    const d = latest.current;
    setStatus({ state: "saving" });
    try {
      if (entry.local) {
        await putLocalDeck(account, {
          id: entry.id,
          ...deckRecord(d),
          slides: tidyDeck(d).slides,
          private: privateDeck,
          created: entry.created,
          updated: Date.now(),
        });
      } else await api("/api/slides/" + encodeURIComponent(entry.id), { method: "PATCH", body: deckRecord(d) });
      setStatus({ state: "saved" });
    } catch (e) {
      setStatus({ state: "error", message: e?.message || "The deck couldn't be saved." });
    }
  }, [entry.id, entry.local, account]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setStatus({ state: "pending" });
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, 900);
  }, [deck]);
  // Leaving flushes an edit still waiting to be saved.
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        save();
      }
    },
    [],
  );
  const change = (fn) => setDeck((d) => ({ ...d, slides: d.slides.map((s, i) => (i === index ? fn(s) : s)) }));

  // ---- Editing text on the slide ----
  const onEdit = (field, text) => {
    const next = store(typed(text, /bullets\.\d+$/.test(field) ? "bullet" : field.split(".").at(-1)));
    if ((at(slide, field) || "") === next) return;
    change((s) => setField(s, field, next));
  };
  const focusField = (field) =>
    requestAnimationFrame(() => {
      const el = document.querySelector(`.slides-stage [data-field="${field}"]`);
      if (!el) return;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
  const onKey = (e, field, el, commit) => {
    const bullet = /^(.*bullets)\.(\d+)$/.exec(field);
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
      if (bullet && (at(slide, bullet[1]) || []).length < LIMITS.bullets) {
        const i = Number(bullet[2]);
        change((s) => addBullet(s, bullet[1], i));
        focusField(`${bullet[1]}.${i + 1}`);
      } else el?.blur();
    } else if (e.key === "Backspace" && bullet && !el?.textContent) {
      e.preventDefault();
      const i = Number(bullet[2]);
      change((s) => removeBullet(s, bullet[1], i));
      if (i > 0) focusField(`${bullet[1]}.${i - 1}`);
    } else if (e.key === "Escape") el?.blur();
  };
  const onAddBullet = (list) => {
    const n = (at(slide, list) || []).length;
    change((s) => addBullet(s, list));
    focusField(`${list}.${n}`);
  };

  // ---- Slides: order, layout, add, delete ----
  const move = (to) => {
    setDeck((d) => ({ ...d, slides: moveSlide(d.slides, index, to) }));
    setCurrent(to);
  };
  const addSlide = () => {
    if (!canAddSlide(deck.slides)) return;
    setDeck((d) => {
      const slides = [...d.slides];
      slides.splice(index + 1, 0, blankSlide("bullets"));
      return { ...d, slides };
    });
    setCurrent(index + 1);
  };
  const deleteSlide = () => {
    if (total <= 1) return;
    setUndo({ kind: "delete", index, slide });
    setDeck((d) => ({ ...d, slides: d.slides.filter((_, i) => i !== index) }));
    setCurrent(Math.max(0, index - 1));
  };
  async function deleteDeck() {
    if (!window.confirm(t(entry.local ? "Delete this deck from this browser? This can't be undone." : "Delete this deck from your account? This can't be undone.")))
      return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    try {
      if (entry.local) await deleteLocalDeck(account, entry.id);
      else await api("/api/slides/" + encodeURIComponent(entry.id), { method: "DELETE" });
      try {
        localStorage.removeItem("anonyma:veil:state:" + key);
      } catch {}
      onClose();
    } catch (e) {
      setMessage(e?.message || "The slide deck couldn't be deleted.");
    }
  }

  // The export menu closes on a click anywhere else, or Escape.
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e) => !menuRef.current?.contains(e.target) && setMenu(false);
    const esc = (e) => e.key === "Escape" && setMenu(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  // ---- Export ----
  const shownDeck = () => mapDeckText(tidyDeck(deck), show);
  async function exportHTML() {
    setMenu(false);
    const fonts = {};
    await Promise.all(
      Object.entries({ didot: didotUrl, neo400: neo400Url, neo700: neo700Url }).map(async ([k, url]) => {
        try {
          const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
          let bin = "";
          for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
          fonts[k] = "data:font/woff2;base64," + btoa(bin);
        } catch {}
      }),
    );
    const d = shownDeck();
    const html = deckHTML(d, {
      slideCSS: SLIDE_CSS,
      fontCSS: exportFontCSS(fonts),
      lang: getLanguage(),
      labels: {
        count: t(plural(d.slides.length, "slide", "slides")),
        help: t("arrows to move, P to present, Esc to stop"),
        present: t("Present"),
        notes: t("Notes"),
      },
    });
    download(slug(d.title) + ".html", html, "text/html;charset=utf-8");
  }

  const statusText =
    status.state === "saving" || status.state === "pending"
      ? "Saving…"
      : status.state === "error"
        ? "Not saved"
        : entry.local
          ? "Saved in this browser"
          : "Saved";
  return (
    <div className="slides-editor">
      <div className="slides-bar">
        <button type="button" className="slides-secondary" onClick={onClose}>
          <Icon name="arrow" size={14} className="slides-back" />
          Slide decks
        </button>
        <input
          className="slides-title-input"
          aria-label="Deck title"
          data-i18n="off"
          maxLength={LIMITS.deckTitle}
          value={titleDraft ?? show(deck.title)}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={() => {
            if (titleDraft == null) return;
            const next = store(typed(titleDraft, "deckTitle")) || deck.title;
            setTitleDraft(null);
            if (next !== deck.title) setDeck((d) => ({ ...d, title: next }));
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <span className={"slides-status " + status.state} title={status.message || ""} role="status">
          {status.state === "error" ? <Icon name="warning" size={14} /> : <Icon name={entry.local ? "drive" : "check"} size={14} />}
          {statusText}
        </span>
        <div className="slides-seg slides-theme" role="group" aria-label="Theme">
          {THEMES.map((id) => (
            <button key={id} type="button" className={deck.theme === id ? "on" : ""} aria-pressed={deck.theme === id} onClick={() => setDeck((d) => ({ ...d, theme: id }))}>
              <i className={"slides-swatch " + id} aria-hidden="true" />
              {THEME_NAMES[id]}
            </button>
          ))}
        </div>
        <div className="slides-bar-actions">
          <button type="button" className="button slides-present-open" onClick={() => setPresent(index)}>
            <Icon name="present" size={15} />
            Present
          </button>
          <div className="slides-menu" ref={menuRef}>
            <button type="button" className="slides-secondary" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
              <Icon name="download" size={14} />
              Export
            </button>
            {menu && (
              <div className="slides-menu-list" role="menu">
                <button type="button" role="menuitem" onClick={() => (setMenu(false), setPrinting(true))}>
                  <Icon name="printer" size={14} />
                  PDF (print, one slide per page)
                </button>
                <button type="button" role="menuitem" onClick={exportHTML}>
                  <Icon name="file" size={14} />
                  HTML file (works offline)
                </button>
              </div>
            )}
          </div>
          <button type="button" className="slides-secondary danger" aria-label="Delete this deck" title={t("Delete this deck")} onClick={deleteDeck}>
            <Icon name="delete" size={14} />
          </button>
        </div>
      </div>
      {status.state === "error" && <Notice type="error">{`Not saved: ${status.message}`}</Notice>}
      {message && <Notice type="error">{message}</Notice>}
      {undo && (
        <div className="slides-undo" role="status">
          <span>{undo.kind === "delete" ? `Slide ${undo.index + 1} deleted.` : `Slide ${undo.index + 1} regenerated.`}</span>
          <button
            type="button"
            className="slides-link"
            onClick={() => {
              setDeck((d) => {
                const slides = [...d.slides];
                if (undo.kind === "delete") slides.splice(undo.index, 0, undo.slide);
                else slides[undo.index] = undo.slide;
                return { ...d, slides };
              });
              setCurrent(undo.index);
              setUndo(null);
            }}
          >
            Undo
          </button>
          <button type="button" className="slides-link" onClick={() => setUndo(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div className="slides-workarea">
        <ol className="slides-rail" aria-label="Slides">
          {deck.slides.map((s, i) => (
            <li key={s.id}>
              <button type="button" className={"slides-thumb" + (i === index ? " on" : "")} aria-current={i === index} aria-label={t(`Slide ${i + 1}`)} onClick={() => setCurrent(i)}>
                <span className="slides-thumb-num">{i + 1}</span>
                <SlideFrame slide={s} show={show} theme={deck.theme} index={i} total={total} deckTitle={deck.title} hidden />
              </button>
            </li>
          ))}
          {canAddSlide(deck.slides) && (
            <li>
              <button type="button" className="slides-thumb-add" onClick={addSlide}>
                <Icon name="plus" size={16} />
                <span>Add slide</span>
              </button>
            </li>
          )}
        </ol>
        <div className="slides-main">
          <div className="slides-stage">
            <SlideFrame
              key={slide.id}
              slide={slide}
              show={show}
              theme={deck.theme}
              index={index}
              total={total}
              deckTitle={deck.title}
              editing
              onEdit={onEdit}
              onKey={onKey}
              onAddBullet={onAddBullet}
            />
          </div>
          <div className="slides-tools">
            <label className="slides-field slides-layout">
              Layout
              <select value={slide.layout} onChange={(e) => change((s) => convertSlide(s, e.target.value))}>
                {LAYOUTS.map((l) => (
                  <option key={l} value={l}>
                    {LAYOUT_NAMES[l]}
                  </option>
                ))}
              </select>
            </label>
            <span className="slides-tool-group">
              <button type="button" className="slides-icon" aria-label="Move slide up" title={t("Move slide up")} disabled={index === 0} onClick={() => move(index - 1)}>
                <Icon name="up" size={15} />
              </button>
              <button type="button" className="slides-icon" aria-label="Move slide down" title={t("Move slide down")} disabled={index === total - 1} onClick={() => move(index + 1)}>
                <Icon name="down" size={15} />
              </button>
              <button type="button" className="slides-icon" aria-label="Delete slide" title={t("Delete slide")} disabled={total <= 1} onClick={deleteSlide}>
                <Icon name="delete" size={15} />
              </button>
            </span>
            <button type="button" className="slides-secondary" disabled={!canAddSlide(deck.slides)} onClick={addSlide}>
              <Icon name="plus" size={14} />
              Add slide
            </button>
            {live && (
              <button type="button" className={"slides-secondary slides-regen-open" + (regen ? " on" : "")} aria-expanded={regen} onClick={() => setRegen((v) => !v)}>
                <Icon name="refresh" size={14} />
                Regenerate this slide
              </button>
            )}
          </div>
          {regen && live && (
            <RegeneratePanel
              key={slide.id}
              deck={deck}
              index={index}
              config={config}
              models={models}
              privateDeck={privateDeck}
              veiling={veilLive && (veilOn || privateDeck || hasMap(veilState.current))}
              veilState={veilState}
              veilKey={key}
              veilWords={veilWords}
              refresh={refresh}
              onClose={() => setRegen(false)}
              onDone={(next) => {
                setUndo({ kind: "regen", index, slide });
                change(() => ({ ...next, id: slide.id }));
              }}
            />
          )}
          <label className="slides-notes">
            <span>Speaker notes</span>
            <NotesField key={slide.id} value={show(slide.notes || "")} onCommit={(v) => change((s) => ({ ...s, notes: store(typed(v, "notes")) }))} />
          </label>
          <p className="slides-fine">
            {entry.local
              ? "This deck is kept in this browser only. Edits save as you go."
              : "Edits save to your account as you go."}
            {hasMap(veilState.current) ? " Veil's placeholders are shown with their values in this browser only." : ""}
          </p>
        </div>
      </div>
      {present != null && <Presenter deck={deck} show={show} start={present} onClose={() => setPresent(null)} />}
      {printing && <PrintView deck={deck} show={show} onClose={() => setPrinting(false)} />}
    </div>
  );
}

function NotesField({ value, onCommit }) {
  const [draft, setDraft] = useState(value);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <textarea
      rows={3}
      value={draft}
      data-i18n="off"
      maxLength={LIMITS.notes}
      placeholder={t("What to say on this slide")}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => onCommit(v), 700);
      }}
      onBlur={() => {
        clearTimeout(timer.current);
        onCommit(draft);
      }}
    />
  );
}

// ---- Regenerate one slide ----

function RegeneratePanel({ deck, index, config, models, privateDeck, veiling, veilState, veilKey: key, veilWords, refresh, onClose, onDone }) {
  const [instruction, setInstruction] = useState(""),
    [model, setModel] = useState(() => readStore(MODEL_KEY, "")),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  const trailLive = isReleased(config, "trail");
  const uncensored = config?.releases?.uncensoredModels || [];
  const choices = useMemo(
    () =>
      models.filter(
        (m) => m.type === "chat" && m.callable && !m.imageCapable && !m.sealed && !uncensored.includes(m.id) && (!privateDeck || m.private),
      ),
    [models, privateDeck, config],
  );
  useEffect(() => {
    setModel((prev) => (choices.some((m) => m.id === prev) ? prev : pickPreset(choices, "balanced", { mode: "chat" })?.id || choices[0]?.id || ""));
  }, [choices]);
  // The deck's text as sent: masked with (a copy of) its Veil state.
  const build = (state) => {
    let masked = 0;
    const mask = veiling
      ? (s) => {
          const r = veil(s, state, veilWords);
          masked += r.count;
          return r.text;
        }
      : (s) => s;
    const d = mapDeckText(tidyDeck(deck), mask);
    // A slide emptied by editing still goes as it is.
    d.slides[index] = mapSlideText(deck.slides[index], mask);
    return { payload: slidePayload(d, index, instruction), masked };
  };
  const preview = useMemo(() => build(structuredClone(veilState.current)), [deck, index, instruction, veiling, veilWords]);
  const quoteBody = useMemo(() => (model && !busy ? { model, slides: preview.payload } : null), [model, busy, preview]);
  const estimate = useCreditEstimate(quoteBody);
  const short = estimate.status === "ready" && estimate.available != null && estimate.credits > estimate.available;
  const limited = estimate.status === "ready" && !short && estimate.room != null && estimate.credits > estimate.room;

  async function run(e) {
    e?.preventDefault();
    if (busy || !model) return;
    setError("");
    setBusy(true);
    const state = veilState.current;
    const { payload, masked } = build(state);
    if (hasMap(state)) saveVeilState(key, state);
    const ctl = new AbortController();
    controller.current = ctl;
    let text = "",
      receipt = null,
      failure = null;
    try {
      await streamChat(
        {
          slides: payload,
          model,
          ephemeral: true,
          requestId: uid(),
          ...(privateDeck ? { private: true } : {}),
          ...(trailLive ? { veil_masked: veiling ? masked : null } : {}),
        },
        (event) => {
          const delta = event.choices?.[0]?.delta?.content;
          if (typeof delta === "string") text += delta;
          if (event.anonyma && Number.isFinite(event.anonyma.credits_charged)) receipt = event.anonyma;
          if (event.error) failure = event.error;
        },
        ctl.signal,
      );
      if (failure) throw Error(unveil(failure.message || "The model request failed.", state.map));
      const read = readSlide(text, { layout: payload.slide.layout, finishReason: receipt?.finish_reason ?? null });
      if (!read.slide) throw Error("The model's reply wasn't a slide this page can read.");
      onDone(read.slide);
      onClose();
    } catch (err) {
      setError(err.name === "AbortError" ? "Stopped. The slide wasn't changed, and nothing was charged." : err.message);
    } finally {
      if (controller.current === ctl) controller.current = null;
      setBusy(false);
      refresh?.();
    }
  }
  return (
    <form className="slides-regen" onSubmit={run}>
      <div className="slides-regen-row">
        <label className="slides-field slides-regen-ask">
          {`Regenerate slide ${index + 1}`}
          <input
            value={instruction}
            maxLength={LIMITS.instruction}
            disabled={busy}
            data-i18n="off"
            placeholder={t("Optional: shorter, more formal, turn into two columns…")}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </label>
        <label className="slides-field slides-model">
          Model
          <select value={model} disabled={busy || !choices.length} onChange={(e) => setModel(e.target.value)}>
            {choices.map((m) => (
              <option key={m.id} value={m.id} data-i18n="off">
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="slides-hint">
        The AI sees this deck's title, its slide titles and this slide, not the original source, so it can't add
        facts from it.{preview.masked ? ` Veil masked ${plural(preview.masked, "detail", "details")}.` : ""}
        {privateDeck ? " Private Mode: zero-data-retention models only." : ""}
      </p>
      {privateDeck && !choices.length && <NoPrivateModelsNotice />}
      {error && <Notice type="error">{error}</Notice>}
      <div className="slides-send">
        {busy ? (
          <button type="button" className="slides-secondary" onClick={() => controller.current?.abort()}>
            <Icon name="stop" size={14} />
            Stop
          </button>
        ) : (
          <button type="submit" className="button" disabled={!model}>
            Regenerate
          </button>
        )}
        <button type="button" className="slides-link" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        {busy && <span className="credit-estimate loading">Rewriting the slide…</span>}
        {!busy && estimate.status === "ready" && (
          <span className={"credit-estimate " + (short ? "short" : limited ? "limited" : "ready")} role="status">
            <Icon name="coins" size={13} />
            {`Up to ${formatCredits(estimate.credits)} credits`}
            {short && <b> · over your balance</b>}
            {limited && <b> · over your spending limit</b>}
          </span>
        )}
        {!busy && estimate.status === "loading" && <span className="credit-estimate loading">Updating estimate…</span>}
        {!busy && estimate.status === "unavailable" && (
          <span className="credit-estimate unavailable" title={estimate.message}>
            Estimate unavailable
          </span>
        )}
      </div>
    </form>
  );
}

// ---- Present ----

function Presenter({ deck, show, start, onClose }) {
  const slides = tidyDeck(deck).slides;
  const [i, setI] = useState(Math.min(start, slides.length - 1));
  const [notesError, setNotesError] = useState("");
  const root = useRef(null),
    notesWin = useRef(null),
    entered = useRef(false);
  const go = (n) => setI(Math.max(0, Math.min(slides.length - 1, n)));
  useEffect(() => {
    const el = root.current;
    el?.focus();
    const full = el?.requestFullscreen?.();
    if (full) full.then(() => (entered.current = true)).catch(() => {});
    const onFull = () => {
      if (!document.fullscreenElement && entered.current) onClose();
    };
    document.addEventListener("fullscreenchange", onFull);
    return () => {
      document.removeEventListener("fullscreenchange", onFull);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      try {
        notesWin.current?.close();
      } catch {}
    };
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) {
        e.preventDefault();
        setI((n) => Math.min(slides.length - 1, n + 1));
      } else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) {
        e.preventDefault();
        setI((n) => Math.max(0, n - 1));
      } else if (e.key === "Home") setI(0);
      else if (e.key === "End") setI(slides.length - 1);
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slides.length]);
  // Speaker notes in a second window, written as text from this page.
  const writeNotes = () => {
    const w = notesWin.current;
    if (!w || w.closed) return;
    const d = w.document;
    const s = slides[i];
    const next = slides[i + 1];
    d.title = t("Speaker notes") + " · " + show(deck.title);
    d.body.textContent = "";
    Object.assign(d.body.style, { margin: "0", padding: "28px", font: "16px/1.5 system-ui, sans-serif", background: "#fff", color: "#18233f" });
    const add = (tag, text, style) => {
      const el = d.createElement(tag);
      el.textContent = text;
      Object.assign(el.style, style || {});
      d.body.append(el);
    };
    add("p", `${i + 1} / ${slides.length}`, { margin: "0 0 6px", color: "#0135df", fontWeight: "700", letterSpacing: ".04em" });
    add("h1", show(s.title || s.quote || s.number || ""), { margin: "0 0 18px", fontSize: "24px", lineHeight: "1.2" });
    add("p", show(s.notes || "") || t("No notes for this slide."), { margin: "0 0 24px", fontSize: "20px", whiteSpace: "pre-wrap" });
    if (next) add("p", t("Next") + ": " + show(next.title || next.quote || next.number || ""), { margin: "0", color: "#606a80", borderTop: "1px solid #e2e6ee", paddingTop: "14px" });
  };
  useEffect(writeNotes, [i]);
  const openNotes = () => {
    setNotesError("");
    const w = window.open("", "anonyma-slides-notes", "popup,width=560,height=680");
    if (!w) return setNotesError("Your browser blocked the notes window. Allow pop-ups for this site to open it.");
    notesWin.current = w;
    writeNotes();
  };
  const s = slides[i];
  return createPortal(
    <div className="slides-present" ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("Presenting")}>
      <div className="slides-present-stage" onClick={() => go(i + 1)}>
        <SlideFrame slide={s} show={show} theme={deck.theme} index={i} total={slides.length} deckTitle={deck.title} />
      </div>
      <div className="slides-present-bar">
        <button type="button" aria-label="Previous slide" disabled={i === 0} onClick={() => go(i - 1)}>
          <Icon name="arrow" size={15} className="slides-back" />
        </button>
        <span>{`${i + 1} / ${slides.length}`}</span>
        <button type="button" aria-label="Next slide" disabled={i === slides.length - 1} onClick={() => go(i + 1)}>
          <Icon name="arrow" size={15} />
        </button>
        <button type="button" onClick={openNotes}>
          Speaker notes
        </button>
        <button type="button" onClick={onClose}>
          Exit
        </button>
        {notesError && <em>{notesError}</em>}
      </div>
    </div>,
    document.body,
  );
}

// ---- Print (PDF) ----

function PrintView({ deck, show, onClose }) {
  const slides = tidyDeck(deck).slides;
  const printButton = useRef(null);
  useEffect(() => {
    document.documentElement.classList.add("slides-printing");
    printButton.current?.focus();
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.documentElement.classList.remove("slides-printing");
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return createPortal(
    <div className="slides-print-root" role="dialog" aria-modal="true" aria-label={t("Print view")}>
      <style>{SLIDE_CSS}</style>
      <div className="slides-print-toolbar">
        <button type="button" className="slides-secondary" onClick={onClose}>
          Back
        </button>
        <span>{`${plural(slides.length, "page", "pages")}, one slide each. In the print dialog, choose Save as PDF.`}</span>
        <button ref={printButton} type="button" className="button" onClick={() => window.print()}>
          Print or save as PDF
        </button>
      </div>
      <div className="slides-print-pages">
        {slides.map((s, i) => (
          <div className="slides-print-page" key={s.id}>
            <SlideFrame slide={s} show={show} theme={deck.theme} index={i} total={slides.length} deckTitle={deck.title} />
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
