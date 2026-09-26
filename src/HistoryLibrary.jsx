import { ReplyMarkdown } from "./RichMarkdown.jsx";
import remarkGfm from "remark-gfm";
import React, { useEffect, useRef, useState } from "react";
import { api, isReleased, messageFromServer } from "./lib.js";
import { Icon, Notice } from "./ui.jsx";
import { ProjectPicker, ProjectSwatch } from "./Projects.jsx";
import BookmarksPanel from "./Bookmarks.jsx";
import "./history-library.css";

export default function HistoryLibrary({
  user,
  demo,
  config,
  media,
  onDelete,
  Grid,
  onOpen,
  // Chat Export, once released: exports a saved conversation ({ id, mode }).
  onExport = null,
  refreshMedia,
  // From the Command Palette: { tab: "history", query, key }. Opens the
  // search tab with the words typed there; searching stays a press of Search.
  // { tab: "bookmarks", key } opens Bookmarks (from the palette or a star).
  request = null,
  // Projects: the account's projects, to narrow a search to one (empty
  // until the update is released).
  projects = [],
  // Bookmarks (src/Bookmarks.jsx): its tab, once the update is live.
  bookmarks = false,
  models = [],
}) {
  const [tab, setTab] = useState("media"),
    [filter, setFilter] = useState("all"),
    [query, setQuery] = useState(""),
    [hits, setHits] = useState([]),
    [next, setNext] = useState(null),
    [searching, setSearching] = useState(false),
    [error, setError] = useState(""),
    [active, setActive] = useState(null),
    [details, setDetails] = useState(null),
    [quoted, setQuoted] = useState(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [savedPreview, setSavedPreview] = useState(null),
    [focusQuery, setFocusQuery] = useState(0),
    [inProject, setInProject] = useState(null);
  const searchCtl = useRef(null),
    detailCtl = useRef(null),
    generation = useRef(null),
    lock = useRef(false),
    mounted = useRef(true),
    epoch = useRef(0),
    queryBox = useRef(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      searchCtl.current?.abort();
      detailCtl.current?.abort();
      generation.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (request?.tab === "bookmarks" && bookmarks) return setTab("bookmarks");
    if (request?.tab !== "history") return;
    setTab("history");
    if (typeof request.query === "string") setQuery(request.query.slice(0, 160));
    setFocusQuery((n) => n + 1);
  }, [request?.key]);
  // Once the search tab has rendered its box.
  useEffect(() => {
    if (focusQuery && tab === "history") queryBox.current?.focus();
  }, [focusQuery, tab]);
  useEffect(() => {
    searchCtl.current?.abort();
    setHits([]);
    setNext(null);
    setSearching(false);
  }, [query, inProject]);
  // A project deleted since it was chosen stops narrowing the search.
  const projectFilter = projects.some((p) => p.id === inProject) ? inProject : null;
  const signedIn = !demo && user;
  async function search(offset = 0) {
    if (!signedIn) {
      setError("Sign in to search your saved conversations.");
      return;
    }
    searchCtl.current?.abort();
    const ctl = new AbortController();
    searchCtl.current = ctl;
    setSearching(true);
    setError("");
    try {
      const r = await api(
        `/api/history/search?q=${encodeURIComponent(query.trim())}&offset=${offset}&limit=20` +
          (projectFilter ? `&project=${encodeURIComponent(projectFilter)}` : ""),
        { signal: ctl.signal },
      );
      if (!ctl.signal.aborted && mounted.current) {
        setHits((prev) => (offset ? [...prev, ...r.data] : r.data));
        setNext(r.nextOffset);
      }
    } catch (e) {
      if (!ctl.signal.aborted && mounted.current) setError(e.message);
    } finally {
      if (!ctl.signal.aborted && mounted.current) setSearching(false);
    }
  }
  async function openSaved(item) {
    if (lock.current) return;
    const mode = item.mode || "chat";
    if (["chat", "code", "uncensored"].includes(mode)) {
      onOpen({ ...item, mode });
      return;
    }
    detailCtl.current?.abort();
    const ctl = new AbortController();
    detailCtl.current = ctl;
    setError("");
    setSavedPreview(null);
    try {
      const saved = await api(
        `/api/conversations/${encodeURIComponent(item.id)}`,
        { signal: ctl.signal },
      );
      if (mounted.current && !ctl.signal.aborted)
        setSavedPreview({
          ...saved,
          messages: saved.messages.map(messageFromServer),
        });
    } catch (e) {
      if (mounted.current && !ctl.signal.aborted) setError(e.message);
    }
  }
  async function inspect(item) {
    if (lock.current) return;
    const ticket = ++epoch.current;
    detailCtl.current?.abort();
    const ctl = new AbortController();
    detailCtl.current = ctl;
    setActive(item);
    setDetails(null);
    setQuoted(null);
    setError("");
    setNotice("");
    try {
      const r = await api(
        `/api/library/${encodeURIComponent(item.id)}/actions`,
        { signal: ctl.signal },
      );
      if (mounted.current && epoch.current === ticket && !ctl.signal.aborted)
        setDetails(r);
    } catch (e) {
      if (mounted.current && !ctl.signal.aborted) setError(e.message);
    }
  }
  async function quoteRerun() {
    if (lock.current || !active) return;
    setBusy(true);
    setQuoted(null);
    setError("");
    lock.current = true;
    const ticket = epoch.current;
    try {
      const r = await api(
        `/api/library/${encodeURIComponent(active.id)}/quote`,
        { method: "POST", body: {} },
      );
      if (mounted.current && ticket === epoch.current) setQuoted(r);
    } catch (e) {
      if (mounted.current) setError(e.message);
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function rerun() {
    if (lock.current || !quoted) return;
    if (quoted.quote.expires < Date.now()) {
      setQuoted(null);
      setError("This quote expired. Get a fresh quote.");
      return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    generation.current = new AbortController();
    const endpoint = {
      image: "/api/images",
      video: "/api/videos",
      audio: "/api/audio/speech",
    }[quoted.kind];
    try {
      await api(endpoint, {
        method: "POST",
        body: quoted.body,
        signal: generation.current.signal,
      });
      if (mounted.current) {
        setNotice(
          quoted.kind === "video"
            ? "Video submitted. Check Video Studio and your library for completion."
            : "New media saved. The original is unchanged.",
        );
        setQuoted(null);
        await refreshMedia();
      }
    } catch (e) {
      if (mounted.current) {
        setError(
          e.name === "AbortError"
            ? "Stopped waiting. Check your library and ledger before retrying."
            : e.message,
        );
        setQuoted(null);
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function close() {
    if (lock.current) return;
    epoch.current++;
    detailCtl.current?.abort();
    setActive(null);
    setDetails(null);
    setQuoted(null);
    setError("");
    setNotice("");
  }
  return (
    <div className="library-page history-library">
      <p className="eyebrow">YOURS TO COME BACK TO</p>
      <h1>History & library.</h1>
      <div className="filter-tabs">
        {["media", "history", ...(bookmarks ? ["bookmarks"] : [])].map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
          >
            {t === "media" ? "Saved media" : t === "history" ? "Search conversations" : "Bookmarks"}
          </button>
        ))}
      </div>
      {error && <Notice type="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {savedPreview && (
        <section
          className="library-review"
          aria-label="Saved conversation preview"
        >
          <div className="library-review-heading">
            <h2>{savedPreview.title || "Saved result"}</h2>
            {onExport && (
              <button
                className="small-button history-export"
                onClick={() => onExport({ id: savedPreview.id, mode: savedPreview.mode })}
              >
                <Icon name="download" size={13} />
                Export
              </button>
            )}
            <button onClick={() => setSavedPreview(null)}>
              Close saved result
            </button>
          </div>
          <p>
            Saved result · read only. Nothing is generated or charged when you
            open it.
          </p>
          {savedPreview.messages.map((m) => (
            <article className="history-saved-message" key={m.id}>
              <strong>
                {m.role === "user" ? "You" : m.model || "Assistant"}
              </strong>
              <ReplyMarkdown rich={m.role !== "user"} remarkPlugins={[remarkGfm]}>
                {m.content}
              </ReplyMarkdown>
              {m.reasoning && (
                <details>
                  <summary>Saved reasoning</summary>
                  <ReplyMarkdown rich={false} remarkPlugins={[remarkGfm]}>
                    {m.reasoning}
                  </ReplyMarkdown>
                </details>
              )}
              {(m.images || []).map((url, index) => (
                <img
                  key={index}
                  src={url}
                  alt="Saved conversation image"
                  className="history-saved-image"
                />
              ))}
            </article>
          ))}
        </section>
      )}
      {tab === "bookmarks" && bookmarks ? (
        <BookmarksPanel user={user} demo={demo} config={config} models={models} />
      ) : tab === "history" ? (
        <>
          <p>
            Search the titles and messages of saved chats you can access.
            Private, off-the-record and auto-deleting chats are excluded.
          </p>
          <form
            className="history-search"
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
          >
            <label htmlFor="history-query">Find a conversation</label>
            <div>
              <input
                ref={queryBox}
                id="history-query"
                value={query}
                maxLength={160}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="A phrase you remember…"
              />
              <button
                className="button"
                disabled={searching || query.trim().length < 2}
              >
                Search saved chats
              </button>
            </div>
            {projects.length > 0 && (
              <ProjectPicker
                className="inline history-project"
                label="In project"
                none="Any project"
                projects={projects}
                value={projectFilter}
                onChange={setInProject}
              />
            )}
          </form>
          <div className="history-results" aria-live="polite">
            {hits.map((h) => {
              const hit = (
                <button
                  key={h.id}
                  className="history-hit"
                  onClick={() => openSaved(h)}
                >
                  <strong data-i18n={h.title ? "off" : undefined}>{h.title || "Untitled"}</strong>
                  <span>
                    {h.collab_id ? "Shared workspace" : "Personal chat"} ·{" "}
                    {new Date(h.updated).toLocaleDateString()}
                    {projects.some((p) => p.id === h.project_id) && (
                      <b className="history-hit-project">
                        <ProjectSwatch color={projects.find((p) => p.id === h.project_id).color} />
                        <i data-i18n="off">{projects.find((p) => p.id === h.project_id).name}</i>
                      </b>
                    )}
                  </span>
                  <p data-i18n={h.snippet ? "off" : undefined}>{h.snippet || "Title match"}</p>
                </button>
              );
              return onExport ? (
                <div className="history-hit-row" key={h.id}>
                  {hit}
                  <button
                    className="small-button history-export"
                    aria-label="Export this conversation"
                    onClick={() => onExport({ id: h.id, mode: h.mode })}
                  >
                    <Icon name="download" size={13} />
                    Export
                  </button>
                </div>
              ) : (
                hit
              );
            })}
            {!searching && !hits.length && query.trim().length >= 2 && (
              <p>
                No results shown. Search a phrase to find saved conversations.
              </p>
            )}
          </div>
          {next !== null && (
            <button
              className="button"
              disabled={searching}
              onClick={() => search(next)}
            >
              Load more conversations
            </button>
          )}
        </>
      ) : (
        <>
          <p>
            Inspect the original settings, open an accessible source chat, or
            review a fresh quote before generating again.
          </p>
          <div className="filter-tabs">
            {["all", "image", "video", "audio"].map((f) => (
              <button
                key={f}
                aria-pressed={f === filter}
                className={f === filter ? "active" : ""}
                onClick={() => setFilter(f)}
              >
                {f === "all"
                  ? "Everything"
                  : f === "image"
                    ? "Images"
                    : f === "video"
                      ? "Video"
                      : "Audio"}
              </button>
            ))}
          </div>
          {active && (
            <section className="library-review" aria-label="Review saved media">
              <div className="library-review-heading">
                <h2>Review saved {active.kind}</h2>
                <button onClick={close} disabled={busy}>
                  Close
                </button>
              </div>
              {!details ? (
                <p>Loading original settings…</p>
              ) : (
                <>
                  {details.source.status === "available" ? (
                    <button
                      className="small-button"
                      onClick={() => openSaved(details.source)}
                    >
                      Open source chat: {details.source.title || "Untitled"}
                    </button>
                  ) : (
                    <p>{details.source.message}</p>
                  )}
                  {details.rerun.available ? (
                    <>
                      <dl>
                        <dt>Model</dt>
                        <dd>{details.rerun.params.model}</dd>
                        <dt>{active.kind === "audio" ? "Script" : "Prompt"}</dt>
                        <dd className="library-saved-prompt">
                          {details.rerun.params.prompt ||
                            details.rerun.params.text}
                        </dd>
                        {Object.entries(details.rerun.params)
                          .filter(
                            ([k]) =>
                              ![
                                "model",
                                "text",
                                "prompt",
                                "images",
                                "image_url",
                              ].includes(k),
                          )
                          .map(([k, v]) => (
                            <React.Fragment key={k}>
                              <dt>
                                {{
                                  n: "Images per request",
                                  ratio: "Aspect ratio",
                                  quality: "Quality",
                                  resolution: "Resolution",
                                  size: "Size",
                                  output_format: "Output format",
                                  duration: "Duration (seconds)",
                                  voice: "Voice",
                                  language: "Language",
                                }[k] || k.replaceAll("_", " ")}
                              </dt>
                              <dd>{String(v)}</dd>
                            </React.Fragment>
                          ))}
                        <dt>Reference assets</dt>
                        <dd>
                          {details.rerun.referenceCount || 0} saved reference
                          {details.rerun.referenceCount === 1 ? "" : "s"}
                          {details.rerun.params.image_url
                            ? " · External HTTPS image; availability may have changed."
                            : ""}
                        </dd>
                      </dl>
                      <p>
                        Generating again uses credits. Results may differ.
                        Nothing runs when you open this panel.
                      </p>
                      {isReleased(
                        config,
                        { image: "images", video: "video", audio: "audio" }[
                          active.kind
                        ],
                      ) ? (
                        <>
                          <button
                            className="button"
                            disabled={busy}
                            onClick={quoteRerun}
                          >
                            {quoted ? "Refresh quote" : "Get fresh quote"}
                          </button>
                          {quoted && (
                            <div className="library-quote">
                              <strong>
                                Estimated {quoted.credits.toLocaleString()}{" "}
                                credits
                              </strong>
                              <p>
                                Current model and settings checked. Quote
                                expires in two minutes; actual usage may differ.
                              </p>
                              <button
                                className="button"
                                disabled={busy}
                                onClick={rerun}
                              >
                                Generate again using credits
                              </button>
                            </div>
                          )}
                        </>
                      ) : (
                        <Notice>This generation studio is not released.</Notice>
                      )}
                    </>
                  ) : (
                    <p>{details.rerun.message}</p>
                  )}
                </>
              )}
            </section>
          )}
          <Grid
            media={media.filter((m) => filter === "all" || m.kind === filter)}
            onDelete={onDelete}
            onActions={signedIn ? inspect : null}
          />
          {!media.length && (
            <p>Your completed images, videos and audio will appear here.</p>
          )}
        </>
      )}
    </div>
  );
}
