import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Icon, Notice } from "./ui.jsx";
import { api, download, isReleased } from "./lib.js";
import { t } from "./i18n.js";
import { formatBytes } from "./documents.js";
import { MAX_VAULT_CHATS } from "./device-vault.js";
import { openEngine } from "./chat-import-client.js";
import { importToAccount, importToMarkdown, importToVault } from "./chat-import-run.js";
import {
  MAX_FILE_BYTES,
  MAX_FILE_LABEL,
  chatProblem,
  chosenIds,
  destinationRoom,
  selectAll as selectAllIn,
  selectNone as selectNoneIn,
  sourceName,
} from "./chat-import.js";
import "./seed-guard.css";
import "./chat-import.css";

// Chat Import (update "chatimport"): the page at /workspace/import. The
// export is opened and read in this browser (src/chat-import-engine.js, in
// a worker); nothing is uploaded until the person picks "Your account", and
// then only the chats they chose, as their words and dates. The other two
// destinations make no request at all: Device Vault seals the chats on this
// device, and Markdown writes files here. Attachments, images, tool steps
// and hidden reasoning are not imported.

const PAGE = 100;
const REASONS = {
  already_imported: "already imported",
  seed_phrase_blocked: "held back by Seed Guard",
  too_large: "too large for your account",
  conversation_limit: "over your account's chat limit",
  empty: "couldn't be read",
  invalid: "couldn't be read",
};
const count = (n, one, many) => (n === 1 ? one : many.replace("{n}", n.toLocaleString("en-US")));
const day = (ms) => (ms ? new Date(ms).toLocaleDateString() : "");

const PHASES = {
  reading: "Opening the file…",
  unzipping: "Unzipping it here…",
  parsing: "Reading the chats…",
  parsed: "Reading the chats…",
  checking: "Checking for seed phrases…",
};

