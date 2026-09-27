// On-Device Model: a small open model that runs in this browser on WebGPU,
// through WebLLM (@mlc-ai/web-llm, loaded only on its page, in a worker:
// src/ondevice-engine.js and src/ondevice.worker.js).
//
// Nothing about a chat here touches ANONYMA's server: no /api/chat, no
// credits, no history. The only network traffic is the one-time download of
// the model's files, straight from Hugging Face (the weights, config and
// tokenizer) and GitHub (the compiled WebGPU library), at the pinned
// revisions below. The browser keeps them in Cache Storage until the user
// removes them.
//
// Pure helpers only (no React, no WebLLM), so tests run them in Node.

import { isReleased } from "./lib.js";
import { vaultChat } from "./device-vault.js";

export const ondeviceReleased = (config) => isReleased(config, "ondevice");
// The workspace mode (/workspace/device) and its update id.
export const DEVICE_MODE = "device";

// ---- The models ----
// Pinned sources: a fixed Hugging Face commit per model and a fixed commit of
// MLC's prebuilt WebGPU libraries, so the files can't change under us. The
// config, tokenizer and library (the only executable part) are also checked
// against these SHA-256 hashes by WebLLM before use (ModelIntegrity); a
// mismatch stops the load. Hashes were taken from the files at these commits.
export const HF_BASE = "https://huggingface.co/mlc-ai/";
export const LIB_BASE =
  "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/";
// WebLLM's prebuilt libraries for these models are compiled for 4k tokens.
export const CONTEXT_WINDOW = 4096;
// The longest reply, and room kept for the chat template's own tokens.
export const REPLY_TOKENS = 1024;
export const TEMPLATE_TOKENS = 160;
// The longest single message the composer takes.
export const MAX_PROMPT_CHARS = 6000;
// The Cache Storage buckets WebLLM's "cache" backend uses.
export const CACHES = { model: "webllm/model", config: "webllm/config", wasm: "webllm/wasm" };

const TOKENIZER_LLAMA = "sha256-eePlImNfMXEwCRO7QhRkqH3mIiGCoFcLmyzLoqlksrQ=";
const TOKENIZER_QWEN = "sha256-wDghF+oynN8JcEETL21zWSS2l5JNb2/DlFcT6WzodTk=";

