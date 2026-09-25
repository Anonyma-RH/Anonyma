// Edit, regenerate and branch chats: the pure planning the workspace uses.
// Both edit and regenerate resend a user turn from the history before it:
// saved conversations first branch there on the server (the original stays
// as it was); off-the-record and demo chats only rewind in this browser.

// A saved user message may carry <document> blocks after the typed prompt
// (src/documents.js). Editing changes the typed part and keeps the documents.
export function promptParts(content) {
  const text = typeof content === "string" ? content : "";
  const at = text.indexOf("\n\n<document ");
  if (text.startsWith("<document ")) return { typed: "", attached: text };
  return at < 0
    ? { typed: text, attached: "" }
    : { typed: text.slice(0, at), attached: text.slice(at) };
}

// What to resend for an edit (index is a user message) or a regenerate
// (index is an assistant message; its prompt is the nearest user message
// before it). Returns null when there is nothing to resend.
export function rewindPlan(messages, index, kind) {
  const m = messages?.[index];
  if (!m) return null;
  let userIndex = -1;
  if (kind === "edit" && m.role === "user") userIndex = index;
  if (kind === "regenerate" && m.role === "assistant")
    for (let i = index - 1; i >= 0; i--)
      if (messages[i].role === "user") {
        userIndex = i;
        break;
      }
  if (userIndex < 0) return null;
  const prompt = messages[userIndex];
  return {
    userIndex,
    base: messages.slice(0, userIndex),
    prompt,
    // The model that answered, so a regenerate asks the same one by default.
    model: kind === "regenerate" ? m.model || null : null,
  };
}

// The content to resend: an edit replaces the typed text and keeps any
// attached documents; a regenerate resends the prompt exactly.
export function resendContent(prompt, editedText) {
  if (editedText == null) return prompt.content || "";
  return editedText.trim() + promptParts(prompt.content).attached;
}

// Branches cut at a given message, for the chips under it.
export const branchesAt = (branches, messageId) =>
  messageId ? (branches || []).filter((b) => b.branch_point === messageId) : [];

// One branch/resend at a time. `run` ignores calls while one is pending (a
// double click can't make two branches or pay for two generations) and hands
// the task a `fresh()` check that turns false once `reset` is called (the user
// opened another conversation or started a new chat), so late results are
// dropped instead of landing in the wrong place.
export function singleFlight() {
  let pending = false,
    generation = 0;
  return {
    get pending() {
      return pending;
    },
    reset() {
      generation++;
    },
    async run(task) {
      if (pending) return undefined;
      pending = true;
      const started = generation;
      try {
        return await task(() => started === generation);
      } finally {
        pending = false;
      }
    },
  };
}