export default function ChatImport({ demo, user, config, vault, vaultLive, onUnlockVault, onImported }) {
  const navigate = useNavigate();
  const seedLive = isReleased(config, "seedguard");
  const signedIn = !demo && !!user;
  const vaultOpen = vaultLive && !!vault?.unlocked;

  const [stage, setStage] = useState("start");
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [overview, setOverview] = useState(null);
  const [dest, setDest] = useState(vaultLive ? "vault" : signedIn ? "account" : "markdown");
  const [selected, setSelected] = useState(() => new Set());
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState(null);
  const [shown, setShown] = useState(PAGE);
  const [allow, setAllow] = useState(() => new Set());
  const [confirming, setConfirming] = useState(null);
  const [status, setStatus] = useState(null);
  const [work, setWork] = useState(null);
  const [result, setResult] = useState(null);
  const engine = useRef(null);
  const input = useRef(null);
  const loadToken = useRef(0);
  const searchToken = useRef(0);
  const control = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      control.current?.abort();
      engine.current?.close();
    };
  }, []);
  // Never leave a dead destination chosen (Device Vault not available, or not
  // signed in for the account).
  useEffect(() => {
    if (dest === "vault" && !vaultLive) setDest(signedIn ? "account" : "markdown");
    if (dest === "account" && !signedIn) setDest(vaultLive ? "vault" : "markdown");
  }, [dest, vaultLive, signedIn]);

  const source = overview?.source || null;
  const chats = overview?.chats || [];

  // What the account can take, and which chats it already has from this
  // service (so a repeat isn't imported twice).
  async function loadStatus() {
    if (!signedIn) return setStatus(null);
    try {
      setStatus(await api("/api/import/status"));
    } catch {
      setStatus(null);
    }
  }

  async function pick(f) {
    if (!f) return;
    setError("");
    if (f.size > MAX_FILE_BYTES) {
      setError(`This file is over ${MAX_FILE_LABEL}. Choose a smaller export, or the conversations.json from inside it.`);
      return;
    }
    const token = ++loadToken.current;
    engine.current?.close();
    engine.current = openEngine();
    setFile({ name: f.name, size: f.size });
    setStage("reading");
    setProgress({ phase: "reading" });
    try {
      const view = await engine.current.load(f, {
        seedGuard: seedLive,
        onProgress: (p) => token === loadToken.current && mounted.current && setProgress(p),
      });
      if (token !== loadToken.current || !mounted.current) return;
      setOverview(view);
      setSelected(new Set());
      setAllow(new Set());
      setConfirming(null);
      setQuery("");
      setMatches(null);
      setShown(PAGE);
      setResult(null);
      setStage("list");
      loadStatus();
    } catch (e) {
      if (token !== loadToken.current || !mounted.current) return;
      engine.current?.close();
      engine.current = null;
      setError(e?.message || "This file couldn't be read.");
      setStage("start");
    }
  }
  function reset() {
    loadToken.current++;
    control.current?.abort();
    engine.current?.close();
    engine.current = null;
    setStage("start");
    setOverview(null);
    setFile(null);
    setError("");
    setResult(null);
    setSelected(new Set());
    setQuery("");
    setMatches(null);
  }

  // Search runs in the worker over titles and messages.
  useEffect(() => {
    if (stage !== "list") return;
    const q = query.trim();
    const token = ++searchToken.current;
    if (!q) {
      setMatches(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const ids = await engine.current.search(q);
        if (token === searchToken.current && mounted.current) {
          setMatches(ids);
          setShown(PAGE);
        }
      } catch {
        if (token === searchToken.current) setMatches([]);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query, stage]);

  // ---- What can be chosen, for the destination picked ----
  const vaultKeys = useMemo(
    () => new Set((vault?.chats || []).filter((c) => c.importedFrom === source && c.importKey).map((c) => c.importKey)),
    [vault?.chats, source],
  );
  const accountKeys = useMemo(() => new Set(status?.imported?.[source] || []), [status, source]);
  const known = dest === "vault" ? vaultKeys : dest === "account" ? accountKeys : null;
  const rules = { dest, known, allow, seedLive };
  // Why a chat can't be chosen right now, or null.
  const problem = (c) => chatProblem(c, rules);
  const visible = matches ? matches.map((id) => chats[id]).filter(Boolean) : chats;
  const chosen = useMemo(
    () => chosenIds(selected, chats, rules),
    [selected, chats, dest, known, allow, seedLive],
  );
  const room = destinationRoom(dest, { status, vaultCount: vault?.chats?.length || 0, vaultMax: MAX_VAULT_CHATS });
  const over = chosen.length > room;
  const ready =
    stage === "list" &&
    chosen.length > 0 &&
    !over &&
    (dest !== "vault" || vaultOpen) &&
    (dest !== "account" || !!status);

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAll = () => setSelected((prev) => selectAllIn(prev, visible, rules));
  const selectNone = () => setSelected((prev) => selectNoneIn(prev, visible, !!matches));

  async function start() {
    if (!ready) return;
    const ids = chosen;
    const controller = new AbortController();
    control.current = controller;
    setError("");
    setWork({ done: 0, total: ids.length, dest });
    setStage("working");
    const onProgress = (p) => mounted.current && setWork({ ...p, dest });
    let out;
    try {
      if (dest === "account")
        out = await importToAccount({
          engine: engine.current,
          ids,
          source,
          allow,
          // Stop takes effect between batches, so what was done is exact.
          post: (body) => api("/api/import/chats", { method: "POST", body }),
          onProgress,
          signal: controller.signal,
        });
      else if (dest === "vault")
        out = await importToVault({ engine: engine.current, ids, source, vault, onProgress, signal: controller.signal });
      else {
        out = await importToMarkdown({ engine: engine.current, ids, source, label: t, onProgress, signal: controller.signal });
        if (out.download) download(out.download.name, out.download.blob, out.download.blob.type);
      }
    } catch (e) {
      out = { saved: [], skipped: [], error: e, left: ids };
    }
    if (!mounted.current) return;
    control.current = null;
    if (dest === "account") {
      loadStatus();
      if (out.saved?.length) onImported?.();
    }
    setResult({ ...out, dest, requested: ids.length });
    setSelected(new Set());
    setStage("done");
  }
  const stop = () => control.current?.abort();

  // ---- Screens ----
  const dropProps = {
    onDragOver: (e) => {
      if (stage !== "start") return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e) => e.currentTarget.contains(e.relatedTarget) || setDragging(false),
    onDrop: (e) => {
      if (stage !== "start") return;
      e.preventDefault();
      setDragging(false);
      pick(e.dataTransfer?.files?.[0]);
    },
  };

  return (
    <section className={"import-page" + (dragging ? " dragging" : "")} {...dropProps}>
      <div className={"import-head" + (stage === "start" ? "" : " compact")}>
        <div>
          <p className="eyebrow">IMPORT CHATS</p>
          <h1>Import chats</h1>
          <p>Bring your ChatGPT or Claude history with you. It's read in your browser, and you choose what to keep.</p>
        </div>
        {stage !== "start" && stage !== "working" && (
          <button type="button" className="import-secondary" onClick={reset}>
            <Icon name="plus" size={14} />
            Choose another file
          </button>
        )}
      </div>
      {error && <Notice type="error">{error}</Notice>}
      <input
        ref={input}
        type="file"
        hidden
        accept=".zip,.json,application/zip,application/json"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          pick(f);
        }}
      />
      {stage === "start" && <Start dragging={dragging} onChoose={() => input.current?.click()} />}
      {stage === "reading" && <Reading file={file} progress={progress} />}
      {stage === "list" && (
        <List
          overview={overview}
          file={file}
          source={source}
          dest={dest}
          setDest={setDest}
          signedIn={signedIn}
          vault={vault}
          vaultLive={vaultLive}
          vaultOpen={vaultOpen}
          onUnlockVault={onUnlockVault}
          status={status}
          seedLive={seedLive}
          veilLive={isReleased(config, "veil")}
          visible={visible}
          selected={selected}
          query={query}
          setQuery={setQuery}
          shown={shown}
          setShown={setShown}
          problem={problem}
          toggle={toggle}
          selectAll={selectAll}
          selectNone={selectNone}
          allow={allow}
          setAllow={setAllow}
          confirming={confirming}
          setConfirming={setConfirming}
          chosen={chosen}
          room={room}
          over={over}
          ready={ready}
          onStart={start}
          demo={demo}
        />
      )}
      {stage === "working" && <Working work={work} onStop={stop} />}
      {stage === "done" && (
        <Done
          result={result}
          source={source}
          overview={overview}
          config={config}
          navigate={navigate}
          onMore={() => {
            setResult(null);
            setStage("list");
          }}
        />
      )}
    </section>
  );
}

