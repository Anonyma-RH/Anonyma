import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Icon, Notice } from "./ui.jsx";
import { t, useLanguage } from "./i18n.js";
import { api, copyText, download, isReleased, readStore, saveStore, streamChat, uid } from "./lib.js";
import { CleanImageChip } from "./CleanUploads.jsx";
import { RedactChipTools, RedactEditor, redactReleased } from "./Redact.jsx";
import { PrivacyTrail, privacyTrailReleased } from "./PrivacyTrail.jsx";
import { PrivateModeToggle, privateModeReleased } from "./PrivateMode.jsx";
import { SeedGuardNotice, seedGuardLive } from "./SeedGuard.jsx";
import { SecretGuardNotice, useSecretGuard, useSecretScan } from "./SecretGuard.jsx";
import { maskSecrets, removeSecrets, secretGuardTurn } from "./secret-guard.js";
import { LivePreview } from "./LivePreview.jsx";
import { VeilToggle } from "./Veil.jsx";
import { createVeilState, veil } from "./veil.js";
import { scanSecrets, isSoft } from "./seed-guard.js";
import { useShieldLive } from "./Shield.jsx";
import { cleanText, scanText, shieldSummary } from "./shield.js";
import { useCreditEstimate } from "./CreditEstimate.jsx";
import { formatCredits } from "./estimate.js";
import { pickPreset } from "./model-finder.js";
import { withKeep } from "./clean-notes.js";
import { PhotoError, shrinkToFit } from "./photo-tools.js";
import {
  IMAGE_MIMES,
  MAX_INSTRUCTION_CHARS,
  MAX_NOTES_CHARS,
  MAX_PAGE_BLOCK,
  MAX_VERSIONS,
  MIN_INSTRUCTION_CHARS,
  SITE_PAGE_TOO_LONG_TO_CHANGE,
  externalRefs,
  pageBlock,
  pageTitle,
  readPage,
  stripExternal,
} from "./site-spec.js";
import {
  MODEL_KEY,
  SAVE_KEY,
  SiteImageError,
  addVersion,
  labelFor,
  labelText,
  makePayload,
  newVersion,
  pageFileName,
  pastedImage,
  seenText,
  siteCopy,
  sizeText,
  versionsFromConversation,
} from "./shot-to-site.js";
import "./shot-to-site.css";

// Screenshot to site (update "shottosite"): the page at /workspace/screenshot.
// A picture (a screenshot, a sketch, a wireframe) is cleaned of hidden
// details, can be redacted, and is redrawn small in this browser; one vision
// model turns it into ONE self-contained HTML file, shown in Live Preview's
// sandbox (allow-scripts only, network blocked): the same frame Code & Build
// uses, never a second one. "Change it" sends the current page as data plus
// your words, and every result is a version you can go back to. Making and
// changing a page is an off-the-record chat request held at exactly the
// maximum shown (server/shot-to-site.js). Only the pages are ever saved, as a
// conversation in Code & Build's mode (server/routes/shot-to-site.js), never
// the picture. The saved page is in the address (?page=), so a reload opens it.

const BLOCKED_REDACT =
  "Metadata couldn't be removed from an image. Redact it to send a redrawn copy, tick Keep original to send it as it is, or remove it.";
const BLOCKED_PLAIN =
  "Metadata couldn't be removed from an image. Tick Keep original to send it as it is, or remove it.";
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const PICTURE = { "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP" };
// How much of what the model is sent is shown under "What the AI sees".
const SEEN_CHARS = 2400;

async function plainAttachment(file) {
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new SiteImageError("This picture couldn't be read."));
    reader.readAsDataURL(file);
  });
  return { name: file.name, url, cleanUrl: url, originalUrl: url, clean: null, keep: false };
}

// One picture: chosen (or pasted), cleaned, redrawn small. Used for the
// first picture and for the optional one on a change.
function useImageSlot({ cleanLive, mounted }) {
  const [photo, setPhoto] = useState(null),
    [copy, setCopy] = useState(null),
    [reading, setReading] = useState(false),
    [redacting, setRedacting] = useState(false),
    [error, setError] = useState("");
  const token = useRef(0);
  async function pick(file) {
    if (!file || reading) return;
    const mine = ++token.current;
    setError("");
    setReading(true);
    try {
      if (!IMAGE_MIMES.includes(file.type)) throw new SiteImageError("Use a PNG, JPEG or WebP picture.");
      let opened = file;
      try {
        opened = await shrinkToFit(file);
      } catch (e) {
        throw new SiteImageError(
          e instanceof PhotoError
            ? "This picture couldn't be opened here. Try a PNG, JPEG or WebP under 40 MiB."
            : "This picture couldn't be opened here.",
        );
      }
      const item = cleanLive
        ? await (await import("./clean-uploads.js")).prepareImageAttachment(opened)
        : await plainAttachment(opened);
      if (item.error) throw new SiteImageError(item.error);
      if (mounted.current && mine === token.current) setPhoto(item);
    } catch (e) {
      if (mounted.current && mine === token.current)
        setError(e instanceof SiteImageError ? e.message : "This picture couldn't be opened here.");
    } finally {
      if (mounted.current && mine === token.current) setReading(false);
    }
  }
  const forget = () => {
    token.current++;
    setPhoto(null);
    setCopy(null);
    setError("");
    setReading(false);
  };
  // The copy that is sent: redrawn small here (and again after a redaction).
  const url = photo?.url || null;
  useEffect(() => {
    if (!url) return setCopy(null);
    let alive = true;
    setCopy({ for: url, status: "working" });
    siteCopy(url).then(
      (c) => alive && setCopy({ for: url, status: "ready", ...c }),
      (e) => alive && setCopy({ for: url, status: "error", message: e instanceof SiteImageError ? e.message : "A smaller copy of this picture couldn't be made." }),
    );
    return () => {
      alive = false;
    };
  }, [url]);
  const ready = copy?.for === url && copy.status === "ready" ? copy : null;
  return { photo, setPhoto, copy, ready, reading, redacting, setRedacting, error, setError, pick, forget };
}

