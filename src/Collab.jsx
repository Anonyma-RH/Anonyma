import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Icon, Button, Notice, Empty, CopyButton } from "./ui.jsx";
import { api } from "./lib.js";
import { t } from "./i18n.js";

// Collab: shared workspaces of up to 12 people with shared conversations.
export default function CollabHub({ demo, user }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [list, setList] = useState([]),
    [active, setActive] = useState(null),
    [name, setName] = useState(""),
    [topic, setTopic] = useState(""),
    [invite, setInvite] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const load = () =>
    api("/api/collabs")
      .then((r) => setList(r.data))
      .catch((e) => setError(e.message));
  const open = (id) =>
    api("/api/collabs/" + id)
      .then((c) => {
        setActive(c);
        setInvite("");
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    if (demo || !user) return;
    load();
    const token = params.get("join");
    if (token) {
      api("/api/collabs/join", { method: "POST", body: { token } })
        .then((c) => {
          setNotice(`You joined ${c.name}.`);
          setParams({}, { replace: true });
          load();
          open(c.id);
        })
        .catch((e) => setError(e.message));
    }
  }, [demo, user]);
  async function act(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (demo || !user)
    return (
      <div className="library-page">
        <Empty icon="users" title="Work together in a collab.">
          Collabs are shared workspaces for up to 12 people. Sign in to create one or
          to accept an invite link.
        </Empty>
      </div>
    );
  const owner = active?.role === "owner";
  return (
    <div className="library-page collab-page">
      <div className="page-heading-inline">
        <div>
          <p className="eyebrow">COLLAB</p>
          <h1>Think it through together.</h1>
          <p>Shared conversations for up to 12 people. Everyone pays for their own requests.</p>
        </div>
      </div>
      {notice && <Notice>{notice}</Notice>}
      {error && <Notice type="error">{error}</Notice>}
      <div className="collab-layout">
        <aside>
          <form
            className="form-panel"
            onSubmit={(e) => {
              e.preventDefault();
              act(async () => {
                const c = await api("/api/collabs", { method: "POST", body: { name } });
                setName("");
                await load();
                await open(c.id);
              });
            }}
          >
            <label>
              New collab
              <input value={name} maxLength="60" placeholder="Launch team" onChange={(e) => setName(e.target.value)} required />
            </label>
            <Button disabled={busy || !name.trim()}>
              Create <Icon name="plus" size={16} />
            </Button>
          </form>
          <nav className="collab-list" aria-label="Your collabs">
            {list.map((c) => (
              <button key={c.id} className={active?.id === c.id ? "active" : ""} onClick={() => open(c.id)}>
                <b data-i18n="off">{c.name}</b>
                <span>
                  {c.members} member{c.members === 1 ? "" : "s"} · {c.role}
                </span>
              </button>
            ))}
          </nav>
        </aside>
        {active ? (
          <section className="collab-detail">
            <div className="account-section-head">
              <h2 data-i18n="off">{active.name}</h2>
              {owner ? (
                <button
                  className="small-button danger-text"
                  onClick={() =>
                    confirm(t(`Delete ${active.name} and its shared conversations?`)) &&
                    act(async () => {
                      await api("/api/collabs/" + active.id, { method: "DELETE" });
                      setActive(null);
                      await load();
                    })
                  }
                >
                  <Icon name="delete" size={14} /> Delete collab
                </button>
              ) : (
                <button
                  className="small-button"
                  onClick={() =>
                    act(async () => {
                      await api(`/api/collabs/${active.id}/members/${encodeURIComponent(user.username)}`, { method: "DELETE" });
                      setActive(null);
                      await load();
                    })
                  }
                >
                  Leave collab
                </button>
              )}
            </div>
            <div className="collab-columns">
              <div>
                <h3>Shared conversations</h3>
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(async () => {
                      const r = await api(`/api/collabs/${active.id}/conversations`, {
                        method: "POST",
                        body: { title: topic || "Shared conversation" },
                      });
                      navigate("/workspace/chat?c=" + r.id);
                    });
                  }}
                >
                  <input value={topic} maxLength="70" placeholder="What are you working on?" onChange={(e) => setTopic(e.target.value)} />
                  <Button disabled={busy}>Start</Button>
                </form>
                {active.conversations.length ? (
                  active.conversations.map((c) => (
                    <button key={c.id} className="collab-conversation" onClick={() => navigate(`/workspace/${c.mode}?c=${c.id}`)}>
                      <b data-i18n="off">{c.title}</b>
                      <span>
                        {c.author ? "by " + c.author + " · " : ""}
                        {new Date(c.updated).toLocaleString()}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="fine-print">No shared conversations yet.</p>
                )}
              </div>
              <div>
                <h3>
                  Members <span className="fine-print">{active.members.length} / {active.maxMembers}</span>
                </h3>
                <ul className="collab-members">
                  {active.members.map((m) => (
                    <li key={m.username + m.joined}>
                      <span className="avatar">{m.username[0]?.toUpperCase()}</span>
                      <span>
                        {m.username}
                        {m.role === "owner" && <small> · owner</small>}
                      </span>
                      {owner && m.role !== "owner" && (
                        <button
                          className="small-button"
                          aria-label={"Remove " + m.username}
                          onClick={() =>
                            act(async () => {
                              await api(`/api/collabs/${active.id}/members/${encodeURIComponent(m.username)}`, { method: "DELETE" });
                              await open(active.id);
                            })
                          }
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {owner && (
                  <div className="info-card">
                    <h3>Invite people</h3>
                    {invite ? (
                      <div className="invite-link">
                        <code>{invite}</code>
                        <CopyButton text={invite} />
                      </div>
                    ) : (
                      <p>Anyone with the link can join while there's room.</p>
                    )}
                    <button
                      className="small-button"
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          const r = await api(`/api/collabs/${active.id}/invite`, { method: "POST", body: {} });
                          setInvite(r.link);
                        })
                      }
                    >
                      {invite ? "Make a new link (disables this one)" : "Create invite link"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : (
          <Empty icon="users" title={list.length ? "Choose a collab." : "Start your first collab."}>
            Create one, then share its invite link with up to 11 others.
          </Empty>
        )}
      </div>
    </div>
  );
}