// ---- Choosing the file ----

function Start({ dragging, onChoose }) {
  return (
    <>
      <div className={"import-drop" + (dragging ? " dragging" : "")}>
        <span className="import-drop-icon" aria-hidden="true">
          <Icon name="import" size={22} />
        </span>
        <b>Drop your export here</b>
        <small>{`The ZIP from ChatGPT or Claude, or the conversations.json inside it. Up to ${MAX_FILE_LABEL}.`}</small>
        <button type="button" className="button" onClick={onChoose}>
          <Icon name="upload" size={15} />
          Choose your export
        </button>
      </div>
      <div className="import-how">
        <div>
          <b>ChatGPT</b>
          <span>In its settings, find Data controls and choose Export data. It emails you a ZIP.</span>
        </div>
        <div>
          <b>Claude</b>
          <span>In its settings, find Privacy and choose Export data. It emails you a ZIP.</span>
        </div>
      </div>
      <ul className="import-promises">
        <li>
          <b>Read in this browser</b>
          <span>Your export is opened and read here. It isn't uploaded, and ANONYMA never sees the file.</span>
        </li>
        <li>
          <b>You choose what to keep</b>
          <span>Pick chats one by one, or search and select all. Then choose where they go.</span>
        </li>
        <li>
          <b>Only the words</b>
          <span>Attachments, images, tool steps and hidden reasoning aren't imported. Projects, memories and custom instructions aren't either.</span>
        </li>
      </ul>
    </>
  );
}

