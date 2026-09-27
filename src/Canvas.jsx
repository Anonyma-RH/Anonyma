import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { Icon, Notice, Modal } from "./ui.jsx";
import { api, isReleased, streamChat, uid, download } from "./lib.js";
import { createVeilState, veil, unveil } from "./veil.js";
import { VeilToggle } from "./Veil.jsx";
import { PrivateModeToggle, NoPrivateModelsNotice, privateModeReleased } from "./PrivateMode.jsx";
import { SeedGuardNotice, seedGuardLive } from "./SeedGuard.jsx";
import { findSeedPhrase, scanSecrets } from "./seed-guard.js";
import { useShieldLive, shieldMarkdown, SentAsDataTag } from "./Shield.jsx";
import { useCreditEstimate, CreditEstimate } from "./CreditEstimate.jsx";
import { ReplyMarkdown } from "./RichMarkdown.jsx";
import { pickPreset } from "./model-finder.js";
import { formatCredits } from "./estimate.js";
import { retentionLabel } from "./ephemeral.js";
import {
  CANVAS_LENGTH,
  CANVAS_LIMITS,
  CANVAS_SYSTEM,
  CANVAS_TOO_LONG,
  CANVAS_UNREADABLE,
  canvasFit,
  canvasUserText,
  checkCanvasPayload,
  readCanvasReply,
} from "./canvas-spec.js";
import {
  DEFAULT_TITLE,
  DOCX_TYPE,
  SAMPLE_CANVAS,
  buildRequest,
  changedRange,
  changesIn,
  createHistory,
  decideAll,
  decisionCounts,
  allDecided,
  docxBytes,
  fileStem,
  finishReview,
  insertLink,
  isVaultCanvas,
  newLocalId,
  readTabCanvases,
  recordHistory,
  redoHistory,
  removeTabCanvas,
  selectionRange,
  storeOf,
  summaryInsertText,
  titleFrom,
  toggleLinePrefix,
  toggleWrap,
  trackChanges,
  undoHistory,
  vaultCanvasRecord,
  wordCount,
  writeTabCanvas,
} from "./canvas.js";
import "./canvas.css";

// Canvas: a Markdown document beside a small suggestions panel. Select text
// and ask for a change; the model's rewrite comes back as tracked changes to
// accept or reject one by one. Only the selection and a little text around
// it is sent, unless the action works on the whole document (Summarise on
// top, Make consistent, or an instruction with nothing selected), which
// says so and shows exactly what's sent first. Every suggestion is an
// off-the-record chat: nothing about it is saved.
//
// A canvas lives in one of three places, chosen when it's made: on the
// account (server/routes/canvas.js, saved as you type), off the record in
// this tab only (sessionStorage), or in Device Vault (sealed in this
// browser like a vault chat). The address carries ?doc=<id>, so a reload
// reopens what's on screen.

const n = (v) => Number(v || 0).toLocaleString("en-US");
const PLACES = {
  account: { label: "On your account", tag: "Account", note: "Saved to your account as you type. It stays until you delete it (or your auto-delete default removes it)." },
  tab: { label: "Off the record", tag: "Off the record", note: "Kept only in this browser tab. Closing the tab clears it; nothing is saved to your account." },
  vault: { label: "Device only", tag: "Device only", note: "Encrypted in this browser with Device Vault. ANONYMA's servers never store it." },
};
const ACTIONS = [
  ["improve", "Improve"],
  ["shorten", "Shorten"],
  ["expand", "Expand"],
  ["grammar", "Fix grammar"],
];
const TONES = [
  ["formal", "Formal"],
  ["friendly", "Friendly"],
  ["plain", "Plain"],
];
const LABELS = {
  improve: "Improve",
  shorten: "Shorten",
  expand: "Expand",
  grammar: "Fix grammar",
  tone: "Change tone",
  custom: "Your instruction",
  summarize: "Summarise on top",
  consistent: "Make consistent",
};
const toneLabel = (tone) => TONES.find(([id]) => id === tone)?.[1] || "";
const STOPPED = "Stopped. Nothing was charged.";
const safeSession = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};
const mod = (e) => e.metaKey || e.ctrlKey;

