// Credit Estimates: the chat request Send makes, built in one place so the
// estimate beside Send prices exactly what Send will post, and a debounced
// estimator that never shows a stale answer. Pure and DOM-free so it can be
// unit tested in node; the React side lives in CreditEstimate.jsx.
import { toRequestMessage } from "./lib.js";
import { historyLimit, withStanding } from "./scrolls.js";
import { fitDocuments, composeMessageWithDocuments } from "./documents.js";
import { maskOutsideLinks } from "./link-reader.js";
import { veil } from "./veil.js";
import { factsToSend } from "./memory.js";

// The reply budget Send asks for; the estimate quotes the same one.
export const REPLY_BUDGET = 4096;

// The messages a chat Send posts, and the conversation as shown afterwards.
// `veilWith` is { state, words } when Veil is on, else null. Veil records new
// tags in `veilWith.state`, so Send passes its live map and an estimate passes
// a copy (cloneVeilState): the copy yields the same tags Send would, without
// remembering anything for a message that may never be sent.
export function buildChatRequest({
  messages = [],
  text = "",
  attachments = [],
  documents = [],
  instructions = "",
  veilWith = null,
  preserveHistory = false,
  // Memory Across Models: the account's facts when memory applies to this
  // request, else null. Sent as [{ id, text }]; the server adds them.
  memoryFacts = null,
}) {
  // Document text (already trimmed to the shared budget) rides along as
  // delimited blocks after the typed prompt; see src/documents.js.
  const budgeted = documents.length ? fitDocuments(text, documents).documents : [];
  const content = budgeted.length ? composeMessageWithDocuments(text, budgeted) : text;
  const rawNext = [
    ...messages,
    { role: "user", content, images: attachments.map((a) => a.url) },
  ];
  // Standing instructions (Scrolls) lead the request as a system message in
  // one of the context slots (see historyLimit).
  let standing = instructions || "";
  const history = preserveHistory ? rawNext.length : historyLimit(standing);
  if (!veilWith)
    return {
      next: rawNext,
      request: withStanding(standing, rawNext.slice(-history).map(toRequestMessage)),
      memory: memoryFacts ? factsToSend(memoryFacts) : null,
      masked: 0,
      tags: [],
    };
  // Veil masks the instructions, the new message and any earlier turns in
  // this request's context window; tagging happens only in this browser.
  let masked = 0;
  const tags = new Set();
  const mask = (value) => {
    const r = veil(value, veilWith.state, veilWith.words);
    masked += r.count;
    r.tags.forEach((t) => tags.add(t));
    return r.text;
  };
  if (standing) standing = mask(standing);
  // A page read by Link Reader is public text, not the user's: Veil masks
  // the typed question around it and leaves the page as it is.
  const payload = rawNext
    .slice(-history)
    .map((m) => ({ ...m, content: maskOutsideLinks(m.content || "", mask) }));
  return {
    // The just-sent message is displayed the way the server saw it.
    next: [...messages, payload[payload.length - 1]],
    request: withStanding(standing, payload.map(toRequestMessage)),
    // Memory facts are masked with the same map, so a reply's tags unveil.
    memory: memoryFacts ? factsToSend(memoryFacts, mask) : null,
    masked,
    tags: [...tags],
  };
}

export const cloneVeilState = (state) => ({
  map: { ...(state?.map || {}) },
  counters: { ...(state?.counters || {}) },
  valueToTag: { ...(state?.valueToTag || {}) },
});

// The /api/quote body for a chat Send: same model, messages, reply budget and
// web search flag, and nothing that reserves or charges.
export function quoteBody({
  model,
  request,
  webSearch = false,
  maxTokens = REPLY_BUDGET,
  treasury = false,
  conversationId,
  memory = null,
  mode,
}) {
  return {
    model,
    messages: request,
    max_tokens: maxTokens,
    ...(treasury === true ? { treasury: true, conversationId } : {}),
    ...(webSearch ? { web_search: true } : {}),
    // The same memory Send would carry, with what decides whether it's used.
    ...(memory ? { memory, mode, ...(conversationId ? { conversationId } : {}) } : {}),
  };
}

// Requests carrying reference images are large, so they wait longer before
// quoting; the text is still priced exactly.
const hasImages = (body) =>
  (body?.messages || []).some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p?.type === "image_url"),
  );

// Debounces quote requests and keeps only the newest answer. States:
//   idle         nothing to estimate (empty prompt, signed out, sending)
//   loading      waiting or asking; `last` is the previous estimate, if any
//   ready        { credits, available, model } for the current request
//   unavailable  the quote failed; never shown as zero
export function createEstimator({
  quote,
  onChange,
  delay = 500,
  imageDelay = 1500,
  timers = globalThis,
}) {
  let seq = 0,
    timer = null,
    controller = null,
    lastKey = null,
    state = { status: "idle" };
  const set = (next) => {
    state = next;
    onChange(next);
  };
  const cancel = () => {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };
  const lastReady = () =>
    state.status === "ready" ? state : state.status === "loading" ? state.last : null;
  return {
    get state() {
      return state;
    },
    // Call with the current quote body, or null when there is nothing to
    // estimate. Every call supersedes the ones before it.
    update(body) {
      const id = ++seq;
      cancel();
      if (!body) {
        lastKey = null;
        if (state.status !== "idle") set({ status: "idle" });
        return;
      }
      const last = lastReady();
      if (state.status !== "loading") set({ status: "loading", last });
      timer = timers.setTimeout(
        async () => {
          timer = null;
          const key = JSON.stringify(body);
          // Unchanged request (e.g. a caret move or a re-render): keep the answer.
          if (key === lastKey && last) return set(last);
          const c = new AbortController();
          controller = c;
          try {
            const r = await quote(body, c.signal);
            if (id !== seq) return;
            lastKey = key;
            set({
              status: "ready",
              credits: Number(r.credits),
              available: r.available == null ? null : Number(r.available),
              // Spending Limits: room left under the account's own limits.
              ...(r.spending_limit?.remaining != null
                ? { room: Number(r.spending_limit.remaining) }
                : {}),
              model: r.model,
              ...(body.max_tokens ? { replyBudget: body.max_tokens } : {}),
            });
          } catch (e) {
            if (id !== seq || e?.name === "AbortError") return;
            lastKey = null;
            set({
              status: "unavailable",
              message: e?.message || "The estimate is unavailable.",
              code: e?.code || null,
            });
          } finally {
            if (controller === c) controller = null;
          }
        },
        hasImages(body) ? imageDelay : delay,
      );
    },
    dispose() {
      seq++;
      cancel();
    },
  };
}

// What the chip beside Send says. An estimate is labelled as one, and a
// refresh never shows the previous request's number as the current quote.
export function estimateLabel(state) {
  switch (state?.status) {
    case "ready":
      return {
        text: `Estimated ≈${formatCredits(state.credits)} credits`,
        tone:
          state.available != null && state.credits > state.available
            ? "short"
            : state.room != null && state.credits > state.room
              ? "limited"
              : "ready",
      };
    case "loading":
      return { text: "Updating estimate…", tone: "loading" };
    case "unavailable":
      return { text: "Estimate unavailable", tone: "unavailable" };
    default:
      return null;
  }
}

// "12.35", "0.0421", "1,204": enough precision to compare, no float noise.
export function formatCredits(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "0";
  if (n >= 100) return Math.round(n).toLocaleString("en-US");
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
}
