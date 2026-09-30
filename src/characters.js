// Characters: AI characters an account makes for itself: a name, a picture,
// a personality and the model they talk through. The pure half, shared by
// the server (what a character may hold, what a copy link carries) and the
// browser (what a chat with one sends). No DOM, React or storage here, so
// tests run it in node.
//
// A character's instructions are sent by the browser, exactly as a project's
// are (src/projects.js): as part of the one leading system message, so Veil
// masks them with the rest of the request and they're never saved with a
// chat. The order is fixed: your standing instructions (Scrolls), then the
// project's, then the character's. Its opening message is shown as the first
// assistant turn; it is not a model reply, costs nothing to show and is
// never sent as an assistant turn. The model is told about it inside the
// character's instructions instead, so it stays in voice.
// The browser's release check (isReleased in src/lib.js), inlined so the
// server can import this file without the browser's helpers.
const isReleased = (config, id) => config?.releases?.features?.[id] === true;

export const charactersReleased = (config) => isReleased(config, "characters");

export const MAX_CHARACTERS = 50;
export const MAX_CHARACTER_NAME = 60;
export const MAX_CHARACTER_DESCRIPTION = 200;
// The same limit as standing and project instructions.
export const MAX_CHARACTER_INSTRUCTIONS = 4000;
export const MAX_CHARACTER_OPENING = 1000;

// A picture is a built-in monogram (a letter on a flat colour), or an image
// the browser has redrawn at 256 px (which drops every hidden detail).
export const AVATAR_SIZE = 256;
export const MAX_AVATAR_BYTES = 48 * 1024;
export const AVATAR_TYPES = ["image/webp", "image/jpeg", "image/png"];
// The house palette (src/brand.css), each with the ink that reads on it.
export const MONOGRAMS = [
  { id: "cobalt", hex: "#0135df", ink: "#ffffff", label: "Cobalt" },
  { id: "navy", hex: "#061b69", ink: "#ffffff", label: "Navy" },
  { id: "amber", hex: "#ffb21c", ink: "#061b69", label: "Amber" },
  { id: "ink", hex: "#18233f", ink: "#ffffff", label: "Ink" },
  { id: "slate", hex: "#606a80", ink: "#ffffff", label: "Slate" },
  { id: "mist", hex: "#d9e5ff", ink: "#061b69", label: "Mist" },
];
export const DEFAULT_MONOGRAM = "cobalt";
export const monogram = (id) => MONOGRAMS.find((m) => m.id === id) || MONOGRAMS[0];
// Stored as null, "mono:<colour id>" or a data URL of an image.
export function parseAvatar(value) {
  if (value == null || value === "") return { kind: "none" };
  if (typeof value !== "string") return null;
  const mono = /^mono:([a-z]{2,10})$/.exec(value);
  if (mono) return MONOGRAMS.some((m) => m.id === mono[1]) ? { kind: "mono", color: mono[1] } : null;
  const image = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  return image ? { kind: "image", mime: image[1], base64: image[2] } : null;
}
export const monogramAvatar = (id) => "mono:" + id;
// The letter a monogram shows: the first letter or number of the name.
export function initialOf(name) {
  const m = /[\p{L}\p{N}]/u.exec(String(name ?? ""));
  return m ? m[0].toUpperCase() : "?";
}

// A copy link: another signed-in account can add a copy of the character as
// it was when the link was made. The link carries no chats.
export const SHARE_DAYS = [1, 7, 30];
export const DEFAULT_SHARE_DAYS = 30;
export const MAX_ACTIVE_SHARES = 20;
export const MAX_SHARES_PER_CHARACTER = 5;
export const SHARE_TOKEN_BYTES = 32;
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
// The address of a copy link. The token sits after the # so it never
// reaches a server log or a referrer; the page takes it out of the address
// bar at once.
export const SHARE_PAGE = "/workspace/characters";
export const shareUrl = (base, token) =>
  String(base || "").replace(/\/+$/, "") + SHARE_PAGE + "#copy=" + token;
