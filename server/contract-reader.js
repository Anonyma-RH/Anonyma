import { getAddress, id } from "ethers";
import { uid, fail, wantsWebSearch } from "./core.js";
import { chatLimits, contextEstimate } from "../data/chat-limits.js";
import { ALLOWED_HOSTS, SOURCES, UpstreamError, clip, fetchJson, rpcBatch, rpcTokenMeta, units } from "./onchain.js";
import { chainById } from "../src/onchain.js";
import { cleanText, findPhrases, projectVisible, scanInvisible } from "../src/shield.js";
import {
  BEACON_IMPLEMENTATION,
  CONTRACT_READER,
  EIP1967,
  ROLE_MEMBER,
  ROLE_MEMBER_COUNT,
  STANDARD_READS,
  cleanSourcePath,
  cloneTarget,
  codeLines,
  contractMessages,
  contractProblem,
  functionIndex,
  hasCode,
  isDelegatedWallet,
  orderFiles,
  pickSent,
  pushSelectors,
  scanBytecode,
} from "../src/contract-reader.js";

// Contract Reader (update "contractreader"): the facts about one contract,
// read by ANONYMA's server so the user's IP never reaches Sourcify, the
// explorer or the node. Built on Onchain Explainer's fetcher
// (server/onchain.js): sources are fixed in code, no host, URL or path a user
// sent is ever fetched (a URL is built only from a validated chain id and
// 0x address), redirects are never followed, responses must be JSON and
// arrive within 8 seconds, and addresses are never logged.
//
// - Code, the EIP-1967 proxy slots and the standard reads (owner(),
//   paused(), totalSupply() and so on) come from one JSON-RPC batch: the
//   public node for Robinhood Chain, each other chain's Blockscout eth-rpc
//   endpoint. When that endpoint doesn't answer, live reads are skipped and
//   the facts say so.
// - Verified source comes from Sourcify's v2 API first, then the chain's
//   Blockscout (not for Robinhood Chain, whose Blockscout answers servers
//   with a browser challenge). A proxy's implementation is followed one hop
//   (EIP-1967 slots, a beacon, an EIP-1167 clone, or Sourcify's own proxy
//   detection), and its source is what's read.
// - Unverified code: what its bytecode's PUSH4 selectors match in a small
//   built-in table (src/contract-reader.js). No 4byte or other lookup.
// - Source text is public, but it's someone else's text: Injection Shield
//   removes invisible characters and flags files that read like
//   instructions; it goes to the model only as data.
// Read only: nothing here signs, sends or connects a wallet.
export const SOURCIFY_URL = "https://sourcify.dev/server/v2/contract";
export const CONTRACT_HOSTS = new Set([...ALLOWED_HOSTS, new URL(SOURCIFY_URL).host]);
export const rpcUrl = (chainId) =>
  SOURCES[chainId].type === "rpc" ? SOURCES[chainId].url : SOURCES[chainId].url + "/api/eth-rpc";
const ZERO = "0x0000000000000000000000000000000000000000";

export class ContractError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---- Words -----------------------------------------------------------------
const word = (hex) => (typeof hex === "string" && /^0x[0-9a-fA-F]{64}/.test(hex) ? hex.slice(2, 66) : null);
const checksum = (a) => {
  try {
    return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) ? getAddress(a.toLowerCase()) : null;
  } catch {
    return null;
  }
};
export const addressWord = (hex) => {
  const w = word(hex);
  return w && /^0{24}/.test(w) ? checksum("0x" + w.slice(24)) : null;
};
const boolWord = (hex) => {
  const w = word(hex);
  if (!w || (typeof hex === "string" && hex.length !== 66)) return null;
  const v = BigInt("0x" + w);
  return v === 0n ? false : v === 1n ? true : null;
};
const uintWord = (hex) => {
  const w = word(hex);
  return w ? BigInt("0x" + w) : null;
};
// A storage slot holding an address, or null when it's empty.
const slotAddress = (hex) => {
  const a = addressWord(hex);
  return a && a !== ZERO ? a : null;
};
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