export default function Canvas({ demo, user, models, config, refresh, veilOn, setVeilOn, veilWords, vault, vaultLive, onUnlockVault }) {
  const live = !demo && !!user;
  const [params, setParams] = useSearchParams();
  const docParam = params.get("doc");
  const [serverList, setServerList] = useState(null),
    [tabList, setTabList] = useState(() => (live ? readTabCanvases(safeSession(), user.id) : [])),
    [listError, setListError] = useState(""),
    [doc, setDoc] = useState(null),
    [history, setHistory] = useState(() => createHistory("")),
    [sel, setSel] = useState({ start: 0, end: 0 }),
    [view, setView] = useState("write"),
    [saveState, setSaveState] = useState({ status: "saved" }),
    [notice, setNotice] = useState(null),
    [menu, setMenu] = useState(null),
    [removing, setRemoving] = useState(null),
    [printing, setPrinting] = useState(false),
    [model, setModel] = useState(""),
    [privateOn, setPrivateOn] = useState(false),
    [instruction, setInstruction] = useState(""),
    [step, setStep] = useState("idle"),
    [confirm, setConfirm] = useState(null),
    [seedHold, setSeedHold] = useState(null),
    [panelError, setPanelError] = useState(""),
    [review, setReview] = useState(null),
    [sending, setSending] = useState(null),
    [log, setLog] = useState([]);
  const text = history.present;
  const area = useRef(null),
    pendingSel = useRef(null),
    controller = useRef(null),
    mounted = useRef(true),
    // What's stored for the open canvas, the revision the server has, and
    // saves queued one after another so each carries the latest revision.
    saved = useRef({ id: null, title: "", content: "" }),
    revision = useRef(0),
    saving = useRef(Promise.resolve()),
    latest = useRef({ doc: null, text: "", vault: null }),
    // Veil's placeholders for the open canvas, in memory only.
    veilState = useRef(createVeilState());
  latest.current = { doc, text, vault };

  const veilLive = isReleased(config, "veil");
  const veiling = veilLive && live && (veilOn || privateOn);
  const privateLive = privateModeReleased(config);
  const shieldOn = useShieldLive(config);
  const trailLive = isReleased(config, "trail");
  const seedLive = live && seedGuardLive(config);
  const vaultOn = !!vaultLive && !!vault && live;
  const vaultCanvases = vaultOn && vault.unlocked ? vault.chats.filter(isVaultCanvas) : [];
  const uncensored = config?.releases?.uncensoredModels || [];
  const choices = useMemo(
    () =>
      models.filter(
        (m) => m.type === "chat" && m.callable && !m.imageCapable && !m.sealed && !uncensored.includes(m.id) && (!privateOn || m.private),
      ),
    [models, privateOn, config],
  );
  useEffect(() => {
    setModel((prev) =>
      choices.some((m) => m.id === prev) ? prev : pickPreset(choices, "balanced", { mode: "chat" })?.id || choices[0]?.id || "",
    );
  }, [choices]);
  const chosen = choices.find((m) => m.id === model);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      saveNow();
    };
  }, []);

  // ---- The list ----
  async function loadList() {
    if (!live) return;
    try {
      const r = await api("/api/canvas");
      if (mounted.current) {
        setServerList(r.data);
        setListError("");
      }
    } catch (e) {
      if (mounted.current) {
        setServerList([]);
        setListError(e.message);
      }
    }
  }
  useEffect(() => {
    loadList();
  }, [live]);
  const docs = useMemo(() => {
    const all = [
      ...(serverList || []).map((d) => ({ ...d, store: "account" })),
      ...tabList.map((d) => ({ id: d.id, title: d.title, updated: d.updated, created: d.created, chars: d.content.length, store: "tab" })),
      ...vaultCanvases.map((d) => ({ id: d.id, title: d.title, updated: d.updated, created: d.created, chars: d.canvas.content.length, store: "vault" })),
    ];
    return all.sort((a, b) => b.updated - a.updated);
  }, [serverList, tabList, vault?.chats, vault?.unlocked]);

  // ---- Opening and closing ----
  const goTo = (id) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (id) next.set("doc", id);
        else next.delete("doc");
        return next;
      },
      { replace: true },
    );
  function show(next, content) {
    controller.current?.abort();
    setDoc(next);
    setHistory(createHistory(content));
    saved.current = { id: next.id, title: next.title, content };
    revision.current = next.revision || 0;
    veilState.current = createVeilState();
    setSel({ start: 0, end: 0 });
    setReview(null);
    setSending(null);
    setConfirm(null);
    setSeedHold(null);
    setStep("idle");
    setLog([]);
    setPanelError("");
    setSaveState({ status: "saved" });
    setView("write");
  }
  function close() {
    controller.current?.abort();
    setDoc(null);
    setHistory(createHistory(""));
    saved.current = { id: null, title: "", content: "" };
    setReview(null);
    setSending(null);
    setStep("idle");
    setLog([]);
  }
  async function open(id) {
    await saveNow();
    setNotice(null);
    const where = storeOf(id);
    try {
      if (where === "account") {
        const r = await api("/api/canvas/" + encodeURIComponent(id));
        if (!mounted.current || new URLSearchParams(window.location.search).get("doc") !== id) return;
        show({ id: r.id, store: "account", title: r.title, revision: r.revision, created: r.created, expires: r.expires }, r.content);
        return;
      }
      if (where === "tab") {
        const c = readTabCanvases(safeSession(), user?.id).find((x) => x.id === id);
        if (c) return show({ id: c.id, store: "tab", title: c.title, created: c.created }, c.content);
      }
      if (where === "vault" && vaultOn) {
        if (!vault.unlocked) {
          setNotice({ kind: "locked", id });
          return;
        }
        const c = vault.chats.find((x) => x.id === id && isVaultCanvas(x));
        if (c) return show({ id: c.id, store: "vault", title: c.title, created: c.created }, c.canvas.content);
      }
      throw Object.assign(Error("That canvas wasn't found. It may have been deleted, or kept in another tab."), { code: "canvas_not_found" });
    } catch (e) {
      if (!mounted.current) return;
      close();
      setNotice({ kind: "error", text: e.code === "canvas_not_found" ? "That canvas wasn't found. It may have been deleted, or kept in another tab." : e.message });
      goTo(null);
    }
  }
  // The address is the source of truth: ?doc= opens that canvas (a reload,
  // back and forward, or a link from the vault), and no ?doc= shows the list.
  useEffect(() => {
    if (demo) {
      if (!doc) show({ id: "demo", store: "demo", title: titleFrom(SAMPLE_CANVAS) }, SAMPLE_CANVAS);
      return;
    }
    if (!live) return;
    if (!docParam) {
      if (doc) {
        saveNow();
        close();
      }
      return;
    }
    if (docParam !== doc?.id) open(docParam);
  }, [docParam, live, demo, vault?.unlocked]);
  // Device Vault locked (Lock, the idle timer): its canvas leaves the screen.
  useEffect(() => {
    if (doc?.store === "vault" && vaultOn && !vault.unlocked) {
      close();
      setNotice({ kind: "locked", id: doc.id });
    }
  }, [vault?.unlocked]);

  async function create(where, content = "", title = DEFAULT_TITLE) {
    setMenu(null);
    setNotice(null);
    await saveNow();
    const now = Date.now();
    try {
      if (where === "account") {
        const r = await api("/api/canvas", { method: "POST", body: { title, content } });
        setServerList((l) => [{ id: r.id, title: r.title, chars: r.content.length, revision: r.revision, created: r.created, updated: r.updated, expires: r.expires }, ...(l || [])]);
        show({ id: r.id, store: "account", title: r.title, revision: r.revision, created: r.created, expires: r.expires, autoTitle: title === DEFAULT_TITLE }, r.content);
        goTo(r.id);
      } else if (where === "tab") {
        const c = { id: newLocalId("tab"), title, content, created: now, updated: now };
        setTabList(writeTabCanvas(safeSession(), user.id, c));
        show({ id: c.id, store: "tab", title, created: now, autoTitle: title === DEFAULT_TITLE }, content);
        goTo(c.id);
      } else if (where === "vault") {
        if (!vault.unlocked) return onUnlockVault?.();
        const id = newLocalId("vault");
        await vault.save(vaultCanvasRecord({ id, title, content, created: now }));
        show({ id, store: "vault", title, created: now, autoTitle: title === DEFAULT_TITLE }, content);
        goTo(id);
      }
    } catch (e) {
      setNotice({ kind: "error", text: e.message || "The canvas couldn't be made." });
    }
  }
  async function remove(item) {
    setRemoving(null);
    try {
      if (item.store === "account") {
        await api("/api/canvas/" + encodeURIComponent(item.id), { method: "DELETE" });
        setServerList((l) => (l || []).filter((d) => d.id !== item.id));
      } else if (item.store === "tab") setTabList(removeTabCanvas(safeSession(), user.id, item.id));
      else if (item.store === "vault") await vault.remove(item.id);
      if (doc?.id === item.id) {
        saved.current = { id: null, title: "", content: "" };
        close();
        goTo(null);
      }
    } catch (e) {
      setNotice({ kind: "error", text: e.message });
    }
  }

  // ---- Saving ----
  const title = doc?.title ?? "";
  const dirty = !!doc && doc.store !== "demo" && (title !== saved.current.title || text !== saved.current.content);
  // Seed Guard: a canvas kept on the account is stored, so one holding a
  // seed phrase isn't sent to be saved at all (the server refuses it too).
  const seedBlocked = !!doc && doc.store === "account" && seedLive && (!!findSeedPhrase(text) || !!findSeedPhrase(title));
  function saveNow() {
    saving.current = saving.current.then(saveOnce, saveOnce);
    return saving.current;
  }
  // Runs after unmount too (leaving the page), so a last edit is kept.
  async function saveOnce() {
    const { doc: d, text: body, vault: v } = latest.current;
    if (!d || d.store === "demo") return;
    const name = d.title.replace(/\s+/g, " ").trim() || DEFAULT_TITLE;
    if (saved.current.id === d.id && name === saved.current.title && body === saved.current.content) return;
    const now = Date.now();
    try {
      if (d.store === "account") {
        if (seedGuardLive(config) && (findSeedPhrase(body) || findSeedPhrase(name))) {
          setSaveState({ status: "blocked" });
          return;
        }
        setSaveState({ status: "saving" });
        const r = await api("/api/canvas/" + encodeURIComponent(d.id), {
          method: "PATCH",
          body: { title: name, content: body, ...(revision.current ? { base: revision.current } : {}) },
        });
        revision.current = r.revision;
        saved.current = { id: d.id, title: r.title, content: body };
        setServerList((l) => (l || []).map((x) => (x.id === r.id ? { ...x, title: r.title, chars: r.content.length, revision: r.revision, updated: r.updated } : x)));
      } else if (d.store === "tab") {
        const c = { id: d.id, title: name, content: body, created: d.created || now, updated: now };
        setTabList(writeTabCanvas(safeSession(), user.id, c));
        saved.current = { id: d.id, title: name, content: body };
      } else if (d.store === "vault") {
        if (!v?.unlocked) {
          setSaveState({ status: "locked" });
          return;
        }
        await v.save(vaultCanvasRecord({ id: d.id, title: name, content: body, created: d.created }));
        saved.current = { id: d.id, title: name, content: body };
      }
      if (mounted.current && latest.current.doc?.id === d.id) setSaveState({ status: "saved", at: now });
    } catch (e) {
      if (e.code === "canvas_conflict") setSaveState({ status: "conflict" });
      else if (e.code === "seed_phrase_blocked") setSaveState({ status: "blocked" });
      else if (e.name === "QuotaExceededError") setSaveState({ status: "error", message: "This tab has no room left to keep the canvas. Export it to keep a copy." });
      else setSaveState({ status: "error", message: e.message || "The canvas couldn't be saved." });
    }
  }
  // A Seed Guard hold is about the text it read: it goes once that changes.
  useEffect(() => setSeedHold(null), [text, sel.start, sel.end]);
  // Autosave: a moment after typing stops.
  useEffect(() => {
    if (review || step === "sending") return;
    // Back to what's stored (an undo, say): nothing is waiting any more.
    if (!dirty) {
      setSaveState((s) => (s.status === "blocked" || s.status === "unsaved" ? { status: "saved" } : s));
      return;
    }
    if (seedBlocked) {
      setSaveState({ status: "blocked" });
      return;
    }
    if (saveState.status === "conflict") return;
    setSaveState((s) => (s.status === "saving" ? s : { status: "unsaved" }));
    const timer = setTimeout(saveNow, 1200);
    return () => clearTimeout(timer);
  }, [text, title, dirty, review, step, seedBlocked]);
  // Leaving the page with a change not yet saved: send it on the way out.
  useEffect(() => {
    const flush = () => {
      const { doc: d, text: body } = latest.current;
      if (!d || d.store !== "account" || saveState.status === "conflict") return;
      if (body === saved.current.content && d.title === saved.current.title) return;
      if (seedGuardLive(config) && findSeedPhrase(body)) return;
      try {
        fetch("/api/canvas/" + encodeURIComponent(d.id), {
          method: "PATCH",
          credentials: "same-origin",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: d.title.trim() || DEFAULT_TITLE, content: body, ...(revision.current ? { base: revision.current } : {}) }),
        });
      } catch {}
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [saveState.status, config]);
  async function resolveConflict(keepMine) {
    if (!doc) return;
    if (keepMine) {
      revision.current = 0;
      setSaveState({ status: "unsaved" });
      await saveNow();
      const r = await api("/api/canvas/" + encodeURIComponent(doc.id)).catch(() => null);
      if (r) revision.current = r.revision;
    } else {
      const id = doc.id;
      saved.current = { id: null, title: "", content: "" };
      close();
      await open(id);
    }
  }

  // ---- Editing ----
  function edit(next, { typing = false, select } = {}) {
    setHistory((h) => recordHistory(h, next, { typing }));
    if (select) pendingSel.current = select;
    // A new canvas takes its title from its first line until it's renamed.
    if (doc?.autoTitle) setDoc((d) => (d ? { ...d, title: titleFrom(next) } : d));
  }
  useLayoutEffect(() => {
    const el = area.current;
    if (!el || !pendingSel.current) return;
    const { start, end } = pendingSel.current;
    pendingSel.current = null;
    el.focus();
    el.setSelectionRange(start, end);
    setSel({ start, end });
  }, [history, view, review, step]);
  // The selection, however it changes (mouse, keyboard, select all, or a
  // script): React's onSelect misses some of these.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const read = () => setSel({ start: el.selectionStart, end: el.selectionEnd });
    const onDocument = () => document.activeElement === el && read();
    el.addEventListener("select", read);
    document.addEventListener("selectionchange", onDocument);
    return () => {
      el.removeEventListener("select", read);
      document.removeEventListener("selectionchange", onDocument);
    };
  }, [doc?.id, view, review, step]);
  // Undo and redo select what changed, in whole words.
  const step_ = (move) =>
    setHistory((h) => {
      const next = move(h);
      if (next !== h) {
        const r = changedRange(h.present, next.present);
        pendingSel.current = selectionRange(next.present, r.start, r.end);
      }
      return next;
    });
  const undo = () => step_(undoHistory);
  const redo = () => step_(redoHistory);
  const current = () => {
    const el = area.current;
    return el ? { start: el.selectionStart, end: el.selectionEnd } : sel;
  };
  function format(kind) {
    if (!editable) return;
    const { start, end } = current();
    const r =
      kind === "bold"
        ? toggleWrap(text, start, end, "**")
        : kind === "italic"
          ? toggleWrap(text, start, end, "*")
          : kind === "link"
            ? insertLink(text, start, end)
            : toggleLinePrefix(text, start, end, { heading: "## ", list: "- ", numbered: "1. ", quote: "> " }[kind]);
    edit(r.text, { select: { start: r.start, end: r.end } });
  }
  function onKeyDown(e) {
    if (!mod(e)) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((k === "z" && e.shiftKey) || (k === "y" && e.ctrlKey && !e.metaKey)) {
      e.preventDefault();
      redo();
    } else if (k === "b" || k === "i" || k === "k") {
      e.preventDefault();
      format(k === "b" ? "bold" : k === "i" ? "italic" : "link");
    }
  }

  // ---- Suggestions ----
  const range = selectionRange(text, sel.start, sel.end);
  const selected = range.end - range.start;
  const busy = step === "sending";
  const editable = !!doc && !review && !busy && view === "write";
  const noPrivate = privateOn && !choices.length;
  const canAsk = live && !!doc && !review && !busy && !!model && !noPrivate;

  // The request an action would make now, masked with `mask`.
  const requestFor = (req, mask) =>
    buildRequest({ action: req.action, tone: req.tone, instruction: req.instruction, text, start: range.start, end: range.end, mask });
  // What's wrong with sending it, in plain words, or "".
  function problemWith(req, built) {
    const p = built.payload;
    if (p.scope === "selection" && p.text.length > CANVAS_LIMITS.selection)
      return `Select up to ${n(CANVAS_LIMITS.selection)} characters at a time.`;
    if (p.scope === "document" && !text.trim()) return "Write something first.";
    if (p.scope === "document" && p.text.length > CANVAS_LIMITS.document)
      return `Whole-document suggestions work on up to ${n(CANVAS_LIMITS.document)} characters. Select a part instead.`;
    try {
      checkCanvasPayload(p);
    } catch (e) {
      return e.message;
    }
    if (chosen && !canvasFit(p, chosen).fits) return CANVAS_TOO_LONG;
    return "";
  }
  // A selection action runs at once; a whole-document one shows what's sent
  // (and its estimate) first.
  function ask(req) {
    setPanelError("");
    setSeedHold(null);
    setMenu(null);
    if (!canAsk) return;
    const whole = req.action === "summarize" || req.action === "consistent" || (req.action === "custom" && !selected);
    if (!whole && !selected) return setPanelError("Select some text in the canvas first.");
    if (whole) {
      setConfirm(req);
      setStep("confirm");
      // Bring the preview and Send into view.
      requestAnimationFrame(() => document.querySelector(".canvas-sees")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      return;
    }
    send(req);
  }
  // The confirm step's preview: masked with a copy of Veil's state, so
  // previewing adds no placeholders; sending uses the real state and gives
  // the same ones.
  const preview = useMemo(() => {
    if (!confirm || !doc) return null;
    const copy = structuredClone(veilState.current);
    const built = requestFor(confirm, veiling ? (s) => veil(s, copy, veilWords).text : (s) => s);
    const problem = problemWith(confirm, built);
    return { built, problem, text: problem ? "" : canvasUserText(built.payload) };
  }, [confirm, text, veiling, veilWords, chosen]);
  const quote = useMemo(
    () => (step === "confirm" && preview && !preview.problem && live && model && isReleased(config, "estimates") ? { canvas: preview.built.payload, model } : null),
    [step, preview, live, model, config],
  );
  const estimate = useCreditEstimate(quote);

  async function send(req, { allowSeed = false } = {}) {
    if (!canAsk) return;
    let masked = 0;
    const mask = veiling
      ? (s) => {
          const r = veil(s, veilState.current, veilWords);
          masked += r.count;
          return r.text;
        }
      : (s) => s;
    // Seed Guard reads what would be sent, before anything is.
    if (!allowSeed && seedLive) {
      const plainBuilt = requestFor(req, (s) => s);
      const p = plainBuilt.payload;
      const hit = scanSecrets(p.text, p.before || "", p.after || "", p.instruction || "");
      if (hit) {
        setSeedHold({ req, hit });
        return;
      }
    }
    const built = requestFor(req, mask);
    const problem = problemWith(req, built);
    if (problem) return setPanelError(problem);
    setSeedHold(null);
    setConfirm(null);
    setPanelError("");
    const base = text;
    const id = uid();
    const label = req.action === "tone" ? `${LABELS.tone}: ${toneLabel(req.tone)}` : LABELS[req.action];
    const entry = {
      id,
      label,
      instruction: req.action === "custom" ? req.instruction : "",
      scope: built.payload.scope,
      chars: built.payload.scope === "selection" ? built.original.length : base.length,
      model: chosen?.name || model,
      private: privateOn,
      masked: veiling ? masked : null,
      sent: canvasUserText(built.payload),
      status: "sending",
      received: 0,
    };
    setLog((l) => [...l, entry]);
    setSending({ region: built.region, scope: built.payload.scope });
    setStep("sending");
    if (req.action === "custom") setInstruction("");
    const ctl = new AbortController();
    controller.current = ctl;
    let reply = "",
      finish = null,
      receipt = null,
      failure = null;
    const update = (patch) => setLog((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    try {
      await streamChat(
        {
          canvas: built.payload,
          model,
          ephemeral: true,
          requestId: id,
          ...(privateOn ? { private: true } : {}),
          ...(allowSeed ? { allow_seed_phrase: true } : {}),
          ...(trailLive ? { veil_masked: veiling ? masked : null } : {}),
        },
        (event) => {
          const choice = event.choices?.[0];
          if (typeof choice?.delta?.content === "string" && reply.length < 400000) {
            reply += choice.delta.content;
            if (mounted.current) update({ received: reply.length });
          }
          if (typeof choice?.finish_reason === "string") finish = choice.finish_reason;
          if (event.anonyma && Number.isFinite(event.anonyma.credits_charged)) {
            receipt = event.anonyma;
            finish = event.anonyma.finish_reason || finish;
          }
          if (event.error) failure = event.error;
        },
        ctl.signal,
      );
      if (failure) throw Object.assign(Error(failure.message || "The suggestion failed."), { code: failure.code });
      const read = readCanvasReply(reply, { finish: finish || "stop", original: built.payload.text });
      if (!read.ok) throw Error(read.reason === "length" ? CANVAS_LENGTH : CANVAS_UNREADABLE);
      if (!mounted.current || latest.current.doc?.id !== doc.id) return;
      const result = unveil(read.text, veilState.current.map);
      const parts =
        req.action === "summarize"
          ? trackChanges("", summaryInsertText(base, built.region.start, result))
          : trackChanges(built.original, result);
      const total = changesIn(parts).length;
      update({ status: total ? "review" : "none", total, credits: receipt?.credits_charged });
      if (total)
        setReview({ parts, region: built.region, decisions: {}, base, logId: id, whole: req.action !== "summarize" && built.payload.scope === "document" });
    } catch (err) {
      if (!mounted.current) return;
      const stopped = err.name === "AbortError";
      update({ status: stopped ? "stopped" : "failed", error: stopped ? STOPPED : err.message });
    } finally {
      if (controller.current === ctl) controller.current = null;
      if (mounted.current) {
        setSending(null);
        setStep("idle");
      }
      refresh?.();
    }
  }

  // ---- Reviewing ----
  function decide(id, decision) {
    if (!review) return;
    const decisions = { ...review.decisions, [id]: decision };
    if (allDecided(review.parts, decisions)) finish(decisions);
    else setReview({ ...review, decisions });
  }
  function finish(decisions) {
    const done = finishReview(review.base, review.region, review.parts, decisions);
    const counts = decisionCounts(review.parts, decisions);
    setLog((l) => l.map((x) => (x.id === review.logId ? { ...x, status: "done", accepted: counts.accepted, total: counts.total } : x)));
    setReview(null);
    // The new text is selected, ready for another suggestion; after a
    // whole-document one, the cursor goes back to the start instead.
    edit(done.text, { select: review.whole ? { start: 0, end: 0 } : { start: done.start, end: done.end } });
  }
  useEffect(() => {
    if (!review) return;
    const first = changesIn(review.parts)[0];
    requestAnimationFrame(() => document.getElementById(`cv-change-${first?.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }, [review?.logId]);

  // ---- Export ----
  const stem = fileStem(title);
  async function exportAs(kind) {
    setMenu(null);
    if (kind === "md") download(`${stem}.md`, text, "text/markdown");
    else if (kind === "docx") {
      try {
        const { default: JSZip } = await import("jszip");
        download(`${stem}.docx`, await docxBytes(JSZip, text), DOCX_TYPE);
      } catch {
        setNotice({ kind: "error", text: "The Word file couldn't be made. Try Markdown instead." });
      }
    } else setPrinting(true);
  }

  // ---- Rendering ----
  const counts = review ? decisionCounts(review.parts, review.decisions) : null;
  const saveLine =
    !doc || doc.store === "demo"
      ? demo
        ? "Demo: nothing is saved"
        : ""
      : {
          saved: doc.store === "account" ? "Saved" : doc.store === "tab" ? "Kept in this tab" : "Saved on this device",
          saving: "Saving…",
          unsaved: "Not saved yet",
          locked: "Device Vault is locked: not saved",
          blocked: "Not saved: Seed Guard",
          conflict: "Changed elsewhere",
          error: "Not saved",
        }[saveState.status];
  const docList = (
    <DocList
      docs={docs}
      loading={live && serverList === null}
      current={doc?.id}
      live={live}
      vaultOn={vaultOn}
      vault={vault}
      menu={menu}
      setMenu={setMenu}
      onNew={create}
      onOpen={(id) => id !== doc?.id && goTo(id)}
      onRemove={setRemoving}
      onUnlockVault={onUnlockVault}
    />
  );

  return (
    <section className="canvas-page">
      <div className="canvas-head">
        <div>
          <p className="eyebrow">WRITE WITH AI BESIDE YOU</p>
          <h1>Canvas</h1>
        </div>
        <p>
          Select text and ask for a change. Every suggestion comes back as
          tracked changes you accept or reject, and only your selection and a
          little text around it go to the AI.
        </p>
      </div>
      {!live && !demo && <Notice>Sign in to keep canvases and get suggestions.</Notice>}
      {notice?.kind === "error" && <Notice type="error">{notice.text}</Notice>}
      {notice?.kind === "locked" && (
        <div className="notice error canvas-locked" role="alert">
          <Icon name="lock" size={17} />
          <span>Device Vault is locked. Unlock it to open this canvas.</span>
          <button type="button" className="small-button" onClick={() => onUnlockVault?.()}>
            Unlock
          </button>
        </div>
      )}
      {listError && <Notice type="error">{listError}</Notice>}
      <div className={"canvas-grid" + (doc ? " open" : "") + (demo ? " nolist" : "")}>
        {!demo && docList}
        {doc ? (
          <div className="canvas-editor">
            <div className="canvas-docbar">
              <input
                className="canvas-title"
                data-i18n="off"
                aria-label="Canvas title"
                value={title}
                maxLength={CANVAS_LIMITS.title}
                disabled={doc.store === "demo"}
                onChange={(e) => setDoc((d) => ({ ...d, title: e.target.value, autoTitle: false }))}
                onBlur={() => !title.trim() && setDoc((d) => ({ ...d, title: DEFAULT_TITLE }))}
              />
              <div className="canvas-docmeta">
                {doc.store !== "demo" && <span className={"canvas-tag " + doc.store}>{PLACES[doc.store].tag}</span>}
                {doc.expires && <span className="canvas-expiry">{retentionLabel(doc.expires)}</span>}
                <span className={"canvas-save " + saveState.status} title={saveState.message || ""}>
                  {saveState.status === "saving" ? <Icon name="refresh" size={12} /> : saveState.status === "saved" ? <Icon name="check" size={12} /> : null}
                  {saveLine}
                </span>
              </div>
            </div>
            {saveState.status === "blocked" && (
              <Notice type="error">
                Seed Guard: this canvas looks like it holds a wallet seed phrase, so it isn't being saved to your account. Remove it to keep saving, or export the canvas.
              </Notice>
            )}
            {saveState.status === "error" && <Notice type="error">{saveState.message}</Notice>}
            {saveState.status === "locked" && (
              <div className="notice error canvas-locked" role="alert">
                <Icon name="lock" size={17} />
                <span>Device Vault is locked. Unlock it to keep saving this canvas.</span>
                <button type="button" className="small-button" onClick={() => onUnlockVault?.()}>
                  Unlock
                </button>
              </div>
            )}
            {saveState.status === "conflict" && (
              <div className="notice error canvas-conflict" role="alert">
                <Icon name="warning" size={17} />
                <span>This canvas was changed in another tab or on another device, so your latest edits aren't saved.</span>
                <span className="canvas-notice-actions">
                  <button type="button" className="small-button" onClick={() => resolveConflict(false)}>
                    Load the other version
                  </button>
                  <button type="button" className="small-button" onClick={() => resolveConflict(true)}>
                    Keep my version
                  </button>
                </span>
              </div>
            )}
            <div className="canvas-toolbar" role="toolbar" aria-label="Formatting">
              <div className="canvas-tools">
                {[
                  ["bold", "bold", "Bold (Ctrl or ⌘ B)"],
                  ["italic", "italic", "Italic (Ctrl or ⌘ I)"],
                  ["heading", "heading", "Heading"],
                  ["list", "list", "Bulleted list"],
                  ["numbered", "numbered", "Numbered list"],
                  ["quote", "quote", "Quote"],
                  ["link", "link", "Link (Ctrl or ⌘ K)"],
                ].map(([kind, icon, label]) => (
                  <button key={kind} type="button" aria-label={label} title={label} disabled={!editable} onMouseDown={(e) => e.preventDefault()} onClick={() => format(kind)}>
                    <Icon name={icon} size={15} />
                  </button>
                ))}
                <span className="canvas-sep" />
                <button type="button" aria-label="Undo" title="Undo (Ctrl or ⌘ Z)" disabled={!editable || !history.past.length} onClick={undo}>
                  <Icon name="undo" size={15} />
                </button>
                <button type="button" aria-label="Redo" title="Redo (Ctrl or ⌘ Shift Z)" disabled={!editable || !history.future.length} onClick={redo}>
                  <Icon name="redo" size={15} />
                </button>
              </div>
              <div className="canvas-tools right">
                <div className="canvas-switch" role="group" aria-label="View">
                  <button type="button" className={view === "write" ? "on" : ""} aria-pressed={view === "write"} disabled={!!review || busy} onClick={() => setView("write")}>
                    Write
                  </button>
                  <button type="button" className={view === "preview" ? "on" : ""} aria-pressed={view === "preview"} disabled={!!review || busy} onClick={() => setView("preview")}>
                    Preview
                  </button>
                </div>
                <div className="canvas-menu-wrap">
                  <button type="button" className="canvas-secondary" aria-expanded={menu === "export"} onClick={() => setMenu(menu === "export" ? null : "export")}>
                    <Icon name="download" size={14} />
                    Export
                  </button>
                  {menu === "export" && (
                    <div className="canvas-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => exportAs("md")}>
                        <b>Markdown</b>
                        <small>A .md file, exactly as written</small>
                      </button>
                      <button type="button" role="menuitem" onClick={() => exportAs("docx")}>
                        <b>Word (DOCX)</b>
                        <small>Headings, lists, bold, italic and links; no author details</small>
                      </button>
                      <button type="button" role="menuitem" onClick={() => exportAs("print")}>
                        <b>Print or PDF</b>
                        <small>Choose Save as PDF in the print dialog</small>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
            {review && (
              <div className="canvas-reviewbar" role="status">
                <span>
                  <b>{counts.total === 1 ? "1 suggested change" : `${n(counts.total)} suggested changes`}</b>
                  {counts.open < counts.total && <small>{counts.open === 1 ? "1 left to decide" : `${n(counts.open)} left to decide`}</small>}
                </span>
                <span className="canvas-reviewbar-actions">
                  {/* Decisions already made stay; these settle the rest. */}
                  <button type="button" className="button" onClick={() => finish({ ...decideAll(review.parts, "accept"), ...review.decisions })}>
                    <Icon name="check" size={14} />
                    {counts.open < counts.total ? "Accept the rest" : "Accept all"}
                  </button>
                  <button type="button" className="canvas-secondary" onClick={() => finish({ ...decideAll(review.parts, "reject"), ...review.decisions })}>
                    <Icon name="close" size={14} />
                    {counts.open < counts.total ? "Reject the rest" : "Reject all"}
                  </button>
                </span>
              </div>
            )}
            {review ? (
              <ReviewText review={review} onDecide={decide} />
            ) : busy && sending ? (
              <div className="canvas-paper canvas-pending" data-i18n="off" aria-busy="true">
                {sending.scope === "selection" ? (
                  <>
                    <span className="canvas-outside">{text.slice(0, sending.region.start)}</span>
                    <mark className="canvas-sending">{text.slice(sending.region.start, sending.region.end)}</mark>
                    <span className="canvas-outside">{text.slice(sending.region.end)}</span>
                  </>
                ) : (
                  <mark className="canvas-sending whole">{text}</mark>
                )}
              </div>
            ) : view === "preview" ? (
              <div className="canvas-paper canvas-preview prose markdown" data-i18n="off">
                {text.trim() ? (
                  <ReplyMarkdown remarkPlugins={[remarkGfm]} components={shieldOn ? shieldMarkdown() : undefined}>
                    {text}
                  </ReplyMarkdown>
                ) : (
                  <p className="canvas-empty-line">Nothing to preview yet.</p>
                )}
              </div>
            ) : (
              <textarea
                ref={area}
                className="canvas-paper canvas-text"
                // A textarea's text is never translated (i18n.js NO_TEXT); its
                // placeholder is.
                aria-label="Canvas text (Markdown)"
                spellCheck
                value={text}
                maxLength={CANVAS_LIMITS.content}
                placeholder="Start writing, or paste a draft. Select any part and ask for a change."
                onChange={(e) => edit(e.target.value, { typing: true })}
                onSelect={(e) => setSel({ start: e.target.selectionStart, end: e.target.selectionEnd })}
                onKeyDown={onKeyDown}
              />
            )}
            <p className="canvas-count">
              {(() => {
                const words = wordCount(text);
                return `${words === 1 ? "1 word" : `${n(words)} words`} · ${text.length === 1 ? "1 character" : `${n(text.length)} characters`}`;
              })()}
            </p>
          </div>
        ) : (
          !demo && (
            <div className="canvas-start">
              <h2>Start a canvas</h2>
              <p>Write or paste a draft, then select any part and ask the AI to improve it. Nothing changes until you accept it.</p>
              <div className="canvas-start-actions">
                <button type="button" className="button" disabled={!live} onClick={() => create("account")}>
                  <Icon name="plus" size={15} />
                  New canvas
                </button>
                <button type="button" className="canvas-secondary" disabled={!live} onClick={() => create("account", SAMPLE_CANVAS, titleFrom(SAMPLE_CANVAS))}>
                  <Icon name="canvas" size={15} />
                  Try a sample
                </button>
              </div>
              <ul className="canvas-promises">
                <li>
                  <b>Tracked changes</b>
                  <span>Each suggestion shows every word it would change. Accept or reject them one by one, or all at once.</span>
                </li>
                <li>
                  <b>Only the selection goes out</b>
                  <span>The AI gets what you selected and a little text around it. Whole-document actions show you exactly what's sent first.</span>
                </li>
                <li>
                  <b>Yours to keep, or not</b>
                  <span>Keep a canvas on your account, off the record in this tab, or encrypted on this device with Device Vault.</span>
                </li>
              </ul>
            </div>
          )
        )}
        {doc && (
          <aside className="canvas-panel" aria-label="Suggestions">
            <div className="canvas-panel-head">
              <b>Suggestions</b>
              <small>Off the record · each one billed as a message</small>
            </div>
            {!live ? (
              <p className="canvas-note">{demo ? "Sign in to get suggestions. In the demo, you can write and export." : "Sign in to get suggestions."}</p>
            ) : (
              <>
                <div className="canvas-controls">
                  <label className="canvas-model">
                    <span>Model</span>
                    <select value={model} disabled={busy || !choices.length} onChange={(e) => setModel(e.target.value)}>
                      {choices.map((m) => (
                        <option key={m.id} value={m.id} data-i18n="off">
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="canvas-toggles">
                    {privateLive && (
                      <PrivateModeToggle
                        active={privateOn}
                        disabled={busy}
                        onToggle={() => {
                          setPrivateOn((on) => !on);
                          if (!privateOn && veilLive) setVeilOn(true);
                        }}
                      />
                    )}
                    {veilLive && (
                      <VeilToggle
                        on={veilOn || privateOn}
                        onToggle={() => {
                          if (!busy && !privateOn) setVeilOn((v) => !v);
                        }}
                      />
                    )}
                  </div>
                </div>
                {noPrivate && <NoPrivateModelsNotice />}
                <div className={"canvas-scope" + (selected ? " on" : "")}>
                  <Icon name={selected ? "check" : "canvas"} size={14} />
                  <span>
                    {selected
                      ? selected === 1
                        ? "1 character selected"
                        : `${n(selected)} characters selected`
                      : "Select text in the canvas to use these."}
                  </span>
                </div>
                <div className="canvas-actions">
                  {ACTIONS.map(([action, label]) => (
                    <button key={action} type="button" disabled={!canAsk || !selected} onClick={() => ask({ action })}>
                      {label}
                    </button>
                  ))}
                  <div className="canvas-menu-wrap">
                    <button type="button" disabled={!canAsk || !selected} aria-expanded={menu === "tone"} onClick={() => setMenu(menu === "tone" ? null : "tone")}>
                      Change tone
                      <Icon name="down" size={13} />
                    </button>
                    {menu === "tone" && (
                      <div className="canvas-menu" role="menu">
                        {TONES.map(([tone, label]) => (
                          <button key={tone} type="button" role="menuitem" onClick={() => ask({ action: "tone", tone })}>
                            <b>{label}</b>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <p className="canvas-note">Only your selection and up to 600 characters on each side are sent.</p>
                <div className="canvas-actions whole">
                  <button type="button" disabled={!canAsk || !text.trim()} onClick={() => ask({ action: "summarize" })}>
                    Summarise on top
                  </button>
                  <button type="button" disabled={!canAsk || !text.trim()} onClick={() => ask({ action: "consistent" })}>
                    Make consistent
                  </button>
                </div>
                <p className="canvas-note">These send the whole document. You see what's sent first.</p>
                {step === "confirm" && preview && (
                  <div className="canvas-sees">
                    <h3>
                      <Icon name="eye" size={15} />
                      What the AI sees
                    </h3>
                    {preview.problem ? (
                      <Notice type="error">{preview.problem}</Notice>
                    ) : (
                      <>
                        <p>{`${LABELS[confirm.action]}: the whole document, ${n(preview.built.payload.text.length)} characters, plus ANONYMA's fixed instructions. Nothing else.`}</p>
                        <pre data-i18n="off">{preview.text}</pre>
                        {veiling && <p className="canvas-note">Veil is on: details it recognises are masked before sending, as shown.</p>}
                        <p className="canvas-note canvas-data">
                          <SentAsDataTag />
                          <span>The document is marked as data, not instructions.</span>
                        </p>
                        <details>
                          <summary>Show the fixed instructions</summary>
                          <pre data-i18n="off">{CANVAS_SYSTEM}</pre>
                        </details>
                      </>
                    )}
                    <div className="canvas-confirm">
                      <button type="button" className="button" disabled={!!preview.problem} onClick={() => send(confirm)}>
                        {`Send to ${chosen?.name || "the model"}`}
                      </button>
                      <button
                        type="button"
                        className="canvas-secondary"
                        onClick={() => {
                          setConfirm(null);
                          setStep("idle");
                        }}
                      >
                        Cancel
                      </button>
                      {quote && <CreditEstimate state={estimate} />}
                    </div>
                  </div>
                )}
                {seedHold && (
                  <SeedGuardNotice
                    hit={seedHold.hit}
                    busy={busy}
                    onProceed={seedHold.hit.kind === "seed" ? () => send(seedHold.req, { allowSeed: true }) : undefined}
                  />
                )}
                {panelError && <Notice type="error">{panelError}</Notice>}
                <ol className="canvas-log" aria-live="polite">
                  {log.map((item) => (
                    <LogItem key={item.id} item={item} onStop={() => controller.current?.abort()} />
                  ))}
                </ol>
                <form
                  className="canvas-ask"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (instruction.trim()) ask({ action: "custom", instruction: instruction.trim() });
                  }}
                >
                  <textarea
                    rows={2}
                    value={instruction}
                    maxLength={CANVAS_LIMITS.instruction}
                    disabled={!canAsk}
                    aria-label="Your instruction"
                    placeholder={selected ? "Ask for a change to the selection…" : "Ask for a change to the whole document…"}
                    onChange={(e) => setInstruction(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.form.requestSubmit();
                      }
                    }}
                  />
                  <button type="submit" className="button" aria-label="Ask" disabled={!canAsk || !instruction.trim()}>
                    <Icon name="send" size={15} />
                  </button>
                </form>
                <p className="canvas-note">{selected ? "Applies to your selection." : "Nothing selected: this sends the whole document, and you see it first."}</p>
              </>
            )}
          </aside>
        )}
      </div>
      {removing && (
        <Modal title="Delete this canvas?" onClose={() => setRemoving(null)}>
          <div className="canvas-dialog">
            <p>
              <b data-i18n="off">{removing.title}</b>
            </p>
            <p>{removing.store === "account" ? "It's deleted from your account at once. This can't be undone." : removing.store === "tab" ? "It's cleared from this tab. This can't be undone." : "It's deleted from Device Vault on this device. This can't be undone."}</p>
            <div className="canvas-dialog-actions">
              <button type="button" className="button danger" onClick={() => remove(removing)}>
                Delete
              </button>
              <button type="button" className="canvas-secondary" onClick={() => setRemoving(null)}>
                Keep it
              </button>
            </div>
          </div>
        </Modal>
      )}
      {printing && doc && <PrintView title={title} text={text} shieldOn={shieldOn} onClose={() => setPrinting(false)} />}
    </section>
  );
}

