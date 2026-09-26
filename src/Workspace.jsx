import { CONTINUE_PROMPT, replyBudgetFor, replyBudgets, completionNotice } from "./long-answers.js";
import { chatFailureMessage } from "./chat-control.js";
import { useReadingPosition, useRequestCharge, ChargeStatus } from "./ChatControl.jsx";
import HistoryLibrary from "./HistoryLibrary.jsx";
import { useBookmarks, bookmarksReleased } from "./Bookmarks.jsx";
import { useFindInChat, findInChatReleased } from "./FindInChat.jsx";
import React, { useEffect, useMemo, useRef, useState } from "react";
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
import Routines from "./Routines.jsx";
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
import { vaultChat } from "./device-vault.js";
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
import { IMAGE_TYPES, IMAGE_LIMIT, HEIC_LIMIT, isHeicFile, withKeep } from "./clean-notes.js";
import { parseDocumentBlocks, MAX_DOCUMENTS } from "./documents.js";
import { useShieldLive, shieldReleased, ShieldPanel, ShieldPasteNotice, shieldMarkdown } from "./Shield.jsx";
import { scanText, scanDocument, shieldDocument, cleanText, LARGE_PASTE } from "./shield.js";
import Symposium from "./Symposium.jsx";
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
} from "./veil.js";
import { buildChatRequest, cloneVeilState, quoteBody, REPLY_BUDGET } from "./estimate.js";
import { CreditEstimate, useCreditEstimate } from "./CreditEstimate.jsx";
import CostCompare from "./CostCompare.jsx";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import { scanSecrets } from "./seed-guard.js";
import ModelFinder from "./ModelFinder.jsx";
import { STORAGE_KEY as MODEL_CHOICES, loadChoices, resolveChoice, withChoice, requestNeedsVision } from "./model-finder.js";
import { useShareTargetPrefill } from "./share-target.js";
import { InstallAppEntry } from "./InstallApp.jsx";
import { LivePreview, CodePanelTabs, useHtmlPreview } from "./LivePreview.jsx";
import { projectFiles, previewPages, PREVIEW_DEMO_REPLY } from "./live-preview.js";
import { EarlyTag } from "./Holders.jsx";
import { EarlyModelTag, earlyModelSuffix } from "./early-models.js";
import { isEarlyAccess } from "./holders.js";
import CommandPalette, { PaletteButton, usePalette } from "./CommandPalette.jsx";
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
import { useLanguage, setLanguage } from "./i18n.js";
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
const recentConversations = (list) =>
  list.filter((c) => c.mode !== "symposium");
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
          ["symposium", "Symposium"],
          ["code", "Code & build"],
          ["image", "Images"],
          ["video", "Video"],
          ["audio", "Voice & audio"],
          ["collab", "Collab"],
          ["tools", "Task tools"],
          ["routines", "Routines"],
          ["projects", "Projects"],
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
              {isEarlyAccess(config, MODE_FEATURES[id]) && <EarlyTag />}
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
  const { mode = "home" } = useParams();
  const location = useLocation();
  const welcomeRef = useRef();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const demo = params.get("demo") === "1";
  const { models, user, connected, config, refresh } = useApp();
  const cleanLive = isReleased(config, "cleanuploads");
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
    [documents, setDocuments] = useState([]),
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
    [editing, setEditing] = useState(null),
    // True while a branch is being made and its resend runs (see branchFlight).
    [branching, setBranching] = useState(false),
    [privateMode, setPrivateMode] = useState(false),
    // Sealed Mode: encrypted in this browser to a verified enclave, relayed
    // as ciphertext, never saved on the server (see src/SealedMode.jsx).
    [sealed, setSealed] = useState(false),
    [sealedModelId, setSealedModelId] = useState(""),
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
    vaultSavedRef = useRef("");
  const teamPays = useTeamPays(config, shared, demo, current);
  // Device Vault (src/DeviceVault.jsx): for signed-in accounts once it and
  // Ephemeral Chats are released; never in the demo. Locking it (Lock, the
  // idle timer, closing the tab) closes any vault chat on screen.
  const vaultLive = !demo && !!user && vaultReleased(config);
  const vault = useDeviceVault({ enabled: vaultLive, account: user?.id, onLock: vaultLocked });
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
  ].includes(mode);
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
  const sentInstructions = withProjectInstructions(
    instructionsActive ? instructions.body.trim() : "",
    project,
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
  // Training Labels: flag models whose provider trains on prompts, and
  // offer the listed version that doesn't. Private mode never lists them.
  const trainingSelected =
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
  }, [mode, demo]);
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
    if (!vaultRequest) return;
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
    const ref = (vaultChatRef.current ||= { id: uid(), created: Date.now() });
    setVaultChatId(ref.id);
    const veilKey = veilKeyRef.current;
    vault
      .save(
        vaultChat({
          id: ref.id,
          created: ref.created,
          mode,
          privateMode,
          sealed: sealedOn || sealedThread,
          messages: kept,
          veil: veilStateRef.current,
          // Projects: grouped with its project inside the vault only.
          project: project?.id || null,
        }),
      )
      .then(() => forgetVeilState(veilKey))
      .catch((e) => {
        vaultSavedRef.current = "";
        setError(e?.message || "This chat couldn't be saved to Device Vault.");
      });
  }, [deviceOnly, busy, vault.unlocked, messages]);
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
    if (mode !== chat.mode) {
      navigate("/workspace/" + chat.mode, { state: { vaultChat: chat.id } });
      return;
    }
    newChat();
    veilKeyRef.current = "vault-" + chat.id;
    veilStateRef.current = chat.veil ? cloneVeilState(chat.veil) : createVeilState();
    vaultChatRef.current = { id: chat.id, created: chat.created };
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
    setEditing(null);
    branchFlight.current?.reset();
    if (!demo) {
      try {
        const r = await api("/api/conversations/" + c.id);
        setCurrent(c.id);
        setShared(r.collab || null);
        setProjectId(r.project_id ?? null);
        setLineage({ parent: r.parent || null, branches: r.branches || [] });
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
  const mentionQuery = textMode && !sealedOn
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
  const mention = textMode && !sealedOn
    ? prompt.trim().match(/^@(\S+)\s+([\s\S]+)$/)
    : null;
  const mentioned = mention
    ? visibleModels.find((m) => m.id.toLowerCase() === mention[1].toLowerCase())
    : null;
  const incompatibleMention = finderLive && mentioned && needsVision && !mentioned.vision;
  const target = mentioned || selected;
  const selectedReplyBudget = longAnswersLive ? replyBudgetFor(target, replyBudget) : REPLY_BUDGET;
  // What a chat Send posts, shared with the credit estimate beside it.
  const sendText = mentioned ? mention[2].trim() : prompt.trim();
  const sendModel = target?.id || model;
  // Sealed Mode: the most this message can hold, worked out here from the
  // sealed body's size exactly as the server bounds it. Never a server quote,
  // which would carry the prompt unsealed.
  const sealedHoldCredits = useMemo(() => {
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
  }, [sealedOn, sealedTarget, messages, sendText, sentDocuments, documentsAsData, instructionsActive, instructions.body, longAnswersLive, config?.markup]);
  const branchesLive = isReleased(config, "branches");
  // Live Preview (src/LivePreview.jsx): Code & Build's Preview tab and a
  // Preview button on HTML blocks in replies. Browser-only and sandboxed.
  const previewLive = isReleased(config, "preview");
  const [codeTab, setCodeTab] = useState(null);
  const htmlPreview = useHtmlPreview(previewLive && textMode);
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
    return quoteBody({
      model: sendModel,
      request,
      webSearch,
      maxTokens: selectedReplyBudget,
      treasury: teamPays.on,
      conversationId: current,
      memory,
      mode,
    });
  }
  // Seed Guard: what Send would carry right now (the prompt, attached
  // documents' text and active standing instructions), scanned in this
  // browser. A find blocks Send, and the estimate too, since a quote posts
  // the same text, until the user removes it or confirms "Send anyway".
  const seedLive = seedGuardLive(config) && !demo;
  const documentTexts = useMemo(() => sentDocuments.map((d) => d.text || ""), [sentDocuments]);
  const promptSeed = useSeedScan(seedLive, sendText);
  const documentSeed = useSeedScan(seedLive && textMode, documentTexts);
  const instructionsSeed = useSeedScan(
    seedLive && textMode && !!sentInstructions,
    sentInstructions,
  );
  const seedHit = promptSeed || documentSeed || instructionsSeed;
  const editSeed = useSeedScan(seedLive, editing?.text || "");
  // Credit Estimates: a live estimate beside Send in chat, code and
  // Uncensored, whenever Send would go through. Image, video and Symposium
  // keep their own explicit pricing.
  const estimatesLive = isReleased(config, "estimates");
  const autoEstimate =
    !seedHit &&
    estimatesLive &&
    textMode &&
    !demo &&
    !!user &&
    !busy &&
    !branching &&
    !!sendText &&
    !incompatibleMention &&
    !!target?.callable &&
    !!config?.services?.generation &&
    !(privateMode && !target?.private) &&
    // Sealed Mode never posts a prompt for an estimate (it would go unsealed).
    !sealedOn;
  const estimateBody = useMemo(
    () => (autoEstimate ? estimateRequest() : null),
    // Everything estimateRequest reads that can change between renders.
    [autoEstimate, sendText, sendModel, messages, attachments, sentDocuments, documentsAsData,
      sentInstructions, veilOn, veilWords, webSearch, current, teamPays.on, selectedReplyBudget, longAnswersLive, memoryFacts, mode],
  );
  const estimate = useCreditEstimate(estimateBody);
  // Cost Compare: from the estimate chip, the same request priced on other
  // models from the picker's pool. Not for an @mention, whose model isn't
  // the chat's to switch.
  const costCompareLive =
    estimatesLive && isReleased(config, "costcompare") && textMode && !demo && !!user;
  const compareBase = costCompareLive && !mentioned ? estimateBody : null;
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
  // `redo` resends an earlier turn (edit or regenerate): its own text, the
  // history before it and the conversation to add to, instead of the composer.
  // `allowSeed` is Seed Guard's confirmed "Send anyway".
  async function send(e, redo = null, { allowSeed = false } = {}) {
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
    // The server checks the same text for seed phrases only; one found here
    // was confirmed above or already sent (an edited turn keeps its original
    // attachments). Keys and 64-hex never reach the server's check.
    const allowSeedPhrase =
      seedFound?.kind === "seed" ||
      (seedLive && !!redo && scanSecrets(redo.content)?.kind === "seed");
    if (!redo && attachments.length !== imageItems.length) {
      setError("Metadata couldn't be removed from an image. Tick Keep original to send it as it is, or remove it.");
      return;
    }
    // Sealed Mode has its own send; a sealed thread never goes on unsealed.
    if (sealedOn && textMode) return sendSealed(redo);
    if (sealedThread && !demo) {
      setError("This chat was sealed. Turn on Sealed Mode to continue it, or start a new chat.");
      return;
    }
    const redoModel = redo?.model ? visibleModels.find((x) => x.id === redo.model && x.callable) : null;
    const effectiveModel = redo ? redoModel || selected : target;
    const requestVision = redo
      ? requestNeedsVision(buildChatRequest({
          messages: redo.base,
          preserveHistory: longAnswersLive,
          attachments: (redo.images || []).map((url) => ({ url })),
          instructions: sentInstructions,
        }).request)
      : needsVision;
    if (finderLive && textMode && requestVision && !effectiveModel?.vision) {
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
      if (!effectiveModel?.callable || !config?.services?.generation) {
        setError("This model is not currently available for generation.");
        return;
      }
      if (privateMode && !effectiveModel?.private) {
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
    const requestModel = effectiveModel?.id || model;
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
      documents: redo ? [] : sentDocuments,
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
      charged = null;
    const sendingPrivate = privateMode && !demo;
    try {
      await streamChat(
        {
          model: requestModel,
          messages: built.request,
          ...(ephemeral ? { ephemeral: true } : { conversationId }),
          mode,
          max_tokens: longAnswersLive ? replyBudgetFor(effectiveModel, replyBudget) : REPLY_BUDGET,
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
              model: requestModel,
              finishReason,
              requestId,
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
        role: "assistant", content: output, reasoning, images, citations, model: requestModel,
        finishReason: finishReason || "interrupted", interrupted: true, requestId,
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
  // Sealed Mode's send. The request is built as any chat's is (documents read
  // in this browser, standing instructions, Veil), then sealed here to the
  // verified enclave and relayed as ciphertext. The enclave is verified again
  // first if its last check is too old; if that fails nothing is sent. The
  // server keeps no copy: Device Vault keeps the chat while it's unlocked.
  async function sendSealed(redo) {
    const model =
      (redo?.model && sealedModels.find((m) => m.id === redo.model)) || sealedTarget;
    if (!model) {
      setError("No sealed models are available right now.");
      return;
    }
    if (!redo && attachments.length) {
      setError("Sealed models can't read images. Remove them to send.");
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
  async function rewind(index, kind, editedText = null, { allowSeed = false } = {}) {
    if (busy) return;
    // Seed Guard: an edit is new text; stop before any branch is made.
    if (editedText != null && !allowSeed && seedLive && scanSecrets(editedText)) return;
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
          model: plan.model,
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
    if (seedHit) return;
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
      default:
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
  return (
    <main id="main" className="app-shell">
      <AppSidebar
        active={mode}
        demo={demo}
        open={menu}
        onClose={() => setMenu(false)}
      >
        <button
          className="new-conversation"
          onClick={() => {
            newChat();
            leaveProject();
          }}
        >
          <Icon name="plus" size={17} />
          New conversation
        </button>
        {projectsLive && (
          <ProjectsSidebar
            projects={projects.list}
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
              }[mode]
            }
            {isEarlyAccess(config, MODE_FEATURES[mode]) && <EarlyTag />}
            <span className="workspace-slash">/</span>
            <small>{demo ? "Demo workspace" : "Personal workspace"}</small>
          </span>
          <div>
            {find.button}
            {sharesLive && textMode && messages.length > 0 && (
              <button
                type="button"
                className="share-open-button"
                aria-label="Share this chat"
                onClick={openShare}
              >
                <Icon name="share" size={15} />
                <span>Share</span>
              </button>
            )}
            {exportLive && textMode && messages.length > 0 && (
              <button
                type="button"
                className="chat-export-open"
                aria-label="Export this chat"
                title={busy ? "Wait for the reply to finish" : undefined}
                disabled={busy}
                onClick={openExport}
              >
                <Icon name="download" size={15} />
                <span>Export</span>
              </button>
            )}
            {paletteLive && (
              <PaletteButton onOpen={() => palette.setOpen(true)} apple={palette.apple} />
            )}
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
        {/* Low-Balance Alerts: below the account's alert level, with Top up. */}
        <LowBalanceBanner config={config} user={user} demo={demo} />
        {/* Find in Chat: sticks to the top of the chat while it's open. */}
        {find.bar}
        <div
          key={mode}
          className={
            "workspace-body " +
            (!messages.length ? "workspace-start " : "") +
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
                {messages.length && textMode ? (
                  <div className="messages">
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
                      const shown =
                        parsed.text || (hasDocuments ? "" : m.interrupted && chatControlLive ? "Reply interrupted. Check charge status below." : "Preparing…");
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
                              ? shieldMarkdown(m.role === "assistant" ? htmlPreview.components : null)
                              : m.role === "assistant"
                                ? htmlPreview.components
                                : undefined
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
                          (highlight && m.id === highlight ? " bookmark-target" : "")
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
                          {/* The typed text is user content, so it stays
                              untranslated; with documents attached only it is
                              fenced off, leaving the chips' labels to the
                              language switch while their names stay as sent. */}
                          <div
                            className="markdown"
                            data-i18n={m.content && !hasDocuments ? "off" : undefined}
                          >
                            {hasDocuments ? (
                              <div className="document-prompt" data-i18n="off">
                                {body}
                              </div>
                            ) : (
                              body
                            )}
                            {hasDocuments && (
                              <MessageDocuments
                                documents={parsed.documents}
                                veilMap={veilStateRef.current.map}
                                asData={shieldReleased(config) && parsed.asData}
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
                          {m.role === "assistant" && m.content && (
                            <CopyButton text={m.content} />
                          )}
                          {longAnswersLive && m.role === "assistant" && completionNotice(m) && (
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
                            m.role === "assistant" && m.content && !busy && (
                            <button type="button" className="small-button"
                              onClick={() => setReadAloud(m.content)}>
                              Read aloud
                            </button>
                          )}
                          {!(branchesLive && !busy && !branching && editing?.index !== i && !m.sample) &&
                            (rememberButton(m) || bookmarks.actions(m, i, messages)) && (
                              <div className="turn-actions">
                                {bookmarks.actions(m, i, messages)}
                                {rememberButton(m)}
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
                              <div className="edit-turn-actions">
                                <button type="button" className="small-button" onClick={() => setEditing(null)}>
                                  Cancel
                                </button>
                                <button className="small-button primary" disabled={!editing.text.trim() || busy || branching || !!editSeed}>
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
                              {m.role === "assistant" && m.content && (
                                <button type="button" onClick={() => rewind(i, "regenerate")}>
                                  Regenerate
                                </button>
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
                {sealedOn && (
                  <SealedPanel
                    state={enclave.state}
                    onRetry={enclave.retry}
                    holdCredits={sealedHoldCredits}
                    noModels={!sealedModels.length}
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
                  hit={seedHit}
                  busy={busy}
                  onProceed={() => send(null, null, { allowSeed: true })}
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
                      {imageItems.map((a, i) => a.clean ? (
                        <CleanImageChip
                          key={i}
                          item={a}
                          onKeep={(keep) =>
                            setAttachments((p) => p.map((x, j) => (j === i ? withKeep(x, keep) : x)))
                          }
                          onRemove={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                        />
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
                      {sealedOn ? (
                        <select
                          className="sealed-model"
                          aria-label="Sealed model"
                          data-i18n="off"
                          value={sealedTarget?.id || ""}
                          disabled={busy}
                          onChange={(e) => setSealedModelId(e.target.value)}
                        >
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
                      {(mode === "image" || (selected?.vision && !sealedOn)) && (
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
                      {longAnswersLive && textMode && !demo && !sealedOn && (
                        <label className="fine-print">
                          Reply budget
                          <select aria-label="Reply token budget" value={selectedReplyBudget} disabled={busy}
                            onChange={(e) => setReplyBudget(Number(e.target.value))}>
                            {replyBudgets(target, selectedReplyBudget).map(value => <option key={value} value={value}>{value.toLocaleString()} tokens</option>)}
                          </select>
                          {!target?.chatLimits?.outputLimitKnown && <span>Provider output cap unavailable; conservative service limit.</span>}
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
                    {estimatesLive && textMode && <CreditEstimate state={estimate} />}
                    {costCompareLive && (
                      <CostCompare
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
                          (finderLive && !selected && !sealedOn) ||
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
                  {/* Training Labels: under the model picker, never blocking Send. */}
                  {trainingSelected && !sealedOn && (
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
                  {textMode && !estimatesLive && (
                    <button
                      onClick={quoteRequest}
                      disabled={!prompt.trim() || busy || !!seedHit}
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
