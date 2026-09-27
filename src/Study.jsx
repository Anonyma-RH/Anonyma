import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { t } from "./i18n.js";
import { Icon, Notice } from "./ui.jsx";
import { api, download, isReleased, messageFromServer, streamChat, uid } from "./lib.js";
import { createVeilState, loadVeilState, veil } from "./veil.js";
import { VeilToggle } from "./Veil.jsx";
import { PrivateModeToggle, NoPrivateModelsNotice, privateModeReleased } from "./PrivateMode.jsx";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import { useShieldLive } from "./Shield.jsx";
import { useCreditEstimate } from "./CreditEstimate.jsx";
import { ReplyMarkdown, MathText, diagramsReleased } from "./RichMarkdown.jsx";
import { formatCredits } from "./estimate.js";
import { pickPreset } from "./model-finder.js";
import { pdfText } from "./pdf-text.js";
import { extractOffice, browserInflate, textBytes } from "./file-formats.js";
import { cleanText, scanText, shieldSummary, summaryText } from "./shield.js";
import { DOCUMENT_ACCEPT, MAX_FILE_BYTES, documentKind, formatBytes } from "./documents.js";
import { MAX_SOURCE_CHARS, STUDY_COUNTS, studyText } from "./study-spec.js";
import {
  GRADES,
  MAX_IMPORT_BYTES,
  NEW_PER_SESSION,
  TRUNCATED_MESSAGE,
  UNREADABLE_MESSAGE,
  chatTranscript,
  cleanName,
  deckCSV,
  deckCounts,
  exportDeck,
  formatInterval,
  importDeck,
  logReview,
  newDeck,
  nextDue,
  nextIntervals,
  quizScore,
  readDeck,
  restoreDeck,
  reviewQueue,
  reviewedToday,
  sampleDeck,
  schedule,
  streak,
  streamedCount,
  studyPayload,
  totalCounts,
  tooShort,
  withQuizResult,
} from "./study.js";
import { deleteAllDecks, deleteDeck, listDecks, loadLog, putDeck, saveLog } from "./study-store.js";
import "./study.css";

// Study Mode: flashcards and a quiz from a document, a saved chat or pasted
// text, reviewed with spaced repetition. Decks and progress are kept only in
// this browser (src/study-store.js). Making a deck is one off-the-record chat
// request, billed like a message (server/study.js); nothing else is sent.

const MAKES = [
  ["cards", "Flashcards"],
  ["quiz", "Quiz"],
  ["both", "Both"],
];
const LEVELS = [
  ["easy", "Easy"],
  ["medium", "Medium"],
  ["hard", "Hard"],
];
const SOURCES = [
  ["text", "Paste text"],
  ["document", "A document"],
  ["chat", "A saved chat"],
];
const GRADE_LABELS = { again: "Again", hard: "Hard", good: "Good", easy: "Easy" };
const KIND_LABELS = { text: "Pasted text", document: "Document", chat: "Saved chat" };
const PREVIEW_CHARS = 2400;
const REPEATS = 3;
const shortDate = (ms) => new Date(ms).toLocaleDateString("en-US");
const plural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const slug = (s) =>
  String(s || "deck")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "deck";
// Cards are the model's text: rendered with the shared reply renderer, but
// never loading an image or following a link from inside a card.
const CARD_MARKDOWN = {
  img: ({ alt }) => (alt ? <span className="study-md-image">[{alt}]</span> : null),
  a: ({ children }) => <span>{children}</span>,
};
function CardText({ text }) {
  return (
    <div className="study-md" data-i18n="off">
      <ReplyMarkdown components={CARD_MARKDOWN}>{text}</ReplyMarkdown>
    </div>
  );
}

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

