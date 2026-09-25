import React, { useEffect, useRef, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useApp } from "./context.jsx";
import {
  Logo,
  Mark,
  Icon,
  Button,
  Notice,
  Empty,
  Modal,
  CopyButton,
  PixelTile,
  BandLines,
  BandSteps,
  ComingSoon,
  SoonTag,
} from "./ui.jsx";
import AsciiField from "./AsciiField.jsx";
import { Reveal } from "./ReferenceMotion.jsx";
import WorkspaceHome from "./WorkspaceHome.jsx";
import AudioStudio, { MicButton } from "./AudioStudio.jsx";
import CollabHub from "./Collab.jsx";
import { VeilToggle, VeilPanel, veilRemarkPlugin } from "./Veil.jsx";
import {
  EphemeralToggle,
  EphemeralNotice,
  RetentionSelect,
  RetentionIndicator,
} from "./Ephemeral.jsx";
import { retentionChoiceFor } from "./ephemeral.js";
import {
  PrivateModeToggle,
  PrivateModeNotice,
  NoPrivateModelsNotice,
  PrivateModelTag,
  PrivateReplyNote,
  privateModeReleased,
} from "./PrivateMode.jsx";
import { LanguageSwitch } from "./LanguageSwitch.jsx";
import { ScrollsPanel, ScrollFillForm } from "./Scrolls.jsx";
import { extractVariables, historyLimit, withStanding } from "./scrolls.js";
import {
  api,
  streamChat,
  readStore,
  saveStore,
  download,
  uid,
  messageFromServer,
  toRequestMessage,
  videoPresets,
  isReleased,
  modeReleased,
  releaseUpdate,
  MODE_FEATURES,
} from "./lib.js";
import {
  veil,
  loadVeilState,
  saveVeilState,
  moveVeilState,
  loadVeilWords,
  saveVeilWords,
  loadVeilOn,
  saveVeilOn,
} from "./veil.js";
const initial = [
  {
    id: "welcome",
    title: "A fresh perspective",
    mode: "chat",
    messages: [
      { role: "user", content: "What can I explore in this workspace?" },
      {
        role: "assistant",
        content:
          "Welcome to your ANONYMA demo.\n\nExplore **chat, code, images and video** in one place. Switch models, organize your conversations and discover a shared credit experience.\n\nThis is a prepared example. No AI request has been made and no credits have been charged.",
        sample: true,
      },
    ],
  },
];
const sampleChat =
  "Here is a starting point for your idea.\n\n### Make space for the possibility\n\n1. **Start with the outcome.** Describe what you want to create and who it is for.\n2. **Choose your approach.** Use chat to explore, code to build, and image or video to visualize.\n3. **Keep what works.** Refine your prompt and return to the conversation when you are ready.\n\nThis is a prepared UI demonstration, not a response from the selected model.";
const sampleCode =
  'Here is an editable starting point for a simple idea card.\n\n```jsx\n// IdeaCard.jsx — prepared demo example\nexport default function IdeaCard({ title, description }) {\n  return (\n    <article className="idea-card">\n      <span>A LITTLE POSSIBILITY</span>\n      <h2>{title}</h2>\n      <p>{description}</p>\n    </article>\n  );\n}\n```\n\n```css\n/* idea-card.css */\n.idea-card {\n  padding: 32px;\n  background: #fdfff8;\n  border: 1px solid #dfe3d9;\n}\n```\n\nFiles are available in the code panel. This workspace does not execute code.';
