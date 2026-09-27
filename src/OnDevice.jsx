import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { Icon, Button, Mark, Notice, Modal, CopyButton } from "./ui.jsx";
import { ReplyMarkdown } from "./RichMarkdown.jsx";
import { ShieldLink } from "./Shield.jsx";
import {
  ONDEVICE_MODELS,
  DEFAULT_MODEL,
  MAX_PROMPT_CHARS,
  SUPPORT_REASONS,
  SUPPORT_WORKS,
  appConfigFor,
  buildLocalRequest,
  deviceVaultChat,
  detectWebGPU,
  formatBytes,
  friendlyError,
  modelByKey,
  modelStorage,
  progressState,
  removeModelFiles,
  streamLocalReply,
  variantFor,
} from "./on-device.js";
import "./on-device.css";

// On-Device Model (src/on-device.js): a small model that runs in this
// browser. Nothing here calls ANONYMA's API: no chat request, no credits, no
// history on the server. The chat is kept in this tab's memory, or sealed in
// Device Vault when the user asks and the vault is unlocked.

// The open chat survives switching workspace pages in this tab (not a
// reload), for the account that started it.
const session = { account: null, messages: [], model: null, vaultId: null, created: null, keep: false };
const newId = () => globalThis.crypto.randomUUID();

// Replies never load images: an image in a reply would be a request to
// someone's server. Links stay links, showing where they go (Injection
// Shield's link guard), and open only when clicked.
function NoImage({ alt }) {
  return (
    <span className="od-no-image">
      <Icon name="image" size={13} />
      <span>Image not shown: on-device replies never load images.</span>
      {alt ? <span data-i18n="off">{alt}</span> : null}
    </span>
  );
}
const REPLY_PARTS = {
  img: NoImage,
  a: ({ node, href, title, children }) => (
    <ShieldLink node={node} href={href} title={title}>
      {children}
    </ShieldLink>
  ),
};

