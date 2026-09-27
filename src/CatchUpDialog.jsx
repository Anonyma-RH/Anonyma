import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, streamChat, uid } from "./lib.js";
import { Icon, Modal, Button, Notice, CopyButton } from "./ui.jsx";
import { buildChatRequest, cloneVeilState, formatCredits } from "./estimate.js";
import { veil } from "./veil.js";
import { t } from "./i18n.js";
import {
  aboutTokens,
  carriedContext,
  catchupMessages,
  fitTranscript,
  messagesChars,
  readSummary,
  roughTokens,
  savingsEstimate,
  summaryText,
  transcriptFrom,
  transcriptRoom,
  MAX_CARRIED_CHARS,
  MAX_TRANSCRIPT_CHARS,
  TRUNCATED_MESSAGE,
  INVALID_MESSAGE,
} from "./catchup.js";

// Summarize & Continue's dialog, loaded when Catch me up is opened. The
// summary request is an off-the-record /api/chat call that carries only a
// text transcript (server/catchup.js builds its prompt around it); Veil
// masks the transcript here, and the summary is restored here. Continue
// fresh hands the edited summary to the workspace (continueFresh), which
// starts the new chat where this one lives.

// Where a fresh chat will live, by where this one does.
const STORAGE_NOTES = {
  saved: "Saved like any chat, with a link back to this one. This chat stays as it is.",
  vault: "Kept in Device Vault on this device, like this chat. This chat stays as it is.",
  ephemeral: "Off the record, like this chat: nothing is saved. This chat isn't saved either, so it closes when the fresh one starts. Copy anything you need first.",
  private: "Private Mode, like this chat: zero-data-retention models, nothing saved. This chat isn't saved either, so it closes when the fresh one starts. Copy anything you need first.",
};

// Models a summary can use: this chat's own model first, then up to four
// that would cost less for it (priced on the transcript as input plus a
// short reply), cheapest first. The catalog's popular models are offered
// when any are cheaper; otherwise any cheaper model in this section.
export function summaryModels(models, current, inputTokens) {
  const text = models.filter((m) => m.type === "chat" && m.callable !== false && !m.imageCapable);
  const cost = (m) => {
    const i = Number(m?.pricing?.input_per_1M_tokens),
      o = Number(m?.pricing?.output_per_1M_tokens);
    return Number.isFinite(i) && Number.isFinite(o) ? i * inputTokens + o * 800 : null;
  };
  const own = current && text.find((m) => m.id === current.id);
  const base = own ? cost(own) : null;
  const cheaper = text
    .filter((m) => m.id !== own?.id && cost(m) != null && (base == null || cost(m) < base))
    .sort((a, b) => cost(a) - cost(b) || String(a.name).localeCompare(String(b.name)));
  const popular = cheaper.filter((m) => m.popular);
  return [...(own ? [own] : []), ...(popular.length ? popular : cheaper).slice(0, 4)];
}

