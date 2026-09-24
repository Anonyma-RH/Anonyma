import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PixelIcon, CountUp } from "./ui.jsx";
import { useApp } from "./context.jsx";
import { api } from "./lib.js";
import "./dashboard.css";

// The workspace dashboard: greeting and composer, the balance, where the
// credits went over two weeks, recent work, and the social and API corners.
const modes = [
  ["chat", "Chat"],
  ["code", "Code"],
  ["image", "Image"],
  ["video", "Video"],
  ["audio", "Voice"],
];
const placeholders = {
  chat: "Ask, write or think something through…",
  code: "What would you like to build?",
  image: "Describe what you imagine…",
  video: "Describe your scene…",
  audio: "Type what you'd like to hear spoken…",
};
const modeNames = {
  chat: "Chat",
  code: "Code",
  image: "Image",
  video: "Video",
  audio: "Voice",
  collab: "Collab",
};
const kindNames = { chat: "Chat & code", image: "Images", video: "Video", audio: "Voice" };
const kindNouns = {
  chat: ["chat", "chats"],
  image: ["image", "images"],
  video: ["video", "videos"],
  audio: ["voice clip", "voice clips"],
};
// A Greek key, drawn in the same 7-pixel grid as the icons.
const meander = ["#######.", "#.....#.", "#.###.#.", "#.#...#.", "#.#####.", "#.......", "########"];
const CREDITS_PER_USD = 1000;

const plural = (n, one, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const fmt = (n) =>
  (Number(n) || 0).toLocaleString(undefined, {
    maximumFractionDigits: Math.abs(n) >= 10 ? 0 : 2,
  });
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(t) {
  const s = (Date.now() - Number(t)) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  for (const [unit, sec] of [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ])
    if (s >= sec) return rtf.format(-Math.floor(s / sec), unit);
}
function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 18) return "Good afternoon";
  return "Good evening";
}
function dayLabel(date) {
  return new Date(date + "T12:00:00Z").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
function lasts(available, spentThisWeek) {
  const perDay = spentThisWeek / 7;
  if (!(perDay > 0) || !(available > 0)) return "";
  const days = available / perDay;
  const span =
    days < 1
      ? "less than a day"
      : days < 14
        ? plural(Math.round(days), "day")
        : days < 120
          ? plural(Math.round(days / 7), "week")
          : "several months";
  return ` At this week's pace that lasts about ${span}.`;
}
function niceMax(m) {
  if (!(m > 0)) return 100;
  const mag = 10 ** Math.floor(Math.log10(m));
  return [1, 2, 2.5, 5, 10].map((s) => s * mag).find((v) => v >= m);
}

// Sample figures for the browser-only demo, which never calls the API.
function demoData() {
  const shape = [18, 24, 9, 31, 26, 42, 15, 20, 33, 28, 47, 39, 21, 36];
  const today = new Date();
  const days = shape.map((spent, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - 13 + i);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return { date: local.toISOString().slice(0, 10), spent };
  });
  return {
    summary: {
      days,
      byKind: [
        { kind: "chat", spent: 142, requests: 98 },
        { kind: "image", spent: 82, requests: 22 },
        { kind: "video", spent: 69, requests: 6 },
        { kind: "audio", spent: 12, requests: 20 },
      ],
      week: { spent: 224, previous: 190, requests: 71, byKind: { chat: 52, image: 11, audio: 5, video: 3 } },
    },
    collabs: [{ id: "demo", name: "Launch team", members: 3, role: "owner" }],
    referrals: { percent: 5, invited: 2, earned: 100, link: "" },
    keys: [{ id: "demo", name: "Production app", cap: 100, spent: 62, revoked: null }],
  };
}

function Meander() {
  return (
    <svg className="dash-meander" aria-hidden="true" width="100%" height="14">
      <defs>
        <pattern id="dash-meander" width="16" height="14" patternUnits="userSpaceOnUse">
          {meander.flatMap((row, y) =>
            [...row].map((c, x) =>
              c === "#" ? <rect key={x + "-" + y} x={x * 2} y={y * 2} width="2" height="2" /> : null,
            ),
          )}
        </pattern>
      </defs>
      <rect width="100%" height="14" fill="url(#dash-meander)" />
    </svg>
  );
}

function Tile({ name }) {
  return (
    <span className="dash-tile">
      <PixelIcon name={name} />
    </span>
  );
}