function Reading({ file, progress }) {
  const phase = progress?.phase || "reading";
  const checking = phase === "checking" && progress?.total;
  return (
    <div className="import-panel" role="status">
      <div className="import-file">
        <span className="import-drop-icon" aria-hidden="true">
          <Icon name="import" size={20} />
        </span>
        <div className="import-file-text">
          <b data-i18n="off">{file?.name}</b>
          <small>{formatBytes(file?.size || 0)}</small>
        </div>
      </div>
      <p className="import-phase">{PHASES[phase] || PHASES.reading}</p>
      {progress?.chats > 0 && phase !== "checking" && (
        <p className="import-fine">{`${progress.chats.toLocaleString("en-US")} chats so far`}</p>
      )}
      <div className="import-bar" aria-hidden="true">
        <span
          className={checking ? "" : "moving"}
          style={checking ? { width: Math.round((progress.done / progress.total) * 100) + "%" } : undefined}
        />
      </div>
      <p className="import-fine">This all happens on your device. Nothing is uploaded.</p>
    </div>
  );
}

// ---- The list and the destinations ----

function List(p) {
  const { overview, file, source, dest, setDest, signedIn, vault, vaultLive, vaultOpen, status, seedLive } = p;
  const name = sourceName(source);
  const shownRows = p.visible.slice(0, p.shown);
  const selectedHere = p.visible.filter((c) => p.selected.has(c.id) && !p.problem(c)).length;
  const label =
    dest === "markdown"
      ? p.chosen.length === 1
        ? "Download 1 chat as Markdown"
        : `Download ${p.chosen.length.toLocaleString("en-US")} chats as Markdown`
      : p.chosen.length === 1
        ? "Import 1 chat"
        : `Import ${p.chosen.length.toLocaleString("en-US")} chats`;
  return (
    <>
      <div className="import-summary">
        <div className="import-file">
          <span className="import-drop-icon" aria-hidden="true">
            <Icon name="import" size={20} />
          </span>
          <div className="import-file-text">
            <b>{`${name} export`}</b>
            <small data-i18n="off">{`${file?.name} · ${formatBytes(file?.size || 0)}`}</small>
          </div>
        </div>
        <ul className="import-facts">
          <li>{count(overview.chats.length, "1 chat found", "{n} chats found")}</li>
          <li>{count(overview.messages, "1 message", "{n} messages")}</li>
          {overview.attachments > 0 && (
            <li>{count(overview.attachments, "1 attachment or image left out", "{n} attachments and images left out")}</li>
          )}
          {overview.empty > 0 && <li>{count(overview.empty, "1 empty chat not listed", "{n} empty chats not listed")}</li>}
        </ul>
      </div>

      <h2 className="import-step">1. Choose where they go</h2>
      <div className="import-dests" role="radiogroup" aria-label="Where the chats go">
        <Dest
          id="vault"
          active={dest === "vault"}
          disabled={!vaultLive || vault?.status === "unavailable"}
          onPick={() => setDest("vault")}
          title="Device Vault"
          tag="Recommended"
          text="Encrypted on this device, with your passphrase. ANONYMA's servers never see these chats."
          off={!vaultLive ? "Device Vault isn't available here." : vault?.status === "unavailable" ? "This browser can't keep a vault." : ""}
        />
        <Dest
          id="account"
          active={dest === "account"}
          disabled={!signedIn}
          onPick={() => setDest("account")}
          title="Your account"
          text="Saved with your other chats and marked as imported. Only the chats you choose are uploaded."
          off={!signedIn ? "Sign in to save chats to an account." : ""}
        />
        <Dest
          id="markdown"
          active={dest === "markdown"}
          onPick={() => setDest("markdown")}
          title="Markdown files"
          text="Downloads readable .md files. Nothing is saved anywhere."
        />
      </div>
      {dest === "vault" && vaultLive && vault?.status !== "unavailable" && !vaultOpen && (
        <div className="import-inline">
          <Icon name="lock" size={14} />
          <span>{vault?.status === "none" ? "Set up Device Vault to keep the chats on this device." : "Unlock Device Vault to keep the chats on this device."}</span>
          <button type="button" className="small-button" onClick={() => p.onUnlockVault?.()}>
            {vault?.status === "none" ? "Set up" : "Unlock"}
          </button>
        </div>
      )}
      {dest === "vault" && vaultOpen && vault?.synced && (
        <p className="import-fine">Vault Sync is on, so these chats also sync, still encrypted, to your other devices.</p>
      )}
      {dest === "account" && status && (
        <>
          <p className="import-fine">
            {`Your account keeps up to ${status.cap.toLocaleString("en-US")} saved chats and has room for ${status.room.toLocaleString("en-US")} more. Older chats are removed first as you add new ones.`}
          </p>
          {status.retention_days ? (
            <p className="import-fine">
              {status.retention_days === 1
                ? "Your auto-delete setting of 1 day applies to imported chats too."
                : `Your auto-delete setting of ${status.retention_days} days applies to imported chats too.`}
            </p>
          ) : null}
        </>
      )}
      {dest === "account" && !status && <p className="import-fine">Checking what your account can take…</p>}
      {p.veilLive && <p className="import-fine">Chats come over exactly as written. Veil doesn't change them.</p>}
      {dest === "account" && seedLive && (
        <p className="import-fine">Seed Guard checks every chat first. One that holds a wallet seed phrase or private key is held back unless you allow it.</p>
      )}

      <h2 className="import-step">2. Choose the chats</h2>
      <div className="import-tools">
        <label className="import-search">
          <Icon name="search" size={15} />
          <input
            type="search"
            placeholder="Search titles and messages"
            aria-label="Search titles and messages"
            maxLength={200}
            value={p.query}
            onChange={(e) => p.setQuery(e.target.value)}
          />
        </label>
        <button type="button" className="import-secondary" onClick={p.selectAll} disabled={!p.visible.length}>
          {p.query.trim() ? "Select all shown" : "Select all"}
        </button>
        <button type="button" className="import-secondary" onClick={p.selectNone} disabled={!selectedHere && !p.selected.size}>
          Select none
        </button>
      </div>
      <p className="import-count" role="status">
        {p.query.trim()
          ? `${p.visible.length.toLocaleString("en-US")} of ${overview.chats.length.toLocaleString("en-US")} chats match. ${p.chosen.length.toLocaleString("en-US")} selected.`
          : `${p.chosen.length.toLocaleString("en-US")} of ${overview.chats.length.toLocaleString("en-US")} chats selected.`}
      </p>
      {p.visible.length === 0 ? (
        <p className="import-none">No chats match that search.</p>
      ) : (
        <ul className="import-list">
          {shownRows.map((c) => (
            <Row key={c.id} c={c} p={p} />
          ))}
        </ul>
      )}
      {p.visible.length > p.shown && (
        <button type="button" className="import-secondary import-more" onClick={() => p.setShown(p.shown + PAGE)}>
          {`Show ${Math.min(PAGE, p.visible.length - p.shown)} more`}
        </button>
      )}

      <div className="import-go">
        {p.over && (
          <p className="import-block" role="alert">
            <Icon name="warning" size={14} />
            {dest === "vault"
              ? `Device Vault has room for ${p.room.toLocaleString("en-US")} more chats. Choose fewer.`
              : `Your account has room for ${p.room.toLocaleString("en-US")} more chats. Choose fewer, or use Device Vault or Markdown files.`}
          </p>
        )}
        <button type="button" className="button" disabled={!p.ready} onClick={p.onStart}>
          <Icon name={dest === "markdown" ? "download" : "import"} size={15} />
          {label}
        </button>
      </div>
      <p className="import-fine">
        {dest === "account"
          ? "Only the chats you chose are uploaded: their words and dates, nothing else. No model is used and nothing is charged."
          : dest === "vault"
            ? "Nothing leaves this browser. No model is used and nothing is charged."
            : "Nothing leaves this browser and nothing is saved. No model is used and nothing is charged."}
      </p>
    </>
  );
}
function Dest({ id, active, disabled, onPick, title, tag, text, off }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      className={"import-dest" + (active ? " on" : "")}
      onClick={onPick}
      data-dest={id}
    >
      <span className="import-radio" aria-hidden="true" />
      <span className="import-dest-text">
        <b>
          {title}
          {tag && <em className="import-tag good">{tag}</em>}
        </b>
        <small>{off || text}</small>
      </span>
    </button>
  );
}