// ---- ABI --------------------------------------------------------------------
const TYPE = /^[a-z0-9_[\]()]+$/i;
function signatureOf(item) {
  if (item?.type !== "function" || typeof item.name !== "string" || !/^[A-Za-z_$][\w$]*$/.test(item.name)) return null;
  const types = (Array.isArray(item.inputs) ? item.inputs : []).map(canonical);
  if (types.some((t) => !t)) return null;
  return `${item.name}(${types.join(",")})`;
}
function canonical(input) {
  if (typeof input?.type !== "string" || !TYPE.test(input.type)) return null;
  if (input.type.startsWith("tuple")) {
    const inner = (input.components || []).map(canonical);
    if (inner.some((t) => !t)) return null;
    return `(${inner.join(",")})${input.type.slice(5)}`;
  }
  return input.type;
}
// The 4-byte selectors of an ABI's functions.
export function abiSelectors(abi) {
  const out = new Set();
  for (const item of Array.isArray(abi) ? abi : []) {
    const sig = signatureOf(item);
    if (sig) out.add(id(sig).slice(0, 10));
  }
  return out;
}
// Getters worth a live read: no inputs, one address back, named like a
// role (supplyController(), pauser(), governor() …). The standard reads
// are asked anyway, so they're left out here.
const ROLE_NAME = /(owner|admin|minter|pauser|blacklist|blocklist|freezer|controller|guardian|governor|governance|operator|rescuer|manager|timelock|keeper|protect)/i;
const DEPRECATED = /deprecated|legacy/i;
const STANDARD_NAMES = new Set(STANDARD_READS.map(([, name]) => name));
export function roleGetters(abi, max = 6) {
  const out = [];
  for (const item of Array.isArray(abi) ? abi : []) {
    if (item?.type !== "function" || (item.inputs || []).length) continue;
    if (!["view", "pure"].includes(item.stateMutability) && item.constant !== true) continue;
    if ((item.outputs || []).length !== 1 || item.outputs[0]?.type !== "address") continue;
    if (!ROLE_NAME.test(item.name || "") || DEPRECATED.test(item.name) || STANDARD_NAMES.has(item.name)) continue;
    const sig = signatureOf(item);
    if (sig && !out.some((g) => g.name === item.name)) out.push({ name: item.name, selector: id(sig).slice(0, 10) });
    if (out.length >= max) break;
  }
  return out;
}

// ---- Source files -------------------------------------------------------------
// Verified files as the page and the model see them: paths checked, CRLF
// and a BOM removed, Injection Shield's invisible characters taken out, and
// files that read like instructions to an AI flagged. At most maxFiles and
// maxSourceChars, keeping the main contract and what it inherits from first.
export function cleanSources(raw, main = {}) {
  const seen = new Set();
  let hidden = 0;
  const files = [];
  for (const f of Array.isArray(raw) ? raw : []) {
    const path = cleanSourcePath(f?.path);
    if (!path || seen.has(path) || typeof f?.text !== "string") continue;
    seen.add(path);
    let text = f.text.replace(/\r\n?/g, "\n");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const invisible = scanInvisible(text);
    if (invisible.total) {
      hidden += invisible.total;
      text = cleanText(text, { text, invisible });
    }
    files.push({ path, text });
  }
  const mainPath = cleanSourcePath(main.path);
  const { order, main: first, inherited } = orderFiles(files, { path: mainPath, name: main.name });
  const byPath = new Map(files.map((f) => [f.path, f]));
  // Within the caps, the main contract and everything it inherits from are
  // kept first; the kept files stay in reading order.
  const keep = new Set();
  let chars = 0,
    trimmed = false;
  for (const path of [first, ...inherited, ...order]) {
    const f = byPath.get(path);
    if (!f || keep.has(path)) continue;
    if (keep.size >= CONTRACT_READER.maxFiles || chars + f.text.length > CONTRACT_READER.maxSourceChars) {
      trimmed = true;
      continue;
    }
    keep.add(path);
    chars += f.text.length;
  }
  const kept = [];
  for (const path of order.filter((p) => keep.has(p))) {
    const f = byPath.get(path);
    const lines = f.text.split("\n").length;
    kept.push({
      path,
      text: f.text,
      bytes: Buffer.byteLength(f.text),
      lines,
      main: path === first || undefined,
      flagged: findPhrases(projectVisible(f.text).visible).length > 0 || undefined,
    });
  }
  return { files: kept, order: kept.map((f) => f.path), main: first, trimmed, hidden, chars };
}

