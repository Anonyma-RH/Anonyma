import { fail } from "./core.js";
import { PRIVACY_FEATURES } from "../src/projects.js";
import {
  parseHolderRewards,
  parseHolderLoyalty,
  BASE_CAPS,
  HOLDER_CAPS,
  CYCLE_DAYS,
  referralTierRates,
} from "./holder-tiers.js";

// The app launches as an MVP (chat with a short list of models, credits and
// the account) and the rest ships as named feature releases, in this order. RELEASED_FEATURES
// lists the updates that are live: "mvp" (the default) plus any
// update ids, e.g. "mvp,code,search". Until an update is released the server
// refuses its routes and the app shows it as coming soon. The copy here also
// drives the roadmap page and the launch videos.
export const UPDATES = [
  {
    id: "code",
    released: true,
    title: "Code & Build",
    tagline: "Build with your favorite models.",
    points: [
      "A dedicated code mode",
      "Files in a live side panel",
      "Download the project as a ZIP",
    ],
  },
  {
    id: "search",
    released: true,
    title: "Live Web Search",
    tagline: "Answers from the live web, with sources.",
    points: [
      "One tap on Web in any chat",
      "Cited sources under every answer",
      "About 2 cents a search",
    ],
  },
  {
    id: "images",
    released: true,
    title: "Image Studio",
    tagline: "Turn words into images.",
    points: [
      "Leading image models",
      "Guide them with reference images",
      "Everything saved in your library",
    ],
  },
  {
    id: "catalog",
    released: true,
    title: "Full Model Catalog",
    tagline: "More models. One balance.",
    points: [
      "Models from OpenAI, Anthropic, Google and more",
      "@mention any model mid-conversation",
      "Pay per use, never a subscription",
    ],
  },
  {
    id: "audio",
    released: true,
    title: "Voice & Audio",
    tagline: "Talk to it. Hear it back.",
    points: [
      "Natural text-to-speech voices",
      "Dictate prompts with the mic",
      "Dictate prompts into your composer",
    ],
  },
  {
    id: "video",
    released: true,
    title: "Video Studio",
    tagline: "Direct AI video.",
    points: [
      "Text and image to video",
      "Choose the length and the frame",
      "Delivered to your library",
    ],
  },
  {
    id: "collab",
    released: true,
    title: "Collab",
    tagline: "Build it together.",
    points: [
      "Shared workspaces for up to 12 people",
      "Conversations everyone can join",
      "One balance per person, no surprises",
    ],
  },
  {
    id: "api",
    released: true,
    title: "Developer API & CLI",
    tagline: "Your balance, in your code.",
    points: [
      "OpenAI-compatible /v1 API",
      "Per-key spending caps",
      "A one-line CLI install",
    ],
  },
  {
    id: "social",
    released: true,
    title: "Referrals & Credits",
    tagline: "Invite friends. Get credits back.",
    points: [
      "Get 5% back in credits when friends top up",
      "Send credits to any account",
      "Instant, on the ledger",
    ],
  },
  {
    id: "veil",
    title: "Veil",
    tagline: "Private details stay in your browser.",
    points: [
      "Emails, cards, phone numbers and keys masked before sending",
      "Real values restored only on your screen",
      "Your own always-veil word list",
    ],
    released: true,
  },
  {
    id: "uncensored",
    released: true,
    title: "Uncensored Models",
    tagline: "Your space for uncensored models.",
    points: [
      "A dedicated uncensored collection",
      "Choose your model",
      "One prepaid balance",
    ],
  },
  {
    id: "ephemeral",
    title: "Ephemeral Chats",
    tagline: "Off the record, or gone on schedule.",
    points: [
      "Chats that are never saved",
      "Auto-delete after 1, 7 or 30 days",
      "A receipt either way",
    ],
    released: true,
  },
  {
    id: "private",
    title: "Private Mode",
    tagline: "Private models. Nothing saved.",
    points: [
      "Only zero-data-retention models",
      "Never saved on our servers",
      "Veil masks your details before sending",
    ],
    released: true,
  },
  {
    id: "zh",
    title: "简体中文",
    tagline: "The whole site in Simplified Chinese.",
    points: [
      "One switch between English and Chinese",
      "Every page, the workspace and your account",
      "Your chats stay exactly as written",
    ],
    released: true,
  },
  {
    id: "files",
    title: "Files & Reusable Uploads",
    tagline: "Bring your files back into the conversation.",
    points: ["Office text and reusable uploads", "Owner-only files with expiry and delete", "Explicit audio transcription"],
    released: true,
  },
  {
    id: "documents",
    title: "Documents",
    tagline: "Bring the document. Ask the question.",
    points: [
      "PDFs, text, CSV and code files",
      "Text extracted in your browser",
      "Tidy document chips in every chat",
    ],
    released: true,
  },
  {
    id: "symposium",
    title: "Symposium",
    tagline: "Ask several models at once.",
    points: [
      "Up to four models side by side",
      "A receipt for every answer",
      "Fuse the answers into one",
    ],
    released: true,
  },
  {
    id: "receipts",
    title: "Signed Receipts",
    tagline: "Proof of what ran, and what it cost.",
    points: [
      "Every settled reply gets an Ed25519-signed receipt",
      "Anyone can verify it, including the answer text",
      "The public key is published for independent checks",
    ],
    released: true,
  },
  {
    id: "scrolls",
    title: "Scrolls",
    tagline: "Save the prompt. Skip the retyping.",
    points: [
      "Saved prompts with fill-in blanks",
      "Type / to insert one",
      "Standing instructions for every chat",
    ],
    released: true,
  },
  {
    id: "app",
    title: "Install the App",
    tagline: "Your workspace, one tap away.",
    points: [
      "Install on phone or desktop",
      "Opens straight into your workspace",
      "Share links and text into a chat on Android",
    ],
    released: true,
  },
  {
    id: "training",
    title: "Training Labels",
    tagline: "Know when a provider learns from your prompts.",
    points: [
      "A clear label on models whose provider trains on what you send",
      "One tap to the version that doesn't",
      "Flagged in the API too",
    ],
    released: true,
  },
  {
    id: "mcp",
    title: "MCP Server",
    tagline: "Your balance, inside any AI tool.",
    points: [
      "A remote MCP server at /mcp",
      "Works with Claude Code, Cursor and other MCP clients",
      "Same keys, same ledger, no new account",
    ],
    released: true,
  },
  {
    id: "allowances",
    title: "Agent Allowances",
    tagline: "Give an agent a budget, not your wallet.",
    points: [
      "A lifetime credit cap per key",
      "Optional expiry and a pause switch",
      "One glance at what an agent spent",
    ],
    released: true,
  },
  {
    id: "connect",
    title: "Connect an App",
    tagline: "Let an app in. Keep the rest private.",
    points: [
      "One click, no key to paste",
      "Its own budget, expiry and off switch",
      "Private models only by default",
    ],
    released: true,
  },
  {
    id: "estimates",
    title: "Credit Estimates",
    tagline: "See the cost before you send.",
    points: [
      "A live credit estimate beside Send",
      "Updates as you type, switch models or turn on Web",
      "Priced on the same request Send makes, Veil masking included",
    ],
    released: true,
  },
  {
    id: "branches",
    title: "Edit, Regenerate & Branch Chats",
    tagline: "Try it another way. Keep the original.",
    points: [
      "Edit an earlier prompt and ask again",
      "Regenerate an answer without losing the first one",
      "Branches link back to where they started",
    ],
    released: true,
  },
  {
    id: "holders",
    title: "NYMA Holder Program",
    tagline: "Hold NYMA, get credits and perks.",
    points: [
      "ANONYMA credits every 30 days, by tier",
      "A bigger library, early access and a roadmap vote",
      "No staking or locking: your NYMA stays in your wallet",
    ],
    released: true,
  },
  {
    id: "v1media",
    title: "Multimodal API",
    tagline: "Images, voice and video in your code.",
    points: [
      "Generate images with one POST",
      "Text to speech and speech to text",
      "Submit and poll video jobs",
    ],
    released: false,
    // Open to NYMA Insiders and up before its public release.
    early: true,
  },
  {
    id: "treasury",
    title: "Team Treasury",
    tagline: "One balance for the whole team.",
    points: [
      "Pool credits in a collab",
      "Spending limits for each member",
      "Every contribution and spend on record",
    ],
    released: true,
  },
  {
    id: "doublecheck",
    title: "Double-check This",
    tagline: "A second opinion from another provider.",
    points: [
      "One tap under any answer",
      "A model from a different provider reviews it",
      "See the extra cost before you ask",
    ],
    released: true,
  },
  {
    id: "finder",
    title: "Model Finder & Presets",
    tagline: "The right model, found fast.",
    points: [
      "Search every model you can use, by name, provider or feature",
      "Cheap, Balanced and Best quality presets, with manual override",
      "Prices from the live catalog on every model",
    ],
    released: true,
  },
  {
    id: "memory",
    title: "Memory Across Models",
    tagline: "Facts you choose. Context you control.",
    points: [
      "Off until you turn it on; you write every fact",
      "Edit, pause or delete any fact, and see exactly what was sent",
      "Never used off the record, in Private Mode or shared chats",
    ],
    released: true,
  },
  {
    id: "tasktools",
    released: true,
    title: "Research, Writing & Calculators",
    tagline: "Sources, alternatives and arithmetic, clearly apart.",
    points: ["Research with provider-returned source links", "Compare writing alternatives without overwriting them", "Calculate arithmetic locally without a model call"],
  },
  {
    id: "longanswers", title: "Longer, More Reliable Answers",
    tagline: "More room to finish your thought.",
    points: ["Choose a larger reply budget where supported", "Keep context and partial answers", "Continue only when you choose"],
    released: true,
  },

  {
    id: "chatcontrol",
    title: "Reading & Charge Clarity",
    tagline: "Keep your place. Know your charge.",
    points: ["Read older replies without forced scrolling", "Jump to the latest reply when ready", "Check actual charge status without resending"],
    released: true,
  },
  {
    id: "historylibrary",
    title: "History Search & Library Actions",
    tagline: "Pick up where you left off.",
    points: ["Search saved conversations", "Reopen accessible source chats", "Review a fresh quote before rerunning media"],
    released: true,
  },
  {
    id: "voice",
    title: "Read-aloud & Voice Conversations",
    tagline: "Speak, review, send and listen.",
    points: [
      "Record each turn by choice",
      "Review paid transcription before Send",
      "Read replies with an available device voice",
    ],
    released: true,
  },
  {
    id: "limits",
    title: "Spending Limits",
    tagline: "Your balance, with a ceiling you set.",
    points: [
      "Daily and monthly limits on your own balance",
      "Refused before anything is reserved or spent",
      "Raising a limit waits 24 hours",
    ],
    released: true,
  },
  {
    id: "sharelinks",
    title: "Share a Chat",
    tagline: "One link. Read-only. Yours to revoke.",
    points: [
      "A read-only snapshot of one saved chat",
      "Masked details stay masked; attachments aren't shared",
      "Expires when you choose, or revoke it any time",
    ],
    released: true,
  },
  {
    id: "palette",
    title: "Command Palette",
    tagline: "Everything, one keystroke away.",
    points: [
      "Press ⌘K or Ctrl+K from anywhere in the workspace",
      "Find chats, models, scrolls and actions",
      "Search runs in your browser and is never charged",
    ],
    // Browser only: no server routes, so nothing to gate in featuresFor.
    released: true,
  },
  {
    id: "insights",
    title: "Usage Insights & Export",
    tagline: "Every credit, accounted for.",
    points: [
      "Spending by day, model, feature and key",
      "Totals that add up exactly to your ledger",
      "Export your own ledger as CSV or JSON",
    ],
    released: true,
  },
  {
    id: "preview",
    title: "Live Preview",
    tagline: "See it run, right beside the code.",
    points: [
      "HTML, CSS and JavaScript from Code & Build, running beside the files",
      "A Preview button on HTML code in chat replies",
      "Sandboxed in your browser: network requests blocked, no account access",
    ],
    released: true,
  },
  {
    id: "trail",
    title: "Privacy Trail",
    tagline: "See where every prompt went.",
    points: [
      "A Privacy chip under every reply",
      "The model, provider, route and retention for that prompt",
      "Only what the app knows, never a guess",
    ],
    released: true,
  },
  {
    id: "seedguard",
    title: "Seed Guard",
    tagline: "Your seed phrase never leaves your browser.",
    points: [
      "Stops wallet seed phrases and private keys before they're sent",
      "Always on, checked right in your browser",
      "Nothing about a match is logged or saved",
    ],
    released: true,
  },
  {
    id: "cleanuploads",
    title: "Clean Uploads",
    tagline: "Your files arrive without their hidden details.",
    points: [
      "Location, camera and author details removed in your browser",
      "Photos keep their quality and stay the right way up",
      "See what was removed, or keep the original",
    ],
    released: true,
  },
  {
    id: "wipe",
    title: "Panic Wipe",
    tagline: "Everything gone in one tap. Your credits stay.",
    points: [
      "Erase chats, files, memory and keys in one confirmed step",
      "Signs out every device and clears this browser",
      "Your balance, ledger and receipts stay intact",
    ],
    released: true,
  },
  {
    id: "vault",
    title: "Device Vault",
    tagline: "Keep your chats, but only on your device.",
    points: [
      "Save a chat on this device only, never on our servers",
      "Encrypted in your browser with a passphrase only you know",
      "Export the encrypted vault to move it to another device",
    ],
    // Browser only: a device-only chat is sent as an off-the-record request,
    // so the server gates it as "ephemeral" and never learns a vault exists.
    // The app needs both released (vaultReleased in src/DeviceVault.jsx).
    released: true,
  },
  {
    id: "routines",
    title: "Routines",
    tagline: "Your prompts, on a schedule, on a budget.",
    points: [
      "Daily, weekday or weekly runs in your own time zone",
      "A per-run maximum and a monthly budget, refused rather than exceeded",
      "Every answer in a Routines inbox, with its charge and signed receipt",
    ],
    released: true,
  },
  {
    id: "sealedshare",
    title: "Sealed Share",
    tagline: "Share a chat we can't read.",
    points: [
      "Encrypted in your browser before it's uploaded",
      "The key stays in the link, never on our servers",
      "Share Device-only chats too, sealed",
    ],
    // Builds on Share a Chat: every Sealed Share route needs both released
    // (featuresFor). Encryption and decryption happen only in the browser.
    released: true,
  },
  {
    id: "projects",
    title: "Projects",
    tagline: "Keep related chats, files and instructions together.",
    points: [
      "Group chats and Symposium runs by project",
      "Instructions and pinned files go with every new chat",
      "A default model and privacy mode for each project",
    ],
    // Pinning files needs Files & Reusable Uploads, and a default privacy
    // mode needs the update behind it (PRIVACY_FEATURES in src/projects.js).
    released: true,
  },
  {
    id: "twostep",
    title: "Two-Step Sign-in",
    tagline: "A stolen password isn’t enough.",
    points: [
      "A code from your authenticator app after every sign-in",
      "Ten single-use recovery codes, shown once",
      "Covers password, email code and wallet sign-in",
    ],
    // Only the settings routes are gated. The sign-in's own second step
    // (/api/auth/two-step) stays open: an account that turned two-step on
    // keeps needing its code even if the update is switched off again.
    released: true,
  },
  {
    id: "costcompare",
    title: "Cost Compare",
    tagline: "See what your message costs on other models.",
    points: [
      "Your message priced on up to 8 models before you send it",
      "The same quote as Send, with context fit and image support shown",
      "Switch models in one click; nothing is sent or charged",
    ],
    released: true,
  },
  {
    id: "balancealerts",
    title: "Low-Balance Alerts",
    tagline: "Know before you run out of credits.",
    points: [
      "Choose the balance you want a heads-up at",
      "A banner in the workspace with a Top up button",
      "An optional browser notification while ANONYMA is open",
    ],
    released: true,
  },
  {
    id: "chatexport",
    title: "Chat Export",
    tagline: "Your chat, your file.",
    points: [
      "Markdown, JSON, or a clean page to print or save as PDF",
      "Model names and dates; receipts and sources if you choose",
      "Made in your browser; masked details stay masked unless you restore them",
    ],
    // Browser only: the file is built from the conversation the account can
    // already open (GET /api/conversations/:id, the same access check) or
    // from what's on screen, so there's no route to gate in featuresFor.
    released: true,
  },
  {
    id: "bookmarks",
    title: "Bookmarks",
    tagline: "Keep the good parts.",
    points: [
      "Star any saved message, with a private note",
      "Search your bookmarks and jump straight back",
      "Yours alone, even in shared Collab chats",
    ],
    released: true,
  },
  {
    id: "sealed",
    title: "Sealed Mode",
    tagline: "Encrypted in your browser. Readable only in the enclave.",
    points: [
      "Open-weight private models only, running inside a hardware-verified enclave",
      "We relay only ciphertext, but still see metadata: model, time, size and tokens",
      "You trust the open-source page code we serve to do the encrypting",
    ],
    // RELEASE PRECONDITION (docs/operations/sealed-mode.md): billing must be
    // known before this ships. PPQ has to confirm that sealed requests may be
    // relayed and either that the X-Tinfoil-Usage-Metrics trailer reaches us
    // (SEALED_BILLING=trailer) or how its query history identifies a request
    // (SEALED_BILLING=reconcile with SEALED_RECONCILE=true), and the private/*
    // rates. Until SEALED_BILLING is set the routes refuse and the app hides
    // the toggle, even with this flag on.
    released: true,
  },
  {
    id: "paynyma",
    title: "Pay with NYMA",
    tagline: "Top up with NYMA. Get more credits for it.",
    points: [
      "Send NYMA from your own wallet on Robinhood Chain",
      "A quote holds the rate for 10 minutes",
      "Bonus credits on every NYMA top-up",
    ],
    // Needs WALLET_PAYMENT_ADDRESS on chain 4663 (server/routes/nyma.js).
    released: true,
  },
  {
    id: "findinchat",
    title: "Find in Chat",
    tagline: "Find any word in a long chat.",
    points: [
      "⌘F or Ctrl+F in the chat you have open",
      "Every match highlighted; step through them one by one",
      "Searched in your browser; nothing is sent or charged",
    ],
    // Browser only: it searches the conversation already on screen, so
    // there's no route to gate in featuresFor and no API contract.
    released: true,
  },
  {
    id: "referralboost",
    title: "Referral Boost",
    tagline: "Hold NYMA. Get more back from referrals.",
    points: [
      "A higher referral rate for NYMA holders, by tier",
      "Paid in credits when a friend's top-up is confirmed",
      "Your tier at that moment sets the rate",
    ],
    // No routes of its own, so nothing to gate in featuresFor: it sets the
    // rate of the reward Referrals & Credits already pays
    // (server/referral-boost.js), from the NYMA Holder Program's tiers, and
    // does nothing unless that program is released too.
    released: true,
  },
  {
    id: "earlymodels",
    title: "Early Model Access",
    tagline: "New models open to NYMA Insiders first.",
    points: [
      "Newly added models, 14 days before everyone else",
      "For the Insider tier and up, tagged Early",
      "No staking or locking: your NYMA stays in your wallet",
    ],
    // The Insider perk for new models (server/early-models.js). It works
    // only while the NYMA Holder Program is live with balance checks on;
    // otherwise, or with EARLY_MODEL_DAYS=0, every model opens to everyone
    // as soon as it's added. No routes of its own to gate.
    released: true,
  },
  {
    id: "apiboost",
    title: "API Boost",
    tagline: "Higher API limits for NYMA holders.",
    points: [
      "More API and MCP requests a minute at every holder tier",
      "Your keys, MCP and connected apps all get the higher limit",
      "Your balance, key caps and allowances still set what's spent",
    ],
    // Rates only (server/api-boost.js): HOLDER_API_MULTIPLIERS per tier,
    // from the Holder Program's current tier. Before release, /v1 and /mcp
    // keep the standard per-IP limit and the account's limit route refuses.
    released: true,
  },
  {
    id: "diagrams",
    title: "Math & Diagrams",
    tagline: "Equations and diagrams, rendered right in the chat.",
    points: [
      "LaTeX equations in replies, typeset with KaTeX",
      "Mermaid flowcharts, sequences and charts, drawn in your browser",
      "Copy either as SVG, or download a diagram as PNG",
    ],
    // Browser only: replies are typeset and drawn in the page (src/
    // RichMarkdown.jsx), so there's no route to gate in featuresFor. The one
    // server change is the Bookmarks excerpt, which leaves a reply's diagram
    // source out once this is released (routes/bookmarks.js).
    released: false,
  },
  {
    id: "shield",
    title: "Injection Shield",
    tagline: "A document can't hijack your AI.",
    points: [
      "Flags hidden instructions and invisible characters in files and pastes",
      "Sends attached files as data, not instructions",
      "Holds remote images in replies until you load them",
    ],
    // Browser only: every check runs in the page (src/shield.js) and nothing
    // about a finding reaches the server, so there's no route to gate in
    // featuresFor. The data notice rides inside the message as text.
    released: false,
  },
  {
    id: "redact",
    title: "Redact Before You Send",
    tagline: "Black out what you don't want to share.",
    points: [
      "Box out text, faces or a whole corner of a screenshot before it's sent",
      "Redrawn in your browser: the original never leaves your device",
      "Black for text, Pixelate for faces, never a blur that can be undone",
    ],
    // Browser only: the redacted copy is made before the request exists and
    // is sent like any other image, so no route is gated on it (like Clean
    // Uploads). The app shows Redact only once this is released.
    released: false,
  },
  {
    id: "linkreader",
    title: "Link Reader",
    tagline: "Paste a link and ask about the page. The site sees our server, not you.",
    points: [
      "Read this page on any link in your message",
      "Fetched by our server: no cookies, no referrer, never your IP",
      "The page goes with your question; reading it is free",
    ],
    // POST /api/read (server/routes/link-reader.js, SSRF rules in
    // server/link-reader.js). The page is attached as a Documents block, so
    // it needs "documents" released too (featuresFor).
    released: false,
  },
  {
    id: "onchain",
    title: "Onchain Explainer",
    tagline: "Any transaction, in plain English.",
    points: [
      "Paste a transaction hash, an address or an explorer link",
      "Exact chain facts first, then a plain-English explanation",
      "Looked up by our server, so the explorer never sees you",
    ],
    // Read only: the lookup (/api/onchain/lookup) is free and never signs,
    // sends or connects a wallet; the explanation is an ordinary chat.
    released: false,
  },
  {
    id: "sheets",
    title: "Local Sheets",
    tagline: "Ask your spreadsheet. It never leaves your device.",
    points: [
      "Drop a CSV, TSV or JSON file; it's read in your browser only",
      "By default the AI sees only column names and types, not your rows",
      "Charts and tables calculated on your device, with CSV and image export",
    ],
    // The workspace's Sheets page (src/Sheets.jsx). Its model calls are
    // /api/chat requests carrying `sheets` (server/sheets.js); nothing about
    // them is stored, so there's nothing to erase or export.
    released: false,
  },
  {
    id: "blind",
    title: "Blind Compare",
    tagline: "Two models answer. You pick the better one.",
    points: [
      "Two replies side by side, names and costs hidden",
      "Vote A, B, tie or both bad, then see who's who, the cost and the speed",
      "Your own rankings from your votes; no prompts kept",
    ],
    // Each side is a chat request on runChat's hold/settle path; a vote
    // stores only model ids, the outcome and the date (routes/blind.js).
    released: false,
  },
  {
    id: "deepresearch",
    title: "Deep Research",
    tagline: "Ask a hard question. Get a sourced report.",
    points: [
      "Plans the question, runs 3 or 6 web searches, then writes a report",
      "Numbered citations that point only to pages the searches found",
      "See the most it can cost first; pay only for the steps that finish",
    ],
    // Runs Live Web Search's plugin for each search, so it needs "search"
    // released too (featuresFor). Workspace only; nothing new is stored: a
    // saved run is an ordinary conversation turn (server/routes/research.js).
    released: false,
  },
  {
    id: "passkeys",
    title: "Passkeys",
    tagline: "Sign in with Face ID or your fingerprint.",
    points: [
      "No password to leak, no email needed",
      "Counts as both steps of two-step sign-in",
      "Your device keeps the private key; we store only the public one",
    ],
    // Every route is gated (featuresFor). Once released, keep it released:
    // an account made with a passkey has no other way to sign in. Needs
    // APP_ORIGIN on a domain over HTTPS (the WebAuthn RP ID is its host);
    // server/passkeys.js passkeysAvailable.
    released: false,
  },
  {
    id: "privacyscreen",
    title: "Privacy Screen",
    tagline: "One key and your screen goes blank.",
    points: [
      "Press Esc twice or tap Hide, and your chats leave the screen",
      "Optional: hide when you switch away, lock when you're idle",
      "Unlock with your password; a reply in progress keeps going",
    ],
    // Browser only (src/privacy-screen.js), apart from the idle lock's
    // unlock check (server/routes/unlock.js), which re-verifies the account's
    // password, email code or wallet signature without touching the session.
    released: false,
  },
];
// Connect an App issues MCP tokens that spend through an agent allowance on
// the API's hold/settle path, so it is live only when all four are.
export const CONNECT_UPDATES = ["api", "mcp", "allowances", "connect"];
const IDS = UPDATES.map((u) => u.id);
// The NYMA an account must hold for early access is the Insider tier's
// minimum in HOLDER_REWARDS (server/holder-tiers.js): 5,000,000 by default,
// 0.5% of the 1,000,000,000 supply.
const holderTiers = (cfg) => cfg?.holderRewards ?? parseHolderRewards();
export const earlyAccessMin = (cfg) => holderTiers(cfg)[1].min;

