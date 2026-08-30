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