// Redact a PDF -> Chat: the redacted pages (as pictures, or as the text read
// from them on this device) are handed to the next chat's composer through
// this one in-memory slot. Nothing is written anywhere, nothing rides in the
// URL or the router's history state, and a payload nobody takes within half a
// minute is dropped.
let held = null;
const LIFETIME = 30000;
export function holdForChat(payload, now = Date.now()) {
  held = payload ? { payload, at: now } : null;
}
export function takeForChat(now = Date.now()) {
  const h = held;
  held = null;
  return h && now - h.at <= LIFETIME ? h.payload : null;
}

// Whether Send to chat can go on, and why not (null when it can). It needs a
// signed-in workspace, and Sealed Mode takes no attachments.
export function sendBlock({ demo, signedIn, sealed }) {
  if (demo || !signedIn) return "Send to chat needs a signed-in workspace. Download the copy instead.";
  if (sealed) return "Sealed Mode takes no attachments. Turn it off to send pages to a chat, or download the copy.";
  return null;
}