// The MVP's chat models when "catalog" isn't released (override: MVP_MODELS).
export const DEFAULT_MVP_MODELS = [
  "claude-opus-5.5",
  "claude-sonnet-5",
  "claude-haiku-4.5",
  "gpt-6-sol",
  "gpt-5.4-mini",
  "gemini-3.7-flash",
  "grok-4.6",
  "glm-5.3",
  "kimi-k3-fast",
  "deepseek/deepseek-v4.1-flash",
];

// The Uncensored section's models, offered once "uncensored" is released even
// while the full catalog stays closed. Curated, never inferred from a
// provider: add a model only when its catalog metadata explicitly labels it
// uncensored and it is a live chat model with published token rates. The
// current list is every such row in the catalog (all hosted by Venice) except
// venice/e2ee-gemma-4-26b-a4b-uncensored-p, an enclave ("e2ee") variant that
// publishes no supported parameters and hasn't been tested on this chat path.
export const UNCENSORED_MODELS = [
  "venice/venice-uncensored-1-2",
  "cognitivecomputations/dolphin-mistral-24b-venice-edition",
  "venice/venice-uncensored-role-play",
  "venice/gemma-4-uncensored",
  "venice/olafangensan-glm-4.7-flash-heretic",
];

export function parseReleased(value) {
  const parts = String(value ?? "mvp")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const unknown = parts.filter(
    (p) => p !== "mvp" && p !== "all" && !IDS.includes(p),
  );
  if (unknown.length)
    throw Error(
      `Unknown RELEASED_FEATURES: ${unknown.join(", ")}. Use all, or mvp plus any of: ${IDS.join(", ")}.`,
    );
  if (parts.includes("all")) return "all";
  return new Set(parts.filter((p) => p !== "mvp"));
}