// Each model has two builds of the same 4-bit weights: f16 for GPUs with the
// WebGPU "shader-f16" feature (most recent ones), f32 for the rest. The
// download is the same size either way.
export const ONDEVICE_MODELS = [
  {
    key: "llama-3.2-1b",
    name: "Llama 3.2 1B",
    maker: "Meta",
    licence: "Llama 3.2 Community License",
    note: "Fastest. Quick questions, rewrites and short drafts.",
    shards: 22,
    variants: {
      f16: {
        id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
        rev: "2a37b0a5ecb622d51ddc2fac74de0b95872affd7",
        lib: "Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm",
        bytes: 709718801,
        vramMB: 879,
        integrity: {
          config: "sha256-DsUTtUtBmtRxAGQwaGvc/6rnECtB97Akb7/N4lF6zH8=",
          model_lib: "sha256-Kqm18MjeUy9sv2u3uGOqoCZFv2//hWCDsgL5aHEtP5I=",
          tokenizer: TOKENIZER_LLAMA,
        },
      },
      f32: {
        id: "Llama-3.2-1B-Instruct-q4f32_1-MLC",
        rev: "a949835e0f9a65335bd834db02a44cf8fae34020",
        lib: "Llama-3.2-1B-Instruct-q4f32_1_cs1k-webgpu.wasm",
        bytes: 709601094,
        vramMB: 1129,
        integrity: {
          config: "sha256-BGVh5aSNDJJrH8pWNyDFNIe1kUn+lYoYmo7mwI4O7zQ=",
          model_lib: "sha256-oUB0BMuFt9vG20vXdWkpHwLatQqusdxZWxdZXC4gTGY=",
          tokenizer: TOKENIZER_LLAMA,
        },
      },
    },
  },
  {
    key: "qwen-2.5-1.5b",
    name: "Qwen 2.5 1.5B",
    maker: "Qwen (Alibaba)",
    licence: "Apache 2.0",
    note: "Balanced. Better at reasoning, and at Chinese and other languages.",
    shards: 30,
    variants: {
      f16: {
        id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
        rev: "9bd564b064631febf14deadcac492efb761d60c3",
        lib: "Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
        bytes: 880931543,
        vramMB: 1630,
        integrity: {
          config: "sha256-faSVQhLT8hqRzD5pPRefYyE/1XNWeWhH9l1/lUeKH54=",
          model_lib: "sha256-D861C7r0fv3DH86WtywRXct/UiHIWr5qn8At2p0db8M=",
          tokenizer: TOKENIZER_QWEN,
        },
      },
      f32: {
        id: "Qwen2.5-1.5B-Instruct-q4f32_1-MLC",
        rev: "a822ee410075710c9673005eafa017b90136b85d",
        lib: "Qwen2-1.5B-Instruct-q4f32_1_cs1k-webgpu.wasm",
        bytes: 880812244,
        vramMB: 1889,
        integrity: {
          config: "sha256-AJeMU16DrFeX+j5uHRBpf5X0+NCje99j60OCBArbLPc=",
          model_lib: "sha256-fBjiCSn2oRRfmFxL3PnOi+7GfyRFyRs2HIQtMjdYBg0=",
          tokenizer: TOKENIZER_QWEN,
        },
      },
    },
  },
  {
    key: "llama-3.2-3b",
    name: "Llama 3.2 3B",
    maker: "Meta",
    licence: "Llama 3.2 Community License",
    note: "The most capable of the three. Slower, and needs more memory.",
    shards: 58,
    variants: {
      f16: {
        id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
        rev: "1e80abf71e3d17cd564e2d2b63caa15cb226018e",
        lib: "Llama-3.2-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
        bytes: 1822589797,
        vramMB: 2264,
        integrity: {
          config: "sha256-ELIxjYcTIMpmyGt6RMtETOp2d+B4obFH1OBkaViofb4=",
          model_lib: "sha256-ecwvN5TjLZYRZ1ECqR1q0cjoacHVw/fo+NJlZNLyjvs=",
          tokenizer: TOKENIZER_LLAMA,
        },
      },
      f32: {
        id: "Llama-3.2-3B-Instruct-q4f32_1-MLC",
        rev: "6083cfdaaf08d2dd4872d7f5b87fb0242aa7d75c",
        lib: "Llama-3.2-3B-Instruct-q4f32_1_cs1k-webgpu.wasm",
        bytes: 1822389507,
        vramMB: 2952,
        integrity: {
          config: "sha256-wnLypNTZn34QjdyLsgfOCergrr/HfStyrWO4FuWwfPc=",
          model_lib: "sha256-+sXyMDwXDYk2/+8CSYuPZFsX6Y9L6Dz+LQgepzBND2c=",
          tokenizer: TOKENIZER_LLAMA,
        },
      },
    },
  },
];
export const DEFAULT_MODEL = ONDEVICE_MODELS[0].key;
export const modelByKey = (key) => ONDEVICE_MODELS.find((m) => m.key === key) || null;

// The build this device runs: f16 where the GPU has shader-f16.
export const variantFor = (model, gpu) => (gpu?.f16 ? model.variants.f16 : model.variants.f32);

// Where a build's files live, exactly as WebLLM keys them in Cache Storage.
export function modelFiles(model, variant) {
  const base = `${HF_BASE}${variant.id}/resolve/${variant.rev}/`;
  const shards = Array.from({ length: model.shards }, (_, i) => `${base}params_shard_${i}.bin`);
  return {
    base,
    config: base + "mlc-chat-config.json",
    tokenizer: base + "tokenizer.json",
    tensors: base + "tensor-cache.json",
    shards,
    lib: LIB_BASE + variant.lib,
    // Every file a complete download holds, by cache.
    expected: [
      ...[base + "tensor-cache.json", base + "tokenizer.json", ...shards].map((url) => ({ cache: CACHES.model, url })),
      { cache: CACHES.config, url: base + "mlc-chat-config.json" },
      { cache: CACHES.wasm, url: LIB_BASE + variant.lib },
    ],
  };
}

// WebLLM's model record for a build: the pinned URLs, the 4k context the
// library was compiled for, the GPU feature it needs and the hashes.
export function modelRecord(model, variant) {
  const files = modelFiles(model, variant);
  return {
    model: files.base,
    model_id: variant.id,
    model_lib: files.lib,
    vram_required_MB: variant.vramMB,
    low_resource_required: true,
    overrides: { context_window_size: CONTEXT_WINDOW },
    ...(variant === model.variants.f16 ? { required_features: ["shader-f16"] } : {}),
    integrity: {
      config: variant.integrity.config,
      model_lib: variant.integrity.model_lib,
      tokenizer: { "tokenizer.json": variant.integrity.tokenizer },
      onFailure: "error",
    },
  };
}
// The only models WebLLM may load here: ours, for this device's GPU.
export const appConfigFor = (gpu) => ({
  cacheBackend: "cache",
  model_list: ONDEVICE_MODELS.map((m) => modelRecord(m, variantFor(m, gpu))),
});

