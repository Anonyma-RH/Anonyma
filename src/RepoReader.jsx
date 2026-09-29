import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { t } from "./i18n.js";
import { Icon, Modal, Notice } from "./ui.jsx";
import { api, isReleased, readStore, saveStore, streamChat, uid } from "./lib.js";
import { createVeilState, unveil, veil } from "./veil.js";
import { VeilToggle } from "./Veil.jsx";
import { PrivateModeToggle, NoPrivateModelsNotice, privateModeReleased } from "./PrivateMode.jsx";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import { isSoft } from "./seed-guard.js";
import { useShieldLive, shieldMarkdown } from "./Shield.jsx";
import { ReplyMarkdown } from "./RichMarkdown.jsx";
import { useCreditEstimate } from "./CreditEstimate.jsx";
import { formatCredits } from "./estimate.js";
import { pickPreset } from "./model-finder.js";
import { formatBytes } from "./documents.js";
import { REPO_READER, citationOf, findCitations, parseRepoUrl, plural, repoText } from "./repo-reader.js";
import "./repo-reader.css";

// Repo Reader: paste a public GitHub repo, browse its files, ask about it.
// ANONYMA's server downloads and unpacks the repo into a cache that lives 30
// minutes in its memory (/api/repos). "Find files" shows exactly which
// excerpts a question would send; "Ask" sends them, off the record, as one
// chat request held at exactly the maximum shown. Answers cite path:line,
// and each citation opens the file at that line. Answers live on this page
// only, until it's closed.

const MODEL_KEY = "repos:model";
const SAMPLE = "https://github.com/expressjs/cors";
const PREVIEW_LINES = 14;

function buildTree(files) {
  const root = { path: "", name: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) node.dirs.set(parts[i], (next = { path: parts.slice(0, i + 1).join("/"), name: parts[i], dirs: new Map(), files: [] }));
      node = next;
    }
    node.files.push({ ...f, name: parts.at(-1) });
  }
  return root;
}
const received = (r) => ({ ...r, receivedAt: Date.now() });