function DocList({ docs, loading, current, live, vaultOn, vault, menu, setMenu, onNew, onOpen, onRemove, onUnlockVault }) {
  const vaultReady = vaultOn && vault?.unlocked;
  return (
    <nav className="canvas-docs" aria-label="Your canvases">
      <div className="canvas-docs-head">
        <b>Your canvases</b>
        <div className="canvas-menu-wrap">
          <button type="button" className="canvas-new" disabled={!live} aria-expanded={menu === "new"} onClick={() => setMenu(menu === "new" ? null : "new")}>
            <Icon name="plus" size={14} />
            New
          </button>
          {menu === "new" && (
            <div className="canvas-menu wide" role="menu">
              {["account", "tab", "vault"].map((where) =>
                where === "vault" && !vaultOn ? null : (
                  <button
                    key={where}
                    type="button"
                    role="menuitem"
                    onClick={() => (where === "vault" && !vaultReady ? (setMenu(null), onUnlockVault?.()) : onNew(where))}
                  >
                    <b>{PLACES[where].label}</b>
                    <small>
                      {where !== "vault" || vaultReady
                        ? PLACES[where].note
                        : vault?.status === "none"
                          ? "Set up Device Vault first, then choose this again."
                          : "Unlock Device Vault first, then choose this again."}
                    </small>
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      </div>
      {loading ? (
        <p className="canvas-docs-hint">Loading…</p>
      ) : !docs.length ? (
        <p className="canvas-docs-hint">No canvases yet.</p>
      ) : (
        <ul>
          {docs.map((d) => (
            <li key={d.id} className={d.id === current ? "current" : ""}>
              <button type="button" className="canvas-doc" onClick={() => onOpen(d.id)}>
                <span className="canvas-doc-title" data-i18n="off">
                  {d.title}
                </span>
                <span className="canvas-doc-meta">
                  <span className={"canvas-tag " + d.store}>{PLACES[d.store].tag}</span>
                  {d.expires ? <span>{retentionLabel(d.expires)}</span> : null}
                </span>
              </button>
              <button type="button" className="canvas-doc-delete" aria-label="Delete this canvas" title="Delete this canvas" onClick={() => onRemove(d)}>
                <Icon name="delete" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {vaultOn && !vault?.unlocked && vault?.status === "locked" && (
        <button type="button" className="canvas-docs-vault" onClick={() => onUnlockVault?.()}>
          <Icon name="unlock" size={13} />
          Unlock Device Vault to see its canvases
        </button>
      )}
    </nav>
  );
}

// A whitespace-only change would be invisible, so it shows a mark.
const shown = (s) => (s && !s.trim() ? (s.includes("\n") ? "¶" + s : "·") : s);
// Line breaks that end an open change (a new paragraph, say) go after its
// buttons, so the buttons stay on the change's own line.
const tailOf = (s) => (s.trim() ? /\s*$/.exec(s)[0] : "");
function ReviewText({ review, onDecide }) {
  const { base, region, parts, decisions } = review;
  return (
    // The document's words are never translated; the buttons are.
    <div className="canvas-paper canvas-review">
      <span className="canvas-outside" data-i18n="off">
        {base.slice(0, region.start)}
      </span>
      {parts.map((p, i) => {
        if (p.kind === "same")
          return (
            <span key={i} data-i18n="off">
              {p.text}
            </span>
          );
        const open = !decisions[p.id];
        const tail = open ? tailOf(p.ins || p.del) : "";
        const cut = (s) => (tail && s.endsWith(tail) ? s.slice(0, -tail.length) : s);
        return (
          <span key={i} id={`cv-change-${p.id}`} className={"canvas-change " + (decisions[p.id] || "open")}>
            {decisions[p.id] !== "accept" && p.del && <del data-i18n="off">{shown(p.ins ? p.del : cut(p.del))}</del>}
            {decisions[p.id] !== "reject" && p.ins && <ins data-i18n="off">{shown(cut(p.ins))}</ins>}
            {open && (
              <span className="canvas-change-tools">
                <button type="button" className="accept" aria-label="Accept this change" title="Accept this change" onClick={() => onDecide(p.id, "accept")}>
                  <Icon name="check" size={12} />
                </button>
                <button type="button" className="reject" aria-label="Reject this change" title="Reject this change" onClick={() => onDecide(p.id, "reject")}>
                  <Icon name="close" size={12} />
                </button>
              </span>
            )}
            {tail && (
              <span className={p.ins ? "canvas-tail ins" : "canvas-tail"} data-i18n="off">
                {tail}
              </span>
            )}
          </span>
        );
      })}
      <span className="canvas-outside" data-i18n="off">
        {base.slice(region.end)}
      </span>
    </div>
  );
}

function LogItem({ item, onStop }) {
  const where = item.scope === "selection" ? (item.chars === 1 ? "1 character selected" : `${n(item.chars)} characters selected`) : "Whole document";
  return (
    <li className={"canvas-log-item " + item.status}>
      <div className="canvas-log-ask">
        <b>{item.label}</b>
        {item.instruction && <q data-i18n="off">{item.instruction}</q>}
        <small>{where}</small>
      </div>
      <div className="canvas-log-reply">
        {item.status === "sending" ? (
          <>
            <span>{item.received ? `Writing… ${n(item.received)} characters` : "Waiting for the model…"}</span>
            <button type="button" className="canvas-secondary small" onClick={onStop}>
              <Icon name="stop" size={12} />
              Stop
            </button>
          </>
        ) : item.status === "review" ? (
          <span>{item.total === 1 ? "1 change suggested. Accept or reject it in the canvas." : `${n(item.total)} changes suggested. Accept or reject each in the canvas.`}</span>
        ) : item.status === "done" ? (
          <span>{item.accepted === item.total ? (item.total === 1 ? "Accepted the change." : `Accepted all ${n(item.total)} changes.`) : item.accepted === 0 ? "Rejected the suggestion." : `Accepted ${n(item.accepted)} of ${n(item.total)} changes.`}</span>
        ) : item.status === "none" ? (
          <span>No changes suggested.</span>
        ) : (
          <span className="canvas-log-error">{item.error}</span>
        )}
      </div>
      <div className="canvas-log-meta">
        <span data-i18n="off">{item.model}</span>
        {Number.isFinite(item.credits) && <span>{`${formatCredits(item.credits)} credits`}</span>}
        {item.private && <span>Zero data retention</span>}
        {item.masked > 0 && <span>{item.masked === 1 ? "1 detail masked" : `${n(item.masked)} details masked`}</span>}
        <span>Not saved</span>
      </div>
      <details className="canvas-log-sent">
        <summary>What was sent</summary>
        <pre data-i18n="off">{item.sent}</pre>
      </details>
    </li>
  );
}

// The canvas alone, ready for the print dialog (Save as PDF). Rendered with
// the shared reply renderer, so remote images wait behind Injection Shield.
function PrintView({ title, text, shieldOn, onClose }) {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("canvas-printing");
    const was = document.title;
    document.title = title || DEFAULT_TITLE;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      root.classList.remove("canvas-printing");
      document.title = was;
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return createPortal(
    <div className="canvas-print-root" role="dialog" aria-modal="true" aria-label="Print view">
      <div className="canvas-print-toolbar">
        <button type="button" className="small-button" onClick={onClose}>
          Back
        </button>
        <span>In the print dialog, choose Save as PDF to keep a PDF copy.</span>
        <button type="button" className="button" onClick={() => window.print()}>
          <Icon name="printer" size={15} />
          Print or save as PDF
        </button>
      </div>
      <article className="canvas-print-page prose markdown" data-i18n="off">
        <ReplyMarkdown remarkPlugins={[remarkGfm]} components={shieldOn ? shieldMarkdown() : undefined}>
          {text}
        </ReplyMarkdown>
      </article>
    </div>,
    document.body,
  );
}