export default function ShotToSite({ demo, user, models = [], config, refresh, veilOn, setVeilOn, veilWords }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  // The words typed into the boxes are the person's own (never translated),
  // but their placeholders are ours.
  useLanguage();
  const live = !demo && !!user;
  const remembered = useMemo(() => readStore(SAVE_KEY, {}) || {}, []);
  const cleanLive = isReleased(config, "cleanuploads");
  const redactOn = redactReleased(config);
  const seedLive = seedGuardLive(config);
  const veilLive = isReleased(config, "veil");
  const trailLive = privacyTrailReleased(config);
  const offRecordLive = isReleased(config, "ephemeral");
  const privateLive = privateModeReleased(config);
  const codeLive = isReleased(config, "code");
  const shieldOn = useShieldLive(config);
  const uncensored = config?.releases?.uncensoredModels || [];

  const mounted = useRef(true),
    controller = useRef(null),
    input = useRef(null),
    followInput = useRef(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const first = useImageSlot({ cleanLive, mounted });
  const follow = useImageSlot({ cleanLive, mounted });

  const [notes, setNotes] = useState(""),
    [instruction, setInstruction] = useState(""),
    [model, setModel] = useState(() => readStore(MODEL_KEY, "")),
    [privateOn, setPrivateOn] = useState(false),
    [keep, setKeep] = useState(remembered.keep === "none" ? "none" : "history"),
    [versions, setVersions] = useState([]),
    [at, setAt] = useState(0),
    [pageId, setPageId] = useState(null),
    [busy, setBusy] = useState(null),
    [progress, setProgress] = useState(0),
    [error, setError] = useState(""),
    [info, setInfo] = useState(""),
    [saveNote, setSaveNote] = useState(""),
    [view, setView] = useState("preview"),
    [copied, setCopied] = useState(false),
    [seedOk, setSeedOk] = useState(false),
    [dragging, setDragging] = useState(false),
    [pages, setPages] = useState(null),
    [opening, setOpening] = useState(false),
    [receipt, setReceipt] = useState(null);

  // ---- Models, Veil, Private Mode ----
  const privacyOn = privateLive && privateOn;
  const readers = useMemo(
    () => models.filter((m) => m.type === "chat" && m.callable && m.vision && !m.imageCapable && !m.sealed && !uncensored.includes(m.id)),
    [models, config],
  );
  const canPrivate = readers.some((m) => m.private);
  const choices = useMemo(() => readers.filter((m) => !privacyOn || m.private), [readers, privacyOn]);
  useEffect(() => {
    if (!models.length) return;
    setModel((prev) =>
      choices.some((m) => m.id === prev) ? prev : pickPreset(choices, "balanced", { mode: "chat" })?.id || choices[0]?.id || "",
    );
  }, [choices, models.length]);
  useEffect(() => {
    if (model) saveStore(MODEL_KEY, model);
  }, [model]);
  const modelName = (id) => models.find((m) => m.id === id)?.name || id;
  // Private Mode keeps nothing; otherwise the person's choice.
  const offRecord = privacyOn || (keep === "none" && offRecordLive);
  const saveLive = live && codeLive && !offRecord;
  const veiling = veilLive && live && (!!veilOn || privacyOn);

  // ---- The page on screen ----
  const current = versions[Math.min(at, versions.length - 1)] || null;
  const html = current?.html || "";
  const title = useMemo(() => (html ? pageTitle(html) : ""), [html]);
  const files = useMemo(() => (html ? [{ path: "index.html", content: html }] : []), [html]);
  const outside = useMemo(() => (html ? externalRefs(html) : []), [html]);
  const changing = versions.length > 0;
  const tooBigToChange = !!html && pageBlock(html).length > MAX_PAGE_BLOCK;

  // The address carries the saved page, so a reload opens it.
  const patch = (changes) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        for (const [key, value] of Object.entries(changes)) value == null ? next.delete(key) : next.set(key, value);
        return next;
      },
      { replace: true },
    );

  // ---- Words: Seed Guard, Veil ----
  const words = (changing ? instruction : notes).trim();
  const seedHit = seedLive && words ? scanSecrets(words) : null;
  useEffect(() => setSeedOk(false), [words]);
  const seedBlocked = !!seedHit && !(isSoft(seedHit) && seedOk);
  const veiled = useMemo(() => (veiling && words ? veil(words, createVeilState(), veilWords).count : 0), [veiling, words, veilWords]);
  const active = changing ? follow : first;
  // Secret Guard: a password, key or token in the notes or the change holds
  // the page (and its estimate, which posts the same words), after Seed
  // Guard's notice, until it's masked, removed or sent anyway. Masked, the
  // model and the page see a placeholder like [SECRET_1].
  const secretLive = useSecretGuard(config, user, demo);
  const secretFinds = useSecretScan(secretLive, words);
  const [secretOk, setSecretOk] = useState(false),
    [secretQueued, setSecretQueued] = useState(null);
  useEffect(() => setSecretOk(false), [words]);
  const secretHeld = secretFinds.length > 0 && !secretOk;
  const secretTurn = secretGuardTurn({ seedHit: seedBlocked ? seedHit : null, finds: secretHeld ? secretFinds : [] });
  const setWords = changing ? setInstruction : setNotes;

  // ---- The quote: exactly what a run would hold ----
  const changeText = instruction.trim();
  const shieldScan = useMemo(() => (shieldOn && html ? scanText(html) : null), [shieldOn, html]);
  const sentHtml = useMemo(() => (shieldScan ? cleanText(html, shieldScan) : html), [html, shieldScan]);
  const quoteBody = useMemo(() => {
    if (!live || !model || seedBlocked || secretHeld || veiled > 0) return null;
    if (!changing) {
      if (!first.ready) return null;
      return { model, shottosite: makePayload({ task: "make", image: first.ready, notes, quote: true }) };
    }
    if (tooBigToChange || changeText.length < MIN_INSTRUCTION_CHARS) return null;
    if (follow.photo && !follow.ready) return null;
    return {
      model,
      shottosite: makePayload({ task: "change", html: sentHtml, instruction: changeText, image: follow.ready, quote: true }),
    };
  }, [live, model, seedBlocked, secretHeld, veiled, changing, first.ready, notes, tooBigToChange, changeText, sentHtml, follow.photo, follow.ready]);
  const estimate = useCreditEstimate(quoteBody);
  const over = estimate.status === "ready" && estimate.available != null && estimate.credits > estimate.available;
  const limited = estimate.status === "ready" && !over && estimate.room != null && estimate.credits > estimate.room;

  const blocked = (slot) => slot.photo && !slot.photo.url;
  const canRun =
    live &&
    !busy &&
    !!model &&
    estimate.status === "ready" &&
    !over &&
    !limited &&
    !seedBlocked &&
    !secretHeld &&
    veiled === 0 &&
    !!quoteBody &&
    !blocked(active);

  // ---- Saving ----
  async function persist(list) {
    if (!list.length || !saveLive) return null;
    try {
      const r = await api("/api/site-pages", {
        method: "POST",
        body: {
          ...(pageId ? { id: pageId } : {}),
          versions: list.map((v) => ({ label: v.label, html: v.html, ...(v.requestId ? { request_id: v.requestId } : {}) })),
        },
      });
      if (!mounted.current) return r.id;
      setPageId(r.id);
      patch({ page: r.id });
      const done = new Set(list.map((v) => v.id));
      setVersions((all) => all.map((v) => (done.has(v.id) ? { ...v, saved: true } : v)));
      setSaveNote("");
      return r.id;
    } catch (e) {
      if (mounted.current)
        setSaveNote(
          e?.code === "seed_phrase_blocked"
            ? "This page holds what looks like a seed phrase, so it wasn't saved. Download it instead."
            : "This page couldn't be saved to your history. It's here to download.",
        );
      return null;
    }
  }

  // ---- Running ----
  async function run(task) {
    if (!canRun) return;
    saveStore(SAVE_KEY, { keep });
    setError("");
    setInfo("");
    setSaveNote("");
    setBusy(task);
    setProgress(0);
    const ctl = new AbortController();
    controller.current = ctl;
    const maker = task === "make";
    const payload = makePayload({
      task,
      image: maker ? first.ready : follow.ready,
      notes,
      html: sentHtml,
      instruction: changeText,
    });
    const label = labelFor(task, { notes, instruction: changeText });
    const requestId = uid();
    let text = "",
      done = null,
      failure = null;
    try {
      await streamChat(
        {
          shottosite: payload,
          model,
          ephemeral: true,
          requestId,
          ...(privacyOn ? { private: true } : {}),
          ...(trailLive ? { veil_masked: veiling ? veiled : null } : {}),
        },
        (event) => {
          if (Number.isInteger(event.shottosite?.chars) && mounted.current) setProgress(event.shottosite.chars);
          const delta = event.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && text.length < 400000) text += delta;
          if (event.anonyma && Number.isFinite(event.anonyma.credits_charged)) done = event.anonyma;
          if (event.error) failure = event.error;
        },
        ctl.signal,
      );
      if (failure) throw Object.assign(Error(failure.message || "The model request failed."), { code: failure.code });
      const read = readPage(text, { finishReason: done?.finish_reason ?? null });
      if (!read.html) throw Error("The model's reply wasn't a web page this tool can show.");
      if (!mounted.current) return;
      const version = newVersion({
        html: read.html,
        label,
        model,
        credits: done?.credits_charged ?? null,
        requestId,
        notes: read.notes,
      });
      const list = addVersion(versions, version);
      setVersions(list);
      setAt(list.length - 1);
      setView("preview");
      setReceipt({ credits: done?.credits_charged, privacy: done?.privacy || null, testMode: !!done?.local_test });
      // The picture stays in this tab (never on the server) to compare with
      // the page, until "New page"; the extra picture of a change goes.
      if (!maker) {
        setInstruction("");
        follow.forget();
      }
      setInfo(maker ? `Made with ${modelName(model)}.` : `Changed with ${modelName(model)}.`);
      if (saveLive) await persist(list.filter((v) => !v.saved));
    } catch (e) {
      if (!mounted.current) return;
      setError(
        e?.name === "AbortError"
          ? maker
            ? "Stopped. Nothing was made, and nothing was charged."
            : "Stopped. The page wasn't changed, and nothing was charged."
          : e?.message || "The model request failed.",
      );
    } finally {
      if (controller.current === ctl) controller.current = null;
      if (mounted.current) setBusy(null);
      refresh?.();
    }
  }
  const stop = () => controller.current?.abort();
  // Secret Guard's Mask and send, or Send anyway: the page is made once the
  // estimate for the words as they now are is in (never on a stale one).
  useEffect(() => {
    if (!secretQueued) return;
    if (canRun && !(secretQueued === "change" && tooBigToChange)) {
      setSecretQueued(null);
      run(secretQueued);
    } else if (busy || estimate.status === "unavailable" || over || limited) setSecretQueued(null);
  }, [secretQueued, canRun, busy, estimate.status, over, limited]);

  // ---- A saved page, opened from the address or the list ----
  const wanted = params.get("page");
  useEffect(() => {
    if (!live || !wanted || wanted === pageId) return;
    let alive = true;
    setOpening(true);
    api("/api/conversations/" + encodeURIComponent(wanted)).then(
      (c) => {
        if (!alive) return;
        const list = versionsFromConversation(c);
        if (!list.length) {
          setError("That page wasn't found. It may have been deleted.");
          patch({ page: null });
        } else {
          setVersions(list);
          setAt(list.length - 1);
          setPageId(wanted);
          setError("");
          setInfo("");
          setReceipt(null);
        }
        setOpening(false);
      },
      () => {
        if (!alive) return;
        setError("That page wasn't found. It may have been deleted.");
        patch({ page: null });
        setOpening(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [live, wanted]);
  // The pages already saved, on the start screen.
  useEffect(() => {
    if (!live || !codeLive || changing) return;
    let alive = true;
    api("/api/site-pages").then(
      (r) => alive && setPages(r.data || []),
      () => alive && setPages([]),
    );
    return () => {
      alive = false;
    };
  }, [live, codeLive, changing]);

  function newPage() {
    if (busy) return;
    controller.current?.abort();
    first.forget();
    follow.forget();
    setVersions([]);
    setAt(0);
    setPageId(null);
    setNotes("");
    setInstruction("");
    setError("");
    setInfo("");
    setSaveNote("");
    setReceipt(null);
    patch({ page: null });
  }

  // ---- Picture input: drop, paste, choose ----
  const slotRef = useRef(active);
  slotRef.current = active;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    if (!live) return;
    const onPaste = (e) => {
      const file = pastedImage(e);
      if (!file || busyRef.current) return;
      e.preventDefault();
      slotRef.current.pick(file);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [live]);
  async function pasteFromClipboard(slot) {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => IMAGE_MIMES.includes(t));
        if (type) return slot.pick(new File([await item.getType(type)], "pasted." + EXT[type], { type }));
      }
      slot.setError("There's no picture on the clipboard.");
    } catch {
      slot.setError("This browser didn't allow reading the clipboard. Press Ctrl+V or ⌘V on this page instead.");
    }
  }
  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file && !busy) active.pick(file);
  }

  // ---- What can be done with the page ----
  const goBack = () => setAt((i) => Math.max(0, i - 1));
  const goForward = () => setAt((i) => Math.min(versions.length - 1, i + 1));
  async function copyCode() {
    if (await copyText(html)) {
      setCopied(true);
      setTimeout(() => mounted.current && setCopied(false), 1600);
    }
  }
  function removeOutside() {
    const cleaned = stripExternal(html);
    const read = readPage(cleaned);
    if (!read.html || read.html === html) return;
    const version = newVersion({ html: read.html, label: "Removed the outside links" });
    const list = addVersion(versions, version);
    setVersions(list);
    setAt(list.length - 1);
    setInfo("Took the outside links out. Nothing was sent or charged.");
    if (saveLive) persist(list.filter((v) => !v.saved));
  }
  async function openInCode() {
    let id = pageId;
    if (!id) id = await persist(versions.filter((v) => !v.saved));
    if (id) navigate("/workspace/code?c=" + encodeURIComponent(id));
  }

  // ---- Signed out or demo ----
  if (!live)
    return (
      <section className="sts-page">
        <Head />
        <div className="sts-signin">
          <span className="sts-icon" aria-hidden="true">
            <Icon name="site" size={20} />
          </span>
          <div>
            <b>{demo ? "The demo doesn't build pages." : "Sign in to use Screenshot to site."}</b>
            <small>A model builds the page, so this needs an account with credits. Nothing is sent until you press the button, and you see the most it can cost first.</small>
          </div>
          {!demo && (
            <Link className="button" to="/login?next=/workspace/screenshot">
              Sign in
            </Link>
          )}
        </div>
        <Promises />
      </section>
    );

  const noModels = !choices.length && models.length > 0;
  const seenPayload = quoteBody
    ? makePayload(
        changing
          ? { task: "change", html: sentHtml, instruction: changeText, image: follow.ready, quote: true }
          : { task: "make", image: first.ready, notes, quote: true },
      )
    : null;
  const seen = seenPayload ? seenText({ ...seenPayload, image: seenPayload.image ? { url: "" } : undefined }) : "";
  return (
    <section
      className={"sts-page" + (dragging ? " dragging" : "")}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <Head compact={changing} />
      {error && <Notice type="error">{error}</Notice>}
      <div className="sts-grid">
        <div className="sts-panel">
          {!changing ? (
            <>
              <div className="sts-step">
                <h2>
                  <span>1</span>Picture
                </h2>
                <PicturePicker slot={first} busy={!!busy} input={input} onPaste={() => pasteFromClipboard(first)} redactOn={redactOn} />
              </div>
              <div className="sts-step">
                <h2>
                  <span>2</span>Notes and model
                </h2>
                <label className="sts-field">
                  <span>Notes (optional)</span>
                  <textarea
                    value={notes}
                    maxLength={MAX_NOTES_CHARS}
                    rows={3}
                    disabled={!!busy}
                    data-i18n="off"
                    placeholder={t("Use my brand blue, make it responsive")}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </label>
                <ModelPicker choices={choices} model={model} setModel={setModel} busy={!!busy} models={models} noModels={noModels} privacyOn={privacyOn} />
              </div>
              <div className="sts-step">
                <h2>
                  <span>3</span>Keep the page
                </h2>
                <Keep keep={keep} setKeep={setKeep} busy={!!busy} privacyOn={privacyOn} offRecordLive={offRecordLive} codeLive={codeLive} />
                <PrivateRow privateLive={privateLive} privacyOn={privacyOn} canPrivate={canPrivate} busy={!!busy} onToggle={() => setPrivateOn((v) => !v)} ready={models.length > 0} />
              </div>
            </>
          ) : (
            <>
              <div className="sts-step">
                <div className="sts-page-head">
                  <div>
                    <p className="sts-eyebrow">YOUR PAGE</p>
                    <b className="sts-page-title" data-i18n="off">
                      {title}
                    </b>
                  </div>
                  <button type="button" className="sts-secondary" disabled={!!busy} onClick={newPage}>
                    <Icon name="plus" size={14} />
                    New page
                  </button>
                </div>
              </div>
              <div className="sts-step">
                <h2>
                  <span>
                    <Icon name="canvas" size={12} />
                  </span>
                  Change it
                </h2>
                {tooBigToChange ? (
                  <p className="sts-block">
                    <Icon name="warning" size={14} />
                    <span>{SITE_PAGE_TOO_LONG_TO_CHANGE}</span>
                  </p>
                ) : (
                  <>
                    <label className="sts-field">
                      <span>What should change?</span>
                      <textarea
                        value={instruction}
                        maxLength={MAX_INSTRUCTION_CHARS}
                        rows={3}
                        disabled={!!busy}
                        data-i18n="off"
                        placeholder={t("Make the buttons rounder and the heading blue")}
                        onChange={(e) => setInstruction(e.target.value)}
                      />
                    </label>
                    <div className="sts-extra">
                      {follow.photo ? (
                        <div className="sts-chip">
                          <div className="attachment-list">
                            <CleanImageChip item={follow.photo} onKeep={(k) => follow.setPhoto((p) => withKeep(p, k))} onRemove={follow.forget}>
                              {redactOn && <RedactChipTools item={follow.photo} disabled={!!busy} onOpen={() => follow.setRedacting(true)} />}
                            </CleanImageChip>
                          </div>
                          {blocked(follow) && <small className="sts-note warn">{redactOn ? BLOCKED_REDACT : BLOCKED_PLAIN}</small>}
                        </div>
                      ) : (
                        <div className="sts-row">
                          <button type="button" className="sts-secondary" disabled={!!busy || follow.reading} onClick={() => followInput.current?.click()}>
                            <Icon name="image" size={14} />
                            {follow.reading ? "Reading the picture on this device…" : "Add a picture (optional)"}
                          </button>
                        </div>
                      )}
                      {follow.error && <small className="sts-note warn">{follow.error}</small>}
                      <input
                        ref={followInput}
                        type="file"
                        hidden
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) follow.pick(file);
                        }}
                      />
                      <small className="sts-note">Only the page's code and your words are sent, unless you add a picture.</small>
                    </div>
                  </>
                )}
                <ModelPicker choices={choices} model={model} setModel={setModel} busy={!!busy} models={models} noModels={noModels} privacyOn={privacyOn} />
              </div>
              <div className="sts-step">
                <h2>
                  <span>
                    <Icon name="history" size={12} />
                  </span>
                  Versions
                </h2>
                <ol className="sts-versions" aria-label="Versions">
                  {versions.map((v, i) => (
                    <li key={v.id}>
                      <button type="button" className={i === at ? "on" : ""} aria-current={i === at ? "true" : undefined} disabled={!!busy} onClick={() => setAt(i)}>
                        <b>{`Version ${i + 1}`}</b>
                        <span data-i18n="off">{labelText(v.label, t)}</span>
                        {v.credits != null && <small>{`${formatCredits(v.credits)} credits`}</small>}
                      </button>
                    </li>
                  ))}
                </ol>
                <p className="sts-fine">
                  <Icon name="shield" size={13} />
                  <span>{`The newest ${MAX_VERSIONS} versions are kept. Going back to one is free; changing it makes a new version.`}</span>
                </p>
              </div>
            </>
          )}
          {seedHit && <SeedGuardNotice hit={seedHit} busy={!!busy} hardOverride={false} onProceed={() => setSeedOk(true)} />}
          <SecretGuardNotice
            finds={secretTurn === "secret" ? secretFinds : []}
            busy={!!busy || !!secretQueued}
            note="Mask swaps each one for a placeholder like [SECRET_1] in your words before anything is sent. The page keeps the placeholder; put the real value in after you download it."
            onMask={() => {
              setWords((w) => maskSecrets(w, {}).text);
              setSecretQueued(changing ? "change" : "make");
            }}
            onRemove={() => setWords((w) => removeSecrets(w).text)}
            onProceed={() => {
              setSecretOk(true);
              setSecretQueued(changing ? "change" : "make");
            }}
          />
          {veilLive && (
            <div className="sts-veil">
              <VeilToggle on={veiling} onToggle={() => !privacyOn && setVeilOn?.((v) => !v)} />
              <span>
                {veiling
                  ? "Veil is on. It can't hide details inside a picture, so a page is made only if your words hold nothing Veil would mask."
                  : "Veil is off: the model sees your words as written."}
              </span>
            </div>
          )}
          {veiled > 0 && (
            <div className="sts-block" role="alert">
              <Icon name="warning" size={14} />
              <span>
                {veiled === 1
                  ? "Veil would mask 1 detail in these words, and a page needs them as written. Remove it, or turn Veil off."
                  : `Veil would mask ${veiled} details in these words, and a page needs them as written. Remove them, or turn Veil off.`}
              </span>
              {!privacyOn && (
                <button type="button" className="small-button" onClick={() => setVeilOn?.(false)}>
                  Turn Veil off
                </button>
              )}
            </div>
          )}
          {seenPayload && (
            <details className="sts-sees">
              <summary>What the AI sees</summary>
              <p>
                The picture (redrawn small), this text and fixed instructions, nothing else: no other chats, memory, project or standing instructions.
              </p>
              <pre data-i18n="off">{seen.length > SEEN_CHARS ? seen.slice(0, SEEN_CHARS) + "\n…" : seen}</pre>
            </details>
          )}
          {changing && shieldScan && shieldSummary(shieldScan).invisible > 0 && (
            <Notice>Injection Shield took invisible characters out of the page before it was sent, and the page is sent as data, not instructions.</Notice>
          )}
          <div className="sts-run">
            <p className="sts-cost" role="status">
              {estimate.status === "ready" ? (
                <>
                  <b>{`Up to ${formatCredits(estimate.credits)} credits`}</b>
                  {" · exactly what's held; you're charged only for a usable page"}
                  {over && <b className="sts-short"> · over your balance</b>}
                  {limited && <b className="sts-short"> · over your spending limit</b>}
                </>
              ) : estimate.status === "unavailable" ? (
                estimate.message
              ) : estimate.status === "loading" ? (
                "Working out the most it can cost…"
              ) : changing ? (
                "Say what to change to see the most it can cost."
              ) : (
                "Choose a picture to see the most it can cost."
              )}
            </p>
            <div className="sts-actions">
              {busy ? (
                <button type="button" className="button" onClick={stop}>
                  <Icon name="stop" size={15} />
                  Stop
                </button>
              ) : changing ? (
                <button type="button" className="button" disabled={!canRun || tooBigToChange} onClick={() => run("change")}>
                  <Icon name="canvas" size={15} />
                  Change the page
                </button>
              ) : (
                <button type="button" className="button" disabled={!canRun} onClick={() => run("make")}>
                  <Icon name="site" size={15} />
                  Make the page
                </button>
              )}
            </div>
          </div>
          <p className="sts-fine stacked">
            <span>Your picture goes to the model with its hidden details removed here first. ANONYMA doesn't keep it; only the page can be saved.</span>
            {redactOn && <span>You can black out parts of it before it's sent.</span>}
            <span>A model builds the page, so check it. A page you can't use costs nothing.</span>
          </p>
        </div>

        <div className="sts-stage">
          {busy ? (
            <Working task={busy} progress={progress} name={modelName(model)} />
          ) : current ? (
            <Result
              title={title}
              files={files}
              html={html}
              view={view}
              setView={setView}
              at={at}
              count={versions.length}
              onBack={goBack}
              onForward={goForward}
              current={current}
              pictureUrl={first.photo?.url || first.photo?.originalUrl || null}
              models={models}
              outside={outside}
              onRemoveOutside={removeOutside}
              onCopy={copyCode}
              copied={copied}
              pageId={pageId}
              saveLive={saveLive}
              offRecord={offRecord}
              codeLive={codeLive}
              onOpenCode={openInCode}
              info={info}
              saveNote={saveNote}
              receipt={receipt}
              trailLive={trailLive}
              onRetrySave={() => persist(versions.filter((v) => !v.saved))}
              unsaved={versions.some((v) => !v.saved)}
            />
          ) : opening ? (
            <p className="sts-fine">Opening your page…</p>
          ) : first.photo ? (
            <Preview slot={first} />
          ) : (
            <Idle pages={pages} onOpen={(id) => patch({ page: id })} />
          )}
        </div>
      </div>
      {first.redacting && first.photo && (
        <RedactEditor
          item={first.photo}
          onCancel={() => first.setRedacting(false)}
          onApply={(next) => {
            first.setPhoto(next);
            first.setRedacting(false);
          }}
        />
      )}
      {follow.redacting && follow.photo && (
        <RedactEditor
          item={follow.photo}
          onCancel={() => follow.setRedacting(false)}
          onApply={(next) => {
            follow.setPhoto(next);
            follow.setRedacting(false);
          }}
        />
      )}
    </section>
  );
}

