import { rankTools } from "./tool-search.js";
import { CONTINUE_PROMPT, replyBudgetFor, replyBudgets, completionNotice } from "./long-answers.js";
import { chatFailureMessage } from "./chat-control.js";
import { useReadingPosition, useRequestCharge, ChargeStatus } from "./ChatControl.jsx";
import HistoryLibrary from "./HistoryLibrary.jsx";
import { useBookmarks, bookmarksReleased } from "./Bookmarks.jsx";
import { useFindInChat, findInChatReleased } from "./FindInChat.jsx";
import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { VoiceAssist, ReadAloud } from "./VoiceAssist.jsx";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
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
import SignedReceipt from "./SignedReceipt.jsx";
import { Reveal } from "./ReferenceMotion.jsx";
import WorkspaceHome from "./WorkspaceHome.jsx";
import TaskTools from "./TaskTools.jsx";
// Local Sheets: its parser, planner checks and charts load only on its page.
const Sheets = lazy(() => import("./Sheets.jsx"));
// On-Device Model: its page, and the engine it starts, load only there.
const OnDevice = lazy(() => import("./OnDevice.jsx"));
// Study Mode: its reviewer, parser and deck storage load only on its page.
const Study = lazy(() => import("./Study.jsx"));
// Meeting Notes: its recording reader and notes view load only on its page.
const MeetingNotes = lazy(() => import("./MeetingNotes.jsx"));
// Chat Import: its reader, list and destinations load only on its page.
const ChatImport = lazy(() => import("./ChatImport.jsx"));
// Photo Tools: its page (and the code that shrinks and reads a photo) loads only there.
const PhotoTools = lazy(() => import("./PhotoTools.jsx"));
// File Search: its page loads only when opened.
const FileSearch = lazy(() => import("./FileSearch.jsx"));
// Document Compare: its reader, diff worker and redline load only on its page.
const Compare = lazy(() => import("./Compare.jsx"));
// Canvas: its editor, tracked changes and exports load only on its page.
const Canvas = lazy(() => import("./Canvas.jsx"));
// Slides: its editor, presenter, exports and deck storage load only on its page.
const Slides = lazy(() => import("./Slides.jsx"));
// Repo Reader: its page, file tree and viewer load only on its page.
const RepoReader = lazy(() => import("./RepoReader.jsx"));
// Translate Documents: its readers, part planner and exports load only on its page.
const Translate = lazy(() => import("./Translate.jsx"));
// Audio Overview's dialog and player, loaded only when opened.
const AudioOverviewDialog = lazy(() => import("./AudioOverview.jsx"));
// Summarize & Continue's dialog, loaded when Catch me up is first opened.
const CatchUpDialog = lazy(() => import("./CatchUpDialog.jsx"));
// Quote Cards' editor and its canvas drawing, loaded when a card is first made.
const QuoteCardDialog = lazy(() => import("./QuoteCards.jsx"));
import Routines from "./Routines.jsx";
import { WatchBadge } from "./PageWatch.jsx";
import Projects, { useProjects, ProjectsSidebar, ProjectBar, ProjectPicker, ProjectSwatch } from "./Projects.jsx";
import {
  projectsReleased,
  projectChatStart,
  withProjectInstructions,
  projectRequestFields,
  pinnedFilesBlocked,
  withPinnedDocuments,
  projectItems,
  projectChatPath,
  projectPagePath,
} from "./projects.js";
import AudioStudio, { MicButton } from "./AudioStudio.jsx";
import CollabHub from "./Collab.jsx";
import { VeilToggle, VeilPanel, veilRemarkPlugin } from "./Veil.jsx";
import { ReplyMarkdown } from "./RichMarkdown.jsx";
import DoubleCheck from "./DoubleCheck.jsx";
import {
  EphemeralToggle,
  EphemeralNotice,
  RetentionSelect,
  RetentionIndicator,
} from "./Ephemeral.jsx";
import { retentionChoiceFor } from "./ephemeral.js";
import {
  DeviceOnlyToggle,
  DeviceOnlyNotice,
  VaultSection,
  VaultDialog,
  useDeviceVault,
  vaultReleased,
} from "./DeviceVault.jsx";
import { vaultChat, vaultTitle } from "./device-vault.js";
import { useVaultSync, vaultSyncReleased } from "./VaultSync.jsx";
import { decoyReleased } from "./decoy-vault.js";
import {
  SealedToggle,
  SealedPanel,
  SealedReplyNote,
  sealedLiveFor,
  useSealedEnclave,
} from "./SealedMode.jsx";
import { sealedHoldUsd, sealedBody, ciphertextLength, utf8Length } from "./sealed.js";
import { rewindPlan, resendContent, promptParts, branchesAt, singleFlight } from "./branches.js";
import "./branches.css";
// Quote Cards: the Card button's style is needed before its dialog loads.
import "./quote-cards.css";
import "./chat-import-mark.css";
import {
  PrivateModeToggle,
  PrivateModeNotice,
  NoPrivateModelsNotice,
  PrivateModelTag,
  PrivateReplyNote,
  privateModeReleased,
} from "./PrivateMode.jsx";
import {
  TrainingTag,
  TrainingNotice,
  trainingTitle,
  untrainedAlternative,
  trainingLabelsReleased,
  useTrainingDismissals,
} from "./TrainingLabels.jsx";
import { LanguageSwitch } from "./LanguageSwitch.jsx";
import DocumentAttach, { DocumentChips, MessageDocuments } from "./Documents.jsx";
import { CleanImageChip } from "./CleanUploads.jsx";
import { RedactChipTools, RedactEditor, redactReleased } from "./Redact.jsx";
import { OcrChipTool, OcrDialog, ocrReleased } from "./LocalOcr.jsx";
import { replaceWithText } from "./ocr.js";
import { IMAGE_TYPES, IMAGE_LIMIT, HEIC_LIMIT, isHeicFile, withKeep } from "./clean-notes.js";
import { parseDocumentBlocks, MAX_DOCUMENTS } from "./documents.js";
import { useShieldLive, shieldReleased, ShieldPanel, ShieldPasteNotice, shieldMarkdown } from "./Shield.jsx";
import { scanText, scanDocument, shieldDocument, cleanText, LARGE_PASTE, pdfHiddenText } from "./shield.js";
import Symposium from "./Symposium.jsx";
import {
  BlindToggle,
  BlindBar,
  BlindTurn,
  BlindRankings,
  BlindEstimate,
  useBlindEstimate,
  blindReleased,
} from "./Blind.jsx";
import {
  blindPool,
  surprisePair,
  defaultPair,
  validPair,
  pairInPool,
  pendingBlind,
  applyBlindEvent,
  blindText,
  canVote,
  revealTurn,
  closeTurn,
  secureRandom,
} from "./blind.js";
import { ScrollsPanel, ScrollFillForm } from "./Scrolls.jsx";
import { MemoryPanel, MemoryUsedNote, useMemory } from "./Memory.jsx";
import { ShareDialog, sealedShareLive } from "./ShareLinks.jsx";
import { shareBlocked } from "./share-links.js";
import { ExportDialog, chatExportReleased } from "./ChatExport.jsx";
import { exportPlan } from "./chat-export.js";
import { PrivacyTrail, privacyTrailReleased } from "./PrivacyTrail.jsx";
import { MEMORY_MODES, MAX_FACT_LENGTH } from "./memory.js";
import { extractVariables } from "./scrolls.js";
import { useTeamPays } from "./Treasury.jsx";
import { LowBalanceBanner, LowBalanceRefusal } from "./BalanceAlerts.jsx";
import { InactivityWipeBanner } from "./InactivityWipe.jsx";
import { RecoveryKitNudge } from "./RecoveryKit.jsx";
import {
  api,
  ApiError,
  streamChat,
  readStore,
  saveStore,
  download,
  uid,
  messageFromServer,
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
  createVeilState,
  forgetVeilState,
  unveil,
  withoutSecrets,
} from "./veil.js";
import { buildChatRequest, cloneVeilState, formatCredits, quoteBody, REPLY_BUDGET } from "./estimate.js";
import { CreditEstimate, useCreditEstimate } from "./CreditEstimate.jsx";
import CostCompare from "./CostCompare.jsx";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import { SecretGuardNotice, useSecretGuard, useSecretScan } from "./SecretGuard.jsx";
import { maskComposer, maskSecrets, removeFromComposer, removeSecrets, scanParts, secretGuardTurn } from "./secret-guard.js";
import { LinkReaderChips } from "./LinkReader.jsx";
import { scanSecrets, isSoft, findSeedPhrase, SEED_MESSAGE } from "./seed-guard.js";
import { OnchainChip, MessageChainFacts, onchainReleased } from "./Onchain.jsx";
import { detectOnchain, chainFactsDocument, isChainFactsDocument } from "./onchain.js";
import ModelFinder from "./ModelFinder.jsx";
import { AUTO, readAuto, routeSealed, withAutoMode } from "./auto-model.js";
import { CHAT_SERVICE_OUTPUT } from "../data/chat-limits.js";
import { AutoChip, AutoEstimate, autoModelReleased, autoPoolFrom, autoTierList, useAutoChoices } from "./AutoModel.jsx";
import { STORAGE_KEY as MODEL_CHOICES, loadChoices, resolveChoice, withChoice, requestNeedsVision } from "./model-finder.js";
import { useShareTargetPrefill } from "./share-target.js";
import { InstallAppEntry } from "./InstallApp.jsx";
import { LivePreview, CodePanelTabs, useHtmlPreview } from "./LivePreview.jsx";
import { usePythonRunner, pythonReleased } from "./PythonRunner.jsx";
import { attachedFiles } from "./python-runner.js";
import { projectFiles, previewPages, PREVIEW_DEMO_REPLY } from "./live-preview.js";
import { EarlyTag } from "./Holders.jsx";
import { EarlyModelTag, earlyModelSuffix } from "./early-models.js";
import { isEarlyAccess } from "./holders.js";
import CommandPalette, { PaletteButton, usePalette } from "./CommandPalette.jsx";
import { PrivacyScreen, HideScreenButton, hideScreen } from "./PrivacyScreen.jsx";
import {
  paletteReleased,
  paletteActions,
  chatItems,
  modelItems,
  scrollItems,
  historySearchItem,
  insertIntoPrompt,
  recentStoreKey,
  MODEL_MODES,
} from "./command-palette.js";
import { useLanguage, setLanguage, getLanguage, t } from "./i18n.js";
import { CatchUpButton, CatchUpNudge, ContinuedBanner, CarriedSummary, catchupLive } from "./CatchUp.jsx";
import { catchupEligible, withCarriedSummary, checkCarriedSummary, chatLinkSearch } from "./catchup.js";
import {
  ResearchDetails,
  ResearchEstimate,
  ResearchPanel,
  ResearchProgress,
  ResearchToggle,
  researchBlock,
  researchLive as researchReleased,
  runResearch,
  stoppedReply,
  useResearchEstimate,
} from "./DeepResearch.jsx";
import { statusByModel, statusReleased, useModelStatus } from "./model-status.js";
import { ArenaAsk } from "./Arena.jsx";
import { arenaRanks, arenaReleased, saveArenaChoice, useArena } from "./arena.js";
import { ModelDownNotice } from "./StatusDot.jsx";
import {
  SharpenButton,
  SharpenPanel,
  loadSharpenModel,
  saveSharpenModel,
  sharpenBlock,
  sharpenLive,
  useSharpen,
  useSharpenEstimate,
} from "./Sharpen.jsx";
import { pickSharpener, sharpenPool } from "./sharpen.js";
import { overviewLive, chatSource, researchSource, documentSource } from "./audio-overview.js";
import { HighlightToolbar, FactCheckCard, highlightReleased, factCheckReleased } from "./HighlightAsk.jsx";
import { FACTCHECK_VEILED, MAX_CLAIM, factCheckUserText, hasVeilPlaceholder } from "./highlight-ask.js";
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
// Symposium runs are saved with their own conversation mode and have no
// thread view to open, so they stay out of the recent-conversations list
// and the workspace home.
// Auto Model: the reply budget select offers up to the service's ceiling;
// each model Auto picks gets the budget up to its own limit.
const AUTO_BUDGET_MODEL = { chatLimits: { maxOutputTokens: CHAT_SERVICE_OUTPUT } };
const recentConversations = (list) =>
  list.filter((c) => c.mode !== "symposium");
