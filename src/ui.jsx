import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { animate } from "animejs";
import { Link } from "react-router-dom";
import {
  Mic,
  Globe,
  Users,
  Gift,
  AudioLines,
  ArrowUpRight,
  ArrowRight,
  MessageSquare,
  Code2,
  Image,
  Clapperboard,
  Layers,
  Wallet,
  Plus,
  Check,
  X,
  Search,
  ChevronDown,
  Menu,
  BookOpen,
  KeyRound,
  Clock,
  Settings,
  Download,
  Copy,
  Send,
  Square,
  Pause,
  Play,
  Trash2,
  PanelLeftClose,
  ExternalLink,
  Shield,
  Command,
  Coins,
  SlidersHorizontal,
  RefreshCw,
  LogOut,
  Eye,
  FileCode,
  TriangleAlert,
} from "lucide-react";
const icons = {
  arrow: ArrowRight,
  diagonal: ArrowUpRight,
  chat: MessageSquare,
  code: Code2,
  image: Image,
  video: Clapperboard,
  models: Layers,
  credits: Wallet,
  plus: Plus,
  check: Check,
  close: X,
  search: Search,
  down: ChevronDown,
  menu: Menu,
  book: BookOpen,
  key: KeyRound,
  history: Clock,
  settings: Settings,
  download: Download,
  copy: Copy,
  send: Send,
  stop: Square,
  pause: Pause,
  play: Play,
  delete: Trash2,
  panel: PanelLeftClose,
  external: ExternalLink,
  shield: Shield,
  command: Command,
  coins: Coins,
  filter: SlidersHorizontal,
  refresh: RefreshCw,
  logout: LogOut,
  eye: Eye,
  file: FileCode,
  warning: TriangleAlert,
  mic: Mic,
  globe: Globe,
  users: Users,
  gift: Gift,
  audio: AudioLines,
};
export function Icon({ name, size = 18, ...rest }) {
  if(name === "arrow") return <svg width={size} height={size} viewBox="0 0 15 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="reference-arrow" {...rest}><path className="arrow-shaft" d="M0 5.707H9"/><path className="arrow-head" d="M4 .707L9 5.707L4 10.707"/></svg>;
  const I = icons[name] || Layers;
  return <I size={size} strokeWidth={1.6} aria-hidden="true" {...rest} />;
}
// 7x7 pixel glyphs for the app sidebar, drawn in the capability-icon style.
const pixels = {
  home: ["...#...", "..###..", ".#####.", "#######", ".#...#.", ".#.#.#.", ".#.#.#."],
  chat: ["#######", "#.....#", "#.###.#", "#.....#", "#######", ".##....", ".#....."],
  code: [".......", "#......", ".#.....", "..#....", ".#.....", "#..####", "......."],
  image: ["#######", "#.....#", "#...#.#", "#.....#", "#..#..#", "#.###.#", "#######"],
  video: ["#######", "#.#...#", "#.##..#", "#.###.#", "#.##..#", "#.#...#", "#######"],
  library: ["###....", "#######", "#.....#", "#.....#", "#.....#", "#.....#", "#######"],
  models: ["#######", "#.....#", "#######", ".......", "#######", "#.....#", "#######"],
  key: [".......", "###....", "#.#####", "###.#.#", ".......", ".......", "......."],
  credits: [".#####.", "#.....#", ".#####.", "#.....#", ".#####.", "#.....#", ".#####."],
  audio: ["...#...", "...#.#.", ".#.#.#.", ".#.#.##", "##.#.##", ".#.#.#.", "...#..."],
  collab: [".##..##", "#..##..", "#..##..", ".##..##", ".......", "###.###", "###.###"],
};
export function PixelIcon({ name, size = 14 }) {
  const rows = pixels[name] || pixels.models;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 7 7"
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {rows.flatMap((row, y) =>
        [...row].map((c, x) =>
          c === "#" ? <rect key={x + "-" + y} x={x} y={y} width="1" height="1" /> : null,
        ),
      )}
    </svg>
  );
}
export function PixelTile({ name }) {
  return (
    <span className="pixel-tile">
      <PixelIcon name={name} />
    </span>
  );
}
// Connector lines and square nodes from the landing page walkthrough.
export function BandLines() {
  return (
    <span className="band-lines" aria-hidden="true">
      <i className="l1" />
      <i className="l2" />
      <i className="l3" />
      <b className="n1" />
      <b className="n2" />
      <b className="n3" />
    </span>
  );
}
// Stepped pixel edge, the landing page's block transition between a cobalt band and white content.
export function BandSteps() {
  return (
    <span className="band-steps" aria-hidden="true">
      {[0.45, 0.25, 0.7, 0.4, 0.9, 0.55, 1].map((h, i) => (
        <i key={i} style={{ "--h": h, "--n": i }} />
      ))}
    </span>
  );
}
// Counts a number up from zero once, like the landing page stat panel.
export function CountUp({ value }) {
  const ref = useRef();
  useLayoutEffect(() => {
    const el = ref.current;
    const target = Number(value) || 0;
    // Credits can be fractional; the settled value keeps up to two decimals.
    const final = target.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = final;
      return;
    }
    const state = { v: 0 };
    el.textContent = "0";
    const motion = animate(state, {
      v: target,
      duration: 1600,
      delay: 300,
      ease: "outExpo",
      onUpdate: () => {
        el.textContent = Math.round(state.v).toLocaleString();
      },
      onComplete: () => {
        el.textContent = final;
      },
    });
    return () => {
      motion.pause();
      el.textContent = final;
    };
  }, [value]);
  return <span ref={ref} />;
}