export default function RepoReader({ demo, user, models, config, refresh, veilOn, setVeilOn, veilWords }) {
  const live = !demo && !!user && isReleased(config, "reporeader");
  const [params, setParams] = useSearchParams();
  const [link, setLink] = useState(""),
    [reading, setReading] = useState(false),
    [readError, setReadError] = useState(""),
    [notice, setNotice] = useState(""),
    [repo, setRepo] = useState(null),
    [openRepos, setOpenRepos] = useState([]),
    [viewer, setViewer] = useState(null),
    [clock, setClock] = useState(() => Date.now());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [repo?.id]);

  const repoId = params.get("repo") || "";
  const setParam = useCallback(
    (changes) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(changes)) v ? next.set(k, v) : next.delete(k);
          return next;
        },
        { replace: false },
      ),
    [setParams],
  );
  const listOpen = useCallback(() => {
    if (!live) return;
    api("/api/repos")
      .then((r) => mounted.current && setOpenRepos(r.data || []))
      .catch(() => {});
  }, [live]);
  useEffect(listOpen, [listOpen]);
  // The repo in the URL: opened again on reload while it's still cached.
  useEffect(() => {
    if (!live || !repoId) return setRepo(null);
    if (repo?.id === repoId) return;
    let stop = false;
    api("/api/repos/" + encodeURIComponent(repoId))
      .then((r) => !stop && setRepo(received(r)))
      .catch((e) => {
        if (stop) return;
        setRepo(null);
        setNotice(e?.message || "That repo couldn't be opened.");
        setParam({ repo: null, file: null, line: null });
      });
    return () => {
      stop = true;
    };
  }, [live, repoId]);

  let linkProblem = "";
  if (link.trim())
    try {
      parseRepoUrl(link);
    } catch (e) {
      linkProblem = e.message;
    }
  async function read(e) {
    e?.preventDefault();
    if (!live || reading || !link.trim() || linkProblem) return;
    setReading(true);
    setReadError("");
    setNotice("");
    try {
      const r = await api("/api/repos", { method: "POST", body: { url: link.trim() } });
      if (!mounted.current) return;
      setRepo(received(r));
      setLink("");
      setParam({ repo: r.id, file: null, line: null });
      listOpen();
    } catch (err) {
      if (mounted.current) setReadError(err?.message || "Couldn't read that repo.");
    } finally {
      if (mounted.current) setReading(false);
    }
  }
  async function forget(id) {
    try {
      await api("/api/repos/" + encodeURIComponent(id), { method: "DELETE" });
    } catch {}
    if (repo?.id === id) {
      setRepo(null);
      setParam({ repo: null, file: null, line: null });
    }
    setNotice("Forgotten. Nothing of that repo is kept.");
    listOpen();
  }

  // ---- The file viewer (URL: file and line) ----
  const fileParam = params.get("file") || "";
  const lineParam = Number(params.get("line")) || 0;
  const endParam = Number(params.get("end")) || lineParam;
  const openFile = useCallback(
    (path, start = 0, end = start) => setParam({ file: path, line: start ? String(start) : null, end: end > start ? String(end) : null }),
    [setParam],
  );
  useEffect(() => {
    if (!repo || !fileParam) return setViewer(null);
    let stop = false;
    setViewer((v) => (v?.path === fileParam ? v : { path: fileParam, loading: true }));
    api(`/api/repos/${encodeURIComponent(repo.id)}/file?path=${encodeURIComponent(fileParam)}`)
      .then((f) => !stop && setViewer({ ...f, loading: false }))
      .catch((e) => !stop && setViewer({ path: fileParam, loading: false, error: e?.message || "That file couldn't be opened." }));
    return () => {
      stop = true;
    };
  }, [repo?.id, fileParam]);

  // Counted from what the server said was left, so a browser clock that's
  // off doesn't change it.
  const expiresIn = repo ? Math.ceil(Math.max(0, repo.forgotten_in - Math.max(0, clock - repo.receivedAt)) / 60000) : 0;
  return (
    <section className="repo-page">
      <div className={"repo-head" + (repo ? " compact" : "")}>
        <p className="eyebrow">CODE</p>
        <h1>Repo Reader</h1>
        {!repo && (
          <p>
            Paste a public GitHub repo and ask about it. Answers point to the exact files and lines, and you see which
            excerpts go to the AI before anything is sent.
          </p>
        )}
      </div>
      <form className={"repo-link" + (repo ? " compact" : "")} onSubmit={read}>
        <label htmlFor="repo-link-input">{repo ? "Read another repo" : "GitHub repo link"}</label>
        <div className="repo-link-row">
          <input
            id="repo-link-input"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={SAMPLE}
            value={link}
            maxLength={2048}
            disabled={!live || reading}
            data-i18n="off"
            onChange={(e) => setLink(e.target.value)}
          />
          <button type="submit" className="button" disabled={!live || reading || !link.trim() || !!linkProblem}>
            {reading ? "Reading…" : "Read repo"}
          </button>
        </div>
        {linkProblem && <small className="repo-link-problem">{linkProblem}</small>}
        {repo ? (
          <p className="repo-fine">Public repos only. Free. GitHub sees ANONYMA's server, not you.</p>
        ) : (
          <p className="repo-fine">
            {`Public repos only, no GitHub sign-in. ANONYMA's server downloads the code, so GitHub sees our server, not you. Reading is free (${REPO_READER.perHour} repos an hour), and the files stay in the server's memory for 30 minutes, then they're forgotten. Nothing is saved to your account.`}
            {!live && " Sign in to read a repo."}
          </p>
        )}
      </form>
      {reading && (
        <div className="repo-progress" role="status">
          <span className="repo-spinner" aria-hidden="true" />
          <span>
            <b>Downloading and unpacking the repo…</b>
            <small>Up to 50 MB. Vendored folders, binaries and files over 256 KB are skipped.</small>
          </span>
        </div>
      )}
      {readError && <Notice type="error">{readError}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {openRepos.some((r) => r.id !== repo?.id) && (
        <div className="repo-open" aria-label={t("Open repos")}>
          <span>Open now</span>
          {openRepos.map((r) => (
            <button
              key={r.id}
              type="button"
              className={"repo-chip" + (r.id === repo?.id ? " on" : "")}
              aria-pressed={r.id === repo?.id}
              onClick={() => setParam({ repo: r.id, file: null, line: null, end: null })}
            >
              <Icon name="repo" size={13} />
              <span data-i18n="off">{r.repo}</span>
              {r.ref && <small data-i18n="off">{r.ref}</small>}
            </button>
          ))}
        </div>
      )}
      {repo ? (
        <div className="repo-grid">
          <FilesPanel repo={repo} expiresIn={expiresIn} onOpen={openFile} onForget={() => forget(repo.id)} />
          <AskPanel
            key={repo.id}
            repo={repo}
            live={live}
            config={config}
            models={models}
            refresh={refresh}
            veilOn={veilOn}
            setVeilOn={setVeilOn}
            veilWords={veilWords}
            onOpen={openFile}
          />
        </div>
      ) : (
        <ol className="repo-steps">
          <li>
            <b>Read a repo</b>
            <span>Paste its GitHub link. The server fetches the public code; your browser never contacts GitHub.</span>
          </li>
          <li>
            <b>See what the AI sees</b>
            <span>Your question picks the most relevant excerpts. You see every one before anything is sent.</span>
          </li>
          <li>
            <b>Follow the citations</b>
            <span>Answers cite path:line. Click one to open the file at that line.</span>
          </li>
        </ol>
      )}
      {viewer && repo && (
        <Modal title={viewer.path} onClose={() => setParam({ file: null, line: null, end: null })}>
          <FileView view={viewer} start={lineParam} end={endParam} repo={repo} />
        </Modal>
      )}
    </section>
  );
}