export function AppSidebar({
  active = "chat",
  demo = false,
  children,
  newConversation,
  open = false,
  onClose,
}) {
  const q = demo ? "?demo=1" : "";
  const { user, config } = useApp();
  const signedIn = !demo && user;
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolSearch, setToolSearch] = useState("");
  const primaryModes = ["chat", "image", "video"];
  const navigation = [
    ["home", "Home", "See your recent work, credit usage and account activity in one place."],
    ["chat", "Chat & reason"],
    ["uncensored", "Uncensored", "Chat with models from the uncensored collection. Choose the model that suits your conversation."],
    ["symposium", "Symposium", "Ask several models the same question, compare their answers and combine the best parts."],
    // On-Device Model: a chat mode, with the others.
    ["device", "On-device", "Download a small model to chat directly in your browser, without sending your prompts to a provider."],
    ["code", "Code & build", "Write, explain and debug code with AI. Keep generated files together as you build."],
    ["image", "Images"],
    ["video", "Video"],
    ["audio", "Voice & audio", "Turn text into spoken audio, or transcribe a recording into text."],
    ["collab", "Collab", "Work with other people in shared conversations. Invite your team to contribute in one place."],
    // Tools for your own documents and data.
    ["tools", "Task tools", "Use focused tools for research, writing and calculations without starting from a blank prompt."],
    ["sheets", "Sheets", "Explore spreadsheet data with questions, charts and tables. Calculations run on your device."],
    ["compare", "Compare docs", "Compare two documents to find changes and differences, with references back to the source text."],
    ["canvas", "Canvas", "Write and edit alongside AI. Review each suggested change before accepting it."],
    ["translate", "Translate docs", "Translate documents while keeping headings, lists and tables. Review the translation beside the original."],
    ["study", "Study", "Turn a document or conversation into flashcards and quizzes to practise what you have learned."],
    ["slides", "Slides", "Turn a prompt, document or chat into a slide deck. Edit, present or export it."],
    ["repos", "Repo Reader", "Paste a public GitHub repo and ask about it. Answers cite the exact files and lines."],
    ["notes", "Meeting notes", "Turn a recording into a timestamped transcript, key decisions and action items."],
    ["import", "Import chats", "Bring your ChatGPT or Claude history here. Choose which chats to keep and where they go."],
    ["photos", "Photo tools", "Edit a photo with words, remove its background or upscale it. See the price first."],
    ["filesearch", "Search files", "Ask one question across all your saved files. Every answer cites the file and the passage it came from."],
    ["routines", "Routines", "Schedule prompts to run automatically with spending limits. Read the results in your inbox."],
    ["projects", "Projects", "Group related chats, files and instructions in folders. Set defaults for each project."],
    ["library", "Your library", "Find and revisit the images, videos and audio you have created."],
  ]
    // Local Sheets, On-Device Model, Document Compare, Study Mode and
    // Canvas stay out of sight entirely until they're released.
    .filter(([id]) => id !== "sheets" || isReleased(config, "sheets"))
    .filter(([id]) => id !== "device" || isReleased(config, "ondevice"))
    .filter(([id]) => id !== "compare" || isReleased(config, "doccompare"))
    .filter(([id]) => id !== "translate" || isReleased(config, "doctranslate"))
    .filter(([id]) => id !== "study" || isReleased(config, "study"))
    .filter(([id]) => id !== "canvas" || isReleased(config, "canvas"))
    .filter(([id]) => id !== "slides" || isReleased(config, "slides"))
    .filter(([id]) => id !== "repos" || isReleased(config, "reporeader"))
    .filter(([id]) => id !== "notes" || modeReleased(config, "notes"))
    .filter(([id]) => id !== "import" || isReleased(config, "chatimport"))
    .filter(([id]) => id !== "photos" || modeReleased(config, "photos"))
    .filter(([id]) => id !== "filesearch" || modeReleased(config, "filesearch"))
    // Research Watch lives on the Routines page, so the tool says so once it's live.
    .map(([id, label, description]) =>
      id === "routines" && isReleased(config, "researchwatch") && isReleased(config, "deepresearch") && isReleased(config, "search")
        ? [id, label, "Schedule prompts and research watches to run automatically with spending limits. Read the results in your inbox."]
        : [id, label, description],
    );
  // Recompute translated matching when the language changes, even on Account pages.
  useLanguage();
  const toolAvailable = (id) => id === "models" || (id === "api" ? isReleased(config, "api") : modeReleased(config, id));
  const extraTools = [
    ["models", "Explore models", "Browse available models and compare their capabilities and prices."],
    ["api", "Developer API", "Connect your own apps and scripts to ANONYMA using an API key."],
  ];
  const toolResults = rankTools([
    ...navigation.filter(([id]) => !primaryModes.includes(id)),
    ...(toolSearch.trim() ? extraTools : []),
  ], toolSearch, t);
  const closeTools = () => { setToolsOpen(false); setToolSearch(""); };
  const toolLink = ([id, label, description]) => (
    <Link key={id}
      className={(active === id ? "active " : "") + (toolAvailable(id) ? "" : "locked")}
      aria-current={active === id ? "page" : undefined}
      to={toolAvailable(id) ? (id === "models" ? "/models" : id === "api" ? "/account/keys" + q : "/workspace/" + id + q) : "/roadmap"}
      onClick={() => { closeTools(); onClose?.(); }}>
      <PixelTile name={id} /><span><span>{label}</span>{description && <small className="workspace-tool-description">{description}</small>}</span>
      {toolAvailable(id) ? <>
        {isEarlyAccess(config, MODE_FEATURES[id]) && <EarlyTag />}
        {id === "routines" && <WatchBadge enabled={!!signedIn && isReleased(config, "pagewatch") && modeReleased(config, "routines")} />}
      </> : <SoonTag />}
      {active === id && <span className="nav-active-dot" />}
    </Link>
  );
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
      {newConversation}
      <div className="sidebar-group-label">WORKSPACE</div>
      <nav aria-label="Workspace navigation">
        {navigation.filter(([id]) => primaryModes.includes(id)).map(toolLink)}
        <button type="button"
          className={"more-tools-button" + (!primaryModes.includes(active) ? " active" : "")}
          aria-haspopup="dialog" aria-expanded={toolsOpen}
          onClick={() => setToolsOpen(true)}>
          <PixelTile name="tools" /><span>More tools</span>
          <WatchBadge enabled={!!signedIn && isReleased(config, "pagewatch") && modeReleased(config, "routines")} />
          <Icon name="plus" size={16} />
        </button>
      </nav>
      {toolsOpen && <Modal title="More tools" onClose={closeTools}>
        <div className="workspace-tool-directory">
          <label className="tool-search-label" htmlFor="workspace-tool-search">Find a tool</label>
          <input id="workspace-tool-search" type="search" placeholder="What do you want to do?" maxLength={256}
            value={toolSearch} onChange={e => setToolSearch(e.target.value)} />
          <div className="workspace-tool-grid">
            {toolResults.map(toolLink)}
          </div>
          {toolResults.length === 0 &&
            <p role="status">No tools match your search.</p>}
          {!toolSearch.trim() && <div className="workspace-tool-footer">
            <Link to="/models" onClick={() => { closeTools(); onClose?.(); }}><span>Explore models</span><small className="workspace-tool-description">Browse available models and compare their capabilities and prices.</small></Link>
            <Link to={isReleased(config, "api") ? "/account/keys" + q : "/roadmap"}
              onClick={() => { closeTools(); onClose?.(); }}><span>Developer API{!isReleased(config, "api") && <SoonTag />}</span><small className="workspace-tool-description">Connect your own apps and scripts to ANONYMA using an API key.</small></Link>
          </div>}
        </div>
      </Modal>}
      {children}
      <div className="sidebar-bottom">
        <Link to={"/account/credits" + q}>
          <PixelTile name="credits" />
          Credits
        </Link>
        {isReleased(config, "app") && <InstallAppEntry />}
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
  const { mode = "chat" } = useParams();
  const location = useLocation();
  const welcomeRef = useRef();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const demo = params.get("demo") === "1";
  const { models, user, connected, config, refresh } = useApp();
  const cleanLive = isReleased(config, "cleanuploads");
  // Redact Before You Send: black out parts of a composer image in this
  // browser; only the redacted copy replaces it (src/Redact.jsx).
  const redactLive = redactReleased(config);
  const [all, setAll] = useState(() =>
      demo ? readStore("conversations", initial) : [],
    ),
    [current, setCurrent] = useState(null),
    [messages, setMessages] = useState([]),
    [prompt, setPrompt] = useState(""),
    [legacyModel, setModel] = useState(params.get("model") || models[0]?.id || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [info, setInfo] = useState(""),
    [receipt, setReceipt] = useState(null),
    // Every chosen reference image. Clean Uploads can hold one back (no url)
    // until the user keeps its original; `attachments` are the ones Send uses.
    [imageItems, setAttachments] = useState([]),
    // The composer image open in the redaction editor, if any.
    [redacting, setRedacting] = useState(null),
    // Local OCR: the composer image whose text is being read, if any.
    [ocrItem, setOcrItem] = useState(null),
    [documents, setDocuments] = useState([]),
    [media, setMedia] = useState(() => (demo ? readStore("media", []) : [])),
    [dialog, setDialog] = useState(null),
    [menu, setMenu] = useState(false),
    [composerOptionsOpen, setComposerOptionsOpen] = useState(false),
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
    // Deep Research: null (off), "quick" or "thorough".
    [researchDepth, setResearchDepth] = useState(null),
    [replyBudget, setReplyBudget] = useState(8192),
    [veilOn, setVeilOn] = useState(() => loadVeilOn()),
    [veilWords, setVeilWords] = useState(() => loadVeilWords()),
    [veilNote, setVeilNote] = useState(null),
    [ephemeral, setEphemeral] = useState(false),
    // Device Vault: "Save on this device only". Sent off the record (so
    // `ephemeral` is on too) and kept encrypted in this browser instead.
    [deviceOnly, setDeviceOnly] = useState(false),
    [vaultChatId, setVaultChatId] = useState(null),
    [vaultDialog, setVaultDialog] = useState(null),
    // Edit, Regenerate & Branch Chats: where this conversation came from, the
    // branches cut from it, and the user message being edited in place.
    [lineage, setLineage] = useState({ parent: null, branches: [] }),
    // Summarize & Continue: the summary this chat carries, and where it came
    // from ({ summary, from, kind }), or null; and whether Catch me up is open.
    [carried, setCarried] = useState(null),
    [catchupOpen, setCatchupOpen] = useState(false),
    [editing, setEditing] = useState(null),
    // True while a branch is being made and its resend runs (see branchFlight).
    [branching, setBranching] = useState(false),
    [privateMode, setPrivateMode] = useState(false),
    // Sealed Mode: encrypted in this browser to a verified enclave, relayed
    // as ciphertext, never saved on the server (see src/SealedMode.jsx).
    [sealed, setSealed] = useState(false),
    [sealedModelId, setSealedModelId] = useState(""),
    // Blind Compare: on or off, the two models (or a surprise pair), Your
    // rankings, and the turn whose vote is being sent.
    [blindOn, setBlindOn] = useState(false),
    [blindPair, setBlindPair] = useState([]),
    [blindSurprise, setBlindSurprise] = useState(false),
    [blindRankings, setBlindRankings] = useState(false),
    [blindVoting, setBlindVoting] = useState(null),
    // Blind Arena: the question asked once after a vote ({ round }), and
    // whether its answer is being saved.
    [arenaAsk, setArenaAsk] = useState(null),
    [arenaSaving, setArenaSaving] = useState(false),
    [voiceOpen, setVoiceOpen] = useState(false),
    [readAloud, setReadAloud] = useState(null),
    // Double-check This: the index of the answer whose second-opinion panel is open.
    [checking, setChecking] = useState(null),
    [shared, setShared] = useState(null),
    [scrolls, setScrolls] = useState([]),
    [instructions, setInstructions] = useState({ body: "", enabled: false }),
    [scrollsPanel, setScrollsPanel] = useState(false),
    // Memory Across Models: the account's switch and facts, and the panel
    // (null, or { draft } when opened from "Remember" under a message).
    [memoryPanel, setMemoryPanel] = useState(null),
    // Share a Chat: null, or { conversation, blocked } for the Share dialog.
    [share, setShare] = useState(null),
    // Chat Export: null, or what the Export dialog exports (see openExport).
    [exporting, setExporting] = useState(null),
    // Audio Overview: null, or what its dialog offers (see openOverview).
    [overview, setOverview] = useState(null),
    // Quote Cards: null, or { text } (a selection) / { markdown } (a whole
    // reply), with the reply's model when it says.
    [card, setCard] = useState(null),
    [scrollFill, setScrollFill] = useState(null),
    [slashDismissedFor, setSlashDismissedFor] = useState(null),
    [slashIndex, setSlashIndex] = useState(0),
    // Command Palette: a request to open the composer's Saved files panel.
    [filesRequest, setFilesRequest] = useState(0),
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
    // One edit/regenerate/branch at a time; reset when the open chat changes.
    branchFlight = useRef(null),
    // Veil's tag<->value map for the open conversation. Keyed on a temporary
    // id until the server assigns a real conversationId (see send/openChat),
    // and never sent anywhere: see src/veil.js's local-only storage helpers.
    veilKeyRef = useRef("tmp-" + uid()),
    veilStateRef = useRef(loadVeilState(veilKeyRef.current)),
    // The open device-only chat's vault id and creation time, and the last
    // messages written to the vault (so reopening a chat doesn't rewrite it).
    vaultChatRef = useRef(null),
    vaultSavedRef = useRef(""),
    // Catch me up's last summary per chat, for this visit only (never stored).
    catchupResults = useRef(new Map());
  const teamPays = useTeamPays(config, shared, demo, current);
  // Device Vault (src/DeviceVault.jsx): for signed-in accounts once it and
  // Ephemeral Chats are released; never in the demo. Locking it (Lock, the
  // idle timer, closing the tab) closes any vault chat on screen.
  const vaultLive = !demo && !!user && vaultReleased(config);
  // Decoy Vault (src/decoy-vault.js): a second passphrase that opens a
  // separate, harmless vault. The workspace can't tell which one is open.
  const vault = useDeviceVault({
    enabled: vaultLive,
    account: user?.id,
    onLock: vaultLocked,
    decoy: vaultLive && decoyReleased(config),
  });
  // Vault Sync (src/VaultSync.jsx): the vault's end-to-end-encrypted copy
  // for the account's other devices, once released and turned on.
  const vaultSync = useVaultSync({
    enabled: vaultLive && vaultSyncReleased(config),
    account: user?.id,
    vault,
  });
  // Pages that describe where vault chats are kept (On-device, Projects)
  // say so honestly while sync is on.
  vault.synced = vaultSync.on;
  const validMode = [
    "home",
    "chat",
    "uncensored",
    "symposium",
    "code",
    "image",
    "video",
    "audio",
    "collab",
    "library",
    "tools",
    "routines",
    "projects",
  ].includes(mode) ||
    // Local Sheets' page: unknown until it's released (config still loading
    // counts as known, so it doesn't flash "not found").
    (mode === "sheets" && (!config || isReleased(config, "sheets"))) ||
    // On-Device Model's page, likewise.
    (mode === "device" && (!config || isReleased(config, "ondevice"))) ||
    // Study Mode's page likewise.
    (mode === "study" && (!config || isReleased(config, "study"))) ||
    // Document Compare's page, the same way.
    (mode === "compare" && (!config || isReleased(config, "doccompare"))) ||
    // And Canvas's.
    (mode === "canvas" && (!config || isReleased(config, "canvas"))) ||
    // And Slides'.
    (mode === "slides" && (!config || isReleased(config, "slides"))) ||
    // And Repo Reader's.
    (mode === "repos" && (!config || isReleased(config, "reporeader"))) ||
    // Translate Documents' page, likewise.
    (mode === "translate" && (!config || isReleased(config, "doctranslate"))) ||
    // Meeting Notes' page, the same way (it needs Voice & Audio too).
    (mode === "notes" && (!config || modeReleased(config, "notes"))) ||
    // Chat Import's page, likewise.
    (mode === "import" && (!config || isReleased(config, "chatimport"))) ||
    // Photo Tools' page, the same way (it needs Image Studio's models too).
    (mode === "photos" && (!config || modeReleased(config, "photos"))) ||
    // File Search's page, likewise (it needs Files and Documents too).
    (mode === "filesearch" && (!config || modeReleased(config, "filesearch")));
  // Chat, code and Uncensored all show text conversations; Uncensored keeps
  // its own curated models, which the other text modes leave out.
  const textMode = ["chat", "code", "uncensored"].includes(mode);
  // Injection Shield (src/Shield.jsx, src/shield.js): files attached to a
  // text message are scanned in this browser. What's sent is each file's
  // text as the user chose (invisible characters out by default, flagged
  // lines out if asked) and, by default, a notice that the files are data.
  // Nothing about a finding leaves the browser.
  const shieldView = useShieldLive(config);
  const shieldOn = shieldView && !demo && textMode;
  // Local OCR (src/LocalOcr.jsx): "Text only" on a composer image reads its
  // text in this browser; "Use text" swaps the image for that text as a
  // Documents attachment, so it's sent like any attached file (Shield's
  // "send as data", Veil's masking, Seed Guard). Text modes only: image and
  // video modes use images as references, not as something to read. Not in
  // the demo, which has no document attachments.
  const ocrLive = !demo && textMode && ocrReleased(config);
  const [shieldPrefs, setShieldPrefs] = useState({}),
    [sendAsData, setSendAsData] = useState(true),
    [shieldOpen, setShieldOpen] = useState(null),
    [pasteShield, setPasteShield] = useState(null);
  const shieldScans = useMemo(() => {
    const scans = new Map();
    if (shieldOn) for (const d of documents) scans.set(d.id, scanDocument(d));
    return scans;
  }, [shieldOn, documents]);
  const sentDocuments = useMemo(
    () =>
      shieldOn
        ? documents.map((d) => shieldDocument(d, shieldScans.get(d.id), shieldPrefs[d.id]))
        : documents,
    [shieldOn, documents, shieldScans, shieldPrefs],
  );
  const documentsAsData = shieldOn && sendAsData && documents.length > 0;
  // Each message starts again with "Send as data" on. A file's own choices
  // are kept by its id, so a send that's refused and put back keeps them.
  useEffect(() => {
    if (documents.length) return;
    setSendAsData(true);
    setShieldOpen((o) => (o?.doc ? null : o));
  }, [documents.length]);
  useEffect(() => {
    if (!prompt) setPasteShield(null);
  }, [prompt]);
  // Projects (src/Projects.jsx): the account's projects, and the one the open
  // chat is in (or a new chat was started in). Signed in only, never the demo.
  const projectsLive = !demo && !!user && projectsReleased(config);
  // Chat Import: the service the open chat was brought from, if it was
  // (a saved chat says so when it opens; a vault chat carries it inside).
  const importedFrom = !demo && isReleased(config, "chatimport")
    ? (vaultChatId ? vault.chats.find((c) => c.id === vaultChatId)?.importedFrom : current ? lineage.imported : null) || null
    : null;
  const projects = useProjects(projectsLive, user?.id);
  const [projectId, setProjectId] = useState(null),
    // The sidebar's chat filter: "all", "none" or a project id.
    [chatFilter, setChatFilter] = useState("all"),
    // Bumped whenever a fresh chat starts, so its pinned files attach.
    [freshKey, setFreshKey] = useState(0),
    // A Device only project chat waiting for the vault's state to load.
    [vaultPrompt, setVaultPrompt] = useState(false);
  const project = projectsLive && textMode ? projects.byId(projectId) : null;
  // Scrolls (saved prompts, "/" insert and standing instructions) work in
  // every text mode: chat, code and Uncensored.
  const chatControlLive = !demo && textMode && isReleased(config, "chatcontrol");
  const reading = useReadingPosition({ enabled: chatControlLive, end: streamEnd, composer: composerZone, messages, busy });
  const charge = useRequestCharge(chatControlLive);
  const scrollsLive = !demo && isReleased(config, "scrolls");
  // Sealed Mode (src/SealedMode.jsx): chat and code, signed in, once it's
  // released with its billing configured. It offers only the open-weight
  // enclave models the server marks sealed, and verifies the enclave in this
  // browser before anything is sent.
  const sealedAvailable =
    !demo && !!user && sealedLiveFor(config) && ["chat", "code"].includes(mode);
  const sealedOn = sealedAvailable && sealed;
  // Link Reader (src/LinkReader.jsx): "Read this page" for a link in the
  // prompt, in every text mode, once it and Documents (whose attach format
  // it uses) are released. Signed in only: the server does the fetching.
  const linkCardsLive = isReleased(config, "linkreader") && isReleased(config, "documents");
  const linkLive = !demo && !!user && textMode && linkCardsLive;
  const sealedModels = useMemo(
    () => models.filter((m) => m.type === "chat" && m.sealed),
    [models],
  );
  const sealedTarget =
    sealedModels.find((m) => m.id === sealedModelId) ||
    // A fast, inexpensive enclave model first when it's offered.
    sealedModels.find((m) => m.id === "private/glm-5-3-flash") ||
    sealedModels[0] ||
    null;
  const enclave = useSealedEnclave(sealedOn);
  // A thread written in Sealed Mode (a Device Vault chat) only ever goes on
  // sealed, and nothing in it is sent anywhere unsealed.
  const sealedThread = messages.some((x) => x.sealed);
  const uncensoredIds = config?.releases?.uncensoredModels || [];
  // Blind Compare (src/Blind.jsx): chat, code and Uncensored, signed in,
  // never in the demo, a shared chat or Sealed Mode.
  const blindLive = !demo && !!user && blindReleased(config) && textMode;
  const blindActive = blindLive && blindOn && !sealedOn && !sealedThread && !shared;
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
  const trainingLive = !demo && trainingLabelsReleased(config);
  const [trainingDismissed, dismissTraining] = useTrainingDismissals();
  // Model Finder & Presets (src/model-finder.js): Cheap / Balanced / Best
  // quality presets and a searchable list, remembered per mode in this
  // browser. While it's unreleased the plain model select stays as it was.
  const longAnswersLive = isReleased(config, "longanswers");
  const finderLive = isReleased(config, "finder");
  // Auto Model (src/AutoModel.jsx): whether Auto is chosen in each text
  // section, and how it picks (Account → Settings), in this browser.
  const [autoChoices, setAutoChoices] = useAutoChoices();
  // A ?model= link picks its model for this visit, over Auto, until Auto
  // is chosen again.
  const [modelLinked, setModelLinked] = useState(() => !!params.get("model"));
  const [modelChoices, setModelChoices] = useState(() => {
    const saved = loadChoices(readStore);
    // A ?model= link picks the model for this visit without remembering it.
    const linked = params.get("model");
    return linked ? withChoice(saved, mode, { model: linked }) : saved;
  });
  const instructionsActive =
    scrollsLive && instructions.enabled && !!instructions.body.trim();
  // Standing instructions (Scrolls), then the project's own: the one leading
  // system message on every request in this chat, masked by Veil like the rest.
  // A chat continued fresh (Summarize & Continue) leads with the summary it
  // carries, in the same system message, so Veil masks it with the rest.
  const sentInstructions = withCarriedSummary(
    withProjectInstructions(instructionsActive ? instructions.body.trim() : "", project),
    carried?.summary,
  );
  // Memory Across Models goes with chat, code and Uncensored messages once
  // switched on, never off the record, in Private Mode or in a shared chat
  // (the server refuses those too; see server/routes/memory.js).
  const memoryLive = !demo && !!user && isReleased(config, "memory");
  // Share a Chat: a read-only snapshot link for a saved personal chat. Off
  // the record, Private Mode and collab chats say why they can't be shared
  // (the server refuses them too; see server/routes/shares.js).
  const sharesLive = !demo && !!user && isReleased(config, "sharelinks");
  // Sealed Share: links sealed in this browser, and the only way to share a
  // Device-only chat (never one that ran in Private Mode).
  const sealedLive = sharesLive && sealedShareLive(config);
  const shareModelName = (id) => models.find((m) => m.id === id)?.name || id;
  function openShare() {
    const saved = all.find((c) => c.id === current);
    const blocked = shareBlocked({
      saved: deviceOnly ? !!vaultChatId : !!current,
      ephemeral,
      privateMode,
      deviceOnly,
      collab: !!shared,
      mode,
      sealed: sealedLive,
    });
    setShare({
      conversation:
        current && !deviceOnly
          ? { id: current, title: saved?.title || "", expires: saved?.expires ?? null }
          : null,
      // What this browser holds of a Device-only chat: sealed here, never
      // sent readable.
      device:
        deviceOnly && !blocked
          ? { messages: messages.filter((m) => !m.sample) }
          : null,
      blocked,
    });
  }
  // Chat Export: download one chat as Markdown, JSON or a printable page,
  // built in this browser (src/ChatExport.jsx). A saved chat is read back
  // from the server; off the record, Private Mode, device-only and unsaved
  // chats are exported as they are on screen, with no request.
  const exportLive = !demo && !!user && chatExportReleased(config);
  // Study Mode: the header's "Study" link for a saved chat.
  const studyLive = !demo && !!user && isReleased(config, "study");
  // Slides: the header's "Slides" link for a saved chat.
  const slidesLive = !demo && !!user && isReleased(config, "slides");
  const modelName = (id) => models.find((x) => x.id === id)?.name || id;
  function openExport() {
    const plan = exportPlan({ id: current, ephemeral, privateMode, deviceOnly });
    setExporting({
      ...plan,
      id: plan.source === "server" ? current : null,
      mode,
      messages: plan.source === "screen" ? messages : undefined,
      collab: shared ? { name: shared.name } : null,
      // A copy of this chat's Veil map, used only if restoring is chosen.
      veilMap: { ...veilStateRef.current.map },
    });
  }
  // Audio Overview (src/AudioOverview.jsx): a two-voice audio briefing of
  // this chat, a Deep Research report in it or an attached document, in
  // every text mode, never in Sealed Mode (whose chats never leave the
  // enclave unsealed). A chat that's never saved makes an overview that
  // isn't either; Private Mode says it's unavailable.
  const overviewOn = !demo && !!user && overviewLive(config) && !sealedOn && !sealedThread;
  function openOverview(report = null) {
    const shown = messages.filter((m) => !m.sample);
    const reports = shown.filter((m) => m.role === "assistant" && m.research && !m.research.live && m.content);
    const title = all.find((c) => c.id === current)?.title || "";
    setOverview({
      sources: [
        ...(report ? [researchSource(report)] : []),
        chatSource(shown, title),
        ...reports.filter((m) => m !== report).map(researchSource),
        ...documents.filter((d) => d.text?.trim()).map(documentSource),
      ],
      offRecord: deviceOnly
        ? "This chat is kept only on this device, so its overview isn't saved anywhere either."
        : ephemeral
          ? "This chat is off the record, so its overview is too."
          : null,
    });
  }
  // From History & library or a conversation's details: always a saved chat.
  const exportSaved = (c) =>
    setExporting({
      source: "server",
      reason: null,
      id: c.id,
      mode: c.mode || "chat",
      veilMap: loadVeilState(c.id).map,
    });
  const memoryExcluded = !memoryLive
    ? ""
    : sealedOn || sealedThread
      ? "Sealed Mode: memory isn't used or saved in this chat."
      : blindActive
      ? "Blind: memory isn't used when two models answer."
      : privateMode
      ? "Private Mode: memory isn't used or saved in this chat."
      : ephemeral
        ? "Off the record: memory isn't used or saved in this chat."
        : shared
          ? "Shared chat: memory isn't used here, so other members never see your facts."
          : !MEMORY_MODES.includes(mode)
            ? "Memory is used in chat, code and Uncensored."
            : "";
  const memoryScope = memoryLive && !memoryExcluded ? `${user.id}:${current || "new"}:${mode}` : null;
  const memoryClient = useMemory(memoryScope);
  const memory = memoryClient.memory;
  useEffect(() => { setMemoryPanel(null); }, [memoryScope]);
  const memoryUse =
    memoryLive && memory.enabled && !memoryExcluded && memory.facts.some((f) => f.enabled);
  const memoryFacts = memoryUse ? memory.facts : null;
  // "Remember" under your own message in a saved personal chat: opens Memory
  // with a draft from it. Never off the record, in Private Mode or shared.
  const rememberButton = (m) =>
    memoryLive &&
    m.role === "user" &&
    typeof m.content === "string" &&
    !m.sample &&
    current &&
    !shared &&
    !ephemeral &&
    !privateMode &&
    !sealedOn &&
    !memoryExcluded &&
    !busy ? (
      <button
        type="button"
        className="memory-remember"
        title="Save a fact from this message to your memory"
        onClick={() =>
          setMemoryPanel({
            draft: { text: promptParts(m.content).typed.slice(0, MAX_FACT_LENGTH), source: current },
          })
        }
      >
        <Icon name="memory" size={13} />
        Remember
      </button>
    ) : null;
  const attachments = useMemo(() => imageItems.filter((a) => a.url), [imageItems]);
  // Quote and Send retain image history; capability follows that exact context.
  const needsVision = textMode && requestNeedsVision(buildChatRequest({
    messages, attachments,
    preserveHistory: longAnswersLive,
    instructions: sentInstructions,
  }).request);
  const finderModels = needsVision ? visibleModels.filter((m) => m.vision) : visibleModels;
  // Blind Compare's models here: this section's, private ones in Private
  // Mode, and ones that read images when the chat has some.
  const blindModels = blindPool(models, {
    mode,
    privateMode,
    needsVision,
    uncensored: uncensoredIds,
  });
  const blindPoolKey = blindModels.map((m) => m.id).join(" ");
  const blindTargets = blindPair.map((id) => models.find((m) => m.id === id)).filter(Boolean);
  const finderOpts = useMemo(
    () => ({ mode, privateMode: textMode && privateMode, needsVision, avoidTraining: trainingLive && !privateMode, demo }),
    [mode, textMode, privateMode, needsVision, trainingLive, demo],
  );
  const resolvedModel = finderLive
    ? resolveChoice(modelChoices[mode], finderModels, models, finderOpts)
    : null;
  // One synchronous selection drives the picker, quote and Send. An empty
  // eligible pool must clear the send target instead of retaining an old model.
  const model = finderLive ? resolvedModel?.model?.id || "" : legacyModel;
  const selected = models.find((m) => m.id === model);
  // Model Status: a dot beside each model in the picker, and a notice when
  // the chosen one is down. Public, aggregated numbers (GET /api/status);
  // never in the demo, whose models aren't called.
  const statusLive = !demo && statusReleased(config);
  const { report: statusReport } = useModelStatus(statusLive);
  const modelStatus = useMemo(() => (statusLive ? statusByModel(statusReport) : null), [statusLive, statusReport]);
  // Blind Arena: an "Arena #3" badge beside ranked models in the picker, and
  // the question after a Blind vote. The board is public (GET /api/arena);
  // never in the demo.
  const arenaLive = !demo && arenaReleased(config);
  const { board: arenaBoard } = useArena(arenaLive);
  const arenaRank = useMemo(() => (arenaLive ? arenaRanks(arenaBoard) : null), [arenaLive, arenaBoard]);
  // Another chat on screen: the question goes (unanswered, it stays at no).
  useEffect(() => setArenaAsk(null), [current]);
  // Auto Model, once released: signed in, in chat, code and Uncensored,
  // never the demo (whose models aren't called). The models it may use here
  // are the picker's own (this section, Private Mode, images), less any that
  // are Down; the server checks the same again when it chooses.
  const autoLive = !demo && !!user && textMode && autoModelReleased(config);
  const autoChosen = autoLive && !modelLinked && autoChoices.modes[mode] === true;
  const autoPool = useMemo(
    () => (autoLive ? autoPoolFrom(finderModels, modelStatus) : []),
    [autoLive, finderModels, modelStatus],
  );
  const autoTiers = useMemo(() => autoTierList(autoPool), [autoPool]);
  const autoRequest = { prefer: autoChoices.prefer, helper: autoChoices.helper };
  const selectedDown =
    !autoChosen && modelStatus && selected && modelStatus[selected.id]?.status === "down" ? selected : null;
  // Training Labels: flag models whose provider trains on prompts, and
  // offer the listed version that doesn't. Private mode never lists them.
  const trainingSelected =
    !autoChosen &&
    trainingLive &&
    textMode &&
    !privateMode &&
    selected?.trainsOnPrompts &&
    visibleModels.some((m) => m.id === selected.id) &&
    !trainingDismissed.includes(selected.id)
      ? selected
      : null;
  const trainingAlternative = trainingSelected
    ? untrainedAlternative(trainingSelected, visibleModels)
    : null;

  function chooseModel(choice) {
    setModelChoices((prev) => withChoice(prev, mode, choice));
    // Only what the person chose is remembered, never a fallback.
    if (!demo) saveStore(MODEL_CHOICES, withChoice(loadChoices(readStore), mode, choice));
    // Choosing a model or preset turns Auto off for this section.
    if (autoChoices.modes[mode]) setAutoChoices(withAutoMode(autoChoices, mode, false));
    setQuote(null);
  }
  // Auto Model: "Auto" at the top of the picker, remembered per section in
  // this browser, like the model choice it replaces.
  function chooseAuto() {
    setModelLinked(false);
    setAutoChoices(withAutoMode(autoChoices, mode, true));
    setQuote(null);
  }
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
    charge.reset();
    reading.reset();
    setVoiceOpen(false);
    setReadAloud(null);
    setQuote(null);
    setPrompt(location.state?.prompt || "");
    setWebSearch(!!location.state?.web);
    setResearchDepth(null);
    setAttachments([]);
    setDocuments([]);
    setCurrent(null);
    setMessages([]);
    setMenu(false);
    veilKeyRef.current = "tmp-" + uid();
    veilStateRef.current = loadVeilState(veilKeyRef.current);
    setVeilNote(null);
    vaultChatRef.current = null;
    vaultSavedRef.current = "";
    setVaultChatId(null);
    setProjectId(null);
    setBlindOn(false);
  }, [mode, demo]);
  // Blind Compare: keep the pair to models still offered here (Private Mode,
  // images in the chat and the section all narrow it).
  useEffect(() => {
    if (!blindActive || pairInPool(blindPair, blindModels)) return;
    setBlindPair(defaultPair(blindModels, selected));
    setBlindSurprise(false);
  }, [blindActive, blindPoolKey]);
  // Share-to-ANONYMA: prefill the composer from a share_target request
  // (public/manifest.webmanifest) and drop the params from the URL. Runs
  // after the reset above so a shared prompt survives it.
  useShareTargetPrefill({
    mode,
    search: location.search,
    setPrompt,
    onConsumed: (search) => navigate(location.pathname + search, { replace: true }),
    enabled: isReleased(config, "app"),
  });
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
        .then((r) => setAll(recentConversations(r.data)))
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
  // Voice panels belong to the signed-in account, like Memory and Saved files:
  // an account change closes them, which stops recording and device speech
  // and drops an untranscribed clip.
  useEffect(() => {
    setVoiceOpen(false);
    setReadAloud(null);
  }, [user?.id]);
  // The Share dialog belongs to the signed-in account too.
  useEffect(() => setShare(null), [user?.id]);
  useEffect(() => {
    if (chatControlLive) return;
    const end = streamEnd.current;
    if (!end) return;
    // The sticky composer covers the bottom of the viewport, so reserve its
    // height below the newest message when scrolling it into view.
    end.style.scrollMarginBottom =
      (composerZone.current?.offsetHeight || 0) + "px";
    end.scrollIntoView({ block: "nearest" });
  }, [messages, busy, chatControlLive]);
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
  // "New chat in project" (the Projects page, the Command Palette) arrives
  // as ?project=<id>: a fresh chat in that project, then the link is dropped
  // so a reload doesn't start another.
  const projectParam = params.get("project");
  useEffect(() => {
    if (!projectParam || !textMode || !projects.loaded) return;
    const next = new URLSearchParams(location.search);
    next.delete("project");
    const search = next.toString();
    navigate(location.pathname + (search ? "?" + search : ""), { replace: true });
    const p = projects.byId(projectParam);
    if (p) startProjectChat(p);
    else setError("That project wasn't found.");
  }, [projectParam, projects.loaded, mode]);
  // A Device only project chat asks to set up or unlock the vault. A browser
  // that can't keep a vault starts it off the record instead.
  useEffect(() => {
    if (!vaultPrompt || vault.status === "loading" || vault.status === "off") return;
    setVaultPrompt(false);
    if (!deviceOnly || vault.unlocked) return;
    if (vault.status === "unavailable") {
      setDeviceOnly(false);
      setInfo("This browser can't keep a Device Vault, so this chat is off the record instead.");
    } else setVaultDialog({ kind: vault.status === "none" ? "setup" : "unlock", then: "deviceOnly" });
  }, [vaultPrompt, vault.status]);
  // A project deleted elsewhere leaves the sidebar filter.
  useEffect(() => {
    if (!["all", "none"].includes(chatFilter) && projects.loaded && !projects.byId(chatFilter))
      setChatFilter("all");
  }, [projects.list, chatFilter]);
  // Projects: a fresh chat in a project gets its pinned files' text as
  // documents, only where Saved files work (not Private Mode, off the record,
  // Device only or with Veil on). Switching to one of those, leaving the
  // project or opening another chat drops them.
  const pinsLive = isReleased(config, "files") && isReleased(config, "documents");
  const pinsBlocked = pinnedFilesBlocked({
    privateMode,
    ephemeral,
    veilOn: veilOn && isReleased(config, "veil"),
  });
  useEffect(() => {
    const fresh = !!project && !current && !messages.length;
    if (!fresh || pinsBlocked || !pinsLive || !project.files.length) {
      setDocuments((d) => (d.some((x) => x.pinned) ? d.filter((x) => !x.pinned) : d));
      return;
    }
    let live = true;
    Promise.all(
      project.files.map((f) =>
        api("/api/files/" + encodeURIComponent(f.id) + "/text").then(
          (t) => ({ ...t, id: f.id }),
          () => null,
        ),
      ),
    ).then((list) => {
      if (!live) return;
      setDocuments((d) => withPinnedDocuments(d, list.filter(Boolean), uid));
      if (list.some((x) => !x))
        setInfo("A pinned file couldn't be attached. Its saved file may have expired.");
    });
    return () => {
      live = false;
    };
  }, [project?.id, current, pinsBlocked, freshKey]);
  // A bookmark's link (?c=…&m=…): once that chat has loaded, scroll its
  // message into view and mark it for a moment, however long the chat is.
  const jumpTo = params.get("m");
  const jumped = useRef(null),
    highlightTimer = useRef();
  const [highlight, setHighlight] = useState(null);
  useEffect(() => {
    if (!jumpTo || !linked || !textMode || demo || !user || !bookmarksReleased(config)) return;
    if (current !== linked || !messages.some((m) => m.id)) return;
    const key = linked + ":" + jumpTo;
    if (jumped.current === key) return;
    jumped.current = key;
    if (!messages.some((m) => m.id === jumpTo)) {
      setInfo("That bookmarked message is no longer in this chat.");
      return;
    }
    // Its start just below the top: the composer covers the bottom of the view.
    const target = document.querySelector(`[data-message-id="${CSS.escape(jumpTo)}"]`);
    if (target) {
      target.style.scrollMarginTop = "24px";
      target.scrollIntoView({ block: "start" });
    }
    setHighlight(jumpTo);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlight(null), 4000);
  }, [jumpTo, linked, current, messages, textMode, demo, user?.id]);
  // A vault chat opened from another section arrives here after the section
  // reset above. Its id travels in navigation state, never in the URL.
  const vaultRequest = location.state?.vaultChat;
  useEffect(() => {
    // The On-device page opens its own vault chats.
    if (!vaultRequest || mode === "device") return;
    const chat = vault.unlocked && textMode && vault.chats.find((c) => c.id === vaultRequest);
    if (chat && chat.mode === mode) openVaultChat(chat);
    navigate(location.pathname + location.search, { replace: true, state: null });
  }, [vaultRequest, mode, vault.unlocked]);
  // Device only: once a reply settles (or fails), the chat as shown is sealed
  // into the vault with its Veil map. Veil's plain-text copy of that map is
  // then dropped from this browser's storage.
  useEffect(() => {
    if (!deviceOnly || busy || !vault.unlocked || !textMode) return;
    const kept = messages.filter((m) => !m.sample);
    if (!kept.length) return;
    const snapshot = JSON.stringify(kept);
    if (snapshot === vaultSavedRef.current) return;
    vaultSavedRef.current = snapshot;
    let ref = (vaultChatRef.current ||= { id: uid(), created: Date.now() });
    // Vault Sync: another device changed this chat while a reply was
    // coming in here, so this version is kept beside it as a copy.
    if (ref.stale) {
      ref = vaultChatRef.current = { id: uid(), created: Date.now(), copy: true };
      setInfo("This chat changed on another device while you were writing here, so your version is kept as a separate copy.");
    }
    setVaultChatId(ref.id);
    const veilKey = veilKeyRef.current;
    const saving = Date.now();
    ref.updated = saving;
    vault
      .save(
        vaultChat({
          id: ref.id,
          created: ref.created,
          conflictCopy: !!ref.copy,
          ...(ref.imported ? { title: ref.imported.title, importedFrom: ref.imported.from, importKey: ref.imported.key } : {}),
          now: saving,
          mode,
          privateMode,
          sealed: sealedOn || sealedThread,
          messages: kept,
          // Secret Guard's values stay in memory, never in the vault.
          veil: withoutSecrets(veilStateRef.current),
          // Projects: grouped with its project inside the vault only.
          project: project?.id || null,
          // Summarize & Continue: the summary it carries, if continued fresh.
          carried: carried?.summary ? { summary: carried.summary, from: carried.from || null } : null,
        }),
      )
      .then(() => forgetVeilState(veilKey))
      .catch((e) => {
        vaultSavedRef.current = "";
        setError(e?.message || "This chat couldn't be saved to Device Vault.");
      });
  }, [deviceOnly, busy, vault.unlocked, messages]);
  // Vault Sync: when another device changes the vault chat open here, it
  // reloads while nothing is being sent; mid-reply, this tab's version is
  // kept as a copy when it's saved (above).
  useEffect(() => {
    const ref = vaultChatRef.current;
    if (!vault.remoteChanges.rev || !deviceOnly || !ref || !vault.unlocked) return;
    if (!vault.remoteChanges.ids.includes(ref.id)) return;
    const stored = vault.chats.find((c) => c.id === ref.id);
    if (!stored || stored.updated === ref.updated) return;
    if (busy) {
      ref.stale = true;
      return;
    }
    ref.updated = stored.updated;
    if (stored.veil) veilStateRef.current = cloneVeilState(stored.veil);
    vaultSavedRef.current = JSON.stringify(stored.messages);
    setMessages(stored.messages);
  }, [vault.remoteChanges.rev]);
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
    charge.reset();
    reading.reset();
    setVoiceOpen(false);
    setReadAloud(null);
    setChecking(null);
    if (linked) navigate("/workspace/" + mode + (demo ? "?demo=1" : ""));
    setShared(null);
    setLineage({ parent: null, branches: [] });
    setCarried(null);
    setCatchupOpen(false);
    setEditing(null);
    branchFlight.current?.reset();
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
    vaultChatRef.current = null;
    vaultSavedRef.current = "";
    setVaultChatId(null);
    setFreshKey((k) => k + 1);
  }
  // Projects: a new chat in a project starts the way the project says: its
  // default privacy mode (never saved when that's off the record, Private
  // Mode or Device only), its default model and its pinned files.
  function startProjectChat(p) {
    // Device only is this browser's own choice (the server stores it as
    // off the record), and needs Device Vault here.
    const start = projectChatStart(projects.privacyOf(p, vaultLive), {
      vault: vaultLive,
      privateMode: privateModeReleased(config),
    });
    newChat();
    setProjectId(p.id);
    setDocuments((d) => d.filter((x) => !x.pinned));
    setPrivateMode(start.privateMode);
    if (start.privateMode) setVeilOn(true);
    setDeviceOnly(start.deviceOnly);
    setEphemeral(start.ephemeral);
    // Device only asks to set up or unlock the vault once its state is known.
    if (start.deviceOnly && !vault.unlocked) setVaultPrompt(true);
    // The project's model, for this visit: the choice the picker remembers
    // in this browser is left as it was.
    const own = p.model && models.find((m) => m.id === p.model);
    if (own && (!start.privateMode || own.private)) {
      if (finderLive) setModelChoices((prev) => withChoice(prev, mode, { model: own.id }));
      else setModel(own.id);
    } else if (start.privateMode && !finderLive) setModel(privateModelsCallable[0]?.id || "");
  }
  // Out of the project before the first message: a plain new chat.
  function leaveProject() {
    setProjectId(null);
    setDocuments((d) => (d.some((x) => x.pinned) ? d.filter((x) => !x.pinned) : d));
  }
  // Moves a saved chat into a project, between projects or out of one.
  async function moveChat(c, to) {
    try {
      if (to)
        await api(`/api/projects/${encodeURIComponent(to)}/chats`, {
          method: "POST",
          body: { conversationId: c.id },
        });
      else if (c.project_id)
        await api(
          `/api/projects/${encodeURIComponent(c.project_id)}/chats/${encodeURIComponent(c.id)}`,
          { method: "DELETE" },
        );
      setAll((prev) => prev.map((x) => (x.id === c.id ? { ...x, project_id: to } : x)));
      setDialog((d) => (d?.item?.id === c.id ? { ...d, item: { ...d.item, project_id: to } } : d));
      if (c.id === current) setProjectId(to);
      projects.reload();
    } catch (e) {
      setError(e.message);
    }
  }
  // Off the record only ever applies to a fresh, unsaved thread: switching
  // it either way starts a new chat rather than mixing saved and unsaved turns.
  // From Device only it switches to plain off the record.
  function toggleEphemeral() {
    newChat();
    if (deviceOnly) {
      setDeviceOnly(false);
      setEphemeral(true);
      return;
    }
    setEphemeral((v) => !v);
  }
  // Device only: a fresh thread, sent off the record and kept in the vault.
  // Turning it on first sets up or unlocks the vault; turning it off goes
  // back to a saved chat (or stays off the record in Private Mode).
  function startDeviceOnly() {
    newChat();
    setDeviceOnly(true);
    setEphemeral(true);
  }
  function stopDeviceOnly() {
    newChat();
    setDeviceOnly(false);
    setEphemeral(privateMode || sealedOn);
  }
  function toggleDeviceOnly() {
    if (deviceOnly) return stopDeviceOnly();
    if (!vault.unlocked)
      return setVaultDialog({
        kind: vault.status === "none" ? "setup" : "unlock",
        then: "deviceOnly",
      });
    startDeviceOnly();
  }
  // Opens a vault chat where it was written (chat, code or Uncensored), with
  // its own Veil map and Private Mode setting.
  function openVaultChat(chat) {
    // An On-Device Model chat reopens only on its own page, never with a
    // server model (src/OnDevice.jsx picks it up from navigation state).
    if (chat.mode === "device") {
      setMenu(false);
      if (isReleased(config, "ondevice"))
        navigate("/workspace/device" + (demo ? "?demo=1" : ""), { state: { vaultChat: chat.id } });
      return;
    }
    // A device-only canvas opens on the Canvas page (src/Canvas.jsx).
    if (chat.mode === "canvas") {
      setMenu(false);
      if (isReleased(config, "canvas"))
        navigate("/workspace/canvas?" + new URLSearchParams({ ...(demo ? { demo: "1" } : {}), doc: chat.id }));
      return;
    }
    if (mode !== chat.mode) {
      navigate("/workspace/" + chat.mode, { state: { vaultChat: chat.id } });
      return;
    }
    newChat();
    veilKeyRef.current = "vault-" + chat.id;
    veilStateRef.current = chat.veil ? cloneVeilState(chat.veil) : createVeilState();
    vaultChatRef.current = {
      id: chat.id,
      created: chat.created,
      updated: chat.updated,
      copy: !!chat.conflictCopy,
      // Chat Import: an imported chat keeps its own title and its mark.
      imported: chat.importedFrom ? { title: chat.title, from: chat.importedFrom, key: chat.importKey || null } : null,
    };
    vaultSavedRef.current = JSON.stringify(chat.messages);
    setVaultChatId(chat.id);
    setDeviceOnly(true);
    setEphemeral(true);
    setProjectId(chat.project || null);
    const wasPrivate = !!chat.private && privateModeReleased(config);
    setPrivateMode(wasPrivate);
    if (wasPrivate) setVeilOn(true);
    // A sealed chat reopens sealed (and can only go on sealed; see send).
    setSealed(!!chat.sealed);
    // Summarize & Continue: a vault chat continued fresh keeps its summary
    // in the vault too.
    setCarried(chat.carried?.summary ? { ...chat.carried, kind: "vault" } : null);
    setMessages(chat.messages);
    setMenu(false);
  }
  function vaultLocked(reason) {
    if (!deviceOnly) return;
    // A deleted vault can't keep this chat: back to a saved chat.
    if (reason === "deleted") return stopDeviceOnly();
    newChat();
    if (reason === "idle") setInfo("Device Vault locked after being idle. Unlock it to continue.");
  }
  // Sealed Mode starts a fresh thread that's never saved on the server: kept
  // in Device Vault while it's unlocked, otherwise nowhere. It replaces
  // Private mode and turns off what would send anything unsealed.
  function toggleSealed() {
    newChat();
    const next = !sealed;
    setSealed(next);
    if (next) {
      setPrivateMode(false);
      setWebSearch(false);
      setBlindOn(false);
      setResearchDepth(null);
      setVoiceOpen(false);
      setAttachments([]);
      setDeviceOnly(vaultLive && vault.unlocked);
      setEphemeral(true);
    } else setEphemeral(deviceOnly);
  }
  // Private mode forces off the record on (private chats are never saved)
  // and Veil on, and narrows the model choice to private models — like Off
  // the record, switching it starts a fresh thread.
  function togglePrivateMode() {
    // Sealed Mode replaces Private mode while it's on.
    if (sealedOn) return;
    newChat();
    setPrivateMode((v) => {
      const next = !v;
      // Device only stays off the record when Private Mode goes off.
      setEphemeral(next || deviceOnly);
      if (next) {
        setVeilOn(true);
        setModel(privateModelsCallable[0]?.id || "");
      }
      return next;
    });
  }
  async function openChat(c) {
    controller.current?.abort();
    charge.reset();
    reading.reset();
    setReceipt(null);
    setBusy(false);
    setVoiceOpen(false);
    setReadAloud(null);
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
    setDeviceOnly(false);
    // A saved conversation is never sealed.
    setSealed(false);
    vaultChatRef.current = null;
    vaultSavedRef.current = "";
    setVaultChatId(null);
    setChecking(null);
    setCurrent(c.id);
    setProjectId(c.project_id ?? null);
    setMessages(c.messages || []);
    setLineage({ parent: null, branches: [] });
    setCarried(null);
    setCatchupOpen(false);
    setEditing(null);
    branchFlight.current?.reset();
    if (!demo) {
      try {
        const r = await api("/api/conversations/" + c.id);
        setCurrent(c.id);
        setShared(r.collab || null);
        setProjectId(r.project_id ?? null);
        // Chat Import: a chat brought from ChatGPT or Claude says so.
        setLineage({ parent: r.parent || null, branches: r.branches || [], imported: r.imported_from || null });
        setCarried(r.continued?.summary ? { ...r.continued, kind: "saved" } : null);
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
    if (files.length + imageItems.length > 8) {
      setError("Choose up to 8 reference images.");
      e.target.value = "";
      return;
    }
    if (cleanLive) return addCleanImages(files, e.target);
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
  // Clean Uploads: hidden details (location, camera, author) are removed in
  // this browser before an image is attached, and HEIC photos are converted
  // to JPEG. The cleaner loads only when an image is chosen.
  async function addCleanImages(files, input) {
    input.value = "";
    if (
      files.some((f) =>
        IMAGE_TYPES.includes(f.type) ? f.size > IMAGE_LIMIT : !isHeicFile(f) || f.size > HEIC_LIMIT,
      )
    ) {
      setError("Use PNG, JPEG, WebP or GIF images up to 1.5 MiB each, or HEIC photos up to 20 MiB.");
      return;
    }
    const { prepareImageAttachment } = await import("./clean-uploads.js");
    const prepared = await Promise.all(files.map((f) => prepareImageAttachment(f)));
    const problem = prepared.find((p) => p.error);
    if (problem) setError(problem.error);
    setAttachments((prev) => [...prev, ...prepared.filter((p) => !p.error)]);
  }
  // "@model-id your message" sends that one message to another chat model.
  const mentionQuery = textMode && !sealedOn && !blindActive
    ? prompt.match(/^@([^\s]*)$/)?.[1]
    : undefined;
  const mentionMatches =
    mentionQuery === undefined
      ? []
      : (finderLive ? finderModels : visibleModels)
          .filter((m) =>
            (m.id + " " + m.name).toLowerCase().includes(mentionQuery.toLowerCase()),
          )
          .slice(0, 6);
  const mention = textMode && !sealedOn && !blindActive
    ? prompt.trim().match(/^@(\S+)\s+([\s\S]+)$/)
    : null;
  const mentioned = mention
    ? visibleModels.find((m) => m.id.toLowerCase() === mention[1].toLowerCase())
    : null;
  const incompatibleMention = finderLive && mentioned && needsVision && !mentioned.vision;
  const target = mentioned || selected;
  // Deep Research (src/DeepResearch.jsx): offered where Web is (chat and
  // code, signed in, never the demo or Sealed Mode).
  const researchAvailable =
    !demo && !!user && researchReleased(config) && ["chat", "code"].includes(mode);
  const researchOn = researchAvailable && !!researchDepth && !sealedOn && !blindActive;
  // Auto answers a plain message. Blind, Deep Research and an @mention pick
  // their own models, and Sealed Mode routes in this browser (below).
  const autoActive = autoChosen && !sealedOn && !blindActive && !researchOn && !mentioned;
  // Beside the picker: Deep Research runs on the model Auto would give way to.
  const autoNote =
    autoChosen && researchOn && target ? (
      <>
        Deep Research doesn't use Auto. It runs on <span data-i18n="off">{target.name}</span>.
      </>
    ) : null;
  // Auto asks for the reply budget as chosen; each model gets it up to its
  // own limit.
  const selectedReplyBudget = autoActive
    ? longAnswersLive ? replyBudget : REPLY_BUDGET
    : longAnswersLive ? replyBudgetFor(target, replyBudget) : REPLY_BUDGET;
  // What a chat Send posts, shared with the credit estimate beside it.
  const sendText = mentioned ? mention[2].trim() : prompt.trim();
  const sendModel = autoActive ? AUTO : target?.id || model;
  // Sealed Mode: the most this message can hold, worked out here from the
  // sealed body's size exactly as the server bounds it. Never a server quote,
  // which would carry the prompt unsealed.
  // Auto in Sealed Mode: chosen in this browser by rules only, among the
  // sealed models (a helper would see the prompt unsealed). What's shown
  // here follows the composer; Send routes the request as it's sealed.
  const sealedAutoOn = sealedOn && autoModelReleased(config) && sealedModelId === AUTO;
  const sealedAutoPool = useMemo(
    () => sealedModels.filter((m) => modelStatus?.[m.id]?.status !== "down"),
    [sealedModels, modelStatus],
  );
  const sealedRoute = useMemo(() => {
    if (!sealedAutoOn) return null;
    const { request } = buildChatRequest({
      messages,
      text: sendText,
      documents: sentDocuments,
      asData: documentsAsData,
      instructions: instructionsActive ? instructions.body.trim() : "",
      preserveHistory: longAnswersLive,
    });
    return routeSealed({ messages: request, mode, prefer: autoChoices.prefer, pool: sealedAutoPool });
  }, [sealedAutoOn, messages, sendText, sentDocuments, documentsAsData, instructionsActive, instructions.body, longAnswersLive, mode, autoChoices.prefer, sealedAutoPool]);
  const sealedSend = sealedRoute?.model || sealedTarget;
  const sealedAutoTiers = useMemo(() => autoTierList(sealedAutoPool), [sealedAutoPool]);
  const sealedHoldCredits = useMemo(() => {
    const sealedTarget = sealedSend;
    if (!sealedOn || !sealedTarget) return null;
    const { request } = buildChatRequest({
      messages,
      text: sendText,
      documents: sentDocuments,
      asData: documentsAsData,
      instructions: instructionsActive ? instructions.body.trim() : "",
      preserveHistory: longAnswersLive,
    });
    const cap = sealedTarget.sealedOutputCap || 8192;
    const body = sealedBody({
      model: sealedTarget.id,
      messages: request,
      maxTokens: cap,
      cacheSecret: "0".repeat(64),
    });
    const bytes = ciphertextLength(utf8Length(JSON.stringify(body)));
    return sealedHoldUsd(sealedTarget, bytes, cap) * 1000 * (1 + (Number(config?.markup) || 0) / 100);
  }, [sealedOn, sealedSend, messages, sendText, sentDocuments, documentsAsData, instructionsActive, instructions.body, longAnswersLive, config?.markup]);
  const branchesLive = isReleased(config, "branches");
  // Live Preview (src/LivePreview.jsx): Code & Build's Preview tab and a
  // Preview button on HTML blocks in replies. Browser-only and sandboxed.
  const previewLive = isReleased(config, "preview");
  const [codeTab, setCodeTab] = useState(null);
  const htmlPreview = useHtmlPreview(previewLive && textMode);
  // Python Runner (src/PythonRunner.jsx): a Run button on Python blocks in
  // replies. The code runs in this browser with no network; the files it can
  // be given are the text files attached earlier in this conversation (with
  // Veil's placeholders restored in this browser), and only when ticked.
  const pythonLive = pythonReleased(config) && textMode;
  const pythonFiles = useMemo(
    () =>
      pythonLive
        ? attachedFiles(
            messages
              .filter((m) => m.role === "user" && typeof m.content === "string")
              .flatMap((m) => parseDocumentBlocks(m.content).documents)
              .map((d) => ({ ...d, text: unveil(d.text, veilStateRef.current.map) })),
          )
        : [],
    [pythonLive, messages],
  );
  const python = usePythonRunner({ enabled: pythonLive, base: htmlPreview.components, files: pythonFiles });
  if (!branchFlight.current) branchFlight.current = singleFlight();
  // Uses Symposium's orchestration, so both updates must be live; never in the demo.
  const doubleCheckLive =
    !demo && !!user && isReleased(config, "doublecheck") && isReleased(config, "symposium") &&
    !sealedOn && !sealedThread;
  // Privacy Trail: the chip under a reply, from the server's anonyma.privacy
  // (never in the demo, which sends nothing anywhere).
  const trailLive = !demo && privacyTrailReleased(config);
  // Bookmarks (src/Bookmarks.jsx): a star under each saved message of the
  // open chat, and links (?c=…&m=…) that open a chat at one message. Never
  // for a chat that isn't saved on the server.
  // Find in Chat (src/FindInChat.jsx): ⌘F / Ctrl+F or the header's Find
  // button searches the conversation on screen, in this browser only. Any
  // open chat (saved, Collab, off the record, Private, Device Vault, demo)
  // and a Symposium run; nothing is fetched, sent or charged.
  const [symposiumShown, setSymposiumShown] = useState(false);
  const find = useFindInChat({
    enabled: findInChatReleased(config),
    findable:
      modeReleased(config, mode) &&
      ((textMode && messages.length > 0) || (mode === "symposium" && symposiumShown)),
    config,
    resetKey: mode,
  });
  const bookmarksLive = !demo && !!user && bookmarksReleased(config);
  const bookmarks = useBookmarks({
    enabled: bookmarksLive && textMode && !ephemeral && !privateMode && !deviceOnly,
    account: user?.id,
    conversation: current,
    config,
    context: { mode, ephemeral, privateMode, deviceOnly, demo, busy: busy || branching },
  });
  // A check leaves the browser under the same Veil policy as a chat turn
  // (Private Mode forces Veil on): the question and answer are masked with
  // this conversation's map and the always-veil words, even when they were
  // written before Veil was switched on.
  const doubleCheckVeil = (veilOn || privateMode) && isReleased(config, "veil");
  const veilForCheck = (text) => {
    const r = veil(text, veilStateRef.current, veilWords);
    if (r.count && !deviceOnly) saveVeilState(veilKeyRef.current, veilStateRef.current);
    return r;
  };
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
    // A scroll chosen from the Command Palette joins what's already typed.
    const fromPalette = !!scrollFill?.fromPalette;
    setPrompt((p) => (fromPalette ? insertIntoPrompt(p, text) : text));
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
  // The /api/quote body for what a chat Send would post right now. Veil masks
  // it with a copy of the conversation's tag map: the same tags Send would
  // use, without recording any for a message that may never be sent.
  // `facts` lets Memory preview its facts before it is switched on.
  function estimateRequest(facts = memoryFacts) {
    const veiling = veilOn && !demo && isReleased(config, "veil");
    const { request, memory } = buildChatRequest({
      messages,
      text: sendText,
      attachments,
      documents: sentDocuments,
      asData: documentsAsData,
      instructions: sentInstructions,
      preserveHistory: longAnswersLive,
      veilWith: veiling
        ? { state: cloneVeilState(veilStateRef.current), words: veilWords }
        : null,
      memoryFacts: facts,
    });
    const body = quoteBody({
      model: sendModel,
      request,
      webSearch,
      maxTokens: selectedReplyBudget,
      treasury: teamPays.on,
      conversationId: current,
      memory,
      mode,
    });
    // Auto's estimate names no model: it's priced on the models this chat
    // may use (its section and Private Mode, as Send says them).
    if (!autoActive) return body;
    const { model: _chosen, ...rest } = body;
    return { ...rest, mode, auto: autoRequest, ...(privateMode ? { private: true } : {}) };
  }
  // Seed Guard: what Send would carry right now (the prompt, attached
  // documents' text and active standing instructions), scanned in this
  // browser. A find blocks Send, and the estimate too, since a quote posts
  // the same text, until the user removes it or confirms "Send anyway".
  const seedLive = seedGuardLive(config) && !demo;
  // Summarize & Continue (src/CatchUp.jsx): "Catch me up" in the header of
  // a chat, code or Uncensored chat long enough to need it (8 turns, or about
  // 6,000 tokens), never in Sealed Mode. A saved chat needs its id: it's what
  // a fresh chat links back to. The count isn't redone while a reply streams.
  const catchupReleased = !demo && !!user && catchupLive(config);
  const catchupFitRef = useRef(null);
  if (!busy) catchupFitRef.current = catchupReleased && textMode ? catchupEligible(messages) : null;
  const catchupStorage = deviceOnly ? "vault" : privateMode ? "private" : ephemeral ? "ephemeral" : "saved";
  const catchupOn =
    catchupReleased &&
    textMode &&
    !sealedOn &&
    !sealedThread &&
    !!catchupFitRef.current?.eligible &&
    (catchupStorage !== "saved" || !!current) &&
    (catchupStorage !== "vault" || vault.unlocked);
  const catchupKey = deviceOnly ? "vault:" + (vaultChatId || veilKeyRef.current) : current || veilKeyRef.current;
  // Continue fresh: a new chat, in the same place as this one (saved, Device
  // Vault, off the record or Private Mode) and the same project, whose
  // leading context is the summary as edited. With Veil on, the summary is
  // masked with this chat's map before it's kept or sent, and the new chat
  // gets a copy of that map so it's restored on screen. The original chat is
  // never changed.
  async function continueFresh(text) {
    const veiling = veilOn && !demo && isReleased(config, "veil");
    const state = cloneVeilState(veilStateRef.current);
    const summary = checkCarriedSummary(veiling ? veil(text, state, veilWords).text : text);
    if (seedLive && findSeedPhrase(summary)) throw new Error(SEED_MESSAGE);
    const saved = all.find((c) => c.id === current);
    if (catchupStorage === "saved") {
      // A shared chat isn't in this list: the server titles it from the source.
      const title = saved?.title ? `${t("Continued")} · ${saved.title}`.slice(0, 70) : undefined;
      const r = await api("/api/catchup/continue", {
        method: "POST",
        body: { from: current, summary, ...(title ? { title } : {}) },
      });
      if (Object.keys(state.map).length) saveVeilState(r.id, state);
      // The fresh chat opens from its own link (the ?c= effect above loads
      // it), so the address names it and a reload opens it, not the original.
      navigate(location.pathname + chatLinkSearch(location.search, r.id), { replace: true });
      api("/api/conversations")
        .then((list) => setAll(recentConversations(list.data)))
        .catch(() => {});
      if (project) projects.reload();
      return;
    }
    // Device Vault, off the record and Private Mode: in this browser only.
    // A vault chat is sealed into the vault with its first message. Such a
    // chat has no link of its own: newChat drops any ?c= from the address,
    // so a reload never reopens the original.
    const from =
      catchupStorage === "vault" && vaultChatId
        ? { id: vaultChatId, title: vaultTitle(messages, veilStateRef.current.map) }
        : null;
    newChat();
    veilStateRef.current = state;
    setCarried({ summary, from, kind: catchupStorage });
  }
  // A page read by Link Reader is public text our server fetched, not the
  // user's own, so it isn't scanned (the server skips it too). The rest are
  // the documents as they'll be sent (after Injection Shield's clean-up).
  const documentTexts = useMemo(
    () => sentDocuments.filter((d) => d.source !== "link").map((d) => d.text || ""),
    [sentDocuments],
  );
  const promptSeed = useSeedScan(seedLive, sendText);
  const documentSeed = useSeedScan(seedLive && textMode, documentTexts);
  const instructionsSeed = useSeedScan(
    seedLive && textMode && !!sentInstructions,
    sentInstructions,
  );
  const seedHit = promptSeed || documentSeed || instructionsSeed;
  const editSeed = useSeedScan(seedLive, editing?.text || "");
  // Secret Guard (src/SecretGuard.jsx): passwords, API keys and tokens in
  // the prompt and the attached text files and documents, found in this
  // browser (a page Link Reader fetched is public text and isn't scanned).
  // A find holds Send, and the estimate too, since a quote posts the same
  // text. Seed Guard's notice comes first; this one waits until it's
  // answered. Mask and send puts [SECRET_n] placeholders in the composer,
  // recorded in this chat's Veil map (in memory only: withoutSecrets keeps
  // them out of storage), so the reply shows the values again here.
  const secretLive = useSecretGuard(config, user, demo);
  const secretParts = useMemo(
    () => [
      { text: sendText },
      ...(textMode
        ? sentDocuments.filter((d) => d.source !== "link").map((d) => ({ text: d.text || "", name: d.name || "" }))
        : []),
    ],
    [sendText, sentDocuments, textMode],
  );
  const secretFinds = useSecretScan(secretLive, secretParts);
  const secretHeld = secretFinds.length > 0;
  const promptSecret = secretFinds.some((f) => f.part === 0);
  const [seedAnswered, setSeedAnswered] = useState(false);
  useEffect(() => setSeedAnswered(false), [sendText, documentTexts]);
  const guardTurn = secretGuardTurn({ seedHit, finds: secretFinds, seedAnswered });
  const [secretQueued, setSecretQueued] = useState(null);
  useEffect(() => {
    if (!secretQueued) return;
    setSecretQueued(null);
    send(null, null, secretQueued);
  }, [secretQueued]);
  function maskComposerSecrets() {
    const r = maskComposer({ prompt, documents }, veilStateRef.current);
    setPrompt(r.prompt);
    setDocuments(r.documents);
    // Sent on the next render, once the composer holds the masked text.
    setSecretQueued({ allowSeed: seedAnswered });
  }
  function removeComposerSecrets() {
    const r = removeFromComposer({ prompt, documents });
    setPrompt(r.prompt);
    setDocuments(r.documents);
  }
  const editFinds = useSecretScan(secretLive && !!editing, editing?.text || "");
  // Prompt Sharpen (src/Sharpen.jsx): rewrites the typed prompt with a fast
  // model, off the record. Only the prompt goes (never an @mention, the
  // chat, files, memory or instructions). Text modes, signed in, never the
  // demo or Sealed Mode.
  const sharpenAvailable =
    !demo && !!user && textMode && sharpenLive(config) && !sealedOn && !sealedThread;
  const [sharpenChoice, setSharpenChoice] = useState(loadSharpenModel);
  const sharpenPrivate = textMode && privateMode && privateModeReleased(config);
  const sharpenModels = useMemo(
    () => (sharpenAvailable ? sharpenPool(models, { privateMode: sharpenPrivate, inSection }) : []),
    // inSection depends only on the mode and the Uncensored list.
    [sharpenAvailable, models, sharpenPrivate, mode, uncensoredIds.join(",")],
  );
  const sharpenModel = pickSharpener(sharpenModels, sharpenChoice);
  const sharpen = useSharpen();
  const sharpenBlocked = sharpenBlock({
    length: sendText.length,
    seed: promptSeed,
    secret: promptSecret,
    model: sharpenModel,
    privateMode: sharpenPrivate,
  });
  const sharpenEstimate = useSharpenEstimate({
    enabled: sharpenAvailable && !busy && !sharpenBlocked,
    model: sharpenModel?.id,
    chars: sendText.length,
    privateMode: sharpenPrivate,
  });
  // A new sharpen of what's typed, or the last one again (Try again, or
  // with answers to its questions). Veil masks with a copy of this chat's
  // map, so the same detail gets the same tag and nothing is recorded.
  function runSharpen(again = null) {
    if (!sharpenModel) return;
    const veiling = veilOn && isReleased(config, "veil");
    sharpen.run({
      text: again ? sharpen.state.original : sendText,
      prefix: again ? sharpen.state.prefix : mentioned ? "@" + mentioned.id + " " : "",
      answers: again?.answers || [],
      model: sharpenModel.id,
      modelName: sharpenModel.name,
      privateMode: sharpenPrivate,
      veilWith: veiling ? { state: cloneVeilState(veilStateRef.current), words: veilWords } : null,
    });
  }
  function chooseSharpener(id) {
    saveSharpenModel(id);
    setSharpenChoice(id);
  }
  // Sending, another chat or mode, or Sealed Mode closes it.
  useEffect(() => {
    if (busy || !sharpenAvailable) sharpen.reset();
  }, [busy, sharpenAvailable]);
  useEffect(() => {
    sharpen.reset();
  }, [current, mode]);
  // Onchain Explainer: a transaction hash, address or explorer link in the
  // composer offers "Explain on-chain". Nothing leaves the browser until it's
  // pressed; then the server looks it up (free, read only) and the facts go
  // with the message as a Chain facts document, sent like any chat turn.
  // Not in Sealed Mode, whose relay must never learn what's being asked.
  const onchainLive =
    !demo && !!user && onchainReleased(config) && textMode && !sealedOn && !sealedThread &&
    // Blind Compare and Deep research send their own requests, which
    // carry no chain facts, so the chip waits until they're off.
    !blindActive && !researchOn;
  const onchainHit = useMemo(
    () => (onchainLive ? detectOnchain(sendText) : null),
    [onchainLive, sendText],
  );
  const onchainKey = onchainHit
    ? `${onchainHit.kind}:${onchainHit.value}:${onchainHit.chain ?? ""}`
    : null;
  const [onchainChoice, setOnchainChoice] = useState("auto");
  const [onchainLooking, setOnchainLooking] = useState(false);
  const [onchainError, setOnchainError] = useState("");
  const [onchainDismissed, setOnchainDismissed] = useState(null);
  useEffect(() => {
    setOnchainChoice(onchainHit?.chain ? String(onchainHit.chain) : "auto");
    setOnchainError("");
  }, [onchainKey]);
  const onchainShown = onchainHit && onchainDismissed !== onchainKey ? onchainHit : null;
  // A seed phrase or key still blocks; a bare 64-hex notice is answered by
  // choosing to explain it as a transaction.
  const onchainBlocked = !!seedHit && !isSoft(seedHit);
  async function explainOnchain() {
    const hit = onchainShown;
    if (!hit || busy || onchainLooking || onchainBlocked) return;
    setOnchainLooking(true);
    setOnchainError("");
    let facts;
    try {
      const chain = onchainChoice === "auto" ? "auto" : Number(onchainChoice);
      facts = (
        await api("/api/onchain/lookup", {
          method: "POST",
          body: { kind: hit.kind, value: hit.value, chain },
        })
      ).facts;
    } catch (err) {
      setOnchainError(err.message);
      return;
    } finally {
      setOnchainLooking(false);
    }
    await send(null, null, { allowSeed: !!seedHit, chainFacts: facts });
  }
  // Credit Estimates: a live estimate beside Send in chat, code and
  // Uncensored, whenever Send would go through. Image, video and Symposium
  // keep their own explicit pricing.
  const estimatesLive = isReleased(config, "estimates");
  const autoEstimate =
    !seedHit &&
    !secretHeld &&
    estimatesLive &&
    textMode &&
    !demo &&
    !!user &&
    !busy &&
    !branching &&
    !!sendText &&
    !incompatibleMention &&
    (autoActive || !!target?.callable) &&
    !!config?.services?.generation &&
    (autoActive || !(privateMode && !target?.private)) &&
    // Blind quotes both of its models instead (below).
    !blindActive &&
    // Deep research shows its own maximum instead.
    !researchOn &&
    // Sealed Mode never posts a prompt for an estimate (it would go unsealed).
    !sealedOn;
  const estimateBody = useMemo(
    () => (autoEstimate ? estimateRequest() : null),
    // Everything estimateRequest reads that can change between renders.
    [autoEstimate, sendText, sendModel, messages, attachments, sentDocuments, documentsAsData,
      sentInstructions, veilOn, veilWords, webSearch, current, teamPays.on, selectedReplyBudget, longAnswersLive, memoryFacts, mode,
      autoActive, autoChoices.prefer, autoChoices.helper, privateMode],
  );
  const estimate = useCreditEstimate(estimateBody);
  // Blind Compare: each reply's budget fits both models, and the estimate
  // beside Send is the same request quoted on both, added up.
  const blindBudget =
    longAnswersLive && blindTargets.length === 2
      ? Math.min(...blindTargets.map((m) => replyBudgetFor(m, replyBudget)))
      : REPLY_BUDGET;
  const blindReady = blindActive && validPair(blindPair, blindModels);
  const blindEstimateBody = useMemo(() => {
    if (!blindReady || seedHit || secretHeld || busy || branching || !sendText || !config?.services?.generation)
      return null;
    const veiling = veilOn && isReleased(config, "veil");
    const { request } = buildChatRequest({
      messages,
      text: sendText,
      attachments,
      documents,
      instructions: sentInstructions,
      preserveHistory: longAnswersLive,
      veilWith: veiling
        ? { state: cloneVeilState(veilStateRef.current), words: veilWords }
        : null,
    });
    return { models: blindPair, messages: request, max_tokens: blindBudget };
  }, [blindReady, seedHit, secretHeld, busy, branching, sendText, messages, attachments, documents,
    sentInstructions, veilOn, veilWords, longAnswersLive, blindPair.join(" "), blindBudget, config]);
  const blindEstimate = useBlindEstimate(blindEstimateBody);
  // The last turn is a comparison still waiting for its vote: the thread
  // goes on once the person has picked (or called it a tie or both bad).
  const blindAwaiting = blindLive && canVote(messages.at(-1)?.blind);
  // Cost Compare: from the estimate chip, the same request priced on other
  // models from the picker's pool. Not for an @mention, whose model isn't
  // the chat's to switch.
  const costCompareLive =
    estimatesLive && isReleased(config, "costcompare") && textMode && !demo && !!user;
  // Nor for Auto, which prices its own candidates.
  const compareBase = costCompareLive && !mentioned && !autoActive ? estimateBody : null;
  // Injection Shield on a paste: invisible characters come out of every
  // paste, and a long one (LARGE_PASTE) is checked for instruction-like
  // phrases. The paste is put in by hand so what lands is exactly what was
  // scanned; the notice above the composer can undo or act on it while the
  // pasted text is still there as it landed.
  function shieldPaste(e) {
    const raw = e.clipboardData?.getData("text/plain") || "";
    if (!raw) return;
    const pasted = raw.replace(/\r\n?/g, "\n");
    const long = pasted.length >= LARGE_PASTE;
    const result = scanText(pasted, { phrases: long });
    if (!result.invisible.total && !result.instructionCount) return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart ?? prompt.length,
      end = el.selectionEnd ?? start;
    const room = Math.max(0, (el.maxLength > 0 ? el.maxLength : Infinity) - (prompt.length - (end - start)));
    const inserted = cleanText(pasted, result).slice(0, room);
    setPrompt(prompt.slice(0, start) + inserted + prompt.slice(end));
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + inserted.length;
    });
    setPasteShield({ result, original: pasted, removed: result.invisible.total, at: start, inserted, long });
  }
  // Replaces the pasted text, if it's still there as it landed.
  function rewritePaste(next, changes = {}) {
    const p = pasteShield;
    if (!p) return;
    if (prompt.slice(p.at, p.at + p.inserted.length) !== p.inserted) {
      setError("The pasted text has changed since, so Shield left it as it is.");
      return;
    }
    const text = next(p).slice(0, Math.max(0, 48000 - (prompt.length - p.inserted.length)));
    setPrompt(prompt.slice(0, p.at) + text + prompt.slice(p.at + p.inserted.length));
    const report = { ...p, inserted: text, ...changes };
    if (changes.flagged === false) report.result = { ...p.result, instructionCount: 0, instructions: [] };
    setPasteShield(report.removed || report.result.instructionCount ? report : null);
  }
  // A long paste becomes an attached file, so it's scanned like one and sent
  // as data, and the prompt is left with only what the user typed.
  function attachPaste() {
    const p = pasteShield;
    if (!p) return;
    if (prompt.slice(p.at, p.at + p.inserted.length) !== p.inserted) {
      setError("The pasted text has changed since, so Shield left it as it is.");
      return;
    }
    const text = p.removed ? cleanText(p.original, p.result) : p.original;
    setPrompt(prompt.slice(0, p.at) + prompt.slice(p.at + p.inserted.length));
    setDocuments((d) =>
      d.length >= MAX_DOCUMENTS
        ? d
        : [...d, { id: uid(), name: "pasted-text.txt", kind: "text", size: null, text, chars: text.length, warning: "" }],
    );
    setPasteShield(null);
  }
  // Deep Research: only the typed question is sent. Veil is checked on it
  // with a copy of this chat's map, and anything masked stops the run (the
  // server refuses it too).
  const researchVeiling = veilOn && isReleased(config, "veil");
  const researchVeiled = useMemo(
    () =>
      researchOn && researchVeiling && sendText
        ? veil(sendText, cloneVeilState(veilStateRef.current), veilWords).count
        : 0,
    [researchOn, researchVeiling, sendText, veilWords, current],
  );
  const researchBlocked = researchOn
    ? researchBlock({ sealed: sealedOn, sealedThread, teamPays: teamPays.on, veiled: researchVeiled })
    : null;
  // The /api/research body (and its quote's): Memory as a chat would send
  // it, masked by Veil with the live map on Send and a copy for a quote.
  function researchRequest(live = false) {
    const { memory } = buildChatRequest({
      text: sendText,
      veilWith: researchVeiling
        ? { state: live ? veilStateRef.current : cloneVeilState(veilStateRef.current), words: veilWords }
        : null,
      memoryFacts,
    });
    return {
      model: sendModel,
      question: sendText,
      depth: researchDepth,
      mode,
      ...(ephemeral ? { ephemeral: true } : current ? { conversationId: current } : {}),
      ...(privateMode ? { private: true } : {}),
      ...(memory ? { memory } : {}),
      ...(trailLive ? { veil_masked: researchVeiling ? 0 : null } : {}),
      ...(projectsLive ? projectRequestFields(project, { ephemeral, conversationId: current }) : {}),
    };
  }
  const researchQuote =
    researchOn &&
    !researchBlocked &&
    !seedHit &&
    !secretHeld &&
    !busy &&
    !!sendText &&
    !!target?.callable &&
    !!config?.services?.generation &&
    !(privateMode && !target?.private);
  const researchQuoteBody = useMemo(
    () => (researchQuote ? researchRequest() : null),
    [researchQuote, sendText, sendModel, researchDepth, mode, ephemeral, privateMode, current, memoryFacts, veilWords, trailLive, project?.id],
  );
  const researchEstimate = useResearchEstimate(researchQuoteBody);
  // Highlight & Ask (src/HighlightAsk.jsx): selecting text in a reply offers
  // a quote in the composer (Ask about this, Explain, Simplify, Translate),
  // or a fact-check of just that text against the web. Fact-check follows
  // Web: chat and code, signed in, never the demo or Sealed Mode.
  const highlightLive = highlightReleased(config) && textMode;
  // Quote Cards (src/QuoteCards.jsx): a Card button on each finished reply and
  // on Highlight & Ask's toolbar. Everything happens in this browser, so it
  // works wherever there's a reply on screen: the demo, Sealed Mode and
  // device-only chats included.
  const cardsLive = isReleased(config, "quotecards") && textMode;
  const cardButton = (m, i) =>
    cardsLive &&
    m.role === "assistant" &&
    typeof m.content === "string" &&
    m.content.trim() &&
    !m.blind &&
    !m.factcheck &&
    !m.research?.live &&
    !(busy && i === messages.length - 1) ? (
      <button
        type="button"
        className="quote-card-open"
        title="Make an image card of this reply, on this device"
        onClick={() => setCard({ markdown: m.content, model: m.model || null })}
      >
        <Icon name="imagedown" size={13} />
        Card
      </button>
    ) : null;
  const threadRef = useRef(null);
  const factCheckLive =
    !demo && !!user && factCheckReleased(config) && ["chat", "code"].includes(mode) && !sealedOn && !sealedThread;
  const factVeiling = veilOn && isReleased(config, "veil");
  // Why a fact-check can't run right now, or null. The server refuses the
  // same things; its quote says why for anything else.
  function factCheckBlock(claim) {
    if (busy) return "Wait for the reply in progress to finish.";
    if (!target?.callable || !config?.services?.generation)
      return "This model is not currently available for generation.";
    if (privateMode && !target?.private) return "Choose a private model, or turn off Private mode.";
    if (deviceOnly && !vault.unlocked) return "Unlock Device Vault to keep chatting on this device only.";
    if (teamPays.on) return "A fact-check is paid from your own balance. Turn off Team pays to run it.";
    if (claim.length > MAX_CLAIM) return "Select a shorter passage to fact-check: up to 1,000 characters.";
    // A placeholder means Veil masked it earlier; with Veil on, anything it
    // would mask now counts too (checked on a copy of this chat's map).
    if (
      hasVeilPlaceholder(claim) ||
      (factVeiling && veil(claim, cloneVeilState(veilStateRef.current), veilWords).count)
    )
      return FACTCHECK_VEILED;
    return null;
  }
  // The /api/factcheck body (and its quote's): only the selected text, into
  // this chat as it's kept (saved, off the record, Private or Device only).
  const factCheckBody = (claim) => ({
    model: sendModel,
    claim,
    ...(ephemeral ? { ephemeral: true } : current ? { conversationId: current } : {}),
    ...(privateMode ? { private: true } : {}),
    ...(trailLive ? { veil_masked: factVeiling ? 0 : null } : {}),
    ...(projectsLive ? projectRequestFields(project, { ephemeral, conversationId: current }) : {}),
  });
  // A quote goes after whatever is already in the composer, to edit first.
  function quoteIntoComposer(text, { clipped } = {}) {
    if (!text) return;
    // Prompt Sharpen: an open result (and its Undo) is for the prompt before
    // this quote, so it closes rather than let Use this or Undo drop the
    // quote. Sharpen again to include it.
    if (sharpen.state.status !== "idle") sharpen.reset();
    setPrompt((p) => insertIntoPrompt(p, text).slice(0, 48000));
    setInfo(clipped ? "Long selection: only the first 6,000 characters were quoted." : "");
    requestAnimationFrame(() => {
      const el = promptBox.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
      el.scrollTop = el.scrollHeight;
    });
  }
  // Fact-check's run: the quote and a card that fills in once the verdict
  // arrives. A refusal or failure takes both back out; nothing was charged.
  async function runFactCheck(claim) {
    if (!user) {
      setError("Sign in to start generating, or open the demo.");
      return;
    }
    const block = factCheckBlock(claim);
    if (block) {
      setError(block);
      return;
    }
    setError("");
    setInfo("");
    setReceipt(null);
    setVeilNote(null);
    // Chat Control's charge panel follows chat requests; a check shows its own.
    if (chatControlLive) charge.reset();
    setBusy(true);
    controller.current = new AbortController();
    const requestId = uid();
    const body = { ...factCheckBody(claim), requestId };
    const before = messages;
    const requestModel = target.id;
    const asked = { role: "user", content: factCheckUserText(claim) };
    const reply = (extra) => ({ role: "assistant", model: requestModel, requestId, ...extra });
    setMessages([...before, asked, reply({ content: "", factcheck: { live: true } })]);
    let liveId = ephemeral ? null : current;
    try {
      const r = await api("/api/factcheck", { method: "POST", body, signal: controller.current.signal });
      if (r.conversationId) liveId = r.conversationId;
      const a = r.anonyma || {};
      setMessages([
        ...before,
        { ...asked, content: r.user_message?.text || asked.content, ...(r.user_message?.id ? { id: r.user_message.id } : {}) },
        reply({
          ...(r.message?.id ? { id: r.message.id } : {}),
          content: r.message?.text || "",
          citations: r.message?.citations || [],
          factcheck: r.message?.factcheck,
          finishReason: a.finish_reason || "stop",
          credits: a.credits_charged,
          ...(a.private ? { private: a.private, masked: 0 } : {}),
          ...(a.privacy ? { privacy: a.privacy } : {}),
        }),
      ]);
      if (!chatControlLive) setReceipt(a);
      setCurrent(liveId);
    } catch (err) {
      setMessages(before);
      if (err.name === "AbortError") setInfo("Fact-check stopped. Nothing was charged.");
      else setError(err.message);
    } finally {
      if (factVeiling && liveId && liveId !== veilKeyRef.current && !deviceOnly) {
        moveVeilState(veilKeyRef.current, liveId);
        veilKeyRef.current = liveId;
      }
      setBusy(false);
      refresh();
      if (!ephemeral)
        api("/api/conversations")
          .then((r) => setAll(recentConversations(r.data)))
          .catch(() => {});
      if (project && !ephemeral) projects.reload();
    }
  }
  const factCheck = factCheckLive
    ? {
        modelName: () => target?.name || sendModel,
        block: factCheckBlock,
        quote: (claim, _model, signal) =>
          api("/api/factcheck/quote", { method: "POST", body: factCheckBody(claim), signal }),
        run: (claim) => runFactCheck(claim),
      }
    : null;
  // `redo` resends an earlier turn (edit or regenerate): its own text, the
  // history before it and the conversation to add to, instead of the composer.
  // `allowSeed` is Seed Guard's confirmed "Send anyway"; `allowSecret` is
  // Secret Guard's "Send anyway", for this message only.
  async function send(e, redo = null, { allowSeed = false, allowSecret = false, chainFacts = null } = {}) {
    e?.preventDefault?.();
    if (!(redo ? redo.content.trim() : prompt.trim()) || busy || (!redo && branchFlight.current?.pending)) return;
    // Seed Guard: a new or edited message waits for "Send anyway" (the notice
    // is already showing). Regenerating resends a turn that was already sent,
    // so it goes ahead and tells the server so.
    const seedFound = !seedLive
      ? null
      : redo
        ? scanSecrets(redo.edited ?? redo.content, sentInstructions)
        : seedHit;
    if (seedFound && !allowSeed && (!redo || redo.edited != null)) return;
    // Secret Guard: a new message holding a password, key or token waits for
    // its notice (Mask and send, Remove, Send anyway). Seed Guard answered
    // with "Send anyway" hands over to it.
    if (!redo && secretHeld && !allowSecret) {
      if (seedFound && allowSeed) setSeedAnswered(true);
      return;
    }
    // The server checks the same text for seed phrases only; one found here
    // was confirmed above or already sent (an edited turn keeps its original
    // attachments). Keys and 64-hex never reach the server's check.
    const allowSeedPhrase =
      seedFound?.kind === "seed" ||
      (seedLive && !!redo && scanSecrets(redo.content)?.kind === "seed");
    if (!redo && attachments.length !== imageItems.length) {
      setError(
        redactLive
          ? "Metadata couldn't be removed from an image. Redact it to send a redrawn copy, tick Keep original to send it as it is, or remove it."
          : "Metadata couldn't be removed from an image. Tick Keep original to send it as it is, or remove it.",
      );
      return;
    }
    // Sealed Mode has its own send; a sealed thread never goes on unsealed.
    if (sealedOn && textMode) return sendSealed(redo);
    if (sealedThread && !demo) {
      setError("This chat was sealed. Turn on Sealed Mode to continue it, or start a new chat.");
      return;
    }
    // Blind Arena: a new message without an answer leaves the choice at no
    // (the question was recorded when it was asked).
    setArenaAsk(null);
    // Blind Compare: the thread goes on once the last comparison is voted
    // on, and a new message with Blind on goes to both models.
    if (!redo && blindAwaiting) {
      setError("Vote on the replies above to continue.");
      return;
    }
    if (blindActive && !redo) return sendBlind(allowSeedPhrase);
    // Deep research runs a new question; an edit or regenerate is a chat.
    if (researchOn && !redo) return sendResearch();
    const redoModel = redo?.model ? visibleModels.find((x) => x.id === redo.model && x.callable) : null;
    // Auto Model: a new message while Auto answers, or an edited one (a
    // regenerate asks the model that answered, or the one picked under the
    // reply). The server chooses; its choice arrives before the reply.
    const useAuto = redo ? autoChosen && !redo.model : autoActive;
    const effectiveModel = useAuto ? null : redo ? redoModel || selected : target;
    const requestVision = redo
      ? requestNeedsVision(buildChatRequest({
          messages: redo.base,
          preserveHistory: longAnswersLive,
          attachments: (redo.images || []).map((url) => ({ url })),
          instructions: sentInstructions,
        }).request)
      : needsVision;
    if (!useAuto && finderLive && textMode && requestVision && !effectiveModel?.vision) {
      setError("Choose a model that can read the images in this conversation.");
      return;
    }
    if (!demo) {
      if (!user) {
        setError(
          connected
            ? "Sign in to start generating, or open the demo."
            : "Sign in to generate when the account service is connected, or open the demo.",
        );
        return;
      }
      if ((!useAuto && !effectiveModel?.callable) || !config?.services?.generation) {
        setError("This model is not currently available for generation.");
        return;
      }
      if (!useAuto && privateMode && !effectiveModel?.private) {
        setError("Choose a private model, or turn off Private mode.");
        return;
      }
      if (deviceOnly && textMode && !vault.unlocked) {
        setError("Unlock Device Vault to keep chatting on this device only.");
        return;
      }
    }
    setError("");
    setInfo("");
    setReceipt(null);
    setVeilNote(null);
    setBusy(true);
    controller.current = new AbortController();
    const text = redo ? redo.content : sendText;
    const requestModel = useAuto ? AUTO : effectiveModel?.id || model;
    const requestId = uid();
    if (chatControlLive) { charge.begin(requestId); reading.reset(); }
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
    // Documents, standing instructions (Scrolls) and Veil are applied in
    // buildChatRequest (src/estimate.js), which the credit estimate beside
    // Send also uses. Standing instructions are sent, never saved. Veil masks
    // the instructions, the new message and earlier turns in the context
    // window with this conversation's tag map before anything reaches the
    // network; detection and tagging happen only in this browser.
    const veiling = veilOn && !demo && isReleased(config, "veil");
    const built = buildChatRequest({
      messages: redo ? redo.base : messages,
      text,
      attachments: redo ? (redo.images || []).map((url) => ({ url })) : attachments,
      // Onchain Explainer's facts lead the attached documents, so the
      // budget never trims them. The rest are as Injection Shield sends them.
      documents: redo
        ? []
        : chainFacts
          ? [chainFactsDocument(chainFacts, { lang: getLanguage() }), ...sentDocuments]
          : sentDocuments,
      asData: !redo && documentsAsData,
      instructions: sentInstructions,
      preserveHistory: longAnswersLive,
      veilWith: veiling ? { state: veilStateRef.current, words: veilWords } : null,
      memoryFacts,
    });
    const next = built.next,
      // Veil's mask count for this request, carried onto the reply so a
      // private-mode reply can show "<N> details masked" (see
      // PrivateReplyNote); stays 0 when Veil is off or finds nothing.
      requestMasked = built.masked;
    if (veiling) {
      // A device-only chat keeps its map encrypted in the vault instead.
      if (!deviceOnly) saveVeilState(veilKeyRef.current, veilStateRef.current);
      if (built.masked)
        setVeilNote({
          count: built.masked,
          entries: built.tags.map((tag) => ({ tag, value: veilStateRef.current.map[tag] })),
        });
    }
    // What the composer and chat held before this send, put back if the
    // server refuses it before anything starts (see the catch below).
    const before = { messages, prompt, attachments, documents };
    if (!redo) {
      setPrompt("");
      setAttachments([]);
      setDocuments([]);
    }
    setMessages([...next, { role: "assistant", content: "", sample: demo }]);
    if (demo) {
      const answer =
        mode === "code" ? (previewLive ? PREVIEW_DEMO_REPLY : sampleCode) : sampleChat;
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
    const conversationId = redo ? redo.conversationId : current;
    let output = "",
      liveId = conversationId,
      reasoning = "",
      images = [],
      citations = [],
      finishReason = null,
      // Set once the final event's anonyma.private arrives; drives the
      // "Sent to <provider> · not saved" line under this reply.
      privateInfo = null,
      // The final event's anonyma.privacy (Privacy Trail), once released.
      trailInfo = null,
      // The memory facts the server says it sent with this request.
      memoryUsed = null,
      // The final event's credits_charged: kept on the reply on screen, so a
      // chat that isn't saved can still export its receipts (Chat Export).
      charged = null,
      // Auto Model: which model the server chose and why (src/auto-model.js).
      autoInfo = null;
    const sendingPrivate = privateMode && !demo;
    try {
      await streamChat(
        {
          model: requestModel,
          messages: built.request,
          ...(ephemeral ? { ephemeral: true } : { conversationId }),
          mode,
          max_tokens: longAnswersLive ? replyBudgetFor(effectiveModel, replyBudget) : REPLY_BUDGET,
          // Auto Model: no model, Auto's settings, and the reply budget as
          // chosen (each model gets it up to its own limit).
          ...(useAuto
            ? { model: undefined, auto: autoRequest, max_tokens: longAnswersLive ? replyBudget : REPLY_BUDGET }
            : {}),
          requestId,
          ...(webSearch ? { web_search: true } : {}),
          ...(sendingPrivate ? { private: true } : {}),
          ...(built.memory ? { memory: built.memory } : {}),
          // Privacy Trail: only Veil's count leaves the browser (null: off),
          // so a saved reply's trail can still show it after a reload.
          ...(trailLive ? { veil_masked: veiling ? requestMasked : null } : {}),
          ...(allowSeedPhrase ? { allow_seed_phrase: true } : {}),
          // Projects: a new saved chat is filed in its project; off the
          // record, Private and Device only chats never name one.
          ...(projectsLive ? projectRequestFields(project, { ephemeral, conversationId }) : {}),
          ...teamPays.body,
        },
        (event) => {
          if (chatControlLive && !charge.isCurrent(requestId)) return;
          if (event.billing) charge.accept(requestId, event.billing);
          if (event.auto || event.anonyma?.auto) autoInfo = readAuto(event.auto || event.anonyma.auto) || autoInfo;
          if (event.conversationId) liveId = event.conversationId;
          if (event.anonyma) setReceipt(event.anonyma);
          finishReason = event.anonyma?.finish_reason || event.choices?.[0]?.finish_reason || finishReason;
          if (event.anonyma?.memory) memoryUsed = event.anonyma.memory;
          if (event.anonyma?.credits_charged != null) charged = event.anonyma.credits_charged;
          if (event.error)
            throw new ApiError(
              event.error.message || "The stream ended with an error.",
              200, event.error.code, event,
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
          if (event.anonyma?.privacy) trailInfo = event.anonyma.privacy;
          setMessages([
            ...next,
            {
              role: "assistant",
              content: output,
              reasoning,
              images,
              citations,
              model: autoInfo?.model || requestModel,
              finishReason,
              requestId,
              ...(autoInfo ? { auto: autoInfo } : {}),
              ...(privateInfo
                ? { private: privateInfo, masked: requestMasked }
                : {}),
              ...(trailInfo ? { privacy: trailInfo } : {}),
              ...(memoryUsed ? { memoryUsed } : {}),
              ...(charged != null ? { credits: charged } : {}),
            },
          ]);
        },
        controller.current.signal,
      );
      if (chatControlLive && !charge.isCurrent(requestId)) return;
      setCurrent(liveId);
    } catch (err) {
      if (chatControlLive && !charge.isCurrent(requestId)) return;
      if (err.data?.billing) charge.accept(requestId, err.data.billing);
      if (err.data?.anonyma) setReceipt(err.data.anonyma);
      if (err.data?.anonyma?.memory) memoryUsed = err.data.anonyma.memory;
      if (err.data?.anonyma?.privacy) trailInfo = err.data.anonyma.privacy;
      if (err.data?.anonyma?.credits_charged != null) charged = err.data.anonyma.credits_charged;
      if (err.data?.anonyma?.auto) autoInfo = readAuto(err.data.anonyma.auto) || autoInfo;
      setCurrent(liveId);
      // Refused before anything was reserved (out of credits, a spending
      // limit, Seed Guard, a rate limit): nothing started and nothing was
      // charged, so there's no interrupted reply or charge check, only the
      // reason.
      const refused =
        err?.status >= 400 && err.status < 500 &&
        (!err.data?.billing || err.data.billing.status === "not_charged") &&
        !output && !reasoning && !images.length;
      if (refused) {
        setMessages(before.messages);
        if (!redo) {
          setPrompt(before.prompt);
          setAttachments(before.attachments);
          setDocuments(before.documents);
        }
      }
      if (!refused && (chatControlLive || output || reasoning || images.length)) setMessages([...next, {
        role: "assistant", content: output, reasoning, images, citations, model: autoInfo?.model || requestModel,
        finishReason: finishReason || "interrupted", interrupted: true, requestId,
        ...(autoInfo ? { auto: autoInfo } : {}),
        ...(memoryUsed ? { memoryUsed } : {}),
        ...(trailInfo ? { privacy: trailInfo } : {}),
        ...(sendingPrivate ? { private: { privacy: "zdr", stored: false }, masked: requestMasked } : {}),
        ...(charged != null ? { credits: charged } : {}),
      }]);
      if (chatControlLive && !refused) charge.recover(requestId);
      setError(chatControlLive ? chatFailureMessage(err) : err.name === "AbortError"
        ? "Stopped. Partial billing may apply; refresh receipts before retrying." : err.message);
    } finally {
      if (!chatControlLive || charge.isCurrent(requestId)) {
        // Failed first replies also have a real ID; preserve their local Veil map.
        if (veilOn && liveId && liveId !== veilKeyRef.current) {
          moveVeilState(veilKeyRef.current, liveId);
          veilKeyRef.current = liveId;
        }
        setBusy(false);
        refresh();
        api("/api/conversations")
          .then((r) => setAll(recentConversations(r.data)))
          .catch(() => {});
        // A chat just filed in a project changes its counts.
        if (project && !ephemeral) projects.reload();
      }
    }
  }
  // Blind Compare's send (server/routes/blind.js): the request is built as
  // any chat's is (documents, standing and project instructions, Veil), then
  // goes to both models at once. The server picks the order and keeps the
  // names and each reply's cost to itself until the vote. Memory and web
  // search aren't used; off the record, Private Mode and projects apply.
  async function sendBlind(allowSeedPhrase) {
    if (!config?.services?.generation) {
      setError("This model is not currently available for generation.");
      return;
    }
    if (!validPair(blindPair, blindModels)) {
      setError("Choose two different models to compare.");
      return;
    }
    if (deviceOnly && !vault.unlocked) {
      setError("Unlock Device Vault to keep chatting on this device only.");
      return;
    }
    setError("");
    setInfo("");
    setReceipt(null);
    setVeilNote(null);
    // Each side has its own charge record; the round shows its total.
    if (chatControlLive) {
      charge.reset();
      reading.reset();
    }
    setBusy(true);
    controller.current = new AbortController();
    const veiling = veilOn && isReleased(config, "veil");
    const built = buildChatRequest({
      messages,
      text: sendText,
      attachments,
      // As Injection Shield sends them (cleaned, and "as data" when on).
      documents: sentDocuments,
      asData: documentsAsData,
      instructions: sentInstructions,
      preserveHistory: longAnswersLive,
      veilWith: veiling ? { state: veilStateRef.current, words: veilWords } : null,
    });
    if (veiling) {
      if (!deviceOnly) saveVeilState(veilKeyRef.current, veilStateRef.current);
      if (built.masked)
        setVeilNote({
          count: built.masked,
          entries: built.tags.map((tag) => ({ tag, value: veilStateRef.current.map[tag] })),
        });
    }
    const before = { messages, prompt, attachments, documents };
    setPrompt("");
    setAttachments([]);
    setDocuments([]);
    const conversationId = current;
    let liveId = conversationId,
      messageId = null,
      heard = false,
      blind = pendingBlind();
    const place = () =>
      setMessages([
        ...built.next,
        {
          role: "assistant",
          content: blindText(blind),
          blind,
          ...(messageId ? { id: messageId } : {}),
          ...(blind.credits != null ? { credits: blind.credits } : {}),
        },
      ]);
    place();
    try {
      await streamChat(
        {
          models: blindPair,
          messages: built.request,
          ...(ephemeral ? { ephemeral: true } : { conversationId }),
          mode,
          max_tokens: blindBudget,
          requestId: uid(),
          ...(privateMode ? { private: true } : {}),
          ...(trailLive ? { veil_masked: veiling ? built.masked : null } : {}),
          ...(allowSeedPhrase ? { allow_seed_phrase: true } : {}),
          ...(projectsLive ? projectRequestFields(project, { ephemeral, conversationId }) : {}),
        },
        (event) => {
          heard = true;
          if (event.error)
            throw new ApiError(
              event.error.message || "The stream ended with an error.",
              200,
              event.error.code,
              event,
            );
          if (event.blind?.conversationId) liveId = event.blind.conversationId;
          if (event.blind?.message_id) messageId = event.blind.message_id;
          blind = applyBlindEvent(blind, event);
          place();
        },
        controller.current.signal,
        "/api/blind",
      );
      setCurrent(liveId);
    } catch (err) {
      setCurrent(liveId);
      // Refused before either model started (out of credits, a spending
      // limit, Seed Guard, a model that can't take it): nothing was charged,
      // so the composer comes back as it was.
      if (!heard && err?.status >= 400) {
        setMessages(before.messages);
        setPrompt(before.prompt);
        setAttachments(before.attachments);
        setDocuments(before.documents);
      } else {
        // Stopped or cut off: what arrived stays, with nothing to vote on.
        const cut = (x) => ({ ...x, status: x.status === "streaming" ? "stopped" : x.status });
        blind = { ...blind, pending: false, a: cut(blind.a), b: cut(blind.b) };
        place();
      }
      setError(
        err.name === "AbortError"
          ? "Stopped. A reply that had started may be charged for what it used; check your activity."
          : err.message,
      );
    } finally {
      if (veilOn && liveId && liveId !== veilKeyRef.current) {
        moveVeilState(veilKeyRef.current, liveId);
        veilKeyRef.current = liveId;
      }
      setBusy(false);
      refresh();
      api("/api/conversations")
        .then((r) => setAll(recentConversations(r.data)))
        .catch(() => {});
      if (project && !ephemeral) projects.reload();
    }
  }
  // Vote, then reveal: the names, what each reply cost and how fast it was.
  async function voteBlind(index, outcome) {
    const m = messages[index];
    if (!m?.blind?.token || blindVoting != null) return;
    setBlindVoting(index);
    setError("");
    try {
      const r = await api("/api/blind/votes", {
        method: "POST",
        body: { round: m.blind.token, outcome, ...(m.id ? { message_id: m.id } : {}) },
      });
      setMessages((prev) =>
        prev.map((x, j) => (j === index && x.blind ? revealTurn(x, r.reveal) : x)),
      );
      if (!r.counted) setInfo("This comparison already had a vote. The first one stands.");
      // Blind Arena: the first vote once it's live asks, once, whether to
      // add votes to it. Yes also adds this one (its round).
      if (arenaLive && r.arena?.ask) setArenaAsk({ round: m.blind.token });
    } catch (e) {
      if (["blind_vote_closed", "blind_round_not_found"].includes(e.code))
        setMessages((prev) => prev.map((x, j) => (j === index && x.blind ? closeTurn(x) : x)));
      setError(e.message);
    } finally {
      setBlindVoting(null);
    }
  }
  // Blind Arena: the answer to the question after a vote.
  async function answerArena(yes) {
    if (!arenaAsk || arenaSaving) return;
    setArenaSaving(true);
    setError("");
    try {
      const r = await saveArenaChoice(yes, arenaAsk.round);
      setArenaAsk(null);
      setInfo(
        !yes
          ? "Your Blind votes stay yours. You can change this in Account settings."
          : r.added
            ? "Added. This vote and your next Blind votes go to the Arena, with no account attached."
            : "Your next Blind votes go to the Arena, with no account attached.",
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setArenaSaving(false);
    }
  }
  // After the reveal: go on with one model (Blind off), or keep comparing
  // the same two in a fresh random order.
  function continueWith(id) {
    setBlindOn(false);
    if (finderLive) chooseModel({ model: id });
    else {
      setModel(id);
      setQuote(null);
    }
    setInfo(`Blind is off. Your next message goes to ${modelName(id)}.`);
    promptBox.current?.focus();
  }
  function keepComparing(reveal) {
    setBlindOn(true);
    setWebSearch(false);
    setResearchDepth(null);
    if (reveal?.a?.model && reveal?.b?.model) {
      setBlindPair([reveal.a.model, reveal.b.model]);
      setBlindSurprise(false);
    }
    promptBox.current?.focus();
  }
  function toggleBlind() {
    if (blindOn) return setBlindOn(false);
    setBlindOn(true);
    setWebSearch(false);
    // Blind and Deep research are one or the other.
    setResearchDepth(null);
    if (!pairInPool(blindPair, blindModels)) {
      setBlindPair(defaultPair(blindModels, selected));
      setBlindSurprise(false);
    }
  }
  function surpriseBlind() {
    const pick = surprisePair(blindModels, selected, secureRandom);
    if (pick) {
      setBlindPair(pick);
      setBlindSurprise(true);
    }
  }
  // Deep research's send: the question alone, run by /api/research, with a
  // live progress panel in the reply until the report arrives. A refusal
  // before anything ran puts the question back; Stop keeps what finished.
  async function sendResearch() {
    if (!user) {
      setError("Sign in to start generating, or open the demo.");
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
    if (deviceOnly && !vault.unlocked) {
      setError("Unlock Device Vault to keep chatting on this device only.");
      return;
    }
    if (researchBlocked) {
      setError(researchBlocked);
      return;
    }
    setError("");
    setInfo("");
    setReceipt(null);
    setVeilNote(null);
    // Chat Control's charge panel follows chat requests; a run shows its own.
    if (chatControlLive) charge.reset();
    setBusy(true);
    controller.current = new AbortController();
    const requestId = uid();
    const body = { ...researchRequest(true), requestId };
    if (researchVeiling && !deviceOnly) saveVeilState(veilKeyRef.current, veilStateRef.current);
    const question = sendText;
    const requestModel = target.id;
    const before = { messages, prompt };
    setPrompt("");
    const next = [...messages, { role: "user", content: question }];
    const reply = (extra) => ({ role: "assistant", model: requestModel, requestId, ...extra });
    setMessages([...next, reply({ content: "", research: { live: true, stage: "planning", depth: body.depth, questions: [], results: [] } })]);
    let liveId = ephemeral ? null : current;
    const sendingPrivate = privateMode;
    try {
      const done = await runResearch(
        body,
        (state) => {
          if (state.conversationId) liveId = state.conversationId;
          setMessages([...next, reply({ content: "", research: state })]);
        },
        controller.current.signal,
      );
      if (done.conversationId) liveId = done.conversationId;
      const a = done.anonyma || {};
      setMessages([
        ...next,
        reply({
          content: done.message?.text || "",
          citations: done.message?.citations || [],
          research: done.message?.research,
          finishReason: a.finish_reason || "stop",
          credits: a.credits_charged,
          ...(a.private ? { private: a.private, masked: 0 } : {}),
          ...(a.privacy ? { privacy: a.privacy } : {}),
          ...(a.memory ? { memoryUsed: a.memory } : {}),
        }),
      ]);
      // The run's total is under the report; the plain receipt line shows it
      // too where Chat Control's charge panel isn't live.
      if (!chatControlLive) setReceipt(a);
      setCurrent(liveId);
    } catch (err) {
      const state = err.state || err.data?.state;
      if (err.data?.conversationId) liveId = err.data.conversationId;
      if (err.name === "AbortError") {
        // Stopped: the finished steps stay charged; show what they found.
        const kept = stoppedReply(state || { depth: body.depth });
        setMessages(kept.content ? [...next, reply({ ...kept, finishReason: "interrupted" })] : next);
        if (!chatControlLive) setReceipt({ credits_charged: kept.research.credits_charged, request_id: requestId });
        setInfo(`Stopped. Only finished steps were charged: ${formatCredits(kept.research.credits_charged) || "0"} credits.`);
        setCurrent(liveId);
      } else if (err.data?.refused) {
        // Refused before anything ran (balance, a limit, Veil, Seed Guard, a
        // rate limit): nothing was charged, so the question comes back.
        setMessages(before.messages);
        setPrompt(before.prompt);
        setError(err.message);
      } else {
        const m = err.data?.message;
        const a = err.data?.anonyma || {};
        setMessages(
          m?.text
            ? [...next, reply({ content: m.text, citations: m.citations || [], research: m.research, finishReason: "interrupted", credits: a.credits_charged, ...(a.privacy ? { privacy: a.privacy } : {}), ...(sendingPrivate ? { private: { privacy: "zdr", stored: false }, masked: 0 } : {}) })]
            : next,
        );
        if (a.credits_charged != null && !chatControlLive) setReceipt(a);
        setError(err.message);
        setCurrent(liveId);
      }
    } finally {
      if (researchVeiling && liveId && liveId !== veilKeyRef.current && !deviceOnly) {
        moveVeilState(veilKeyRef.current, liveId);
        veilKeyRef.current = liveId;
      }
      setBusy(false);
      refresh();
      api("/api/conversations")
        .then((r) => setAll(recentConversations(r.data)))
        .catch(() => {});
      if (project && !ephemeral) projects.reload();
    }
  }
  // Sealed Mode's send. The request is built as any chat's is (documents read
  // in this browser, standing instructions, Veil), then sealed here to the
  // verified enclave and relayed as ciphertext. The enclave is verified again
  // first if its last check is too old; if that fails nothing is sent. The
  // server keeps no copy: Device Vault keeps the chat while it's unlocked.
  async function sendSealed(redo) {
    const pinned = redo?.model ? sealedModels.find((m) => m.id === redo.model) : null;
    const fallbackModel = pinned || sealedTarget;
    if (!fallbackModel) {
      setError("No sealed models are available right now.");
      return;
    }
    if (!redo && attachments.length) {
      setError(
        ocrLive
          ? "Sealed models can't read images. Use Text only to send their words instead, or remove them."
          : "Sealed models can't read images. Remove them to send.",
      );
      return;
    }
    if (deviceOnly && !vault.unlocked) {
      setError("Unlock Device Vault to keep chatting on this device only.");
      return;
    }
    setError("");
    setInfo("");
    setReceipt(null);
    setVeilNote(null);
    setBusy(true);
    controller.current = new AbortController();
    const text = redo ? redo.content : sendText;
    const veiling = veilOn && isReleased(config, "veil");
    const built = buildChatRequest({
      messages: redo ? redo.base : messages,
      text,
      documents: redo ? [] : sentDocuments,
      asData: !redo && documentsAsData,
      instructions: instructionsActive ? instructions.body.trim() : "",
      preserveHistory: longAnswersLive,
      veilWith: veiling ? { state: veilStateRef.current, words: veilWords } : null,
    });
    // Auto: routed on the request exactly as it will be sealed.
    const routed =
      !pinned && sealedAutoOn
        ? routeSealed({ messages: built.request, mode, prefer: autoChoices.prefer, pool: sealedAutoPool })
        : null;
    const model = routed?.model || fallbackModel;
    const next = built.next;
    if (veiling) {
      if (!deviceOnly) saveVeilState(veilKeyRef.current, veilStateRef.current);
      if (built.masked)
        setVeilNote({
          count: built.masked,
          entries: built.tags.map((tag) => ({ tag, value: veilStateRef.current.map[tag] })),
        });
    }
    const before = { messages, prompt, documents };
    if (!redo) {
      setPrompt("");
      setDocuments([]);
    }
    let output = "",
      reasoning = "",
      finishReason = null;
    const reply = (sealedInfo, extra = {}) => ({
      role: "assistant",
      content: output,
      reasoning,
      model: model.id,
      finishReason,
      sealed: sealedInfo,
      ...(routed ? { auto: routed.auto } : {}),
      ...extra,
    });
    setMessages([...next, reply({ pending: true })]);
    try {
      const { requestId } = await enclave.chat({
        model: model.id,
        messages: built.request,
        maxTokens: model.sealedOutputCap || 8192,
        signal: controller.current.signal,
        onEvent: (event) => {
          if (event.error)
            throw new ApiError(event.error.message || "The stream ended with an error.", 200, event.error.code);
          output += event.choices?.[0]?.delta?.content || "";
          reasoning +=
            event.choices?.[0]?.delta?.reasoning_content ||
            event.choices?.[0]?.delta?.reasoning ||
            "";
          finishReason = event.choices?.[0]?.finish_reason || finishReason;
          setMessages([...next, reply({ pending: true })]);
        },
      });
      setMessages([...next, reply({ pending: true, requestId })]);
      const billing = await enclave.billing(requestId);
      setMessages([...next, reply({ billing, requestId })]);
    } catch (err) {
      // Refused before any reply (verification failed, out of credits, a
      // provider refusal): nothing started, so the composer comes back.
      if (!output && !reasoning && (err.status >= 400 || /^attestation_/.test(err.code || ""))) {
        setMessages(before.messages);
        if (!redo) {
          setPrompt(before.prompt);
          setDocuments(before.documents);
        }
      } else {
        const billing = err.requestId ? await enclave.billing(err.requestId) : null;
        setMessages([
          ...next,
          reply(
            { billing, requestId: err.requestId || null },
            { finishReason: finishReason || "interrupted", interrupted: true },
          ),
        ]);
      }
      setError(
        err.name === "AbortError"
          ? "Stopped. A sealed request the provider accepted is charged for what it used."
          : err.message,
      );
    } finally {
      setBusy(false);
      refresh();
    }
  }
  // Edit a user turn or regenerate an answer. A saved conversation is first
  // branched just before that turn, so the original keeps every message;
  // off-the-record and demo chats rewind only here and stay unsaved.
  // `model` regenerates on another model (Auto Model's "Use a different
  // model"); otherwise a regenerate asks the model that answered.
  async function rewind(index, kind, editedText = null, { allowSeed = false, allowSecret = false, model = null } = {}) {
    if (busy) return;
    // Seed Guard: an edit is new text; stop before any branch is made.
    if (editedText != null && !allowSeed && seedLive && scanSecrets(editedText)) return;
    // Secret Guard likewise, until it's masked, removed or sent anyway.
    if (editedText != null && !allowSecret && secretLive && scanParts(editedText).length) return;
    const plan = rewindPlan(messages, index, kind);
    if (!plan) return;
    // Synchronous guard: a second click while this one is pending is ignored.
    await branchFlight.current.run(async (fresh) => {
      setBranching(true);
      setError("");
      setEditing(null);
      try {
        let conversationId = current;
        if (!demo && !ephemeral && current) {
          let point = plan.prompt.id;
          // Turns sent in this session have no server id yet: read them back.
          if (!point) {
            const r = await api("/api/conversations/" + current);
            const saved = r.messages[plan.userIndex];
            if (r.messages.length !== messages.length || saved?.role !== "user")
              throw new Error("This conversation changed. Reopen it and try again.");
            point = saved.id;
          }
          if (!fresh()) return;
          const branch = await api(`/api/conversations/${current}/branch`, {
            method: "POST",
            body: { before: point, requestId: uid() },
          });
          // Opened something else meanwhile: keep the branch, don't resend into it.
          if (!fresh()) return;
          // The branch reuses this conversation's local Veil map.
          saveVeilState(branch.id, loadVeilState(veilKeyRef.current));
          veilKeyRef.current = branch.id;
          conversationId = branch.id;
          setCurrent(branch.id);
          setLineage({ parent: branch.parent, branches: [] });
        }
        await send(null, {
          content: resendContent(plan.prompt, editedText),
          edited: editedText,
          images: plan.prompt.images || [],
          base: plan.base,
          model: model || plan.model,
          conversationId,
        }, { allowSeed });
      } catch (e) {
        setError(e.message);
      } finally {
        setBranching(false);
      }
    });
  }
  // Branch from here: a copy through this message, opened so it can go on.
  async function branchFrom(message) {
    if (busy || !current || !message.id) return;
    await branchFlight.current.run(async (fresh) => {
      setBranching(true);
      try {
        const b = await api(`/api/conversations/${current}/branch`, {
          method: "POST",
          body: { through: message.id, requestId: uid() },
        });
        if (!fresh()) return;
        saveVeilState(b.id, loadVeilState(veilKeyRef.current));
        await openChat({ id: b.id, mode: b.mode });
      } catch (e) {
        setError(e.message);
      } finally {
        setBranching(false);
      }
    });
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
    if (seedHit || secretHeld) return;
    if (demo) {
      setQuote({ credits: 0, sample: true });
      return;
    }
    try {
      const r = await api("/api/quote", { method: "POST", body: estimateRequest() });
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
  // Command Palette (⌘K / Ctrl+K, or the header button): this page's chats,
  // the model picker's own list, scrolls and actions, ranked in the browser.
  // Opening or searching it fetches, sends and charges nothing; choosing an
  // item runs the same code as the control it stands for.
  const paletteLive = paletteReleased(config);
  const palette = usePalette(paletteLive);
  const language = useLanguage();
  const paletteModels =
    MODEL_MODES.includes(mode) && modeReleased(config, mode)
      ? finderLive
        ? finderModels
        : visibleModels
      : [];
  function paletteItems(query) {
    const ctx = {
      config,
      page: "workspace",
      mode,
      demo,
      signedIn: !!user,
      webSearch,
      veilOn,
      privateMode,
      // Device only reads as not off the record: the palette's toggle
      // switches it to plain off the record, as the composer's does.
      ephemeral: ephemeral && !deviceOnly,
      shared: !!shared,
      busy,
      language,
      findable: find.live,
    };
    return [
      ...chatItems(demo || user ? all : [], { current }),
      ...modelItems(paletteModels, { current: model, demo, trainingLive }),
      ...(textMode && scrollsLive ? scrollItems(scrolls) : []),
      // Projects: Go to project and New chat in project.
      ...(projectsLive ? projectItems(projects.list) : []),
      ...paletteActions(ctx),
      ...[historySearchItem(query, ctx)].filter(Boolean),
    ];
  }
  function runPaletteItem(item) {
    const focusComposer = () => setTimeout(() => promptBox.current?.focus(), 0);
    if (item.group === "chats" && item.value) return openChat(item.value);
    if (item.group === "models" && item.value) {
      // Exactly what choosing it in the model picker does.
      if (finderLive) chooseModel({ model: item.value.id });
      else {
        setModel(item.value.id);
        setQuote(null);
      }
      return;
    }
    if (item.group === "projects" && item.value) {
      if (item.run !== "new") return navigate(projectPagePath(item.value));
      if (!textMode) return navigate(projectChatPath(item.value, mode));
      startProjectChat(item.value);
      focusComposer();
      return;
    }
    if (item.group === "scrolls" && item.value) {
      const scroll = item.value;
      if (extractVariables(scroll.body).length)
        setScrollFill({ ...scroll, fromPalette: true });
      else {
        setPrompt((p) => insertIntoPrompt(p, scroll.body));
        focusComposer();
      }
      return;
    }
    switch (item.id) {
      case "new-chat":
        if (item.to) navigate(item.to);
        else {
          newChat();
          focusComposer();
        }
        return;
      case "web-search":
        return setWebSearch((v) => !v);
      case "veil":
        return setVeilOn((v) => !v);
      case "private-mode":
        return togglePrivateMode();
      case "off-record":
        return toggleEphemeral();
      case "scrolls":
        return setScrollsPanel(true);
      case "memory":
        return setMemoryPanel({});
      case "files":
        return setFilesRequest((n) => n + 1);
      case "language":
        return setLanguage(language === "zh" ? "en" : "zh");
      case "find-in-chat":
        return find.show();
      case "privacy-screen":
        return hideScreen();
      default:
        // "language-es": with Spanish released, one action per language.
        if (item.id?.startsWith("language-")) return setLanguage(item.id.slice(9));
        if (item.to) navigate(item.to, item.state ? { state: item.state } : undefined);
    }
  }
  // With Live Preview, files take the names the reply gives them (the
  // preview resolves a page's links by name) and real revision numbers.
  const files = previewLive
    ? projectFiles(messages)
    : messages
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
  // The Preview tab opens by itself once there's a page to show, until the
  // tabs are used.
  const codePanelTab =
    codeTab || (previewLive && previewPages(files).length ? "preview" : "files");
  const previewing = previewLive && codePanelTab === "preview";
  // The Voice studio's saved audio (Audio Overview's included) lays out
  // like the image and video results, so the composer never covers it.
  const hasResults =
    mode === "audio"
      ? media.some((m) => m.kind === "audio")
      : (mode === "image" || mode === "video") &&
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
  // The sidebar's recent chats, narrowed to a project (or to none) once
  // Projects is live.
  const sidebarChats = (demo || user ? all : []).filter((c) =>
    !projectsLive || chatFilter === "all"
      ? true
      : chatFilter === "none"
        ? !projects.byId(c.project_id)
        : c.project_id === chatFilter,
  );
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
  // The header's chat tools. A long saved chat can show up to seven (Find,
  // Catch me up, Share, Study, Slides, Export, Listen); with more than the header
  // has room for, they compact to icons (workspace.css, .tools-5 and
  // .tools-4), so the header never scrolls sideways. These mirror the
  // conditions each tool is shown with in the header below.
  const shareShown = sharesLive && textMode && messages.length > 0;
  const studyShown =
    studyLive && textMode && current && !deviceOnly && !ephemeral && !privateMode &&
    !sealedOn && !sealedThread && messages.length > 0;
  const slidesShown =
    slidesLive && textMode && current && !deviceOnly && !ephemeral && !privateMode &&
    !sealedOn && !sealedThread && messages.length > 0;
  const exportShown = exportLive && textMode && messages.length > 0;
  const listenShown = overviewOn && textMode && messages.some((m) => !m.sample);
  const headerTools = [!!find.button, catchupOn, shareShown, studyShown, slidesShown, exportShown, listenShown].filter(Boolean).length;
  return (
    <main id="main" className="app-shell">
      {/* Privacy Screen: Esc twice or Hide covers the page (and idle locks it). */}
      <PrivacyScreen config={config} user={user} />
      <AppSidebar
        active={mode}
        demo={demo}
        open={menu}
        onClose={() => setMenu(false)}
        newConversation={<button
          className="new-conversation"
          onClick={() => {
            newChat();
            leaveProject();
            navigate("/workspace/chat" + (demo ? "?demo=1" : ""));
            setMenu(false);
          }}
        >
          <Icon name="plus" size={17} />
          New conversation
        </button>}
      >
        {projectsLive && (
          <ProjectsSidebar
            projects={projects.list}
            chats={all}
            currentChat={current}
            onOpenChat={openChat}
            currentId={mode === "projects" ? params.get("p") : project?.id}
            onNew={() => {
              setMenu(false);
              navigate("/workspace/projects?new=1");
            }}
          />
        )}
        <div className="sidebar-group-label">RECENT CONVERSATIONS</div>
        {projectsLive && projects.list.length > 0 && (
          <select
            className="project-filter"
            aria-label="Show chats from"
            value={chatFilter}
            onChange={(e) => setChatFilter(e.target.value)}
          >
            <option value="all">All chats</option>
            <option value="none">No project</option>
            {projects.list.map((p) => (
              <option key={p.id} value={p.id} data-i18n="off">
                {p.name}
              </option>
            ))}
          </select>
        )}
        {projectsLive && chatFilter !== "all" && !sidebarChats.length && (
          <p className="sidebar-empty">
            {chatFilter === "none" ? "Every saved chat is in a project." : "No saved chats in this project yet."}
          </p>
        )}
        <div className="conversation-list">
          {sidebarChats.slice(0, chatFilter === "all" ? 12 : 40).map((c) => (
            <div className={c.id === current ? "current" : ""} key={c.id}>
              <button data-i18n="off" onClick={() => openChat(c)}>
                {projectsLive && projects.byId(c.project_id) && (
                  <ProjectSwatch
                    color={projects.byId(c.project_id).color}
                    title={projects.byId(c.project_id).name}
                    className="chat-project"
                  />
                )}
                {c.title}
              </button>
              {c.imported_from && (
                <span
                  className="chat-imported"
                  title={"Imported from " + (c.imported_from === "claude" ? "Claude" : "ChatGPT")}
                >
                  <Icon name="import" size={12} />
                </span>
              )}
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
        {vaultLive && (
          <VaultSection
            vault={vault}
            // Projects: the sidebar filter reaches the vault's chats too,
            // grouped by project in this browser only.
            filter={
              projectsLive && chatFilter !== "all"
                ? (c) => (chatFilter === "none" ? !projects.byId(c.project) : c.project === chatFilter)
                : null
            }
            mark={
              projectsLive
                ? (c) =>
                    projects.byId(c.project) && (
                      <ProjectSwatch
                        color={projects.byId(c.project).color}
                        title={projects.byId(c.project).name}
                        className="chat-project"
                      />
                    )
                : null
            }
            currentId={deviceOnly ? vaultChatId : null}
            onOpen={(c) => {
              setMenu(false);
              openVaultChat(c);
            }}
            onDialog={setVaultDialog}
            sync={vaultSync}
          />
        )}
      </AppSidebar>
      {menu && (
        <button
          className="sidebar-scrim"
          aria-label="Close menu"
          onClick={() => setMenu(false)}
        />
      )}
      {chatControlLive && reading.away && messages.length > 0 && <button type="button" className="jump-latest" onClick={reading.jump}>Jump to latest ↓</button>}
      <div className="workspace-main">
        <header
          className={
            "workspace-header" + (headerTools >= 5 ? " tools-5" : "") + (headerTools >= 4 ? " tools-4" : "")
          }
        >
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
                symposium: "Symposium",
                code: "Code & build",
                image: "Image studio",
                video: "Video studio",
                audio: "Voice studio",
                collab: "Collab",
                library: "Your library",
                tools: "Research, Writing & Calculators",
                routines: "Routines",
                projects: "Projects",
                sheets: "Sheets",
                device: "On-device",
                study: "Study",
                compare: "Compare docs",
                canvas: "Canvas",
                slides: "Slides",
                repos: "Repo Reader",
                translate: "Translate docs",
                notes: "Meeting notes",
                import: "Import chats",
                photos: "Photo tools",
                filesearch: "Search files",
              }[mode]
            }
            {isEarlyAccess(config, MODE_FEATURES[mode]) && <EarlyTag />}
            <span className="workspace-slash">/</span>
            <small>{demo ? "Demo workspace" : "Personal workspace"}</small>
          </span>
          <div>
            {find.button}
            {catchupOn && (
              <CatchUpButton disabled={busy} onOpen={() => setCatchupOpen(true)} />
            )}
            {sharesLive && textMode && messages.length > 0 && (
              <button
                type="button"
                className="share-open-button"
                aria-label="Share this chat"
                title="Share this chat"
                onClick={openShare}
              >
                <Icon name="share" size={15} />
                <span>Share</span>
              </button>
            )}
            {/* Study Mode: make a deck from this saved chat (never an unsaved,
                Private, Device Vault or sealed one). */}
            {studyLive && textMode && current && !deviceOnly && !ephemeral && !privateMode &&
              !sealedOn && !sealedThread && messages.length > 0 && (
              <Link
                className="chat-export-open"
                aria-label="Make a study deck from this chat"
                title="Make a study deck from this chat"
                to={"/workspace/study?chat=" + encodeURIComponent(current)}
              >
                <Icon name="study" size={15} />
                <span>Study</span>
              </Link>
            )}
            {/* Slides: make a deck from this saved chat (never an unsaved,
                Private, Device Vault or sealed one). */}
            {slidesShown && (
              <Link
                className="chat-export-open"
                aria-label="Make slides from this chat"
                title="Make slides from this chat"
                to={"/workspace/slides?chat=" + encodeURIComponent(current)}
              >
                <Icon name="present" size={15} />
                <span>Slides</span>
              </Link>
            )}
            {exportLive && textMode && messages.length > 0 && (
              <button
                type="button"
                className="chat-export-open"
                aria-label="Export this chat"
                title={busy ? "Wait for the reply to finish" : "Export this chat"}
                disabled={busy}
                onClick={openExport}
              >
                <Icon name="download" size={15} />
                <span>Export</span>
              </button>
            )}
            {overviewOn && textMode && messages.some((m) => !m.sample) && (
              <button
                type="button"
                className="chat-export-open overview-open"
                aria-label="Make an audio overview of this chat"
                title={busy ? "Wait for the reply to finish" : "Audio overview: a two-voice briefing of this chat"}
                disabled={busy}
                onClick={() => openOverview()}
              >
                <Icon name="audio" size={15} />
                <span>Listen</span>
              </button>
            )}
            {paletteLive && (
              <PaletteButton onOpen={() => palette.setOpen(true)} apple={palette.apple} />
            )}
            <HideScreenButton config={config} user={user} />
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
                  <span className="balance-detail">
                    available · {Number(user.held || 0).toLocaleString()} held
                  </span>
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
        {/* Low-Balance Alerts: below the account's alert level, with Top up. */}
        <LowBalanceBanner config={config} user={user} demo={demo} />
        {/* Inactivity Wipe: the clock was reset, or the content was erased. */}
        <InactivityWipeBanner config={config} user={user} demo={demo} />
        {/* Recovery Kit: a one-time nudge for accounts with no email. */}
        <RecoveryKitNudge config={config} user={user} demo={demo} />
        {/* Find in Chat: sticks to the top of the chat while it's open. */}
        {find.bar}
        <div
          key={mode}
          className={
            "workspace-body " +
            (!messages.length && !carried ? "workspace-start " : "") +
            (mode === "home" ? "workspace-home " : "") +
            (hasResults ? "with-results " : "") +
            (mode === "code" && files.length ? "with-code" : "") +
            (mode === "code" && files.length && previewing ? " with-preview" : "")
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
          ) : mode === "library" && isReleased(config, "historylibrary") ? (
            <HistoryLibrary key={`${user?.id || "guest"}:${demo}`} user={user} demo={demo} config={config} projects={projectsLive ? projects.list : []} media={media} Grid={MediaGrid} request={paletteLive && location.state?.libraryTab ? { tab: location.state.libraryTab, query: location.state.historyQuery, key: location.key } : bookmarksLive && location.state?.libraryTab === "bookmarks" ? { tab: "bookmarks", key: location.key } : null} bookmarks={bookmarksLive} models={models} onOpen={openChat} onExport={exportLive ? exportSaved : null} onDelete={(item) => setDialog({ type: "media", item })} refreshMedia={async () => { const r = await api("/api/media"); setMedia(r.data); refresh(); }} />
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
          ) : mode === "projects" ? (
            <Projects
              key={`${user?.id || "guest"}:${demo}`}
              demo={demo}
              user={user}
              config={config}
              models={models}
              projects={projects}
              vault={vault}
              vaultLive={vaultLive}
              onOpenChat={openChat}
              onOpenVaultChat={openVaultChat}
              onNewChat={(p) => navigate(projectChatPath(p, "chat"))}
              onUnlockVault={() =>
                setVaultDialog({ kind: vault.status === "none" ? "setup" : "unlock" })
              }
            />
          ) : mode === "routines" ? (
            <Routines key={`${user?.id || "guest"}:${demo}`} demo={demo} user={user} models={models} config={config} refresh={refresh} markdown={shieldView ? shieldMarkdown() : undefined} />
          ) : mode === "sheets" ? (
            isReleased(config, "sheets") && (
              <Suspense fallback={<p className="sheets-loading">Opening Sheets…</p>}>
                <Sheets key={`${user?.id || "guest"}:${demo}`} demo={demo} user={user} models={models} config={config} refresh={refresh} veilOn={veilOn} setVeilOn={setVeilOn} veilWords={veilWords} />
              </Suspense>
            )
          ) : mode === "device" ? (
            isReleased(config, "ondevice") && (
              <Suspense fallback={<p className="sheets-loading">Opening the on-device model…</p>}>
                <OnDevice
                  key={`${user?.id || "guest"}:${demo}`}
                  demo={demo}
                  user={user}
                  vault={vault}
                  vaultLive={vaultLive}
                  onUnlockVault={() => setVaultDialog({ kind: vault.status === "none" ? "setup" : "unlock" })}
                />
              </Suspense>
            )
          ) : mode === "study" ? (
            isReleased(config, "study") && (
              <Suspense fallback={<p className="study-loading">Opening Study…</p>}>
                <Study key={`${user?.id || "guest"}:${demo}`} demo={demo} user={user} models={models} config={config} refresh={refresh} veilOn={veilOn} setVeilOn={setVeilOn} veilWords={veilWords} />
              </Suspense>
            )
          ) : mode === "slides" ? (
            isReleased(config, "slides") && (
              <Suspense fallback={<p className="slides-loading">Opening Slides…</p>}>
                <Slides key={`${user?.id || "guest"}:${demo}`} demo={demo} user={user} models={models} config={config} refresh={refresh} veilOn={veilOn} setVeilOn={setVeilOn} veilWords={veilWords} />
              </Suspense>
            )
          ) : mode === "repos" ? (
            isReleased(config, "reporeader") && (
              <Suspense fallback={<p className="repo-loading">Opening Repo Reader…</p>}>
                <RepoReader key={`${user?.id || "guest"}:${demo}`} demo={demo} user={user} models={models} config={config} refresh={refresh} veilOn={veilOn} setVeilOn={setVeilOn} veilWords={veilWords} />
              </Suspense>
            )
          ) : mode === "compare" ? (
            isReleased(config, "doccompare") && (
              <Suspense fallback={<p className="compare-loading">Opening Compare docs…</p>}>
                <Compare key={`${user?.id || "guest"}:${demo}`} demo={demo} user={user} models={models} config={config} refresh={refresh} veilOn={veilOn} setVeilOn={setVeilOn} veilWords={veilWords} />
              </Suspense>
            )
          ) : mode === "notes" ? (
            modeReleased(config, "notes") && (
              <Suspense fallback={<p className="meeting-loading">Opening Meeting notes…</p>}>
                <MeetingNotes
                  key={`${user?.id || "guest"}:${demo}`}
                  demo={demo}
                  user={user}
                  models={models}
                  config={config}
                  refresh={refresh}
                  veilOn={veilOn}
                  setVeilOn={setVeilOn}
                  veilWords={veilWords}
                  vault={vault}
                  vaultLive={vaultLive}
                  onUnlockVault={() => setVaultDialog({ kind: vault.status === "none" ? "setup" : "unlock" })}
                  projects={projectsLive ? projects.list : []}
                />
              </Suspense>
            )
          ) : mode === "import" ? (
            isReleased(config, "chatimport") && (
              <Suspense fallback={<p className="import-loading">Opening Import chats…</p>}>
                <ChatImport
                  key={`${user?.id || "guest"}:${demo}`}
                  demo={demo}
                  user={user}
                  config={config}
                  vault={vault}
                  vaultLive={vaultLive}
                  onUnlockVault={() => setVaultDialog({ kind: vault.status === "none" ? "setup" : "unlock" })}
                  // The sidebar's recent chats pick up what was just imported.
                  onImported={() =>
                    api("/api/conversations")
                      .then((r) => setAll(recentConversations(r.data)))
                      .catch(() => {})
                  }
                />
              </Suspense>
            )
          ) : mode === "photos" ? (
            modeReleased(config, "photos") && (
              <Suspense fallback={<p className="photo-loading">Opening Photo tools…</p>}>
                <PhotoTools
                  key={`${user?.id || "guest"}:${demo}`}
                  demo={demo}
                  user={user}
                  models={models}
                  config={config}
                  refresh={refresh}
                  veilOn={veilOn}
                  setVeilOn={setVeilOn}
                  veilWords={veilWords}
                />
              </Suspense>
            )
          ) : mode === "filesearch" ? (
            modeReleased(config, "filesearch") && (
              <Suspense fallback={<p className="fsearch-loading">Opening Search files…</p>}>
                <FileSearch
                  key={`${user?.id || "guest"}:${demo}`}
                  demo={demo}
                  user={user}
                  models={models}
                  config={config}
                  refresh={refresh}
                  veilOn={veilOn}
                  setVeilOn={setVeilOn}
                  veilWords={veilWords}
                  vault={vault}
                  vaultLive={vaultLive}
                />
              </Suspense>
            )
          ) : mode === "canvas" ? (
            isReleased(config, "canvas") && (
              <Suspense fallback={<p className="canvas-loading">Opening Canvas…</p>}>
                <Canvas
                  key={`${user?.id || "guest"}:${demo}`}
                  demo={demo}
                  user={user}
                  models={models}
                  config={config}
                  refresh={refresh}
                  veilOn={veilOn}
                  setVeilOn={setVeilOn}
                  veilWords={veilWords}
                  vault={vault}
                  vaultLive={vaultLive}
                  onUnlockVault={() => setVaultDialog({ kind: vault.status === "none" ? "setup" : "unlock" })}
                />
              </Suspense>
            )
          ) : mode === "translate" ? (
            isReleased(config, "doctranslate") && (
              <Suspense fallback={<p className="translate-loading">Opening Translate docs…</p>}>
                <Translate key={`${user?.id || "guest"}:${demo}`} demo={demo} user={user} models={models} config={config} refresh={refresh} veilOn={veilOn} setVeilOn={setVeilOn} veilWords={veilWords} />
              </Suspense>
            )
          ) : mode === "tools" ? (
            <TaskTools key={`${user?.id || "guest"}:${demo}`} demo={demo} user={user} models={models} config={config} refresh={refresh} veilOn={veilOn} setVeilOn={setVeilOn} veilWords={veilWords} />
          ) : mode === "collab" ? (
            <CollabHub demo={demo} user={user} />
          ) : mode === "symposium" ? (
            <Symposium
              demo={demo}
              user={user}
              models={models}
              config={config}
              refresh={refresh}
              veilOn={veilOn}
              setVeilOn={setVeilOn}
              veilWords={veilWords}
              setVeilWords={setVeilWords}
              projects={projectsLive ? projects.list : []}
              onFiled={projects.reload}
              onResults={setSymposiumShown}
            />
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
                    Shared in <b data-i18n="off">{shared.name}</b>
                    {teamPays.on
                      ? " · members see this conversation; Team pays charges the team treasury."
                      : " · members see this conversation; each pays for their own requests."}
                    <Link to="/workspace/collab">Open collab</Link>
                  </div>
                )}
                {branchesLive && textMode && lineage.parent && (
                  <div className="branch-banner">
                    <Icon name="arrow" size={14} />
                    Branched from{" "}
                    <button
                      type="button"
                      data-i18n="off"
                      onClick={() => openChat({ mode, ...lineage.parent })}
                    >
                      {lineage.parent.title || "Untitled"}
                    </button>
                    <span>The original is unchanged.</span>
                  </div>
                )}
                {textMode && importedFrom && (
                  <div className="branch-banner import-banner">
                    <Icon name="import" size={14} />
                    {`Imported from ${importedFrom === "claude" ? "Claude" : "ChatGPT"}.`}
                    <span>The replies were written by that service, not by an ANONYMA model.</span>
                  </div>
                )}
                {highlightLive && (
                  <HighlightToolbar
                    key={current || vaultChatId || "new"}
                    root={threadRef}
                    enabled={messages.length > 0 && !editing}
                    onQuote={quoteIntoComposer}
                    onCard={cardsLive ? setCard : null}
                    factCheck={factCheck}
                  />
                )}
                {carried && textMode && (
                  <ContinuedBanner
                    carried={carried}
                    onOpen={
                      carried.kind === "saved" && carried.from?.id
                        ? () => openChat({ mode, ...carried.from })
                        : carried.kind === "vault" && vault.chats.some((c) => c.id === carried.from?.id)
                          ? () => openVaultChat(vault.chats.find((c) => c.id === carried.from.id))
                          : null
                    }
                  />
                )}
                {(messages.length || carried) && textMode ? (
                  <div className={"messages" + (highlightLive ? " highlight-live" : "")} ref={threadRef}>
                    {carried && (
                      <CarriedSummary
                        key={current || vaultChatId || "carried"}
                        summary={carried.summary}
                        restore={(s) => unveil(s, veilStateRef.current.map)}
                        started={messages.length > 0}
                      />
                    )}
                    {messages.map((m, i) => {
                      // A saved user message may carry <document> blocks after
                      // the typed prompt; render those as collapsed chips
                      // instead of a wall of extracted text. Replies are left
                      // as written, even if a model echoes the tags back.
                      const parsed =
                        m.role === "user"
                          ? parseDocumentBlocks(m.content)
                          : { text: m.content, documents: [] };
                      const hasDocuments = parsed.documents.length > 0;
                      // Onchain Explainer's facts are drawn as a card, not a chip.
                      const chainDocs = onchainReleased(config)
                        ? parsed.documents.filter(isChainFactsDocument)
                        : [];
                      const otherDocs = chainDocs.length
                        ? parsed.documents.filter((d) => !chainDocs.includes(d))
                        : parsed.documents;
                      const shown =
                        parsed.text || (hasDocuments ? "" : m.interrupted && chatControlLive ? "Reply interrupted. Check charge status below." : "Preparing…");
                      // Reply parts: Live Preview's and Python Runner's code
                      // block tools; Run waits until the reply has finished.
                      const replyParts =
                        m.role !== "assistant"
                          ? undefined
                          : busy && i === messages.length - 1
                            ? python.streamingComponents
                            : python.components;
                      const body = (
                        <ReplyMarkdown
                          // Math & Diagrams: only replies are typeset or drawn.
                          rich={m.role === "assistant"}
                          remarkPlugins={[
                            remarkGfm,
                            // Re-runs on every render (incl. mid-stream) so a
                            // [TAG_n] split across chunks resolves once whole.
                            [veilRemarkPlugin, { map: veilStateRef.current.map }],
                          ]}
                          components={
                            shieldView
                              ? shieldMarkdown(replyParts)
                              : replyParts
                          }
                        >
                          {shown}
                        </ReplyMarkdown>
                      );
                      return (
                      <article
                        key={i}
                        data-message-id={m.id || undefined}
                        className={
                          "message " +
                          m.role +
                          (busy &&
                          i === messages.length - 1 &&
                          m.role === "assistant"
                            ? " streaming"
                            : "") +
                          (highlight && m.id === highlight ? " bookmark-target" : "") +
                          (m.research && researchAvailable ? " research-report" : "")
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
                            {m.blind && <span>BLIND COMPARE</span>}
                            {m.role === "assistant" && m.model && !m.sample && (
                              <span className="model-tag">
                                {m.model === AUTO ? "Auto" : models.find((x) => x.id === m.model)?.name || m.model}
                              </span>
                            )}
                          </div>
                          {m.blind ? (
                            <BlindTurn
                              blind={m.blind}
                              last={i === messages.length - 1}
                              busy={busy}
                              voting={blindVoting != null || !blindLive}
                              veilMap={veilStateRef.current.map}
                              trailLive={trailLive}
                              receiptsLive={isReleased(config, "receipts")}
                              models={models}
                              onVote={(outcome) => voteBlind(i, outcome)}
                              onContinue={continueWith}
                              onKeepComparing={() => keepComparing(m.blind.reveal)}
                              Markdown={ReplyMarkdown}
                              markdown={shieldView ? shieldMarkdown() : undefined}
                              highlightable={highlightLive}
                            />
                          ) : (
                          <>
                          {/* The typed text is user content, so it stays
                              untranslated; with documents attached only it is
                              fenced off, leaving the chips' labels to the
                              language switch while their names stay as sent. */}
                          {highlightLive && m.factcheck ? (
                            <FactCheckCard factcheck={m.factcheck} citations={m.citations} />
                          ) : (
                          <div
                            className="markdown"
                            data-i18n={m.content && !hasDocuments ? "off" : undefined}
                            // Highlight & Ask: a finished reply's text can be selected to ask about.
                            data-highlight-reply={
                              highlightLive &&
                              m.role === "assistant" &&
                              m.content &&
                              !m.research?.live &&
                              !m.factcheck &&
                              !(busy && i === messages.length - 1)
                                ? ""
                                : undefined
                            }
                            // The model that wrote it, for Quote Cards' credit line.
                            data-highlight-model={
                              cardsLive && highlightLive && m.role === "assistant" && m.model ? m.model : undefined
                            }
                          >
                            {m.research?.live ? (
                              <ResearchProgress research={m.research} />
                            ) : hasDocuments ? (
                              <div className="document-prompt" data-i18n="off">
                                {body}
                              </div>
                            ) : (
                              body
                            )}
                            {otherDocs.length > 0 && (
                              <MessageDocuments
                                documents={otherDocs}
                                veilMap={veilStateRef.current.map}
                                asData={shieldReleased(config) && parsed.asData}
                                linkCards={linkCardsLive}
                              />
                            )}
                            {chainDocs.length > 0 && (
                              <MessageChainFacts
                                documents={chainDocs}
                                veilMap={veilStateRef.current.map}
                              />
                            )}
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
                          )}
                          {researchAvailable && m.role === "assistant" && m.research && !m.research.live && (
                            <ResearchDetails
                              research={m.research}
                              citations={m.citations}
                              trail={trailLive}
                            />
                          )}
                          {m.citations?.length > 0 && !(researchAvailable && m.research) && !(highlightLive && m.factcheck) && (
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
                          </>
                          )}
                          {/* Auto Model: which model answered and why, and
                              one click to regenerate on another. */}
                          {m.role === "assistant" && m.auto && !m.sample && !(busy && i === messages.length - 1 && !m.content) && (
                            <AutoChip
                              auto={m.auto}
                              models={models}
                              alternatives={m.auto.sealed ? sealedAutoTiers : autoTiers}
                              disabled={busy || branching}
                              onUse={
                                branchesLive && m.content && !m.research && !m.blind && !m.filesearch && !(busy && i === messages.length - 1)
                                  ? (id) => rewind(i, "regenerate", null, { model: id })
                                  : null
                              }
                            />
                          )}
                          {m.role === "assistant" && m.private && (
                            <PrivateReplyNote info={m.private} masked={m.masked} />
                          )}
                          {m.role === "assistant" && m.sealed && (
                            <SealedReplyNote info={m.sealed} />
                          )}
                          {m.role === "assistant" && m.memoryUsed && (
                            <MemoryUsedNote memory={m.memoryUsed} />
                          )}
                          {trailLive && m.role === "assistant" && m.privacy && (
                            <PrivacyTrail
                              key={m.requestId || m.id || i}
                              privacy={m.privacy}
                              models={models}
                              receiptsLive={isReleased(config, "receipts")}
                            />
                          )}
                          {m.role === "assistant" && m.content && !m.blind && (
                            <CopyButton text={m.content} />
                          )}
                          {/* A Deep research report says so itself when it was cut short;
                              a continuation would be a chat, not more research. */}
                          {longAnswersLive && m.role === "assistant" && !m.blind && !m.research && !m.factcheck && !m.filesearch && completionNotice(m) && (
                            <div className="fine-print" role="status">
                              <p>{completionNotice(m)}</p>
                              {i === messages.length - 1 && !busy && (m.content || m.reasoning) && (
                                <button type="button" className="small-button" onClick={() => {
                                  setPrompt(CONTINUE_PROMPT);
                                  setInfo("Continuation is a new paid request. Review the estimate, then press Send. Your previous answer stays here.");
                                  promptBox.current?.focus();
                                }}>Prepare continuation</button>
                              )}
                            </div>
                          )}
                          {!demo && isReleased(config, "voice") && !sealedOn && !sealedThread &&
                            m.role === "assistant" && m.content && !m.blind && !busy && (
                            <button type="button" className="small-button"
                              onClick={() => setReadAloud(m.content)}>
                              Read aloud
                            </button>
                          )}
                          {overviewOn && m.role === "assistant" && m.research && !m.research.live && m.content && !busy && (
                            <button type="button" className="small-button overview-listen" onClick={() => openOverview(m)}>
                              Listen as an audio overview
                            </button>
                          )}
                          {!(branchesLive && !busy && !branching && editing?.index !== i && !m.sample) &&
                            (rememberButton(m) || bookmarks.actions(m, i, messages) || cardButton(m, i)) && (
                              <div className="turn-actions">
                                {bookmarks.actions(m, i, messages)}
                                {rememberButton(m)}
                                {cardButton(m, i)}
                              </div>
                            )}
                          {branchesLive && editing?.index === i && (
                            <form
                              className="edit-turn"
                              onSubmit={(e) => {
                                e.preventDefault();
                                rewind(i, "edit", editing.text);
                              }}
                            >
                              <textarea
                                aria-label="Edit your message"
                                data-i18n="off"
                                value={editing.text}
                                autoFocus
                                onChange={(e) =>
                                  setEditing({ index: i, text: e.target.value })
                                }
                              />
                              <p className="fine-print">
                                {deviceOnly
                                  ? "Sends from this point again. Device Vault keeps the new version."
                                  : ephemeral || demo || !current
                                  ? "Sends from this point again. Nothing here is saved."
                                  : "Sends from this point in a new branch. The original conversation stays as it is."}
                              </p>
                              <SeedGuardNotice
                                hit={editSeed}
                                busy={busy || branching}
                                onProceed={() => rewind(i, "edit", editing.text, { allowSeed: true })}
                              />
                              <SecretGuardNotice
                                finds={editSeed ? [] : editFinds}
                                busy={busy || branching}
                                onMask={() => {
                                  const masked = maskSecrets(editing.text, veilStateRef.current).text;
                                  setEditing({ index: i, text: masked });
                                  rewind(i, "edit", masked);
                                }}
                                onRemove={() => setEditing({ index: i, text: removeSecrets(editing.text).text })}
                                onProceed={() => rewind(i, "edit", editing.text, { allowSecret: true })}
                              />
                              <div className="edit-turn-actions">
                                <button type="button" className="small-button" onClick={() => setEditing(null)}>
                                  Cancel
                                </button>
                                <button className="small-button primary" disabled={!editing.text.trim() || busy || branching || !!editSeed || editFinds.length > 0}>
                                  Send edit
                                </button>
                              </div>
                            </form>
                          )}
                          {branchesLive && !busy && !branching && editing?.index !== i && !m.sample && (
                            <div className="turn-actions">
                              {bookmarks.actions(m, i, messages)}
                              {m.role === "user" && m.content !== undefined && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setEditing({ index: i, text: promptParts(m.content).typed })
                                  }
                                >
                                  Edit
                                </button>
                              )}
                              {rememberButton(m)}
                              {m.role === "assistant" && m.content && !m.blind && !m.research && !m.factcheck && !m.filesearch && (
                                <button type="button" onClick={() => rewind(i, "regenerate")}>
                                  Regenerate
                                </button>
                              )}
                              {cardButton(m, i)}
                              {/* A File Search answer can't be regenerated here: a chat would
                                  answer without the files. Asking again reopens File Search with
                                  the question, carried in the route's state, never in the address. */}
                              {m.role === "assistant" && m.filesearch && !demo && modeReleased(config, "filesearch") && (
                                <Link
                                  className="turn-link"
                                  to="/workspace/filesearch"
                                  state={{
                                    filesearchQuestion: unveil(
                                      String(messages.slice(0, i).filter((x) => x.role === "user").at(-1)?.content || ""),
                                      veilStateRef.current.map,
                                    ),
                                  }}
                                >
                                  Ask again in File Search
                                </Link>
                              )}
                              {!ephemeral && !demo && current && m.id && (
                                <button type="button" onClick={() => branchFrom(m)}>
                                  Branch from here
                                </button>
                              )}
                            </div>
                          )}
                          {bookmarks.details(m, i)}
                          {branchesLive && branchesAt(lineage.branches, m.id).length > 0 && (
                            <div className="branch-chips">
                              <span>Branches</span>
                              {branchesAt(lineage.branches, m.id).map((b) => (
                                <button
                                  type="button"
                                  key={b.id}
                                  data-i18n="off"
                                  onClick={() => openChat({ mode, ...b })}
                                >
                                  {b.title || "Untitled"}
                                </button>
                              ))}
                            </div>
                          )}
                          {doubleCheckLive &&
                            m.role === "assistant" &&
                            m.content &&
                            !m.blind &&
                            !m.factcheck &&
                            // A saved File Search answer: a check here would see the
                            // answer without the passages it was written from.
                            !m.filesearch &&
                            m.model &&
                            !m.sample &&
                            !(busy && i === messages.length - 1) &&
                            (checking === i ? (
                              <DoubleCheck
                                key={(current || "local") + ":" + i}
                                answer={m}
                                question={
                                  messages.slice(0, i).filter((x) => x.role === "user").at(-1)?.content || ""
                                }
                                models={visibleModels}
                                privateMode={privateMode}
                                ephemeral={ephemeral}
                                sourceConversation={current}
                                mask={doubleCheckVeil ? veilForCheck : null}
                                maskPolicy={
                                  doubleCheckVeil ? "veil:" + JSON.stringify(veilWords) : "off"
                                }
                                veilMap={veilStateRef.current.map}
                                onClose={() => setChecking(null)}
                                refresh={refresh}
                                seedGuard={seedLive}
                                shield={shieldView}
                              />
                            ) : (
                              <button
                                type="button"
                                className="double-check-action"
                                onClick={() => setChecking(i)}
                              >
                                Double-check this
                              </button>
                            ))}
                        </div>
                      </article>
                      );
                    })}
                    {catchupOn && !busy && <CatchUpNudge onOpen={() => setCatchupOpen(true)} />}
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
                {voiceOpen && !privateMode && !sealedOn && textMode && !demo &&
                  isReleased(config, "voice") && isReleased(config, "audio") && (
                  <VoiceAssist
                    ephemeral={ephemeral} disabled={busy} refresh={refresh}
                    onClose={() => setVoiceOpen(false)}
                    onText={t => {
                      setPrompt(p => p.trim() ? p.trimEnd() + " " + t : t);
                      promptBox.current?.focus();
                    }}
                  />
                )}
                {isReleased(config, "ephemeral") &&
                  ephemeral &&
                  !privateMode &&
                  !sealedOn &&
                  !deviceOnly &&
                  textMode && <EphemeralNotice />}
                {vaultLive && deviceOnly && textMode && (
                  <DeviceOnlyNotice
                    locked={!vault.unlocked}
                    onUnlock={() =>
                      setVaultDialog({ kind: vault.status === "none" ? "setup" : "unlock" })
                    }
                    synced={vaultSync.on}
                  />
                )}
                {!demo &&
                  privateModeReleased(config) &&
                  privateMode &&
                  textMode &&
                  (privateModelsCallable.length ? (
                    <PrivateModeNotice />
                  ) : (
                    <NoPrivateModelsNotice />
                  ))}
                {project && (
                  <ProjectBar
                    project={project}
                    saved={!!current || messages.length > 0}
                    fresh={!current && !messages.length}
                    instructionsOn={!!project.instructions.trim()}
                    attached={documents.filter((d) => d.pinned).length}
                    pinsBlocked={pinsBlocked}
                    note={
                      deviceOnly
                        ? "Device only: grouped with this project in Device Vault"
                        : ephemeral
                          ? "Not saved, so not listed in the project"
                          : ""
                    }
                    onLeave={leaveProject}
                  />
                )}
                {blindActive && (
                  <BlindBar
                    pool={blindModels}
                    pair={blindPair}
                    surprise={blindSurprise}
                    current={selected}
                    busy={busy}
                    waiting={blindAwaiting && !busy}
                    onPick={(pair) => {
                      setBlindPair(pair);
                      setBlindSurprise(false);
                    }}
                    onSurprise={surpriseBlind}
                    onChoose={() => setBlindSurprise(false)}
                    onRankings={() => setBlindRankings(true)}
                    notes={[
                      privateMode ? "Private mode: zero-data-retention models only." : "",
                      needsVision ? "Showing models that can read your images." : "",
                    ].filter(Boolean)}
                  />
                )}
                {blindAwaiting && !blindActive && !busy && (
                  <Notice>Vote on the replies above to continue.</Notice>
                )}
                {researchOn && !busy && (
                  <ResearchPanel
                    depth={researchDepth}
                    onDepth={setResearchDepth}
                    estimate={researchEstimate}
                    block={researchBlocked}
                    attached={imageItems.length + documents.length}
                    compact={messages.length > 0}
                  />
                )}
                {sealedOn && (
                  <SealedPanel
                    state={enclave.state}
                    onRetry={enclave.retry}
                    holdCredits={sealedHoldCredits}
                    noModels={!sealedModels.length}
                  />
                )}
                {sharpenAvailable && (
                  <SharpenPanel
                    sharpen={sharpen}
                    pool={sharpenModels}
                    model={sharpenModel}
                    onModel={chooseSharpener}
                    estimate={sharpenEstimate}
                    onUse={(text) => {
                      setPrompt(sharpen.state.prefix + text);
                      sharpen.used(text);
                      promptBox.current?.focus();
                    }}
                    onUndo={() => {
                      setPrompt(sharpen.state.prefix + sharpen.state.original);
                      sharpen.reset();
                      promptBox.current?.focus();
                    }}
                    onAnswer={(answers) => runSharpen({ answers })}
                    onRetry={() => runSharpen({ answers: sharpen.state.answers })}
                    teamPays={teamPays.on}
                  />
                )}
                {info && <Notice>{info}</Notice>}
                {error && (
                  <Notice type="error">
                    {error}
                    {/* A refusal by the account's own Spending Limits. */}
                    {isReleased(config, "limits") &&
                      /\byour (whole )?(daily|monthly) spending limit\b/i.test(error) && (
                        <Link className="limit-link" to={"/account/limits" + (demo ? "?demo=1" : "")}>
                          Spending limits
                        </Link>
                      )}
                    {/* Too few credits (never a spending limit): Top up. */}
                    <LowBalanceRefusal config={config} user={user} demo={demo} error={error} />
                  </Notice>
                )}
                {chatControlLive && <ChargeStatus state={charge.state} checking={charge.checking} recover={charge.recover} />}
                {receipt && (!chatControlLive || receipt.request_id || receipt.signed_receipt) && (
                  <div className="receipt">
                    <span className="sq" aria-hidden="true" />
                    {chatControlLive ? "Usage receipt" : receipt.sample
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
                    {isReleased(config, "receipts") && receipt.signed_receipt && (
                      <SignedReceipt signedReceipt={receipt.signed_receipt} />
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
                <SeedGuardNotice
                  hit={guardTurn === "seed" ? seedHit : null}
                  busy={busy || onchainLooking}
                  onProceed={() => send(null, null, { allowSeed: true })}
                  onExplain={onchainShown?.kind === "transaction" ? explainOnchain : undefined}
                  hardOverride={!researchOn}
                >
                  {researchOn && (
                    <p className="seed-guard-note">
                      Deep research turns your question into web searches, so it never sends this.
                    </p>
                  )}
                </SeedGuardNotice>
                <SecretGuardNotice
                  finds={guardTurn === "secret" ? secretFinds : []}
                  busy={busy || onchainLooking || !!secretQueued}
                  onMask={maskComposerSecrets}
                  onRemove={removeComposerSecrets}
                  // Deep research turns the question into web searches, so a
                  // secret there is masked or removed, never sent as it is.
                  onProceed={researchOn ? undefined : () => send(null, null, { allowSeed: seedAnswered, allowSecret: true })}
                />
                <OnchainChip
                  hit={onchainShown}
                  choice={onchainChoice}
                  setChoice={setOnchainChoice}
                  onExplain={explainOnchain}
                  onDismiss={() => setOnchainDismissed(onchainKey)}
                  busy={busy}
                  looking={onchainLooking}
                  error={onchainError}
                  blocked={onchainBlocked}
                  veilOn={veilOn && isReleased(config, "veil")}
                />
                {shieldOn && (
                  <ShieldPasteNotice
                    report={pasteShield}
                    onReview={() => setShieldOpen({ paste: true })}
                    onRemoveFlagged={() => rewritePaste((p) => cleanText(p.original, p.result, { stripInvisible: p.removed > 0, removeFlagged: true }), { flagged: false })}
                    onAttach={
                      pasteShield?.long && isReleased(config, "documents") && documents.length < MAX_DOCUMENTS
                        ? attachPaste
                        : null
                    }
                    onRestore={() => rewritePaste((p) => p.original, { removed: 0 })}
                    onDismiss={() => setPasteShield(null)}
                  />
                )}
                <form className="composer" onSubmit={send}>
                  {imageItems.length > 0 && (
                    <div className="attachment-list">
                      {imageItems.map((a, i) => a.clean || redactLive || ocrLive ? (
                        <CleanImageChip
                          key={i}
                          item={a}
                          onKeep={(keep) =>
                            setAttachments((p) => p.map((x, j) => (j === i ? withKeep(x, keep) : x)))
                          }
                          onRemove={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                        >
                          <span className="ocr-chip-tools">
                          {redactLive && (
                            <RedactChipTools
                              item={a}
                              disabled={busy}
                              onOpen={() => setRedacting(a)}
                            />
                          )}
                          {ocrLive && (
                            <OcrChipTool
                              item={a}
                              disabled={busy}
                              onOpen={() => setOcrItem(a)}
                            />
                          )}
                          </span>
                        </CleanImageChip>
                      ) : (
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
                  {!demo &&
                    textMode &&
                    isReleased(config, "documents") && (
                    <DocumentChips
                      documents={sentDocuments}
                      setDocuments={setDocuments}
                      prompt={prompt}
                      shield={
                        shieldOn
                          ? { results: shieldScans, asData: sendAsData, onOpen: (id) => setShieldOpen({ doc: id }) }
                          : null
                      }
                    />
                  )}
                  {linkLive && (
                    <LinkReaderChips
                      prompt={prompt}
                      documents={documents}
                      setDocuments={setDocuments}
                      disabled={busy}
                      sealed={sealedOn}
                      pdfHidden={shieldOn ? pdfHiddenText : null}
                      onError={setError}
                    />
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
                    onPaste={shieldOn ? shieldPaste : undefined}
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
                          <EarlyModelTag model={m} />
                          {trainingLive && m.trainsOnPrompts && (
                            <TrainingTag model={m} models={visibleModels} />
                          )}
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
                  <div
                    className={
                      "composer-controls" +
                      (estimatesLive && textMode ? " with-estimate" : "")
                    }
                  >
                    <div>
                      {blindActive ? null : sealedOn ? (
                        <select
                          className="sealed-model"
                          aria-label="Sealed model"
                          data-i18n="off"
                          value={sealedAutoOn ? AUTO : sealedTarget?.id || ""}
                          disabled={busy}
                          onChange={(e) => setSealedModelId(e.target.value)}
                        >
                          {/* Auto Model: rules only, in this browser. */}
                          {autoModelReleased(config) && sealedModels.length > 1 && (
                            <option value={AUTO}>{t("Auto")}</option>
                          )}
                          {sealedModels.map((m) => (
                            <option value={m.id} key={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                      <>
                      {finderLive ? (
                        <ModelFinder
                          models={finderModels}
                          mode={mode}
                          markup={config?.markup}
                          resolved={resolvedModel}
                          onChoose={chooseModel}
                          opts={finderOpts}
                          notes={[
                            textMode && privateMode ? "Private mode: zero-data-retention models only." : "",
                            needsVision ? "Showing models that can read your images." : "",
                          ].filter(Boolean)}
                          trainingLive={trainingLive}
                          demo={demo}
                          status={modelStatus}
                          arena={arenaRank}
                          // Auto Model, once released (src/AutoModel.jsx).
                          auto={autoLive ? { on: autoChosen, tiers: autoTiers, onChoose: chooseAuto, note: autoNote } : null}
                          // On-Device Model: in Chat, a way to its page.
                          onDevice={
                            mode === "chat" && isReleased(config, "ondevice")
                              ? () => navigate("/workspace/device" + (demo ? "?demo=1" : ""))
                              : null
                          }
                        />
                      ) : (
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
                            <option
                              value={m.id}
                              key={m.id}
                              title={
                                trainingLive && m.trainsOnPrompts
                                  ? trainingTitle(m, visibleModels)
                                  : undefined
                              }
                            >
                              {m.name}
                              {!demo && m.private ? " · Private" : ""}
                              {earlyModelSuffix(m)}
                              {trainingLive && m.trainsOnPrompts
                                ? " · Trains on prompts"
                                : ""}
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
                      )}
                      </>
                      )}
                      {(mode === "image" ||
                        (blindActive
                          ? blindTargets.length === 2 && blindTargets.every((m) => m.vision)
                          : selected?.vision && !sealedOn)) && (
                        <label
                          className="attachment-control"
                          title="Add reference image"
                        >
                          <Icon name="plus" size={18} />
                          <span className="sr-only">Add reference images</span>
                          <input
                            type="file"
                            multiple
                            accept={
                              "image/png,image/jpeg,image/webp,image/gif" +
                              (cleanLive ? ",image/heic,image/heif,.heic,.heif" : "")
                            }
                            onChange={addFiles}
                          />
                        </label>
                      )}
                      {!demo &&
                        textMode &&
                        isReleased(config, "documents") && (
                        <DocumentAttach
                          key={user?.id}
                          documents={documents}
                          setDocuments={setDocuments}
                          disabled={busy}
                          onError={setError}
                          filesEnabled={isReleased(config, "files") && !sealedOn}
                          cleanEnabled={cleanLive}
                          privateContext={privateMode || ephemeral || veilOn}
                          audioEnabled={isReleased(config, "audio")}
                          onRefresh={refresh}
                          openRequest={filesRequest}
                          seedGuard={seedLive}
                          shieldHidden={shieldOn}
                        />
                      )}
                      {["chat", "code"].includes(mode) &&
                        !sealedOn &&
                        isReleased(config, "search") &&
                        // Blind never searches the web.
                        !blindActive && (
                        <button
                          type="button"
                          className={
                            "attachment-control web-toggle" +
                            (webSearch ? " on" : "")
                          }
                          aria-pressed={webSearch}
                          title="Search the web before answering (about 21 credits per search)"
                          onClick={() => {
                            // Deep research always searches; the two are one or the other.
                            if (!webSearch) setResearchDepth(null);
                            setWebSearch((v) => !v);
                          }}
                        >
                          <Icon name="globe" size={17} />
                          <span>Web</span>
                        </button>
                      )}
                      <button type="button" className="attachment-control composer-options-toggle"
                        aria-expanded={composerOptionsOpen} aria-controls="composer-options-panel"
                        onClick={() => setComposerOptionsOpen(v => !v)}>
                        <Icon name="settings" size={17} /><span>Options</span>
                      </button>
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
                    {incompatibleMention && (
                      <span role="status">The mentioned model cannot read this conversation’s images. Choose a vision model.</span>
                    )}
                    <span className="send-cluster">
                    {blindActive ? (
                      <BlindEstimate state={blindEstimate} />
                    ) : researchOn ? (
                      <ResearchEstimate state={researchEstimate} />
                    ) : (
                      estimatesLive && textMode && (autoActive
                        ? <AutoEstimate state={estimate} models={models} />
                        : <CreditEstimate state={estimate} />)
                    )}
                    {costCompareLive && !blindActive && !researchOn && (
                      // Not with Auto, which prices its own candidates.
                      !autoActive && <CostCompare
                        base={compareBase}
                        mode={mode}
                        privateMode={privateMode}
                        replyBudget={longAnswersLive ? replyBudget : REPLY_BUDGET}
                        current={selected}
                        pool={finderLive ? finderModels : visibleModels}
                        allModels={models}
                        presetOpts={finderOpts}
                        presetsLive={finderLive}
                        notes={[
                          privateMode ? "Private mode: zero-data-retention models only." : "",
                          finderLive && needsVision ? "Showing models that can read your images." : "",
                        ].filter(Boolean)}
                        busy={busy}
                        onSwitch={(id) => {
                          if (finderLive) chooseModel({ model: id });
                          else {
                            setModel(id);
                            setQuote(null);
                          }
                        }}
                      />
                    )}
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
                          !!seedHit ||
                          secretHeld ||
                          !!researchBlocked ||
                          (finderLive && !selected && !sealedOn && !blindActive) ||
                          (blindActive && !validPair(blindPair, blindModels)) ||
                          blindAwaiting ||
                          incompatibleMention ||
                          (privateMode && !privateModelsCallable.length) ||
                          // Sealed Mode sends only once the enclave is verified.
                          (sealedOn && (!sealedTarget || enclave.state.status !== "verified"))
                        }
                        aria-label={demo ? "Run sample" : "Generate"}
                      >
                        <Icon name="arrow" size={21} />
                      </button>
                    )}
                    </span>
                  </div>
                  {textMode && <p className="composer-storage-status">
                    {demo ? "Local sample · no charges" : deviceOnly ? (vaultSync.on ? "Device Vault · encrypted sync on" : "Device Vault · saved on this device") : ephemeral || sealedOn || privateMode ? "Off the record · chat not saved to your account" : "Chat saved to your account"}
                    {privateMode && " · Private mode"}
                    {sealedOn && " · Sealed mode"}
                    {veilOn && " · Veil on"}
                    {memoryLive && memoryUse && !memoryExcluded && " · Memory on"}
                    {instructionsActive && " · Standing instructions on"}
                  </p>}
                  <div id="composer-options-panel" className="composer-options-panel" hidden={!composerOptionsOpen}>
                      {researchAvailable && !sealedOn && (
                        <ResearchToggle
                          on={researchOn}
                          disabled={busy}
                          onToggle={() => {
                            if (!researchDepth) {
                              setWebSearch(false);
                              // Blind and Deep research are one or the other.
                              setBlindOn(false);
                            }
                            setResearchDepth((d) => (d ? null : "quick"));
                          }}
                        />
                      )}
                      {["chat", "code"].includes(mode) && !sealedOn && teamPays.toggle}
                      {!demo &&
                        isReleased(config, "ephemeral") &&
                        textMode && (
                        <EphemeralToggle
                          active={ephemeral && !deviceOnly}
                          onToggle={toggleEphemeral}
                          disabled={privateMode || sealedOn}
                          reason={sealedOn ? "Off the record is on for this chat because Sealed Mode is on" : undefined}
                        />
                      )}
                      {vaultLive && textMode && (
                        <DeviceOnlyToggle
                          active={deviceOnly}
                          onToggle={toggleDeviceOnly}
                          disabled={busy}
                          synced={vaultSync.on}
                        />
                      )}
                      {!demo &&
                        privateModeReleased(config) &&
                        textMode && (
                        <PrivateModeToggle
                          active={privateMode}
                          onToggle={togglePrivateMode}
                          disabled={sealedOn}
                        />
                      )}
                      {blindLive && !shared && (
                        <BlindToggle
                          active={blindActive}
                          onToggle={toggleBlind}
                          disabled={busy || sealedOn || sealedThread}
                          reason={sealedOn || sealedThread ? "Blind isn't available in Sealed Mode" : undefined}
                        />
                      )}
                      {sealedAvailable && (
                        <SealedToggle
                          active={sealedOn}
                          onToggle={toggleSealed}
                          disabled={busy}
                        />
                      )}
                      {textMode &&
                        !demo &&
                        isReleased(config, "veil") && (
                        <VeilToggle on={veilOn} onToggle={() => setVeilOn((v) => !v)} />
                      )}
                      {textMode && !demo && !privateMode && !sealedOn &&
                        isReleased(config, "voice") && isReleased(config, "audio") && (
                        <button type="button" className="attachment-control"
                          disabled={busy} aria-pressed={voiceOpen}
                          onClick={() => setVoiceOpen(v => !v)}>
                          Voice-assisted chat
                        </button>
                      )}
                      {["chat", "code"].includes(mode) && !privateMode && !sealedOn &&
                        !isReleased(config, "voice") && isReleased(config, "audio") && (
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
                      {textMode && scrollsLive && !sealedOn && (
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
                      {sharpenAvailable && (
                        <SharpenButton
                          block={busy ? "Wait for the reply to finish." : sharpenBlocked}
                          estimate={sharpenEstimate}
                          running={sharpen.state.status === "running"}
                          onSharpen={() => runSharpen()}
                          onStop={sharpen.stop}
                        />
                      )}
                      {longAnswersLive && textMode && !demo && !sealedOn && !researchOn && (
                        <label className="fine-print">
                          Reply budget
                          <select aria-label="Reply token budget" value={selectedReplyBudget} disabled={busy}
                            onChange={(e) => setReplyBudget(Number(e.target.value))}>
                            {replyBudgets(autoActive ? AUTO_BUDGET_MODEL : target, selectedReplyBudget).map(value => <option key={value} value={value}>{value.toLocaleString()} tokens</option>)}
                          </select>
                          {autoActive ? (
                            <span>With Auto, each model gets this budget up to its own limit.</span>
                          ) : !target?.chatLimits?.outputLimitKnown && <span>Provider output cap unavailable; conservative service limit.</span>}
                          <span>Higher budgets can cost and reserve more. Reasoning can use this budget. Chat history is kept or refused, never trimmed.</span>
                        </label>
                      )}
                      {textMode && memoryLive && (
                        <button
                          type="button"
                          className={
                            "attachment-control memory-button" + (memoryExcluded ? " excluded" : "")
                          }
                          disabled={!!memoryExcluded}
                          aria-pressed={memoryUse}
                          title={
                            memoryExcluded ||
                            (memoryUse
                              ? `Memory on: ${memory.facts.filter((f) => f.enabled).length} facts go with this chat`
                              : "Memory: facts you choose to share with every model")
                          }
                          onClick={() => setMemoryPanel({})}
                        >
                          <Icon name="memory" size={17} />
                          <span>Memory</span>
                          {memoryUse && <span className="memory-dot" aria-hidden="true" />}
                        </button>
                      )}
                  </div>
                  {/* Training Labels: under the model picker, never blocking Send. */}
                  {trainingSelected && !sealedOn && !blindActive && (
                    <TrainingNotice
                      model={trainingSelected}
                      alternative={trainingAlternative}
                      onSwitch={() => {
                        if (finderLive) chooseModel({ model: trainingAlternative.id });
                        else setModel(trainingAlternative.id);
                        setQuote(null);
                      }}
                      onDismiss={() => dismissTraining(trainingSelected.id)}
                    />
                  )}
                  {/* Model Status: the chosen model is down (never blocks Send). */}
                  {selectedDown && !sealedOn && !blindActive && <ModelDownNotice model={selectedDown} />}
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
                          <EarlyModelTag model={m} />
                        </label>
                      ))}
                    </details>
                  )}
                </form>
                {!messages.length && !carried && (
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
                  {textMode && !estimatesLive && (
                    <button
                      onClick={quoteRequest}
                      disabled={!prompt.trim() || busy || !!seedHit || secretHeld}
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
            <aside className={"code-panel" + (previewing ? " previewing" : "")}>
              {previewLive && <CodePanelTabs tab={codePanelTab} onTab={setCodeTab} />}
              {previewing ? (
                <LivePreview files={files} />
              ) : (
              <>
              <div>
                <h3>Files & revisions</h3>
                <button className="small-button" onClick={exportZip}>
                  <Icon name="download" size={14} />
                  ZIP
                </button>
              </div>
              <p className="fine-print">
                {previewLive
                  ? "Prepared code · HTML runs only in the sandboxed Preview"
                  : "Prepared code · no execution sandbox"}
              </p>
              {files.map((f, i) => (
                <details key={i} open={i === 0}>
                  <summary>
                    <Icon name="file" size={14} />
                    {f.name}
                    <span>v{f.version || Math.floor(i / 2) + 1}</span>
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
              </>
              )}
            </aside>
          )}
        </div>
      </div>
      {htmlPreview.dialog}
      {shieldOn && shieldOpen?.doc && shieldScans.get(shieldOpen.doc) && (
        <ShieldPanel
          name={documents.find((d) => d.id === shieldOpen.doc)?.name || ""}
          result={shieldScans.get(shieldOpen.doc)}
          prefs={shieldPrefs[shieldOpen.doc] || {}}
          onPrefs={(p) => setShieldPrefs((all) => ({ ...all, [shieldOpen.doc]: p }))}
          asData={sendAsData}
          onAsData={setSendAsData}
          onClose={() => setShieldOpen(null)}
        />
      )}
      {shieldOn && shieldOpen?.paste && pasteShield && (
        <ShieldPanel paste result={pasteShield.result} onClose={() => setShieldOpen(null)} />
      )}
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
              {projectsLive && !dialog.item.collab_id && (
                <div className="project-move-row">
                  <ProjectPicker
                    projects={projects.list}
                    value={projects.byId(dialog.item.project_id)?.id || null}
                    onChange={(to) => moveChat(dialog.item, to)}
                  />
                </div>
              )}
              <div className="inline-actions">
                <Button onClick={confirmDialog} disabled={!rename.trim()}>
                  Save name
                </Button>
                <button
                  className="small-button"
                  onClick={() => {
                    if (!exportLive)
                      return download(
                        "conversation.json",
                        JSON.stringify(dialog.item, null, 2),
                      );
                    const c = dialog.item;
                    setDialog(null);
                    exportSaved(c);
                  }}
                >
                  <Icon name="download" size={14} />
                  Export
                </button>
                {sharesLive && (
                  <button
                    className="small-button"
                    onClick={() => {
                      const c = dialog.item;
                      setDialog(null);
                      setShare({
                        conversation: { id: c.id, title: c.title, expires: c.expires ?? null },
                        blocked: shareBlocked({ saved: true, mode: c.mode }),
                      });
                    }}
                  >
                    <Icon name="share" size={14} />
                    Share
                  </button>
                )}
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
      {/* Blind Arena: asked once, right after the vote that prompted it. */}
      {arenaLive && arenaAsk && (
        <ArenaAsk busy={arenaSaving} onAnswer={answerArena} onClose={() => setArenaAsk(null)} />
      )}
      {blindRankings && blindLive && <BlindRankings onClose={() => setBlindRankings(false)} arena={arenaLive ? <Link to="/arena">See the public Blind Arena</Link> : null} />}
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
          seedGuard={seedLive}
        />
      )}
      {memoryPanel && memoryScope && (
        <MemoryPanel
          key={memoryScope}
          memory={memory}
          draft={memoryPanel.draft}
          excluded={memoryExcluded}
          onClose={() => setMemoryPanel(null)}
          previewFacts={estimateRequest(memory.facts).memory || []}
          onToggle={memoryClient.toggle}
          onCreate={memoryClient.create}
          onUpdate={memoryClient.update}
          onDelete={memoryClient.remove}
          onDeleteAll={memoryClient.clear}
          seedGuard={seedLive}
        />
      )}
      {scrollFill && (
        <ScrollFillForm
          scroll={scrollFill}
          onInsert={insertScroll}
          onCancel={() => setScrollFill(null)}
        />
      )}
      {readAloud != null && (
        <ReadAloud text={readAloud} onClose={() => setReadAloud(null)} />
      )}
      {vaultDialog && vaultLive && (
        <VaultDialog
          key={vaultDialog.kind + ":" + (vaultDialog.chat?.id || "")}
          vault={vault}
          dialog={vaultDialog}
          sync={vaultSync}
          sampleModel={selected?.id || null}
          onClose={(why) => {
            const d = vaultDialog;
            setVaultDialog(null);
            if (why !== "deleted") return;
            if (d.kind === "delete") {
              if (deviceOnly && d.chat.id === vaultChatRef.current?.id) newChat();
            } else if (deviceOnly) stopDeviceOnly();
          }}
          onUnlocked={() => {
            const d = vaultDialog;
            setVaultDialog(null);
            if (d.then === "deviceOnly") startDeviceOnly();
          }}
        />
      )}
      {catchupOpen && catchupOn && (
        <Suspense fallback={null}>
        <CatchUpDialog
          key={catchupKey}
          messages={messages}
          carried={carried?.summary || ""}
          models={visibleModels}
          current={selected}
          mode={mode}
          storage={catchupStorage}
          privateMode={privateMode}
          preserveHistory={longAnswersLive}
          veilWith={veilOn && isReleased(config, "veil") ? { state: veilStateRef.current, words: veilWords } : null}
          onVeilUsed={() => {
            // A device-only chat keeps its map in the vault instead.
            if (!deviceOnly) saveVeilState(veilKeyRef.current, veilStateRef.current);
          }}
          restore={(s) => unveil(s, veilStateRef.current.map)}
          trail={trailLive}
          seedGuard={seedLive}
          cached={catchupResults.current.get(catchupKey) || null}
          onResult={(r) => catchupResults.current.set(catchupKey, r)}
          onContinue={continueFresh}
          onClose={() => setCatchupOpen(false)}
          refresh={refresh}
        />
        </Suspense>
      )}
      {exporting && exportLive && (
        <ExportDialog
          key={exporting.id || exporting.reason}
          target={exporting}
          user={user}
          modelName={modelName}
          veilMap={exporting.veilMap}
          testMode={!!config?.testMode}
          onClose={() => setExporting(null)}
        />
      )}
      {card && cardsLive && (
        <Suspense fallback={null}>
          <QuoteCardDialog
            source={card}
            modelName={card.model ? modelName(card.model) : ""}
            veilMap={veilStateRef.current.map}
            seedGuard={seedLive}
            onClose={() => setCard(null)}
          />
        </Suspense>
      )}
      {overview && overviewOn && (
        <Suspense fallback={null}>
          <AudioOverviewDialog
            config={config}
            user={user}
            models={models}
            sources={overview.sources}
            offRecord={overview.offRecord}
            privateMode={privateMode}
            veilWords={veilOn && isReleased(config, "veil") ? veilWords : null}
            office={isReleased(config, "files")}
            onSaved={(r) => r.media && setMedia((prev) => [r.media, ...prev.filter((x) => x.id !== r.media.id)])}
            onClose={() => setOverview(null)}
          />
        </Suspense>
      )}
      {share && sharesLive && (
        <ShareDialog
          key={share.conversation?.id || (share.device ? "device" : share.blocked)}
          conversation={share.conversation}
          device={share.device}
          blocked={share.blocked}
          modelName={shareModelName}
          onClose={() => setShare(null)}
        />
      )}
      {ocrLive && ocrItem && imageItems.includes(ocrItem) && (
        <OcrDialog
          item={ocrItem}
          model={target}
          markup={config?.markup}
          veilWith={veilOn && isReleased(config, "veil") ? { state: veilStateRef.current, words: veilWords } : null}
          documentsFull={documents.length >= MAX_DOCUMENTS}
          onRedact={redactLive && !ocrItem.redacted ? () => {
            setOcrItem(null);
            setRedacting(ocrItem);
          } : null}
          onCancel={() => setOcrItem(null)}
          onUse={(doc) => {
            // The image leaves the composer and its text is attached in its
            // place; nothing keeps the image after this.
            const next = replaceWithText({ images: imageItems, documents, item: ocrItem, doc });
            if (next) {
              setAttachments(next.images);
              setDocuments(next.documents);
            }
            setOcrItem(null);
          }}
        />
      )}
      {redactLive && redacting && imageItems.includes(redacting) && (
        <RedactEditor
          item={redacting}
          onCancel={() => setRedacting(null)}
          onApply={(next) => {
            // The redacted copy takes the original's place; nothing keeps
            // the original after this.
            setAttachments((p) => p.map((x) => (x === redacting ? next : x)));
            setRedacting(null);
          }}
        />
      )}
      {palette.open && (
        <CommandPalette
          items={paletteItems}
          onRun={runPaletteItem}
          onClose={() => palette.setOpen(false)}
          config={config}
          apple={palette.apple}
          recentKey={recentStoreKey({ demo, userId: user?.id })}
          // Private Mode and off-the-record chats leave no palette history either.
          record={!privateMode && !ephemeral}
          placeholder={
            textMode
              ? "Search chats, models, scrolls and actions…"
              : MODEL_MODES.includes(mode)
                ? "Search chats, models and actions…"
                : "Search chats and actions…"
          }
        />
      )}
    </main>
  );
}
function MediaGrid({ media, onDelete, onActions }) {
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
                  : m.prompt || `Saved ${m.kind}`
              }
            />
          )}
          <div>
            <span className="eyebrow">
              {m.sample ? "PREPARED SAMPLE" : m.model}
            </span>
            <h3 data-i18n="off">{m.prompt || `Saved ${m.kind}`}</h3>
            <p>
              {m.model}
              {m.cost != null ? " · " + m.cost + " credits" : ""}
            </p>
            <div className="inline-actions">
              {onActions && !m.sample && <button className="small-button" onClick={() => onActions(m)}>Source & rerun</button>}
              <a className="small-button" href={m.url} download>
                <Icon name="download" size={14} />
                Download
              </a>
              <button
                className="small-button"
                onClick={() => onDelete(m)}
                aria-label={"Delete " + (m.prompt || `saved ${m.kind}`)}
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
