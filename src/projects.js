// Projects: folders that keep an account's related chats, files and
// instructions together. The pure half, shared by the server (what a
// project may hold) and the browser (what a chat in a project starts as and
// carries). No DOM, React or storage here, so tests run it in node.
//
// A project's instructions are sent by the browser, like standing
// instructions (Scrolls): Veil masks them with the rest of the request and
// they're never saved with a chat. Its pinned files are saved uploads whose
// text is attached to each new chat in it, where Saved files work. Its
// default privacy mode decides how a new chat in it starts: off the record,
// Private Mode and Device only chats store nothing on the server, so they
// are never filed in a project there.
// The browser's release check (isReleased in src/lib.js), inlined so the
// server can import this file without the browser's helpers.
const isReleased = (config, id) => config?.releases?.features?.[id] === true;

export const projectsReleased = (config) => isReleased(config, "projects");

export const MAX_PROJECTS = 50;
// The composer takes up to five documents, so a project pins up to five.
export const MAX_PINNED = 5;
export const MAX_PROJECT_NAME = 60;
// The same limit as standing instructions.
export const MAX_PROJECT_INSTRUCTIONS = 4000;

// The house palette (src/brand.css).
export const PROJECT_COLORS = [
  { id: "cobalt", hex: "#0135df", label: "Cobalt" },
  { id: "navy", hex: "#061b69", label: "Navy" },
  { id: "amber", hex: "#ffb21c", label: "Amber" },
  { id: "ink", hex: "#18233f", label: "Ink" },
  { id: "slate", hex: "#606a80", label: "Slate" },
  { id: "mist", hex: "#d9e5ff", label: "Mist" },
];
export const DEFAULT_COLOR = "cobalt";
export const colorHex = (id) =>
  (PROJECT_COLORS.find((c) => c.id === id) || PROJECT_COLORS[0]).hex;

// How a new chat in the project starts. The server keeps three of them.
// Device only is kept in this browser (see storedPrivacy): the server never
// learns that a Device Vault exists, so it stores such a project as off the
// record, which is also how it starts in a browser without the vault.
export const PROJECT_PRIVACY = ["normal", "off_record", "private"];
export const PRIVACY_CHOICES = ["normal", "off_record", "device", "private"];
export const PRIVACY_LABELS = {
  normal: "Normal",
  off_record: "Off the record",
  device: "Device only",
  private: "Private Mode",
};
export const PRIVACY_HELP = {
  normal: "New chats are saved to your account and listed in the project.",
  off_record: "New chats are never saved, so they're never listed.",
  device: "New chats are kept encrypted in this browser's Device Vault, never on our servers. This choice stays in this browser; elsewhere they start off the record.",
  private: "New chats use zero-data-retention models only and are never saved.",
};
// The releases a stored default needs, besides Projects (the server gates
// saving one on them; see featuresFor).
export const PRIVACY_FEATURES = {
  normal: [],
  off_record: ["ephemeral"],
  private: ["private", "ephemeral"],
};
// And in the browser, Device only needs Device Vault too.
const CHOICE_FEATURES = { ...PRIVACY_FEATURES, device: ["vault", "ephemeral"] };
// The choices the editor offers: each needs its updates live. Device only
// also needs Device Vault to be usable here (signed in, not the demo).
export function privacyChoices(config, { vault = true } = {}) {
  return PRIVACY_CHOICES.filter(
    (p) =>
      CHOICE_FEATURES[p].every((id) => isReleased(config, id)) &&
      (p !== "device" || vault),
  );
}
// What the server stores for a choice: Device only is off the record there.
export const storedPrivacy = (choice) => (choice === "device" ? "off_record" : choice);
// A project's default as this browser sees it: off the record on the
// server, and marked Device only here (`deviceIds`, this browser's list),
// is Device only while Device Vault is usable.
export function effectivePrivacy(project, deviceIds = [], vault = false) {
  return project?.privacy === "off_record" && vault && deviceIds.includes(project.id)
    ? "device"
    : project?.privacy || "normal";
}
// This browser's Device only list after choosing `choice` for a project.
export function withDeviceChoice(ids = [], projectId, choice) {
  const rest = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id !== projectId);
  return choice === "device" ? [...rest, projectId] : rest;
}