export function Mark({ className = "" }) {
  return (
    <span
      className={"brand-mark official-mark " + className}
      aria-hidden="true"
    >
      <img src="/brand/official/ionic-transparent.png" alt="" />
    </span>
  );
}
export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="ANONYMA home">
      <Mark />
      <span>ANONYMA</span>
    </Link>
  );
}
export function Button({
  to,
  children,
  secondary = false,
  className = "",
  ...rest
}) {
  const cls = `button ${secondary ? "secondary" : ""} ${className}`;
  return to ? (
    <Link to={to} className={cls} {...rest}>
      {children}
    </Link>
  ) : (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
}
export function SectionTitle({ eyebrow, children, body, left = false }) {
  return (
    <div className={"section-title " + (left ? "align-left" : "")}>
      <p className="eyebrow">{eyebrow}</p>
      <h2>{children}</h2>
      {body && <p className="section-intro">{body}</p>}
    </div>
  );
}
export function Pill({ icon, children, color = "mint", className = "" }) {
  return (
    <span className={"pill-group " + color + " " + className}>
      <span className="pill-icon">
        <Icon name={icon} />
      </span>
      <span className="pill-label">{children}</span>
    </span>
  );
}
export function Modal({ title, children, onClose }) {
  const ref = useRef();
  useEffect(() => {
    const prev = document.activeElement;
    const el = ref.current;
    el.showModal();
    return () => {
      el.close();
      prev?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label={title}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function CopyButton({ text, label = "Copy" }) {
  const [done, setDone] = useState("");
  return (
    <button
      className="small-button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone("Copied");
        } catch {
          setDone("Copy unavailable");
        }
        setTimeout(() => setDone(""), 2500);
      }}
    >
      <Icon name={done === "Copied" ? "check" : "copy"} size={14} />
      <span aria-live="polite">{done || label}</span>
    </button>
  );
}
export function Empty({ icon = "models", title, children, action }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={30} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Notice({ children, type = "" }) {
  return (
    <div
      className={"notice " + type}
      role={type === "error" ? "alert" : "status"}
    >
      <Icon name={type === "error" ? "warning" : "shield"} size={17} />
      <span>{children}</span>
    </div>
  );
}
export function Art({ kind = "chat", color = "mint" }) {
  return (
    <div className={"artwork " + color + " artwork-" + kind} aria-hidden="true">
      <div className="art-grid" />
      <span className="art-square s1" />
      <span className="art-square s2" />
      <span className="art-square s3" />
      <span className="art-tile tile-back">
        <Icon name={kind === "credits" ? "coins" : kind} size={43} />
      </span>
      <span className="art-tile tile-front">
        <Icon name={kind} size={46} />
      </span>
      <span className="art-dotted" />
    </div>
  );
}