export default function OnDevice({ user, demo, vault, vaultLive, onUnlockVault }) {
  const account = demo ? "demo" : user?.id || "guest";
  if (session.account !== account)
    Object.assign(session, { account, messages: [], model: null, vaultId: null, created: null, keep: false });
  const location = useLocation();
  const navigate = useNavigate();
  const [gpu, setGpu] = useState(null),
    [storage, setStorage] = useState({}),
    [quota, setQuota] = useState(null),
    [selected, setSelected] = useState(session.model || DEFAULT_MODEL),
    [phase, setPhase] = useState("idle"), // idle | loading | ready
    [progress, setProgress] = useState(null),
    [loaded, setLoaded] = useState(null),
    [messages, setMessages] = useState(session.messages),
    [prompt, setPrompt] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [keep, setKeep] = useState(session.keep),
    [removing, setRemoving] = useState(null);
  const handle = useRef(null),
    engine = useRef(null),
    savedRef = useRef(""),
    saving = useRef(false),
    endRef = useRef(null);
  const vaultOpen = vaultLive && vault?.unlocked;

  // Keep the chat for this tab as it changes.
  useEffect(() => {
    session.messages = messages;
    session.keep = keep;
  }, [messages, keep]);

  // Check for WebGPU once, then what's already on this device.
  useEffect(() => {
    let live = true;
    detectWebGPU().then((g) => live && setGpu(g));
    return () => {
      live = false;
    };
  }, []);
  async function refreshStorage(g = gpu) {
    if (!g?.ok || typeof caches === "undefined") return;
    const next = {};
    for (const m of ONDEVICE_MODELS) {
      try {
        next[m.key] = await modelStorage(m, variantFor(m, g));
      } catch {
        next[m.key] = { bytes: 0, files: 0, complete: false, partial: false };
      }
    }
    setStorage(next);
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.quota) setQuota(Math.max(0, est.quota - (est.usage || 0)));
    } catch {}
  }
  useEffect(() => {
    if (!gpu?.ok) return;
    refreshStorage(gpu);
    // Back on this page with a model that was running in this tab: start it
    // again from this device's copy (no download).
    if (session.model) start(session.model, { resume: true });
  }, [gpu]);
  // Leaving the page ends the worker and frees the graphics memory.
  useEffect(() => () => handle.current?.stop(), []);

  // A vault chat opened from the sidebar: its id travels in navigation state.
  const vaultRequest = location.state?.vaultChat;
  useEffect(() => {
    if (!vaultRequest || !vault) return;
    if (vault.status === "loading") return;
    const chat = vault.unlocked && vault.chats.find((c) => c.id === vaultRequest && c.mode === "device");
    if (chat) openVaultChat(chat);
    navigate(location.pathname + location.search, { replace: true, state: null });
  }, [vaultRequest, vault?.status]);
  function openVaultChat(chat) {
    if (busy) return;
    session.vaultId = chat.id;
    session.created = chat.created;
    savedRef.current = JSON.stringify(chat.messages);
    setMessages(chat.messages);
    setKeep(true);
    setError("");
    const m = modelByKey(chat.model);
    if (m) {
      setSelected(m.key);
      if (gpu?.ok && loaded !== m.key && storage[m.key]?.complete) start(m.key);
    }
  }
  // Locking the vault closes a chat that's kept in it, as the chat page does.
  useEffect(() => {
    if (vaultOpen || !keep || !session.vaultId) return;
    if (busy) engine.current?.interruptGenerate?.();
    session.vaultId = null;
    savedRef.current = "";
    setMessages([]);
    setKeep(false);
  }, [vaultOpen]);
  // Kept in Device Vault: sealed there after each finished reply.
  useEffect(() => {
    if (!keep || !vaultOpen || busy || !messages.length) return;
    const snapshot = JSON.stringify(messages);
    if (snapshot === savedRef.current) return;
    savedRef.current = snapshot;
    session.vaultId ||= newId();
    session.created ||= Date.now();
    saving.current = true;
    vault
      .save(deviceVaultChat({ id: session.vaultId, model: loaded || selected, messages, created: session.created }))
      .catch(() => setError("This chat couldn't be saved to Device Vault. It's still here in this tab."))
      .finally(() => (saving.current = false));
  }, [keep, vaultOpen, busy, messages]);
  // Deleted from the vault (the sidebar's Delete) while open here: stop
  // keeping it, so the next reply doesn't quietly save it again.
  useEffect(() => {
    if (!vaultOpen || !keep || !session.vaultId || !savedRef.current || saving.current) return;
    if (!vault.chats.some((c) => c.id === session.vaultId)) {
      session.vaultId = null;
      savedRef.current = "";
      setKeep(false);
    }
  }, [vault?.chats]);

  async function start(key, { resume = false } = {}) {
    const model = modelByKey(key);
    if (!model || !gpu?.ok) return;
    if (loaded === key && engine.current) return setPhase("ready");
    handle.current?.stop();
    engine.current = null;
    setLoaded(null);
    setSelected(key);
    setError("");
    setPhase("loading");
    const variant = variantFor(model, gpu);
    setProgress({ phase: resume ? "load" : "prepare", fraction: 0 });
    let h;
    try {
      const { startEngine } = await import("./ondevice-engine.js");
      h = handle.current = startEngine({
        modelId: variant.id,
        appConfig: appConfigFor(gpu),
        onProgress: (r) => handle.current === h && setProgress(progressState(r, variant.bytes)),
      });
      const e = await h.engine;
      if (handle.current !== h) return;
      engine.current = e;
      session.model = key;
      setLoaded(key);
      setPhase("ready");
    } catch (err) {
      if (h && handle.current !== h) return;
      handle.current = null;
      setPhase("idle");
      if (err?.name !== "AbortError") setError(friendlyError(err, "load"));
      h?.stop();
    } finally {
      if (!h || handle.current === h || handle.current === null) {
        setProgress(null);
        refreshStorage();
      }
    }
  }
  function cancel() {
    const h = handle.current;
    handle.current = null;
    h?.stop();
    engine.current = null;
    session.model = null;
    setLoaded(null);
    setPhase("idle");
    setProgress(null);
    refreshStorage();
  }
  async function remove(key) {
    setRemoving(null);
    const model = modelByKey(key);
    if (!model) return;
    if (loaded === key || (phase === "loading" && selected === key)) cancel();
    try {
      await removeModelFiles(model);
    } catch {
      setError("The model's files couldn't be removed. Try again, or clear this site's data in your browser settings.");
    }
    refreshStorage();
  }

  async function send(e) {
    e?.preventDefault();
    const text = prompt.trim();
    if (!text || busy || phase !== "ready" || !engine.current) return;
    if (text.length > MAX_PROMPT_CHARS) {
      setError(`That message is too long for the on-device model. Keep it under ${MAX_PROMPT_CHARS.toLocaleString("en-US")} characters.`);
      return;
    }
    setError("");
    const thread = [...messages, { role: "user", content: text }];
    const { request, dropped } = buildLocalRequest(thread);
    const reply = { role: "assistant", content: "", local: { model: loaded } };
    setMessages([...thread, reply]);
    setPrompt("");
    setBusy(true);
    let got = "";
    try {
      const out = await streamLocalReply({
        engine: engine.current,
        request,
        onDelta: (t) => {
          got = t;
          setMessages((prev) => [...prev.slice(0, -1), { ...prev.at(-1), content: t }]);
        },
      });
      setMessages((prev) => [
        ...prev.slice(0, -1),
        {
          ...prev.at(-1),
          content: out.text,
          local: {
            model: loaded,
            ...(out.tokensPerSecond ? { tps: out.tokensPerSecond } : {}),
            ...(out.finishReason === "length" ? { cut: true } : {}),
            ...(out.finishReason === "abort" ? { stopped: true } : {}),
            ...(dropped ? { dropped } : {}),
          },
        },
      ]);
    } catch (err) {
      setError(friendlyError(err, "reply"));
      // A reply that never started is taken back, with the prompt restored;
      // a partial one stays, marked as stopped.
      setMessages((prev) =>
        got
          ? [...prev.slice(0, -1), { ...prev.at(-1), content: got, local: { ...prev.at(-1).local, stopped: true } }]
          : prev.slice(0, -2),
      );
      if (!got) setPrompt((p) => p || text);
    } finally {
      setBusy(false);
    }
  }
  function stopReply() {
    engine.current?.interruptGenerate?.();
  }
  function newChat() {
    if (busy) stopReply();
    session.vaultId = null;
    session.created = null;
    savedRef.current = "";
    setMessages([]);
    setError("");
  }
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages.length, busy]);

  // The model the start or loading card is about (the list's choice).
  const current = modelByKey(selected);
  const variant = gpu?.ok && current ? variantFor(current, gpu) : null;
  const used = Object.values(storage).reduce((a, s) => a + (s?.bytes || 0), 0);
  const nameOf = (key) => modelByKey(key)?.name || "";

  return (
    <section className="od-page">
      <div className="od-head">
        <div>
          <p className="eyebrow">RUNS ON THIS DEVICE</p>
          <h1>On-device model</h1>
          <p>
            Chat with a small model that runs in your browser. Free, it keeps
            answering offline, and nothing you type is sent anywhere.
          </p>
        </div>
        {phase === "ready" && messages.length > 0 && (
          <button type="button" className="od-secondary" onClick={newChat}>
            <Icon name="plus" size={15} />
            New chat
          </button>
        )}
      </div>
      <div className="od-layout">
        <div className="od-main">
          {gpu === null ? (
            <p className="od-checking">Checking this browser for WebGPU…</p>
          ) : !gpu.ok ? (
            <div className="od-unsupported" role="status">
              <span className="od-icon" aria-hidden="true">
                <Icon name="device" size={24} />
              </span>
              <h2>Your browser doesn't support this yet</h2>
              <p>{SUPPORT_REASONS[gpu.reason] || SUPPORT_REASONS["no-webgpu"]}</p>
              <p className="od-works-title">It works in:</p>
              <ul>
                {SUPPORT_WORKS.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              <p>Everything else in ANONYMA works as usual in this browser.</p>
              <Button to={"/workspace/chat" + (demo ? "?demo=1" : "")}>Open Chat</Button>
            </div>
          ) : phase === "loading" ? (
            <LoadingCard model={current} variant={variant} progress={progress} onCancel={cancel} />
          ) : phase !== "ready" ? (
            <StartCard
              model={current}
              variant={variant}
              state={storage[current?.key]}
              onStart={() => start(current.key)}
            />
          ) : (
            <div className="od-chat">
              {messages.length === 0 ? (
                <div className="od-empty">
                  <span className="od-icon" aria-hidden="true">
                    <Icon name="device" size={22} />
                  </span>
                  <h2>{`${nameOf(loaded)} is ready`}</h2>
                  <p>
                    Ask anything. The reply is written by your own device; you
                    can even turn off your connection.
                  </p>
                </div>
              ) : (
                <div className="messages od-messages">
                  {messages.map((m, i) => (
                    <article
                      key={i}
                      className={
                        "message " +
                        m.role +
                        (busy && i === messages.length - 1 && m.role === "assistant" ? " streaming" : "")
                      }
                    >
                      <div className="message-avatar">{m.role === "user" ? "Y" : <Mark />}</div>
                      <div>
                        <div className="message-label">
                          {m.role === "user" ? "You" : "ANONYMA"}
                          {m.role === "assistant" && (
                            <span className="model-tag od-model-tag">
                              <span data-i18n="off">{nameOf(m.local?.model) || nameOf(loaded)}</span>
                              <span> · on this device</span>
                            </span>
                          )}
                        </div>
                        <div className="markdown" data-i18n="off">
                          {m.role === "assistant" ? (
                            <ReplyMarkdown rich remarkPlugins={[remarkGfm]} components={REPLY_PARTS}>
                              {m.content || (busy && i === messages.length - 1 ? "…" : "")}
                            </ReplyMarkdown>
                          ) : (
                            <ReplyMarkdown rich={false} remarkPlugins={[remarkGfm]} components={REPLY_PARTS}>
                              {m.content}
                            </ReplyMarkdown>
                          )}
                        </div>
                        {m.role === "assistant" && !(busy && i === messages.length - 1) && (
                          <div className="od-reply-meta">
                            {m.content && <CopyButton text={m.content} />}
                            <span className="od-free">Free · nothing sent</span>
                            {m.local?.tps ? <span>{`${m.local.tps} tokens a second`}</span> : null}
                            {m.local?.cut && <span>Stopped at the length limit.</span>}
                            {m.local?.stopped && <span>Stopped.</span>}
                            {m.local?.dropped ? (
                              <span>Earlier messages didn't fit the model's memory, so it saw only the most recent ones.</span>
                            ) : null}
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                  <div ref={endRef} />
                </div>
              )}
            </div>
          )}
          {error && <Notice type="error">{error}</Notice>}
          {gpu?.ok && phase === "ready" && (
            <form className="composer od-composer" onSubmit={send}>
              <label className="sr-only" htmlFor="od-prompt">
                Message the on-device model
              </label>
              <textarea
                id="od-prompt"
                value={prompt}
                rows={3}
                maxLength={MAX_PROMPT_CHARS}
                placeholder={`Message ${nameOf(loaded)}, on this device`}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) send(e);
                }}
              />
              <div className="composer-controls">
                <div>
                  <span className="od-badge">
                    <Icon name="device" size={14} />
                    On this device · free · nothing sent
                  </span>
                </div>
                {busy ? (
                  <button type="button" className="send-button" aria-label="Stop generation" onClick={stopReply}>
                    <Icon name="stop" size={15} />
                  </button>
                ) : (
                  <button type="submit" className="send-button" aria-label="Send message" disabled={!prompt.trim()}>
                    <Icon name="send" size={16} />
                  </button>
                )}
              </div>
            </form>
          )}
          {gpu?.ok && phase === "ready" && (
            <div className="od-save">
              {vaultOpen ? (
                <label className="od-check">
                  <input
                    type="checkbox"
                    checked={keep}
                    disabled={busy}
                    onChange={(e) => {
                      setKeep(e.target.checked);
                      if (!e.target.checked && session.vaultId) {
                        // Stop keeping: the copy in the vault is removed.
                        const id = session.vaultId;
                        session.vaultId = null;
                        savedRef.current = "";
                        vault.remove(id).catch(() => {});
                      }
                    }}
                  />
                  <span>
                    <b>Keep this chat in Device Vault</b>
                    <small>Encrypted on this device with your passphrase. Never on our servers.</small>
                  </span>
                </label>
              ) : (
                <p>
                  Not saved: kept in this tab only, gone when you reload or close it.
                  {vaultLive && vault?.status !== "unavailable" && (
                    <>
                      {" "}
                      <button type="button" className="od-link" onClick={onUnlockVault}>
                        {vault?.status === "none" ? "Set up Device Vault to keep it" : "Unlock Device Vault to keep it"}
                      </button>
                    </>
                  )}
                </p>
              )}
            </div>
          )}
        </div>
        <aside className="od-side" aria-label="Models on this device">
          <h2>
            <Icon name="device" size={16} />
            Models on this device
          </h2>
          <ul className="od-models">
            {ONDEVICE_MODELS.map((m) => {
              const s = storage[m.key];
              const v = gpu?.ok ? variantFor(m, gpu) : m.variants.f16;
              const inUse = loaded === m.key;
              const loading = phase === "loading" && selected === m.key;
              return (
                <li key={m.key} className={(inUse ? "in-use " : "") + (selected === m.key ? "selected" : "")}>
                  <button
                    type="button"
                    className="od-model"
                    aria-pressed={selected === m.key}
                    disabled={!gpu?.ok || busy || phase === "loading"}
                    onClick={() => {
                      setSelected(m.key);
                      // Back to the running model's chat, or to the start
                      // card for another one (the chat stays).
                      if (inUse && engine.current) setPhase("ready");
                      else if (phase === "ready") setPhase("idle");
                    }}
                  >
                    <b data-i18n="off">{m.name}</b>
                    <small>{m.note}</small>
                    <span className="od-model-facts">
                      <span>{`${formatBytes(v.bytes)} download`}</span>
                      <span>{`About ${formatBytes(v.vramMB * 1e6)} of graphics memory`}</span>
                    </span>
                  </button>
                  <span className="od-model-state">
                    {inUse ? (
                      <span className="od-state on">In use</span>
                    ) : loading ? (
                      <span className="od-state">{progress?.phase === "download" ? "Downloading…" : "Starting…"}</span>
                    ) : s?.complete ? (
                      <span className="od-state">{`Downloaded · ${formatBytes(s.bytes || v.bytes)}`}</span>
                    ) : s?.partial ? (
                      <span className="od-state">{`Partly downloaded · ${formatBytes(s.bytes)}`}</span>
                    ) : (
                      <span className="od-state off">Not downloaded</span>
                    )}
                    {(s?.complete || s?.partial) && (
                      <button
                        type="button"
                        className="od-remove"
                        disabled={busy}
                        onClick={() => setRemoving(m.key)}
                      >
                        Remove
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {gpu?.ok && (
            <p className="od-storage">
              <Icon name="drive" size={14} />
              <span>{used > 0 ? `Using ${formatBytes(used)} on this device` : "No models downloaded yet"}</span>
              {quota != null && <small>{`${formatBytes(quota)} free for this site`}</small>}
            </p>
          )}
          <h3>What leaves this device</h3>
          <p>
            The model file downloads once from Hugging Face, and its small
            engine file from GitHub (they see a download, not your chats).
            After that, everything runs on your device: no credits, nothing
            sent to ANONYMA or anyone.
          </p>
          <p>
            Your browser keeps the files until you remove them, and may clear
            them if it runs short of space.
          </p>
          <p className="od-honest">
            Small models are weaker than the ones in Chat: expect simpler
            answers and more mistakes. No web search, files or memory here.
          </p>
        </aside>
      </div>
      {removing && (
        <Modal title="Remove downloaded model?" onClose={() => setRemoving(null)}>
          <p className="od-dialog-text">
            <span data-i18n="off">{nameOf(removing)}</span>{" "}
            <span>{`frees ${formatBytes(storage[removing]?.bytes || 0)} on this device. You can download it again any time.`}</span>
          </p>
          <div className="od-dialog-actions">
            <button type="button" className="od-secondary" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button type="button" className="button" onClick={() => remove(removing)}>
              Remove
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function StartCard({ model, variant, state, onStart }) {
  if (!model || !variant) return null;
  const ready = !!state?.complete;
  return (
    <div className="od-start">
      <span className="od-icon" aria-hidden="true">
        <Icon name="device" size={24} />
      </span>
      <h2 data-i18n="off">{model.name}</h2>
      <p>{model.note}</p>
      <dl className="od-facts">
        <div>
          <dt>Download</dt>
          <dd>{ready ? "Already on this device" : `${formatBytes(variant.bytes)}, once`}</dd>
        </div>
        <div>
          <dt>Graphics memory</dt>
          <dd>{`About ${formatBytes(variant.vramMB * 1e6)}`}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>Free, no credits</dd>
        </div>
        <div>
          <dt>Licence</dt>
          <dd data-i18n="off">{model.licence}</dd>
        </div>
      </dl>
      <button type="button" className="button" onClick={onStart}>
        <Icon name={ready ? "play" : "download"} size={16} />
        {ready
          ? `Start ${model.name}`
          : state?.partial
            ? "Resume download"
            : `Download ${formatBytes(variant.bytes)} and start`}
      </button>
      <small>
        {ready
          ? "Loads from this device. No download, nothing sent."
          : "Only the model file is downloaded. Your messages never leave this device."}
      </small>
    </div>
  );
}

function LoadingCard({ model, variant, progress, onCancel }) {
  const pct = Math.round((progress?.fraction || 0) * 100);
  const label =
    progress?.phase === "download"
      ? `Downloading ${pct}%`
      : progress?.phase === "load"
        ? `Loading from this device ${pct}%`
        : "Preparing…";
  return (
    <div className="od-start od-loading" aria-live="polite">
      <span className="od-icon" aria-hidden="true">
        <Icon name="download" size={22} />
      </span>
      <h2 data-i18n="off">{model?.name}</h2>
      <p className="od-progress-label">{label}</p>
      <div
        className="od-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Model download"
      >
        <span style={{ width: pct + "%" }} />
      </div>
      {progress?.phase === "download" && variant && (
        <p className="od-progress-bytes">{`${formatBytes(progress.done || 0)} of ${formatBytes(variant.bytes)} downloaded`}</p>
      )}
      <small>
        {progress?.phase === "download"
          ? "A one-time download. If you stop, what's downloaded is kept and the next start resumes."
          : "Getting the model ready on your graphics processor."}
      </small>
      <button type="button" className="od-secondary" onClick={onCancel}>
        {progress?.phase === "download" ? "Stop download" : "Cancel"}
      </button>
    </div>
  );
}