function FilesPanel({ repo, expiresIn, onOpen, onForget }) {
  const [filter, setFilter] = useState("");
  const [opened, setOpened] = useState(() => new Set());
  const tree = useMemo(() => buildTree(repo.files), [repo.files]);
  const toggle = (path) =>
    setOpened((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  const q = filter.trim().toLowerCase();
  const matches = q ? repo.files.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 200) : null;
  const s = repo.skipped || {};
  const skippedTotal = Object.values(s).reduce((n, v) => n + (Number(v) || 0), 0);
  const renderDir = (node, depth) => (
    <ul className="repo-tree-list" role={depth ? "group" : "tree"}>
      {[...node.dirs.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => {
          const open = opened.has(d.path);
          return (
            <li key={d.path} role="treeitem" aria-expanded={open}>
              <button type="button" className="repo-tree-dir" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(d.path)}>
                <Icon name={open ? "down" : "right"} size={12} />
                <span data-i18n="off">{d.name}</span>
              </button>
              {open && renderDir(d, depth + 1)}
            </li>
          );
        })}
      {node.files
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => (
          <li key={f.path} role="treeitem">
            <button type="button" className="repo-tree-file" style={{ paddingLeft: 22 + depth * 14 }} onClick={() => onOpen(f.path)}>
              <span data-i18n="off">{f.name}</span>
              <small>{f.lines.toLocaleString("en-US")}</small>
            </button>
          </li>
        ))}
    </ul>
  );
  return (
    <aside className="repo-files">
      <div className="repo-card">
        <div className="repo-card-title">
          <Icon name="repo" size={18} />
          <a href={repo.url} target="_blank" rel="noopener noreferrer nofollow" data-i18n="off">
            {repo.repo}
          </a>
        </div>
        <div className="repo-tags">
          <span className="repo-tag" data-i18n="off">
            {repo.ref || "HEAD"}
          </span>
          {repo.commit && (
            <span className="repo-tag" data-i18n="off" title={repo.commit}>
              {repo.commit.slice(0, 7)}
            </span>
          )}
          <span className="repo-tag">{plural(repo.file_count, "file", "files")}</span>
          <span className="repo-tag">{formatBytes(repo.text_bytes)}</span>
        </div>
        <p className="repo-fine">
          {`In memory for ${expiresIn} more ${expiresIn === 1 ? "minute" : "minutes"}, then forgotten.`}{" "}
          <button type="button" className="repo-textbutton" onClick={onForget}>
            Forget now
          </button>
        </p>
        {skippedTotal > 0 && (
          <details className="repo-skipped">
            <summary>{`${plural(skippedTotal, "entry", "entries")} skipped`}</summary>
            <ul>
              {s.vendored > 0 && <li>{`${plural(s.vendored, "file", "files")} in vendored or build folders`}</li>}
              {s.generated > 0 && <li>{`${plural(s.generated, "lock or minified file", "lock or minified files")}`}</li>}
              {s.binary > 0 && <li>{`${plural(s.binary, "binary file", "binary files")}`}</li>}
              {s.large > 0 && <li>{`${plural(s.large, "file", "files")} over 256 KB`}</li>}
              {s.links > 0 && <li>{`${plural(s.links, "link", "links")}, never followed`}</li>}
              {s.unsafe > 0 && <li>{`${plural(s.unsafe, "unsafe path", "unsafe paths")}`}</li>}
              {s.other > 0 && <li>{`${plural(s.other, "special entry", "special entries")}`}</li>}
              {s.limit > 0 && <li>{`${plural(s.limit, "file", "files")} past the 5,000-file or 8 MB limit`}</li>}
            </ul>
            {repo.skipped_dirs?.length > 0 && (
              <p className="repo-fine" data-i18n="off">
                {repo.skipped_dirs.join(", ")}
              </p>
            )}
          </details>
        )}
        {repo.hidden_removed > 0 && (
          <p className="repo-fine">
            {`Injection Shield removed ${plural(repo.hidden_removed, "invisible character", "invisible characters")}.`}
          </p>
        )}
      </div>
      <label className="repo-filter">
        <Icon name="search" size={14} />
        <input
          type="search"
          value={filter}
          placeholder={t("Filter files")}
          aria-label={t("Filter files")}
          data-i18n="off"
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>
      <nav className="repo-tree" aria-label={t("Files")}>
        {matches ? (
          matches.length ? (
            <ul className="repo-tree-list">
              {matches.map((f) => (
                <li key={f.path}>
                  <button type="button" className="repo-tree-file" onClick={() => onOpen(f.path)}>
                    <span data-i18n="off">{f.path}</span>
                    <small>{f.lines.toLocaleString("en-US")}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="repo-fine repo-empty">No files match.</p>
          )
        ) : (
          renderDir(tree, 0)
        )}
      </nav>
    </aside>
  );
}

function FileView({ view, start, end, repo }) {
  const box = useRef(null);
  useEffect(() => {
    if (!start || view.loading) return;
    box.current?.querySelector(`[data-line="${start}"]`)?.scrollIntoView?.({ block: "center" });
  }, [view.loading, view.text, start]);
  if (view.loading) return <p className="repo-fine">Opening the file…</p>;
  if (view.error) return <Notice type="error">{view.error}</Notice>;
  const lines = view.text.split("\n");
  return (
    <div className="repo-viewer">
      <p className="repo-fine repo-meta">
        <span>{plural(view.lines, "line", "lines")}</span>
        <span>{formatBytes(view.bytes)}</span>
        {start > 0 && <span>{end > start ? `Lines ${start}–${end} highlighted` : `Line ${start} highlighted`}</span>}
        <a
          href={`https://github.com/${repo.repo}/blob/${repo.commit || repo.ref || "HEAD"}/${view.path
            .split("/")
            .map(encodeURIComponent)
            .join("/")}${start ? `#L${start}${end > start ? `-L${end}` : ""}` : ""}`}
          target="_blank"
          rel="noopener noreferrer nofollow"
        >
          Open on GitHub
        </a>
      </p>
      <div className="repo-code" ref={box} data-i18n="off">
        {lines.map((line, i) => {
          const n = i + 1;
          const hit = start && n >= start && n <= (end || start);
          return (
            <div key={n} data-line={n} className={hit ? "hit" : undefined}>
              <span className="repo-ln">{n}</span>
              <span className="repo-lc">{line || " "}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AskPanel({ repo, live, config, models, refresh, veilOn, setVeilOn, veilWords, onOpen }) {
  const [question, setQuestion] = useState(""),
    [model, setModel] = useState(() => readStore(MODEL_KEY, "")),
    [privateOn, setPrivateOn] = useState(false),
    [finding, setFinding] = useState(false),
    [found, setFound] = useState(null),
    [formError, setFormError] = useState(""),
    [gen, setGen] = useState(null),
    [answers, setAnswers] = useState([]),
    [seesOpen, setSeesOpen] = useState(true),
    [seedOk, setSeedOk] = useState(false);
  const controller = useRef(null),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const paths = useMemo(() => new Set(repo.files.map((f) => f.path)), [repo.files]);

  // ---- Models, Veil, Private Mode (as on the other tool pages) ----
  const veilLive = isReleased(config, "veil");
  const veiling = veilLive && live && (veilOn || privateOn);
  const privateLive = privateModeReleased(config);
  const trailLive = isReleased(config, "trail");
  const shieldOn = useShieldLive(config);
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
  useEffect(() => {
    if (model) saveStore(MODEL_KEY, model);
  }, [model]);
  const modelName = (id) => models.find((m) => m.id === id)?.name || id;

  const seedHit = useSeedScan(live && seedGuardLive(config), question);
  useEffect(() => setSeedOk(false), [question]);
  // A seed phrase is never sent (no override, as on the server); a key-like
  // string can be, once confirmed.
  const seedBlocked = !!seedHit && !(isSoft(seedHit) && seedOk);
  const busy = gen?.status === "writing";
  const noPrivate = privateOn && !choices.length;
  // A question edited after "Find files", or Veil switched since (Private
  // Mode turns it on), has to be found again.
  const stale = found && (found.typed !== question.trim() || found.veiled !== veiling);

  async function find(e) {
    e?.preventDefault();
    const typed = question.trim();
    if (!live || !typed || finding || busy || seedBlocked) return;
    setFormError("");
    setFinding(true);
    // Veil masks the question before it leaves this browser, for the search
    // and the model alike; a public repo's own text is sent as it is.
    const state = createVeilState();
    const masked = veiling ? veil(typed, state, veilWords) : { text: typed, count: 0 };
    try {
      const r = await api(`/api/repos/${encodeURIComponent(repo.id)}/excerpts`, { method: "POST", body: { question: masked.text } });
      if (mounted.current) {
        setFound({ ...r, typed, state, masked: masked.count, veiled: veiling });
        setSeesOpen(true);
      }
    } catch (err) {
      if (mounted.current) setFormError(err?.message || "Couldn't find files for that question.");
    } finally {
      if (mounted.current) setFinding(false);
    }
  }
  const payload = found && !stale ? found.repo : null;
  const quoteBody = useMemo(
    () => (live && model && payload && !busy ? { model, repo: payload, ...(privateOn ? { private: true } : {}) } : null),
    [live, model, payload, busy, privateOn],
  );
  const estimate = useCreditEstimate(quoteBody);
  const short = estimate.status === "ready" && estimate.available != null && estimate.credits > estimate.available;
  const limited = estimate.status === "ready" && !short && estimate.room != null && estimate.credits > estimate.room;

  async function ask() {
    if (!payload || busy || seedBlocked) return;
    if (!model) return setFormError(privateOn ? "No private models are available right now." : "No callable chat model is available.");
    setFormError("");
    const ctl = new AbortController();
    controller.current = ctl;
    const map = found.state.map;
    const started = { question: found.typed, model, modelName: modelName(model), private: privateOn };
    setGen({ status: "writing", ...started, text: "" });
    let text = "",
      receipt = null,
      failure = null;
    try {
      await streamChat(
        {
          repo: payload,
          model,
          ephemeral: true,
          requestId: uid(),
          ...(privateOn ? { private: true } : {}),
          ...(trailLive ? { veil_masked: veiling ? found.masked : null } : {}),
        },
        (event) => {
          const delta = event.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && text.length < 400000) {
            text += delta;
            if (mounted.current) setGen((g) => (g?.status === "writing" ? { ...g, text: unveil(text, map) } : g));
          }
          if (event.anonyma && Number.isFinite(event.anonyma.credits_charged)) receipt = event.anonyma;
          if (event.error) failure = event.error;
        },
        ctl.signal,
      );
      if (failure) throw Error(unveil(failure.message || "The model request failed.", map));
      const answer = {
        id: uid(),
        ...started,
        text: unveil(text, map),
        charged: receipt?.credits_charged,
        cut: receipt?.finish_reason === "length",
        excerpts: payload.snippets.length,
      };
      if (mounted.current) {
        setAnswers((prev) => [answer, ...prev].slice(0, 20));
        setGen(null);
        setSeesOpen(false);
      }
    } catch (err) {
      const stopped = err.name === "AbortError";
      if (mounted.current)
        setGen({
          status: stopped ? "stopped" : "failed",
          ...started,
          text: "",
          error: stopped ? "Stopped. Only what the model had already written is charged, if anything." : err.message,
        });
    } finally {
      if (controller.current === ctl) controller.current = null;
      refresh?.();
    }
  }

  const components = useMemo(() => {
    const base = shieldOn ? shieldMarkdown() : {};
    return {
      ...base,
      code: ({ node: _node, className, children, ...rest }) => {
        const text = String(Array.isArray(children) ? children.join("") : children ?? "");
        const cite = !className && !text.includes("\n") ? citationOf(text, paths) : null;
        if (!cite)
          return (
            <code className={className} {...rest}>
              {children}
            </code>
          );
        return (
          <button type="button" className="repo-cite" title={t("Open this file at that line")} onClick={() => onOpen(cite.path, cite.start, cite.end)}>
            {cite.label}
          </button>
        );
      },
    };
  }, [shieldOn, paths, onOpen]);

  const chars = payload ? payload.snippets.reduce((n, s) => n + s.text.length, 0) : 0;
  const files = payload ? new Set(payload.snippets.map((s) => s.path)).size : 0;
  return (
    <div className="repo-ask">
      <form className="repo-ask-form" onSubmit={find}>
        <h2>Ask about this repo</h2>
        <textarea
          rows={3}
          value={question}
          maxLength={REPO_READER.maxQuestion}
          disabled={!live || busy}
          placeholder={t("Where are requests rate limited? How is the config loaded?")}
          aria-label={t("Your question")}
          data-i18n="off"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) find(e);
          }}
        />
        <div className="repo-controls">
          <label className="repo-field repo-model">
            Model
            <select value={model} disabled={busy || !choices.length} onChange={(e) => setModel(e.target.value)}>
              {choices.map((m) => (
                <option key={m.id} value={m.id} data-i18n="off">
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          {live && privateLive && (
            <PrivateModeToggle
              active={privateOn}
              disabled={busy}
              onToggle={() => {
                setPrivateOn((on) => !on);
                if (!privateOn && veilLive) setVeilOn(true);
              }}
            />
          )}
          {live && veilLive && (
            <VeilToggle
              on={veilOn || privateOn}
              onToggle={() => {
                if (!busy && !privateOn) setVeilOn((v) => !v);
              }}
            />
          )}
        </div>
        {noPrivate && <NoPrivateModelsNotice />}
        <SeedGuardNotice hit={seedHit} busy={busy} hardOverride={false} onProceed={() => setSeedOk(true)} />
        {formError && <Notice type="error">{formError}</Notice>}
        <div className="repo-send">
          <button type="submit" className={payload ? "repo-secondary" : "button"} disabled={!live || !question.trim() || finding || busy || seedBlocked}>
            <Icon name="search" size={14} />
            {finding ? "Finding files…" : payload ? "Find again" : "Find files"}
          </button>
          <span className="repo-fine">Free. Nothing is sent to a model until you ask.</span>
        </div>
      </form>

      {payload && (
        <section className={"repo-sees" + (seesOpen ? "" : " closed")} aria-label={t("What the AI sees")}>
          <h3>
            <button type="button" className="repo-sees-toggle" aria-expanded={seesOpen} onClick={() => setSeesOpen((o) => !o)}>
              <Icon name={seesOpen ? "down" : "right"} size={14} />
              What the AI sees
            </button>
            <span className="repo-meta">
              <span>{plural(payload.snippets.length, "excerpt", "excerpts")}</span>
              <span>{plural(files, "file", "files")}</span>
              <span>{plural(chars, "character", "characters")}</span>
            </span>
          </h3>
          {seesOpen && (
            <>
          <p className="repo-fine">
            {`Your question, a list of ${plural(payload.list.length, "path", "paths")} and these excerpts, sent as data with fixed instructions to cite path:line. Nothing else: no other files, chats, memory or instructions.`}
            {found.masked ? ` Veil masked ${plural(found.masked, "detail", "details")} in your question.` : ""}
            {found.fallback ? " None of your words matched the code, so the README and manifest go instead." : ""}
          </p>
          <ol className="repo-excerpts">
            {payload.snippets.map((s, i) => (
              <li key={`${s.path}:${s.start}`}>
                <details>
                  <summary>
                    <button type="button" className="repo-cite" onClick={() => onOpen(s.path, s.start, s.end)}>
                      {`${s.path}:${s.start}-${s.end}`}
                    </button>
                    <small>{plural(s.text.length, "character", "characters")}</small>
                    {found.flagged?.[i] && (
                      <span className="repo-tag warn" title={t("Injection Shield: this excerpt has text that reads like instructions to an AI. It's sent as data, and the model is told not to follow it.")}>
                        Reads like instructions
                      </span>
                    )}
                  </summary>
                  <pre data-i18n="off">
                    {s.text
                      .split("\n")
                      .slice(0, PREVIEW_LINES)
                      .map((l, k) => `${s.start + k}| ${l}`)
                      .join("\n") + (s.end - s.start + 1 > PREVIEW_LINES ? "\n…" : "")}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
          <details className="repo-everything">
            <summary>Show everything that's sent</summary>
            <pre data-i18n="off">{repoText(payload)}</pre>
          </details>
          <div className="repo-send">
            {busy ? (
              <button type="button" className="repo-secondary" onClick={() => controller.current?.abort()}>
                <Icon name="stop" size={14} />
                Stop
              </button>
            ) : (
              <button type="button" className="button" disabled={!live || !model || noPrivate || seedBlocked || short} onClick={ask}>
                {`Ask ${modelName(model)}`}
              </button>
            )}
            {quoteBody && estimate.status === "ready" && (
              <span
                className={"credit-estimate " + (short ? "short" : limited ? "limited" : "ready")}
                role="status"
                title={t("The most this answer can cost, and exactly what's held while it's written: these excerpts and a full answer budget at the model's published rates. You're charged only for what's used, and nothing if the reply is empty.")}
              >
                <Icon name="coins" size={13} />
                {`Up to ${formatCredits(estimate.credits)} credits`}
                {short && <b> · over your balance</b>}
                {limited && <b> · over your spending limit</b>}
              </span>
            )}
            {quoteBody && estimate.status === "loading" && <span className="credit-estimate loading">Updating estimate…</span>}
            {quoteBody && estimate.status === "unavailable" && (
              <span className="credit-estimate unavailable" title={estimate.message}>
                Estimate unavailable
              </span>
            )}
          </div>
          <p className="repo-fine">
            {privateOn
              ? "Private Mode: zero-data-retention models only, Veil on, and nothing is saved."
              : "Asked off the record: billed like a message, and neither the question nor the answer is saved. The answer stays on this page until you leave it."}
          </p>
            </>
          )}
        </section>
      )}

      {gen && (
        <article className={"repo-answer" + (gen.status === "failed" ? " failed" : "")} aria-live="polite">
          <header>
            <b data-i18n="off">{gen.question}</b>
            <small>{gen.status === "writing" ? `${gen.modelName} is answering…` : gen.status === "failed" ? "No answer." : "Stopped."}</small>
          </header>
          {gen.text ? (
            <div className="repo-answer-text" data-i18n="off">
              <ReplyMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {gen.text}
              </ReplyMarkdown>
            </div>
          ) : gen.status === "writing" ? (
            <p className="repo-fine">
              <span className="repo-spinner" aria-hidden="true" /> Waiting for the first words…
            </p>
          ) : null}
          {gen.error && <Notice type="error">{gen.error}</Notice>}
        </article>
      )}
      {answers.map((a) => (
        <Answer key={a.id} answer={a} paths={paths} components={components} onOpen={onOpen} />
      ))}
      <p className="repo-fine">
        The AI can be wrong about code it only sees in part. Check the cited lines before you rely on an answer.
      </p>
    </div>
  );
}

function Answer({ answer, paths, components, onOpen }) {
  const [copied, setCopied] = useState(false);
  const cites = useMemo(() => findCitations(answer.text, paths), [answer.text, paths]);
  return (
    <article className="repo-answer">
      <header>
        <b data-i18n="off">{answer.question}</b>
        <small className="repo-meta">
          <span data-i18n="off">{answer.modelName}</span>
          {Number.isFinite(answer.charged) && <span>{`${formatCredits(answer.charged)} credits`}</span>}
          {answer.private && <span>Private Mode</span>}
        </small>
      </header>
      <div className="repo-answer-text" data-i18n="off">
        <ReplyMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {answer.text}
        </ReplyMarkdown>
      </div>
      {answer.cut && <Notice>The answer was cut short at its length limit.</Notice>}
      <footer>
        {cites.length > 0 ? (
          <div className="repo-cites">
            <span>{`Cited ${plural(cites.length, "place", "places")}`}</span>
            {cites.slice(0, 24).map((c) => (
              <button key={c.label} type="button" className="repo-cite" onClick={() => onOpen(c.path, c.start, c.end)}>
                {c.label}
              </button>
            ))}
          </div>
        ) : (
          <span className="repo-fine">No path:line citations in this answer.</span>
        )}
        <button
          type="button"
          className="repo-textbutton"
          onClick={() => {
            navigator.clipboard?.writeText(answer.text).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              },
              () => {},
            );
          }}
        >
          {copied ? "Copied" : "Copy answer"}
        </button>
      </footer>
    </article>
  );
}
