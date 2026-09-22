import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { animate, createAnimatable, stagger } from "animejs";
import { Icon, PixelTile, BandLines, BandSteps, CountUp } from "./ui.jsx";
import AsciiField from "./AsciiField.jsx";
import { Reveal } from "./ReferenceMotion.jsx";
import { useApp } from "./context.jsx";
import { api } from "./lib.js";

const modes = [
  ["chat", "Chat"],
  ["code", "Code"],
  ["image", "Image"],
  ["video", "Video"],
];
const modeNames = {
  chat: "Chat & reason",
  code: "Code & build",
  image: "Image studio",
  video: "Video studio",
};
const placeholders = {
  chat: "What would you like to think through?",
  code: "What would you like to build?",
  image: "Describe what you imagine…",
  video: "Describe your scene…",
};
const shortcuts = [
  ["Chat & reasoning", "chat", "/workspace/chat"],
  ["Code generation", "code", "/workspace/code"],
  ["Image creation", "image", "/workspace/image"],
  ["Video generation", "video", "/workspace/video"],
  ["Your library", "library", "/workspace/library"],
  ["Developer API", "key", "/account/keys"],
];
const guides = [
  ["choose-a-model", "models", "models", "Model guide", "The right model for the way you work."],
  ["understanding-credits", "credits", "credits", "Credits & usage", "Understand your credits, estimates and receipts."],
  ["one-api", "api", "key", "Developer notes", "One connection to your AI workspace."],
];
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 18) return "Good afternoon";
  return "Good evening";
}

function snippet(conversation) {
  const answer = [...(conversation.messages || [])]
    .reverse()
    .find((m) => m.role === "assistant")?.content;
  return typeof answer === "string"
    ? answer.replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim().slice(0, 110)
    : "";
}

