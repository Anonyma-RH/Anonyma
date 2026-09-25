import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Notice } from "./ui.jsx";
import { api, streamChat, uid } from "./lib.js";
import { veilRemarkPlugin } from "./Veil.jsx";
import { SeedGuardNotice, useSeedScan } from "./SeedGuard.jsx";
import {
  checkerCandidates,
  checkSnapshot,
  canAsk,
  providerKey,
  providerLabel,
  CHECK_TOKENS,
  DISCLOSURE,
} from "./double-check.js";
import "./double-check.css";

// Double-check This: under one answer, pick a model from another provider,
// see the estimated extra cost, and ask it (only when the user presses the
// button) for a second opinion. The reviewed answer is never changed, and the
// request keeps the chat's storage: off the record and Private stay unsaved;
// otherwise it is saved apart as a Symposium run that expires no later than
// the reviewed conversation. With Veil active, the question and answer are
// masked (`mask`, the chat's own masker) once, and that same snapshot is
// both quoted and sent; the reply is shown with the chat's Veil map.
export default function DoubleCheck({
  answer,
  question,
  models,
  privateMode,
  ephemeral,
  sourceConversation,
  mask,
  maskPolicy = "off",
  veilMap,
  onClose,
  refresh,
  // Seed Guard is live: the question and answer are scanned before the
  // check's estimate or request can send them to another provider.
  seedGuard = false,
}) {
  const source = models.find((m) => m.id === answer.model) || {
    id: answer.model,
  };
  const sourceName = source.name || source.id;
  const candidates = checkerCandidates(models, source, {
    privateOnly: privateMode,
  });
  const [checker, setChecker] = useState(candidates[0]?.id || ""),
    [quote, setQuote] = useState(null),
    [retry, setRetry] = useState(0),
    // The result keeps the model that wrote it and the answer it reviewed,
    // so changing the selection afterwards never relabels it.
    [result, setResult] = useState(null);
  const controller = useRef(null),
    // Set synchronously, so a double click can't start two paid requests
    // before React re-renders.
    inflight = useRef(false);
  const snapshot = useMemo(
    () =>
      checkSnapshot({
        question,
        answer: answer.content,
        answerModel: sourceName,
        mask,
        policy: maskPolicy,
      }),
    // `mask` is recreated on every render; the policy key stands for it.
    [question, answer.content, sourceName, maskPolicy],
  );
  const seedTexts = useMemo(
    () => snapshot.messages.map((m) => (typeof m.content === "string" ? m.content : "")),
    [snapshot.key],
  );
  const seedHit = useSeedScan(seedGuard, seedTexts);
  // "Send anyway", confirmed: the estimate and Ask go ahead as usual.
  const [seedAllowed, setSeedAllowed] = useState(false);
  const seedBlocked = !!seedHit && !seedAllowed;
  useEffect(() => () => controller.current?.abort(), []);
  // The estimate is for this checker and this exact snapshot; anything else
  // is stale and Ask stays disabled until a fresh one settles.
  useEffect(() => {
    if (!checker || seedBlocked) return;
    let live = true;
    const key = snapshot.key;
    setQuote(null);
    api("/api/quote", {
      method: "POST",
      body: {
        model: checker,
        messages: snapshot.messages,
        max_tokens: CHECK_TOKENS,
      },
    })
      .then((r) => live && setQuote({ checker, key, credits: r.credits }))
      .catch((e) => live && setQuote({ checker, key, error: e.message }));
    return () => {
      live = false;
    };
  }, [checker, snapshot.key, retry, seedBlocked]);
  const running =
    result?.status === "pending" || result?.status === "streaming";
  const ready = canAsk({ checker, snapshotKey: snapshot.key, quote, running });
  const checkerName = models.find((m) => m.id === checker)?.name || checker;
  async function ask() {
    if (inflight.current || !ready || seedBlocked) return;
    inflight.current = true;
    controller.current = new AbortController();
    setResult({
      model: checker,
      modelName: checkerName,
      sourceName,
      status: "pending",
      text: "",
      error: "",
      receipt: null,
    });
    // Nothing to inherit a deletion time from (an unsaved source): keep the
    // check unsaved too.
    const unsaved = ephemeral || privateMode || !sourceConversation;
    let text = "";
    try {
      await streamChat(
        {
          model: checker,
          messages: snapshot.messages,
          mode: "symposium",
          max_tokens: CHECK_TOKENS,
          requestId: uid(),
          double_check: {
            source_model: source.id,
            ...(unsaved ? {} : { source_conversation: sourceConversation }),
          },
          ...(unsaved ? { ephemeral: true } : {}),
          ...(privateMode ? { private: true } : {}),
          ...(seedHit ? { allow_seed_phrase: true } : {}),
        },
        (event) => {
          if (event.error)
            throw new Error(
              event.error.message || "The stream ended with an error.",
            );
          text += event.choices?.[0]?.delta?.content || "";
          setResult((prev) => ({
            ...prev,
            status: "streaming",
            text,
            receipt: event.anonyma || prev.receipt,
          }));
        },
        controller.current.signal,
      );
      setResult((prev) => ({ ...prev, status: "done" }));
    } catch (e) {
      setResult((prev) => ({
        ...prev,
        status: e.name === "AbortError" ? "stopped" : "error",
        error:
          e.name === "AbortError"
            ? "Stopped. Partial output may have been billed."
            : e.message,
      }));
    } finally {
      inflight.current = false;
      controller.current = null;
      refresh?.();
    }
  }
  const unknownSource = !providerKey(source);
  return (
    <section className="double-check" aria-label="Double-check this answer">
      <header>
        <b>Double-check this</b>
        <button type="button" className="small-button" onClick={onClose}>
          Close
        </button>
      </header>
      <p className="fine-print">{DISCLOSURE}</p>
      <p className="fine-print">This second opinion uses your personal balance, even in a shared chat.</p>
      {!candidates.length ? (
        <Notice>
          {unknownSource
            ? "The provider of this answer's model isn't known, so a second opinion isn't available."
            : privateMode
              ? "No private model from another provider is available right now."
              : "No model from another provider is available right now."}
        </Notice>
      ) : (
        <>
          <SeedGuardNotice
            hit={seedBlocked ? seedHit : null}
            onProceed={() => setSeedAllowed(true)}
          />
          <div className="double-check-controls">
            <label>
              Second opinion from
              <select
                value={checker}
                disabled={running}
                onChange={(e) => setChecker(e.target.value)}
              >
                {candidates.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id} · {providerLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <span className="double-check-cost" aria-live="polite">
              {seedBlocked
                ? ""
                : quote?.credits != null &&
                    quote.checker === checker &&
                    quote.key === snapshot.key
                  ? `Estimated extra: ~${quote.credits} credits`
                  : quote?.error
                    ? "Estimate unavailable"
                    : "Estimating…"}
            </span>
            {running ? (
              <button
                type="button"
                className="small-button"
                onClick={() => controller.current?.abort()}
              >
                Stop
              </button>
            ) : quote?.error ? (
              <button
                type="button"
                className="small-button"
                onClick={() => setRetry((n) => n + 1)}
              >
                Retry estimate
              </button>
            ) : (
              <button
                type="button"
                className="small-button primary"
                disabled={!ready}
                onClick={ask}
              >
                Ask for a second opinion
              </button>
            )}
          </div>
          {snapshot.masked > 0 && (
            <p className="fine-print">
              {snapshot.masked === 1
                ? `${snapshot.masked} detail masked`
                : `${snapshot.masked} details masked`}
            </p>
          )}
          {result && (
            <div className="double-check-result">
              <div className="message-label">
                Second opinion from{" "}
                <span className="model-tag">{result.modelName}</span>
              </div>
              <p className="fine-print">{`On the answer from ${result.sourceName}.`}</p>
              <div className="markdown" data-i18n="off">
                <ReactMarkdown
                  remarkPlugins={[
                    remarkGfm,
                    [veilRemarkPlugin, { map: veilMap }],
                  ]}
                >
                  {result.text || (running ? "Reviewing…" : "")}
                </ReactMarkdown>
              </div>
              {result.receipt?.credits_charged != null && (
                <p className="fine-print">
                  {result.receipt.credits_charged} credits charged for this
                  second opinion.
                </p>
              )}
              {result.error && <Notice type="error">{result.error}</Notice>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
