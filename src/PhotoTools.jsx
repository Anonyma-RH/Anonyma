import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Icon, Modal, Notice } from "./ui.jsx";
import { api, uid, isReleased, readStore, saveStore } from "./lib.js";
import { CleanImageChip } from "./CleanUploads.jsx";
import { RedactChipTools, RedactEditor, redactReleased } from "./Redact.jsx";
import { PrivacyTrail, privacyTrailReleased } from "./PrivacyTrail.jsx";
import { PrivateModeToggle, privateModeReleased } from "./PrivateMode.jsx";
import { VeilToggle } from "./Veil.jsx";
import { createVeilState, veil } from "./veil.js";
import { scanSecrets, seedGuardMessage, isSoft } from "./seed-guard.js";
import { IMAGE_TYPES, HEIC_LIMIT, isHeicFile, withKeep } from "./clean-notes.js";
import { formatBytes } from "./documents.js";
import {
  CHOICES,
  PROMPT_MAX,
  PhotoError,
  TOOLS,
  TOOL_INFO,
  price,
  dataUrlBlob,
  fitLongSide,
  resultName,
  shrinkToFit,
  sizeNote,
  toolFrom,
} from "./photo-tools.js";
import "./photo-tools.css";

// Photo Tools (update "phototools"): the page at /workspace/photos. A photo
// (a file, or one from the library) is cleaned of hidden details and can be
// redacted in this browser, then goes to one image model to be edited with
// words, cut out or upscaled. server/routes/photo-tools.js holds exactly the
// quoted maximum and charges only for a result that was checked and kept.
// What's on screen is in the address: ?tool=, ?src= (the library photo) and
// ?result= (the saved result), so a reload opens it again.

const BLOCKED_REDACT =
  "Metadata couldn't be removed from an image. Redact it to send a redrawn copy, tick Keep original to send it as it is, or remove it.";
const BLOCKED_PLAIN =
  "Metadata couldn't be removed from an image. Tick Keep original to send it as it is, or remove it.";

// A picture's pixel size, once it has loaded.
function useSize(url) {
  const [size, setSize] = useState(null);
  useEffect(() => {
    setSize(null);
    if (!url) return;
    let alive = true;
    const img = new Image();
    img.onload = () => alive && setSize({ width: img.naturalWidth, height: img.naturalHeight });
    img.src = url;
    return () => {
      alive = false;
    };
  }, [url]);
  return size;
}

async function plainAttachment(file) {
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new PhotoError(`"${file.name}" couldn't be read.`));
    reader.readAsDataURL(file);
  });
  return { name: file.name, url, cleanUrl: url, originalUrl: url, clean: null, keep: false };
}

