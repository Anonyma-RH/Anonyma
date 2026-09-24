import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon, Notice, Empty, BandLines, BandSteps } from "./ui.jsx";
import AsciiField from "./AsciiField.jsx";
import { api, streamChat, uid } from "./lib.js";
import { defaultSymposiumModels, buildFusionMessages, totalEstimate, pickerModels } from "./symposium.js";
import "./symposium.css";

const STATUS_LABEL = {
  pending: "Waiting…",
  streaming: "Answering…",
  done: "Complete",
  error: "Failed",
  stopped: "Stopped",
};
const emptyColumn = () => ({
  status: "pending",
  text: "",
  reasoning: "",
  citations: [],
  receipt: null,
  error: "",
});

// Symposium: ask 2-4 chat models the same question side by side, then
// optionally fuse their answers into one. Each model streams independently
// (see /api/chat) so one failure never blocks the others.
export default function Symposium({ demo, user, models, config, refresh }) {
  const welcome = useRef();
  const controllers = useRef({});
  const fuseController = useRef(null);
  const visibleModels = models.filter((m) => m.type === "chat" && m.callable);
  const [selected, setSelected] = useState([]),
    [prompt, setPrompt] = useState(""),
    [askedQuestion, setAskedQuestion] = useState(""),
    [runModels, setRunModels] = useState([]),
    [columns, setColumns] = useState({}),
    [fuseModel, setFuseModel] = useState(""),
    [fusion, setFusion] = useState(null),
    [quotes, setQuotes] = useState({}),
    [quoting, setQuoting] = useState(false),
    [error, setError] = useState(""),
    [pickerQuery, setPickerQuery] = useState("");
  const fusionCard = useRef(null);
  // Bring the fused answer into view as it starts, above the pinned composer.
  const fusionStarted = fusion?.status === "pending";
  useEffect(() => {
    if (fusionStarted) fusionCard.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [fusionStarted]);
  // Keep the picker valid as the catalog loads or callability changes,
  // without discarding a selection that is still good.
  useEffect(() => {
    setSelected((prev) => {
      const valid = prev.filter((id) => visibleModels.some((m) => m.id === id));
      return valid.length >= 2 ? valid : defaultSymposiumModels(visibleModels);
    });
  }, [models]);
  const busy = runModels.some((id) =>
    ["pending", "streaming"].includes(columns[id]?.status),
  );
  const allSettledRun =
    runModels.length > 0 &&
    runModels.every((id) => ["done", "error", "stopped"].includes(columns[id]?.status));
  const modelName = (id) => models.find((m) => m.id === id)?.name || id;
  function toggleModel(id) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.length <= 2 ? prev : prev.filter((x) => x !== id);
      return prev.length >= 4 ? prev : [...prev, id];
    });
    setQuotes({});
  }
  async function estimate() {
    const question = prompt.trim();
    if (!question || selected.length < 2 || quoting) return;
    setError("");
    setQuoting(true);
    const results = await Promise.allSettled(
      selected.map((id) =>
        api("/api/quote", {
          method: "POST",
          body: {
            model: id,
            messages: [{ role: "user", content: question }],
            max_tokens: 4096,
          },
        }).then((r) => ({ credits: r.credits })),
      ),
    );
    const next = {};
    results.forEach((r, i) => {
      next[selected[i]] =
        r.status === "fulfilled" ? r.value : { error: r.reason?.message || "Unavailable" };
    });
    setQuotes(next);
    setQuoting(false);
  }
  async function runOne(id, question) {
    const controller = new AbortController();
    controllers.current[id] = controller;
    let text = "",
      reasoning = "",
      citations = [];
    try {
      await streamChat(
        {
          model: id,
          messages: [{ role: "user", content: question }],
          mode: "symposium",
          max_tokens: 4096,
          requestId: uid(),
        },
        (event) => {
          if (event.error)
            throw new Error(event.error.message || "The stream ended with an error.");
          text += event.choices?.[0]?.delta?.content || "";
          reasoning +=
            event.choices?.[0]?.delta?.reasoning_content ||
            event.choices?.[0]?.delta?.reasoning ||
            "";
          if (event.anonyma?.citations) citations = event.anonyma.citations;
          setColumns((prev) => ({
            ...prev,
            [id]: {
              ...prev[id],
              status: "streaming",
              text,
              reasoning,
              citations,
              receipt: event.anonyma || prev[id]?.receipt || null,
            },
          }));
        },
        controller.signal,
      );
      setColumns((prev) => ({ ...prev, [id]: { ...prev[id], status: "done" } }));
    } catch (e) {
      setColumns((prev) => ({
        ...prev,
        [id]: {
          ...prev[id],
          status: e.name === "AbortError" ? "stopped" : "error",
          error:
            e.name === "AbortError"
              ? "Stopped. Partial output may have been billed."
              : e.message,
        },
      }));
    } finally {
      delete controllers.current[id];
    }
  }
  async function send(e) {
    e.preventDefault();
    const question = prompt.trim();
    if (!question || busy || selected.length < 2) return;
    if (!config?.services?.generation) {
      setError("Generation isn't currently available.");
      return;
    }
    setError("");
    setFusion(null);
    setAskedQuestion(question);
    setRunModels(selected);
    setFuseModel(selected[0]);
    setColumns(Object.fromEntries(selected.map((id) => [id, emptyColumn()])));
    setPrompt("");
    setQuotes({});
    await Promise.allSettled(selected.map((id) => runOne(id, question)));
    if (!demo) refresh();
  }
  function stopOne(id) {
    controllers.current[id]?.abort();
  }
  async function fuse() {
    const answers = runModels
      .map((id) => ({ id, name: modelName(id), text: columns[id]?.text || "" }))
      .filter((a) => a.text.trim());
    if (answers.length < 2) {
      setError("Not enough finished answers to fuse.");
      return;
    }
    setError("");
    const controller = new AbortController();
    fuseController.current = controller;
    setFusion({ status: "pending", text: "", receipt: null, error: "" });
    let text = "";
    try {
      await streamChat(
        {
          model: fuseModel,
          messages: buildFusionMessages({ question: askedQuestion, answers }),
          mode: "symposium",
          max_tokens: 4096,
          requestId: uid(),
        },
        (event) => {
          if (event.error)
            throw new Error(event.error.message || "The stream ended with an error.");
          text += event.choices?.[0]?.delta?.content || "";
          setFusion((prev) => ({
            ...prev,
            status: "streaming",
            text,
            receipt: event.anonyma || prev?.receipt || null,
          }));
        },
        controller.signal,
      );
      setFusion((prev) => ({ ...prev, status: "done" }));
    } catch (e) {
      setFusion((prev) => ({
        ...prev,
        status: e.name === "AbortError" ? "stopped" : "error",
        error:
          e.name === "AbortError"
            ? "Stopped. Partial output may have been billed."
            : e.message,
      }));
    } finally {
      fuseController.current = null;
      if (!demo) refresh();
    }
  }
  function stopFuse() {
    fuseController.current?.abort();
  }
  if (demo || !user)
    return (
      <div className="library-page">
        <Empty icon="chat" title="Ask several models at once.">
          Symposium sends the same question to 2 to 4 chat models side by side, then
          can fuse their answers into one. Sign in to try it; it isn't part of the demo.
        </Empty>
      </div>
    );
  return (
    <>
      <div className="chat-area">
        <div className="workspace-welcome" ref={welcome}>
          <AsciiField sectionRef={welcome} />
          <BandLines />
          <p className="eyebrow">SYMPOSIUM</p>
          <h1>Ask several models at once.</h1>
          <p>
            Choose 2 to 4 chat models, ask them the same question, and compare what
            comes back. Fuse the answers into one when they're done.
          </p>
          <BandSteps />
        </div>
        {runModels.length > 0 && (
          <div className="symposium-results" style={{ "--symposium-cols": runModels.length }}>
            {askedQuestion && <p className="symposium-question">{askedQuestion}</p>}
            <div className="symposium-columns">
              {runModels.map((id) => {
                const col = columns[id] || emptyColumn();
                return (
                  <article className="symposium-column" key={id}>
                    <header>
                      <b>{modelName(id)}</b>
                      {["pending", "streaming"].includes(col.status) ? (
                        <button type="button" className="small-button" onClick={() => stopOne(id)}>
                          <Icon name="stop" size={13} /> Stop
                        </button>
                      ) : (
                        <span className={"symposium-status " + col.status}>
                          {STATUS_LABEL[col.status] || col.status}
                        </span>
                      )}
                    </header>
                    <div className="markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {col.text || (col.status === "pending" ? "Preparing…" : "")}
                      </ReactMarkdown>
                    </div>
                    {col.error && <p className="symposium-error">{col.error}</p>}
                    {col.receipt && (
                      <div className="receipt">
                        <span className="sq" aria-hidden="true" />
                        {col.receipt.local_test ? "Test receipt" : "Receipt"} ·{" "}
                        {col.receipt.credits_charged} credits
                        {col.receipt.request_id && (
                          <span className="receipt-part">
                            Request {String(col.receipt.request_id).slice(0, 12)}
                          </span>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
            {allSettledRun && (
              <div className="symposium-fuse">
                {!fusion ? (
                  <div className="symposium-fuse-controls">
                    <label>
                      Fuse with
                      <select value={fuseModel} onChange={(e) => setFuseModel(e.target.value)}>
                        {runModels.map((id) => (
                          <option key={id} value={id}>
                            {modelName(id)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="button" className="small-button" onClick={fuse}>
                      <Icon name="models" size={14} /> Fuse answers
                    </button>
                  </div>
                ) : (
                  <article className="symposium-column symposium-fusion" ref={fusionCard}>
                    <header>
                      <b>Fused answer · {modelName(fuseModel)}</b>
                      {["pending", "streaming"].includes(fusion.status) ? (
                        <button type="button" className="small-button" onClick={stopFuse}>
                          <Icon name="stop" size={13} /> Stop
                        </button>
                      ) : (
                        <span className={"symposium-status " + fusion.status}>
                          {STATUS_LABEL[fusion.status] || fusion.status}
                        </span>
                      )}
                    </header>
                    <div className="markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {fusion.text || (fusion.status === "pending" ? "Preparing…" : "")}
                      </ReactMarkdown>
                    </div>
                    {fusion.error && <p className="symposium-error">{fusion.error}</p>}
                    {fusion.receipt && (
                      <div className="receipt">
                        <span className="sq" aria-hidden="true" />
                        {fusion.receipt.local_test ? "Test receipt" : "Receipt"} ·{" "}
                        {fusion.receipt.credits_charged} credits
                        {fusion.receipt.request_id && (
                          <span className="receipt-part">
                            Request {String(fusion.receipt.request_id).slice(0, 12)}
                          </span>
                        )}
                      </div>
                    )}
                  </article>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="composer-zone">
        {error && <Notice type="error">{error}</Notice>}
        {Object.keys(quotes).length > 0 && (
          <div className="receipt">
            Estimated total: {totalEstimate(quotes)} credits
            {selected.map(
              (id) =>
                quotes[id] && (
                  <span className="receipt-part" key={id}>
                    {modelName(id)} {quotes[id].error ? "—" : quotes[id].credits}
                  </span>
                ),
            )}
          </div>
        )}
        <form className="composer" onSubmit={send}>
          <textarea
            aria-label="Your question"
            placeholder="Ask every model the same question…"
            value={prompt}
            maxLength={48000}
            onChange={(e) => {
              setPrompt(e.target.value);
              setQuotes({});
            }}
            rows="3"
          />
          <div className="composer-controls">
            <span className="fine-print">
              {selected.length} of {visibleModels.length} models selected
            </span>
            <button
              type="submit"
              className="send-button"
              disabled={!prompt.trim() || busy || selected.length < 2}
              aria-label="Ask all models"
            >
              <Icon name="arrow" size={21} />
            </button>
          </div>
          <details className="compare-options">
            <summary>
              Models to compare ({selected.length}/4)
            </summary>
            <input
              className="symposium-filter"
              type="search"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder="Filter models"
              aria-label="Filter models"
            />
            {pickerModels(visibleModels, selected, pickerQuery).map((m) => (
              <label key={m.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(m.id)}
                  disabled={
                    busy || (selected.includes(m.id) ? selected.length <= 2 : selected.length >= 4)
                  }
                  onChange={() => toggleModel(m.id)}
                />
                {m.name}
              </label>
            ))}
          </details>
        </form>
        <div className="composer-caption">
          <span>Each model is billed separately at its own rate. AI can make mistakes.</span>
          <button
            type="button"
            onClick={estimate}
            disabled={!prompt.trim() || selected.length < 2 || quoting}
          >
            {quoting ? "Estimating…" : "Estimate credits"}
          </button>
        </div>
      </div>
    </>
  );
}