function Head({ compact = false }) {
  return (
    <div className={"sts-head" + (compact ? " compact" : "")}>
      <div>
        <p className="sts-eyebrow">SCREENSHOT TO SITE</p>
        <h1>Drop a screenshot. Get a working page.</h1>
        <p>A sketch or a wireframe works too. See the page, change it with words and download it. You see the price before anything runs, and a page you can't use costs nothing.</p>
      </div>
    </div>
  );
}

function Promises() {
  return (
    <ul className="sts-promises">
      <li>
        <b>Cleaned here first</b>
        <span>Hidden details such as location and camera are removed in your browser, and you can black out parts of a picture before it goes anywhere.</span>
      </li>
      <li>
        <b>Shown in a sandbox</b>
        <span>The page runs with no network and no access to your account. Its forms and links go nowhere.</span>
      </li>
      <li>
        <b>Nothing kept you didn't ask for</b>
        <span>ANONYMA doesn't keep your picture. The page goes to your history, or nowhere if you go off the record.</span>
      </li>
    </ul>
  );
}

function PicturePicker({ slot, busy, input, onPaste, redactOn }) {
  const { photo, copy, reading } = slot;
  return (
    <>
      {photo ? (
        <div className="sts-chip">
          <div className="attachment-list">
            <CleanImageChip item={photo} onKeep={(k) => slot.setPhoto((p) => withKeep(p, k))} onRemove={slot.forget}>
              {redactOn && <RedactChipTools item={photo} disabled={busy} onOpen={() => slot.setRedacting(true)} />}
            </CleanImageChip>
          </div>
          {!photo.url && <small className="sts-note warn">{redactOn ? BLOCKED_REDACT : BLOCKED_PLAIN}</small>}
          <div className="sts-row">
            <button type="button" className="sts-secondary" disabled={busy || reading} onClick={() => input.current?.click()}>
              <Icon name="upload" size={14} />
              Choose another
            </button>
            <button type="button" className="sts-secondary" disabled={busy || reading} onClick={onPaste}>
              <Icon name="copy" size={14} />
              Paste from clipboard
            </button>
          </div>
        </div>
      ) : (
        <div className={"sts-drop" + (reading ? " busy" : "")}>
          <span className="sts-icon" aria-hidden="true">
            <Icon name="image" size={20} />
          </span>
          <b>{reading ? "Reading the picture on this device…" : "Drop a picture here"}</b>
          <small>PNG, JPEG or WebP. Paste one with Ctrl+V or ⌘V. It's redrawn smaller here before it's sent.</small>
          <div className="sts-row center">
            <button type="button" className="button" disabled={reading} onClick={() => input.current?.click()}>
              <Icon name="upload" size={15} />
              Choose a picture
            </button>
            <button type="button" className="sts-secondary" disabled={reading} onClick={onPaste}>
              <Icon name="copy" size={14} />
              Paste from clipboard
            </button>
          </div>
        </div>
      )}
      {photo?.url && copy?.status === "working" && <small className="sts-note">Redrawing the picture smaller…</small>}
      {photo?.url && copy?.status === "error" && <small className="sts-note warn">{copy.message}</small>}
      {photo?.url && copy?.status === "ready" && (
        <small className="sts-note">{`Sent to the model as a ${PICTURE[copy.mime]} of ${sizeText(copy.chars)}.`}</small>
      )}
      {slot.error && <small className="sts-note warn">{slot.error}</small>}
      <input
        ref={input}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) slot.pick(file);
        }}
      />
    </>
  );
}