function Row({ c, p }) {
  const why = p.problem(c);
  const on = p.selected.has(c.id) && !why;
  const flagged = p.dest === "account" && p.seedLive && c.seed;
  const allowed = flagged && p.allow.has(c.id);
  return (
    <li className={"import-row" + (on ? " on" : "") + (why === "known" || why === "big" ? " muted" : "")}>
      <label className="import-row-main">
        <input type="checkbox" checked={on} disabled={!!why} onChange={() => p.toggle(c.id)} aria-label={"Select " + c.title} data-i18n="off" />
        <span className="import-row-text">
          <b data-i18n="off">{c.title}</b>
          <small>
            <span>{day(c.updated)}</span>
            <span>{count(c.messages, "1 message", "{n} messages")}</span>
            {c.attachments > 0 && <span>{count(c.attachments, "1 attachment left out", "{n} attachments left out")}</span>}
          </small>
        </span>
      </label>
      <span className="import-row-tags">
        {why === "known" && <em className="import-tag">{p.dest === "vault" ? "Already in your vault" : "Already imported"}</em>}
        {why === "big" && <em className="import-tag warn">Too large for your account</em>}
        {flagged && !allowed && <em className="import-tag warn">Seed Guard</em>}
        {allowed && <em className="import-tag warn">Seed Guard: allowed</em>}
      </span>
      {flagged && !allowed && p.confirming !== c.id && (
        <button type="button" className="import-link" onClick={() => p.setConfirming(c.id)}>
          Import anyway…
        </button>
      )}
      {allowed && (
        <button
          type="button"
          className="import-link"
          onClick={() => {
            p.setAllow((prev) => {
              const next = new Set(prev);
              next.delete(c.id);
              return next;
            });
          }}
        >
          Keep it out
        </button>
      )}
      {flagged && !allowed && p.confirming === c.id && (
        <div className="seed-guard import-seed" role="alert">
          <span className="seed-guard-tile" aria-hidden="true">
            <Icon name="lock" size={16} />
          </span>
          <div className="seed-guard-body">
            <p className="seed-guard-eyebrow">SEED GUARD</p>
            <p className="seed-guard-message">This chat looks like it holds a wallet seed phrase or private key, so it isn't saved to your account.</p>
            <p className="seed-guard-note">Anyone with it controls that wallet. Import it only if it's a test phrase with no funds.</p>
            <div className="seed-guard-actions">
              <button
                type="button"
                className="seed-guard-button solid"
                onClick={() => {
                  p.setAllow((prev) => new Set(prev).add(c.id));
                  p.setConfirming(null);
                  p.toggle(c.id);
                }}
              >
                Yes, import it
              </button>
              <button type="button" className="seed-guard-button" onClick={() => p.setConfirming(null)}>
                Keep it out
              </button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

// ---- Working and done ----

function Working({ work, onStop }) {
  const pct = work?.total ? Math.round((work.done / work.total) * 100) : 0;
  const what =
    work?.dest === "account" ? "Saving to your account…" : work?.dest === "vault" ? "Sealing into Device Vault…" : "Writing Markdown files…";
  return (
    <div className="import-panel" role="status">
      <div className="import-progress-head">
        <h3>{what}</h3>
        <button type="button" className="import-secondary" onClick={onStop}>
          Stop
        </button>
      </div>
      <p className="import-phase">{`${(work?.done || 0).toLocaleString("en-US")} of ${(work?.total || 0).toLocaleString("en-US")} chats`}</p>
      <div className="import-bar" aria-hidden="true">
        <span style={{ width: pct + "%" }} />
      </div>
      <p className="import-fine">Stopping keeps what was already done. Nothing is undone.</p>
    </div>
  );
}

function Done({ result, source, overview, config, navigate, onMore }) {
  const { dest, saved, skipped, error, left } = result;
  const name = sourceName(source);
  const by = {};
  for (const s of skipped) by[s.reason] = (by[s.reason] || 0) + 1;
  const stopped = error === "stopped";
  const headline =
    dest === "markdown"
      ? saved.length === 1
        ? "1 chat downloaded as Markdown"
        : `${saved.length.toLocaleString("en-US")} chats downloaded as Markdown`
      : dest === "vault"
        ? saved.length === 1
          ? "1 chat kept in Device Vault"
          : `${saved.length.toLocaleString("en-US")} chats kept in Device Vault`
        : saved.length === 1
          ? "1 chat saved to your account"
          : `${saved.length.toLocaleString("en-US")} chats saved to your account`;
  const opened = saved.slice(0, 5);
  return (
    <div className="import-panel import-done" role="status">
      <div className="import-progress-head">
        <div>
          <p className="import-eyebrow">{saved.length ? "DONE" : "NOTHING IMPORTED"}</p>
          <h3>{saved.length ? headline : "No chats were imported"}</h3>
        </div>
      </div>
      {dest !== "markdown" && saved.length > 0 && (
        <p className="import-fine">{`Each one is marked as imported from ${name}. The replies were written by that service.`}</p>
      )}
      {Object.keys(by).length > 0 && (
        <ul className="import-skipped">
          {Object.entries(by).map(([reason, n]) => (
            <li key={reason}>{`${n.toLocaleString("en-US")} ${REASONS[reason] || "skipped"}`}</li>
          ))}
        </ul>
      )}
      {error && (
        <Notice type={stopped ? "" : "error"}>
          {stopped ? "Stopped." : error.message || "Something went wrong."}
          <br />
          {`${saved.length.toLocaleString("en-US")} done; ${left.length.toLocaleString("en-US")} not imported.`}
        </Notice>
      )}
      {dest !== "markdown" && opened.length > 0 && (
        <>
          <h4 className="import-open-head">Open one</h4>
          <ul className="import-open">
            {opened.map((s) => (
              <li key={s.conversation}>
                {dest === "account" ? (
                  <Link to={"/workspace/chat?c=" + encodeURIComponent(s.conversation)} data-i18n="off">
                    {s.title}
                  </Link>
                ) : (
                  <button type="button" className="import-link" data-i18n="off" onClick={() => navigate("/workspace/chat", { state: { vaultChat: s.conversation } })}>
                    {s.title}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="import-fine">
            {dest === "vault"
              ? "The rest are in the Device Vault section of the sidebar."
              : isReleased(config, "historylibrary")
                ? "Find the rest by searching your history in Your library."
                : "The most recent ones are in the sidebar."}
          </p>
        </>
      )}
      <div className="import-actions">
        {overview && (
          <button type="button" className="button" onClick={onMore}>
            <Icon name="plus" size={15} />
            Import more from this file
          </button>
        )}
        {dest === "account" && isReleased(config, "historylibrary") && (
          <Link className="import-secondary" to="/workspace/library">
            <Icon name="search" size={14} />
            Search your history
          </Link>
        )}
      </div>
    </div>
  );
}