function SpendChart({ days }) {
  const [active, setActive] = useState(null);
  const top = Math.max(0, ...days.map((d) => d.spent));
  const max = niceMax(top);
  const peak = top > 0 ? days.findIndex((d) => d.spent === top) : -1;
  const shown = active ?? peak;
  return (
    <div className="dash-chart" role="group" aria-label="Credits spent per day over the last 14 days">
      {[0, max / 2, max].map((g) => (
        <div key={g} className="dash-grid" style={{ bottom: (g / max) * 100 + "%" }}>
          <span>{fmt(g)}</span>
        </div>
      ))}
      <div className="dash-bars" onMouseLeave={() => setActive(null)}>
        {days.map((d, i) => (
          <div
            key={d.date}
            className={"dash-col" + (i === shown ? " on" : "")}
            style={{ "--n": i }}
            tabIndex={0}
            aria-label={`${dayLabel(d.date)}: ${fmt(d.spent)} credits`}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
          >
            <div className="dash-bar" style={{ height: (d.spent / max) * 100 + "%" }}>
              {i === shown && (
                <b className="dash-tip">
                  {active === i && <small>{dayLabel(d.date)}</small>}
                  {fmt(d.spent)}
                </b>
              )}
            </div>
            <span>{i % 2 ? "" : dayLabel(d.date)}</span>
          </div>
        ))}
      </div>
      {top === 0 && (
        <p className="dash-chart-empty">
          Nothing spent in the last two weeks. Your first request will show up here.
        </p>
      )}
    </div>
  );
}