function ModelPicker({ choices, model, setModel, busy, models, noModels, privacyOn }) {
  return (
    <>
      <label className="sts-field">
        <span>Model</span>
        <select value={model} disabled={busy || !choices.length} onChange={(e) => setModel(e.target.value)}>
          {!models.length && <option value="">Loading…</option>}
          {noModels && <option value="">None available right now</option>}
          {choices.map((m) => (
            <option key={m.id} value={m.id} data-i18n="off">
              {m.name}
            </option>
          ))}
        </select>
      </label>
      {noModels && (
        <small className="sts-note warn">
          {privacyOn ? "No private model can read images right now." : "No model that can read images is available right now."}
        </small>
      )}
    </>
  );
}

function Keep({ keep, setKeep, busy, privacyOn, offRecordLive, codeLive }) {
  return (
    <>
      <label className="sts-field">
        <span>Where it goes</span>
        <select value={privacyOn || !codeLive ? "none" : keep} disabled={busy || privacyOn || !offRecordLive || !codeLive} onChange={(e) => setKeep(e.target.value)}>
          {codeLive && <option value="history">In your history, to reopen and change</option>}
          {offRecordLive && <option value="none">Nowhere: off the record, download only</option>}
        </select>
      </label>
      <p className="sts-fine">
        <Icon name="lock" size={13} />
        <span>Pages are never kept in Device Vault: they're saved to your history or nowhere.</span>
      </p>
    </>
  );
}

