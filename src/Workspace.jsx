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