// ---- Reading one contract -------------------------------------------------------
export function createContractReader({ fetch: fetchImpl = globalThis.fetch } = {}) {
  const get = (url) => fetchJson(fetchImpl, url, { hosts: CONTRACT_HOSTS, maxBytes: CONTRACT_READER.maxResponseBytes });
  const rpc = (chainId, calls) => rpcBatch(fetchImpl, rpcUrl(chainId), calls);

  async function sourcify(chainId, address) {
    const r = await get(`${SOURCIFY_URL}/${chainId}/${address}?fields=sources,abi,proxyResolution,compilation`);
    if (!r || typeof r !== "object" || !r.sources || typeof r.sources !== "object") return null;
    const fq = typeof r.compilation?.fullyQualifiedName === "string" ? r.compilation.fullyQualifiedName : "";
    const cut = fq.lastIndexOf(":");
    const impls = r.proxyResolution?.isProxy
      ? (Array.isArray(r.proxyResolution.implementations) ? r.proxyResolution.implementations : [])
          .map((i) => checksum(i?.address))
          .filter(Boolean)
      : [];
    return {
      via: "Sourcify",
      match: r.match === "exact_match" ? "exact" : r.match === "match" ? "partial" : undefined,
      name: clip(r.compilation?.name, 80),
      compiler: clip(r.compilation?.compilerVersion, 60),
      mainPath: cut > 0 ? fq.slice(0, cut) : null,
      raw: Object.entries(r.sources).map(([path, v]) => ({ path, text: v?.content })),
      abi: Array.isArray(r.abi) ? r.abi : [],
      proxyType: impls.length ? clip(r.proxyResolution.proxyType, 40) : undefined,
      proxyTargets: impls,
    };
  }
  async function blockscout(chainId, address) {
    if (SOURCES[chainId].type !== "blockscout") return null;
    const r = await get(`${SOURCES[chainId].url}/api/v2/smart-contracts/${address}`);
    if (!r || typeof r !== "object" || r.is_verified !== true || typeof r.source_code !== "string") return null;
    const name = clip(r.name, 80);
    const ext = /vyper/i.test(r.language || "") ? ".vy" : ".sol";
    const mainPath = cleanSourcePath(r.file_path) || (name && /^[\w$-]+$/.test(name) ? name + ext : "Contract" + ext);
    return {
      via: "Blockscout",
      match: r.is_fully_verified === true ? "exact" : r.is_partially_verified === true ? "partial" : undefined,
      name,
      compiler: clip(r.compiler_version, 60),
      mainPath,
      raw: [
        { path: mainPath, text: r.source_code },
        ...(Array.isArray(r.additional_sources) ? r.additional_sources : []).map((s) => ({ path: s?.file_path, text: s?.source_code })),
      ],
      abi: Array.isArray(r.abi) ? r.abi : [],
      // Blockscout's own proxy detection, used only when the slots couldn't
      // be read live.
      proxyType: clip(r.proxy_type, 40),
      proxyTargets: (Array.isArray(r.implementations) ? r.implementations : [])
        .map((i) => checksum(i?.address_hash || i?.address))
        .filter(Boolean),
    };
  }
  // Sourcify first, then Blockscout. `failed` when a source didn't answer
  // (so "unverified" isn't claimed from a failure).
  async function sourceFor(chainId, address) {
    let failed = false;
    for (const find of [sourcify, blockscout]) {
      try {
        const found = await find(chainId, address);
        if (found) return { found, failed };
      } catch (e) {
        if (!(e instanceof UpstreamError)) throw e;
        failed = true;
      }
    }
    return { found: null, failed };
  }

  async function read({ chain: chainId, address }) {
    const chain = chainById(chainId);
    const target = checksum(address);
    if (!chain || !SOURCES[chainId] || !target) throw new ContractError(400, "Choose one of the listed chains.", "contract_chain");
    const notes = [];
    // 1. Code, proxy slots and the standard reads: one batch.
    let first = null;
    try {
      first = await rpc(chainId, [
        ["eth_getCode", [address, "latest"]],
        ["eth_getStorageAt", [address, EIP1967.implementation, "latest"]],
        ["eth_getStorageAt", [address, EIP1967.admin, "latest"]],
        ["eth_getStorageAt", [address, EIP1967.beacon, "latest"]],
        ...STANDARD_READS.map(([selector]) => ["eth_call", [{ to: address, data: selector }, "latest"]]),
      ]);
    } catch (e) {
      if (!(e instanceof UpstreamError)) throw e;
      if (SOURCES[chainId].type === "rpc") throw new ContractError(502, `${chain.name} couldn't be reached. Nothing was charged; try again in a minute.`, "contract_unavailable");
      notes.push("no_live_reads");
    }
    const code = first && !first[0].error ? first[0].result : null;
    if (first && first[0].error) notes.push("no_live_reads");
    if (typeof code === "string" && !hasCode(code))
      throw new ContractError(
        404,
        isDelegatedWallet(code)
          ? `This address is a wallet on ${chain.name}, not a contract.`
          : `There's no contract at this address on ${chain.name}. It's a wallet, or nothing was deployed there.`,
        "contract_not_found",
      );
    const slot = (i) => (first && !first[i].error ? slotAddress(first[i].result) : null);
    let implementation = slot(1),
      admin = slot(2),
      beacon = slot(3),
      proxyKind = implementation ? "EIP-1967" : null;
    const clone = cloneTarget(code);
    if (!implementation && clone) {
      implementation = checksum(clone);
      proxyKind = "EIP-1167 clone";
    }
    if (!implementation && beacon) {
      try {
        const [r] = await rpc(chainId, [["eth_call", [{ to: beacon, data: BEACON_IMPLEMENTATION }, "latest"]]]);
        implementation = r.error ? null : slotAddress(r.result);
      } catch (e) {
        if (!(e instanceof UpstreamError)) throw e;
      }
      proxyKind = "EIP-1967 beacon";
    }
    // 2. The contract's own source (not needed once the slots or its code
    // name an implementation), then, one hop, its implementation's.
    const own = implementation ? { found: null, failed: false } : await sourceFor(chainId, address);
    if (!implementation && own.found?.proxyTargets?.length) {
      implementation = own.found.proxyTargets[0];
      proxyKind = `${own.found.via}${own.found.proxyType ? ": " + own.found.proxyType : ""}`;
    }
    if (implementation && implementation.toLowerCase() === address) implementation = null;
    const impl = implementation ? await sourceFor(chainId, implementation.toLowerCase()) : { found: null, failed: false };
    const logic = implementation ? impl.found : own.found;
    if (!first && !own.found && !impl.found)
      throw new ContractError(502, `${chain.name}'s explorer couldn't be read right now, and nothing verified was found. Nothing was charged; try again in a minute.`, "contract_unavailable");
    if (own.failed || impl.failed) notes.push("source_unavailable");

    // 3. Implementation code (when its source isn't verified), role getters,
    // role members and the upgrade admin's owner: one more batch.
    const logicAbi = logic?.abi || [];
    const getters = roleGetters(logicAbi);
    const abiSel = abiSelectors(logicAbi);
    const enumerable = abiSel.has(ROLE_MEMBER_COUNT) && abiSel.has(ROLE_MEMBER);
    const second = [];
    if (implementation && !impl.found) second.push(["impl_code", ["eth_getCode", [implementation.toLowerCase(), "latest"]]]);
    for (const g of getters) second.push(["getter:" + g.name, ["eth_call", [{ to: address, data: g.selector }, "latest"]]]);
    if (enumerable) {
      second.push(["members", ["eth_call", [{ to: address, data: ROLE_MEMBER_COUNT + "0".repeat(64) }, "latest"]]]);
      for (let i = 0; i < 3; i++)
        second.push(["member:" + i, ["eth_call", [{ to: address, data: ROLE_MEMBER + "0".repeat(64) + i.toString(16).padStart(64, "0") }, "latest"]]]);
    }
    if (admin) second.push(["admin_owner", ["eth_call", [{ to: admin.toLowerCase(), data: "0x8da5cb5b" }, "latest"]]]);
    const results = new Map();
    const batch = async (list) => {
      if (!list.length || !first) return;
      try {
        const out = await rpc(chainId, list.map(([, call]) => call));
        list.forEach(([key], i) => !out[i].error && results.set(key, out[i].result));
      } catch (e) {
        if (!(e instanceof UpstreamError)) throw e;
        if (!notes.includes("reads_incomplete")) notes.push("reads_incomplete");
      }
    };
    await batch(second);

    // Which functions the logic has: its ABI, or its bytecode's selectors.
    const implCode = results.get("impl_code");
    const logicCode = implementation ? implCode : code;
    const exposed = logic ? abiSel : pushSelectors(logicCode || "");
    const readOf = (i) => (first && !first[4 + i].error ? first[4 + i].result : null);
    const reads = {};
    STANDARD_READS.forEach(([selector, name, type], i) => {
      if (!exposed.has(selector)) return;
      const raw = readOf(i);
      if (raw == null) return;
      if (type === "string") return;
      const value = type === "address" ? addressWord(raw) : type === "bool" ? boolWord(raw) : uintWord(raw);
      if (value !== null && value !== undefined) reads[name] = value;
    });
    const tokenMeta = exposed.has("0x95d89b41") && exposed.has("0x313ce567") ? rpcTokenMeta(readOf(6), readOf(5), readOf(7)) : null;
    const token = tokenMeta
      ? compact({
          name: tokenMeta.name,
          symbol: tokenMeta.symbol,
          decimals: tokenMeta.decimals,
          supply: typeof reads.totalSupply === "bigint" ? units(reads.totalSupply, tokenMeta.decimals) : undefined,
        })
      : null;

    // 4. Who controls it, from the live reads.
    const control = [];
    const owner = reads.owner ?? reads.getOwner ?? null;
    if (owner) control.push({ role: "owner", address: owner, via: reads.owner ? "owner()" : "getOwner()" });
    if (reads.pendingOwner && reads.pendingOwner !== ZERO) control.push({ role: "pending_owner", address: reads.pendingOwner, via: "pendingOwner()" });
    if (reads.defaultAdmin && reads.defaultAdmin !== owner) control.push({ role: "default_admin", address: reads.defaultAdmin, via: "defaultAdmin()" });
    if (admin) control.push({ role: "upgrade_admin", address: admin, via: "EIP-1967 admin slot" });
    const adminOwner = addressWord(results.get("admin_owner"));
    if (admin && adminOwner && adminOwner !== ZERO) control.push({ role: "admin_owner", address: adminOwner, via: "owner()" });
    if (beacon) control.push({ role: "beacon", address: beacon, via: "EIP-1967 beacon slot" });
    // A role getter that returns the zero address holds nothing (often a
    // deprecated slot), so it isn't listed.
    for (const g of getters) {
      const a = addressWord(results.get("getter:" + g.name));
      if (a && a !== ZERO) control.push({ role: "role", name: g.name, address: a, via: g.name + "()" });
    }
    const count = uintWord(results.get("members"));
    if (enumerable && count !== null) {
      const members = [0, 1, 2].map((i) => addressWord(results.get("member:" + i))).filter((a) => a && a !== ZERO);
      control.push({ role: "role_admins", count: Number(count > 999n ? 999n : count), members, via: "getRoleMember(DEFAULT_ADMIN_ROLE)" });
    }
    // Wallet or contract, for every address named above.
    const parties = [...new Set(control.flatMap((c) => [c.address, ...(c.members || [])]).filter((a) => a && a !== ZERO))].slice(0, 8);
    await batch(parties.map((a) => ["code:" + a, ["eth_getCode", [a.toLowerCase(), "latest"]]]));
    const typeOf = (a) => {
      if (!a) return undefined;
      if (a === ZERO) return "none";
      const c = results.get("code:" + a);
      return typeof c === "string" ? (hasCode(c) ? "contract" : "wallet") : undefined;
    };
    for (const c of control) {
      if (c.address) {
        const t = typeOf(c.address);
        if (t) c.type = t;
        if (c.address === ZERO && (c.role === "owner" || c.role === "default_admin")) c.renounced = true;
      }
      if (c.members) c.member_types = c.members.map(typeOf);
    }

    // 5. The source the reading uses, or the bytecode's functions.
    const cleaned = logic ? cleanSources(logic.raw, { path: logic.mainPath, name: logic.name }) : null;
    if (cleaned?.trimmed) notes.push("sources_trimmed");
    if (implementation) notes.push("proxy_source_skipped");
    const bytecode = !logic && logicCode ? scanBytecode(logicCode) : null;
    const checks = [];
    if (!logic) checks.push({ code: implementation ? "implementation_unverified" : "unverified" });
    if (proxyKind && proxyKind !== "EIP-1167 clone") checks.push({ code: "upgradeable" });
    if (reads.paused === true) checks.push({ code: "paused" });
    const ownerRow = control.find((c) => c.role === "owner");
    if (ownerRow?.type === "wallet") checks.push({ code: "wallet_owner" });
    const upgrader = control.find((c) => c.role === "admin_owner") || control.find((c) => c.role === "upgrade_admin");
    if (upgrader?.type === "wallet") checks.push({ code: "wallet_admin" });
    if (bytecode) for (const g of [...new Set(bytecode.functions.map((f) => f.group))]) checks.push({ code: "group", group: g });

    const facts = compact({
      kind: "contract",
      chain: { id: chain.id, name: chain.name },
      address: target,
      name: logic?.name || token?.name || undefined,
      token: token || undefined,
      code_size: typeof code === "string" ? Math.floor((code.length - 2) / 2) : undefined,
      verified: logic
        ? compact({ via: logic.via, match: logic.match, contract: logic.name, compiler: logic.compiler, files: cleaned.files.length })
        : undefined,
      unverified: logic ? undefined : true,
      proxy: proxyKind
        ? compact({
            kind: proxyKind,
            implementation: implementation || undefined,
            implementation_name: impl.found?.name,
            implementation_verified: implementation ? !!impl.found : undefined,
          })
        : undefined,
      paused: typeof reads.paused === "boolean" ? reads.paused : undefined,
      control,
      bytecode: bytecode
        ? { size: bytecode.size, selectors: bytecode.selectors, functions: bytecode.functions.map((f) => ({ signature: f.signature, group: f.group })) }
        : undefined,
      checks,
      notes: notes.length ? [...new Set(notes)] : undefined,
    });
    return { facts, files: cleaned?.files || [], main: cleaned?.main || null, hidden: cleaned?.hidden || 0 };
  }
  return { read };
}