export default function Study({ demo, user, models, config, refresh, veilOn, setVeilOn, veilWords }) {
  const [params, setParams] = useSearchParams();
  const account = demo ? "demo" : user?.id || "guest";
  const live = !demo && !!user;
  const [decks, setDecks] = useState([]),
    [log, setLog] = useState({ days: {} }),
    [storeError, setStoreError] = useState(""),
    [loaded, setLoaded] = useState(false),
    [view, setView] = useState({ name: "home" }),
    [notice, setNotice] = useState("");
  // The form
  const [sourceKind, setSourceKind] = useState(params.get("chat") ? "chat" : "text"),
    [pasted, setPasted] = useState(""),
    [doc, setDoc] = useState(null),
    [docBusy, setDocBusy] = useState(false),
    [chats, setChats] = useState(null),
    [chatId, setChatId] = useState(params.get("chat") || ""),
    [chat, setChat] = useState(null),
    [make, setMake] = useState("both"),
    [count, setCount] = useState(20),
    [level, setLevel] = useState("medium"),
    [model, setModel] = useState(""),
    [privateOn, setPrivateOn] = useState(false),
    [formError, setFormError] = useState(""),
    [gen, setGen] = useState(null);
  const controller = useRef(null),
    // The latest decks and review log, so quick successive grades build on
    // each other rather than on a stale render.
    decksRef = useRef([]),
    logRef = useRef({ days: {} }),
    mounted = useRef(true),
    fileInput = useRef(null),
    importInput = useRef(null),
    resultBox = useRef(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  // ---- This browser's decks ----
  useEffect(() => {
    let stop = false;
    setLoaded(false);
    Promise.all([listDecks(account), loadLog(account)])
      .then(([list, l]) => {
        if (stop) return;
        decksRef.current = list;
        logRef.current = l;
        setDecks(list);
        setLog(l);
        setStoreError("");
      })
      .catch((e) => !stop && setStoreError(e?.message || "This browser can't store decks."))
      .finally(() => !stop && setLoaded(true));
    return () => {
      stop = true;
    };
  }, [account]);
  const setAll = (list) => {
    decksRef.current = list;
    setDecks(list);
  };
  const saveDeck = useCallback(
    async (deck) => {
      setAll([deck, ...decksRef.current.filter((d) => d.id !== deck.id)]);
      try {
        await putDeck(account, deck);
      } catch (e) {
        setStoreError(e?.message || "This deck couldn't be saved in this browser.");
      }
    },
    [account],
  );
  async function removeDeck(id) {
    setAll(decksRef.current.filter((d) => d.id !== id));
    setView({ name: "home" });
    try {
      await deleteDeck(account, id);
    } catch (e) {
      setStoreError(e?.message || "The deck couldn't be deleted.");
    }
  }
  async function removeAll() {
    if (!window.confirm(t("Delete every deck and your review history in this browser? This can't be undone."))) return;
    setAll([]);
    logRef.current = { days: {} };
    setLog(logRef.current);
    setView({ name: "home" });
    try {
      await deleteAllDecks(account);
    } catch (e) {
      setStoreError(e?.message || "The decks couldn't be deleted.");
    }
  }

  // ---- Models, Veil, Private Mode ----
  const veilLive = isReleased(config, "veil");
  const veiling = veilLive && live && (veilOn || privateOn);
  const privateLive = privateModeReleased(config);
  const trailLive = isReleased(config, "trail");
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
  // Saved chats: the account's own list, read when that source is chosen.
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
        setChat({ id: c.id, name: cleanName(c.title, "Saved chat"), text, sealed: false });
      })
      .catch((e) => !stop && (setChat(null), setFormError(e?.message || "That chat couldn't be opened.")));
    return () => {
      stop = true;
    };
  }, [live, chatId]);
  const source =
    sourceKind === "text"
      ? { kind: "text", name: "Pasted text", text: pasted }
      : sourceKind === "document"
        ? doc && { kind: "document", name: doc.name, text: doc.text }
        : chat && { kind: "chat", name: chat.name, text: chat.text };
  // Injection Shield: invisible characters come out; the source always goes
  // as data (the server frames it). Checked here only.
  const shieldScan = useMemo(
    () => (shieldOn && source?.text ? scanText(source.text) : null),
    [shieldOn, source?.text],
  );
  const cleaned = useMemo(
    () => (source ? { ...source, text: shieldScan ? cleanText(source.text, shieldScan) : source.text } : null),
    [source?.kind, source?.name, source?.text, shieldScan],
  );
  // A saved chat's own Veil map: its placeholders stay as they are, and new
  // ones continue its numbering, so the deck restores with both.
  const baseVeil = () =>
    sourceKind === "chat" && chat ? structuredClone(loadVeilState(chat.id)) : createVeilState();
  // What would be sent, masked with a copy of Veil's state (the real send
  // masks again with the same result).
  const built = useMemo(() => {
    if (!cleaned || tooShort(cleaned.text)) return null;
    const state = baseVeil();
    let masked = 0;
    const mask = veiling
      ? (s) => {
          const r = veil(s, state, veilWords);
          masked += r.count;
          return r.text;
        }
      : (s) => s;
    const r = studyPayload(cleaned, { make, count, level }, mask);
    return { ...r, masked, text: studyText(r.payload) };
  }, [cleaned, make, count, level, veiling, veilWords, chat?.id]);
  const seedHit = useSeedScan(live && seedGuardLive(config), built?.text || "");
  const busy = gen?.status === "writing";
  const noPrivate = privateOn && !choices.length;
  const quoteBody = useMemo(
    () => (live && model && built && !seedHit && !busy ? { model, study: built.payload } : null),
    [live, model, built, seedHit, busy],
  );
  const estimate = useCreditEstimate(quoteBody);
  // The most it can cost, against the balance and the Spending Limits room.
  const short = estimate.status === "ready" && estimate.available != null && estimate.credits > estimate.available;
  const limited = estimate.status === "ready" && !short && estimate.room != null && estimate.credits > estimate.room;

  // ---- Making a deck ----
  async function makeDeck(e, { allowSeed = false } = {}) {
    e?.preventDefault();
    if (busy || !built || (seedHit && !allowSeed)) return;
    if (!live) return setFormError("Sign in to make decks. Reviewing a sample or an imported deck works without an account.");
    if (!model) return setFormError(privateOn ? "No private models are available right now." : "No callable chat model is available.");
    setFormError("");
    const state = baseVeil();
    let masked = 0;
    const mask = veiling
      ? (s) => {
          const r = veil(s, state, veilWords);
          masked += r.count;
          return r.text;
        }
      : (s) => s;
    const { payload } = studyPayload(cleaned, { make, count, level }, mask);
    const ctl = new AbortController();
    controller.current = ctl;
    const started = { make, count, level, model, modelName: modelName(model), veiled: veiling, private: privateOn };
    setGen({ status: "writing", ...started, progress: { cards: 0, quiz: 0 } });
    let text = "",
      receipt = null,
      failure = null,
      shown = "";
    try {
      await streamChat(
        {
          study: payload,
          model,
          ephemeral: true,
          requestId: uid(),
          ...(privateOn ? { private: true } : {}),
          ...(allowSeed && seedHit?.kind === "seed" ? { allow_seed_phrase: true } : {}),
          ...(trailLive ? { veil_masked: veiling ? masked : null } : {}),
        },
        (event) => {
          const delta = event.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && text.length < 400000) {
            text += delta;
            const p = streamedCount(text);
            const key = p.cards + ":" + p.quiz;
            if (key !== shown && mounted.current) {
              shown = key;
              setGen((g) => (g?.status === "writing" ? { ...g, progress: p } : g));
            }
          }
          if (event.anonyma && Number.isFinite(event.anonyma.credits_charged)) receipt = event.anonyma;
          if (event.error) failure = event.error;
        },
        ctl.signal,
      );
      if (failure) throw Error(failure.message || "The model request failed.");
      const charged = receipt?.credits_charged ?? null;
      const result = readDeck(text, {
        make,
        count,
        source: payload.source.text,
        finishReason: receipt?.finish_reason ?? null,
      });
      if (result.truncated) return setGen({ status: "failed", ...started, charged, error: TRUNCATED_MESSAGE });
      if (result.refusal)
        return setGen({ status: "refused", ...started, charged, error: restoreDeck({ title: result.refusal, cards: [], quiz: [] }, state.map).title });
      if (result.problems) return setGen({ status: "failed", ...started, charged, error: UNREADABLE_MESSAGE });
      const restored = restoreDeck(result.deck, state.map);
      const deck = newDeck({
        title: restored.title,
        source: { kind: cleaned.kind, name: cleanName(cleaned.name), chars: payload.source.text.length },
        make,
        count,
        level,
        model: started.modelName,
        cards: restored.cards,
        quiz: restored.quiz,
      });
      await saveDeck(deck);
      setGen({ status: "done", ...started, charged, deckId: deck.id, dropped: result.dropped, ungrounded: result.ungrounded });
    } catch (err) {
      const stopped = err.name === "AbortError";
      setGen({
        status: stopped ? "stopped" : "failed",
        ...started,
        error: stopped
          ? "Stopped. If the model had already started, that part may be charged; check your activity."
          : err.message,
      });
    } finally {
      if (controller.current === ctl) controller.current = null;
      refresh?.();
    }
  }

  // The progress line and the result stay in view as they change.
  useEffect(() => {
    resultBox.current?.scrollIntoView?.({ block: "nearest" });
  }, [gen?.status]);

  // ---- Reviewing ----
  const now = Date.now();
  const totals = totalCounts(decks, now);
  const streakDays = streak(log, now);
  const today = reviewedToday(log, now);
  async function grade(deckId, cardId, g) {
    const at = Date.now();
    const deck = decksRef.current.find((d) => d.id === deckId);
    if (!deck) return;
    const next = {
      ...deck,
      updated: at,
      cards: deck.cards.map((c) => (c.id === cardId ? { ...c, srs: schedule(c.srs, g, at) } : c)),
    };
    const nextLog = logReview(logRef.current, at);
    logRef.current = nextLog;
    setLog(nextLog);
    await saveDeck(next);
    try {
      await saveLog(account, nextLog);
    } catch {}
  }
  function startReview(deckIds) {
    const items = [];
    for (const d of decks.filter((x) => deckIds.includes(x.id)))
      for (const id of reviewQueue(d, Date.now())) items.push({ deckId: d.id, cardId: id });
    if (!items.length) return setNotice("Nothing is due. New cards and cards you've reviewed come back when they're due.");
    setNotice("");
    setView({ name: "review", items });
  }
  async function finishQuiz(deckId, answers) {
    const deck = decksRef.current.find((d) => d.id === deckId);
    if (!deck || !answers.length) return;
    await saveDeck(withQuizResult(deck, quizScore(answers)));
  }
  async function importFile(file) {
    if (!file) return;
    setNotice("");
    if (file.size > MAX_IMPORT_BYTES) return setNotice("This file is too large for a deck (5 MB at most).");
    try {
      const { deck, dropped } = importDeck(await file.text());
      await saveDeck(deck);
      setNotice(
        dropped
          ? `Imported “${deck.title}”. ${plural(dropped, "item wasn't usable and was left out.", "items weren't usable and were left out.")}`
          : `Imported “${deck.title}”.`,
      );
    } catch (e) {
      setNotice(e.message);
    }
  }

  const current = view.deckId ? decks.find((d) => d.id === view.deckId) : null;
  if (view.name === "review")
    return (
      <section className="study-page">
        <Review
          items={view.items}
          decks={decks}
          onGrade={grade}
          onExit={() => setView({ name: "home" })}
          streakDays={streak(log, Date.now())}
        />
      </section>
    );
  if (view.name === "quiz" && current)
    return (
      <section className="study-page">
        <Quiz
          deck={current}
          live={diagramsReleased(config)}
          onFinish={(answers) => finishQuiz(current.id, answers)}
          onExit={() => setView({ name: "deck", deckId: current.id })}
        />
      </section>
    );
  if (view.name === "deck" && current)
    return (
      <section className="study-page">
        <DeckView
          deck={current}
          onBack={() => setView({ name: "home" })}
          onReview={() => startReview([current.id])}
          onQuiz={() => setView({ name: "quiz", deckId: current.id })}
          onSave={saveDeck}
          onDelete={() => {
            if (window.confirm(t("Delete this deck and its progress from this browser?"))) removeDeck(current.id);
          }}
          notice={notice}
        />
      </section>
    );

  const made = gen?.status === "done" ? decks.find((d) => d.id === gen.deckId) : null;
  const shieldLine = shieldScan && !shieldSummary(shieldScan).clear ? summaryText(shieldSummary(shieldScan)) : "";
  return (
    <section className="study-page">
      <div className="study-head">
        <div>
          <p className="eyebrow">YOUR DECKS STAY ON THIS DEVICE</p>
          <h1>Study</h1>
          <p>
            Turn a document, a saved chat or pasted text into flashcards and a quiz, then review with spaced
            repetition. Decks and progress are kept in this browser only.
          </p>
        </div>
        <div className="study-stats" aria-label="Your review">
          <span>
            <b>{totals.due.toLocaleString("en-US")}</b>
            <small>Due now</small>
          </span>
          <span>
            <b>{totals.new.toLocaleString("en-US")}</b>
            <small>New cards</small>
          </span>
          <span className={streakDays ? "hot" : ""}>
            <b>
              <Icon name="flame" size={16} />
              {streakDays.toLocaleString("en-US")}
            </b>
            <small>Day streak</small>
          </span>
          <button
            type="button"
            className="button study-review-all"
            disabled={!totals.due && !totals.new}
            onClick={() => startReview(decks.map((d) => d.id))}
          >
            Review now
          </button>
        </div>
      </div>
      {storeError && <Notice type="error">{storeError}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      <div className="study-grid">
        <form className="study-make" onSubmit={makeDeck}>
          <h2>Make a deck</h2>
          <div className="study-tabs" role="tablist" aria-label="Study source">
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
          {sourceKind === "text" && (
            <textarea
              className="study-paste"
              rows={7}
              value={pasted}
              disabled={busy}
              maxLength={400000}
              data-i18n="off"
              aria-label="Text to study"
              placeholder="Paste notes, an article or a chapter…"
              onChange={(e) => setPasted(e.target.value)}
            />
          )}
          {sourceKind === "document" && (
            <div className="study-source-box">
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
                <div className="study-source-file">
                  <Icon name="file" size={18} />
                  <span>
                    <b data-i18n="off">{doc.name}</b>
                    <small>
                      {plural(doc.text.length, "character", "characters")}
                      {doc.pages ? ` · ${plural(doc.pages, "page", "pages")}` : ""} · Read in this browser
                    </small>
                  </span>
                  <button type="button" className="study-secondary" disabled={busy || docBusy} onClick={() => fileInput.current?.click()}>
                    Change
                  </button>
                </div>
              ) : (
                <button type="button" className="study-secondary" disabled={busy || docBusy} onClick={() => fileInput.current?.click()}>
                  <Icon name="upload" size={15} />
                  {docBusy ? "Reading…" : "Choose a file"}
                </button>
              )}
              <small>PDF, Word, text or Markdown. The text is read in this browser; the file isn't uploaded.</small>
            </div>
          )}
          {sourceKind === "chat" && (
            <div className="study-source-box">
              {!live ? (
                <small>Sign in to study your saved chats.</small>
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
                        params.delete("chat");
                        setParams(params, { replace: true });
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
                      {plural(chat.text.length, "character", "characters")} from this chat: your messages, their
                      attached documents and the replies.
                    </small>
                  )}
                  <small>
                    Only chats saved on your account are listed. Off the record, Private Mode and Device Vault chats
                    aren't: a deck is stored unencrypted in this browser.
                  </small>
                </>
              )}
            </div>
          )}
          <div className="study-options">
            <fieldset>
              <legend>Make</legend>
              <div className="study-seg">
                {MAKES.map(([id, label]) => (
                  <button key={id} type="button" className={make === id ? "on" : ""} aria-pressed={make === id} disabled={busy} onClick={() => setMake(id)}>
                    {label}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>How many</legend>
              <div className="study-seg">
                {STUDY_COUNTS.map((n) => (
                  <button key={n} type="button" className={count === n ? "on" : ""} aria-pressed={count === n} disabled={busy} onClick={() => setCount(n)}>
                    {n}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Difficulty</legend>
              <div className="study-seg">
                {LEVELS.map(([id, label]) => (
                  <button key={id} type="button" className={level === id ? "on" : ""} aria-pressed={level === id} disabled={busy} onClick={() => setLevel(id)}>
                    {label}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
          <div className="study-controls">
            <label className="study-model">
              Model
              <select value={model} disabled={busy || !choices.length} onChange={(e) => setModel(e.target.value)}>
                {choices.map((m) => (
                  <option key={m.id} value={m.id} data-i18n="off">
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
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
          {built && (
            <details className="study-sees">
              <summary>
                What the AI sees <span>{plural(built.payload.source.text.length, "character", "characters")}</span>
              </summary>
              <p>
                This source and Study Mode's fixed instructions, nothing else: no other chats, memory, project or
                standing instructions.
                {built.masked ? ` Veil masked ${plural(built.masked, "detail", "details")}.` : ""}
              </p>
              <pre data-i18n="off">
                {built.text.length > PREVIEW_CHARS ? built.text.slice(0, PREVIEW_CHARS) + "\n…" : built.text}
              </pre>
            </details>
          )}
          {built?.cut && (
            <Notice>
              {`Only the first ${MAX_SOURCE_CHARS.toLocaleString("en-US")} of ${built.total.toLocaleString("en-US")} characters are sent. Paste or pick a shorter part to study the rest.`}
            </Notice>
          )}
          {shieldLine && <Notice>{`Injection Shield found ${shieldLine}. Invisible characters are removed, and the source is sent as data, not instructions.`}</Notice>}
          {cleaned && tooShort(cleaned.text) && cleaned.text.trim() && <Notice>Add a few more sentences: the source is too short to study.</Notice>}
          <SeedGuardNotice hit={seedHit} busy={busy} onProceed={() => makeDeck(null, { allowSeed: true })} />
          {formError && <Notice type="error">{formError}</Notice>}
          <div className="study-send">
            {busy ? (
              <button type="button" className="study-secondary" onClick={() => controller.current?.abort()}>
                <Icon name="stop" size={14} />
                Stop
              </button>
            ) : (
              <button type="submit" className="button" disabled={!live || !built || !model || noPrivate || !!seedHit}>
                Make deck
              </button>
            )}
            {quoteBody && estimate.status === "ready" && (
              <span
                className={"credit-estimate " + (short ? "short" : limited ? "limited" : "ready")}
                role="status"
                title="The most this deck can cost: the source and a full reply budget at the model's published rates. You're charged only for what's used."
              >
                <Icon name="coins" size={13} />
                {`Up to ≈${formatCredits(estimate.credits)} credits`}
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
              <Result gen={gen} deck={made} onOpen={(id) => setView({ name: "deck", deckId: id })} onReview={(id) => startReview([id])} />
            </div>
          )}
          <p className="study-fine">
            Off the record: billed like a message, and nothing about it is saved on ANONYMA's servers. The AI can
            still get things wrong, so check cards against the source.
          </p>
        </form>
        <aside className="study-decks">
          <div className="study-decks-head">
            <h2>
              Your decks <span>{decks.length}</span>
            </h2>
            <input
              ref={importInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                importFile(file);
              }}
            />
            <button type="button" className="study-secondary" onClick={() => importInput.current?.click()}>
              <Icon name="upload" size={14} />
              Import
            </button>
          </div>
          {!loaded ? (
            <p className="study-empty">Opening your decks…</p>
          ) : !decks.length ? (
            <div className="study-empty">
              <p>No decks in this browser yet.</p>
              <button type="button" className="study-secondary" onClick={() => saveDeck(sampleDeck())}>
                Try a sample deck
              </button>
              <small>The sample is written by hand, not by a model. It costs nothing.</small>
            </div>
          ) : (
            <ul className="study-deck-list">
              {decks.map((d) => {
                const c = deckCounts(d, now);
                return (
                  <li key={d.id}>
                    <button type="button" className="study-deck-open" onClick={() => setView({ name: "deck", deckId: d.id })}>
                      <b data-i18n="off">{d.title}</b>
                      <small>
                        {[
                          d.cards.length ? plural(d.cards.length, "card", "cards") : null,
                          d.quiz.length ? plural(d.quiz.length, "question", "questions") : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </button>
                    <span className="study-deck-due">
                      {c.due ? <span className="study-tag due">{`${c.due} due`}</span> : null}
                      {c.new ? <span className="study-tag">{`${c.new} new`}</span> : null}
                    </span>
                    {c.due || c.new ? (
                      <button type="button" className="study-secondary" onClick={() => startReview([d.id])}>
                        {`Review ${c.due + Math.min(c.new, NEW_PER_SESSION)}`}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="study-fine">
            Stored in this browser only, unencrypted, like a downloaded file. ANONYMA's servers never see your decks.
            {today ? ` ${plural(today, "review", "reviews")} today.` : ""}
          </p>
          {decks.length > 0 && (
            <button type="button" className="study-link" onClick={removeAll}>
              Delete all decks in this browser
            </button>
          )}
        </aside>
      </div>
    </section>
  );
}

function Result({ gen, deck, onOpen, onReview }) {
  if (gen.status === "writing") {
    const p = gen.progress || {};
    const parts = [
      gen.make !== "quiz" ? plural(p.cards || 0, "card", "cards") : null,
      gen.make !== "cards" ? plural(p.quiz || 0, "question", "questions") : null,
    ].filter(Boolean);
    return (
      <div className="study-result writing" role="status">
        <span className="study-spinner" aria-hidden="true" />
        <span>
          <b>Writing your deck…</b>
          <small>{[...parts, gen.modelName].join(" · ")}</small>
        </span>
      </div>
    );
  }
  const charged = gen.charged != null ? ` Charged ${formatCredits(gen.charged)} credits.` : "";
  if (gen.status !== "done")
    return (
      <Notice type={gen.status === "refused" ? "" : "error"}>
        {gen.status === "refused" ? (
          <span data-i18n="off">{gen.error}</span>
        ) : (
          gen.error
        )}
        {charged}
      </Notice>
    );
  if (!deck) return null;
  return (
    <div className="study-result done" role="status">
      <Icon name="check" size={18} />
      <span>
        <b>
          Deck ready: <span data-i18n="off">{deck.title}</span>
        </b>
        <small>
          {[
            deck.cards.length ? plural(deck.cards.length, "card", "cards") : null,
            deck.quiz.length ? plural(deck.quiz.length, "question", "questions") : null,
            gen.modelName,
            gen.charged != null ? `${formatCredits(gen.charged)} credits` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
        {gen.ungrounded > 0 && (
          <small className="warn">
            {gen.ungrounded === 1
              ? "1 item's snippet wasn't found in the source. It's marked; check it."
              : `${gen.ungrounded} items' snippets weren't found in the source. They're marked; check them.`}
          </small>
        )}
      </span>
      <span className="study-result-actions">
        <button type="button" className="button" onClick={() => onReview(deck.id)} disabled={!deck.cards.length}>
          Start reviewing
        </button>
        <button type="button" className="study-secondary" onClick={() => onOpen(deck.id)}>
          See the deck
        </button>
      </span>
    </div>
  );
}

function Snippet({ item, imported }) {
  if (!item.snippet) return null;
  return (
    <p className="study-snippet">
      <span className="study-snippet-label">From the source</span>
      <q data-i18n="off">{item.snippet}</q>
      {!item.grounded && !imported && <span className="study-tag warn">Not found in the source</span>}
    </p>
  );
}

// ---- The flip-card review ----
function Review({ items, decks, onGrade, onExit, streakDays }) {
  const [queue, setQueue] = useState(items),
    [index, setIndex] = useState(0),
    [flipped, setFlipped] = useState(false),
    [done, setDone] = useState(0),
    [seen, setSeen] = useState({});
  const item = queue[index];
  const deck = item && decks.find((d) => d.id === item.deckId);
  const card = deck?.cards.find((c) => c.id === item.cardId);
  const intervals = card ? nextIntervals(card.srs, Date.now()) : null;
  const finished = !item || !card;
  const answer = useCallback(
    (g) => {
      if (!card || !flipped) return;
      onGrade(item.deckId, item.cardId, g);
      setDone((n) => n + 1);
      const repeats = seen[item.cardId] || 0;
      if (g === "again" && repeats < REPEATS) {
        setQueue((q) => [...q, item]);
        setSeen((s) => ({ ...s, [item.cardId]: repeats + 1 }));
      }
      setFlipped(false);
      setIndex((i) => i + 1);
    },
    [card, flipped, item, onGrade, seen],
  );
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") return onExit();
      if (finished) return;
      if (!flipped && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        setFlipped(true);
      } else if (flipped && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        answer(GRADES[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flipped, finished, answer, onExit]);
  const left = Math.max(0, queue.length - index);
  if (finished) {
    const next = decks
      .filter((d) => items.some((i) => i.deckId === d.id))
      .map(nextDue)
      .filter((t) => t != null && t > Date.now());
    const soonest = next.length ? Math.min(...next) : null;
    return (
      <div className="study-review">
        <div className="study-review-bar">
          <button type="button" className="study-secondary" onClick={onExit}>
            <Icon name="arrow" size={13} className="study-back" />
            Back to decks
          </button>
        </div>
        <div className="study-finished">
          <span className="study-finished-icon" aria-hidden="true">
            <Icon name="check" size={26} />
          </span>
          <h2>Session done</h2>
          <p>
            {plural(done, "card reviewed", "cards reviewed")}
            {streakDays ? ` · ${streakDays}-day streak` : ""}
          </p>
          {soonest && <p>{`Next card due in ${formatInterval(soonest - Date.now())}.`}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="study-review">
      <div className="study-review-bar">
        <button type="button" className="study-secondary" onClick={onExit}>
          <Icon name="arrow" size={13} className="study-back" />
          End session
        </button>
        <span className="study-review-deck" data-i18n="off">
          {deck.title}
        </span>
        <span className="study-review-count">{`${left} left`}</span>
      </div>
      <div className="study-progress" aria-hidden="true">
        <i style={{ width: `${Math.round((index / Math.max(1, queue.length)) * 100)}%` }} />
      </div>
      <button
        type="button"
        className={"study-card" + (flipped ? " flipped" : "")}
        aria-label={flipped ? "Answer shown" : "Show answer"}
        onClick={() => setFlipped(true)}
      >
        <span className="study-card-inner">
          <span className="study-face front">
            <small>Question</small>
            <CardText text={card.front} />
            {!flipped && <em>Tap or press Space to show the answer</em>}
          </span>
          <span className="study-face back">
            <span className="study-face-q">
              <CardText text={card.front} />
            </span>
            <small>Answer</small>
            <CardText text={card.back} />
            <Snippet item={card} imported={deck.imported} />
          </span>
        </span>
      </button>
      <div className="study-grades">
        {flipped ? (
          GRADES.map((g, i) => (
            <button key={g} type="button" className={"study-grade " + g} onClick={() => answer(g)}>
              <b>{GRADE_LABELS[g]}</b>
              <small>{formatInterval(intervals[g])}</small>
              <kbd>{i + 1}</kbd>
            </button>
          ))
        ) : (
          <button type="button" className="button study-show" onClick={() => setFlipped(true)}>
            Show answer <kbd>Space</kbd>
          </button>
        )}
      </div>
      <p className="study-keys">Space shows the answer · 1 Again · 2 Hard · 3 Good · 4 Easy · Esc ends the session</p>
    </div>
  );
}

// ---- The quiz ----
function Quiz({ deck, live, onFinish, onExit }) {
  const [index, setIndex] = useState(0),
    [chosen, setChosen] = useState(null),
    [answers, setAnswers] = useState([]),
    [reported, setReported] = useState(false);
  const q = deck.quiz[index];
  const finished = !q;
  const choose = useCallback(
    (i) => {
      if (!q || chosen !== null) return;
      setChosen(i);
      setAnswers((a) => [...a, { chosen: i, answer: q.answer }]);
    },
    [q, chosen],
  );
  const next = useCallback(() => {
    if (chosen === null) return;
    setChosen(null);
    setIndex((n) => n + 1);
  }, [chosen]);
  useEffect(() => {
    if (finished && !reported) {
      setReported(true);
      onFinish(answers);
    }
  }, [finished, reported, answers, onFinish]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") return onExit();
      if (!q) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : "";
      const pick = k && "1234".includes(k) ? Number(k) - 1 : k && "abcd".includes(k) ? "abcd".indexOf(k) : -1;
      if (pick >= 0 && pick < q.options.length && chosen === null) {
        e.preventDefault();
        choose(pick);
      } else if ((e.key === "Enter" || e.key === "ArrowRight") && chosen !== null) {
        e.preventDefault();
        next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [q, chosen, choose, next, onExit]);
  const score = quizScore(answers);
  if (finished)
    return (
      <div className="study-review">
        <div className="study-review-bar">
          <button type="button" className="study-secondary" onClick={onExit}>
            <Icon name="arrow" size={13} className="study-back" />
            Back to the deck
          </button>
        </div>
        <div className="study-finished">
          <span className="study-finished-icon" aria-hidden="true">
            <Icon name="check" size={26} />
          </span>
          <h2>{`${score.right} / ${score.total}`}</h2>
          <p>{`You scored ${score.percent}%.`}</p>
          {deck.quizStats?.best && <p>{`Best: ${deck.quizStats.best.right} / ${deck.quizStats.best.total}`}</p>}
        </div>
      </div>
    );
  return (
    <div className="study-review">
      <div className="study-review-bar">
        <button type="button" className="study-secondary" onClick={onExit}>
          <Icon name="arrow" size={13} className="study-back" />
          End quiz
        </button>
        <span className="study-review-deck" data-i18n="off">
          {deck.title}
        </span>
        <span className="study-review-count">{`Question ${index + 1} of ${deck.quiz.length}`}</span>
      </div>
      <div className="study-progress" aria-hidden="true">
        <i style={{ width: `${Math.round((index / deck.quiz.length) * 100)}%` }} />
      </div>
      <div className="study-question">
        <CardText text={q.question} />
        <ol className="study-options-list">
          {q.options.map((o, i) => {
            const state =
              chosen === null ? "" : i === q.answer ? " right" : i === chosen ? " wrong" : " dim";
            return (
              <li key={i}>
                <button type="button" className={"study-option" + state} disabled={chosen !== null} onClick={() => choose(i)}>
                  <kbd>{"ABCD"[i] || i + 1}</kbd>
                  <span data-i18n="off">
                    <MathText text={o} live={live} />
                  </span>
                  {chosen !== null && i === q.answer && <Icon name="check" size={16} />}
                  {chosen === i && i !== q.answer && <Icon name="close" size={16} />}
                </button>
              </li>
            );
          })}
        </ol>
        {chosen !== null && (
          <div className="study-explain">
            <b>{chosen === q.answer ? "Correct" : "Not quite"}</b>
            {q.explanation && <CardText text={q.explanation} />}
            <Snippet item={q} imported={deck.imported} />
            <button type="button" className="button" onClick={next}>
              {index + 1 < deck.quiz.length ? "Next question" : "See your score"}
            </button>
          </div>
        )}
      </div>
      <p className="study-keys">{`Score so far: ${score.right} / ${score.total} · A–D or 1–4 to answer · Enter for the next question`}</p>
    </div>
  );
}

// ---- One deck ----
function DeckView({ deck, onBack, onReview, onQuiz, onSave, onDelete, notice }) {
  const [tab, setTab] = useState(deck.cards.length ? "cards" : "quiz");
  const c = deckCounts(deck, Date.now());
  const removeItem = (list, id) =>
    onSave({ ...deck, updated: Date.now(), [list]: deck[list].filter((x) => x.id !== id) });
  return (
    <div className="study-deck">
      <button type="button" className="study-secondary" onClick={onBack}>
        <Icon name="arrow" size={13} className="study-back" />
        All decks
      </button>
      <div className="study-deck-head">
        <div>
          <h1 data-i18n="off">{deck.title}</h1>
          <p>
            {KIND_LABELS[deck.source?.kind] || "Pasted text"}
            {deck.source?.name && deck.source.name !== "Pasted text" ? (
              <>
                {" · "}
                <span data-i18n="off">{deck.source.name}</span>
              </>
            ) : null}
            {deck.made?.model ? (
              <>
                {" · "}
                <span data-i18n="off">{deck.made.model}</span>
              </>
            ) : null}
            {" · "}
            <span>{shortDate(deck.created)}</span>
          </p>
          {deck.imported && <p className="study-fine">Imported: snippets weren't checked against a source.</p>}
          {deck.sample && <p className="study-fine">A sample written by hand, not by a model.</p>}
        </div>
        <div className="study-deck-actions">
          <button type="button" className="button" disabled={!c.due && !c.new} onClick={onReview}>
            {c.due || c.new ? `Review ${c.due + Math.min(c.new, NEW_PER_SESSION)}` : "Nothing due"}
          </button>
          <button type="button" className="study-secondary" disabled={!deck.quiz.length} onClick={onQuiz}>
            Take the quiz
          </button>
          <button
            type="button"
            className="study-secondary"
            onClick={() => download(slug(deck.title) + ".json", JSON.stringify(exportDeck(deck), null, 2))}
          >
            <Icon name="download" size={14} />
            JSON
          </button>
          <button
            type="button"
            className="study-secondary"
            onClick={() => download(slug(deck.title) + "-anki.csv", deckCSV(deck), "text/csv;charset=utf-8")}
          >
            <Icon name="download" size={14} />
            Anki CSV
          </button>
          <button type="button" className="study-secondary danger" onClick={onDelete}>
            <Icon name="delete" size={14} />
            Delete
          </button>
        </div>
      </div>
      {notice && <Notice>{notice}</Notice>}
      <div className="study-deck-stats">
        <span>{plural(c.due, "card due", "cards due")}</span>
        <span>{plural(c.new, "new card", "new cards")}</span>
        <span>{plural(c.learned, "card learned", "cards learned")}</span>
        {deck.quizStats?.last && <span>{`Last quiz: ${deck.quizStats.last.right} / ${deck.quizStats.last.total}`}</span>}
      </div>
      <div className="study-tabs" role="tablist" aria-label="Deck">
        <button type="button" role="tab" aria-selected={tab === "cards"} className={tab === "cards" ? "on" : ""} onClick={() => setTab("cards")}>
          {`Cards (${deck.cards.length})`}
        </button>
        <button type="button" role="tab" aria-selected={tab === "quiz"} className={tab === "quiz" ? "on" : ""} onClick={() => setTab("quiz")}>
          {`Questions (${deck.quiz.length})`}
        </button>
      </div>
      <ol className="study-items">
        {(tab === "cards" ? deck.cards : deck.quiz).map((x) => (
          <li key={x.id}>
            <div className="study-item-main">
              {tab === "cards" ? (
                <>
                  <CardText text={x.front} />
                  <div className="study-item-back">
                    <CardText text={x.back} />
                  </div>
                </>
              ) : (
                <>
                  <CardText text={x.question} />
                  <ul className="study-item-options">
                    {x.options.map((o, i) => (
                      <li key={i} className={i === x.answer ? "right" : ""} data-i18n="off">
                        {o}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <Snippet item={x} imported={deck.imported || deck.sample} />
            </div>
            <button
              type="button"
              className="icon-button study-item-delete"
              aria-label={tab === "cards" ? "Delete this card" : "Delete this question"}
              onClick={() => removeItem(tab === "cards" ? "cards" : "quiz", x.id)}
            >
              <Icon name="delete" size={15} />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
