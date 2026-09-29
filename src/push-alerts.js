// Push Alerts: the rules the server (server/push-alerts.js, server/web-push.js)
// and the page (src/PushAlerts.jsx) share. No DOM, no imports, so tests and
// the server can load it as it is.

// The per-account switches, each on by default once a browser is subscribed,
// and the updates each one needs besides Push Alerts itself.
export const PUSH_EVENTS = ["pagewatch", "routines", "lowbalance", "gifts", "inactivity"];
export const EVENT_UPDATES = {
  pagewatch: ["pagewatch", "routines"],
  routines: ["routines"],
  lowbalance: ["balancealerts"],
  gifts: ["giftlinks"],
  inactivity: ["deadswitch", "wipe"],
};

// Every notification ANONYMA can send, with its fixed text. None of them
// carries anything from the account: no chat or page text, no amounts, no
// names, no links to content. Clicking opens `url` on this site.
export const PUSH_TITLE = "ANONYMA";
export const PUSH_KINDS = {
  pagewatch: { event: "pagewatch", url: "/workspace/routines", body: "Your page watch found a change." },
  pagewatch_paused: { event: "pagewatch", url: "/workspace/routines", body: "A page watch was paused. Open it to see why." },
  routine: { event: "routines", url: "/workspace/routines", body: "Your routine has a new result." },
  lowbalance: { event: "lowbalance", url: "/account/credits", body: "Your balance is low." },
  gift_claimed: { event: "gifts", url: "/account/credits#gift-links", body: "Your gift was claimed." },
  gift_returned: { event: "gifts", url: "/account/credits#gift-links", body: "An unclaimed gift came back to your balance." },
  inactivity: {
    event: "inactivity",
    url: "/account/settings#inactivity-wipe",
    body: "Inactivity Wipe erases your content in 7 days. Sign in to keep it.",
  },
  test: { event: null, url: "/account/settings#push-alerts", body: "Notifications from ANONYMA are working." },
};
// The same text in Chinese, for browsers that subscribed with the site in
// Chinese (the language is kept with the subscription). Kept equal to
// src/i18n/zh.json's translations (tests/push-alerts.test.mjs).
export const PUSH_BODIES_ZH = {
  "Your page watch found a change.": "你的网页监测发现了变化。",
  "A page watch was paused. Open it to see why.": "一个网页监测已暂停。打开查看原因。",
  "Your routine has a new result.": "你的定时任务有新结果。",
  "Your balance is low.": "你的余额不足。",
  "Your gift was claimed.": "你的礼物已被领取。",
  "An unclaimed gift came back to your balance.": "一份未领取的礼物已退回你的余额。",
  "Inactivity Wipe erases your content in 7 days. Sign in to keep it.": "闲置清除将在 7 天后清除你的内容。登录即可保留。",
  "Notifications from ANONYMA are working.": "ANONYMA 的通知已正常工作。",
};
export const PUSH_LANGS = ["en", "zh"];

// The notification for one kind, in the subscription's language: the whole
// payload the browser receives (then padded and encrypted).
export function pushPayload(kind, lang = "en") {
  const k = PUSH_KINDS[kind];
  if (!k) return null;
  return {
    v: 1,
    kind,
    title: PUSH_TITLE,
    body: lang === "zh" ? PUSH_BODIES_ZH[k.body] || k.body : k.body,
    url: k.url,
    tag: "anonyma-" + (k.event || kind),
  };
}

// The push services ANONYMA sends to, by the endpoint's host. Anything else
// is refused, so a subscription can never make the server post to an
// arbitrary address.
export function pushService(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (h === "fcm.googleapis.com" || h === "android.googleapis.com") return "google";
  if (h === "push.services.mozilla.com" || h.endsWith(".push.services.mozilla.com")) return "mozilla";
  if (h.endsWith(".push.apple.com")) return "apple";
  if (h.endsWith(".notify.windows.com")) return "microsoft";
  return null;
}
export const SERVICE_NAMES = {
  google: "Google's push service",
  mozilla: "Mozilla's push service",
  apple: "Apple's push service",
  microsoft: "Microsoft's push service",
};
export const SERVICE_BROWSERS = {
  google: "Chrome or similar",
  mozilla: "Firefox",
  apple: "Safari",
  microsoft: "Edge",
};

// At most this many browsers per account.
export const MAX_DEVICES = 10;

// A short fingerprint of a subscription's endpoint, so the page can tell
// which listed browser is this one without the server sending endpoints.
export async function deviceTag(endpoint) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(endpoint)));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The VAPID public key as the bytes PushManager.subscribe takes.
export function keyBytes(b64u) {
  const s = String(b64u || "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
// Whether a subscription was made with this key (after a key change, the
// browser subscribes again).
export function sameKey(subscriptionKey, b64u) {
  if (!subscriptionKey) return true;
  const a = new Uint8Array(subscriptionKey);
  const b = keyBytes(b64u);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// The path a notification may open: one of ours, on this site.
export function safePushUrl(url) {
  const u = String(url || "");
  return Object.values(PUSH_KINDS).some((k) => k.url === u) ? u : "/workspace";
}
