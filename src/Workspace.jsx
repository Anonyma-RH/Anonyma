import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { readChatEvents } from "./stream";
import { videoPresets } from "../data/video-presets.js";
import {
  MessageSquare,
  Code2,
  Image,
  Video,
  Plus,
  ArrowUp,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Search,
  X,
  Paperclip,
  Square,
  Copy,
  Download,
  Trash2,
  PanelLeft,
  PanelRight,
  History,
  FolderOpen,
  SlidersHorizontal,
  Check,
  RefreshCw,
  Wallet,
  LoaderCircle,
  ExternalLink,
  FileCode,
  Expand,
  Pencil,
} from "lucide-react";
import {
  api,
  useApp,
  Button,
  ErrorBox,
  Modal,
  CopyButton,
  ProviderIcon,
  fmt,
  date,
  download,
  Empty,
  generationPrice,
} from "./lib";
const modes = [
  ["chat", MessageSquare, "Ask", "Think, plan and explore."],
  ["code", Code2, "Code", "Build, debug and explain."],
  ["image", Image, "Images", "Create and refine visuals."],
  ["video", Video, "Video", "Direct your next clip."],
];
const modeLabel = {
  chat: "Ask",
  code: "Code",
  image: "Images",
  video: "Video",
};
function textOf(content) {
  return typeof content === "string"
    ? content
    : content?.text ||
        (Array.isArray(content)
          ? content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n")
          : "");
}
function imageOf(content) {
  return Array.isArray(content)
    ? content.filter((p) => p.type === "image_url").map((p) => p.image_url.url)
    : content?.images?.map((i) => i.image_url?.url || i.url) || [];
}
export function ModelPicker({
  mode,
  selected,
  onSelect,
  onClose,
  multi = false,
}) {
  const { models, modelInfo } = useApp(),
    [q, setQ] = useState(""),
    [filter, setFilter] = useState("all");
  const relevant = models.filter((m) =>
    mode === "image"
      ? m.imageCapable
      : mode === "video"
        ? m.type === "video"
        : m.type === "chat" && !m.imageCapable,
  );
  const list = relevant
    .filter(
      (m) =>
        `${m.id} ${m.name} ${m.owned_by}`
          .toLowerCase()
          .includes(q.toLowerCase()) &&
        (filter === "all" ||
          (filter === "popular" && m.popular) ||
          (filter === "vision" && m.vision) ||
          (filter === "code" && /code|coder|devstral|claude|gpt/i.test(m.id)) ||
          (filter === "reasoning" &&
            /reason|think|o3|o4|r1|gpt-5/i.test(m.id)) ||
          (filter === "cheap" && (m.pricing?.input_per_1M_tokens || 0) < 1) ||
          (filter === "long" && m.context_length >= 128000)),
    )
    .sort(
      (a, b) =>
        Number(b.callable) - Number(a.callable) ||
        Number(b.popular) - Number(a.popular),
    );
  return (
    <Modal
      title={multi ? "Compare image models" : "Choose a model"}
      onClose={onClose}
      wide
    >
      <div className="search-field">
        <Search size={18} />
        <input
          autoFocus
          placeholder="Search models or providers…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <kbd>ESC</kbd>
      </div>
      <div className="pills model-picker-filters">
        {(mode === "image" || mode === "video"
          ? ["all"]
          : ["all", "popular", "code", "reasoning", "vision", "cheap", "long"]
        ).map((v) => (
          <button
            key={v}
            className={v === filter ? "active" : ""}
            onClick={() => setFilter(v)}
          >
            {v === "long" ? "Long context" : v}
          </button>
        ))}
      </div>
      <div className="picker-list">
        {list.map((m) => (
          <button
            key={m.id}
            className={
              (
                Array.isArray(selected)
                  ? selected.includes(m.id)
                  : selected === m.id
              )
                ? "active"
                : ""
            }
            disabled={!m.callable}
            onClick={() => onSelect(m.id)}
          >
            <ProviderIcon provider={m.owned_by} />
            <div>
              <strong>{m.name}</strong>
              <small>{m.id}</small>
            </div>
            <div className="picker-price">
              <span>
                {mode === "image"
                  ? fmt(m.imagePrice * 1000) + " cr"
                  : mode === "video"
                    ? fmt(generationPrice(m) * 1000) + " cr"
                    : "$" + (m.pricing?.input_per_1M_tokens || 0) + "/M"}
              </span>
              <small>
                {!m.callable
                  ? "Not configured"
                  : m.context_length
                    ? fmt(m.context_length / 1000) + "K context"
                    : "per generation"}
              </small>
            </div>
            {(Array.isArray(selected)
              ? selected.includes(m.id)
              : selected === m.id) && <Check size={16} />}
          </button>
        ))}
      </div>
      {!list.length && (
        <Empty title="No models found">Try another search.</Empty>
      )}
      {multi && (
        <Button className="full" onClick={onClose}>
          Use selected models
        </Button>
      )}
      <p className="fineprint">
        {modelInfo?.live
          ? "Catalog refreshed from the provider"
          : "Reference catalog snapshot"}
        {modelInfo?.updatedAt ? ` · ${date(modelInfo.updatedAt)}` : ""}. Only
        connected, supported models are selectable. ⌘K opens this picker.
      </p>
    </Modal>
  );
}
function artifactsFrom(messages) {
  const files = [];
  messages
    .filter((m) => m.role === "assistant")
    .forEach((m, version) => {
      const code = textOf(m.content);
      const regex = /```([^\n]*)\n([\s\S]*?)```/g;
      let match;
      let index = 0;
      while ((match = regex.exec(code))) {
        const info = match[1].trim(),
          lang = info.split(/\s/)[0] || "text";
        const ext =
          {
            javascript: "js",
            typescript: "ts",
            python: "py",
            jsx: "jsx",
            tsx: "tsx",
            html: "html",
            css: "css",
            json: "json",
            bash: "sh",
            sql: "sql",
            markdown: "md",
          }[lang] || "txt";
        const filename = (
          info.match(/(?:filename=|file=)([^\s]+)/)?.[1] ||
          `file-${++index}.${ext}`
        ).replace(/[\\/]/g, "-");
        files.push({
          name: filename,
          language: lang,
          code: match[2],
          version: version + 1,
          id: `${version}-${files.length}`,
        });
      }
    });
  return files;
}
function Artifacts({ files, onClose }) {
  const [selected, setSelected] = useState("");
  const file = files.find((f) => f.id === selected) || files.at(-1);
  return (
    <aside className="artifact-panel">
      <div className="panel-title">
        <h3>
          <FileCode size={16} /> Code files
        </h3>
        <button
          className="icon-button"
          aria-label="Close code panel"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <div className="artifact-tabs">
        {files.map((f) => (
          <button
            key={f.id}
            className={file?.id === f.id ? "active" : ""}
            onClick={() => setSelected(f.id)}
          >
            {f.name}
            <small>v{f.version}</small>
          </button>
        ))}
      </div>
      {file ? (
        <>
          <div className="artifact-actions">
            <span>
              {file.language} · version {file.version}
            </span>
            <CopyButton text={file.code} />
            <button
              className="copy-button"
              aria-label="Download selected code file"
              onClick={() => download(file.code, file.name)}
            >
              <Download size={14} />
            </button>
          </div>
          <pre>
            <code>{file.code}</code>
          </pre>
          <Button
            variant="outline"
            onClick={async () => {
              const { default: JSZip } = await import("jszip");
              const zip = new JSZip();
              files.forEach((f) => zip.file(`v${f.version}/${f.name}`, f.code));
              const blob = await zip.generateAsync({ type: "blob" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "anonyma-code.zip";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            <Download size={15} /> Save all files
          </Button>
        </>
      ) : (
        <Empty title="Your code appears here">
          Ask for a code example to create a downloadable file.
        </Empty>
      )}
      <p className="fineprint">
        Generated source is not executed in this workspace.
      </p>
    </aside>
  );
}
export function Workspace() {
  const { models, user, refresh, config } = useApp(),
    navigate = useNavigate(),
    [params] = useSearchParams();
  const initialMode = ["chat", "code", "image", "video"].includes(
    params.get("mode"),
  )
    ? params.get("mode")
    : "chat";
  const [mode, setMode] = useState(initialMode),
    [modelId, setModelId] = useState(params.get("model") || ""),
    [messages, setMessages] = useState([]),
    [conversations, setConversations] = useState([]),
    [conversation, setConversation] = useState(null),
    [prompt, setPrompt] = useState(""),
    [attachments, setAttachments] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [picker, setPicker] = useState(false),
    [sidebar, setSidebar] = useState(false),
    [showCode, setShowCode] = useState(true),
    [library, setLibrary] = useState(false),
    [media, setMedia] = useState([]),
    [jobs, setJobs] = useState([]),
    [zoom, setZoom] = useState(null),
    [n, setN] = useState(1),
    [compare, setCompare] = useState([]),
    [multiPicker, setMultiPicker] = useState(false),
    [ratio, setRatio] = useState("16:9"),
    [duration, setDuration] = useState("5"),
    [quality, setQuality] = useState("standard"),
    [imageUrl, setImageUrl] = useState(""),
    [estimate, setEstimate] = useState(null),
    [maxTokens, setMaxTokens] = useState(4096),
    [settings, setSettings] = useState(false),
    [libraryFilter, setLibraryFilter] = useState("all");
  const [renaming, setRenaming] = useState(null);
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState("");
  const controller = useRef(null),
    conversationLoad = useRef(0),
    bottom = useRef(null),
    fileInput = useRef(null),
    textarea = useRef(null);
  const selected = models.find((m) => m.id === modelId);
  const eligible = models.filter(
    (m) =>
      m.callable &&
      (mode === "image"
        ? m.imageCapable
        : mode === "video"
          ? m.type === "video"
          : m.type === "chat" && !m.imageCapable),
  );
  const explicitUnavailable =
    modelId === params.get("model") &&
    modelId &&
    models.length &&
    (!selected || !selected.callable);
  const model = explicitUnavailable
    ? selected || { id: modelId, name: modelId, callable: false }
    : eligible.find((m) => m.id === modelId) ||
      eligible.find((m) => m.id === "google/gemini-2.5-flash") ||
      eligible.find((m) => m.popular) ||
      eligible[0] ||
      selected;
  const presets = videoPresets(model);
  const files = useMemo(() => artifactsFrom(messages), [messages]);
  async function loadHistory() {
    if (!user) return;
    try {
      setConversations((await api("/api/conversations")).data);
    } catch (e) {
      setError(e.message);
    }
  }
  async function loadMedia() {
    if (!user) return;
    try {
      const [m, j] = await Promise.all([
        api("/api/media"),
        api("/api/videos"),
        refresh(),
      ]);
      setMedia(m.data);
      setJobs(j.data);
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    loadHistory();
    loadMedia();
  }, [user?.id]);
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => {
      if (
        mode === "video" ||
        jobs.some((j) => ["pending", "processing"].includes(j.status))
      )
        loadMedia();
    }, 5000);
    return () => clearInterval(timer);
  }, [
    user?.id,
    mode,
    jobs.some((j) => ["pending", "processing"].includes(j.status)),
  ]);
  useEffect(() => {
    const fn = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPicker((v) => !v);
      }
    };
    window.addEventListener("keydown", fn);
    return () => {
      window.removeEventListener("keydown", fn);
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (busy)
      bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);
  useEffect(() => {
    setError("");
    setEstimate(null);
    if (mode === "video" && model) {
      const preset = presets[0];
      if (preset) {
        setQuality(preset.quality);
        setRatio(preset.ratio);
        setDuration(preset.duration);
        if (model.capabilities?.accepts_image_url === false) setImageUrl("");
      }
    }
  }, [mode, model?.id]);
  const content = () =>
    attachments.length
      ? [
          { type: "text", text: prompt },
          ...attachments.map((a) => ({
            type: "image_url",
            image_url: { url: a.url },
          })),
        ]
      : prompt;
  const context = () => {
    const previous = messages
      .filter((m) => ["user", "assistant"].includes(m.role))
      .slice(-18)
      .map((m) => ({
        role: m.role,
        content: m.role === "assistant" ? textOf(m.content) : m.content,
      }));
    return [
      ...(mode === "code"
        ? [
            {
              role: "system",
              content:
                "Help write and explain code. Put complete source in fenced code blocks with a language and filename=example.ext where useful.",
            },
          ]
        : []),
      ...previous,
      { role: "user", content: content() },
    ].slice(-20);
  };
  useEffect(() => {
    if (!user || !model?.callable || !prompt.trim()) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const j = await api("/api/quote", {
          method: "POST",
          body: {
            model: model.id,
            messages:
              mode === "chat" || mode === "code"
                ? context()
                : [{ role: "user", content: prompt }],
            max_tokens: maxTokens,
            n: mode === "image" ? n : 1,
            ratio,
            duration,
            quality,
            image_url: mode === "video" ? imageUrl || undefined : undefined,
          },
        });
        if (!cancelled) setEstimate(j);
      } catch {
        if (!cancelled) setEstimate(null);
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    prompt,
    model?.id,
    attachments.length,
    maxTokens,
    n,
    ratio,
    duration,
    quality,
    imageUrl,
    user?.id,
  ]);
  function changeMode(next) {
    if (busy) return;
    setMode(next);
    setLibrary(false);
    setError("");
    setAttachments([]);
  }
  async function selectConversation(id) {
    if (busy) return;
    const version = ++conversationLoad.current;
    try {
      const c = await api("/api/conversations/" + id);
      if (version !== conversationLoad.current) return;
      setConversation(id);
      setMessages(c.messages.map((m) => ({ ...m, usage: m.content?.usage })));
      setMode(c.mode === "code" ? "code" : "chat");
      setLibrary(false);
      setSidebar(false);
      setError("");
      setAttachments([]);
    } catch (e) {
      if (version === conversationLoad.current) setError(e.message);
    }
  }
  function reset() {
    if (busy) return;
    conversationLoad.current++;
    setConversation(null);
    setMessages([]);
    setPrompt("");
    setAttachments([]);
    setLibrary(false);
    setSidebar(false);
    setError("");
  }
  async function attach(files) {
    setError("");
    const incoming = Array.from(files);
    if (attachments.length + incoming.length > 8) {
      setError("You can attach up to eight images.");
      return;
    }
    const all = [];
    for (const file of incoming) {
      if (
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          file.type,
        )
      ) {
        setError("Only PNG, JPEG, WebP and GIF images are supported.");
        return;
      }
      if (file.size > 1.5 * 1024 * 1024) {
        setError("Each image must be smaller than 1.5 MB.");
        return;
      }
      const url = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      all.push({ name: file.name, url });
    }
    setAttachments((a) => [...a, ...all]);
  }
  async function send(e) {
    e?.preventDefault();
    if (busy || !prompt.trim()) return;
    if (!user) {
      navigate("/signin?next=/ask");
      return;
    }
    if (!model?.callable) {
      setError(
        "This model is not available for generation yet. Please choose an available model or try again after the service is connected.",
      );
      return;
    }
    if (mode === "video" && requiresVideoImage && !imageUrl.trim()) {
      setError(
        "This video model needs a starting image. Add its HTTPS image link before generating.",
      );
      return;
    }
    setBusy(true);
    conversationLoad.current++;
    setError("");
    const sentPrompt = prompt,
      bodyContent = content();
    const ac = new AbortController();
    controller.current = ac;
    try {
      if (mode === "image") {
        const ids = compare.length ? compare : [model.id];
        const results = await Promise.allSettled(
          ids.map((id) =>
            api("/api/images", {
              method: "POST",
              body: {
                model: id,
                prompt: sentPrompt,
                n,
                images: attachments.map((a) => a.url),
                requestId: crypto.randomUUID(),
              },
              signal: ac.signal,
            }),
          ),
        );
        const errors = results.filter((r) => r.status === "rejected");
        const warnings = results
          .filter((r) => r.status === "fulfilled" && r.value.warning)
          .map((r) => r.value.warning);
        if (errors.length || warnings.length)
          setError(
            [...errors.map((r) => r.reason.message), ...warnings].join(" · "),
          );
        await loadMedia();
        setLibrary(true);
        setLibraryFilter("image");
      } else if (mode === "video") {
        await api("/api/videos", {
          method: "POST",
          body: {
            model: model.id,
            prompt: sentPrompt,
            ratio,
            duration,
            quality,
            image_url: imageUrl || undefined,
            requestId: crypto.randomUUID(),
          },
          signal: ac.signal,
        });
        await loadMedia();
        setLibrary(true);
        setLibraryFilter("video");
      } else {
        const requestMessages = context();
        setMessages((prev) => [
          ...prev,
          { role: "user", content: bodyContent },
          {
            role: "assistant",
            content: { text: "", reasoning: "" },
            model: model.id,
            pending: true,
          },
        ]);
        setPrompt("");
        setAttachments([]);
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: model.id,
            messages: requestMessages,
            conversationId: conversation,
            mode,
            max_tokens: maxTokens,
            requestId: crypto.randomUUID(),
          }),
          signal: ac.signal,
        });
        if (!response.ok) {
          const j = await response.json();
          throw Error(j.error?.message || "Generation failed.");
        }
        let text = "",
          reasoning = "",
          interrupted = false,
          receipt = null;
        const images = [];
        for await (const chunk of readChatEvents(response)) {
          if (chunk.error) {
            interrupted = true;
            setError(chunk.error.message);
          }
          if (chunk.conversationId) setConversation(chunk.conversationId);
          const delta = chunk.choices?.[0]?.delta || {};
          text += delta.content || "";
          reasoning += delta.reasoning || delta.reasoning_content || "";
          if (delta.images) images.push(...delta.images);
          if (chunk.anonyma) receipt = { ...chunk.anonyma, usage: chunk.usage };
          setMessages((prev) => [
            ...prev.slice(0, -1),
            {
              role: "assistant",
              content: { text, reasoning, images: [...images], interrupted },
              model: model.id,
              pending: true,
              credits: receipt?.credits_charged,
              usage: receipt?.usage,
            },
          ]);
        }
        setMessages((prev) =>
          prev.map((m, i) =>
            i === prev.length - 1 ? { ...m, pending: false } : m,
          ),
        );
        await loadHistory();
      }
      await refresh();
    } catch (e) {
      setError(
        e.name === "AbortError"
          ? "Generation stopped. Partial output may be billed."
          : e.message,
      );
      setMessages((prev) =>
        prev.map((m) =>
          m.pending
            ? {
                ...m,
                pending: false,
                content: { ...m.content, interrupted: true },
              }
            : m,
        ),
      );
      await refresh();
      await loadHistory();
    } finally {
      setBusy(false);
      controller.current = null;
    }
  }
  const visibleMedia = media.filter(
    (m) => libraryFilter === "all" || m.kind === libraryFilter,
  );
  const jobList = jobs.filter((j) => j.status !== "completed");
  function chooseVideoOption(field, value) {
    const choices = presets.filter((p) => p[field] === value);
    const current = { quality, ratio, duration };
    const next =
      choices.find((p) =>
        Object.keys(current).every(
          (key) => key === field || p[key] === current[key],
        ),
      ) || choices[0];
    if (next) {
      setQuality(next.quality);
      setRatio(next.ratio);
      setDuration(next.duration);
    }
  }
  const videoRatios = [
    ...new Set(
      presets.filter((p) => p.quality === quality).map((p) => p.ratio),
    ),
  ];
  const videoQualities = [...new Set(presets.map((p) => p.quality))];
  const requiresVideoImage =
    model?.capabilities?.requires_image_url ||
    model?.category === "image-to-video";
  const durations = [
    ...new Set(
      presets
        .filter((p) => p.quality === quality && p.ratio === ratio)
        .map((p) => p.duration),
    ),
  ];
  return (
    <div className="workspace">
      <aside className={"workspace-sidebar " + (sidebar ? "open" : "")}>
        <div className="sidebar-top">
          <div className="rail-heading">
            <span>WORKSPACE</span>
            <Link to="/support">Support</Link>
          </div>
          <Link
            to="/account"
            className={"sidebar-balance " + (!user ? "unsigned" : "")}
          >
            <span>
              {user ? "YOUR BALANCE" : "NOT SIGNED IN"}{" "}
              <ArrowUpRight size={12} />
            </span>
            <strong>
              {user ? (
                <>
                  {fmt(user.available, 2)} <small>credits</small>
                </>
              ) : (
                "Sign in to start"
              )}
            </strong>
            {user && <span>Available to use</span>}
          </Link>
          <Button variant="outline full" onClick={reset} disabled={busy}>
            <Plus size={16} /> New chat <kbd>＋</kbd>
          </Button>
        </div>
        <div className="history-label">RECENT CHATS</div>
        <div className="history-list">
          {conversations.map((c) => (
            <div key={c.id} className={conversation === c.id ? "active" : ""}>
              <button disabled={busy} onClick={() => selectConversation(c.id)}>
                <MessageSquare size={14} />
                <span>{c.title}</span>
              </button>
              <button
                className="delete-chat"
                title="Rename conversation"
                aria-label={"Rename " + c.title}
                disabled={busy}
                onClick={() => {
                  setTitleError("");
                  setRenaming({ id: c.id, title: c.title });
                }}
              >
                <Pencil size={12} />
              </button>
              <button
                className="delete-chat"
                title="Delete conversation"
                aria-label={"Delete " + c.title}
                disabled={busy}
                onClick={async () => {
                  try {
                    await api("/api/conversations/" + c.id, {
                      method: "DELETE",
                    });
                    if (conversation === c.id) reset();
                    loadHistory();
                  } catch (e) {
                    setError(e.message);
                  }
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {!conversations.length && (
            <p>
              Your conversations will
              <br />
              appear here.
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            className={"library-link " + (library ? "active" : "")}
            onClick={() => {
              setLibrary(!library);
              setSidebar(false);
              loadMedia();
            }}
          >
            <FolderOpen size={17} /> Your library <span>{media.length}</span>
          </button>
          <Link to="/account/deposit" className="sidebar-promo">
            <Wallet size={17} />
            <div>
              <strong>One balance. Every model.</strong>
              <p>Add credits. Make something.</p>
            </div>
            <ArrowUpRight size={14} />
          </Link>
          <Link to="/docs/api" className="sidebar-promo">
            <Code2 size={17} />
            <div>
              <strong>Bring your own workflow.</strong>
              <p>Connect with the API or CLI.</p>
            </div>
            <ArrowUpRight size={14} />
          </Link>
          <Link className="sidebar-user" to={user ? "/account" : "/signin"}>
            <span>{(user?.username || "A").slice(0, 1).toUpperCase()}</span>
            {user?.username || user?.email || "Sign in / Create account"}
            <ChevronRight size={15} />
          </Link>
        </div>
      </aside>
      {sidebar && (
        <div className="sidebar-shade" onClick={() => setSidebar(false)} />
      )}
      <main className="workspace-main">
        <div className="workspace-toolbar">
          <button
            className="icon-button sidebar-toggle"
            aria-label="Open history"
            onClick={() => setSidebar(!sidebar)}
          >
            <PanelLeft size={19} />
          </button>
          <div className="mode-tabs">
            {modes.map(([id, Icon]) => (
              <button
                key={id}
                aria-label={modeLabel[id]}
                aria-pressed={mode === id}
                className={mode === id ? "active" : ""}
                disabled={busy}
                onClick={() => changeMode(id)}
              >
                <Icon size={16} />
                <span>{modeLabel[id]}</span>
              </button>
            ))}
          </div>
          <div className="toolbar-right">
            <Link className="compare-workspace" to="/compare">
              ⇄ Compare
            </Link>
            {conversation && (
              <button
                title="Export conversation"
                aria-label="Export conversation"
                className="icon-button"
                onClick={() =>
                  download(
                    { messages },
                    "conversation.json",
                    "application/json",
                  )
                }
              >
                <Download size={16} />
              </button>
            )}
            <button
              className="icon-button"
              title="Saved library"
              aria-label="Saved library"
              onClick={() => {
                setLibrary(!library);
                loadMedia();
              }}
            >
              <FolderOpen size={17} />
            </button>
            {mode === "code" && (
              <button
                className="icon-button"
                aria-label="Toggle code panel"
                onClick={() => setShowCode(!showCode)}
              >
                <PanelRight size={17} />
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Generation settings"
              onClick={() => setSettings(true)}
            >
              <SlidersHorizontal size={17} />
            </button>
          </div>
        </div>
        <div className="workspace-content">
          <div
            className="conversation-column"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (mode !== "video") attach(e.dataTransfer.files);
            }}
          >
            <div className="conversation-scroll">
              {library ? (
                <div className="library">
                  <div className="panel-title">
                    <div>
                      <div className="eyebrow">SAVED TO YOUR ACCOUNT</div>
                      <h1>Your library</h1>
                    </div>
                    <Button
                      variant="ghost small"
                      aria-label="Refresh library"
                      onClick={() => loadMedia()}
                    >
                      <RefreshCw size={14} />
                    </Button>
                  </div>
                  <div className="pills">
                    {["all", "image", "video"].map((v) => (
                      <button
                        key={v}
                        className={libraryFilter === v ? "active" : ""}
                        onClick={() => setLibraryFilter(v)}
                      >
                        {v === "all"
                          ? "Everything"
                          : v === "image"
                            ? "Images"
                            : "Videos"}
                      </button>
                    ))}
                  </div>
                  {libraryFilter !== "image" &&
                    jobList.map((j) => (
                      <div className="video-job" key={j.id}>
                        {["pending", "processing"].includes(j.status) ? (
                          <LoaderCircle className="spin" size={18} />
                        ) : (
                          <Video size={18} />
                        )}
                        <div>
                          <strong>
                            {j.status} · {j.request.model}
                          </strong>
                          <p>{j.request.prompt}</p>
                          {j.error && <small>{j.error}</small>}
                        </div>
                      </div>
                    ))}
                  {!visibleMedia.length && !jobList.length && (
                    <Empty title="Room for your next idea">
                      Generated images and videos will be saved here.
                    </Empty>
                  )}
                  <div className="media-grid">
                    {visibleMedia.map((m) => (
                      <article className="media-card" key={m.id}>
                        <button
                          className="media-preview"
                          onClick={() => setZoom(m)}
                        >
                          {m.kind === "video" ? (
                            <video
                              src={m.url + "#t=0.1"}
                              preload="metadata"
                              muted
                            />
                          ) : (
                            <img src={m.url} alt={m.prompt} />
                          )}
                          <Expand size={19} />
                          {config?.testMode && (
                            <span className="media-test">
                              LOCAL TEST FIXTURE
                            </span>
                          )}
                        </button>
                        <div>
                          <p>{m.prompt}</p>
                          <small>
                            {m.model} · {fmt(m.cost, 4)} cr
                          </small>
                          <div className="media-actions">
                            <a
                              href={m.url + "?download=1"}
                              download
                              className="copy-button"
                            >
                              <Download size={14} /> Save
                            </a>
                            <button
                              className="copy-button"
                              onClick={() => {
                                setMode(m.kind);
                                setModelId(m.model);
                                setPrompt(
                                  m.prompt.replace(/^LOCAL TEST FIXTURE: /, ""),
                                );
                                setLibrary(false);
                              }}
                            >
                              Rerun
                            </button>
                            <button
                              className="copy-button"
                              aria-label="Delete media"
                              onClick={async () => {
                                try {
                                  await api("/api/media/" + m.id, {
                                    method: "DELETE",
                                  });
                                  loadMedia();
                                } catch (e) {
                                  setError(e.message);
                                }
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              ) : messages.length && ["chat", "code"].includes(mode) ? (
                <div className="messages">
                  {messages.map((m, i) => (
                    <article className={"message " + m.role} key={m.id || i}>
                      <div className="message-avatar">
                        {m.role === "user" ? (
                          (user?.username || "You").slice(0, 1).toUpperCase()
                        ) : (
                          <ProviderIcon
                            provider={
                              models.find((v) => v.id === m.model)?.owned_by ||
                              ""
                            }
                            size={22}
                          />
                        )}
                      </div>
                      <div className="message-body">
                        <div className="message-name">
                          {m.role === "user"
                            ? "You"
                            : models.find((v) => v.id === m.model)?.name ||
                              "Assistant"}
                          {m.pending && <span className="tiny-dot pulse" />}
                        </div>
                        {m.content?.reasoning && (
                          <details className="reasoning">
                            <summary>Reasoning</summary>
                            <Markdown remarkPlugins={[remarkGfm]}>
                              {m.content.reasoning}
                            </Markdown>
                          </details>
                        )}
                        <Markdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            pre: ({ children }) => (
                              <div className="code-block">
                                <div>Generated code</div>
                                <pre>{children}</pre>
                              </div>
                            ),
                            a: ({ children, ...p }) => (
                              <a {...p} target="_blank" rel="noreferrer">
                                {children}
                              </a>
                            ),
                          }}
                        >
                          {textOf(m.content)}
                        </Markdown>
                        {imageOf(m.content).length > 0 && (
                          <div className="message-images">
                            {imageOf(m.content).map((url, j) => (
                              <img
                                key={j}
                                src={url}
                                alt="Conversation image"
                                onClick={() =>
                                  setZoom({
                                    url,
                                    prompt: "Conversation image",
                                    kind: "image",
                                  })
                                }
                              />
                            ))}
                          </div>
                        )}
                        {m.content?.interrupted && (
                          <p className="muted">
                            Response interrupted. Check account activity for the
                            charge.
                          </p>
                        )}
                        {m.pending && !textOf(m.content) && (
                          <div className="typing">•••</div>
                        )}
                        {m.role === "assistant" && !m.pending && (
                          <div className="message-receipt">
                            <CopyButton text={textOf(m.content)} label="Copy" />
                            {m.credits != null && (
                              <span>{fmt(m.credits, 4)} credits</span>
                            )}
                            {m.usage && (
                              <span>{fmt(m.usage.total_tokens)} tokens</span>
                            )}
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                  <div ref={bottom} />
                </div>
              ) : (
                <div className="workspace-empty">
                  <div className="eyebrow">&gt;_ EVERY MODEL · ONE BALANCE</div>
                  <h1>
                    {mode === "chat"
                      ? "What are you making?"
                      : mode === "code"
                        ? "What will you build?"
                        : mode === "image"
                          ? "Imagine something new."
                          : "Make your ideas move."}
                  </h1>
                  <p>
                    {mode === "chat"
                      ? "Ask a question, explore an idea, or make a plan. See an estimate before sending and a usage receipt after every reply."
                      : mode === "code"
                        ? "Write, debug and explore. Your code, ready to take with you."
                        : mode === "image"
                          ? "Create and compare images with your favorite models."
                          : "Choose your model and turn a prompt into a video."}
                  </p>
                  <div className="mode-cards">
                    {modes.map(([id, Icon, title, desc]) => (
                      <button
                        key={id}
                        className={mode === id ? "active" : ""}
                        onClick={() => changeMode(id)}
                      >
                        <Icon size={20} />
                        <strong>{title}</strong>
                        <span>{desc}</span>
                        <Icon className="ghost-icon" />
                      </button>
                    ))}
                  </div>
                  {mode === "image" && (
                    <div className="generation-controls">
                      <label>
                        Images
                        <select
                          value={n}
                          onChange={(e) => setN(Number(e.target.value))}
                        >
                          {[1, 2, 3, 4].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      <Button
                        variant="outline"
                        onClick={() => setMultiPicker(true)}
                      >
                        Compare models{" "}
                        {compare.length ? `(${compare.length})` : ""}
                      </Button>
                      {compare.length > 0 && (
                        <button
                          className="text-link"
                          onClick={() => setCompare([])}
                        >
                          Use single model
                        </button>
                      )}
                    </div>
                  )}
                  {mode === "video" && (
                    <div className="video-controls">
                      <div className="generation-controls">
                        <label>
                          Aspect ratio
                          <select
                            value={ratio}
                            onChange={(e) =>
                              chooseVideoOption("ratio", e.target.value)
                            }
                          >
                            {videoRatios.map((v) => (
                              <option key={v} value={v}>
                                {v || "Model default"}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Duration
                          <select
                            value={duration}
                            onChange={(e) =>
                              chooseVideoOption("duration", e.target.value)
                            }
                          >
                            {durations.map((v) => (
                              <option key={v} value={v}>
                                {v ? `${v} seconds` : "Model default"}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Quality
                          <select
                            value={quality}
                            onChange={(e) =>
                              chooseVideoOption("quality", e.target.value)
                            }
                          >
                            {videoQualities.map((v) => (
                              <option key={v} value={v}>
                                {v || "Model default"}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      {model?.capabilities?.accepts_image_url !== false && (
                        <input
                          aria-label="Video reference image URL"
                          placeholder={
                            requiresVideoImage
                              ? "Required reference image URL (https://…)"
                              : "Optional reference image URL (https://…)"
                          }
                          required={requiresVideoImage}
                          type="url"
                          value={imageUrl}
                          onChange={(e) => setImageUrl(e.target.value)}
                        />
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="composer-wrap">
              <ErrorBox error={error} />
              {attachments.length > 0 && (
                <div className="attachment-row">
                  {attachments.map((a, i) => (
                    <div key={i}>
                      <img src={a.url} alt={a.name} />
                      <button
                        aria-label={"Remove " + a.name}
                        onClick={() =>
                          setAttachments(attachments.filter((_, j) => i !== j))
                        }
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <form className="composer" onSubmit={send}>
                <div className="composer-top">
                  <textarea
                    ref={textarea}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    maxLength={mode === "video" ? 2000 : 48000}
                    placeholder={
                      mode === "image"
                        ? "Describe the image you want to create…"
                        : mode === "video"
                          ? "Describe your video…"
                          : mode === "code"
                            ? "Describe what you want to build…"
                            : "Ask anything…"
                    }
                    rows={2}
                  />
                  {busy ? (
                    <button
                      type="button"
                      className="send-button"
                      aria-label="Stop generation"
                      onClick={() => controller.current?.abort()}
                    >
                      <Square size={17} />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="send-button"
                      aria-label="Send prompt"
                      disabled={!prompt.trim()}
                    >
                      <span>
                        Send
                        {estimate ? ` · ~${fmt(estimate.credits, 1)} cr` : ""}
                      </span>
                    </button>
                  )}
                </div>
                <div className="composer-bottom">
                  <div className="composer-model">
                    <button type="button" onClick={() => setPicker(true)}>
                      <ProviderIcon
                        provider={model?.owned_by || ""}
                        size={19}
                      />
                      <span>{model?.name || "Choose a model"}</span>
                      <ChevronDown size={13} />
                    </button>
                    {mode !== "video" && (
                      <>
                        <input
                          hidden
                          ref={fileInput}
                          type="file"
                          multiple
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          onChange={(e) => {
                            attach(e.target.files);
                            e.target.value = "";
                          }}
                        />
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Attach reference images"
                          onClick={() => fileInput.current?.click()}
                        >
                          <Paperclip size={17} />
                        </button>
                      </>
                    )}
                  </div>
                  <span className="composer-estimate">
                    {estimate
                      ? `Up to ${fmt(mode === "image" && compare.length ? compare.reduce((sum, id) => sum + (models.find((m) => m.id === id)?.imagePrice || 0) * 1000 * n, 0) : estimate.credits, 2)} credits`
                      : "Pay only for what you use"}
                  </span>
                </div>
              </form>
              <div className="composer-note">
                {config?.testMode
                  ? "Local test output is a fixture, not a real model response."
                  : "AI can make mistakes. Review important output."}
                <Link to="/docs/credits">How billing works ↗</Link>
              </div>
            </div>
          </div>
          {mode === "code" && showCode && messages.length > 0 && (
            <Artifacts files={files} onClose={() => setShowCode(false)} />
          )}
        </div>
      </main>
      {picker && (
        <ModelPicker
          mode={mode}
          selected={model?.id}
          onSelect={(id) => {
            setModelId(id);
            setPicker(false);
          }}
          onClose={() => setPicker(false)}
        />
      )}{" "}
      {multiPicker && (
        <ModelPicker
          mode="image"
          multi
          selected={compare}
          onSelect={(id) =>
            setCompare((v) =>
              v.includes(id)
                ? v.filter((x) => x !== id)
                : v.length < 4
                  ? [...v, id]
                  : v,
            )
          }
          onClose={() => setMultiPicker(false)}
        />
      )}{" "}
      {settings && (
        <Modal title="Generation settings" onClose={() => setSettings(false)}>
          <label>
            Maximum output tokens
            <input
              type="number"
              min="1"
              max="8192"
              value={maxTokens}
              onChange={(e) =>
                setMaxTokens(
                  Math.min(8192, Math.max(1, Number(e.target.value))),
                )
              }
            />
          </label>
          <p className="fineprint">
            Default 4,096. The credit reservation includes this output ceiling.
            Actual settled usage can be lower.
          </p>
          <Button className="full" onClick={() => setSettings(false)}>
            Done
          </Button>
        </Modal>
      )}
      {renaming && (
        <Modal
          title="Rename conversation"
          onClose={() => !savingTitle && setRenaming(null)}
        >
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (savingTitle || !renaming.title.trim()) return;
              setSavingTitle(true);
              setTitleError("");
              try {
                await api("/api/conversations/" + renaming.id, {
                  method: "PATCH",
                  body: { title: renaming.title.trim() },
                });
                await loadHistory();
                setRenaming(null);
              } catch (error) {
                setTitleError(error.message);
              } finally {
                setSavingTitle(false);
              }
            }}
          >
            <label>
              Conversation name
              <input
                autoFocus
                maxLength={70}
                required
                value={renaming.title}
                onChange={(event) =>
                  setRenaming({ ...renaming, title: event.target.value })
                }
              />
            </label>
            <ErrorBox error={titleError} />
            <Button
              type="submit"
              className="full"
              disabled={savingTitle || !renaming.title.trim()}
            >
              {savingTitle ? "Saving…" : "Save name"}
            </Button>
          </form>
        </Modal>
      )}
      {zoom && (
        <Modal
          title={zoom.kind === "video" ? "Your video" : "Your image"}
          onClose={() => setZoom(null)}
          wide
        >
          <div className="lightbox">
            {zoom.kind === "video" ? (
              <video controls autoPlay src={zoom.url} />
            ) : (
              <img src={zoom.url} alt={zoom.prompt} />
            )}
          </div>
          <p>{zoom.prompt}</p>
          <small>
            {zoom.model} · {zoom.created ? date(zoom.created) : ""}
          </small>
          <div className="button-row">
            <a
              className="button outline"
              href={
                zoom.url + (zoom.url.includes("?") ? "&" : "?") + "download=1"
              }
              download
            >
              <Download size={16} /> Download original
            </a>
            <CopyButton text={zoom.prompt || ""} label="Copy prompt" />
          </div>
        </Modal>
      )}
    </div>
  );
}