// What goes to the model from a read: the files in order, within budget,
// and each sent file's function index for grounding citations.
export function sentFiles(entry) {
  const { sent, chars } = pickSent(entry.files, entry.files.map((f) => f.path));
  return {
    sent,
    chars,
    index: Object.fromEntries(sent.map((f) => [f.path, functionIndex(codeLines(entry.files.find((x) => x.path === f.path).text, f.path))])),
  };
}

// ---- The cache ------------------------------------------------------------------
// Reads live in this process's memory for 30 minutes, three per account;
// nothing is written to storage. Erase and the account export reach it.
export const CONTRACT_CACHE_BYTES = 96 * 1024 * 1024;
export function createContractCache({
  now = Date.now,
  ttlMs = CONTRACT_READER.ttlMinutes * 60000,
  perAccount = CONTRACT_READER.perAccount,
  maxBytes = CONTRACT_CACHE_BYTES,
} = {}) {
  const entries = new Map();
  const drop = (key) => {
    const e = entries.get(key);
    if (!e) return;
    clearTimeout(e.timer);
    entries.delete(key);
  };
  const sweep = () => {
    const t = now();
    for (const [key, e] of entries) if (e.expires <= t) drop(key);
  };
  const bytes = () => [...entries.values()].reduce((n, e) => n + e.bytes, 0);
  const idlest = (user) => {
    let pick = null;
    for (const e of entries.values()) if ((user == null || e.user === user) && (!pick || e.used < pick.used)) pick = e;
    return pick;
  };
  const touch = (e) => {
    if (e) e.used = now();
    return e;
  };
  return {
    put(user, data) {
      sweep();
      if (!(data.bytes <= maxBytes)) throw new ContractError(503, "Too many contracts are being read right now. Try again in a few minutes.", "contract_busy");
      for (const e of [...entries.values()]) if (e.user === user && e.key === data.key) drop(e.id);
      while ([...entries.values()].filter((e) => e.user === user).length >= perAccount) drop(idlest(user).id);
      while (entries.size && bytes() + data.bytes > maxBytes) drop(idlest().id);
      const created = now();
      const entry = { ...data, id: uid("ctr_"), user, created, used: created, expires: created + ttlMs };
      entry.timer = setTimeout(() => drop(entry.id), ttlMs);
      entry.timer.unref?.();
      entries.set(entry.id, entry);
      return entry;
    },
    get(user, key) {
      sweep();
      const e = typeof key === "string" ? entries.get(key) : null;
      return e && e.user === user ? touch(e) : null;
    },
    byKey(user, key) {
      sweep();
      for (const e of entries.values()) if (e.user === user && e.key === key) return touch(e);
      return null;
    },
    list(user) {
      sweep();
      return [...entries.values()].filter((e) => e.user === user).sort((a, b) => b.created - a.created);
    },
    forget(user, key) {
      const e = entries.get(key);
      if (!e || e.user !== user) return false;
      drop(key);
      return true;
    },
    forgetAll(user) {
      for (const e of [...entries.values()]) if (e.user === user) drop(e.id);
    },
    clear() {
      for (const key of [...entries.keys()]) drop(key);
    },
    get size() {
      sweep();
      return entries.size;
    },
  };
}
const caches = new WeakMap();
export function contractCacheFor(db, options) {
  if (!caches.has(db)) caches.set(db, createContractCache(options));
  return caches.get(db);
}
// Account closure and Panic Wipe (eraseAccountContent in routes/account.js).
export const forgetContracts = (db, user) => caches.get(db)?.forgetAll(user);
// Account export: the contracts being read right now (chain, address, name
// and times; the source is public and goes in 30 minutes anyway).
export const exportContracts = (db, user) =>
  (caches.get(db)?.list(user) || []).map((e) => ({
    chain: e.facts.chain.name,
    address: e.facts.address,
    name: e.facts.name || null,
    read: e.created,
    forgotten_at: e.expires,
  }));