// An update is live when RELEASED_FEATURES includes it, or when its entry in
// UPDATES says `released: true`. The second way makes turning a feature on a
// public commit ("Release Veil") rather than a hosting setting.
//
// Early access: an entry may also say `early: true`. Once the NYMA Holder
// Program ("holders") is live, an early update that isn't released yet opens
// for accounts at the Insider tier or above (the rule is earlyAccessHolder in
// server/holders.js), and for no one else.
// Absent means the update waits for its public release like any other.
export const isReleased = (cfg, id) =>
  cfg.released === "all" ||
  (cfg.released instanceof Set && cfg.released.has(id)) ||
  UPDATES.some((u) => u.id === id && u.released === true);
export const connectLive = (cfg) =>
  CONNECT_UPDATES.every((id) => isReleased(cfg, id));
// Never early: the Holder Program itself, Early Model Access (a holder perk
// already), and Connect an App, whose OAuth flow is driven by the outside
// app, which would learn from it whether the account holds NYMA.
const NEVER_EARLY = ["connect", "holders", "earlymodels"];
// An update open to early-access holders right now: marked `early`, not yet
// released, and the Holder Program itself is live. Global, never per user.
export const earlyOpen = (cfg, id) =>
  !NEVER_EARLY.includes(id) &&
  !isReleased(cfg, id) &&
  isReleased(cfg, "holders") &&
  UPDATES.some((u) => u.id === id && u.early === true);