function PrivateRow({ privateLive, privacyOn, canPrivate, busy, onToggle, ready }) {
  if (!privateLive) return null;
  return (
    <div className="sts-veil">
      <PrivateModeToggle active={privacyOn} disabled={busy || !canPrivate} onToggle={onToggle} />
      <span>
        {canPrivate
          ? "Private mode: only models with zero data retention, nothing saved, Veil on."
          : ready
            ? "Private mode isn't available for pictures: no model with zero data retention can read images."
            : "Checking which models offer zero data retention…"}
      </span>
    </div>
  );
}

// What the page can do, before a picture is chosen.
function Idle({ pages, onOpen }) {
  return (
    <div className="sts-idle">
      <ol className="sts-how">
        <li>
          <span className="sts-icon" aria-hidden="true">
            <Icon name="image" size={18} />
          </span>
          <b>Drop a picture</b>
          <span>A screenshot of a page you like, a sketch on paper or a wireframe from a design tool.</span>
        </li>
        <li>
          <span className="sts-icon" aria-hidden="true">
            <Icon name="site" size={18} />
          </span>
          <b>Get one page</b>
          <span>One HTML file with its own styles. One page only, with no backend or sign-in. It looks like your picture and works at phone width.</span>
        </li>
        <li>
          <span className="sts-icon" aria-hidden="true">
            <Icon name="canvas" size={18} />
          </span>
          <b>Change it with words</b>
          <span>Ask for another colour or layout. Every version is kept, and going back is free.</span>
        </li>
      </ol>
      {pages?.length > 0 && (
        <section className="sts-pages" aria-label="Your pages">
          <h2>Your pages</h2>
          <ul>
            {pages.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => onOpen(p.id)}>
                  <b data-i18n="off">{p.title}</b>
                  <small>{p.versions === 1 ? "1 version" : `${p.versions} versions`}</small>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Promises />
    </div>
  );
}

function Preview({ slot }) {
  const url = slot.photo.url || slot.photo.originalUrl;
  return (
    <figure className="sts-preview">
      <div className="sts-frame">
        <img src={url} alt="Your picture" />
      </div>
      <figcaption>
        <span>Your picture</span>
        {slot.ready && <span>{`${slot.ready.width} × ${slot.ready.height} px`}</span>}
      </figcaption>
    </figure>
  );
}

function Working({ task, progress, name }) {
  return (
    <div className="sts-working" role="status">
      <span className="sts-spinner" aria-hidden="true" />
      <b>{task === "make" ? "Building the page…" : "Changing the page…"}</b>
      <small>
        <span data-i18n="off">{name}</span>
      </small>
      {progress > 0 && <small>{`${progress.toLocaleString("en-US")} characters written so far`}</small>}
      <small>The page appears once it's complete. Nothing is charged unless a usable page comes back.</small>
    </div>
  );
}

function Result({
  title,
  files,
  html,
  view,
  setView,
  at,
  count,
  onBack,
  onForward,
  current,
  pictureUrl,
  models,
  outside,
  onRemoveOutside,
  onCopy,
  copied,
  pageId,
  saveLive,
  offRecord,
  codeLive,
  onOpenCode,
  info,
  saveNote,
  receipt,
  trailLive,
  onRetrySave,
  unsaved,
}) {
  const model = models.find((m) => m.id === current.model);
  return (
    <section className="sts-result" aria-label="Result">
      <div className="sts-result-head">
        <div>
          <p className="sts-eyebrow">{`VERSION ${at + 1} OF ${count}`}</p>
          <p className="sts-meta">
            <span data-i18n="off">{title}</span>
            <span>{sizeText(html.length)}</span>
            {current.model && <span data-i18n="off">{model?.name || current.model}</span>}
            {current.credits != null && <span>{`${formatCredits(current.credits)} credits`}</span>}
          </p>
        </div>
        <div className="sts-undo" role="group" aria-label="Versions">
          <button type="button" className="sts-secondary" disabled={at === 0} onClick={onBack}>
            <Icon name="undo" size={14} />
            Undo
          </button>
          <button type="button" className="sts-secondary" disabled={at >= count - 1} onClick={onForward}>
            <Icon name="redo" size={14} />
            Redo
          </button>
        </div>
      </div>
      <div className="sts-tabs" role="tablist" aria-label="View">
        <button type="button" role="tab" aria-selected={view === "preview"} className={view === "preview" ? "on" : ""} onClick={() => setView("preview")}>
          <Icon name="eye" size={14} />
          Preview
        </button>
        <button type="button" role="tab" aria-selected={view === "code"} className={view === "code" ? "on" : ""} onClick={() => setView("code")}>
          <Icon name="code" size={14} />
          Code
        </button>
        {pictureUrl && (
          <button type="button" role="tab" aria-selected={view === "picture"} className={view === "picture" ? "on" : ""} onClick={() => setView("picture")}>
            <Icon name="image" size={14} />
            Your picture
          </button>
        )}
      </div>
      {view === "preview" ? (
        <div className="sts-preview-box">
          <LivePreview files={files} />
        </div>
      ) : view === "picture" && pictureUrl ? (
        <div className="sts-frame tall">
          <img src={pictureUrl} alt="Your picture" />
        </div>
      ) : (
        <pre className="sts-code" tabIndex={0} data-i18n="off">
          <code>{html}</code>
        </pre>
      )}
      <div className="sts-toolbar">
        <button type="button" className="button" onClick={() => download(pageFileName(title), html, "text/html")}>
          <Icon name="download" size={15} />
          Download .html
        </button>
        <button type="button" className="sts-secondary" onClick={onCopy}>
          <Icon name={copied ? "check" : "copy"} size={14} />
          {copied ? "Copied" : "Copy the page's code"}
        </button>
        {codeLive && (pageId || saveLive) && (
          <button type="button" className="sts-secondary" onClick={onOpenCode}>
            <Icon name="code" size={14} />
            Open in Code & build
          </button>
        )}
      </div>
      {outside.length > 0 && (
        <div className="sts-block soft" role="status">
          <Icon name="warning" size={14} />
          <span>
            {outside.length === 1
              ? "This page reaches for 1 outside resource, such as a font, a script or a picture. It's blocked in the preview and won't load offline."
              : `This page reaches for ${outside.length} outside resources, such as fonts, scripts or pictures. They're blocked in the preview and won't load offline.`}
          </span>
          <button type="button" className="small-button" onClick={onRemoveOutside}>
            Take them out
          </button>
        </div>
      )}
      <ul className="sts-notes">
        {info && (
          <li>
            <Icon name="check" size={13} />
            <span>{info}</span>
          </li>
        )}
        <li>
          <Icon name={pageId && !unsaved ? "check" : "shield"} size={13} />
          <span>
            {pageId && !unsaved
              ? "Saved to your history as a page you can reopen and change. Deleting it there deletes it here."
              : offRecord
                ? "Off the record: nothing was saved. Download the page before you leave."
                : "Not saved to your history yet."}
          </span>
          {!offRecord && saveLive && unsaved && (
            <button type="button" className="small-button" onClick={onRetrySave}>
              Save it now
            </button>
          )}
        </li>
        {saveNote && (
          <li>
            <Icon name="warning" size={13} />
            <span>{saveNote}</span>
          </li>
        )}
        <li>
          <Icon name="shield" size={13} />
          <span>The preview has no network, so nothing in the page can reach out. Go back to an earlier version with Undo.</span>
        </li>
        <li>
          <Icon name="warning" size={13} />
          <span>The downloaded file is an ordinary web page, no longer in the sandbox: read its code before you trust it.</span>
        </li>
      </ul>
      {receipt?.credits != null && current.credits != null && at === count - 1 && (
        <div className="sts-receipt">
          <div className="receipt">
            <span className="sq" aria-hidden="true" />
            {receipt.testMode ? `Test receipt · ${formatCredits(receipt.credits)} credits charged` : `Receipt · ${formatCredits(receipt.credits)} credits charged`}
          </div>
          {trailLive && receipt.privacy && <PrivacyTrail privacy={receipt.privacy} models={models} />}
        </div>
      )}
    </section>
  );
}
