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