export default function WorkspaceHome({ demo, user, models, conversations, media, onOpen }) {
  const q = demo ? "?demo=1" : "";
  const navigate = useNavigate();
  const hero = useRef();
  const film = useRef();
  const [tab, setTab] = useState("chat");
  const [text, setText] = useState("");
  const { config } = useApp();
  const [ledger, setLedger] = useState([]);
  const [jobs, setJobs] = useState([]);
  // Signed in: activity comes from the real ledger and running jobs from the video queue.
  useEffect(() => {
    if (demo || !user) return;
    api("/api/account/ledger")
      .then((r) => setLedger(r.data || []))
      .catch(() => {});
    api("/api/videos")
      .then((r) => setJobs(r.data || []))
      .catch(() => {});
  }, [demo, user]);
  const running = jobs.filter((j) =>
    ["submitting", "pending", "processing", "reconciliation"].includes(j.status),
  ).length;
  const balance = demo
    ? { available: 1000, held: 0, balance: 1000 }
    : user
      ? { available: user.available, held: user.held, balance: user.balance }
      : null;
  const shareAvailable = balance?.balance
    ? Math.round((Number(balance.available) / Number(balance.balance)) * 100)
    : 100;
  const defaultModel = models.find(
    (m) =>
      (demo || m.callable) &&
      (tab === "image"
        ? m.imageCapable || (demo && m.type === "image")
        : tab === "video"
          ? m.type === "video"
          : m.type === "chat"),
  );
  const counts = {
    chat: conversations.filter((c) => c.mode === "chat").length,
    code: conversations.filter((c) => c.mode === "code").length,
    image: media.filter((m) => m.kind === "image").length,
    video: media.filter((m) => m.kind === "video").length,
  };
  const ledgerTile = { chat: "chat", code: "code", image: "image", video: "video", deposit: "credits" };
  const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toLocaleString();
  const activity = !demo && ledger.length
    ? ledger.slice(0, 4).map((r) => ({
        key: r.id,
        tile: ledgerTile[r.kind] || "credits",
        title: r.description || r.kind,
        meta: `${r.kind[0].toUpperCase()}${r.kind.slice(1)}${r.key_name ? " · API key " + r.key_name : ""} · ${new Date(r.created).toLocaleDateString()}`,
        amount: signed(Number(r.amount) || 0),
        to: "/account" + q,
      }))
    : [
    ...media.map((m) => ({
      key: m.id,
      tile: m.kind,
      title: m.prompt,
      meta: `${m.kind === "video" ? "Video" : "Image"} · ${m.model}`,
      amount: m.sample ? "0" : m.cost != null ? `−${m.cost}` : null,
      to: "/workspace/" + m.kind + q,
    })),
    ...conversations.map((c) => ({
      key: c.id,
      tile: c.mode,
      title: c.title,
      meta: modeNames[c.mode] || "Conversation",
      amount: demo ? "0" : null,
      conversation: c,
    })),
  ].slice(0, 4);
  const recent = [
    ...conversations.slice(0, 2).map((c) => ({ type: "conversation", item: c })),
    ...media.slice(0, 2).map((m) => ({ type: "media", item: m })),
  ];

  useEffect(() => {
    const node = hero.current;
    const video = film.current;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !reducedMotion()) video.play().catch(() => {});
        else video.pause();
      },
      { threshold: 0.05 },
    );
    io.observe(video);
    if (reducedMotion()) return () => io.disconnect();
    const pills = [...node.querySelectorAll(".home-pill")];
    const entrance = animate(pills, {
      scale: [0, 1],
      opacity: [0, 1],
      duration: 900,
      delay: stagger(90, { start: 500 }),
      ease: "outBack(1.4)",
    });
    const depth = [0.7, 1.2, 0.9, 1.4, 0.8, 1.1];
    const layers = pills.map((p) => createAnimatable(p, { x: 1200, y: 1200 }));
    const move = (e) => {
      if (!matchMedia("(hover: hover)").matches) return;
      const r = node.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      layers.forEach((l, i) => {
        l.x(-x * 26 * depth[i]);
        l.y(-y * 18 * depth[i]);
      });
    };
    const leave = () => layers.forEach((l) => (l.x(0), l.y(0)));
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerleave", leave);
    return () => {
      io.disconnect();
      entrance.revert();
      layers.forEach((l) => l.revert());
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerleave", leave);
    };
  }, []);

  function start(e) {
    e.preventDefault();
    navigate("/workspace/" + tab + q, { state: { prompt: text.trim() } });
  }

  return (
    <div className="home-view">
      <section className="home-hero" ref={hero}>
        <div className="home-film" aria-hidden="true">
          <video
            ref={film}
            src="/media/anonyma-landscape-upscaled.mp4"
            poster="/media/anonyma-landscape-upscaled-poster.jpg"
            muted
            loop
            playsInline
            preload="metadata"
          />
        </div>
        <AsciiField sectionRef={hero} />
        <BandLines />
        <nav className="home-pills" aria-label="Workflow shortcuts">
          {shortcuts.map(([label, icon, to], i) => (
            <Link key={label} to={to + q} className={"home-pill home-pill-" + i}>
              <PixelTile name={icon} />
              <b>{label}</b>
            </Link>
          ))}
        </nav>
        <div className="home-hero-inner">
          <p className="eyebrow">{demo ? "DEMO WORKSPACE" : "YOUR WORKSPACE"}</p>
          <Reveal>
            <h1>
              {greeting()}
              {user?.username ? `, ${user.username}` : ""}.
            </h1>
          </Reveal>
          <p>Pick up where you left off, or start something new.</p>
        </div>
        <BandSteps />
      </section>

      <div className="home-wrap">
        <form className="home-composer" onSubmit={start}>
          <label className="sr-only" htmlFor="home-prompt">
            Your prompt
          </label>
          <textarea
            id="home-prompt"
            rows="2"
            value={text}
            maxLength={tab === "video" ? 2000 : 48000}
            placeholder={placeholders[tab]}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) start(e);
            }}
          />
          <div className="home-composer-bar">
            <div className="home-tabs" role="group" aria-label="Workflow">
              {modes.map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  aria-pressed={tab === id}
                  className={tab === id ? "active" : ""}
                  onClick={() => setTab(id)}
                >
                  <PixelTile name={id} />
                  {label}
                </button>
              ))}
            </div>
            <span className="home-model">
              {defaultModel?.name || "Choose a model"}
              <em>
                {demo
                  ? "Prepared sample"
                  : defaultModel?.callable
                    ? "Available"
                    : "Catalog only"}
              </em>
            </span>
            <button type="submit" className="step-button">
              Open {modeNames[tab]}
              <Icon name="arrow" size={15} />
            </button>
          </div>
        </form>
        <span className="home-link" aria-hidden="true" />

        <div className="home-grid">
          <article className="home-card home-balance" style={{ "--i": 0 }}>
            <img className="home-balance-field" src="/media/ascii/poster.webp" alt="" />
            <p className="eyebrow">Balance</p>
            {balance ? (
              <>
                <b className="home-balance-value">
                  <CountUp value={balance.available} />
                </b>
                <span className="home-balance-caption">credits available</span>
                <span className="home-meter" aria-hidden="true">
                  <i style={{ width: shareAvailable + "%" }} />
                </span>
                <dl>
                  <div>
                    <dt>Available</dt>
                    <dd>{Number(balance.available || 0).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Held</dt>
                    <dd>{Number(balance.held || 0).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Total</dt>
                    <dd>{Number(balance.balance || 0).toLocaleString()}</dd>
                  </div>
                </dl>
                <Link className="home-balance-link" to={"/account/credits" + q}>
                  {demo
                  ? "Sample credits · explore funding"
                  : config?.testMode
                    ? "Fixture credits · test mode"
                    : "Add credits"}
                  <Icon name="arrow" size={14} />
                </Link>
              </>
            ) : (
              <>
                <b className="home-balance-value">—</b>
                <span className="home-balance-caption">Sign in to see your balance</span>
                <Link className="home-balance-link" to="/login">
                  Go to sign-in <Icon name="arrow" size={14} />
                </Link>
              </>
            )}
          </article>

          <article className="home-card" style={{ "--i": 1 }}>
            <p className="eyebrow">Your workflows</p>
            <div className="home-flows">
              {modes.map(([id]) => (
                <Link key={id} to={"/workspace/" + id + q} className="home-flow">
                  <PixelTile name={id} />
                  <span>
                    <b>{modeNames[id]}</b>
                    <small>
                      {id === "image"
                        ? plural(counts.image, demo ? "sample image" : "image")
                        : id === "video"
                          ? plural(counts.video, demo ? "sample video" : "video") +
                            (running ? ` · ${running} in progress` : "")
                          : plural(counts[id], "conversation")}
                    </small>
                  </span>
                  <Icon name="arrow" size={14} />
                </Link>
              ))}
            </div>
          </article>

          <article className="home-card" style={{ "--i": 2 }}>
            <div className="home-card-head">
              <p className="eyebrow">Recent activity</p>
              <Link to={"/account" + q}>View all</Link>
            </div>
            {activity.length ? (
              <ul className="home-activity">
                {activity.map((a) => (
                  <li key={a.key}>
                    {a.conversation ? (
                      <button type="button" onClick={() => onOpen(a.conversation)}>
                        <PixelTile name={a.tile} />
                        <span>
                          <b>{a.title}</b>
                          <small>{a.meta}</small>
                        </span>
                        {a.amount != null && (
                          <em>
                            {a.amount}
                            <small>credits</small>
                          </em>
                        )}
                      </button>
                    ) : (
                      <Link to={a.to}>
                        <PixelTile name={a.tile} />
                        <span>
                          <b>{a.title}</b>
                          <small>{a.meta}</small>
                        </span>
                        {a.amount != null && (
                          <em>
                            {a.amount}
                            <small>credits</small>
                          </em>
                        )}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="home-empty">Your conversations and creations will appear here.</p>
            )}
            {demo ? (
              <p className="home-note">Sample activity · no credits charged</p>
            ) : config?.testMode ? (
              <p className="home-note">Local test mode · fixture credits, no real charges</p>
            ) : null}
          </article>
        </div>

        {recent.length > 0 && (
          <section className="home-section">
            <div className="home-card-head">
              <p className="eyebrow">Recent work</p>
              <Link to={"/workspace/library" + q}>Open library</Link>
            </div>
            <div className="home-recent">
              {recent.map(({ type, item }, i) =>
                type === "conversation" ? (
                  <button
                    type="button"
                    key={item.id}
                    className="home-work"
                    style={{ "--i": i }}
                    onClick={() => onOpen(item)}
                  >
                    <span className="home-work-kind">
                      <PixelTile name={item.mode} />
                      {modeNames[item.mode] || "Conversation"}
                    </span>
                    <b>{item.title}</b>
                    <small>{snippet(item)}</small>
                  </button>
                ) : (
                  <Link
                    key={item.id}
                    className="home-work home-work-media"
                    style={{ "--i": i }}
                    to={"/workspace/" + item.kind + q}
                  >
                    {item.kind === "video" && item.sample ? (
                      <img src="/media/anonyma-hero-poster.jpg" alt="" />
                    ) : item.kind === "video" ? (
                      <video src={item.url} muted playsInline preload="metadata" aria-hidden="true" />
                    ) : (
                      <img src={item.url} alt="" />
                    )}
                    <span className="home-work-kind">
                      <PixelTile name={item.kind} />
                      {item.sample ? "Prepared sample" : item.model}
                    </span>
                    <b>{item.prompt}</b>
                  </Link>
                ),
              )}
            </div>
          </section>
        )}

        <section className="home-section">
          <div className="home-card-head">
            <p className="eyebrow">From the knowledge base</p>
            <Link to="/docs">Documentation</Link>
          </div>
          <div className="home-guides">
            {guides.map(([slug, image, icon, tag, title], i) => (
              <Link key={slug} to={"/guides/" + slug} className="home-guide" style={{ "--i": i }}>
                <span className="home-guide-art">
                  <img src={`/media/knowledge-painterly-${image}.png`} alt="" loading="lazy" />
                  <PixelTile name={icon} />
                </span>
                <small>{tag}</small>
                <b>{title}</b>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