// ---- WebGPU ----
// The same minimums WebLLM asks for when it opens the GPU (256 MB buffers,
// 128 MB storage bindings). `nav` is navigator, or a stand-in in tests.
export const MIN_BUFFER = 1 << 28;
export const MIN_STORAGE_BINDING = 1 << 27;
export async function detectWebGPU(nav = globalThis.navigator) {
  if (!nav?.gpu || typeof nav.gpu.requestAdapter !== "function") return { ok: false, reason: "no-webgpu" };
  let adapter;
  try {
    adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch {
    return { ok: false, reason: "no-adapter" };
  }
  if (!adapter) return { ok: false, reason: "no-adapter" };
  const limits = adapter.limits || {};
  if ((limits.maxBufferSize || 0) < MIN_BUFFER || (limits.maxStorageBufferBindingSize || 0) < MIN_STORAGE_BINDING)
    return { ok: false, reason: "too-small" };
  const f16 = !!adapter.features?.has?.("shader-f16");
  const info = adapter.info || {};
  return { ok: true, f16, vendor: typeof info.vendor === "string" ? info.vendor : "" };
}
// What each failed check tells the user.
export const SUPPORT_REASONS = {
  "no-webgpu": "This browser doesn't have WebGPU, which the on-device model needs.",
  "no-adapter": "This browser has WebGPU, but it couldn't find a graphics processor it can use.",
  "too-small": "This device's graphics processor is too limited for these models.",
};
export const SUPPORT_WORKS = [
  "Chrome or Edge 113 and later on Windows, macOS and ChromeOS",
  "Chrome on recent Android phones",
  "Safari where WebGPU is turned on (Safari 26 and later)",
];

// ---- Storage ----
// What a model uses in this browser's Cache Storage: every entry under its
// Hugging Face folders (any build, any revision) and its libraries, summed
// from the stored responses' Content-Length (read from the headers only, so
// nothing big is loaded). `complete` is true when this device's build has
// every file. `cachesApi` is window.caches, or a stand-in in tests.
const belongs = (model, url) =>
  Object.values(model.variants).some(
    (v) => url.startsWith(`${HF_BASE}${v.id}/`) || url.endsWith("/" + v.lib),
  );
async function entriesFor(model, cachesApi) {
  const out = [];
  if (!cachesApi) return out;
  for (const name of Object.values(CACHES)) {
    if (typeof cachesApi.has === "function" && !(await cachesApi.has(name))) continue;
    const cache = await cachesApi.open(name);
    for (const req of await cache.keys()) {
      const url = typeof req === "string" ? req : req.url;
      if (belongs(model, url)) out.push({ cache: name, url, store: cache });
    }
  }
  return out;
}
export async function modelStorage(model, variant, cachesApi = globalThis.caches) {
  const entries = await entriesFor(model, cachesApi);
  let bytes = 0;
  for (const e of entries) {
    const res = await e.store.match(e.url);
    const n = Number(res?.headers?.get?.("content-length"));
    if (Number.isFinite(n) && n > 0) bytes += n;
  }
  const have = new Set(entries.map((e) => e.cache + " " + e.url));
  const expected = modelFiles(model, variant).expected;
  const present = expected.filter((f) => have.has(f.cache + " " + f.url)).length;
  const complete = present === expected.length;
  return {
    // A compressed response's Content-Length is its compressed size, so a
    // complete build counts at least its known download size.
    bytes: complete ? Math.max(bytes, variant.bytes) : bytes,
    files: entries.length,
    complete,
    // Some files but not all: an interrupted download, resumed next time.
    partial: entries.length > 0 && present < expected.length,
  };
}
// Deletes every file of a model (both builds, any revision) from this
// browser. Returns how many entries were removed.
export async function removeModelFiles(model, cachesApi = globalThis.caches) {
  const entries = await entriesFor(model, cachesApi);
  let removed = 0;
  for (const e of entries) if (await e.store.delete(e.url)) removed++;
  return removed;
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)} GB`;
  if (v >= 1e6) return `${Math.round(v / 1e6)} MB`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} KB`;
  return `${v} bytes`;
}

// ---- Loading progress ----
// WebLLM reports loading as { progress: 0..1, text }. Its text says whether
// it's fetching the weights from the network ("Fetching param cache[3/22]…")
// or reading this device's copy onto the GPU ("Loading model from cache…").
export function progressState(report, bytes = 0) {
  const text = String(report?.text || "");
  const fraction = Math.max(0, Math.min(1, Number(report?.progress) || 0));
  if (/^Finish loading/i.test(text)) return { phase: "ready", fraction: 1 };
  if (/^Fetching param cache/i.test(text))
    return { phase: "download", fraction, done: Math.round(fraction * bytes) };
  if (/^Loading model from cache/i.test(text)) return { phase: "load", fraction };
  return { phase: "prepare", fraction: 0 };
}

