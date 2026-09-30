import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { animate } from "animejs";
import { reducedMotion } from "./motion.js";
import { Link } from "react-router-dom";
import { isMobileBrowser, walletAvailable, walletBrowserLinks } from "./lib.js";
import {
  Captions,
  Scissors,
  Merge,
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
  EyeOff,
  FileCode,
  TriangleAlert,
  Plug,
  NotebookPen,
  Share2,
  Route,
  LockKeyhole,
  Eraser,
  Lock,
  LockOpen,
  Upload,
  Folder,
  Star,
  Sigma,
  SquareDashedMousePointer,
  Crop,
  Hand,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  ScanText,
  Link2,
  Sheet,
  Scale,
  Shuffle,
  Trophy,
  Telescope,
  FingerprintPattern,
  Activity,
  WandSparkles,
  Cpu,
  HardDrive,
  GraduationCap,
  Flame,
  RotateCcw,
  FileDiff,
  ChevronUp,
  ScanEye,
  Highlighter,
  MessageSquareQuote,
  Quote,
  ImageDown,
  Lightbulb,
  Feather,
  Languages,
  SearchCheck,
  ListCollapse,
  SquareTerminal,
  Hourglass,
  Ticket,
  Printer,
  Podium,
  MonitorSmartphone,
  Split,
  PenLine,
  Bold,
  Italic,
  Heading2,
  List,
  ListOrdered,
  Presentation,
  Import as ImportChats,
  FolderGit2,
  ChevronRight,
  FileAudio,
  LifeBuoy,
  BellRing,
  VenetianMask,
  FileSearch,
  FileX,
  LayoutTemplate,
  ScrollText,
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
  eyeoff: EyeOff,
  file: FileCode,
  warning: TriangleAlert,
  mic: Mic,
  globe: Globe,
  users: Users,
  gift: Gift,
  audio: AudioLines,
  plug: Plug,
  memory: NotebookPen,
  share: Share2,
  route: Route,
  auto: Split,
  lock: LockKeyhole,
  eraser: Eraser,
  lock: Lock,
  unlock: LockOpen,
  upload: Upload,
  folder: Folder,
  star: Star,
  sigma: Sigma,
  redact: SquareDashedMousePointer,
  crop: Crop,
  hand: Hand,
  undo: Undo2,
  redo: Redo2,
  zoomin: ZoomIn,
  zoomout: ZoomOut,
  scantext: ScanText,
  link: Link2,
  chain: Link2,
  sheet: Sheet,
  diff: FileDiff,
  up: ChevronUp,
  scale: Scale,
  shuffle: Shuffle,
  trophy: Trophy,
  research: Telescope,
  fingerprint: FingerprintPattern,
  activity: Activity,
  sharpen: WandSparkles,
  device: Cpu,
  drive: HardDrive,
  study: GraduationCap,
  flame: Flame,
  flip: RotateCcw,
  watch: ScanEye,
  highlight: Highlighter,
  quote: MessageSquareQuote,
  // Quote Cards: a quotation mark, and a picture being saved.
  quotemark: Quote,
  imagedown: ImageDown,
  lightbulb: Lightbulb,
  feather: Feather,
  languages: Languages,
  factcheck: SearchCheck,
  catchup: ListCollapse,
  terminal: SquareTerminal,
  // Inactivity Wipe: time running out on a period without sign-ins.
  hourglass: Hourglass,
  // Push Alerts: browser notifications.
  bell: BellRing,
  ticket: Ticket,
  printer: Printer,
  podium: Podium,
  devices: MonitorSmartphone,
  canvas: PenLine,
  bold: Bold,
  italic: Italic,
  heading: Heading2,
  list: List,
  numbered: ListOrdered,
  present: Presentation,
  meeting: FileAudio,
  // Subtitles: captions on a video, and the editor's cut and join.
  captions: Captions,
  split: Scissors,
  merge: Merge,
  // Recovery Kit: a way back into the account.
  lifebuoy: LifeBuoy,
  // Decoy Vault: a second face shown instead of the real one.
  mask: VenetianMask,
  // Chat Import: a history brought in from another service.
  import: ImportChats,
  filesearch: FileSearch,
  // Redact a PDF: a page with a cross through it.
  pdf: FileX,
  // Screenshot to site: a page laid out in blocks.
  site: LayoutTemplate,
  repo: FolderGit2,
  // Contract Reader: a contract read line by line.
  contract: ScrollText,
  right: ChevronRight,
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
  uncensored: ["#.....#", "#.....#", "#.....#", "#.....#", "#.....#", ".#...#.", "..###.."],
  code: [".......", "#......", ".#.....", "..#....", ".#.....", "#..####", "......."],
  image: ["#######", "#.....#", "#...#.#", "#.....#", "#..#..#", "#.###.#", "#######"],
  video: ["#######", "#.#...#", "#.##..#", "#.###.#", "#.##..#", "#.#...#", "#######"],
  library: ["###....", "#######", "#.....#", "#.....#", "#.....#", "#.....#", "#######"],
  models: ["#######", "#.....#", "#######", ".......", "#######", "#.....#", "#######"],
  key: [".......", "###....", "#.#####", "###.#.#", ".......", ".......", "......."],
  credits: [".#####.", "#.....#", ".#####.", "#.....#", ".#####.", "#.....#", ".#####."],
  audio: ["...#...", "...#.#.", ".#.#.#.", ".#.#.##", "##.#.##", ".#.#.#.", "...#..."],
  collab: [".##..##", "#..##..", "#..##..", ".##..##", ".......", "###.###", "###.###"],
  // Rising columns: several voices answering the same question, compared side by side.
  symposium: [".....#.", ".....#.", "...#.#.", "...#.#.", ".#.#.#.", ".#.#.#.", ".#.#.#."],
  // A clock face: a prompt that runs on a schedule.
  routines: [".#####.", "#.....#", "#..#..#", "#..##.#", "#.....#", "#.....#", ".#####."],
  // Four tiles kept together: related chats grouped in a project.
  projects: ["###.###", "#.#.#.#", "###.###", ".......", "###.###", "#.#.#.#", "###.###"],
  // A ruled grid: a spreadsheet read on this device.
  sheets: ["#######", "#..#..#", "#######", "#..#..#", "#######", "#..#..#", "#######"],
  // A chip with its pins: a model running on this device.
  device: [".#.#.#.", "#######", ".#...#.", "##.#.##", ".#...#.", "#######", ".#.#.#."],
  // Two cards, one flipped behind the other: a study deck.
  study: ["..#####", "..#...#", "#####.#", "#...#.#", "#.#.###", "#...#..", "#####.."],
  // Two pages side by side: two versions of a document.
  compare: ["###.###", "#.#.#.#", "###.###", "#.#.#.#", "#.#.###", "#.#.#.#", "###.###"],
  // A pen writing on a line: a canvas.
  canvas: [".....##", "....#.#", "...#.#.", "..#.#..", ".###...", "##.....", "#######"],
  // A screen on its stand, showing a title and a line: a slide deck.
  slides: ["#######", "#.....#", "#.###.#", "#.....#", "#######", "...#...", "..###.."],
  // 文 and A: a document in another language.
  translate: [".#.....", "###..#.", ".#..#.#", "#.#.###", "....#.#", "....#.#", "......."],
  // A microphone on its stand: a recording turned into notes.
  notes: ["..###..", "..###..", "#.###.#", "#.###.#", ".#...#.", "..###..", ".#####."],
  // An arrow into a tray: a chat history brought in.
  import: ["...#...", "...#...", ".#.#.#.", "..###..", "...#...", "#.....#", "#######"],
  // A picture in a frame: a sun over a hill. Photo tools.
  photos: [".......", "#######", "#...#.#", "#.....#", "#..#..#", "#.###.#", "#######"],
  // A magnifier over a line of text: a question asked across saved files.
  filesearch: [".####..", "#....#.", "#.##.#.", "#....#.", ".####..", "....##.", ".....##"],
  // A face: two eyes and a smile in a round head. Characters.
  characters: [".#####.", "#.....#", "#.#.#.#", "#.....#", "#.#.#.#", "#..###.", ".#####."],
  // A page with a black bar across its text: a PDF redacted.
  pdfredact: ["#####..", "#...##.", "#.....#", "#.###.#", "#.###.#", "#.....#", "#######"],
  // A screen with a line of caption under it: subtitles.
  subtitles: ["#######", "#.....#", "#.....#", "#.....#", "#######", ".#####.", "......."],
  // A folder with a branch on it: a repo read file by file.
  repos: ["###....", "#######", "#.#...#", "#.#.#.#", "#.##..#", "#.#...#", "#######"],
  // A page in a window: a header bar, a banner and two blocks. Screenshot to site.
  screenshot: ["#######", "#.#.#.#", "#######", "#.....#", "#.###.#", "#.###.#", "#######"],
  // A page with a folded corner and its lines: a contract read line by line.
  contracts: ["#####..", "#...##.", "#.#..##", "#.....#", "#.###.#", "#.....#", "#######"],
  // Two speech bubbles facing each other: two models arguing a question.
  debate: ["####...", "#..#...", "####.##", "..#.#..", "....###", "....#..", "....###"],
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
    if (reducedMotion.matches) {
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
      type="button"
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
// Shown in place of an update that hasn't been released yet.
export function ComingSoon({ update }) {
  // An update open early to NYMA holders (NYMA Holder Program) says so.
  const early = update?.early === true && !update.released;
  return (
    <div className="coming-soon">
      <p className="eyebrow">
        {early ? "EARLY ACCESS FOR NYMA HOLDERS" : "COMING SOON"}
      </p>
      <h2>{update?.title || "Coming soon"}</h2>
      {update && <p className="coming-soon-tagline">{update.tagline}</p>}
      {update && (
        <ul>
          {update.points.map((p) => (
            <li key={p}>
              <Icon name="check" size={16} />
              {p}
            </li>
          ))}
        </ul>
      )}
      <Button to={early ? "/token" : "/roadmap"}>
        {early ? "What NYMA does" : "See what's coming"} <Icon name="arrow" />
      </Button>
    </div>
  );
}
// Use the same explicit label on every unreleased feature entry point.
export function SoonTag() {
  return <span className="soon-tag">Coming soon</span>;
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

// Shown where a wallet is needed but this browser has none (and WalletConnect
// isn't configured): phones and in-app browsers have no wallet extension, so
// the page says how to continue instead of only disabling the button. On a
// phone that's a wallet app's own browser, one tap away; on a computer, a
// wallet extension. Whole sentences, so the language switch translates them.
export function WalletMissing({ signIn = false }) {
  const here = globalThis.location?.href || "https://askanonyma.com/account/credits";
  if (!isMobileBrowser())
    return (
      <div className="wallet-missing">
        <Notice>
          No browser wallet found. Install a wallet extension such as MetaMask,
          then reload this page.
        </Notice>
      </div>
    );
  return (
    <div className="wallet-missing">
      <Notice>
        {signIn
          ? "This phone browser has no wallet. Open this page in your wallet app's browser to sign in with your wallet."
          : "This phone browser has no wallet. Open this page in your wallet app's browser, sign in there, and link your wallet from it."}
      </Notice>
      <div className="wallet-missing-links">
        {walletBrowserLinks(here).map((w) => (
          <a
            key={w.name}
            className="small-button"
            href={w.href}
            rel="noopener noreferrer"
          >
            {`Open in ${w.name}`}
            <Icon name="arrow" size={14} />
          </a>
        ))}
        <CopyButton text={here} label="Copy this page's link" />
      </div>
      <p className="fine-print">
        {signIn
          ? "Another wallet app? Paste the page link into its built-in browser."
          : "Another wallet app? Paste the page link into its built-in browser. Your wallet app keeps its own sign-in, so you sign in to ANONYMA again there."}
      </p>
    </div>
  );
}
// Whether this browser can sign with a wallet. Some wallet browsers inject
// window.ethereum just after the page loads and announce it with
// `ethereum#initialized`, so the answer is read again then.
export function useWalletAvailable(config) {
  const [, recheck] = useState(0);
  useEffect(() => {
    const again = () => recheck((n) => n + 1);
    window.addEventListener("ethereum#initialized", again, { once: true });
    return () => window.removeEventListener("ethereum#initialized", again);
  }, []);
  return walletAvailable(config);
}