export const earlyUpdates = (cfg) => IDS.filter((id) => earlyOpen(cfg, id));

// Whether a model is part of what's released: chat models need the full
// catalog, a place on the MVP list, or (for the curated uncensored models)
// the Uncensored release; generators need their studio.
export function modelReleased(m, cfg) {
  if (cfg.released === "all") return true;
  if (m.type === "video") return isReleased(cfg, "video");
  if (m.type === "image") return isReleased(cfg, "images");
  if (m.type !== "chat") return false;
  if ((m.architecture?.output_modalities || []).includes("image"))
    return isReleased(cfg, "images");
  return (
    isReleased(cfg, "catalog") ||
    (cfg.mvpModels || DEFAULT_MVP_MODELS).includes(m.id) ||
    (isReleased(cfg, "uncensored") && UNCENSORED_MODELS.includes(m.id))
  );
}

// All release gates required by a request. featureFor is the first gate.
export const featureFor = (req) => featuresFor(req)[0] || null;
export function featuresFor(req) {
  // Express matches routes regardless of case, so the gates must too:
  // /OAuth/register reaches the same handler as /oauth/register.
  const p = String(req.path).toLowerCase(),
    post = req.method === "POST",
    body = req.body || {};
  // History search can be narrowed to one project.
  if (p.startsWith("/api/history/"))
    return req.query?.project !== undefined ? ["historylibrary", "projects"] : ["historylibrary"];
  if (p.startsWith("/api/library/")) return ["historylibrary"];
  // Projects, and what a project turns on: pinned files need Files &
  // Reusable Uploads, and a default privacy mode the update behind it.
  if (p === "/api/projects" || p.startsWith("/api/projects/")) {
    const needed = ["projects"];
    if (post || req.method === "PATCH") {
      if (body.files !== undefined) needed.push("files");
      const privacy = typeof body.privacy === "string" && Object.hasOwn(PRIVACY_FEATURES, body.privacy)
        ? PRIVACY_FEATURES[body.privacy]
        : [];
      for (const id of privacy)
        if (!needed.includes(id)) needed.push(id);
    }
    return needed;
  }
  // Bookmarks: stars on saved messages, with private notes.
  if (p === "/api/bookmarks" || p.startsWith("/api/bookmarks/")) return ["bookmarks"];
  // Link Reader: the server-side fetch of one public page. The page rides
  // with the message as a Documents block, so it needs Documents too.
  if (p === "/api/read" || p.startsWith("/api/read/")) return ["linkreader", "documents"];
  // Blind Compare: a round, votes and rankings. A round needs whatever the
  // same chat would: code or Uncensored, off the record, Private Mode, a
  // project, Privacy Trail's Veil count and Seed Guard's override.
  if (p === "/api/blind" || p.startsWith("/api/blind/")) {
    const needed = ["blind"];
    if (post && /^\/api\/blind\/?$/.test(p)) {
      if (body.mode === "code") needed.push("code");
      if (body.mode === "uncensored") needed.push("uncensored");
      if (body.ephemeral === true || body.private === true) needed.push("ephemeral");
      if (body.private === true) needed.push("private");
      if (body.project !== undefined) needed.push("projects");
      if (body.veil_masked !== undefined) needed.push("trail");
      if (body.allow_seed_phrase !== undefined) needed.push("seedguard");
    }
    return needed;
  }
  // Deep Research: a plan, one web search per sub-question and a report, so
  // it needs Live Web Search too. What a run turns on needs its own update,
  // as the same chat would: Private Mode, off the record, a project, Memory,
  // Privacy Trail's Veil count, and code mode.
  if (p === "/api/research" || p.startsWith("/api/research/")) {
    const needed = ["deepresearch", "search"];
    if (post) {
      if (body.private === true) needed.push("private", "ephemeral");
      else if (body.ephemeral === true) needed.push("ephemeral");
      if (body.project !== undefined) needed.push("projects");
      if (body.memory != null) needed.push("memory");
      if (body.veil_masked !== undefined) needed.push("trail");
      if (body.mode === "code") needed.push("code");
    }
    return needed;
  }
  // Sealed Mode: the attestation passthrough, the ciphertext relay and a
  // sealed request's billing. Nothing else is needed: a sealed chat is never
  // stored, and its body is never read here.
  if (p === "/api/sealed" || p.startsWith("/api/sealed/")) return ["sealed"];
  // Panic Wipe: the one route that erases an account's content at once.
  if (/^\/api\/account\/wipe\/?$/.test(p)) return ["wipe"];
  // Passkeys: signing in and signing up with one, and Account → Security's
  // passkeys, whose "confirm it's you" also takes Two-Step Sign-in's.
  if (p === "/api/auth/passkey" || p.startsWith("/api/auth/passkey/"))
    return ["passkeys"];
  if (p === "/api/account/passkeys" || p.startsWith("/api/account/passkeys/"))
    return ["passkeys", "twostep"];
  // Privacy Screen: unlocking the screen after idle re-checks the account's
  // password (or an email code or wallet signature). Nothing else is served.
  // With Passkeys, a passkey is one more way to unlock, so a passkey unlock
  // needs that update too.
  if (p === "/api/auth/unlock" || p.startsWith("/api/auth/unlock/"))
    return post && p === "/api/auth/unlock" && body.method === "passkey"
      ? ["privacyscreen", "passkeys"]
      : ["privacyscreen"];
  // Two-Step Sign-in's settings. The sign-in step itself, /api/auth/two-step,
  // is never gated (see the UPDATES entry).
  if (p === "/api/account/two-step" || p.startsWith("/api/account/two-step/"))
    return ["twostep"];
  if (post && (body.libraryMediaId !== undefined || body.libraryQuote !== undefined)) {
    if (p === "/api/images") return ["historylibrary", "images"];
    if (p === "/api/videos") return ["historylibrary", "video"];
    if (p === "/api/audio/speech") return ["historylibrary", "audio"];
  }
  // API Boost: the account's own API rate limit.
  if (p === "/api/account/api-limit") return ["api", "apiboost"];
  if (p.startsWith("/api/files")) return ["files", "documents"];
  if (p.startsWith("/v1/files")) return ["api", "files"];
  if (p.startsWith("/api/videos")) return ["video"];
  if (p.startsWith("/api/audio")) return ["audio"];
  // Team Treasury lives inside collabs, so its routes need both. Viewing a
  // treasury and the owner's withdrawal need only Collab, so switching Team
  // Treasury off again never traps credits already in one; those two routes
  // refuse collabs without a treasury themselves (routes/treasury.js).
  if (/^\/api\/collabs\/[^/]+\/treasury(\/|$)/.test(p))
    return (req.method === "GET" && /\/treasury\/?$/.test(p)) ||
      (post && /\/treasury\/withdraw\/?$/.test(p))
      ? ["collab"]
      : ["treasury", "collab"];
  if (p.startsWith("/api/collabs")) return ["collab"];
  if (p === "/api/images" && post) return ["images"];
  // The /v1 media endpoints need the API, the multimodal update itself, and
  // whichever studio update backs that media type.
  if (p.startsWith("/v1/images")) return ["api", "v1media", "images"];
  if (p.startsWith("/v1/audio")) return ["api", "v1media", "audio"];
  if (p.startsWith("/v1/videos")) return ["api", "v1media", "video"];
  if (p === "/v1" || p.startsWith("/v1/")) return ["api"];
  if (p === "/api/keys" && post) return ["api"];
  // Allowances extend an API key's authorization, so they need the API
  // update released too.
  if (/^\/api\/keys\/[^/]+\/(allowance|pause|resume|usage)$/.test(p))
    return ["api", "allowances"];
  if (["/install.sh", "/install.ps1", "/cli.mjs"].includes(p)) return ["api"];
  // The MCP server runs on the API's key auth, rate limits and hold/settle
  // path, so it needs "api" released as well as "mcp".
  if (p === "/mcp" || p.startsWith("/mcp/")) return ["mcp", "api"];
  // One-click connect: OAuth discovery, registration, authorization, tokens
  // and the account's connected-apps controls.
  if (
    p.startsWith("/.well-known/oauth-") ||
    p === "/oauth" ||
    p.startsWith("/oauth/") ||
    p === "/api/connections" ||
    p.startsWith("/api/connections/")
  )
    return [...CONNECT_UPDATES];
  // The installable app's manifest, service worker and offline page.
  if (
    ["/manifest.webmanifest", "/sw.js", "/offline.html", "/offline.js"].includes(
      p,
    )
  )
    return ["app"];
  if (p === "/api/credits/send" || p === "/api/referrals") return ["social"];
  // Pay with NYMA: the rate, quotes and claims.
  if (p === "/api/nyma" || p.startsWith("/api/nyma/")) return ["paynyma"];
  // Onchain Explainer: the read-only chain lookup.
  if (p === "/api/onchain" || p.startsWith("/api/onchain/")) return ["onchain"];
  if (
    p === "/api/account/wallet/unlink" ||
    p === "/api/account/holdings" ||
    p === "/api/holders" ||
    p.startsWith("/api/holders/")
  )
    return ["holders"];
  if (p.startsWith("/api/receipts") || p === "/.well-known/anonyma-receipts.json")
    return ["receipts"];
  if (p.startsWith("/api/retention")) return ["ephemeral"];
  if (p === "/api/memory" || p.startsWith("/api/memory/")) return ["memory"];
  // Cost Compare opens from Credit Estimates' chip, so it needs both. A
  // comparison priced with saved memory, in Private Mode, for code or
  // Uncensored models, with Web or on the team's treasury needs those
  // updates too, as the same chat would.
  if (/^\/api\/estimate\/compare\/?$/.test(p)) {
    const needed = ["costcompare", "estimates"];
    if (post) {
      if (body.memory != null) needed.push("memory");
      if (body.private === true) needed.push("private");
      if (body.mode === "code") needed.push("code");
      if (body.mode === "uncensored") needed.push("uncensored");
      if (
        body.web_search === true ||
        (Array.isArray(body.plugins) && body.plugins.some((x) => x?.id === "web"))
      )
        needed.push("search");
      if (body.treasury === true) needed.push("treasury", "collab");
    }
    return needed;
  }
  if (p === "/api/spending-limits" || p.startsWith("/api/spending-limits/"))
    return ["limits"];
  // Low-Balance Alerts: the account's alert level and notification choice.
  if (p === "/api/balance-alert" || p.startsWith("/api/balance-alert/"))
    return ["balancealerts"];
  // Live Preview's sandboxed frame document (server/routes/preview.js).
  if (p === "/preview-frame.html") return ["preview"];
  // Sealed Share: the browser seals a snapshot before uploading it, so the
  // draft it seals and a sealed create need both updates.
  if (p === "/api/shares/draft") return ["sharelinks", "sealedshare"];
  if (
    p === "/api/shares" &&
    post &&
    (body.sealed === true ||
      body.ciphertext !== undefined ||
      body.device !== undefined)
  )
    return ["sharelinks", "sealedshare"];
  // Share a Chat: managing links, and the public snapshot page and its data.
  if (
    p === "/api/shares" ||
    p.startsWith("/api/shares/") ||
    p.startsWith("/api/s/") ||
    p.startsWith("/s/")
  )
    return ["sharelinks"];
  if (p === "/api/account/usage" || p.startsWith("/api/account/usage/"))
    return ["insights"];
  // Routines, and the features a routine turns on for its runs: saving one
  // with web search needs Live Web Search, and Private models only needs
  // Private Mode (routing only: a routine's answers are kept in its inbox).
  if (p === "/api/routines" || p.startsWith("/api/routines/")) {
    const needed = ["routines"];
    if (post || req.method === "PATCH") {
      if (body.web_search === true) needed.push("search");
      if (body.private_only === true) needed.push("private");
    }
    return needed;
  }
  // Branching a saved conversation (edit and regenerate use it too).
  if (/^\/api\/conversations\/[^/]+\/branch$/.test(p)) return ["branches"];
  if (
    p === "/api/scrolls" ||
    p.startsWith("/api/scrolls/") ||
    p === "/api/instructions" ||
    p.startsWith("/api/instructions/")
  )
    return ["scrolls"];
  if (
    req.method === "PATCH" &&
    p.startsWith("/api/conversations/") &&
    Object.prototype.hasOwnProperty.call(body, "retention")
  )
    return ["ephemeral"];
  const needed = [];
  // A new saved chat (or Symposium run) filed in a project.
  if (p === "/api/chat" && post && body.project !== undefined) needed.push("projects");
  if (p === "/api/chat" && post && body.taskTool !== undefined) needed.push("tasktools");
  // Privacy Trail: the browser's Veil mask count (null when Veil was off),
  // kept with the reply's trail.
  if (p === "/api/chat" && post && body.veil_masked !== undefined)
    needed.push("trail");
  // Local Sheets: a question about a spreadsheet (server/sheets.js). It's
  // always off the record, so it needs Ephemeral Chats too (pushed below).
  if (p === "/api/chat" && post && body.sheets !== undefined) needed.push("sheets");
  // Seed Guard's "Send anyway" override (server/seed-guard.js).
  if (p === "/api/chat" && post && body.allow_seed_phrase !== undefined)
    needed.push("seedguard");
  // A chat (or its estimate) that asks for saved memory.
  if ((p === "/api/chat" || p === "/api/quote") && post && body.memory != null)
    needed.push("memory");
  if ((p === "/api/chat" || p === "/api/conversations") && post) {
    if (body.mode === "code") needed.push("code");
    if (body.mode === "uncensored") needed.push("uncensored");
    if (body.mode === "symposium") needed.push("symposium");
    if (p === "/api/chat" && body.ephemeral === true) needed.push("ephemeral");
    // Double-check This runs on Symposium's orchestration (mode "symposium").
    if (p === "/api/chat" && body.double_check != null) needed.push("doublecheck");
    // Private mode always takes the ephemeral path, so it needs both.
    if (p === "/api/chat" && body.private === true)
      needed.push("private", "ephemeral");
    if (
      p === "/api/chat" &&
      (body.web_search === true ||
        (Array.isArray(body.plugins) &&
          body.plugins.some((x) => x?.id === "web")))
    )
      needed.push("search");
    // A team-paid chat holds on the collab's treasury, so it needs both.
    if (p === "/api/chat" && body.treasury === true)
      needed.push("treasury", "collab");
  }
  return needed;
}