export default function PhotoTools({ demo, user, models = [], config, refresh, veilOn, setVeilOn, veilWords }) {
  const [params, setParams] = useSearchParams();
  const tool = toolFrom(params.get("tool"));
  const live = !demo && !!user;
  const remembered = useMemo(() => readStore(CHOICES, {}) || {}, []);
  const cleanLive = isReleased(config, "cleanuploads");
  const redactOn = redactReleased(config);
  const seedLive = isReleased(config, "seedguard");
  const veilLive = isReleased(config, "veil");
  const trailLive = privacyTrailReleased(config);
  const offRecordLive = isReleased(config, "ephemeral");
  const privateLive = privateModeReleased(config);

  const [catalog, setCatalog] = useState({ status: "loading" }),
    [chosen, setChosen] = useState(remembered.models || {}),
    [photo, setPhoto] = useState(null),
    [source, setSource] = useState(null),
    [reading, setReading] = useState(false),
    [dragging, setDragging] = useState(false),
    [prompt, setPrompt] = useState(""),
    [save, setSave] = useState(remembered.save === "none" ? "none" : "library"),
    [privateOn, setPrivateOn] = useState(false),
    [quote, setQuote] = useState({ status: "idle" }),
    [running, setRunning] = useState(false),
    [result, setResult] = useState(null),
    [error, setError] = useState(""),
    [seedOk, setSeedOk] = useState(false),
    [redacting, setRedacting] = useState(false),
    [picking, setPicking] = useState(false),
    // An upscale goes from a copy no bigger than the model takes.
    [copy, setCopy] = useState(null);
  const input = useRef(null),
    controller = useRef(null),
    mounted = useRef(true),
    booted = useRef(false),
    pickToken = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  // The address carries the tool, the library photo and the saved result.
  const patch = (changes) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        for (const [key, value] of Object.entries(changes)) value == null ? next.delete(key) : next.set(key, value);
        return next;
      },
      { replace: true },
    );
  const setTool = (id) => {
    setError("");
    patch({ tool: id === "edit" ? null : id });
  };

  // ---- The tools and their models ----
  useEffect(() => {
    if (!live) return;
    const ctl = new AbortController();
    setCatalog({ status: "loading" });
    api("/api/photo-tools", { signal: ctl.signal }).then(
      (d) => setCatalog({ status: "ready", ...d }),
      (e) => !ctl.signal.aborted && setCatalog({ status: "error", message: e.message }),
    );
    return () => ctl.abort();
  }, [live]);
  const toolData = catalog.status === "ready" ? catalog.tools.find((t) => t.id === tool) : null;
  const canPrivate = catalog.status === "ready" && catalog.private_available;
  const privacyOn = privateLive && privateOn && canPrivate;
  const list = (toolData?.models || []).filter((m) => !privacyOn || m.private);
  const model = list.find((m) => m.id === chosen[tool])?.id || list.find((m) => m.id === toolData?.default)?.id || list[0]?.id || "";
  // An upscaler makes the photo 4x bigger on each side, so it takes a photo
  // only up to this long side (the server names it per model).
  const maxSide = tool === "upscale" ? list.find((m) => m.id === model)?.max_side || 1024 : null;
  // Private Mode keeps nothing; otherwise the person's choice.
  const offRecord = privacyOn || (save === "none" && offRecordLive);
  const info = TOOL_INFO[tool];

  // ---- The copy an upscale goes from ----
  const photoUrl = photo?.url || null;
  useEffect(() => {
    if (!maxSide || !photoUrl) return setCopy(null);
    let alive = true;
    setCopy({ for: photoUrl, max: maxSide, status: "working" });
    fitLongSide(photoUrl, maxSide).then(
      (c) => alive && setCopy({ for: photoUrl, max: maxSide, status: "ready", ...c }),
      (e) => alive && setCopy({ for: photoUrl, max: maxSide, status: "error", message: e instanceof PhotoError ? e.message : "A smaller copy of this photo couldn't be made." }),
    );
    return () => {
      alive = false;
    };
  }, [photoUrl, maxSide]);
  const copyReady = !maxSide || (copy?.for === photoUrl && copy.max === maxSide && copy.status === "ready");

  // ---- The quote: exactly what a run would hold ----
  const body = useMemo(
    () => (model ? { tool, model, ...(privacyOn ? { private: true } : offRecord ? { ephemeral: true } : {}) } : null),
    [tool, model, privacyOn, offRecord],
  );
  const quoteKey = body ? JSON.stringify(body) : "";
  useEffect(() => {
    if (!live || !body) return setQuote({ status: "idle" });
    const ctl = new AbortController();
    setQuote((q) => ({ status: "loading", last: q.status === "ready" ? q : q.last }));
    const timer = setTimeout(async () => {
      try {
        const r = await api("/api/photo-tools/quote", { method: "POST", body, signal: ctl.signal });
        setQuote({ status: "ready", ...r });
      } catch (e) {
        if (e?.name !== "AbortError") setQuote({ status: "unavailable", message: e.message });
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [live, quoteKey]);
  const q = quote.status === "ready" ? quote : quote.status === "loading" ? quote.last : null;

  // ---- Choosing a photo ----
  // `keep`: a reload opening the library photo beside the saved result.
  async function pick(file, sourceId = null, { keep = false } = {}) {
    if (!file || reading || running) return;
    const token = ++pickToken.current;
    setError("");
    if (!keep) setResult(null);
    setReading(true);
    try {
      const heic = isHeicFile(file);
      if (!heic && !IMAGE_TYPES.includes(file.type)) throw new PhotoError("Use a PNG, JPEG, WebP or GIF photo, or a HEIC photo.");
      if (heic && file.size > HEIC_LIMIT) throw new PhotoError(`"${file.name}" is larger than 20 MiB.`);
      const opened = heic ? file : await shrinkToFit(file);
      const item = cleanLive ? await (await import("./clean-uploads.js")).prepareImageAttachment(opened) : await plainAttachment(opened);
      if (item.error) throw new PhotoError(item.error);
      if (!mounted.current || token !== pickToken.current) return;
      setPhoto({ ...item, shrunk: opened !== file ? { from: file.size, to: opened.size } : null });
      setSource(sourceId);
      patch(keep ? { src: sourceId } : { src: sourceId, result: null });
    } catch (e) {
      if (mounted.current && token === pickToken.current) setError(e instanceof PhotoError ? e.message : "This photo couldn't be opened in this browser.");
    } finally {
      if (mounted.current && token === pickToken.current) setReading(false);
    }
  }
  const forget = () => {
    pickToken.current++;
    setPhoto(null);
    setSource(null);
    setResult(null);
    setError("");
    patch({ src: null, result: null });
  };
  // A library picture, fetched from this account and opened like a file.
  async function pickLibrary(id, url, name, options) {
    setPicking(false);
    try {
      const r = await fetch(url, { credentials: "same-origin" });
      if (!r.ok) throw new Error("gone");
      const blob = await r.blob();
      const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[blob.type] || "png";
      await pick(new File([blob], `${name || "library-photo"}.${ext}`, { type: blob.type }), id, options);
    } catch {
      if (mounted.current) {
        setError("That library photo couldn't be opened. It may have been deleted.");
        patch({ src: null });
      }
    }
  }
  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) pick(file);
  }

  // A reload opens what was on screen: the library photo and the result.
  useEffect(() => {
    if (!live || booted.current) return;
    booted.current = true;
    const src = params.get("src"),
      saved = params.get("result");
    if (src) pickLibrary(src, "/api/media/" + encodeURIComponent(src), "library-photo", { keep: !!saved });
    if (saved)
      api("/api/media").then(
        (r) => {
          const m = (r.data || []).find((x) => x.id === saved && x.kind === "image");
          if (!mounted.current) return;
          if (!m) return patch({ result: null });
          setResult({ tool, model: m.model, saved: true, media: m, image: m.url, mime: m.mime, credits: m.cost, reloaded: true });
        },
        () => mounted.current && patch({ result: null }),
      );
  }, [live]);

  // ---- What blocks a run ----
  const words = tool === "edit" ? prompt.trim() : "";
  const seedHit = seedLive && words ? scanSecrets(words) : null;
  useEffect(() => setSeedOk(false), [prompt]);
  const veiling = veilLive && live && (!!veilOn || privacyOn);
  const veiled = useMemo(() => (veiling && words ? veil(words, createVeilState(), veilWords).count : 0), [veiling, words, veilWords]);
  const blockedPhoto = photo && !photo.url;
  const over = q && q.available != null && q.credits > q.available;
  const limited = q?.spending_limit && q.credits > q.spending_limit.remaining;
  const seedBlocked = !!seedHit && !(isSoft(seedHit) && seedOk);
  const canRun =
    live &&
    !running &&
    !reading &&
    !!photo?.url &&
    copyReady &&
    !!model &&
    quote.status === "ready" &&
    !over &&
    !limited &&
    (tool !== "edit" || (!!words && words.length <= PROMPT_MAX)) &&
    !seedBlocked &&
    veiled === 0;

  // ---- Running ----
  async function run() {
    if (!canRun) return;
    saveStore(CHOICES, { models: { ...chosen, [tool]: model }, save });
    setChosen((c) => ({ ...c, [tool]: model }));
    setError("");
    setResult(null);
    setRunning(true);
    controller.current = new AbortController();
    // What's sent, and what the result is compared with: for an upscale, the
    // copy that fits the model.
    const before = maxSide ? copy.url : photo.url,
      name = photo.name,
      shrunkTo = maxSide && copy.scaled ? maxSide : null;
    try {
      const r = await api("/api/photo-tools/run", {
        method: "POST",
        signal: controller.current.signal,
        body: {
          ...body,
          image: before,
          max_units: quote.units,
          requestId: uid(),
          ...(tool === "edit" ? { prompt: words } : {}),
          ...(source ? { source } : {}),
          ...(trailLive ? { veil_masked: veiling ? veiled : null } : {}),
        },
      });
      if (!mounted.current) return;
      setResult({
        tool,
        model: r.model,
        saved: r.saved,
        media: r.media,
        image: r.saved ? r.media.url : r.image,
        mime: r.mime,
        credits: r.receipt?.credits_charged,
        testMode: r.testMode,
        privacy: r.privacy || null,
        before,
        name,
        copy: shrunkTo,
      });
      if (r.saved) patch({ result: r.media.id });
    } catch (e) {
      if (!mounted.current) return;
      setError(
        e?.name === "AbortError"
          ? "Stopped. Nothing was charged."
          : e?.code === "estimate_changed"
            ? "The price changed since it was shown. Check the new one, then try again. Nothing was charged."
            : e.message,
      );
      if (e?.code === "estimate_changed") setQuote({ status: "idle" });
    } finally {
      if (mounted.current) {
        setRunning(false);
        refresh?.();
      }
    }
  }
  const stop = () => controller.current?.abort();

  // A result becomes the next photo, so the tools can be chained.
  async function useResult() {
    if (!result || running) return;
    try {
      // A saved result is fetched from the library; an off-the-record one is
      // already in the page.
      const blob = result.image.startsWith("data:") ? dataUrlBlob(result.image) : await (await fetch(result.image, { credentials: "same-origin" })).blob();
      const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[blob.type] || "png";
      await pick(new File([blob], resultName(result.name, result.tool, blob.type).replace(/\.[a-z]+$/, "") + "." + ext, { type: blob.type }), result.media?.id || null);
    } catch {
      setError("The result couldn't be opened as a new photo.");
    }
  }

  // ---- Signed out or demo ----
  if (!live)
    return (
      <section className="photo-page">
        <Head />
        <div className="photo-signin">
          <span className="photo-icon" aria-hidden="true">
            <Icon name="image" size={20} />
          </span>
          <div>
            <b>{demo ? "The demo doesn't edit photos." : "Sign in to use Photo tools."}</b>
            <small>Photos are processed by a model, so this needs an account with credits. Nothing is sent until you press the button, and you see the most it can cost first.</small>
          </div>
          {!demo && (
            <Link className="button" to="/login?next=/workspace/photos">
              Sign in
            </Link>
          )}
        </div>
        <Promises />
      </section>
    );

  const unavailable = catalog.status === "ready" ? catalog.unavailable || [] : [];
  return (
    <section
      className={"photo-page" + (dragging ? " dragging" : "")}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <Head compact={!!photo} />
      <div className="photo-tabs" role="tablist" aria-label="Photo tools">
        {TOOLS.map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tool === id} className={tool === id ? "on" : ""} disabled={running} onClick={() => setTool(id)}>
            <Icon name={TOOL_INFO[id].icon} size={16} />
            <span>{TOOL_INFO[id].label}</span>
          </button>
        ))}
      </div>
      {unavailable.map((u) => (
        <p key={u.tool} className="photo-fine">
          <Icon name="shield" size={13} />
          <span>
            <b>Extend</b> isn't offered yet. <span>{u.reason}</span>
          </span>
        </p>
      ))}
      {catalog.status === "error" && <Notice type="error">{catalog.message}</Notice>}
      {error && <Notice type="error">{error}</Notice>}
      <div className="photo-grid">
        <div className="photo-panel">
          <div className="photo-step">
            <h2>
              <span>1</span>Photo
            </h2>
            {photo ? (
              <div className="photo-chip">
                <div className="attachment-list">
                  <CleanImageChip item={photo} onKeep={(keep) => setPhoto((p) => withKeep(p, keep))} onRemove={forget}>
                    {redactOn && <RedactChipTools item={photo} disabled={running} onOpen={() => setRedacting(true)} />}
                  </CleanImageChip>
                </div>
                {photo.shrunk && (
                  <small className="photo-note">{`Shrunk in this browser from ${formatBytes(photo.shrunk.from)} to ${formatBytes(photo.shrunk.to)} to fit the 1.5 MB limit.`}</small>
                )}
                {blockedPhoto && <small className="photo-note warn">{redactOn ? BLOCKED_REDACT : BLOCKED_PLAIN}</small>}
                <div className="photo-row">
                  <button type="button" className="photo-secondary" disabled={running || reading} onClick={() => input.current?.click()}>
                    <Icon name="upload" size={14} />
                    Choose another
                  </button>
                  <button type="button" className="photo-secondary" disabled={running || reading} onClick={() => setPicking(true)}>
                    <Icon name="folder" size={14} />
                    From your library
                  </button>
                </div>
              </div>
            ) : (
              <div className={"photo-drop" + (dragging ? " dragging" : "") + (reading ? " busy" : "")}>
                <span className="photo-icon" aria-hidden="true">
                  <Icon name="image" size={20} />
                </span>
                <b>{reading ? "Reading the photo on this device…" : "Drop a photo here"}</b>
                <small>PNG, JPEG, WebP, GIF or HEIC. Bigger than 1.5 MB is shrunk here to fit.</small>
                <div className="photo-row center">
                  <button type="button" className="button" disabled={reading} onClick={() => input.current?.click()}>
                    <Icon name="upload" size={15} />
                    Choose a photo
                  </button>
                  <button type="button" className="photo-secondary" disabled={reading} onClick={() => setPicking(true)}>
                    <Icon name="folder" size={14} />
                    From your library
                  </button>
                </div>
              </div>
            )}
            <input
              ref={input}
              type="file"
              hidden
              accept={"image/png,image/jpeg,image/webp,image/gif" + (cleanLive ? ",image/heic,image/heif,.heic,.heif" : "")}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) pick(file);
              }}
            />
          </div>

          <div className="photo-step">
            <h2>
              <span>2</span>
              {info.label}
            </h2>
            <p className="photo-blurb">{info.blurb}</p>
            {maxSide && (
              <p className="photo-note">
                {copy?.status === "error"
                  ? copy.message
                  : photo && !copyReady
                    ? "Making a smaller copy to upscale…"
                    : `A photo bigger than ${maxSide} px on its long side is shrunk to a copy that size here first, so the result stays a manageable size.`}
              </p>
            )}
            {tool === "edit" && (
              <label className="photo-field">
                <span>What should change?</span>
                <textarea
                  value={prompt}
                  maxLength={PROMPT_MAX}
                  rows={3}
                  placeholder="Make the sky a warm sunset, keep everything else"
                  onChange={(e) => setPrompt(e.target.value)}
                  disabled={running}
                />
              </label>
            )}
            <label className="photo-field">
              <span>Model</span>
              <select value={model} disabled={running || !list.length} onChange={(e) => setChosen((c) => ({ ...c, [tool]: e.target.value }))}>
                {catalog.status === "loading" && <option value="">Loading…</option>}
                {catalog.status === "ready" && !list.length && <option value="">None available right now</option>}
                {list.map((m) => (
                  <option key={m.id} value={m.id}>
                    {`${m.name} · up to ${price(m.credits)} credits`}
                  </option>
                ))}
              </select>
            </label>
            {seedHit && (
              <div className="photo-block" role="alert">
                <Icon name="warning" size={14} />
                <span>{seedGuardMessage(seedHit)}</span>
                {isSoft(seedHit) && !seedOk && (
                  <button type="button" className="small-button" onClick={() => setSeedOk(true)}>
                    It's not a key, continue
                  </button>
                )}
              </div>
            )}
            {tool === "edit" && veilLive && (
              <div className="photo-veil">
                <VeilToggle on={veiling} onToggle={() => !privacyOn && setVeilOn?.((v) => !v)} />
                <span>
                  {veiling
                    ? "Veil is on. It can't hide details inside a photo edit, so the edit runs only if your words hold nothing Veil would mask."
                    : "Veil is off: the model sees your words as written."}
                </span>
              </div>
            )}
            {veiled > 0 && (
              <div className="photo-block" role="alert">
                <Icon name="warning" size={14} />
                <span>
                  {veiled === 1
                    ? "Veil would mask 1 detail in these words, and a photo edit needs them as written. Remove it, or turn Veil off."
                    : `Veil would mask ${veiled} details in these words, and a photo edit needs them as written. Remove them, or turn Veil off.`}
                </span>
                {!privacyOn && (
                  <button type="button" className="small-button" onClick={() => setVeilOn?.(false)}>
                    Turn Veil off
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="photo-step">
            <h2>
              <span>3</span>Keep the result
            </h2>
            <label className="photo-field">
              <span>Where it goes</span>
              <select value={privacyOn ? "none" : save} disabled={running || privacyOn} onChange={(e) => setSave(e.target.value)}>
                <option value="library">In your library</option>
                {offRecordLive && <option value="none">Nowhere: off the record, download only</option>}
              </select>
            </label>
            {privateLive && (
              <div className="photo-veil">
                <PrivateModeToggle active={privacyOn} disabled={running || !canPrivate} onToggle={() => setPrivateOn((v) => !v)} />
                <span>
                  {canPrivate
                    ? "Private mode: only models with zero data retention, nothing saved, Veil on."
                    : catalog.status === "ready"
                      ? "Private mode isn't available for photos: no photo model offers zero data retention."
                      : "Checking which models offer zero data retention…"}
                </span>
              </div>
            )}
            <p className="photo-fine">
              <Icon name="lock" size={13} />
              <span>Photo results are never kept in Device Vault: they're saved to your library or nowhere.</span>
            </p>
          </div>

          <div className="photo-run">
          <p className="photo-cost" role="status">
            {q ? (
              <>
                <b>{`Up to ${price(q.credits)} credits`}</b>
                {" · exactly what's held; you're charged only for a usable result"}
                {over && <b className="photo-short"> · over your balance</b>}
                {limited && !over && <b className="photo-short"> · over your spending limit</b>}
              </>
            ) : quote.status === "unavailable" ? (
              quote.message
            ) : (
              "Working out the most it can cost…"
            )}
          </p>
          <div className="photo-actions">
            {running ? (
              <button type="button" className="button" onClick={stop}>
                <Icon name="stop" size={15} />
                Stop
              </button>
            ) : (
              <button type="button" className="button" disabled={!canRun} onClick={run}>
                <Icon name={info.icon} size={15} />
                {info.action}
              </button>
            )}
          </div>
          </div>
          <p className="photo-fine stacked">
            <span>Your photo goes to the model with its hidden details removed here first. ANONYMA doesn't keep it; only the result can be saved.</span>
            {redactOn && <span>You can black out parts of it before it's sent.</span>}
            <span>A model makes the change, so check the result. A run that gives you nothing usable costs nothing.</span>
          </p>
        </div>

        <div className="photo-stage">
          {result ? (
            <Result result={result} photo={photo} models={models} trailLive={trailLive} onUse={useResult} onNew={forget} busy={running || reading} />
          ) : photo ? (
            <Preview photo={photo} running={running} tool={tool} />
          ) : (
            <Idle catalog={catalog} tool={tool} onTool={setTool} />
          )}
        </div>
      </div>
      {picking && <LibraryPicker onClose={() => setPicking(false)} onPick={pickLibrary} />}
      {redacting && photo && (
        <RedactEditor
          item={photo}
          onCancel={() => setRedacting(false)}
          onApply={(next) => {
            setPhoto({ ...next, shrunk: photo.shrunk });
            setRedacting(false);
          }}
        />
      )}
    </section>
  );
}

function Head({ compact = false }) {
  return (
    <div className={"photo-head" + (compact ? " compact" : "")}>
      <div>
        <p className="photo-eyebrow">PHOTO TOOLS</p>
        <h1>Edit a photo with words, remove its background, or upscale it.</h1>
        <p>See the price before anything runs. A result you can't use costs nothing.</p>
      </div>
    </div>
  );
}

function Promises() {
  return (
    <ul className="photo-promises">
      <li>
        <b>Cleaned here first</b>
        <span>Hidden details such as location and camera are removed in your browser, and you can black out parts of a photo before it goes anywhere.</span>
      </li>
      <li>
        <b>The maximum, first</b>
        <span>See the most it can cost before you start; that's exactly what's held. A result you can't use costs nothing.</span>
      </li>
      <li>
        <b>Nothing kept you didn't ask for</b>
        <span>ANONYMA doesn't keep your photo. The result goes to your library, or nowhere if you go off the record.</span>
      </li>
    </ul>
  );
}

// What the page can do, before a photo is chosen.
function Idle({ catalog, tool, onTool }) {
  return (
    <div className="photo-idle">
      <ul className="photo-kinds">
        {TOOLS.map((id) => {
          const models = catalog.tools?.find((t) => t.id === id)?.models || [];
          return (
            <li key={id}>
              <button type="button" className={tool === id ? "on" : ""} onClick={() => onTool(id)}>
                <span className="photo-icon" aria-hidden="true">
                  <Icon name={TOOL_INFO[id].icon} size={18} />
                </span>
                <b>{TOOL_INFO[id].label}</b>
                <span>{TOOL_INFO[id].blurb}</span>
                {models.length > 0 && <small>{`From ${price(Math.min(...models.map((m) => m.credits)))} credits`}</small>}
              </button>
            </li>
          );
        })}
      </ul>
      <Promises />
    </div>
  );
}

function Preview({ photo, running, tool }) {
  const url = photo.url || photo.originalUrl;
  const size = useSize(url);
  return (
    <figure className={"photo-preview" + (running ? " working" : "")}>
      <div className="photo-frame">
        <img src={url} alt="Your photo" />
        {running && (
          <div className="photo-working" role="status">
            <span className="photo-spinner" aria-hidden="true" />
            <b>{tool === "edit" ? "Editing your photo…" : tool === "background" ? "Removing the background…" : "Upscaling your photo…"}</b>
            <small>Nothing is charged unless a usable result comes back.</small>
          </div>
        )}
      </div>
      <figcaption>
        <span>Your photo</span>
        {size && <span>{sizeNote(size, size)}</span>}
      </figcaption>
    </figure>
  );
}

// The before and after, with a slider between them.
function Compare({ before, after, transparent }) {
  const [at, setAt] = useState(50);
  const size = useSize(after);
  return (
    <div
      className={"photo-compare" + (transparent ? " checker" : "")}
      style={{ "--at": at + "%", "--r": size ? size.width / size.height : 1, aspectRatio: size ? `${size.width} / ${size.height}` : undefined }}
    >
      <img className="photo-after" src={after} alt="After" />
      {before && <img className="photo-before" src={before} alt="Before" style={{ clipPath: `inset(0 ${100 - at}% 0 0)` }} />}
      {before && (
        <>
          <span className="photo-handle" aria-hidden="true">
            <i />
          </span>
          <span className="photo-side left">Before</span>
          <span className="photo-side right">After</span>
          <input type="range" min="0" max="100" value={at} aria-label="Slide between before and after" onChange={(e) => setAt(Number(e.target.value))} />
        </>
      )}
    </div>
  );
}

function Result({ result, photo, models, trailLive, onUse, onNew, busy }) {
  const before = result.before ?? (result.reloaded ? photo?.url || null : null);
  const beforeSize = useSize(before);
  const afterSize = useSize(result.image);
  const name = resultName(result.name || photo?.name, result.tool, result.mime);
  const label = TOOL_INFO[result.tool]?.label || "Result";
  const model = models.find((m) => m.id === result.model);
  return (
    <section className="photo-result" aria-label="Result">
      <div className="photo-result-head">
        <div>
          <p className="photo-eyebrow">{label.toUpperCase()}</p>
          <p className="photo-meta">
            <span>{sizeNote(beforeSize, afterSize) || (afterSize ? sizeNote(afterSize, afterSize) : "")}</span>
            {result.mime && <span>{result.mime.replace("image/", "").toUpperCase()}</span>}
            {result.copy && <span>{`Upscaled from a ${result.copy} px copy`}</span>}
            <span data-i18n="off">{model?.name || result.model}</span>
          </p>
        </div>
      </div>
      <Compare before={before} after={result.image} transparent={result.tool === "background"} />
      {!before && (
        <p className="photo-fine">
          <Icon name="shield" size={13} />
          <span>The original isn't kept, so there's no before to slide to. Choose a photo again to compare.</span>
        </p>
      )}
      <div className="photo-toolbar">
        <a className="button" href={result.saved ? result.media.url + "?download=1" : result.image} download={name}>
          <Icon name="download" size={15} />
          Download
        </a>
        <button type="button" className="photo-secondary" disabled={busy} onClick={onUse}>
          <Icon name="refresh" size={14} />
          Use as the photo
        </button>
        {result.saved && (
          <Link className="photo-secondary" to="/workspace/library">
            <Icon name="folder" size={14} />
            Open in your library
          </Link>
        )}
        <button type="button" className="photo-secondary" disabled={busy} onClick={onNew}>
          New photo
        </button>
      </div>
      <ul className="photo-notes">
        <li>
          <Icon name={result.saved ? "check" : "shield"} size={13} />
          <span>
            {result.saved
              ? "Saved to your library like an image you made. Deleting it there deletes it here."
              : "Off the record: nothing was saved. Download it before you leave this page."}
          </span>
        </li>
        {result.tool === "background" && (
          <li>
            <Icon name="shield" size={13} />
            <span>The checkerboard shows what's transparent. Check the edges before you use it.</span>
          </li>
        )}
      </ul>
      {result.credits != null && (
        <div className="photo-receipt">
          <div className="receipt">
            <span className="sq" aria-hidden="true" />
            {result.testMode ? `Test receipt · ${price(result.credits)} credits charged` : `Receipt · ${price(result.credits)} credits charged`}
          </div>
          {trailLive && result.privacy && <PrivacyTrail privacy={result.privacy} models={models} />}
        </div>
      )}
    </section>
  );
}

// One of the account's library pictures.
function LibraryPicker({ onClose, onPick }) {
  const [state, setState] = useState({ status: "loading" });
  useEffect(() => {
    const ctl = new AbortController();
    api("/api/media", { signal: ctl.signal }).then(
      (r) => setState({ status: "ready", items: (r.data || []).filter((m) => m.kind === "image") }),
      (e) => !ctl.signal.aborted && setState({ status: "error", message: e.message }),
    );
    return () => ctl.abort();
  }, []);
  return (
    <Modal title="Choose from your library" onClose={onClose}>
      <div className="photo-library">
        {state.status === "loading" && <p className="photo-fine">Opening your library…</p>}
        {state.status === "error" && <Notice type="error">{state.message}</Notice>}
        {state.status === "ready" && !state.items.length && <p className="photo-fine">Your library has no pictures yet.</p>}
        {state.status === "ready" && state.items.length > 0 && (
          <ul>
            {state.items.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => onPick(m.id, m.url, "library-photo")} aria-label="Use this picture">
                  <img src={m.url} alt="" loading="lazy" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
