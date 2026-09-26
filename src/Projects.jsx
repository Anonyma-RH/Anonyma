import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, isReleased, readStore, saveStore } from "./lib.js";
import { Button, Empty, Icon, Notice } from "./ui.jsx";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import {
  MAX_PROJECTS,
  MAX_PINNED,
  MAX_PROJECT_NAME,
  MAX_PROJECT_INSTRUCTIONS,
  PROJECT_COLORS,
  PRIVACY_LABELS,
  PRIVACY_HELP,
  DEFAULT_COLOR,
  colorHex,
  privacyChoices,
  storedPrivacy,
  effectivePrivacy,
  withDeviceChoice,
  projectProblems,
  projectsReleased,
} from "./projects.js";
import "./projects.css";

// Projects: folders that keep related chats, files and instructions
// together (src/projects.js for the rules, server/routes/projects.js for
// storage). This file holds the account's project list (useProjects), the
// sidebar section, the composer's project line, the picker used by chat
// details, Symposium and History, and the Projects page itself.

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const day = (t) => new Date(t).toLocaleDateString();

// The signed-in account's projects, loaded once the update is live, and
// which of them start Device only in this browser: the server stores those
// as off the record and never learns that a Device Vault exists.
const deviceKey = (account) => "projects:device:" + (account || "guest");
export function useProjects(enabled, account) {
  const [state, setState] = useState({ list: [], loaded: false, max: MAX_PROJECTS });
  const [deviceIds, setDeviceIds] = useState(() => readStore(deviceKey(account), []));
  useEffect(() => {
    setDeviceIds(readStore(deviceKey(account), []));
  }, [account]);
  const setDevice = useCallback(
    (projectId, choice) =>
      setDeviceIds((ids) => {
        const next = withDeviceChoice(ids, projectId, choice);
        saveStore(deviceKey(account), next);
        return next;
      }),
    [account],
  );
  const reload = useCallback(async () => {
    if (!enabled) {
      setState({ list: [], loaded: false, max: MAX_PROJECTS });
      return;
    }
    try {
      const r = await api("/api/projects");
      setState({ list: r.projects || [], loaded: true, max: r.max_projects || MAX_PROJECTS });
    } catch {
      // Quiet: the workspace works the same without its projects.
      setState((s) => ({ ...s, loaded: true }));
    }
  }, [enabled, account]);
  useEffect(() => {
    reload();
  }, [reload]);
  return useMemo(
    () => ({
      ...state,
      reload,
      byId: (id) => (id ? state.list.find((p) => p.id === id) || null : null),
      deviceIds,
      setDevice,
      // How a new chat in `p` starts here (Device only needs the vault).
      privacyOf: (p, vault) => effectivePrivacy(p, deviceIds, vault),
    }),
    [state, reload, deviceIds, setDevice],
  );
}

// A project's colour square. `title` is the project's name, so it's never
// translated.
export function ProjectSwatch({ color, size = 10, title, className = "" }) {
  return (
    <span
      className={"project-swatch " + className}
      style={{ "--project": colorHex(color), width: size, height: size }}
      title={title}
      data-i18n={title ? "off" : undefined}
      aria-hidden="true"
    />
  );
}

// The cobalt sidebar's PROJECTS section: each project opens its page.
export function ProjectsSidebar({ projects, currentId, onNew, shown = 6 }) {
  const list = projects.slice(0, shown);
  return (
    <section className="projects-sidebar" aria-label="Projects">
      <div className="sidebar-group-label projects-label">
        <span>PROJECTS</span>
        <button type="button" className="projects-add" onClick={onNew} title="New project">
          <Icon name="plus" size={12} />
          New
        </button>
      </div>
      {list.length > 0 && (
        <div className="conversation-list projects-list">
          {list.map((p) => (
            <div key={p.id} className={p.id === currentId ? "current" : ""}>
              <Link to={"/workspace/projects?p=" + encodeURIComponent(p.id)}>
                <ProjectSwatch color={p.color} />
                <span data-i18n="off">{p.name}</span>
              </Link>
            </div>
          ))}
        </div>
      )}
      <Link className="projects-all" to="/workspace/projects">
        {projects.length > shown ? `All ${projects.length} projects` : list.length ? "All projects" : "Group related chats in a project"}
        <Icon name="arrow" size={12} />
      </Link>
    </section>
  );
}