export default function WorkspaceHome({ demo, user, models, conversations, media, onOpen }) {
  const q = demo ? "?demo=1" : "";
  const navigate = useNavigate();
  const { config } = useApp();
  const [tab, setTab] = useState("chat");
  const [text, setText] = useState("");
  const [web, setWeb] = useState(false);
  const [copied, setCopied] = useState(false);
  const [data, setData] = useState(() => (demo ? demoData() : {}));
  const [jobs, setJobs] = useState([]);

  useEffect(() => {
    if (demo) return setData(demoData());
    if (!user) return;
    const get = (path, key, pick = (r) => r) =>
      api(path)
        .then((r) => setData((d) => ({ ...d, [key]: pick(r) })))
        .catch(() => {});
    get("/api/account/summary?tz=" + new Date().getTimezoneOffset(), "summary");
    get("/api/collabs", "collabs", (r) => r.data || []);
    get("/api/referrals", "referrals");
    get("/api/keys", "keys", (r) => r.data || []);
    api("/api/videos")
      .then((r) => setJobs(r.data || []))
      .catch(() => {});
  }, [demo, user?.id]);

  const { summary, collabs, referrals, keys } = data;
  const running = jobs.filter((j) =>
    ["submitting", "pending", "processing", "reconciliation"].includes(j.status),
  ).length;
  const balance = demo
    ? { available: 1000, held: 0 }
    : user
      ? { available: Number(user.available) || 0, held: Number(user.held) || 0 }
      : null;
  const week = summary?.week;
  // Whole credits once the balance is large; the header keeps the exact figure.
  const shown = balance
    ? balance.available >= 1000
      ? Math.floor(balance.available)
      : balance.available
    : 0;
  const defaultModel =
    tab === "audio"
      ? null
      : models.find(
          (m) =>
            (demo || m.callable) &&
            (tab === "image"
              ? m.imageCapable || (demo && m.type === "image")
              : tab === "video"
                ? m.type === "video"
                : m.type === "chat"),
        );
  const last = conversations[0];
  const name = user?.username;

  function start(e) {
    e.preventDefault();
    navigate("/workspace/" + tab + q, {
      state: { prompt: text.trim(), web: web && (tab === "chat" || tab === "code") },
    });
  }
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(referrals.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  const change =
    week && week.previous > 0
      ? Math.round(((week.spent - week.previous) / week.previous) * 100)
      : null;
  const facts = balance && [
    [
      "Spent this week",
      week ? fmt(week.spent) : "–",
      !week
        ? ""
        : change === null
          ? week.spent > 0
            ? "Nothing the week before"
            : "Nothing yet this week"
          : change === 0
            ? "The same as last week"
            : `${Math.abs(change)}% ${change > 0 ? "more" : "less"} than last week`,
    ],
    [
      "Requests this week",
      week ? week.requests.toLocaleString() : "–",
      week?.requests
        ? Object.entries(week.byKind)
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => plural(n, ...(kindNouns[k] || [k])))
            .join(", ")
        : week
          ? "None yet"
          : "",
    ],
    [
      "On hold",
      fmt(balance.held),
      running
        ? `for ${plural(running, "video")} still rendering`
        : balance.held > 0
          ? "for requests that are still running"
          : "Nothing is waiting to settle",
    ],
  ];
  const kinds = summary?.byKind || [];
  const kindMax = Math.max(0, ...kinds.map((k) => k.spent));
  const activeKeys = (keys || []).filter((k) => !k.revoked);
  const key = activeKeys.find((k) => k.cap != null) || activeKeys[0];
  const creations = media.slice(0, 3);

  return (
    <div className="dash">
      <section className="dash-hero">
        <div className="dash-hero-copy">
          <h1
            className="dash-display dash-hello"
            style={{
              "--fit": Math.max(
                ...`${greeting()}, ${name || ""}.`.split(" ").map((w) => w.length),
              ),
            }}
          >
            <span style={{ "--i": 0 }}>
              {greeting()}
              {name ? "," : "."}
            </span>
            {name && (
              <span style={{ "--i": 1 }}>
                {/* A name too long even at the smallest size wraps after _ . or - rather than mid-word. */}
                {name.split(/(?<=[_.-])/).map((part, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <wbr />}
                    {part}
                  </React.Fragment>
                ))}
                .
              </span>
            )}
          </h1>
          <p>
            {last ? (
              <>
                Your {last.mode === "code" ? "code session" : "conversation"}{" "}
                <a
                  href={`/workspace/${last.mode === "code" ? "code" : "chat"}?c=${last.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpen(last);
                  }}
                >
                  “{last.title}”
                </a>{" "}
                is where you left it.
              </>
            ) : (
              "Ask, write, draw or build. Everything runs on one prepaid balance."
            )}
          </p>
        </div>
        <form className="dash-composer" onSubmit={start}>
          <label className="sr-only" htmlFor="home-prompt">
            Your prompt
          </label>
          <textarea
            id="home-prompt"
            rows="3"
            value={text}
            maxLength={tab === "video" ? 2000 : 48000}
            placeholder={placeholders[tab]}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) start(e);
            }}
          />
          <div className="dash-composer-bar">
            <div className="dash-modes" role="group" aria-label="Workflow">
              {modes.map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  aria-pressed={tab === id}
                  className={tab === id ? "on" : ""}
                  onClick={() => setTab(id)}
                >
                  <PixelIcon name={id} size={13} />
                  {label}
                </button>
              ))}
            </div>
            <div className="dash-composer-go">
              {(tab === "chat" || tab === "code") && (
                <button
                  type="button"
                  className={"dash-web" + (web ? " on" : "")}
                  aria-pressed={web}
                  onClick={() => setWeb((v) => !v)}
                >
                  Search the web
                </button>
              )}
              <span className="dash-model">
                {tab === "audio" ? "Text to speech" : defaultModel?.name || "Choose a model"}
              </span>
              <button type="submit" className="dash-start">
                Start
              </button>
            </div>
          </div>
        </form>
        <Meander />
      </section>

      <section className="dash-ledger" style={{ "--i": 0 }}>
        <div>
          <p className="dash-label">Balance</p>
          {balance ? (
            <>
              <div
                className="dash-display dash-balance"
                style={{ "--len": shown.toLocaleString().length }}
              >
                <CountUp value={shown} />
              </div>
              <p className="dash-note">
                credits, worth ${(balance.available / CREDITS_PER_USD).toFixed(2)}.
                {week && lasts(balance.available, week.spent)}
                {demo
                  ? " Sample figures for the demo."
                  : config?.testMode
                    ? " Fixture credits in local test mode."
                    : ""}
              </p>
              <div className="dash-actions">
                <Link className="solid" to={"/account/credits" + q}>
                  Add credits
                </Link>
                <Link to={"/account/credits" + q}>Send credits</Link>
              </div>
            </>
          ) : (
            <>
              <div className="dash-display dash-balance">–</div>
              <p className="dash-note">Sign in to see your balance and spending.</p>
              <div className="dash-actions">
                <Link className="solid" to="/login">
                  Sign in
                </Link>
              </div>
            </>
          )}
        </div>
        {facts && (
          <dl className="dash-facts">
            {facts.map(([label, value, note]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className="dash-display">{value}</dd>
                <span>{note}</span>
              </div>
            ))}
          </dl>
        )}
      </section>

      {summary && (
        <section className="dash-split" style={{ "--i": 1 }}>
          <div>
            <h2 className="dash-h2">Spending over the last two weeks</h2>
            <SpendChart days={summary.days} />
            <p className="dash-caption">Credits spent per day, in your time zone.</p>
          </div>
          <div>
            <h2 className="dash-h2">Where it went</h2>
            {kinds.length ? (
              <div className="dash-where">
                {kinds.map((k, i) => (
                  <div key={k.kind} className="dash-wrow" style={{ "--n": i }}>
                    <Tile name={k.kind} />
                    <span>{kindNames[k.kind] || k.kind}</span>
                    <div className="dash-track">
                      <div style={{ width: (kindMax ? (k.spent / kindMax) * 100 : 0) + "%" }} />
                    </div>
                    <b>{fmt(k.spent)}</b>
                  </div>
                ))}
              </div>
            ) : (
              <p className="dash-empty">
                Once you use a model, this shows which kinds of work your credits went to.
              </p>
            )}
          </div>
        </section>
      )}

      <section className="dash-split dash-work" style={{ "--i": 2 }}>
        <div>
          <h2 className="dash-h2">Keep going</h2>
          {conversations.length ? (
            <ul className="dash-rows">
              {conversations.slice(0, 4).map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => onOpen(c)}>
                    <Tile name={modeNames[c.mode] ? c.mode : "chat"} />
                    <span>
                      <b>{c.title}</b>
                      <small>
                        {modeNames[c.mode] || "Conversation"}
                        {c.updated ? ", " + ago(c.updated) : ""}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dash-empty">
              Your conversations will show up here.{" "}
              <Link to={"/workspace/chat" + q}>Start a chat</Link>
            </p>
          )}
        </div>
        <div>
          <h2 className="dash-h2">Recent creations</h2>
          {creations.length ? (
            <div className={"dash-gallery n" + creations.length}>
              {creations.map((m) => (
                <Link key={m.id} to={"/workspace/" + m.kind + q} className={"dash-figure " + m.kind}>
                  {m.kind === "audio" ? (
                    <span className="dash-wave" aria-hidden="true">
                      {Array.from({ length: 28 }, (_, i) => (
                        <i key={i} style={{ height: 22 + Math.abs(Math.sin(i * 0.9 + 3) * 66) + ((i * 7) % 11) + "%" }} />
                      ))}
                    </span>
                  ) : m.kind === "video" && m.sample ? (
                    <img src="/media/anonyma-hero-poster.jpg" alt="" />
                  ) : m.kind === "video" ? (
                    <video src={m.url} muted playsInline preload="metadata" aria-hidden="true" />
                  ) : (
                    <img src={m.url} alt="" loading="lazy" />
                  )}
                  {m.kind === "video" && <span className="dash-play" aria-hidden="true" />}
                  <span className="dash-figcaption">{m.prompt || modeNames[m.kind]}</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="dash-empty">
              Images, videos and voice clips you make will show up here.{" "}
              <Link to={"/workspace/image" + q}>Open the image studio</Link>
            </p>
          )}
        </div>
      </section>

      {(demo || user) && (
        <section className="dash-trio" style={{ "--i": 3 }}>
          <div>
            {collabs?.length ? (
              <>
                <h3>{collabs[0].name}</h3>
                <p>
                  {plural(collabs[0].members, "member")}, and you're the {collabs[0].role}.
                  {collabs.length > 1 && ` You're in ${plural(collabs.length - 1, "other collab")} too.`}
                </p>
                <Link to={"/workspace/collab" + q}>Open the collab</Link>
              </>
            ) : (
              <>
                <h3>Work together</h3>
                <p>Share conversations with up to 11 other people. Everyone pays for their own requests.</p>
                <Link to={"/workspace/collab" + q}>Start a collab</Link>
              </>
            )}
          </div>
          <div>
            <h3>Invite a friend</h3>
            <p>
              {referrals
                ? `You get ${referrals.percent}% of what they add. ` +
                  (referrals.invited
                    ? `${plural(referrals.invited, "person has", "people have")} joined through your link so far, earning you ${fmt(referrals.earned)} credits.`
                    : "Nobody has joined through your link yet.")
                : "Share your link and earn a share of what your friends add."}
            </p>
            {referrals?.link ? (
              <button type="button" onClick={copyInvite}>
                {copied ? "Link copied" : "Copy your link"}
              </button>
            ) : (
              <Link to={"/account" + q}>See your link</Link>
            )}
          </div>
          <div>
            <h3>API keys</h3>
            <p>
              {key
                ? (key.cap != null
                    ? `“${key.name}” has used ${fmt(key.spent)} of its ${fmt(key.cap)} daily credits.`
                    : `“${key.name}” has used ${fmt(key.spent)} credits in the last 24 hours.`) +
                  (activeKeys.length > 1 ? ` You have ${plural(activeKeys.length - 1, "other key")}.` : "")
                : "Use your balance from code, the CLI or any OpenAI-compatible tool."}
            </p>
            <Link to={"/account/keys" + q}>{key ? "Manage keys" : "Create a key"}</Link>
          </div>
        </section>
      )}
    </div>
  );
}