// The token in what was pasted: a whole link, its #copy=… part or the bare
// token. Anything else is not one.
export function tokenFromLink(text) {
  const s = String(text ?? "").trim();
  if (SHARE_TOKEN.test(s)) return s;
  const m = /#copy=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(s);
  return m ? m[1] : null;
}
export const parseShareDays = (value) => {
  if (value === undefined) return { ok: true, days: DEFAULT_SHARE_DAYS };
  return SHARE_DAYS.includes(value) ? { ok: true, days: value } : { ok: false };
};

// What the editor checks before the server does.
export function characterProblems({ name, description, instructions, opening } = {}) {
  const errors = {};
  const n = String(name ?? "").trim();
  if (!n) errors.name = "Give the character a name.";
  else if (n.length > MAX_CHARACTER_NAME) errors.name = `Use up to ${MAX_CHARACTER_NAME} characters.`;
  if (String(description ?? "").length > MAX_CHARACTER_DESCRIPTION)
    errors.description = `Keep the description to ${MAX_CHARACTER_DESCRIPTION} characters.`;
  if (String(instructions ?? "").length > MAX_CHARACTER_INSTRUCTIONS)
    errors.instructions = `Instructions cannot exceed ${MAX_CHARACTER_INSTRUCTIONS} characters.`;
  if (String(opening ?? "").length > MAX_CHARACTER_OPENING)
    errors.opening = `Keep the opening message to ${MAX_CHARACTER_OPENING} characters.`;
  return errors;
}

// What a chat with the character adds to the system message: its
// instructions, then (when it has one) a line telling the model what its
// opening message was, since that turn is shown but never sent as a reply.
export function characterBlock(character) {
  const text = String(character?.instructions ?? "").trim();
  const opening = String(character?.opening ?? "").trim();
  return [
    text,
    opening ? "Your opening message, already shown to the person before they wrote anything:\n" + opening : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
// `before` is what withProjectInstructions returned: standing instructions,
// then the project's. The character's come last.
export function withCharacterInstructions(before, character) {
  return [String(before || "").trim(), characterBlock(character)].filter(Boolean).join("\n\n");
}

// The first assistant turn of a chat with the character. It has no model and
// no charge, and `opening` keeps it out of every request.
export const openingMessage = (character) => ({
  role: "assistant",
  content: String(character?.opening ?? "").trim(),
  opening: true,
});
export const hasOpening = (character) => !!String(character?.opening ?? "").trim();

// What a chat request adds for its character: the id only for a new saved
// chat, so the server files the conversation it creates. Never for off the
// record, Private Mode or Device only (all `ephemeral`), which store
// nothing, and never for a message added to a saved chat (which keeps the
// character it began with).
export function characterRequestFields(character, { ephemeral = false, conversationId = null } = {}) {
  return character?.id && !ephemeral && !conversationId ? { character: character.id } : {};
}

// The text modes a character can talk in: an Uncensored model only exists in
// the Uncensored section, so a character on one opens there.
export function characterMode(character, uncensoredIds = []) {
  return character?.model && uncensoredIds.includes(character.model) ? "uncensored" : "chat";
}
export const characterChatPath = (character, uncensoredIds = []) =>
  "/workspace/" + characterMode(character, uncensoredIds) + "?character=" + encodeURIComponent(character.id);
export const characterPagePath = (character) =>
  "/workspace/characters" + (character ? "?id=" + encodeURIComponent(character.id) : "");

// What the chat says about the character's own default model, or "" when
// there's nothing to say: Private Mode offers only private models, and an
// Uncensored model exists only in the Uncensored section.
export function characterModelNote(character, { models = [], visible = [], privateMode = false } = {}) {
  if (!character?.model) return "";
  const m = models.find((x) => x.id === character.model);
  if (!m) return "This character's default model isn't available, so choose one from the list.";
  if (privateMode && !m.private)
    return "Private Mode offers only private models, and this character's default isn't one. Choose a private model.";
  if (!visible.some((x) => x.id === m.id))
    return "This character's default model isn't offered in this section. Choose another model.";
  return "";
}