function useSummaryEstimate(body) {
  const [state, setState] = useState({ status: "idle" });
  const key = body ? JSON.stringify(body) : "";
  useEffect(() => {
    if (!body) return setState({ status: "idle" });
    const controller = new AbortController();
    setState({ status: "loading" });
    const timer = setTimeout(async () => {
      try {
        const r = await api("/api/quote", { method: "POST", body, signal: controller.signal });
        setState({ status: "ready", ...r });
      } catch (e) {
        if (e?.name !== "AbortError")
          setState({ status: "unavailable", message: e?.message || "The estimate is unavailable." });
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);
  return state;
}

// The summary, as the panel shows it. Model text, restored by Veil in this
// browser, is plain text: no links or images can come from it.
export function SummaryView({ summary, restore = (s) => s }) {
  const section = (title, items, empty) => (
    <section className="catchup-section">
      <h3>{title}</h3>
      {items.length ? (
        <ul data-i18n="off">
          {items.map((item, i) => (
            <li key={i}>{restore(item)}</li>
          ))}
        </ul>
      ) : (
        <p className="catchup-none">{empty}</p>
      )}
    </section>
  );
  return (
    <div className="catchup-summary">
      {section("Key points", summary.keyPoints, "None")}
      {section("Decisions", summary.decisions, "None recorded")}
      {section("Open questions", summary.openQuestions, "None open")}
      <section className="catchup-section catchup-leftoff">
        <h3>Where we left off</h3>
        {summary.leftOff ? <p data-i18n="off">{restore(summary.leftOff)}</p> : <p className="catchup-none">Not stated</p>}
      </section>
    </div>
  );
}

// The saving a fresh chat makes, as an estimate.
export function SavingsLine({ savings }) {
  if (!savings) return null;
  return (
    <div className="catchup-savings" role="status">
      <div className="catchup-savings-row">
        <span>
          <small>Now, with every message</small>
          <b>{`≈${aboutTokens(savings.now)} tokens`}</b>
        </span>
        <Icon name="arrow" size={16} />
        <span>
          <small>Fresh chat, with the summary</small>
          <b>{`≈${aboutTokens(savings.fresh)} tokens`}</b>
        </span>
        {savings.fewer > 0 && <strong>{`${savings.fewer}% fewer`}</strong>}
      </div>
      <p>
        {savings.measured
          ? "An estimate, from the token count the provider reported for the summary. Your next question and each reply add to both."
          : "A rough estimate at about four characters a token. Your next question and each reply add to both."}
      </p>
    </div>
  );
}

export default function CatchUpDialog({
  messages,
  carried = "",
  models,
  current,
  mode = "chat",
  storage = "saved",
  privateMode = false,
  preserveHistory = true,
  veilWith = null,
  onVeilUsed,
  restore = (s) => s,
  trail = false,
  seedGuard = false,
  cached = null,
  onResult,
  onContinue,
  onClose,
  refresh,
}) {
  const [phase, setPhase] = useState(cached ? "done" : "setup"),
    [result, setResult] = useState(cached),
    [error, setError] = useState(null),
    [draft, setDraft] = useState(""),
    [starting, setStarting] = useState(false);
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  const veiling = !!veilWith;
  // Every turn as text, masked by Veil (with a copy of its map: the estimate
  // must never add a tag for a request that isn't made).
  const full = useMemo(() => {
    const state = veiling ? cloneVeilState(veilWith.state) : null;
    let masked = 0;
    const mask = veiling
      ? (text) => {
          const r = veil(text, state, veilWith.words);
          masked += r.count;
          return r.text;
        }
      : null;
    return { transcript: transcriptFrom(messages, { mask, carried }), masked };
  }, [messages, carried, veiling]);
  const inputTokens = roughTokens(full.transcript.reduce((n, x) => n + x.text.length, 0));
  const options = useMemo(() => summaryModels(models, current, inputTokens), [models, current?.id, inputTokens]);
  const [modelId, setModelId] = useState(() => options[0]?.id || "");
  const model = options.find((m) => m.id === modelId) || options[0] || null;
  const fitted = useMemo(
    () =>
      fitTranscript(full.transcript, {
        maxChars: preserveHistory ? MAX_TRANSCRIPT_CHARS : 48000,
        maxBytes: transcriptRoom(model),
      }),
    [full, model?.id, preserveHistory],
  );
  const hasFiles = messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("<document "));
  const hasImages = messages.some((m) => m.images?.length);
  const body = (transcript, extra = {}) => ({
    model: model?.id,
    ephemeral: true,
    mode,
    catchup: { transcript },
    ...(privateMode ? { private: true } : {}),
    ...extra,
  });
  const quoteBody = phase === "setup" && model && fitted.transcript.length >= 2 ? body(fitted.transcript) : null;
  const estimate = useSummaryEstimate(quoteBody);

  async function summarize({ allowSeed = false } = {}) {
    if (!model || fitted.transcript.length < 2) return;
    setError(null);
    setPhase("running");
    // The real request masks with the chat's own map, so every tag in the
    // summary is one this browser can restore.
    let masked = 0,
      transcript = fitted.transcript;
    if (veiling) {
      const mask = (text) => {
        const r = veil(text, veilWith.state, veilWith.words);
        masked += r.count;
        return r.text;
      };
      transcript = fitTranscript(transcriptFrom(messages, { mask, carried }), {
        maxChars: preserveHistory ? MAX_TRANSCRIPT_CHARS : 48000,
        maxBytes: transcriptRoom(model),
      }).transcript;
      onVeilUsed?.();
    }
    const ctl = new AbortController();
    controller.current = ctl;
    let output = "",
      finish = null,
      usage = null,
      charged = null;
    try {
      await streamChat(
        body(transcript, {
          requestId: uid(),
          ...(trail ? { veil_masked: veiling ? masked : null } : {}),
          ...(allowSeed ? { allow_seed_phrase: true } : {}),
        }),
        (event) => {
          if (event.anonyma?.credits_charged != null) charged = event.anonyma.credits_charged;
          if (event.error)
            throw new ApiError(event.error.message || "The stream ended with an error.", 200, event.error.code, event);
          output += event.choices?.[0]?.delta?.content || "";
          finish = event.anonyma?.finish_reason || event.choices?.[0]?.finish_reason || finish;
          if (event.usage) usage = event.usage;
        },
        ctl.signal,
      );
      const read = readSummary(output, finish);
      if (!read.summary) {
        setError({
          message: read.truncated ? TRUNCATED_MESSAGE : INVALID_MESSAGE,
          charged,
        });
        setPhase("setup");
        return;
      }
      const next = {
        summary: read.summary,
        cut: read.cut,
        charged,
        model: model.name || model.id,
        promptTokens: Number(usage?.prompt_tokens) || 0,
        promptChars: messagesChars(catchupMessages(transcript)),
        omitted: fullCount(full) - transcript.length,
      };
      setResult(next);
      onResult?.(next);
      setPhase("done");
    } catch (e) {
      const stopped = e?.name === "AbortError";
      setError({
        message: stopped
          ? "Stopped. If the model had already started, what it wrote was charged."
          : e?.message || "The summary couldn't be made.",
        code: e?.code || null,
        charged: e?.data?.anonyma?.credits_charged ?? charged,
      });
      setPhase("setup");
    } finally {
      controller.current = null;
      refresh?.();
    }
  }

  // The fresh chat's starting text: the summary, restored and with its
  // headings in the page's language, for the user to edit.
  function openContinue() {
    setDraft(summaryText(result.summary, { label: t, restore }));
    setError(null);
    setPhase("continue");
  }
  // What each message carries now: the history Send would include, plus the
  // summary this chat itself carries, if it was continued fresh.
  const history = useMemo(() => {
    const { request } = buildChatRequest({ messages, preserveHistory });
    return messagesChars(request) + carriedContext(carried).length;
  }, [messages, carried, preserveHistory]);
  const savings =
    phase === "continue" && result
      ? savingsEstimate({
          nowChars: history,
          freshChars: carriedContext(draft).length,
          promptTokens: result.promptTokens,
          promptChars: result.promptChars,
        })
      : null;
  async function start() {
    setStarting(true);
    setError(null);
    try {
      await onContinue(draft);
    } catch (e) {
      setError({ message: e?.message || "The fresh chat couldn't be started." });
      setStarting(false);
    }
  }

  const shown = estimate.status === "ready" ? estimate : null;
  const short = shown && shown.available != null && Number(shown.credits) > Number(shown.available);
  const limited =
    shown && !short && shown.spending_limit?.remaining != null && Number(shown.credits) > Number(shown.spending_limit.remaining);
  return (
    <Modal title="Catch me up" onClose={onClose}>
      <div className="catchup">
        {phase === "setup" && (
          <>
            <p className="catchup-lede">
              A short summary of this chat: key points, decisions, open questions and where you left off. Then, if you like, continue in a fresh chat that carries only the summary.
            </p>
            <label className="catchup-model">
              Summarize with
              <select value={model?.id || ""} onChange={(e) => setModelId(e.target.value)} disabled={!options.length}>
                {options.map((m, i) => (
                  <option key={m.id} value={m.id}>
                    {i === 0 && m.id === current?.id ? `${m.name || m.id} (this chat's model)` : `${m.name || m.id} (costs less)`}
                  </option>
                ))}
              </select>
            </label>
            <div className="catchup-sees">
              <p className="catchup-eyebrow">WHAT THE AI SEES</p>
              <ul>
                <li>
                  <Icon name="chat" size={14} />
                  <span>
                    {fitted.omitted === 1
                      ? `The newest ${fitted.transcript.length} of ${full.transcript.length} messages, as text. The oldest one doesn't fit this model.`
                      : fitted.omitted > 1
                        ? `The newest ${fitted.transcript.length} of ${full.transcript.length} messages, as text. The oldest ${fitted.omitted} don't fit this model.`
                        : `All ${fitted.transcript.length} messages, as text (≈${aboutTokens(roughTokens(fitted.chars))} tokens).`}
                  </span>
                </li>
                {(hasFiles || hasImages) && (
                  <li>
                    <Icon name="file" size={14} />
                    <span>Attached files are named, not included. Images are left out.</span>
                  </li>
                )}
                {veiling && (
                  <li>
                    <Icon name="eyeoff" size={14} />
                    <span>
                      {full.masked
                        ? full.masked === 1
                          ? "Veil masks 1 detail before sending. The summary is restored here."
                          : `Veil masks ${full.masked} details before sending. The summary is restored here.`
                        : "Veil is on: details it finds are masked before sending."}
                    </span>
                  </li>
                )}
                {privateMode && (
                  <li>
                    <Icon name="shield" size={14} />
                    <span>Private Mode: zero-data-retention models only.</span>
                  </li>
                )}
                <li>
                  <Icon name="shield" size={14} />
                  <span>Off the record: the summary is shown here and isn't saved, unless you continue fresh.</span>
                </li>
              </ul>
            </div>
            {!options.length && <Notice type="error">No model can summarize this chat right now.</Notice>}
            {options.length > 0 && fitted.transcript.length < 2 && (
              <Notice type="error">This chat is too long for this model. Pick one with a larger context.</Notice>
            )}
            {error && (
              <Notice type="error">
                {error.message}
                {error.charged != null && Number(error.charged) > 0 && ` ${chargedLine(error.charged)}`}
              </Notice>
            )}
            <div className="inline-actions catchup-actions">
              <Button onClick={() => summarize()} disabled={!model || fitted.transcript.length < 2 || short}>
                <Icon name="catchup" size={15} />
                Summarize
              </Button>
              {error?.code === "seed_phrase_blocked" && seedGuard && (
                <Button secondary onClick={() => summarize({ allowSeed: true })}>
                  Summarize anyway
                </Button>
              )}
              <span className={"catchup-estimate" + (short || limited ? " short" : "")} role="status">
                {estimate.status === "loading"
                  ? "Updating estimate…"
                  : estimate.status === "unavailable"
                    ? estimate.message
                    : shown
                      ? short
                        ? `Up to ${formatCredits(shown.credits)} credits · over your balance`
                        : limited
                          ? `Up to ${formatCredits(shown.credits)} credits · over your spending limit`
                          : `Up to ${formatCredits(shown.credits)} credits · you pay only what it uses`
                      : ""}
              </span>
            </div>
          </>
        )}
        {phase === "running" && (
          <div className="catchup-running" role="status" aria-busy="true">
            <p>{`Summarizing ${fitted.transcript.length} messages with ${model?.name || model?.id}…`}</p>
            <div className="catchup-bar" aria-hidden="true">
              <span />
            </div>
            <Button secondary onClick={() => controller.current?.abort()}>
              <Icon name="stop" size={14} />
              Stop
            </Button>
          </div>
        )}
        {phase === "done" && result && (
          <>
            <SummaryView summary={result.summary} restore={restore} />
            <p className="catchup-meta">
              {[
                result.model ? `By ${result.model}` : "",
                result.charged != null ? chargedLine(result.charged) : "",
                result.omitted > 0
                  ? result.omitted === 1
                    ? "The oldest message wasn't included."
                    : `The oldest ${result.omitted} messages weren't included.`
                  : "",
                result.cut ? "The model hit its reply limit, so this may be incomplete." : "",
              ]
                .filter(Boolean)
                .map((part, i) => (
                  <span key={i}>{part}</span>
                ))}
            </p>
            <div className="inline-actions catchup-actions">
              <Button onClick={openContinue}>
                Continue fresh <Icon name="arrow" size={15} />
              </Button>
              <CopyButton text={summaryText(result.summary, { label: t, restore })} label="Copy summary" />
              <button type="button" className="small-button" onClick={() => setPhase("setup")}>
                <Icon name="refresh" size={14} />
                <span>Summarize again</span>
              </button>
            </div>
          </>
        )}
        {phase === "continue" && result && (
          <>
            <p className="catchup-lede">
              A new chat starts with this summary as its context, sent with each message instead of the whole history. Edit it first if you like.
            </p>
            <SavingsLine savings={savings} />
            <label className="catchup-draft">
              The summary the fresh chat carries
              <textarea
                data-i18n="off"
                value={draft}
                maxLength={MAX_CARRIED_CHARS}
                rows={9}
                onChange={(e) => setDraft(e.target.value)}
              />
            </label>
            <p className="catchup-note">
              <Icon name="shield" size={14} />
              <span>{STORAGE_NOTES[storage] || STORAGE_NOTES.saved}</span>
            </p>
            {error && <Notice type="error">{error.message}</Notice>}
            <div className="inline-actions catchup-actions">
              <Button onClick={start} disabled={starting || !draft.trim()}>
                {starting ? "Starting…" : "Start fresh chat"}
              </Button>
              <button type="button" className="small-button" onClick={() => setPhase("done")} disabled={starting}>
                <span>Back to the summary</span>
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
const fullCount = (full) => full.transcript.length;
const chargedLine = (credits) =>
  Number(credits) === 1 ? "Charged 1 credit." : `Charged ${formatCredits(credits)} credits.`;

