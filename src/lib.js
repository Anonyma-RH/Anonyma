import { readChatEvents } from "./stream.js";
export class ApiError extends Error {
  constructor(message, status = 0, code = "unavailable", data = null) {
    super(message);
    this.status = status;
    this.code = code;
    // The whole error body, for the few callers that need more than the
    // message (Connect an App's "Return to the app").
    this.data = data;
  }
}
// Spending Limits: a 402 spending_limit refusal, said in the reader's own
// time. The server's message says how long until room frees up; this says
// when, from the error body's spending_limit details. Null for any other
// error, whose own message is shown.
export function spendingLimitMessage(data) {
  const s = data?.spending_limit;
  if (data?.error?.code !== "spending_limit" || !s) return null;
  const name = s.limit === "monthly" ? "monthly" : "daily";
  const fmt = (v) =>
    Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 });
  const limit = Number(s.limit_credits),
    asked = Number(s.requested_credits),
    left = Number(s.remaining_credits);
  let text =
    limit === 0
      ? `Your ${name} spending limit is 0 credits, so nothing can be spent.`
      : asked > limit
        ? `This would spend up to ${fmt(asked)} credits, more than your whole ${name} spending limit of ${fmt(limit)} credits.`
        : left <= 0
          ? `You've reached your ${name} spending limit of ${fmt(limit)} credits.`
          : `This would spend up to ${fmt(asked)} credits, more than the ${fmt(left)} credits left of your ${name} spending limit.`;
  if (Number.isFinite(s.frees_at))
    text += ` Room frees up at ${new Date(s.frees_at).toLocaleString(undefined, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}.`;
  else if (Number(s.held_credits) > 0 && asked <= limit)
    text += " Room frees up as requests in progress finish.";
  return text;
}
export async function api(path, { method = "GET", body, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError("The service could not be reached. Please try again.");
  }
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new ApiError(
      "The ANONYMA service is currently unavailable. Please try again.",
      503,
    );
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      spendingLimitMessage(data) ||
        data.error?.message ||
        "The request could not be completed.",
      response.status,
      data.error?.code,
      data,
    );
  return data;
}
export async function streamChat(body, onEvent, signal) {
  const response = await fetch("/api/chat", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    let error;
    try {
      error = await response.json();
    } catch {}
    throw new ApiError(
      spendingLimitMessage(error) ||
        error?.error?.message ||
        "Chat is unavailable.",
      response.status,
      error?.error?.code,
      error,
    );
  }
  for await (const event of readChatEvents(response)) onEvent(event);
}
export function readStore(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem("anonyma:" + key)) ?? fallback;
  } catch {
    return fallback;
  }
}
export function saveStore(key, value) {
  try {
    localStorage.setItem("anonyma:" + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
export function download(name, content, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
export function estimateCredits(usd) {
  return Math.round(Number(usd) * 1000);
}
export function savings(subscription, usage) {
  return {
    annual: Math.max(0, (subscription - usage) * 12),
    monthly: subscription - usage,
    percent: subscription
      ? Math.round(((subscription - usage) / subscription) * 100)
      : 0,
  };
}
export const uid = () => crypto.randomUUID();

// Backend contract adapters (Anonyma-RH/Anonyma server). Keep these pure so tests can cover them.

// The catalog names the maker `owned_by`; the UI reads `provider` and a short description.
export function normalizeModel(m) {
  const modality = m.architecture?.modality;
  return {
    ...m,
    provider: m.provider || m.owned_by || String(m.id).split("/")[0],
    description:
      m.description ||
      (modality
        ? modality.replace("->", " → ")
        : m.type
          ? `${m.type} model`
          : ""),
  };
}
// Popular callable models first, then the rest alphabetically.
export function sortModels(list) {
  return [...list].sort(
    (a, b) =>
      Number(!!b.callable) - Number(!!a.callable) ||
      Number(!!b.popular) - Number(!!a.popular) ||
      String(a.name).localeCompare(String(b.name)),
  );
}

// Saved messages hold a string, an array of text/image parts, or {text, reasoning, images}.
export function messageFromServer(m) {
  const c = m.content;
  if (typeof c === "string") return { ...m, content: c };
  if (Array.isArray(c))
    return {
      ...m,
      content: c
        .filter((p) => p?.type === "text")
        .map((p) => p.text)
        .join("\n"),
      images: c
        .filter((p) => p?.type === "image_url")
        .map((p) => p.image_url.url),
    };
  return {
    ...m,
    content: c?.text || "",
    reasoning: c?.reasoning || "",
    finishReason: c?.finish_reason || null,
    interrupted: c?.interrupted === true,
    requestId: c?.request_id || null,
    images: (c?.images || [])
      .map((i) => i?.image_url?.url || i?.url)
      .filter(Boolean),
    citations: Array.isArray(c?.citations) ? c.citations : [],
    // Privacy Trail metadata kept with a saved reply (never prompt text).
    ...(c?.privacy && typeof c.privacy === "object" ? { privacy: c.privacy } : {}),
  };
}
// The server accepts string content, or text plus image_url parts for reference images.
export function toRequestMessage(m) {
  const images = m.role === "user" ? m.images || [] : [];
  return {
    role: m.role,
    content: images.length
      ? [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...images.map((url) => ({ type: "image_url", image_url: { url } })),
        ]
      : m.content || "",
  };
}

// Mirrors the backend's data/video-presets.js: only published, positive prices become options.
export function videoPresets(model) {
  const variants = model?.pricing?.variants || [];
  const presets = [];
  for (const variant of variants) {
    for (const option of variant.options || []) {
      if (
        typeof option.price !== "number" ||
        !Number.isFinite(option.price) ||
        option.price <= 0
      )
        continue;
      const pair = /^(16:9|9:16|1:1)_([1-9]\d{0,2})$/.exec(option.size);
      const seconds = /^[1-9]\d{0,2}$/.test(option.size);
      if (pair || seconds || option.size === "default")
        presets.push({
          quality: variant.quality || "",
          ratio: pair?.[1] || "",
          duration: pair?.[2] || (seconds ? option.size : ""),
          price: option.price,
        });
    }
  }
  const price = model?.pricing?.base_price ?? model?.pricing?.per_generation;
  if (
    !variants.length &&
    typeof price === "number" &&
    Number.isFinite(price) &&
    price > 0
  )
    presets.push({ quality: "", ratio: "", duration: "", price });
  return presets;
}

// Wallet sign-in and linking. The wallet only proves control of an address by signing the
// server's exact one-time challenge; no transfer, approval or recovery phrase is ever requested.
export const walletAvailable = (config) =>
  !!globalThis.window?.ethereum || !!config?.walletProject;
async function walletProvider(config, chain) {
  let provider = globalThis.window?.ethereum;
  if (!provider) {
    if (!config?.walletProject)
      throw new Error(
        "Install a browser wallet, or ask the operator to configure WalletConnect for mobile wallets.",
      );
    const { EthereumProvider } =
      await import("@walletconnect/ethereum-provider");
    provider = await EthereumProvider.init({
      projectId: config.walletProject,
      chains: [chain || config.walletChain || 1],
      showQrModal: true,
    });
    await provider.connect();
  }
  return provider;
}
function walletError(e) {
  if (e?.code === 4001)
    return new Error("The wallet request was cancelled. Nothing was sent.");
  if (e?.code === -32002)
    return new Error(
      "Your wallet already has a pending request. Open it to continue.",
    );
  return e;
}
// "12.5" with 6 decimals -> 12500000n. Rejects more precision than the token has.
export function toTokenUnits(amount, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(amount).trim());
  if (!m || (m[2] || "").length > decimals)
    throw new Error(`Enter an amount with at most ${decimals} decimal places.`);
  return BigInt(m[1] + (m[2] || "").padEnd(decimals, "0"));
}
// ERC-20 transfer(to, value) call data.
export function transferData(to, value) {
  const word = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  return "0xa9059cbb" + word(to) + word(value.toString(16));
}
// Sends the stablecoin from the linked wallet to the payment address and
// returns the transaction hash. Crediting happens server-side once the
// chain confirms it; see claimWalletPayment.
export async function payWithWallet(config, linkedWallet, amount) {
  const wp = config.walletPayments;
  const value = toTokenUnits(amount, wp.decimals);
  if (value <= 0n) throw new Error("Enter an amount above zero.");
  const provider = await walletProvider(config, wp.chainId);
  try {
    const [address] = await provider.request({ method: "eth_requestAccounts" });
    if (!address) throw new Error("No wallet account was selected.");
    if (address.toLowerCase() !== String(linkedWallet).toLowerCase())
      throw new Error(
        `Your wallet is on ${address}, but payments are matched to your linked wallet ${linkedWallet}. Switch accounts in your wallet, or change the linked wallet in Settings.`,
      );
    const chainId = "0x" + wp.chainId.toString(16);
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId }],
      });
    } catch (e) {
      if (e?.code !== 4902 || !wp.publicRpc) throw e;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId,
            chainName: wp.chainName,
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: [wp.publicRpc],
            ...(wp.explorer ? { blockExplorerUrls: [wp.explorer] } : {}),
          },
        ],
      });
    }
    return await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: address,
          to: wp.token,
          data: transferData(wp.address, value),
          value: "0x0",
        },
      ],
    });
  } catch (e) {
    throw walletError(e);
  }
}
// Asks the server to credit a sent transaction, checking again every few
// seconds while the chain confirms it. Resolves with the credited deposit.
export async function claimWalletPayment(txHash, { onProgress, signal } = {}) {
  const deadline = Date.now() + 10 * 60000;
  for (;;) {
    const r = await api("/api/deposits/wallet", {
      method: "POST",
      body: { txHash },
      signal,
    });
    if (r.credited) return r;
    onProgress?.(r);
    if (Date.now() > deadline)
      throw new ApiError(
        "The payment isn't confirmed yet. It will be credited when you check again; nothing is lost.",
        202,
        "still_confirming",
      );
    await new Promise((resolve, reject) => {
      const id = setTimeout(resolve, 3000);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(id);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }
}
export async function walletSign(config, link = false) {
  const provider = await walletProvider(config);
  try {
    const [address] = await provider.request({ method: "eth_requestAccounts" });
    if (!address) throw new Error("No wallet account was selected.");
    const challenge = await api("/api/auth/wallet/challenge", {
      method: "POST",
      body: { address, link },
    });
    const signature = await provider.request({
      method: "personal_sign",
      params: [challenge.message, address],
    });
    return await api("/api/auth/wallet/verify", {
      method: "POST",
      body: { id: challenge.id, signature },
    });
  } catch (e) {
    if (e?.code === 4001)
      throw new Error("The wallet request was cancelled. Nothing was signed.");
    throw walletError(e);
  }
}

// Released updates (see server/releases.js). Without config (preview or
// offline) gated features stay unavailable.
// Where signing in may send someone back to: only the Connect an App
// consent page on this site, with its request, never anywhere else.
export function safeNext(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  return /^\/connect\?[^\\#]*$/.test(value) ? value : null;
}
export const isReleased = (config, id) =>
  config?.releases?.features?.[id] === true;
export const releaseUpdate = (config, id) =>
  config?.releases?.updates?.find((u) => u.id === id) || null;
// The update each workspace mode belongs to; library needs any media studio.
export const MODE_FEATURES = {
  tools: "tasktools",
  code: "code",
  image: "images",
  video: "video",
  audio: "audio",
  collab: "collab",
  uncensored: "uncensored",
  symposium: "symposium",
};
export function modeReleased(config, mode) {
  if (mode === "library")
    return ["images", "video", "audio"].some((id) => isReleased(config, id));
  return !MODE_FEATURES[mode] || isReleased(config, MODE_FEATURES[mode]);
}

// Which manual install hint this browser needs, when it has no install prompt:
// "ios" for Safari on iPhone and iPad, and for Chrome, Edge and Firefox there
// from iOS 16.4 (they can add to the Home Screen from their share menu too);
// "mac" for Safari 17+ on a Mac (File → Add to Dock); null otherwise.
export function installHintFor(ua = "", platform = "", maxTouchPoints = 0) {
  const iPadAsMac = platform === "MacIntel" && maxTouchPoints > 1;
  if (/iPad|iPhone|iPod/.test(ua) || iPadAsMac) {
    if (!/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return "ios";
    const v = ua.match(/OS (\d+)_(\d+)/);
    const [major, minor] = v ? [Number(v[1]), Number(v[2])] : [0, 0];
    return major > 16 || (major === 16 && minor >= 4) ? "ios" : null;
  }
  const macSafari =
    /Macintosh/.test(ua) &&
    /Safari\//.test(ua) &&
    !/Chrome|Chromium|Edg\/|Firefox|OPR\//.test(ua);
  const version = Number((ua.match(/Version\/(\d+)/) || [])[1] || 0);
  return macSafari && version >= 17 ? "mac" : null;
}