// `holder(req)` says whether the request comes from an early-access holder
// (requestHolder in server/holders.js). It's asked only when a gate is an
// early update, at most once per request. Without it, nobody gets in early.
export function releaseGuard(cfg, holder = () => false) {
  return (req, res, next) => {
    let isHolder;
    const open = (id) =>
      isReleased(cfg, id) ||
      (earlyOpen(cfg, id) && (isHolder ??= holder(req) === true));
    const feature = featuresFor(req).find((id) => !open(id));
    if (feature) {
      const update = UPDATES.find((u) => u.id === feature);
      fail(403, `${update.title} is coming soon.`, "feature_unreleased");
    }
    next();
  };
}

const referralBoostInfo = (cfg) => {
  const tiers = isReleased(cfg, "referralboost") ? referralTierRates(cfg) : null;
  return tiers ? { base: cfg.referralPercent, tiers } : null;
};

// What the app needs to show released features and the roadmap.
export function releaseInfo(cfg) {
  return {
    all: cfg.released === "all",
    features: Object.fromEntries(IDS.map((id) => [id, isReleased(cfg, id)])),
    updates: UPDATES.map((u, i) => ({
      ...u,
      number: i + 1,
      released: isReleased(cfg, u.id),
      // Public product information: which updates holders can use early.
      early: earlyOpen(cfg, u.id),
    })),
    uncensoredModels: UNCENSORED_MODELS,
    earlyAccess: {
      threshold: earlyAccessMin(cfg),
    },
    // The NYMA Holder Program's public settings, once it's live: the same
    // for everyone, never anything about an account.
    holderProgram: isReleased(cfg, "holders")
      ? {
          cycleDays: CYCLE_DAYS,
          tiers: holderTiers(cfg).map(({ id, name, perk, min, credits }) => ({
            id,
            name,
            perk,
            min,
            credits,
          })),
          loyalty: cfg?.holderLoyalty ?? parseHolderLoyalty(),
          caps: { standard: BASE_CAPS, holder: HOLDER_CAPS },
          // Referral Boost, once released: each tier's referral percent
          // and the base everyone else earns. Null while it has no effect.
          referralBoost: referralBoostInfo(cfg),
        }
      : null,
  };
}