export function AppSidebar({
  active = "chat",
  demo = false,
  children,
  open = false,
  onClose,
}) {
  const q = demo ? "?demo=1" : "";
  const { user, config } = useApp();
  const signedIn = !demo && user;
  return (
    <aside className={"app-sidebar " + (open ? "shown" : "")}>
      <div className="sidebar-brand">
        <Logo />
        <button
          className="icon-button mobile-only"
          onClick={onClose}
          aria-label="Close sidebar"
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="sidebar-group-label">WORKSPACE</div>
      <nav aria-label="Workspace navigation">
        {[
          ["home", "Home"],
          ["chat", "Chat & reason"],
          ["uncensored", "Uncensored"],
          ["code", "Code & build"],
          ["image", "Images"],
          ["video", "Video"],
          ["audio", "Voice & audio"],
          ["collab", "Collab"],
          ["library", "Your library"],
        ].map(([id, t]) =>
          modeReleased(config, id) ? (
            <Link
              key={id}
              className={active === id ? "active" : ""}
              to={"/workspace/" + id + q}
            >
              <PixelTile name={id} />
              {t}
              {active === id && <span className="nav-active-dot" />}
            </Link>
          ) : (
            <Link key={id} className="locked" to="/roadmap">
              <PixelTile name={id} />
              {t}
              <SoonTag />
            </Link>
          ),
        )}
      </nav>
      {children}
      <div className="sidebar-bottom">
        <Link to="/models">
          <PixelTile name="models" />
          Explore models
          <Icon name="diagonal" size={13} />
        </Link>
        <Link
          to={isReleased(config, "api") ? "/account/keys" + q : "/roadmap"}
          className={isReleased(config, "api") ? "" : "locked"}
        >
          <PixelTile name="key" />
          Developer API
          {!isReleased(config, "api") && <SoonTag />}
        </Link>
        <Link to={"/account/credits" + q}>
          <PixelTile name="credits" />
          Credits
        </Link>
        <LanguageSwitch config={config} />
        <Link to={"/account" + q}>
          <span className="avatar">
            {demo
              ? "D"
              : signedIn
                ? user.username?.[0]?.toUpperCase() || "A"
                : "A"}
          </span>
          <span>
            {demo
              ? "Demo workspace"
              : signedIn
                ? user.username || "Your account"
                : "Your account"}
            <small>
              {demo
                ? "Local sample · no charges"
                : signedIn
                  ? `${Number(user.available || 0).toLocaleString()} credits available`
                  : "Balance & settings"}
            </small>
          </span>
          <Icon name="settings" size={16} />
        </Link>
      </div>
    </aside>
  );
}
export default function Workspace() {
  const { mode = "home" } = useParams();
  const location = useLocation();
  const welcomeRef = useRef();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const demo = params.get("demo") === "1";
  const { models, user, connected, config, refresh } = useApp();
  const [all, setAll] = useState(() =>
      demo ? readStore("conversations", initial) : [],
    ),
    [current, setCurrent] = useState(null),
    [messages, setMessages] = useState([]),
    [prompt, setPrompt] = useState(""),
    [model, setModel] = useState(params.get("model") || models[0]?.id || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [info, setInfo] = useState(""),
    [receipt, setReceipt] = useState(null),
    [attachments, setAttachments] = useState([]),
    [media, setMedia] = useState(() => (demo ? readStore("media", []) : [])),
    [dialog, setDialog] = useState(null),
    [menu, setMenu] = useState(false),
    [n, setN] = useState(1),
    [compareModels, setCompareModels] = useState([]),
    [jobs, setJobs] = useState([]),
    [quote, setQuote] = useState(null),
    [filter, setFilter] = useState("all"),
    [rename, setRename] = useState(""),
    // The server stores an expiry, not the preset that produced it, so this
    // only reflects a choice made in this session rather than a stored one.
    [retentionDays, setRetentionDays] = useState(null),
    [webSearch, setWebSearch] = useState(false),
    [veilOn, setVeilOn] = useState(() => loadVeilOn()),
    [veilWords, setVeilWords] = useState(() => loadVeilWords()),
    [veilNote, setVeilNote] = useState(null),
    [ephemeral, setEphemeral] = useState(false),
    [privateMode, setPrivateMode] = useState(false),
    [shared, setShared] = useState(null),
    [scrolls, setScrolls] = useState([]),
    [instructions, setInstructions] = useState({ body: "", enabled: false }),
    [scrollsPanel, setScrollsPanel] = useState(false),
    [scrollFill, setScrollFill] = useState(null),
    [slashDismissedFor, setSlashDismissedFor] = useState(null),
    [slashIndex, setSlashIndex] = useState(0),
    // null = not chosen yet, so the first published option wins over the "default" preset.
    [video, setVideo] = useState({
      quality: null,
      ratio: null,
      duration: null,
      image: "",
    });
  const controller = useRef(),
    timer = useRef(),
    streamEnd = useRef(),
    composerZone = useRef(),
    promptBox = useRef(),
    // Veil's tag<->value map for the open conversation. Keyed on a temporary
    // id until the server assigns a real conversationId (see send/openChat),
    // and never sent anywhere: see src/veil.js's local-only storage helpers.
    veilKeyRef = useRef("tmp-" + uid()),
    veilStateRef = useRef(loadVeilState(veilKeyRef.current));
  const validMode = [
    "home",
    "chat",
    "uncensored",
    "code",
    "image",
    "video",
    "audio",
    "collab",
    "library",
  ].includes(mode);
  // Chat, code and Uncensored all show text conversations; Uncensored keeps
  // its own curated models, which the other text modes leave out.
  const textMode = ["chat", "code", "uncensored"].includes(mode);
  // Scrolls (saved prompts, "/" insert and standing instructions) work in
  // every text mode: chat, code and Uncensored.
  const scrollsLive = !demo && isReleased(config, "scrolls");
  const uncensoredIds = config?.releases?.uncensoredModels || [];
  // Demo shows the catalog for illustration; live mode offers only models the service can run.
  // Private mode narrows the text modes further, to private, callable models
  // in the current section.
  const inSection = (m) => (mode === "uncensored") === uncensoredIds.includes(m.id);
  const privateModelsCallable = models.filter(
    (m) => m.type === "chat" && m.private && m.callable && inSection(m),
  );
  const visibleModels = models.filter((m) => {
    const base =
      mode === "image"
        ? demo
          ? m.imageCapable || m.type === "image"
          : m.imageCapable && m.callable
        : mode === "video"
          ? m.type === "video" &&
            (demo || (m.callable && videoPresets(m).length > 0))
          : m.type === "chat" && (demo || m.callable) && inSection(m);
    return base && (!textMode || !privateMode || m.private);
  });
  const selected = models.find((m) => m.id === model);
  // Video choices come only from the model's published prices, as the server requires.
  const presets = mode === "video" && selected ? videoPresets(selected) : [];
  const pick = (values, value) =>
    values.includes(value) ? value : (values[0] ?? "");
  const qualities = [...new Set(presets.map((p) => p.quality))];
  const vq = pick(qualities, video.quality);
  const ratios = [
    ...new Set(presets.filter((p) => p.quality === vq).map((p) => p.ratio)),
  ];
  const vr = pick(ratios, video.ratio);
  const durations = [
    ...new Set(
      presets
        .filter((p) => p.quality === vq && p.ratio === vr)
        .map((p) => p.duration),
    ),
  ];
  const vd = pick(durations, video.duration);
  const videoOption = presets.find(
    (p) => p.quality === vq && p.ratio === vr && p.duration === vd,
  );
  const videoCredits = videoOption
    ? Math.ceil(
        videoOption.price * 1000 * (1 + (Number(config?.markup) || 0) / 100),
      )
    : null;
  const needsImage = !!(
    selected?.capabilities?.requires_image_url ||
    selected?.category === "image-to-video"
  );
  const acceptsImage = selected?.capabilities?.accepts_image_url !== false;
  useEffect(() => {
    controller.current?.abort();
    clearInterval(timer.current);
    setBusy(false);
    if (!visibleModels.some((m) => m.id === model))
      setModel(visibleModels[0]?.id || "");
    setError("");
    setReceipt(null);
    setQuote(null);
    setPrompt(location.state?.prompt || "");
    setWebSearch(!!location.state?.web);
    setAttachments([]);
    setCurrent(null);
    setMessages([]);
    setMenu(false);
    veilKeyRef.current = "tmp-" + uid();
    veilStateRef.current = loadVeilState(veilKeyRef.current);
    setVeilNote(null);
  }, [mode, demo]);
  useEffect(() => {
    if (demo && !saveStore("conversations", all))
      setInfo("Browser storage is full. Export your work before leaving.");
  }, [all, demo]);
  useEffect(() => {
    if (demo) saveStore("media", media);
  }, [media, demo]);
  useEffect(() => {
    saveVeilOn(veilOn);
  }, [veilOn]);
  useEffect(() => {
    saveVeilWords(veilWords);
  }, [veilWords]);
  useEffect(() => {
    if (!demo && !user) {
      setAll([]);
      setMedia([]);
      setMessages([]);
      setCurrent(null);
      setScrolls([]);
      setInstructions({ body: "", enabled: false });
    }
    if (!demo && user) {
      api("/api/conversations")
        .then((r) => setAll(r.data))
        .catch((e) => setError(e.message));
      api("/api/media")
        .then((r) => setMedia(r.data))
        .catch((e) => setError(e.message));
      // Scrolls and standing instructions are quiet failures: the composer
      // works the same as before either way. Skipped entirely while the
      // update is unreleased, so the client never calls its endpoints.
      if (scrollsLive) {
        api("/api/scrolls")
          .then((r) => setScrolls(r.data))
          .catch(() => {});
        api("/api/instructions")
          .then((r) => setInstructions(r))
          .catch(() => {});
      }
    }
  }, [demo, user, scrollsLive]);
  useEffect(
    () => () => {
      controller.current?.abort();
      clearInterval(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (!demo && user && mode === "video" && isReleased(config, "video")) {
      let seen = null;
      const poll = () =>
        api("/api/videos")
          .then((r) => {
            const done = r.data.filter((j) => j.status === "completed").length;
            if (seen !== null && done > seen) {
              api("/api/media")
                .then((m) => setMedia(m.data))
                .catch(() => {});
              refresh();
            }
            seen = done;
            setJobs(r.data);
          })
          .catch((e) => setError(e.message));
      poll();
      const id = setInterval(poll, 5000);
      return () => clearInterval(id);
    }
  }, [mode, demo, user]);
  useEffect(() => {
    const end = streamEnd.current;
    if (!end) return;
    // The sticky composer covers the bottom of the viewport, so reserve its
    // height below the newest message when scrolling it into view.
    end.style.scrollMarginBottom =
      (composerZone.current?.offsetHeight || 0) + "px";
    end.scrollIntoView({ block: "nearest" });
  }, [messages, busy]);
  // Load linked conversations after the destination section has reset its state.
  // Keyed on the user's id: the balance refresh after every reply replaces
  // the user object, and re-opening would blank the thread.
  const linked = params.get("c");
  useEffect(() => {
    if (!linked || !textMode) return;
    if (demo) {
      const saved = all.find((c) => c.id === linked);
      if (saved) openChat(saved);
    } else if (user) openChat({ id: linked, mode });
  }, [linked, user?.id, mode, demo]);
  // Shared conversations refresh while open so members see each other.
  useEffect(() => {
    if (!shared || !current || busy) return;
    const id = setInterval(
      () =>
        api("/api/conversations/" + current)
          .then((r) =>
            setMessages((prev) =>
              r.messages.length !== prev.length
                ? r.messages.map(messageFromServer)
                : prev,
            ),
          )
          .catch(() => {}),
      4000,
    );
    return () => clearInterval(id);
  }, [shared, current, busy]);
  function persist(next, id = current) {
    if (!demo) return;
    const key = id || uid();
    setCurrent(key);
    setAll((prev) => {
      const old = prev.find((c) => c.id === key);
      const row = {
        id: key,
        title:
          old?.title ||
          next.find((m) => m.role === "user")?.content?.slice(0, 40) ||
          "New conversation",
        mode,
        messages: next,
      };
      return [row, ...prev.filter((c) => c.id !== key)].slice(0, 300);
    });
  }
  function newChat() {
    if (linked) navigate("/workspace/" + mode + (demo ? "?demo=1" : ""));
    setShared(null);
    controller.current?.abort();
    clearInterval(timer.current);
    setBusy(false);
    setCurrent(null);
    setMessages([]);
    setPrompt("");
    setReceipt(null);
    setError("");
    veilKeyRef.current = "tmp-" + uid();
    veilStateRef.current = loadVeilState(veilKeyRef.current);
    setVeilNote(null);
  }
  // Off the record only ever applies to a fresh, unsaved thread: switching
  // it either way starts a new chat rather than mixing saved and unsaved turns.
  function toggleEphemeral() {
    newChat();
    setEphemeral((v) => !v);
  }
  // Private mode forces off the record on (private chats are never saved)
  // and Veil on, and narrows the model choice to private models — like Off
  // the record, switching it starts a fresh thread.
  function togglePrivateMode() {
    newChat();
    setPrivateMode((v) => {
      const next = !v;
      setEphemeral(next);
      if (next) {
        setVeilOn(true);
        setModel(privateModelsCallable[0]?.id || "");
      }
      return next;
    });
  }
  async function openChat(c) {
    if (mode !== c.mode) {
      navigate("/workspace/" + c.mode + "?" +
        new URLSearchParams({ ...(demo ? { demo: "1" } : {}), c: c.id }));
      return;
    }
    // Load this conversation's local veil map (if this browser has one) so
    // history unveils immediately; a conversation this browser has never
    // veiled in just gets an empty map, and tags show as-is.
    veilKeyRef.current = c.id;
    veilStateRef.current = loadVeilState(c.id);
    setVeilNote(null);
    setEphemeral(false);
    setCurrent(c.id);
    setMessages(c.messages || []);
    if (!demo) {
      try {
        const r = await api("/api/conversations/" + c.id);
        setCurrent(c.id);
        setShared(r.collab || null);
        setMessages(r.messages.map(messageFromServer));
      } catch (e) {
        setError(e.message);
      }
    }
    setMenu(false);
  }
  async function addFiles(e) {
    setError("");
    const files = [...e.target.files];
    if (files.length + attachments.length > 8) {
      setError("Choose up to 8 reference images.");
      e.target.value = "";
      return;
    }
    if (
      files.some(
        (f) =>
          !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
            f.type,
          ) || f.size > 1.5 * 1024 * 1024,
      )
    ) {
      setError("Use PNG, JPEG, WebP or GIF images up to 1.5 MiB each.");
      e.target.value = "";
      return;
    }
    const values = await Promise.all(
      files.map(
        (f) =>
          new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve({ name: f.name, url: reader.result });
            reader.readAsDataURL(f);
          }),
      ),
    );
    setAttachments((prev) => [...prev, ...values]);
    e.target.value = "";
  }
  // "@model-id your message" sends that one message to another chat model.
  const mentionQuery = textMode
    ? prompt.match(/^@([^\s]*)$/)?.[1]
    : undefined;
  const mentionMatches =
    mentionQuery === undefined
      ? []
      : visibleModels
          .filter((m) =>
            (m.id + " " + m.name).toLowerCase().includes(mentionQuery.toLowerCase()),
          )
          .slice(0, 6);
  const mention = textMode
    ? prompt.trim().match(/^@(\S+)\s+([\s\S]+)$/)
    : null;
  const mentioned = mention
    ? visibleModels.find((m) => m.id.toLowerCase() === mention[1].toLowerCase())
    : null;
  const target = mentioned || selected;
  // Typing "/" at the start of an empty prompt opens a scroll picker, filtered
  // by title, in chat, code and Uncensored. Users with no saved scrolls see
  // no change in behaviour.
  const slashQuery =
    textMode && scrollsLive && scrolls.length
      ? prompt.match(/^\/(\S*)$/)?.[1]
      : undefined;
  const scrollMatches =
    slashQuery === undefined || slashDismissedFor === slashQuery
      ? []
      : scrolls
          .filter((s) => s.title.toLowerCase().includes(slashQuery.toLowerCase()))
          .slice(0, 8);
  const scrollIndex = Math.min(slashIndex, Math.max(0, scrollMatches.length - 1));
  function pickScroll(scroll) {
    if (!scroll) return;
    setSlashDismissedFor(slashQuery);
    if (extractVariables(scroll.body).length) setScrollFill(scroll);
    else {
      setPrompt(scroll.body);
      promptBox.current?.focus();
    }
  }
  function insertScroll(text) {
    setPrompt(text);
    setScrollFill(null);
    promptBox.current?.focus();
  }
  async function createScroll(draft) {
    const r = await api("/api/scrolls", { method: "POST", body: draft });
    setScrolls((prev) => [r, ...prev]);
  }
  async function updateScroll(id, draft) {
    const r = await api("/api/scrolls/" + id, { method: "PATCH", body: draft });
    setScrolls((prev) => prev.map((s) => (s.id === id ? r : s)));
  }
  async function deleteScroll(id) {
    await api("/api/scrolls/" + id, { method: "DELETE" });
    setScrolls((prev) => prev.filter((s) => s.id !== id));
  }
  async function saveInstructions(payload) {
    const r = await api("/api/instructions", { method: "PUT", body: payload });
    setInstructions(r);
  }
  const instructionsActive =
    scrollsLive && instructions.enabled && !!instructions.body.trim();
  async function send(e) {
    e?.preventDefault();
    if (!prompt.trim() || busy) return;
    if (!demo) {
      if (!user) {
        setError(
          connected
            ? "Sign in to start generating, or open the demo."
            : "Sign in to generate when the account service is connected, or open the demo.",
        );
        return;
      }
      if (!target?.callable || !config?.services?.generation) {
        setError("This model is not currently available for generation.");
        return;
      }
      if (privateMode && !target?.private) {
        setError("Choose a private model, or turn off Private mode.");
        return;
      }
    }
    setError("");
    setInfo("");
    setReceipt(null);
    setVeilNote(null);
    setBusy(true);
    controller.current = new AbortController();
    const text = mentioned ? mention[2].trim() : prompt.trim();
    const requestModel = target?.id || model;
    const requestId = uid();
    if (mode === "image" || mode === "video") {
      try {
        if (demo) {
          if (mode === "video") {
            setJobs([
              {
                id: requestId,
                status: "processing",
                sample: true,
                request: { prompt: text },
              },
            ]);
            await new Promise((resolve, reject) => {
              const id = setTimeout(resolve, 1200);
              controller.current.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(id);
                  reject(new DOMException("Aborted", "AbortError"));
                },
                { once: true },
              );
            });
            setJobs([
              {
                id: requestId,
                status: "completed",
                sample: true,
                request: { prompt: text },
              },
            ]);
            const item = {
              id: requestId,
              kind: "video",
              url: "/media/anonyma-hero.mp4",
              prompt: text,
              model: "Prepared animation",
              sample: true,
              created: Date.now(),
            };
            setMedia((prev) => [item, ...prev]);
          } else {
            await new Promise((r) => setTimeout(r, 650));
            if (controller.current.signal.aborted) return;
            const targets = compareModels.length ? compareModels : [model];
            const additions = targets.flatMap((m, j) =>
              Array.from({ length: n }, (_, i) => ({
                id: uid(),
                kind: "image",
                url: "/media/sample-" + (((i + j) % 3) + 1) + ".svg",
                prompt: text,
                model: models.find((x) => x.id === m)?.name || m,
                sample: true,
                created: Date.now(),
              })),
            );
            setMedia((prev) => [...additions, ...prev]);
          }
          setInfo(
            "Prepared sample shown. Your prompt was not sent to an AI provider. No credits charged.",
          );
          setReceipt({ credits_charged: 0, sample: true });
        } else if (mode === "image") {
          const targets = compareModels.length ? compareModels : [model];
          const results = await Promise.allSettled(
            targets.map((m) =>
              api("/api/images", {
                method: "POST",
                body: {
                  model: m,
                  prompt: text,
                  n,
                  images: attachments.map((a) => a.url),
                  requestId: uid(),
                },
                signal: controller.current.signal,
              }),
            ),
          );
          const successes = results.filter((r) => r.status === "fulfilled");
          setMedia((prev) => [
            ...successes.flatMap((r) => r.value.data),
            ...prev,
          ]);
          const failures = results.filter((r) => r.status === "rejected");
          if (failures.length)
            setError(
              `${failures.length} model request(s) failed: ${failures.map((r) => r.reason.message).join("; ")}. Completed results are retained.`,
            );
          // Each compared model is a separate request with its own charge.
          const parts = results
            .map((r, i) =>
              r.status === "fulfilled"
                ? {
                    model:
                      models.find((x) => x.id === targets[i])?.name ||
                      targets[i],
                    credits: Number(r.value.receipt?.credits_charged) || 0,
                  }
                : null,
            )
            .filter(Boolean);
          if (parts.length)
            setReceipt({
              credits_charged:
                Math.round(parts.reduce((t, p) => t + p.credits, 0) * 10000) /
                10000,
              parts: parts.length > 1 ? parts : null,
              local_test: successes.some((r) => r.value.testMode),
            });
        } else {
          if (!videoOption)
            throw new Error(
              "This video model has no published price for these options.",
            );
          if (needsImage && !video.image.trim())
            throw new Error(
              "This video model needs a public HTTPS start image.",
            );
          const r = await api("/api/videos", {
            method: "POST",
            body: {
              model,
              prompt: text,
              ...(vq ? { quality: vq } : {}),
              ...(vr ? { ratio: vr } : {}),
              ...(vd ? { duration: vd } : {}),
              ...(video.image.trim() && acceptsImage
                ? { image_url: video.image.trim() }
                : {}),
              requestId,
            },
            signal: controller.current.signal,
          });
          setJobs((prev) => [r, ...prev]);
          setInfo(
            "Video submitted. Completion will be confirmed by the service.",
          );
        }
        setPrompt("");
      } catch (err) {
        setError(
          err.name === "AbortError"
            ? "Stopped waiting. Upstream work may still continue; check your library and receipts."
            : err.message,
        );
      } finally {
        setBusy(false);
        if (!demo) refresh();
      }
      return;
    }
    const rawNext = [
      ...messages,
      { role: "user", content: text, images: attachments.map((a) => a.url) },
    ];
    // Standing instructions (Scrolls) lead the request as a system message,
    // in one of the 20 context slots (see historyLimit). They are sent, never
    // saved: the server stores only the new user message and the reply.
    let standing = instructionsActive ? instructions.body.trim() : "";
    const history = historyLimit(standing);
    // Veil masks the new message and any earlier turns in this request's
    // context window before anything reaches the network. Detection and
    // tagging happen only in this browser; see src/veil.js.
    let next = rawNext,
      veiledPayload = null,
      // Veil's mask count for this request, carried onto the reply so a
      // private-mode reply can show "<N> details masked" (see
      // PrivateReplyNote); stays 0 when Veil is off or finds nothing.
      requestMasked = 0;
    if (veilOn && !demo && isReleased(config, "veil")) {
      let veiledCount = 0;
      const tags = new Set();
      // Standing instructions are masked too, with this conversation's tag
      // map, so a detail saved in them never leaves the browser and a reply
      // that repeats its tag is restored on screen like any other.
      if (standing) {
        const r = veil(standing, veilStateRef.current, veilWords);
        veiledCount += r.count;
        r.tags.forEach((t) => tags.add(t));
        standing = r.text;
      }
      veiledPayload = rawNext.slice(-history).map((m) => {
        const r = veil(m.content || "", veilStateRef.current, veilWords);
        veiledCount += r.count;
        r.tags.forEach((t) => tags.add(t));
        return { ...m, content: r.text };
      });
      requestMasked = veiledCount;
      saveVeilState(veilKeyRef.current, veilStateRef.current);
      if (veiledCount)
        setVeilNote({
          count: veiledCount,
          entries: [...tags].map((tag) => ({ tag, value: veilStateRef.current.map[tag] })),
        });
      // Display the just-sent message the same way the server saw it.
      next = [...messages, veiledPayload[veiledPayload.length - 1]];
    }
    setPrompt("");
    setAttachments([]);
    setMessages([...next, { role: "assistant", content: "", sample: demo }]);
    if (demo) {
      const answer = mode === "code" ? sampleCode : sampleChat;
      let index = 0;
      timer.current = setInterval(() => {
        index += 28;
        const now = [
          ...next,
          { role: "assistant", content: answer.slice(0, index), sample: true },
        ];
        setMessages(now);
        if (index >= answer.length) {
          clearInterval(timer.current);
          setBusy(false);
          persist(now);
          setReceipt({ credits_charged: 0, sample: true });
        }
      }, 25);
      return;
    }
    let output = "",
      liveId = current,
      reasoning = "",
      images = [],
      citations = [],
      // Set once the final event's anonyma.private arrives; drives the
      // "Sent to <provider> · not saved" line under this reply.
      privateInfo = null;
    const sendingPrivate = privateMode && !demo;
    try {
      await streamChat(
        {
          model: requestModel,
          messages: withStanding(
            standing,
            (veiledPayload || next.slice(-history)).map(toRequestMessage),
          ),
          ...(ephemeral ? { ephemeral: true } : { conversationId: current }),
          mode,
          max_tokens: 4096,
          requestId,
          ...(webSearch ? { web_search: true } : {}),
          ...(sendingPrivate ? { private: true } : {}),
        },
        (event) => {
          if (event.error)
            throw new Error(
              event.error.message || "The stream ended with an error.",
            );
          if (event.conversationId) liveId = event.conversationId;
          output += event.choices?.[0]?.delta?.content || "";
          reasoning +=
            event.choices?.[0]?.delta?.reasoning_content ||
            event.choices?.[0]?.delta?.reasoning ||
            "";
          for (const img of event.choices?.[0]?.delta?.images || []) {
            const url = img?.image_url?.url || img?.url;
            if (url) images = [...images, url];
          }
          if (event.anonyma) setReceipt(event.anonyma);
          if (event.anonyma?.citations) citations = event.anonyma.citations;
          if (event.anonyma?.private) privateInfo = event.anonyma.private;
          setMessages([
            ...next,
            {
              role: "assistant",
              content: output,
              reasoning,
              images,
              citations,
              model: requestModel,
              ...(privateInfo
                ? { private: privateInfo, masked: requestMasked }
                : {}),
            },
          ]);
        },
        controller.current.signal,
      );
      setCurrent(liveId);
      // The conversation just got its real id: move its veil map off the
      // temporary key so it's found again next time this browser opens it.
      if (veilOn && liveId && liveId !== veilKeyRef.current) {
        moveVeilState(veilKeyRef.current, liveId);
        veilKeyRef.current = liveId;
      }
    } catch (err) {
      setError(
        err.name === "AbortError"
          ? "Stopped. Partial billing may apply; refresh receipts before retrying."
          : err.message,
      );
    } finally {
      setBusy(false);
      refresh();
      api("/api/conversations")
        .then((r) => setAll(r.data))
        .catch(() => {});
    }
  }
  function stop() {
    clearInterval(timer.current);
    controller.current?.abort();
    setBusy(false);
    if (demo) {
      persist(messages);
      setInfo("Sample stopped. No credits were charged.");
    }
  }
  async function quoteRequest() {
    setError("");
    if (demo) {
      setQuote({ credits: 0, sample: true });
      return;
    }
    try {
      const r = await api("/api/quote", {
        method: "POST",
        body: {
          model,
          messages: [...messages, { role: "user", content: prompt }],
          max_tokens: 4096,
          ...(webSearch ? { web_search: true } : {}),
        },
      });
      setQuote(r);
    } catch (e) {
      setError(e.message);
    }
  }
  async function confirmDialog() {
    try {
      if (dialog.type === "rename") {
        if (!rename.trim()) return;
        if (!demo)
          await api("/api/conversations/" + dialog.item.id, {
            method: "PATCH",
            body: { title: rename.trim() },
          });
        setAll((prev) =>
          prev.map((c) =>
            c.id === dialog.item.id ? { ...c, title: rename.trim() } : c,
          ),
        );
      } else if (dialog.type === "delete") {
        if (!demo)
          await api("/api/conversations/" + dialog.item.id, {
            method: "DELETE",
          });
        setAll((prev) => prev.filter((c) => c.id !== dialog.item.id));
        if (current === dialog.item.id) newChat();
      } else if (dialog.type === "media") {
        if (!demo)
          await api("/api/media/" + dialog.item.id, { method: "DELETE" });
        setMedia((prev) => prev.filter((m) => m.id !== dialog.item.id));
      }
      setDialog(null);
    } catch (e) {
      setError(e.message);
    }
  }
  // Owner only; for a collab conversation, the server further requires the
  // collab owner (a member who merely started the thread gets a 403 here).
  async function updateRetention(days) {
    const expires = days ? Date.now() + days * 86400000 : null;
    try {
      await api("/api/conversations/" + dialog.item.id, {
        method: "PATCH",
        body: { retention: days },
      });
      setAll((prev) =>
        prev.map((c) => (c.id === dialog.item.id ? { ...c, expires } : c)),
      );
      setDialog((d) => (d ? { ...d, item: { ...d.item, expires } } : d));
    } catch (e) {
      setError(e.message);
    }
  }
  const files = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) =>
      [...m.content.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((match, i) => ({
        name:
          match[1] === "jsx"
            ? "IdeaCard.jsx"
            : match[1] === "css"
              ? "idea-card.css"
              : `file-${i + 1}.${match[1] || "txt"}`,
        content: match[2],
      })),
    );
  const hasResults =
    (mode === "image" || mode === "video") &&
    (jobs.some((j) => j.status !== "completed") ||
      media.some((m) => m.kind === mode));
  async function exportZip() {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    files.forEach((f) => zip.file(f.name, f.content));
    download(
      "anonyma-code.zip",
      await zip.generateAsync({ type: "uint8array" }),
      "application/zip",
    );
  }
  if (!validMode)
    return (
      <main id="main">
        <Empty
          title="Workflow not found"
          action={<Button to="/workspace/chat">Open chat</Button>}
        >
          Choose a supported workspace.
        </Empty>
      </main>
    );
  return (
    <main id="main" className="app-shell">
      <AppSidebar
        active={mode}
        demo={demo}
        open={menu}
        onClose={() => setMenu(false)}
      >
        <button className="new-conversation" onClick={newChat}>
          <Icon name="plus" size={17} />
          New conversation
        </button>
        <div className="sidebar-group-label">RECENT CONVERSATIONS</div>
        <div className="conversation-list">
          {(demo ? all : user ? all : []).slice(0, 12).map((c) => (
            <div className={c.id === current ? "current" : ""} key={c.id}>
              <button data-i18n="off" onClick={() => openChat(c)}>{c.title}</button>
              {!demo && isReleased(config, "ephemeral") && (
                <RetentionIndicator expires={c.expires} />
              )}
              <button
                className="conversation-options"
                aria-label={"Options for " + c.title}
                onClick={() => {
                  setRename(c.title);
                  setRetentionDays(retentionChoiceFor(c.expires));
                  setDialog({ type: "rename", item: c });
                }}
              >
                ···
              </button>
            </div>
          ))}
        </div>
      </AppSidebar>
      {menu && (
        <button
          className="sidebar-scrim"
          aria-label="Close menu"
          onClick={() => setMenu(false)}
        />
      )}
      <div className="workspace-main">
        <header className="workspace-header">
          <button
            className="icon-button mobile-only"
            aria-label="Open workspace menu"
            onClick={() => setMenu(true)}
          >
            <Icon name="menu" />
          </button>
          <span>
            {
              {
                home: "Home",
                chat: "Chat & reason",
                uncensored: "Uncensored",
                code: "Code & build",
                image: "Image studio",
                video: "Video studio",
                audio: "Voice studio",
                collab: "Collab",
                library: "Your library",
              }[mode]
            }
            <span className="workspace-slash">/</span>
            <small>{demo ? "Demo workspace" : "Personal workspace"}</small>
          </span>
          <div>
            <Link
              to={"/account/credits" + (demo ? "?demo=1" : "")}
              className="balance-chip"
            >
              <Icon name="credits" size={15} />
              {demo ? (
                <>
                  <b>1,000</b> available · 0 held
                </>
              ) : user ? (
                <>
                  <b>{Number(user.available || 0).toLocaleString()}</b>{" "}
                  available · {Number(user.held || 0).toLocaleString()} held
                </>
              ) : (
                "Credits"
              )}
            </Link>
            <Link
              to={"/account/credits" + (demo ? "?demo=1" : "")}
              className="header-add-credits"
            >
              Add credits
            </Link>
            <Link to="/" className="icon-button" aria-label="Back to website">
              <Icon name="diagonal" size={17} />
            </Link>
          </div>
        </header>
        <div className="workspace-notice">
          <span className={"dot " + (demo ? "demo-dot" : "")} />
          {demo
            ? "Interactive demo · Prepared examples · Saved in this browser"
            : connected
              ? config?.testMode
                ? "Local test mode · Fixture balance · No real provider, payment or email"
                : "Connected account service"
              : "Service unavailable · Account and generation could not be reached"}
          {!demo && (
            <Link to={"/workspace/" + mode + "?demo=1"}>
              Try the demo <Icon name="arrow" size={13} />
            </Link>
          )}
        </div>
        <div
          key={mode}
          className={
            "workspace-body " +
            (!messages.length ? "workspace-start " : "") +
            (mode === "home" ? "workspace-home " : "") +
            (hasResults ? "with-results " : "") +
            (mode === "code" && files.length ? "with-code" : "")
          }
        >
          {!modeReleased(config, mode) ? (
            <ComingSoon update={releaseUpdate(config, MODE_FEATURES[mode])} />
          ) : mode === "home" ? (
            <WorkspaceHome
              demo={demo}
              user={user}
              models={models}
              conversations={all}
              media={media}
              onOpen={openChat}
            />
          ) : mode === "library" ? (
            <div className="library-page">
              <div className="page-heading-inline">
                <div>
                  <p className="eyebrow">YOURS TO COME BACK TO</p>
                  <h1>Your library.</h1>
                </div>
                <Button to={"/workspace/image" + (demo ? "?demo=1" : "")}>
                  Create something <Icon name="plus" />
                </Button>
              </div>
              <div className="filter-tabs">
                {["all", "image", "video", "audio"].map((f) => (
                  <button
                    aria-pressed={f === filter}
                    className={f === filter ? "active" : ""}
                    key={f}
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
              <MediaGrid
                media={media.filter(
                  (m) => filter === "all" || m.kind === filter,
                )}
                onDelete={(item) => setDialog({ type: "media", item })}
              />
              {!media.length && (
                <Empty
                  icon="image"
                  title="A little empty. Full of possibility."
                >
                  Your completed images, videos and audio will appear here.
                </Empty>
              )}
            </div>
          ) : mode === "collab" ? (
            <CollabHub demo={demo} user={user} />
          ) : mode === "audio" ? (
            <AudioStudio
              demo={demo}
              user={user}
              config={config}
              media={media}
              setMedia={setMedia}
              refresh={refresh}
              onDelete={(item) => setDialog({ type: "media", item })}
              Grid={MediaGrid}
            />
          ) : (
            <>
              <div className="chat-area">
                {shared && textMode && (
                  <div className="collab-banner">
                    <Icon name="users" size={16} />
                    Shared in <b data-i18n="off">{shared.name}</b> · members see this
                    conversation; each pays for their own requests.
                    <Link to="/workspace/collab">Open collab</Link>
                  </div>
                )}
                {messages.length && textMode ? (
                  <div className="messages">
                    {messages.map((m, i) => (
                      <article
                        key={i}
                        className={
                          "message " +
                          m.role +
                          (busy &&
                          i === messages.length - 1 &&
                          m.role === "assistant"
                            ? " streaming"
                            : "")
                        }
                      >
                        <div className="message-avatar">
                          {m.role === "user" ? (
                            m.author && m.author !== user?.username ? (
                              m.author[0].toUpperCase()
                            ) : (
                              "Y"
                            )
                          ) : (
                            <Mark />
                          )}
                        </div>
                        <div>
                          <div className="message-label">
                            {m.role === "user"
                              ? m.author && m.author !== user?.username
                                ? m.author
                                : "You"
                              : "ANONYMA"}
                            {m.sample && <span>PREPARED EXAMPLE</span>}
                            {m.role === "assistant" && m.model && !m.sample && (
                              <span className="model-tag">
                                {models.find((x) => x.id === m.model)?.name || m.model}
                              </span>
                            )}
                          </div>
                          <div className="markdown" data-i18n={m.content ? "off" : undefined}>
                            <ReactMarkdown
                              remarkPlugins={[
                                remarkGfm,
                                // Re-runs on every render (incl. mid-stream) so a
                                // [TAG_n] split across chunks resolves once whole.
                                [veilRemarkPlugin, { map: veilStateRef.current.map }],
                              ]}
                            >
                              {m.content || "Preparing…"}
                            </ReactMarkdown>
                            {m.images?.map((url, j) => (
                              <img
                                className="message-image"
                                src={url}
                                alt={
                                  m.role === "user"
                                    ? "Your reference"
                                    : "Generated image"
                                }
                                key={j}
                              />
                            ))}
                          </div>
                          {m.citations?.length > 0 && (
                            <div className="citations">
                              <span>Sources</span>
                              {m.citations.map((c) => (
                                <a
                                  key={c.url}
                                  data-i18n="off"
                                  href={c.url}
                                  target="_blank"
                                  rel="noopener noreferrer nofollow"
                                >
                                  {c.title ||
                                    c.url
                                      .replace(/^https?:\/\//, "")
                                      .split("/")[0]}
                                </a>
                              ))}
                            </div>
                          )}
                          {m.reasoning && (
                            <details>
                              <summary>Reasoning</summary>
                              <p data-i18n="off">{m.reasoning}</p>
                            </details>
                          )}
                          {m.role === "assistant" && m.private && (
                            <PrivateReplyNote info={m.private} masked={m.masked} />
                          )}
                          {m.role === "assistant" && m.content && (
                            <CopyButton text={m.content} />
                          )}
                        </div>
                      </article>
                    ))}
                    <div ref={streamEnd} />
                  </div>
                ) : (
                  <div className="workspace-welcome" ref={welcomeRef}>
                    <AsciiField sectionRef={welcomeRef} />
                    <BandLines />
                    <p className="eyebrow">
                      {
                        {
                          chat: "CHAT & REASON",
                          uncensored: "UNCENSORED MODELS",
                          code: "CODE & BUILD",
                          image: "IMAGE STUDIO",
                          video: "VIDEO STUDIO",
                        }[mode]
                      }
                    </p>
                    <Reveal key={mode}>
                      <h1>
                        {
                          {
                            chat: <>What’s on your mind?</>,
                            uncensored: <>Uncensored models.</>,
                            code: <>What will you build?</>,
                            image: <>Create something worth seeing.</>,
                            video: <>Set your ideas in motion.</>,
                          }[mode]
                        }
                      </h1>
                    </Reveal>
                    <p>
                      {
                        {
                          chat: "Choose a model. Start a conversation. Keep your best ideas together.",
                          uncensored:
                            "Models their providers explicitly label uncensored. Choose one below; each message is billed per token from your prepaid balance.",
                          code: "Turn a thought into code you can make your own.",
                          image:
                            "A fresh perspective, a new direction, a world of your own.",
                          video: "From the first frame to a new possibility.",
                        }[mode]
                      }
                    </p>
                    <BandSteps />
                  </div>
                )}
                {(mode === "image" || mode === "video") && (
                  <div className="generation-results">
                    {jobs
                      .filter((j) => j.status !== "completed")
                      .map((j) => (
                        <Notice key={j.id}>
                          {j.sample ? "Sample job" : "Video job"}: {j.status}
                          {j.error && " · " + j.error}
                          {j.status === "reconciliation" &&
                            " · Operator review required. Do not resubmit."}
                        </Notice>
                      ))}
                    <MediaGrid
                      media={media.filter((m) => m.kind === mode).slice(0, 8)}
                      onDelete={(item) => setDialog({ type: "media", item })}
                    />
                  </div>
                )}
              </div>
              <div className="composer-zone" ref={composerZone}>
                {isReleased(config, "ephemeral") &&
                  ephemeral &&
                  !privateMode &&
                  textMode && <EphemeralNotice />}
                {!demo &&
                  privateModeReleased(config) &&
                  privateMode &&
                  textMode &&
                  (privateModelsCallable.length ? (
                    <PrivateModeNotice />
                  ) : (
                    <NoPrivateModelsNotice />
                  ))}
                {info && <Notice>{info}</Notice>}
                {error && <Notice type="error">{error}</Notice>}
                {receipt && (
                  <div className="receipt">
                    <span className="sq" aria-hidden="true" />
                    {receipt.sample
                      ? "Sample receipt · 0 credits charged"
                      : `${receipt.local_test ? "Test receipt" : "Receipt"} · ${receipt.credits_charged ?? "Unconfirmed"} ${receipt.local_test ? "fixture " : ""}credits charged`}
                    {receipt.parts?.map((p) => (
                      <span className="receipt-part" key={p.model}>
                        {p.model} {p.credits}
                      </span>
                    ))}
                    {receipt.request_id && (
                      <span className="receipt-part">
                        Request {String(receipt.request_id).slice(0, 12)}
                      </span>
                    )}
                  </div>
                )}
                {quote && (
                  <div className="receipt">
                    {quote.sample
                      ? "Demo estimate · no paid request"
                      : `Estimated reservation: ${quote.credits} credits`}
                  </div>
                )}
                <form className="composer" onSubmit={send}>
                  {attachments.length > 0 && (
                    <div className="attachment-list">
                      {attachments.map((a, i) => (
                        <span key={i}>
                          <img src={a.url} alt={a.name} />
                          <button
                            type="button"
                            aria-label={"Remove " + a.name}
                            onClick={() =>
                              setAttachments((p) => p.filter((_, j) => j !== i))
                            }
                          >
                            <Icon name="close" size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={promptBox}
                    aria-label="Your prompt"
                    placeholder={
                      mode === "image"
                        ? "Describe what you imagine…"
                        : mode === "video"
                          ? "Describe your scene…"
                          : "Give your idea a place to begin…"
                    }
                    value={prompt}
                    maxLength={mode === "video" ? 2000 : 48000}
                    onChange={(e) => {
                      setPrompt(e.target.value);
                      setSlashIndex(0);
                    }}
                    onKeyDown={(e) => {
                      if (scrollMatches.length) {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setSlashDismissedFor(slashQuery);
                          return;
                        }
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setSlashIndex((i) => (i + 1) % scrollMatches.length);
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setSlashIndex(
                            (i) => (i - 1 + scrollMatches.length) % scrollMatches.length,
                          );
                          return;
                        }
                        if (e.key === "Enter" || e.key === "Tab") {
                          e.preventDefault();
                          pickScroll(scrollMatches[scrollIndex]);
                          return;
                        }
                      }
                      if (
                        (e.key === "Enter" || e.key === "Tab") &&
                        mentionMatches.length
                      ) {
                        e.preventDefault();
                        setPrompt("@" + mentionMatches[0].id + " ");
                        return;
                      }
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        textMode
                      ) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    rows="3"
                  />
                  {mentionMatches.length > 0 && (
                    <div className="mention-menu" role="listbox" aria-label="Send to model">
                      {mentionMatches.map((m) => (
                        <button
                          type="button"
                          role="option"
                          key={m.id}
                          // Keep typing in the prompt: the menu closes once a model is picked.
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setPrompt("@" + m.id + " ");
                            promptBox.current?.focus();
                          }}
                        >
                          <b>{m.name}</b>
                          {!demo && m.private && <PrivateModelTag />}
                          <span>@{m.id}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {scrollMatches.length > 0 && (
                    <div className="scroll-menu" role="listbox" aria-label="Insert a scroll">
                      {scrollMatches.map((s, i) => {
                        const vars = extractVariables(s.body);
                        return (
                          <button
                            type="button"
                            role="option"
                            aria-selected={i === scrollIndex}
                            className={i === scrollIndex ? "active" : ""}
                            key={s.id}
                            // Keep typing in the prompt: the menu closes once a scroll is picked.
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => pickScroll(s)}
                          >
                            <b data-i18n="off">{s.title}</b>
                            <span>
                              {vars.length
                                ? `${vars.length} variable${vars.length > 1 ? "s" : ""}`
                                : "Insert"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {mentioned && (
                    <p className="mention-hint">
                      This message goes to <b>{mentioned.name}</b>.
                    </p>
                  )}
                  <div className="composer-controls">
                    <div>
                      <select
                        aria-label="Select model"
                        value={model}
                        onChange={(e) => {
                          setModel(e.target.value);
                          setQuote(null);
                        }}
                      >
                        {(() => {
                          const option = (m) => (
                            <option value={m.id} key={m.id}>
                              {m.name}
                              {!demo && m.private ? " · Private" : ""}
                              {!m.callable && !demo ? " · catalog only" : ""}
                            </option>
                          );
                          const popular = visibleModels.filter(
                            (m) => m.popular,
                          );
                          // Long live catalogs read better with popular models grouped first.
                          return visibleModels.length > 12 && popular.length ? (
                            <>
                              <optgroup label="Popular">
                                {popular.map(option)}
                              </optgroup>
                              <optgroup
                                label={`All models (${visibleModels.length})`}
                              >
                                {visibleModels
                                  .filter((m) => !m.popular)
                                  .map(option)}
                              </optgroup>
                            </>
                          ) : (
                            visibleModels.map(option)
                          );
                        })()}
                      </select>
                      {(mode === "image" || selected?.vision) && (
                        <label
                          className="attachment-control"
                          title="Add reference image"
                        >
                          <Icon name="plus" size={18} />
                          <span className="sr-only">Add reference images</span>
                          <input
                            type="file"
                            multiple
                            accept="image/png,image/jpeg,image/webp,image/gif"
                            onChange={addFiles}
                          />
                        </label>
                      )}
                      {["chat", "code"].includes(mode) &&
                        isReleased(config, "search") && (
                        <button
                          type="button"
                          className={
                            "attachment-control web-toggle" +
                            (webSearch ? " on" : "")
                          }
                          aria-pressed={webSearch}
                          title="Search the web before answering (about 21 credits per search)"
                          onClick={() => setWebSearch((v) => !v)}
                        >
                          <Icon name="globe" size={17} />
                          <span>Web</span>
                        </button>
                      )}
                      {!demo &&
                        isReleased(config, "ephemeral") &&
                        textMode && (
                        <EphemeralToggle
                          active={ephemeral}
                          onToggle={toggleEphemeral}
                          disabled={privateMode}
                        />
                      )}
                      {!demo &&
                        privateModeReleased(config) &&
                        textMode && (
                        <PrivateModeToggle
                          active={privateMode}
                          onToggle={togglePrivateMode}
                        />
                      )}
                      {textMode &&
                        !demo &&
                        isReleased(config, "veil") && (
                        <VeilToggle on={veilOn} onToggle={() => setVeilOn((v) => !v)} />
                      )}
                      {["chat", "code"].includes(mode) &&
                        isReleased(config, "audio") && (
                        <MicButton
                          demo={demo}
                          disabled={busy}
                          onText={(t) =>
                            setPrompt((p) =>
                              p.trim() ? p.trimEnd() + " " + t : t,
                            )
                          }
                          onError={setError}
                        />
                      )}
                      {textMode && scrollsLive && (
                        <button
                          type="button"
                          className="attachment-control scrolls-button"
                          title={
                            instructionsActive
                              ? "Scrolls · standing instructions active"
                              : "Scrolls: saved prompts and standing instructions"
                          }
                          onClick={() => setScrollsPanel(true)}
                        >
                          <Icon name="book" size={17} />
                          <span>Scrolls</span>
                          {instructionsActive && (
                            <span className="instructions-dot" aria-hidden="true" />
                          )}
                        </button>
                      )}
                      {mode === "image" && (
                        <select
                          aria-label="Number of images"
                          value={n}
                          onChange={(e) => setN(Number(e.target.value))}
                        >
                          {[1, 2, 3, 4].map((x) => (
                            <option key={x} value={x}>
                              {x} image{x > 1 ? "s" : ""}
                            </option>
                          ))}
                        </select>
                      )}
                      {mode === "video" && presets.length > 0 && (
                        <>
                          {qualities.some(Boolean) && (
                            <select
                              aria-label="Video quality"
                              value={vq}
                              onChange={(e) =>
                                setVideo((v) => ({
                                  ...v,
                                  quality: e.target.value,
                                }))
                              }
                            >
                              {qualities.map((q) => (
                                <option key={q} value={q}>
                                  {q
                                    ? q[0].toUpperCase() + q.slice(1)
                                    : "Default quality"}
                                </option>
                              ))}
                            </select>
                          )}
                          <select
                            aria-label="Aspect ratio"
                            value={vr}
                            onChange={(e) =>
                              setVideo((v) => ({ ...v, ratio: e.target.value }))
                            }
                          >
                            {ratios.map((r) => (
                              <option key={r} value={r}>
                                {r || "Default ratio"}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label="Duration"
                            value={vd}
                            onChange={(e) =>
                              setVideo((v) => ({
                                ...v,
                                duration: e.target.value,
                              }))
                            }
                          >
                            {durations.map((d) => (
                              <option key={d} value={d}>
                                {d ? d + " seconds" : "Default length"}
                              </option>
                            ))}
                          </select>
                        </>
                      )}
                    </div>
                    {busy ? (
                      <button
                        type="button"
                        className="send-button"
                        aria-label="Stop generation"
                        onClick={stop}
                      >
                        <Icon name="stop" size={17} />
                      </button>
                    ) : (
                      <button
                        type="submit"
                        className="send-button"
                        disabled={
                          !prompt.trim() ||
                          (privateMode && !privateModelsCallable.length)
                        }
                        aria-label={demo ? "Run sample" : "Generate"}
                      >
                        <Icon name="arrow" size={21} />
                      </button>
                    )}
                  </div>
                  {mode === "image" && (
                    <details className="compare-options">
                      <summary>Compare image models (up to 4)</summary>
                      {visibleModels.map((m) => (
                        <label key={m.id}>
                          <input
                            type="checkbox"
                            checked={compareModels.includes(m.id)}
                            disabled={
                              !compareModels.includes(m.id) &&
                              compareModels.length >= 4
                            }
                            onChange={() =>
                              setCompareModels((p) =>
                                p.includes(m.id)
                                  ? p.filter((x) => x !== m.id)
                                  : [...p, m.id],
                              )
                            }
                          />
                          {m.name}
                        </label>
                      ))}
                    </details>
                  )}
                </form>
                {!messages.length && (
                  <div className="prompt-suggestions">
                    {(mode === "chat"
                      ? [
                          "Help me think through an idea",
                          "Make a complex topic simple",
                          "Find a fresh perspective",
                        ]
                      : mode === "uncensored"
                        ? [
                            "Write a gritty short story opening",
                            "Argue the other side of a debate",
                            "Play a character in a scene",
                          ]
                      : mode === "code"
                        ? [
                            "Build a simple idea card",
                            "Explain a piece of code",
                            "Plan a small React app",
                          ]
                        : mode === "image"
                          ? [
                              "A quiet architectural study",
                              "A playful geometric world",
                              "A soft, abstract landscape",
                            ]
                          : [
                              "A gentle abstract motion loop",
                              "A product idea in motion",
                              "A cinematic opening frame",
                            ]
                    ).map((t) => (
                      <button key={t} onClick={() => setPrompt(t)}>
                        {t}
                        <Icon name="diagonal" size={14} />
                      </button>
                    ))}
                  </div>
                )}
                <div className="composer-caption">
                  <span>
                    {demo
                      ? "Sample outputs are illustrative. No provider request or charge."
                      : "AI can make mistakes. Check important information."}
                  </span>
                  {textMode &&
                    !demo &&
                    isReleased(config, "veil") && (
                    <VeilPanel note={veilNote} words={veilWords} onWordsChange={setVeilWords} />
                  )}
                  {textMode && (
                    <button
                      onClick={quoteRequest}
                      disabled={!prompt.trim() || busy}
                    >
                      Estimate credits
                    </button>
                  )}
                </div>
                {mode === "video" && !demo && selected && acceptsImage && (
                  <label className="video-image-field">
                    Start image URL
                    {needsImage ? " (required for this model)" : " (optional)"}
                    <input
                      type="url"
                      inputMode="url"
                      placeholder="https://…"
                      value={video.image}
                      onChange={(e) =>
                        setVideo((v) => ({ ...v, image: e.target.value }))
                      }
                    />
                  </label>
                )}
                {mode === "video" && (
                  <p className="fine-print">
                    {demo
                      ? "Demo preview uses the prepared ANONYMA animation."
                      : videoCredits != null
                        ? `About ${videoCredits.toLocaleString()} credits are held until the job completes. Options come from this model's published prices.`
                        : "Choose a video model with a published price."}
                  </p>
                )}
              </div>
            </>
          )}
          {mode === "code" && files.length > 0 && (
            <aside className="code-panel">
              <div>
                <h3>Files & revisions</h3>
                <button className="small-button" onClick={exportZip}>
                  <Icon name="download" size={14} />
                  ZIP
                </button>
              </div>
              <p className="fine-print">Prepared code · no execution sandbox</p>
              {files.map((f, i) => (
                <details key={i} open={i === 0}>
                  <summary>
                    <Icon name="file" size={14} />
                    {f.name}
                    <span>v{Math.floor(i / 2) + 1}</span>
                  </summary>
                  <pre>
                    <code>{f.content}</code>
                  </pre>
                  <div className="inline-actions">
                    <CopyButton text={f.content} />
                    <button
                      className="small-button"
                      onClick={() => download(f.name, f.content, "text/plain")}
                    >
                      Download
                    </button>
                  </div>
                </details>
              ))}
            </aside>
          )}
        </div>
      </div>
      {dialog && (
        <Modal
          title={
            dialog.type === "rename"
              ? "Conversation details"
              : dialog.type === "media"
                ? "Delete this creation?"
                : "Delete this conversation?"
          }
          onClose={() => setDialog(null)}
        >
          {dialog.type === "rename" ? (
            <>
              <label>
                Conversation name
                <input
                  value={rename}
                  onChange={(e) => setRename(e.target.value)}
                  maxLength="100"
                  autoFocus
                />
              </label>
              {!demo && isReleased(config, "ephemeral") && (
                <div className="retention-row">
                  <RetentionSelect
                    value={retentionDays}
                    onChange={(days) => {
                      setRetentionDays(days);
                      updateRetention(days);
                    }}
                  />
                  <RetentionIndicator expires={dialog.item.expires} />
                </div>
              )}
              <div className="inline-actions">
                <Button onClick={confirmDialog} disabled={!rename.trim()}>
                  Save name
                </Button>
                <button
                  className="small-button"
                  onClick={() =>
                    download(
                      "conversation.json",
                      JSON.stringify(dialog.item, null, 2),
                    )
                  }
                >
                  <Icon name="download" size={14} />
                  Export
                </button>
                <button
                  className="small-button danger-text"
                  onClick={() => setDialog({ ...dialog, type: "delete" })}
                >
                  <Icon name="delete" size={14} />
                  Delete
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                {demo
                  ? "This removes the sample from this browser."
                  : "This removes the item from your account."}
              </p>
              <div className="inline-actions">
                <Button onClick={confirmDialog}>Delete</Button>
                <Button secondary onClick={() => setDialog(null)}>
                  Keep it
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}
      {scrollsPanel && (
        <ScrollsPanel
          scrolls={scrolls}
          instructions={instructions}
          currentPrompt={prompt}
          onClose={() => setScrollsPanel(false)}
          onCreate={createScroll}
          onUpdate={updateScroll}
          onDelete={deleteScroll}
          onSaveInstructions={saveInstructions}
        />
      )}
      {scrollFill && (
        <ScrollFillForm
          scroll={scrollFill}
          onInsert={insertScroll}
          onCancel={() => setScrollFill(null)}
        />
      )}
    </main>
  );
}
function MediaGrid({ media, onDelete }) {
  return (
    <div className="media-grid">
      {media.map((m) => (
        <article key={m.id}>
          {m.kind === "audio" ? (
            <div className="audio-card">
              <Icon name="audio" size={28} />
              <audio controls preload="metadata" src={m.url} />
            </div>
          ) : m.kind === "video" ? (
            <video
              controls
              playsInline
              preload="metadata"
              src={m.url}
              poster={m.sample ? "/media/anonyma-hero-poster.jpg" : undefined}
            />
          ) : (
            <img
              src={m.url}
              alt={
                m.sample
                  ? "Prepared geometric illustration — sample, not generated from prompt"
                  : m.prompt
              }
            />
          )}
          <div>
            <span className="eyebrow">
              {m.sample ? "PREPARED SAMPLE" : m.model}
            </span>
            <h3 data-i18n="off">{m.prompt}</h3>
            <p>
              {m.model}
              {m.cost != null ? " · " + m.cost + " credits" : ""}
            </p>
            <div className="inline-actions">
              <a className="small-button" href={m.url} download>
                <Icon name="download" size={14} />
                Download
              </a>
              <button
                className="small-button"
                onClick={() => onDelete(m)}
                aria-label={"Delete " + m.prompt}
              >
                <Icon name="delete" size={14} />
              </button>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