// A select of the account's projects (chat details, Symposium, History).
// Names are the account's own words, so they stay untranslated.
export function ProjectPicker({ projects, value, onChange, label = "Project", none = "No project", disabled = false, className = "" }) {
  return (
    <label className={"project-picker " + className}>
      <span>{label}</span>
      <select value={value || ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{none}</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id} data-i18n="off">
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// The composer's project line: which project this chat is in, what goes
// with it, and a way out before the first message.
export function ProjectBar({ project, saved, fresh, instructionsOn, attached, pinsBlocked, note = "", onLeave }) {
  return (
    <div className="project-bar" style={{ "--project": colorHex(project.color) }}>
      <ProjectSwatch color={project.color} size={12} />
      <span className="project-bar-text">
        <span>{saved ? "In project" : "New chat in"}</span>{" "}
        <Link to={"/workspace/projects?p=" + encodeURIComponent(project.id)} data-i18n="off">
          {project.name}
        </Link>
        {instructionsOn && <span className="project-bar-fact">Instructions on</span>}
        {attached > 0 && (
          <span className="project-bar-fact">{count(attached, "pinned file attached", "pinned files attached")}</span>
        )}
        {note && <span className="project-bar-fact">{note}</span>}
      </span>
      {fresh && (
        <button type="button" className="project-bar-leave" onClick={onLeave}>
          Leave project
        </button>
      )}
      {fresh && pinsBlocked && project.files?.length > 0 && (
        <p className="project-bar-note">
          Pinned files aren't attached in Private Mode, off the record or with Veil on, like Saved files.
        </p>
      )}
    </div>
  );
}

function ColorChoice({ value, onChange }) {
  return (
    <div className="project-colors" role="radiogroup" aria-label="Color">
      {PROJECT_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          role="radio"
          aria-checked={value === c.id}
          aria-label={c.label}
          title={c.label}
          className={value === c.id ? "active" : ""}
          style={{ "--project": c.hex }}
          onClick={() => onChange(c.id)}
        />
      ))}
    </div>
  );
}