// What a new chat in a project starts as: { ephemeral, deviceOnly,
// privateMode }. A default that can't run here never falls back to a saved
// chat: Device only without a usable Device Vault, or Private Mode that
// isn't live, starts off the record instead.
export function projectChatStart(privacy, { vault = false, privateMode = false } = {}) {
  if (privacy === "private" && privateMode)
    return { ephemeral: true, deviceOnly: false, privateMode: true };
  if (privacy === "device" && vault)
    return { ephemeral: true, deviceOnly: true, privateMode: false };
  if (privacy === "off_record" || privacy === "device" || privacy === "private")
    return { ephemeral: true, deviceOnly: false, privateMode: false };
  return { ephemeral: false, deviceOnly: false, privateMode: false };
}

// The instructions a chat in a project sends: the account's standing
// instructions, then the project's own, as one leading system message.
export function withProjectInstructions(standing, project) {
  return [String(standing || "").trim(), String(project?.instructions || "").trim()]
    .filter(Boolean)
    .join("\n\n");
}

// What a chat request adds for its project: the id only for a new saved
// chat, so the server files the conversation it creates. Never for off the
// record, Private Mode or Device only (all `ephemeral`), which store
// nothing, and never for a message added to a saved chat, which is already
// where it belongs.
export function projectRequestFields(project, { ephemeral = false, conversationId = null } = {}) {
  return project?.id && !ephemeral && !conversationId ? { project: project.id } : {};
}

// Pinned files are saved uploads, so they're attached where Saved files
// work: never in Private Mode, off the record (Device only is too) or with
// Veil on (see docs/FILES.md).
export const pinnedFilesBlocked = ({ privateMode = false, ephemeral = false, veilOn = false } = {}) =>
  !!(privateMode || ephemeral || veilOn);

// Pinned files' extracted text (GET /api/files/{id}/text) as composer
// documents, beside anything already attached, up to the composer's five.
// A file already attached isn't added twice.
export function withPinnedDocuments(documents = [], pinned = [], makeId = () => "") {
  const have = new Set(documents.map((d) => d.pinned).filter(Boolean));
  const out = [...documents];
  for (const f of pinned) {
    if (out.length >= MAX_PINNED) break;
    if (!f || typeof f.text !== "string" || have.has(f.id)) continue;
    have.add(f.id);
    out.push({
      id: makeId(),
      kind: "text",
      name: f.name,
      text: f.text,
      chars: f.text.length,
      truncated: !!f.truncated,
      pinned: f.id,
    });
  }
  return out;
}

// The Command Palette's Projects group: "Go to project" and "New chat in
// project" for each one. Names are the account's own words, so they're
// never translated; the detail line is.
export function projectItems(projects = []) {
  return (Array.isArray(projects) ? projects : [])
    .filter((p) => p && p.id)
    .flatMap((p) => [
      {
        key: "project:" + p.id,
        group: "projects",
        label: String(p.name || "Untitled project").slice(0, 200),
        detail: "Go to project",
        keywords: ["go to project", "open project", "projects"],
        icon: "folder",
        run: "open",
        value: p,
      },
      {
        key: "project-new:" + p.id,
        group: "projects",
        label: String(p.name || "Untitled project").slice(0, 200),
        detail: "New chat in project",
        keywords: ["new chat in project", "new chat", "new conversation"],
        icon: "plus",
        run: "new",
        value: p,
      },
    ]);
}

// Where "New chat in project" opens: the text mode you're in, else chat.
export function projectChatPath(project, mode = "chat") {
  const m = ["chat", "code", "uncensored"].includes(mode) ? mode : "chat";
  return "/workspace/" + m + "?project=" + encodeURIComponent(project.id);
}
export const projectPagePath = (project) =>
  "/workspace/projects" + (project ? "?p=" + encodeURIComponent(project.id) : "");

// Client-side checks that mirror the server's, for the editor's errors.
export function projectProblems({ name, instructions } = {}) {
  const errors = {};
  const n = String(name ?? "").trim();
  if (!n) errors.name = "Give the project a name.";
  else if (n.length > MAX_PROJECT_NAME)
    errors.name = `Use up to ${MAX_PROJECT_NAME} characters.`;
  if (String(instructions ?? "").length > MAX_PROJECT_INSTRUCTIONS)
    errors.instructions = `Project instructions cannot exceed ${MAX_PROJECT_INSTRUCTIONS} characters.`;
  return errors;
}