// ---- The explanation, on /api/chat -----------------------------------------------
// Refused alongside a reading: every other built-message mode, options that
// add context or file it somewhere, and Seed Guard's override (nothing the
// person typed is sent: the address and public code only).
const REFUSED = [
  "auto",
  "conversationId",
  "project",
  "taskTool",
  "double_check",
  "treasury",
  "messages",
  "sheets",
  "study",
  "compare",
  "catchup",
  "canvas",
  "slides",
  "repo",
  "models",
  "depth",
  "question",
  "allow_seed_phrase",
  "veil_masked",
];
export const CONTRACT_GONE =
  "This contract was forgotten (30 minutes after it was read, or when you closed it). Read it again to explain it.";
// The checked `contract` payload of /api/chat or /api/quote: { id, lang }.
// The server builds the messages itself from the read it holds, so the
// facts and the source are exactly what it read. Returns the task, or
// undefined for a request without `contract`.
export function prepareContractRequest(req, cache) {
  const body = req.body;
  if (!body || body.contract === undefined) return;
  const refuse = (message) => fail(400, message, "invalid_contract");
  for (const key of REFUSED)
    if (body[key] !== undefined && body[key] !== null) refuse("A contract reading can't be combined with other chat options.");
  if (body.memory != null || wantsWebSearch(body)) refuse("A contract reading can't be combined with other chat options.");
  if (body.mode !== undefined && body.mode !== "chat") refuse("A contract reading can't be combined with other chat options.");
  const p = body.contract;
  if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((k) => !["id", "lang"].includes(k)))
    refuse("That reading couldn't be sent. Read the contract again and retry.");
  if (typeof p.id !== "string" || p.id.length > 100) refuse("That reading couldn't be sent. Read the contract again and retry.");
  const lang = p.lang === undefined ? "en" : p.lang;
  if (!["en", "zh", "es"].includes(lang)) refuse("That reading couldn't be sent. Read the contract again and retry.");
  const entry = cache.get(req.user.id, p.id);
  if (!entry) fail(404, CONTRACT_GONE, "contract_gone");
  body.messages = contractMessages(entry.facts, entry.sent.sent, lang);
  body.max_tokens = CONTRACT_READER.replyTokens;
  body.mode = "chat";
  return { entry, lang };
}
// The reply's room for the chosen model: replyTokens, lowered to the
// model's output cap and to what its context has left. A model whose context
// leaves less than 8,000 tokens (or its whole output cap, when smaller) is
// refused before anything is held.
export function contractBudget(model, messages) {
  const limits = chatLimits(model);
  const room = (limits.contextTokens || 32768) - contextEstimate(messages);
  if (room < Math.min(CONTRACT_READER.replyTokens, limits.maxOutputTokens))
    fail(
      400,
      "This contract's code is too long for this model. Choose a model with a larger context. Nothing was sent or charged.",
      "contract_too_long",
    );
  return Math.max(1, Math.min(CONTRACT_READER.replyTokens, limits.maxOutputTokens, room));
}
// runChat's acceptOutput: true for a reply that reads as a contract
// reading; otherwise it refuses with the plain reason, and runChat releases
// the hold (nothing is charged).
export const contractAcceptor = () => (output, finishReason) => {
  const problem = contractProblem(output, finishReason);
  if (problem) fail(502, problem.message, problem.code);
  return true;
};