// ---- Chatting ----
export const SYSTEM_PROMPT =
  "You are a helpful assistant running entirely on the user's own device. " +
  "You have no internet access and can't see files. Answer clearly and concisely, " +
  "and say so when you are unsure.";
// A rough token count: about 3.5 characters per token for English, and one
// per character for Chinese, Japanese and Korean, so estimates run high.
export function estimateTokens(text) {
  const s = String(text || "");
  const wide = (s.match(/[⺀-鿿가-힯豈-﫿＀-￯]/g) || []).length;
  return Math.ceil((s.length - wide) / 3.5) + wide + 4;
}
// The most recent messages that fit the model's window with room for the
// reply. The newest user message is always kept (the composer caps it).
export function fitHistory(messages, budget = CONTEXT_WINDOW - REPLY_TOKENS - TEMPLATE_TOKENS - estimateTokens(SYSTEM_PROMPT)) {
  const kept = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateTokens(messages[i].content);
    if (kept.length && used + cost > budget) break;
    kept.unshift(messages[i]);
    used += cost;
  }
  // A thread never starts with a reply.
  while (kept.length > 1 && kept[0].role !== "user") kept.shift();
  return { messages: kept, dropped: messages.length - kept.length };
}
// The request WebLLM gets: its OpenAI-style chat completion, streamed. Only
// the role and text of each message: nothing else from the thread.
export function buildLocalRequest(thread) {
  const history = thread
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
    .map((m) => ({ role: m.role, content: m.content }));
  const { messages, dropped } = fitHistory(history);
  return {
    dropped,
    request: {
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: REPLY_TOKENS,
      temperature: 0.7,
    },
  };
}
// Streams one reply from the engine (WebLLM's WebWorkerMLCEngine, or a stub
// in tests), calling onDelta with the text so far. Never uses fetch.
export async function streamLocalReply({ engine, request, onDelta = () => {} }) {
  const stream = await engine.chat.completions.create(request);
  let text = "",
    finishReason = null,
    usage = null;
  for await (const chunk of stream) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta) {
      text += delta;
      onDelta(text);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk?.usage) usage = chunk.usage;
  }
  const tps = Number(usage?.extra?.decode_tokens_per_s);
  return {
    text,
    finishReason,
    tokens: Number(usage?.completion_tokens) || null,
    tokensPerSecond: Number.isFinite(tps) && tps > 0 ? Math.round(tps) : null,
  };
}

// Plain messages for what can go wrong, never the engine's raw text alone.
// The worker reports errors as text ("IntegrityError: …"), so match on both.
export function friendlyError(err, phase = "reply") {
  const t = `${err?.name || ""} ${err?.message || (typeof err === "string" ? err : "")}`;
  if (/IntegrityError|integrity/i.test(t))
    return "A downloaded file didn't match its expected fingerprint, so it wasn't used. Remove the model and try again.";
  if (/QuotaExceeded|quota|not enough space/i.test(t))
    return "There isn't enough storage space on this device for this model. Free some space or pick a smaller model.";
  if (/ShaderF16|shader-f16/i.test(t))
    return "This device's graphics processor can't run this build. Reload the page to try again.";
  if (/ContextWindowSizeExceeded|context window/i.test(t))
    return "This chat is too long for the on-device model. Start a new chat.";
  if (/out of memory|DeviceLost|device (was )?lost/i.test(t))
    return "The graphics processor ran out of memory or stopped. Try a smaller model, close other tabs, or reload the page.";
  if (/WorkerError/.test(t)) return "The on-device engine couldn't run in this browser. Reload the page and try again.";
  if (phase === "load" && /fetch|network|load failed/i.test(t))
    return "The download stopped. Check your connection and try again; the parts already downloaded are kept.";
  return phase === "load"
    ? "The model couldn't start on this device. Reload the page and try again, or pick a smaller model."
    : "The on-device model stopped before finishing. Try again, or start a new chat.";
}

// ---- Device Vault ----
// An on-device chat kept in Device Vault: the same sealed record as a
// device-only chat, marked as this mode so it reopens here (and is never sent
// to a server model), with the on-device model it used.
export function deviceVaultChat({ id, model, messages, created, now = Date.now() }) {
  const kept = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.role === "assistant" && m.local ? { local: m.local } : {}),
    }));
  return { ...vaultChat({ id, mode: DEVICE_MODE, messages: kept, created, now }), model: modelByKey(model)?.key || DEFAULT_MODEL };
}