export function Editor({ draft, setDraft, config, models, vaultLive, busy, error, onSave, onCancel, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  const [files, setFiles] = useState(null);
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));
  const filesLive = isReleased(config, "files") && isReleased(config, "documents");
  const choices = privacyChoices(config, { vault: vaultLive });
  // An existing default that isn't offered here any more stays listed.
  const privacyList = choices.includes(draft.privacy) ? choices : [...choices, draft.privacy];
  const seedHit = useSeedScan(seedGuardLive(config), draft.instructions);
  const problems = projectProblems(draft);
  const chatModels = models.filter(
    (m) => m.type === "chat" && m.callable && !(m.architecture?.output_modalities || []).includes("image"),
  );
  useEffect(() => {
    if (!filesLive) return;
    let live = true;
    api("/api/files?limit=50")
      .then((r) => live && setFiles(r.data.filter((f) => f.anonyma?.kind === "document")))
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [filesLive]);
  const togglePin = (id) =>
    setDraft((d) => ({
      ...d,
      files: d.files.includes(id)
        ? d.files.filter((x) => x !== id)
        : d.files.length >= MAX_PINNED
          ? d.files
          : [...d.files, id],
    }));
  // Pins whose upload isn't in the first page of saved files still count.
  const pinnedElsewhere = (draft.pinned || []).filter((f) => !files?.some((x) => x.id === f.id));
  return (
    <form
      className="project-editor"
      onSubmit={(e) => {
        e.preventDefault();
        // Seed Guard holds Save until the find is removed (a seed phrase)
        // or confirmed with "Save anyway" (a key or 64-hex).
        if (!seedHit) onSave();
      }}
    >
      <div className="project-editor-head">
        <h2>{draft.id ? "Edit project" : "New project"}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={onCancel}>
          <Icon name="close" size={17} />
        </button>
      </div>
      <div className="project-editor-grid">
        <div className="project-editor-col">
          <label className="project-field">
            <span>Name</span>
            <input
              value={draft.name}
              maxLength={MAX_PROJECT_NAME}
              placeholder="Launch plan"
              data-i18n="off"
              onChange={(e) => set("name")(e.target.value)}
              required
              autoFocus
            />
          </label>
          <div className="project-field">
            <span>Color</span>
            <ColorChoice value={draft.color} onChange={set("color")} />
          </div>
          <label className="project-field">
            <span>Instructions</span>
            <textarea
              rows={6}
              value={draft.instructions}
              maxLength={MAX_PROJECT_INSTRUCTIONS}
              placeholder="Standing context for every chat in this project."
              data-i18n="off"
              onChange={(e) => set("instructions")(e.target.value)}
            />
            <small className="project-count">{`${draft.instructions.length}/${MAX_PROJECT_INSTRUCTIONS}`}</small>
          </label>
          <p className="project-note">
            <Icon name="eyeoff" size={15} />
            <span>
              Sent with every chat in this project, after your standing
              instructions. With Veil on, they're masked in your browser before sending.
            </span>
          </p>
          <SeedGuardNotice
            hit={seedHit}
            verb="save"
            busy={busy}
            hardOverride={seedHit?.kind !== "seed"}
            onProceed={() => onSave()}
          />
        </div>
        <div className="project-editor-col">
          <fieldset className="project-field">
            <legend>New chats start</legend>
            <div className="project-privacy">
              {privacyList.map((p) => (
                <label key={p} className={draft.privacy === p ? "active" : ""}>
                  <input
                    type="radio"
                    name="project-privacy"
                    value={p}
                    checked={draft.privacy === p}
                    onChange={() => set("privacy")(p)}
                  />
                  <b>{PRIVACY_LABELS[p]}</b>
                  <small>{PRIVACY_HELP[p]}</small>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="project-field">
            <span>Default model</span>
            <select value={draft.model || ""} onChange={(e) => set("model")(e.target.value || null)}>
              <option value="">No default</option>
              {draft.model && !chatModels.some((m) => m.id === draft.model) && (
                <option value={draft.model} data-i18n="off">
                  {draft.model}
                </option>
              )}
              {chatModels.map((m) => (
                <option key={m.id} value={m.id} data-i18n="off">
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          {filesLive && (
            <fieldset className="project-field">
              <legend>{`Pinned files (${draft.files.length}/${MAX_PINNED})`}</legend>
              {files === null ? (
                <p className="project-help">Loading…</p>
              ) : files.length === 0 && !pinnedElsewhere.length ? (
                <p className="project-help">
                  No saved text files yet. Save one with Saved files in the composer, then pin it here.
                </p>
              ) : (
                <div className="project-pins">
                  {[...pinnedElsewhere.map((f) => ({ id: f.id, filename: f.name, expires_at: f.expires / 1000 })), ...files].map((f) => (
                    <label key={f.id}>
                      <input
                        type="checkbox"
                        checked={draft.files.includes(f.id)}
                        disabled={!draft.files.includes(f.id) && draft.files.length >= MAX_PINNED}
                        onChange={() => togglePin(f.id)}
                      />
                      <span data-i18n="off">{f.filename}</span>
                      <small>{`Expires ${day(f.expires_at * 1000)}`}</small>
                    </label>
                  ))}
                </div>
              )}
              <p className="project-help">
                Their text is attached to each new chat in this project. A pin
                goes when its saved file expires or is deleted.
              </p>
            </fieldset>
          )}
        </div>
      </div>
      {error && <Notice type="error">{error}</Notice>}
      {confirming ? (
        <div className="project-confirm" role="group" aria-label="Delete project">
          <span>Delete this project? Its chats stay saved, in no project.</span>
          <button type="button" className="small-button danger" onClick={onDelete} disabled={busy}>
            Delete project
          </button>
          <button type="button" className="small-button" onClick={() => setConfirming(false)} disabled={busy}>
            Keep it
          </button>
        </div>
      ) : (
        <div className="project-editor-actions">
          <Button type="submit" disabled={busy || !!problems.name || !!problems.instructions || !!seedHit}>
            {draft.id ? "Save project" : "Create project"}
          </Button>
          <button type="button" className="small-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {draft.id && (
            <button type="button" className="project-delete" onClick={() => setConfirming(true)} disabled={busy}>
              <Icon name="delete" size={14} />
              Delete project
            </button>
          )}
        </div>
      )}
    </form>
  );
}

const blank = () => ({
  name: "",
  color: DEFAULT_COLOR,
  instructions: "",
  privacy: "normal",
  model: null,
  files: [],
  pinned: [],
});
const draftOf = (p, privacy) => ({
  id: p.id,
  name: p.name,
  color: p.color,
  instructions: p.instructions,
  privacy,
  model: p.model,
  files: p.files.map((f) => f.id),
  pinned: p.files,
  original: p,
});

function Tags({ project, models, privacy }) {
  const model = project.model && (models.find((m) => m.id === project.model)?.name || project.model);
  return (
    <div className="project-tags">
      <span className="project-tag">{PRIVACY_LABELS[privacy] || PRIVACY_LABELS.normal}</span>
      {model && (
        <span className="project-tag" data-i18n="off">
          {model}
        </span>
      )}
      {project.instructions.trim() && <span className="project-tag">Instructions</span>}
      {project.files.length > 0 && (
        <span className="project-tag">{count(project.files.length, "pinned file", "pinned files")}</span>
      )}
    </div>
  );
}

function ChatRow({ c, onOpen, onMove, busy, run = false }) {
  return (
    <li className="project-chat">
      {run ? (
        <span className="project-chat-title" data-i18n="off">
          {c.title || "Untitled"}
        </span>
      ) : (
        <button type="button" className="project-chat-title" data-i18n="off" onClick={onOpen}>
          {c.title || "Untitled"}
        </button>
      )}
      <span className="project-chat-meta">
        <span>{run ? "Symposium run" : c.mode === "code" ? "Code & build" : c.mode === "uncensored" ? "Uncensored" : "Chat"}</span>
        {" · "}
        <span>{day(c.updated)}</span>
      </span>
      {onMove && (
        <button type="button" className="small-button" disabled={busy} onClick={onMove}>
          Move out
        </button>
      )}
    </li>
  );
}

// One project's own page: its settings, instructions, pinned files, saved
// chats, Symposium runs and, in this browser, its Device only chats.
export function ProjectView({
  p,
  privacy,
  models,
  config,
  busy,
  vault,
  vaultLive,
  editor = null,
  onNewChat,
  onEdit,
  onOpenChat,
  onMoveOut,
  onOpenVaultChat,
  onUnlockVault,
}) {
  const vaultChats = vaultLive && vault?.unlocked ? vault.chats.filter((c) => c.project === p.id) : [];
  return (
    <>
      <div className="project-hero" style={{ "--project": colorHex(p.color) }}>
        <span className="project-hero-mark" aria-hidden="true" />
        <div className="project-hero-text">
          <p className="eyebrow">PROJECT</p>
          <h1 data-i18n="off">{p.name}</h1>
          <Tags project={p} models={models} privacy={privacy} />
        </div>
        <div className="project-hero-actions">
          <Button type="button" onClick={() => onNewChat(p)}>
            New chat in project <Icon name="plus" size={16} />
          </Button>
          <button type="button" className="small-button" onClick={onEdit} disabled={busy}>
            <Icon name="settings" size={14} />
            Edit project
          </button>
        </div>
      </div>
      {editor}
      {privacy !== "normal" && (
        <p className="project-note">
          <Icon name="shield" size={15} />
          <span>
            {privacy === "device"
              ? "New chats here start Device only: they're kept encrypted in this browser and listed below while Device Vault is unlocked, never on our servers."
              : privacy === "private"
                ? "New chats here start in Private Mode: zero-data-retention models only, never saved, so never listed here."
                : "New chats here start off the record: never saved, so never listed here."}
          </span>
        </p>
      )}
      <div className="project-columns">
        <section className="project-panel">
          <h2>Instructions</h2>
          {p.instructions.trim() ? (
            <p className="project-instructions" data-i18n="off">
              {p.instructions}
            </p>
          ) : (
            <p className="project-help">No instructions yet. Add some to send them with every chat in this project.</p>
          )}
        </section>
        <section className="project-panel">
          <h2>Pinned files</h2>
          {p.files.length ? (
            <ul className="project-files">
              {p.files.map((f) => (
                <li key={f.id}>
                  <Icon name="file" size={14} />
                  <span data-i18n="off">{f.name}</span>
                  <small>{`Expires ${day(f.expires)}`}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="project-help">
              {isReleased(config, "files")
                ? "No pinned files. Pin saved text files to attach them to each new chat."
                : "Pinned files arrive with Files & Reusable Uploads."}
            </p>
          )}
          {p.files.length > 0 && (
            <p className="project-help">
              Attached to each new chat here, except in Private Mode, off the record or with Veil on, like Saved files.
            </p>
          )}
        </section>
      </div>
      <section className="project-panel">
        <h2>
          Chats <span className="project-count">{p.chats.length}</span>
        </h2>
        {p.chats.length ? (
          <ul className="project-chats">
            {p.chats.map((c) => (
              <ChatRow
                key={c.id}
                c={c}
                busy={busy}
                onOpen={() => onOpenChat({ id: c.id, mode: c.mode || "chat", title: c.title })}
                onMove={() => onMoveOut(c)}
              />
            ))}
          </ul>
        ) : (
          <p className="project-help">
            No saved chats yet. Start one here, or move a chat in from its details (··· in the chat list).
          </p>
        )}
      </section>
      {p.runs.length > 0 && (
        <section className="project-panel">
          <h2>
            Symposium runs <span className="project-count">{p.runs.length}</span>
          </h2>
          <ul className="project-chats">
            {p.runs.map((c) => (
              <ChatRow key={c.id} c={c} run busy={busy} onMove={() => onMoveOut(c)} />
            ))}
          </ul>
        </section>
      )}
      {vaultLive && (
        <section className="project-panel">
          <h2>
            Device only chats{" "}
            {vault?.unlocked && <span className="project-count">{vaultChats.length}</span>}
          </h2>
          {!vault?.unlocked ? (
            <div className="project-vault-locked">
              <p className="project-help">
                {vault?.status === "none"
                  ? "Device only chats in this project are kept in this browser's Device Vault, which isn't set up yet."
                  : "Unlock Device Vault to see this project's device-only chats. They're kept only in this browser."}
              </p>
              {vault?.status === "locked" && (
                <button type="button" className="small-button" onClick={onUnlockVault}>
                  <Icon name="unlock" size={14} />
                  Unlock
                </button>
              )}
            </div>
          ) : vaultChats.length ? (
            <ul className="project-chats">
              {vaultChats.map((c) => (
                <li className="project-chat" key={c.id}>
                  <button type="button" className="project-chat-title" data-i18n="off" onClick={() => onOpenVaultChat(c)}>
                    {c.title}
                  </button>
                  <span className="project-chat-meta">
                    <span>Device only</span>
                    {" · "}
                    <span>{day(c.updated)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="project-help">
              None yet. Device only chats started in this project are grouped here, in this browser only.
            </p>
          )}
        </section>
      )}
    </>
  );
}

export default function Projects({
  demo,
  user,
  config,
  models,
  projects,
  vault,
  vaultLive,
  onOpenChat,
  onOpenVaultChat,
  onNewChat,
  onUnlockVault,
}) {
  const [params, setParams] = useSearchParams();
  const selected = params.get("p");
  const [draft, setDraft] = useState(null),
    [detail, setDetail] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [formError, setFormError] = useState("");
  const live = !demo && !!user && projectsReleased(config);
  const loadDetail = useCallback(async () => {
    if (!live || !selected) return setDetail(null);
    try {
      setDetail(await api("/api/projects/" + encodeURIComponent(selected)));
      setError("");
    } catch (e) {
      setDetail(null);
      setError(e.status === 404 ? "That project wasn't found." : e.message);
    }
  }, [live, selected]);
  useEffect(() => {
    loadDetail();
    setDraft(null);
  }, [loadDetail]);
  // The ?new=1 link from the sidebar opens the editor.
  useEffect(() => {
    if (params.get("new") !== "1") return;
    setDraft(blank());
    const next = new URLSearchParams(params);
    next.delete("new");
    setParams(next, { replace: true });
  }, [params]);
  async function save() {
    const problems = projectProblems(draft);
    if (problems.name || problems.instructions) return setFormError(problems.name || problems.instructions);
    setBusy(true);
    setFormError("");
    const was = draft.original;
    const filesLive = isReleased(config, "files") && isReleased(config, "documents");
    const stored = storedPrivacy(draft.privacy);
    const body = {
      name: draft.name.trim(),
      color: draft.color,
      instructions: draft.instructions,
      model: draft.model || null,
      // Only what changed needs its update: an existing default that isn't
      // live any more is left as it is.
      ...(!was || was.privacy !== stored ? { privacy: stored } : {}),
      ...(filesLive &&
      (!was || JSON.stringify(was.files.map((f) => f.id)) !== JSON.stringify(draft.files))
        ? { files: draft.files }
        : {}),
    };
    try {
      const saved = was
        ? await api("/api/projects/" + encodeURIComponent(was.id), { method: "PATCH", body })
        : await api("/api/projects", { method: "POST", body });
      // Device only is remembered in this browser, never on the server.
      projects.setDevice(saved.id, draft.privacy);
      setDraft(null);
      await projects.reload();
      if (was) setDetail(saved);
      else setParams({ p: saved.id });
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    const was = draft?.original;
    if (!was) return;
    setBusy(true);
    try {
      await api("/api/projects/" + encodeURIComponent(was.id), { method: "DELETE" });
      projects.setDevice(was.id, null);
      setDraft(null);
      await projects.reload();
      setParams({});
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function moveOut(c) {
    setBusy(true);
    try {
      await api(`/api/projects/${encodeURIComponent(detail.id)}/chats/${encodeURIComponent(c.id)}`, {
        method: "DELETE",
      });
      await Promise.all([loadDetail(), projects.reload()]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (demo || !user)
    return (
      <div className="library-page">
        <Empty icon="folder" title="Keep related chats, files and instructions together.">
          {demo
            ? "Projects group your saved chats with shared instructions and pinned files. Sign in to create one; they aren't part of the demo."
            : "Sign in to create projects."}
        </Empty>
      </div>
    );
  const editor = draft && (
    <Editor
      draft={draft}
      setDraft={setDraft}
      config={config}
      models={models}
      vaultLive={vaultLive}
      busy={busy}
      error={formError}
      onSave={save}
      onCancel={() => {
        setDraft(null);
        setFormError("");
      }}
      onDelete={remove}
    />
  );
  const atLimit = projects.list.length >= projects.max;

  if (selected) {
    const p = detail;
    return (
      <section className="projects-page">
        <button type="button" className="project-back" onClick={() => setParams({})}>
          <Icon name="arrow" size={13} />
          All projects
        </button>
        {error && <Notice type="error">{error}</Notice>}
        {p && (
          <ProjectView
            p={p}
            privacy={projects.privacyOf(p, vaultLive)}
            models={models}
            config={config}
            busy={busy}
            vault={vault}
            vaultLive={vaultLive}
            editor={editor}
            onNewChat={onNewChat}
            onEdit={() => setDraft(draftOf(p, projects.privacyOf(p, vaultLive)))}
            onOpenChat={onOpenChat}
            onMoveOut={moveOut}
            onOpenVaultChat={onOpenVaultChat}
            onUnlockVault={onUnlockVault}
          />
        )}
      </section>
    );
  }

  return (
    <section className="projects-page">
      <div className="projects-head">
        <div>
          <p className="eyebrow">KEEP RELATED WORK TOGETHER</p>
          <h1>Projects</h1>
          <p>
            Group chats and Symposium runs. A project's instructions and pinned
            files go with every new chat in it, with its own default model and
            privacy mode.
          </p>
        </div>
        <Button type="button" onClick={() => setDraft(blank())} disabled={atLimit || busy || !!draft}>
          New project <Icon name="plus" size={16} />
        </Button>
      </div>
      {error && <Notice type="error">{error}</Notice>}
      {atLimit && (
        <p className="project-help">{`You have the most projects an account can keep (${projects.max}). Delete one to add another.`}</p>
      )}
      {editor}
      {projects.list.length ? (
        <>
          <p className="projects-count">{`${projects.list.length}/${projects.max}`}</p>
          <div className="project-grid">
            {projects.list.map((p) => (
              <article className="project-card" key={p.id} style={{ "--project": colorHex(p.color) }}>
                <button type="button" className="project-card-main" onClick={() => setParams({ p: p.id })}>
                  <span className="project-card-bar" aria-hidden="true" />
                  <h2 data-i18n="off">{p.name}</h2>
                  <span className="project-meta">
                    <span>{count(p.chat_count, "saved chat", "saved chats")}</span>
                    {p.run_count > 0 && <span>{count(p.run_count, "Symposium run", "Symposium runs")}</span>}
                  </span>
                </button>
                <Tags project={p} models={models} privacy={projects.privacyOf(p, vaultLive)} />
                <div className="project-actions">
                  <button type="button" className="small-button" onClick={() => onNewChat(p)}>
                    <Icon name="plus" size={13} />
                    New chat
                  </button>
                  <button type="button" className="small-button" onClick={() => setDraft(draftOf(p, projects.privacyOf(p, vaultLive)))} disabled={busy}>
                    Edit
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : (
        !draft &&
        projects.loaded && (
          <Empty icon="folder" title="No projects yet." action={<Button type="button" onClick={() => setDraft(blank())}>New project</Button>}>
            A project keeps related chats together, with instructions and
            pinned files that go with every new chat in it.
          </Empty>
        )
      )}
    </section>
  );
}
