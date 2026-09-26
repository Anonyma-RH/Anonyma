import React, { useState, useRef, useEffect } from "react";
import { api, uid } from "./lib.js";
import {
  FILE_LIMIT,
  OFFICE_EXTENSIONS,
  extractOffice,
  browserInflate,
  textBytes,
} from "./file-formats.js";
import { SeedGuardNotice } from "./SeedGuard.jsx";
import { scanSecrets } from "./seed-guard.js";
import {
  MAX_DOCUMENTS,
  formatBytes,
  createUploadActivity,
} from "./documents.js";
import { CleanNote, KeepOriginal } from "./CleanUploads.jsx";
import "./reusable-uploads.css";
const ACCEPT =
  ".txt,.md,.csv,.json,.js,.ts,.jsx,.tsx,.py,.go,.rs,.java,.rb,.php,.c,.cpp,.h,.cs,.swift,.kt,.sql,.html,.css,.yaml,.yml,.toml,.sh,.docx,.xlsx,.pptx,.wav,.mp3,.flac,.ogg,.webm,.m4a";
const asBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(blob);
  });
const AUDIO = ["wav", "mp3", "flac", "ogg", "webm", "m4a"];
// Seed Guard: the text a saved upload would store, read in this browser the
// same way the server extracts it. Audio carries no text to scan.
async function scanFile(file) {
  const ext = file.name.split(".").at(-1).toLowerCase();
  if (AUDIO.includes(ext)) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = OFFICE_EXTENSIONS.includes(ext)
    ? (await extractOffice(bytes, ext, browserInflate)).text
    : textBytes(bytes);
  return scanSecrets(text);
}
export default function ReusableUploads({
  documents,
  setDocuments,
  disabled,
  privateContext,
  audioEnabled,
  cleanEnabled = false,
  onRefresh,
  // Bumped by the Command Palette's "Open saved files": opens this panel
  // exactly as its own button does, and never where that button is disabled.
  openRequest = 0,
  seedGuard = false,
}) {
  const [open, setOpen] = useState(false),
    [files, setFiles] = useState([]),
    [after, setAfter] = useState(null),
    [chosen, setChosen] = useState(null),
    [consent, setConsent] = useState(false),
    [days, setDays] = useState("7"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [audioFile, setAudioFile] = useState(null),
    [models, setModels] = useState([]),
    [model, setModel] = useState(""),
    [agree, setAgree] = useState(false),
    [transcript, setTranscript] = useState(null),
    [receipt, setReceipt] = useState(null),
    // Seed Guard's finding for the chosen file: null, "scanning" or a hit.
    [chosenSeed, setChosenSeed] = useState(null),
    // Clean Uploads: the chosen file with its hidden details removed, and
    // whether to save the original instead.
    [cleaned, setCleaned] = useState(null),
    [keep, setKeep] = useState(false);
  const lock = useRef(false),
    alive = useRef(true),
    activity = useRef(null),
    panel = useRef(null),
    requestId = useRef(null),
    seedScan = useRef(0),
    picked = useRef(0);
  if (!activity.current) activity.current = createUploadActivity();
  activity.current.update(privateContext, disabled);
  useEffect(() => {
    alive.current = true;
    activity.current.mount();
    return () => {
      alive.current = false;
      activity.current.dispose();
    };
  }, []);
  useEffect(() => {
    if (privateContext) {
      setOpen(false);
      choose(null);
      setAudioFile(null);
      setTranscript(null);
      setFiles([]);
      setConsent(false);
    }
  }, [privateContext]);
  useEffect(() => {
    if (open && !panel.current?.open) panel.current?.showModal();
  }, [open]);
  useEffect(() => {
    if (!openRequest || disabled || privateContext) return;
    setOpen(true);
    run((canAct) => load(undefined, canAct));
  }, [openRequest]);
  async function run(fn) {
    const canAct = activity.current.capture();
    if (lock.current || !canAct()) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn(canAct);
    } catch (e) {
      if (canAct())
        setError(
          e.message +
            (requestId.current
              ? " If a transcription result is uncertain, check your credits before starting another request."
              : ""),
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function load(cursor, canAct = activity.current.capture()) {
    if (!canAct()) return;
    const data = await api(
      "/api/files?limit=20" +
        (cursor ? "&after=" + encodeURIComponent(cursor) : ""),
    );
    if (!canAct()) return;
    setFiles((prev) =>
      !canAct() ? prev : cursor ? [...prev, ...data.data] : data.data,
    );
    setAfter(data.has_more ? data.last_id : null);
  }
  function attach(doc, canAct = activity.current.capture()) {
    if (!canAct()) return;
    setDocuments((prev) =>
      !canAct() || prev.length >= MAX_DOCUMENTS
        ? prev
        : [...prev, { ...doc, id: uid(), kind: "text" }],
    );
    setOpen(false);
  }
  // What Save sends: the cleaned bytes, unless the original is kept or
  // there's nothing to clean (plain text).
  const cleaning = cleanEnabled && !!chosen;
  const usesCleaned = cleaning && !keep && !!cleaned?.bytes && cleaned.status !== "none";
  const waiting = cleaning && (!cleaned || (cleaned.status === "failed" && !keep));
  // A chosen file is scanned by Seed Guard and, with Clean Uploads, has its
  // hidden details removed; Save waits for both.
  async function choose(f) {
    const pick = ++picked.current;
    setCleaned(null);
    setKeep(false);
    setChosen(f);
    const token = ++seedScan.current;
    if (!f || !seedGuard) setChosenSeed(null);
    else {
      setChosenSeed("scanning");
      scanFile(f)
        .catch(() => null)
        .then((hit) => {
          if (alive.current && token === seedScan.current) setChosenSeed(hit);
        });
    }
    if (!cleanEnabled || !f) return;
    await run(async (canAct) => {
      const { cleanUpload } = await import("./clean-uploads.js");
      const result = await cleanUpload(await f.arrayBuffer(), { name: f.name });
      if (canAct() && pick === picked.current) setCleaned(result);
    });
  }
  async function save({ allowSeed = false } = {}) {
    if (!chosen || !consent || waiting || chosenSeed === "scanning") return;
    if (chosenSeed && !allowSeed) return;
    await run(async (canAct) => {
      const data = await asBase64(usesCleaned ? new Blob([cleaned.bytes]) : chosen);
      if (!canAct()) return;
      await api("/api/files", {
        method: "POST",
        body: {
          filename: chosen.name,
          data,
          consent: true,
          retention_seconds: Number(days) * 86400,
        },
      });
      if (!canAct()) return;
      choose(null);
      setConsent(false);
      await load(undefined, canAct);
    });
  }
  async function prepareAudio(file) {
    await run(async (canAct) => {
      const catalog = await api("/api/audio/models");
      if (!canAct()) return;
      setModels(catalog.stt);
      setModel(catalog.stt[0]?.id || "");
      setAudioFile(file);
      requestId.current = uid();
      setAgree(false);
      setTranscript(null);
      setReceipt(null);
    });
  }
  const selected = models.find((m) => m.id === model),
    max = selected ? selected.max_minutes * selected.credits_per_minute : 0;
  async function transcribe() {
    if (!audioFile || !agree || !selected) return;
    await run(async (canAct) => {
      const response = await fetch(
        "/api/files/" + encodeURIComponent(audioFile.id) + "/content",
        { credentials: "same-origin" },
      );
      if (!response.ok)
        throw new Error("This saved audio file is no longer available.");
      const blob = await response.blob();
      if (!canAct()) return;
      if (blob.size > FILE_LIMIT)
        throw new Error("Audio exceeds the 10 MB limit.");
      const ext = audioFile.filename.split(".").at(-1).toLowerCase(),
        mime = {
          wav: "audio/wav",
          mp3: "audio/mpeg",
          flac: "audio/flac",
          ogg: "audio/ogg",
          webm: "audio/webm",
          m4a: "audio/mp4",
        }[ext];
      const audio = await asBase64(blob);
      if (!canAct()) return;
      const result = await api("/api/audio/transcriptions", {
        method: "POST",
        body: {
          audio: `data:${mime};base64,${audio}`,
          model,
          requestId: requestId.current,
        },
      });
      if (canAct()) {
        setTranscript(result.text);
        setReceipt(result.receipt);
        setAgree(false);
      }
      if (alive.current) onRefresh?.();
    });
  }
  return (
    <>
      <button
        type="button"
        className="attachment-control"
        disabled={disabled || privateContext}
        title={
          privateContext
            ? "Saved uploads are unavailable in Private, off-the-record or Veil contexts. Local attachments still work."
            : "Save and reuse owner-only files"
        }
        onClick={() => {
          setOpen(true);
          run((canAct) => load(undefined, canAct));
        }}
      >
        Saved files
      </button>
      {open && (
        <dialog
          className="uploads-dialog"
          ref={panel}
          aria-label="Files & Reusable Uploads"
          onCancel={(e) => {
            e.preventDefault();
            if (!busy) setOpen(false);
          }}
        >
          <section className="uploads-panel">
            <header>
              <div>
                <small>YOUR ACCOUNT · SAVED UPLOADS</small>
                <h2>Files & Reusable Uploads</h2>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </header>
            <p>
              Save only files you want on your account. Local attachments never
              enter this list automatically. Reusing text sends a copy with the
              next chat; deleting the upload does not erase copies already sent.
            </p>
            <p className="uploads-note">
              Up to 10 MB each · 50 files / 50 MB total · expires in 1, 7 or 30
              days. DOCX, XLSX and PPTX are text-only; no macros or formula
              calculation. PDF stays in local attachments.
            </p>
            {error && (
              <p role="alert" className="uploads-error">
                {error}
              </p>
            )}
            <div className="uploads-save">
              <label>
                Choose a file to save
                <input
                  type="file"
                  accept={ACCEPT}
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    setConsent(false);
                    setError("");
                    if (f?.size > FILE_LIMIT) {
                      choose(null);
                      setError("Files must be at most 10 MB.");
                    } else choose(f || null);
                  }}
                />
              </label>
              {chosen && (
                <>
                  <strong>
                    <span data-i18n="off">{chosen.name}</span> ·{" "}
                    {formatBytes(usesCleaned ? cleaned.bytes.length : chosen.size)}
                  </strong>
                  {cleaning && cleaned && cleaned.status !== "none" && (
                    <div className="clean-upload-note">
                      <CleanNote result={cleaned} keep={keep} />
                      <KeepOriginal checked={keep} onChange={setKeep} disabled={busy} />
                      {cleaned.status === "failed" && !keep && (
                        <small>Tick Keep original to save it as it is, or choose another file.</small>
                      )}
                    </div>
                  )}
                  <label>
                    Delete automatically after
                    <select
                      value={days}
                      onChange={(e) => setDays(e.target.value)}
                      disabled={busy}
                    >
                      <option value="1">1 day</option>
                      <option value="7">7 days</option>
                      <option value="30">30 days</option>
                    </select>
                  </label>
                  <label className="uploads-check">
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={busy}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    {usesCleaned
                      ? "Save the cleaned file and extracted text to my account."
                      : "Save the original bytes and extracted text to my account."}
                  </label>
                  <SeedGuardNotice
                    hit={chosenSeed === "scanning" ? null : chosenSeed}
                    verb="save"
                    busy={busy || !consent}
                    onProceed={() => save({ allowSeed: true })}
                  />
                  <button
                    type="button"
                    disabled={busy || !consent || !!chosenSeed || waiting}
                    onClick={() => save()}
                  >
                    Save for reuse · no generation charge
                  </button>
                </>
              )}
            </div>
            <div className="uploads-list">
              {!files.length && !busy && <p>No saved files yet.</p>}
              {files.map((file) => (
                <article key={file.id}>
                  <div>
                    <strong>{file.filename}</strong>
                    <small>
                      {formatBytes(file.bytes)} · {file.anonyma.kind} · expires{" "}
                      {new Date(file.expires_at * 1000).toLocaleDateString()}
                      {file.anonyma.truncated
                        ? " · extracted text trimmed"
                        : ""}
                    </small>
                  </div>
                  <div className="uploads-actions">
                    {file.anonyma.kind === "document" ? (
                      <button
                        type="button"
                        disabled={busy || documents.length >= MAX_DOCUMENTS}
                        onClick={() =>
                          run(async (canAct) =>
                            attach(
                              await api("/api/files/" + file.id + "/text"),
                              canAct,
                            ),
                          )
                        }
                      >
                        Attach text
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy || !audioEnabled}
                        onClick={() => prepareAudio(file)}
                      >
                        Review transcription
                      </button>
                    )}
                    <a href={"/api/files/" + file.id + "/content"} download>
                      Download original
                    </a>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        run(async (canAct) => {
                          await api("/api/files/" + file.id, {
                            method: "DELETE",
                          });
                          if (!canAct()) return;
                          if (audioFile?.id === file.id) {
                            setAudioFile(null);
                            setTranscript(null);
                          }
                          await load(undefined, canAct);
                        })
                      }
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
              {after && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run((canAct) => load(after, canAct))}
                >
                  Load more
                </button>
              )}
            </div>
            {audioFile && (
              <section className="uploads-audio">
                <h3>Transcribe {audioFile.filename}</h3>
                <p>
                  The audio goes to the selected transcription provider only
                  when you confirm below. The transcript remains in this panel
                  until you attach it. Attaching does not send the chat.
                </p>
                <label>
                  Transcription model
                  <select
                    disabled={busy}
                    value={model}
                    onChange={(e) => {
                      setModel(e.target.value);
                      requestId.current = uid();
                      setAgree(false);
                      setTranscript(null);
                    }}
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                {selected && (
                  <p>
                    {selected.credits_per_minute} credits per minute. Up to{" "}
                    {max.toFixed(2)} credits reserved for {selected.max_minutes}{" "}
                    minutes; actual duration charged. If duration is
                    unavailable, the maximum is charged. Personal balance pays.
                    Uploads over {selected.max_minutes} minutes are not
                    supported.
                  </p>
                )}
                <label className="uploads-check">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={agree}
                    onChange={(e) => setAgree(e.target.checked)}
                  />
                  I authorize this transcription and its credit charge.
                </label>
                <button
                  type="button"
                  disabled={busy || !agree || !selected || transcript !== null}
                  onClick={transcribe}
                >
                  {busy ? "Working…" : "Transcribe using credits"}
                </button>
                {transcript !== null && (
                  <>
                    <label>
                      Review transcript
                      <textarea
                        value={transcript}
                        onChange={(e) => setTranscript(e.target.value)}
                        rows={5}
                      />
                    </label>
                    <p>
                      {receipt?.credits_charged ?? 0} credits charged. Review
                      names and numbers before sending.
                    </p>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        !transcript.trim() ||
                        documents.length >= MAX_DOCUMENTS
                      }
                      onClick={() =>
                        attach({
                          name: audioFile.filename + ".transcript.txt",
                          text: transcript,
                          chars: transcript.length,
                        })
                      }
                    >
                      Attach reviewed transcript
                    </button>
                  </>
                )}
              </section>
            )}
            {busy && <p role="status">Working…</p>}
          </section>
        </dialog>
      )}
    </>
  );
}
