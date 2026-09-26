import React, { useEffect, useRef, useState } from "react";
import { ReplyMarkdown } from "./RichMarkdown.jsx";
import remarkGfm from "remark-gfm";
import { Icon, Notice, Empty, BandLines, BandSteps } from "./ui.jsx";
import AsciiField from "./AsciiField.jsx";
import { api, streamChat, uid, isReleased } from "./lib.js";
import { VeilToggle, VeilPanel, veilRemarkPlugin } from "./Veil.jsx";
import { createVeilState } from "./veil.js";
import { TrainingTag, trainingLabelsReleased } from "./TrainingLabels.jsx";
import { PrivacyTrail, privacyTrailReleased } from "./PrivacyTrail.jsx";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import { scanSecrets } from "./seed-guard.js";
import { ProjectPicker } from "./Projects.jsx";
import {
  defaultSymposiumModels,
  buildFusionMessages,
  totalEstimate,
  pickerModels,
  veilQuestion,
  veilSegments,
} from "./symposium.js";
// Every column holds credits for its full output limit while it runs, so
// Symposium asks for shorter answers than chat to keep four at once
// within a normal balance. Fusion keeps the chat limit.
const COLUMN_TOKENS = 2048;
import { LowBalanceRefusal } from "./BalanceAlerts.jsx";
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
// (see /api/chat) so one failure never blocks the others. Veil uses the
// workspace's own setting and word list (passed in), so turning it on here
// or in chat is the same switch.
export default function Symposium({
  demo,
  user,
  models,
  config,
  refresh,
  veilOn = false,
  setVeilOn,
  veilWords = [],
  setVeilWords,
  // Projects: the account's projects (empty until released) and a callback
  // once a run is filed in one.
  projects = [],
  onFiled,
}) {
  const welcome = useRef();
  // This run's tag -> value map. It lives only in this browser tab: runs have
  // no thread to reopen, so nothing needs to be stored or sent.
  const veilState = useRef(createVeilState());
  const [veilNote, setVeilNote] = useState(null);
  const veilLive = !demo && isReleased(config, "veil");
  const trainingLive = !demo && trainingLabelsReleased(config);
  // Privacy Trail: each column's reply gets its own chip. The run's Veil
  // count (null: Veil off) is the only thing added to the request for it.
  const trailLive = !demo && privacyTrailReleased(config);
  const receiptsLive = isReleased(config, "receipts");
  const veilMasked = useRef(null);
  const trailBody = () => (trailLive ? { veil_masked: veilMasked.current } : {});
  const veilMarks = [veilRemarkPlugin, { map: veilState.current.map }];
  const controllers = useRef({});
  const fuseController = useRef(null);
  // Callable chat models only. Uncensored models stay in their own section,
  // as they do for the other text modes.
  const uncensoredIds = config?.releases?.uncensoredModels || [];
  const visibleModels = models.filter(
    (m) => m.type === "chat" && m.callable && !uncensoredIds.includes(m.id),
  );
  // Projects: the project this run is filed in, its instructions (masked
  // with the run's map when Veil is on) and id, fixed when the run starts so
  // the fusion step goes to the same place.
  const [projectId, setProjectId] = useState(null);
  const project = projects.find((p) => p.id === projectId) || null;
  const runProject = useRef({ id: null, instructions: "" });
  const withInstructions = (messages) =>
    runProject.current.instructions
      ? [{ role: "system", content: runProject.current.instructions }, ...messages]
      : messages;
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
  // Seed Guard: the question is scanned before it can go to any model.
  const seedLive = !demo && seedGuardLive(config);
  const seedHit = useSeedScan(seedLive, prompt);
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
  }, [models, config]);
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
    if (!question || selected.length < 2 || quoting || seedHit) return;
    setError("");
    setQuoting(true);
    // Quote what would be sent: masked with a throwaway map when Veil is on.
    const quoteState = createVeilState();
    const { text } = veilQuestion(question, {
      on: veilOn && veilLive,
      state: quoteState,
      words: veilWords,
    });
    const own = project?.instructions?.trim()
      ? veilQuestion(project.instructions.trim(), { on: veilOn && veilLive, state: quoteState, words: veilWords }).text
      : "";
    const results = await Promise.allSettled(
      selected.map((id) =>
        api("/api/quote", {
          method: "POST",
          body: {
            model: id,
            messages: [
              ...(own ? [{ role: "system", content: own }] : []),
              { role: "user", content: text },
            ],
            max_tokens: COLUMN_TOKENS,
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
  async function runOne(id, question, allowSeed = false) {
    const controller = new AbortController();
    controllers.current[id] = controller;
    let text = "",
      reasoning = "",
      citations = [];
    try {
      await streamChat(
        {
          model: id,
          messages: withInstructions([{ role: "user", content: question }]),
          mode: "symposium",
          max_tokens: COLUMN_TOKENS,
          requestId: uid(),
          ...(runProject.current.id ? { project: runProject.current.id } : {}),
          ...trailBody(),
          ...(allowSeed ? { allow_seed_phrase: true } : {}),
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
              : e.status === 402
                ? "Not enough credits right now: the other answers are holding credits while they run. Add credits or compare fewer models."
                : e.message,
        },
      }));
    } finally {
      delete controllers.current[id];
    }
  }
  // `allowSeed` is Seed Guard's confirmed "Send anyway".
  async function send(e, { allowSeed = false } = {}) {
    e?.preventDefault();
    const question = prompt.trim();
    if (!question || busy || selected.length < 2) return;
    if (seedHit && !allowSeed) return;
    if (!config?.services?.generation) {
      setError("Generation isn't currently available.");
      return;
    }
    setError("");
    setFusion(null);
    // Mask once per run: every column and the fusion step send this text.
    veilState.current = createVeilState();
    const masked = veilQuestion(question, {
      on: veilOn && veilLive,
      state: veilState.current,
      words: veilWords,
    });
    // The project's instructions lead every column's request, masked with
    // the same map as the question.
    const own = project?.instructions?.trim()
      ? veilQuestion(project.instructions.trim(), {
          on: veilOn && veilLive,
          state: veilState.current,
          words: veilWords,
        })
      : null;
    runProject.current = { id: project?.id || null, instructions: own?.text || "" };
    const count = masked.count + (own?.count || 0);
    setVeilNote(
      count
        ? { count, entries: [...masked.entries, ...(own?.entries || []).filter((e) => !masked.entries.some((m) => m.tag === e.tag))] }
        : null,
    );
    veilMasked.current = veilOn && veilLive ? count : null;
    setAskedQuestion(masked.text);
    setRunModels(selected);
    setFuseModel(selected[0]);
    setColumns(Object.fromEntries(selected.map((id) => [id, emptyColumn()])));
    setPrompt("");
    setQuotes({});
    await Promise.allSettled(
      selected.map((id) => runOne(id, masked.text, seedHit?.kind === "seed")),
    );
    if (!demo) refresh();
    if (runProject.current.id) onFiled?.();
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
    // Fusing resends the question every column already received (confirmed
    // then if Seed Guard stopped it) with the models' answers.
    const messages = withInstructions(buildFusionMessages({ question: askedQuestion, answers }));
    const resent =
      seedLive && scanSecrets(messages.map((m) => m.content))?.kind === "seed";
    try {
      await streamChat(
        {
          model: fuseModel,
          messages,
          mode: "symposium",
          max_tokens: 4096,
          requestId: uid(),
          ...(runProject.current.id ? { project: runProject.current.id } : {}),
          ...trailBody(),
          ...(resent ? { allow_seed_phrase: true } : {}),
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
          {/* A div, not a p: the band styles its last paragraph. */}
          <div className="symposium-saved">
            Symposium runs are saved to your account, even with Private Mode on.
            {project && (
              <>
                {" "}
                <span>This run goes in the project</span>{" "}
                <b data-i18n="off">{project.name}</b>
                <span>, with its instructions.</span>
              </>
            )}
          </div>
          <BandSteps />
        </div>
        {runModels.length > 0 && (
          <div className="symposium-results" style={{ "--symposium-cols": runModels.length }}>
            {askedQuestion && (
              <p className="symposium-question" data-i18n="off">
                {veilSegments(askedQuestion, veilState.current.map).map((part, i) =>
                  part.tag ? (
                    <mark
                      key={i}
                      className="veil-mark"
                      title={`Veiled — the model saw [${part.tag}]`}
                    >
                      {part.value}
                    </mark>
                  ) : (
                    <React.Fragment key={i}>{part.text}</React.Fragment>
                  ),
                )}
              </p>
            )}
            {veilNote?.count > 0 && (
              <p className="symposium-veil-note">
                {`Veiled ${veilNote.count} detail${veilNote.count === 1 ? "" : "s"} before sending. The real values show only in this browser.`}
              </p>
            )}
            <div className="symposium-columns">
              {runModels.map((id) => {
                const col = columns[id] || emptyColumn();
                return (
                  <article className="symposium-column" key={id}>
                    <header>
                      <b data-i18n="off">{modelName(id)}</b>
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
                    <div className="markdown" data-i18n={col.text ? "off" : undefined}>
                      <ReplyMarkdown rich={!!col.text} remarkPlugins={[remarkGfm, veilMarks]}>
                        {col.text || (col.status === "pending" ? "Preparing…" : "")}
                      </ReplyMarkdown>
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
                    {trailLive && col.receipt?.privacy && (
                      <PrivacyTrail
                        privacy={col.receipt.privacy}
                        models={models}
                        receiptsLive={receiptsLive}
                      />
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
                      <select
                        data-i18n="off"
                        value={fuseModel}
                        onChange={(e) => setFuseModel(e.target.value)}
                      >
                        {runModels.map((id) => (
                          <option key={id} value={id}>
                            {modelName(id)}
                          </option>
                        ))}
                      </select>
                      {trainingLive &&
                        visibleModels.find((m) => m.id === fuseModel)?.trainsOnPrompts && (
                          <TrainingTag
                            model={visibleModels.find((m) => m.id === fuseModel)}
                            models={visibleModels}
                          />
                        )}
                    </label>
                    <button type="button" className="small-button" onClick={fuse}>
                      <Icon name="models" size={14} /> Fuse answers
                    </button>
                  </div>
                ) : (
                  <article className="symposium-column symposium-fusion" ref={fusionCard}>
                    <header>
                      <b>
                        Fused answer · <span data-i18n="off">{modelName(fuseModel)}</span>
                      </b>
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
                    <div className="markdown" data-i18n={fusion.text ? "off" : undefined}>
                      <ReplyMarkdown rich={!!fusion.text} remarkPlugins={[remarkGfm, veilMarks]}>
                        {fusion.text || (fusion.status === "pending" ? "Preparing…" : "")}
                      </ReplyMarkdown>
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
                    {trailLive && fusion.receipt?.privacy && (
                      <PrivacyTrail
                        privacy={fusion.receipt.privacy}
                        models={models}
                        receiptsLive={receiptsLive}
                      />
                    )}
                  </article>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="composer-zone">
        {error && (
          <Notice type="error">
            {error}
            <LowBalanceRefusal config={config} user={user} demo={demo} error={error} />
          </Notice>
        )}
        {Object.keys(quotes).length > 0 && (
          <div className="receipt">
            Estimated total: {totalEstimate(quotes)} credits
            {selected.map(
              (id) =>
                quotes[id] && (
                  <span className="receipt-part" key={id}>
                    <span data-i18n="off">{modelName(id)}</span>{" "}
                    {quotes[id].error ? "—" : quotes[id].credits}
                  </span>
                ),
            )}
          </div>
        )}
        <SeedGuardNotice
          hit={seedHit}
          busy={busy}
          onProceed={() => send(null, { allowSeed: true })}
        />
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
            <div>
              {veilLive && (
                <VeilToggle
                  on={veilOn}
                  onToggle={() => {
                    setVeilOn?.((v) => !v);
                    setQuotes({});
                  }}
                />
              )}
              {projects.length > 0 && (
                <ProjectPicker
                  className="inline"
                  projects={projects}
                  value={projectId}
                  onChange={setProjectId}
                  disabled={busy}
                />
              )}
              <span className="fine-print">
                {selected.length} of {visibleModels.length} models selected
              </span>
            </div>
            <button
              type="submit"
              className="send-button"
              disabled={!prompt.trim() || busy || selected.length < 2 || !!seedHit}
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
                <span data-i18n="off">{m.name}</span>
                {trainingLive && m.trainsOnPrompts && (
                  <TrainingTag model={m} models={visibleModels} />
                )}
              </label>
            ))}
          </details>
        </form>
        <div className="composer-caption">
          <span>Each model is billed separately at its own rate. AI can make mistakes.</span>
          {veilLive && (
            <VeilPanel note={veilNote} words={veilWords} onWordsChange={(w) => setVeilWords?.(w)} />
          )}
          <button
            type="button"
            onClick={estimate}
            disabled={!prompt.trim() || selected.length < 2 || quoting || !!seedHit}
          >
            {quoting ? "Estimating…" : "Estimate credits"}
          </button>
        </div>
      </div>
    </>
  );
}
