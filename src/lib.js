import { readChatEvents } from "./stream.js";
export class ApiError extends Error {
  constructor(message, status = 0, code = "unavailable") {
    super(message);
    this.status = status;
    this.code = code;
  }
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
      "The ANONYMA service is not connected to this preview.",
      503,
    );
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      data.error?.message || "The request could not be completed.",
      response.status,
      data.error?.code,
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
      error?.error?.message || "Chat is unavailable.",
      response.status,
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
      (modality ? modality.replace("->", " → ") : m.type ? `${m.type} model` : ""),
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
      images: c.filter((p) => p?.type === "image_url").map((p) => p.image_url.url),
    };
  return {
    ...m,
    content: c?.text || "",
    reasoning: c?.reasoning || "",
    images: (c?.images || []).map((i) => i?.image_url?.url || i?.url).filter(Boolean),
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
      if (typeof option.price !== "number" || !Number.isFinite(option.price) || option.price <= 0)
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
  if (!variants.length && typeof price === "number" && Number.isFinite(price) && price > 0)
    presets.push({ quality: "", ratio: "", duration: "", price });
  return presets;
}

// Wallet sign-in and linking. The wallet only proves control of an address by signing the
// server's exact one-time challenge; no transfer, approval or recovery phrase is ever requested.
export const walletAvailable = (config) =>
  !!globalThis.window?.ethereum || !!config?.walletProject;
export async function walletSign(config, link = false) {
  let provider = globalThis.window?.ethereum;
  if (!provider) {
    if (!config?.walletProject)
      throw new Error(
        "Install a browser wallet, or ask the operator to configure WalletConnect for mobile wallets.",
      );
    const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
    provider = await EthereumProvider.init({
      projectId: config.walletProject,
      chains: [config.walletChain || 1],
      showQrModal: true,
    });
    await provider.connect();
  }
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
    if (e?.code === -32002)
      throw new Error("Your wallet already has a pending request. Open it to continue.");
    throw e;
  }
}
