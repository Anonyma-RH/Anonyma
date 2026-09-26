import { formatUnits, getAddress } from "ethers";
import { fail } from "./core.js";
import { NYMA_CONTRACT, USDG_CONTRACT, POOL_MANAGER, NYMA_ETH_POOL } from "./nyma-price.js";
import { ADDRESS, CHAIN_IDS, TX_HASH, chainById, chainList } from "../src/onchain.js";

// Onchain Explainer's lookups (update "onchain"). A transaction hash or an
// address is read from a fixed list of public sources on the server, so the
// user's IP never reaches the explorer, and turned into a compact, structured
// set of facts the workspace shows as a card and the model explains.
//
// - Sources are fixed in code: no host, URL or path a user sent is ever
//   fetched. A URL is built only from a validated 0x hash or address.
// - Redirects are never followed, responses must be JSON, arrive within 8
//   seconds and be at most 1 MB.
// - Results are kept in memory for 60 seconds, then forgotten. Nothing is
//   stored, and hashes and addresses are never logged.
// - Read only: nothing here signs, sends or connects a wallet.
//
// Robinhood Chain's Blockscout answers server requests with a Cloudflare
// browser challenge, so for chain 4663 the facts come from the chain's public
// JSON-RPC node instead (no explorer names, verification or internal
// transfers there; a few contracts ANONYMA already knows are named).
export const SOURCES = {
  4663: { type: "rpc", url: "https://rpc.mainnet.chain.robinhood.com" },
  1: { type: "blockscout", url: "https://eth.blockscout.com" },
  8453: { type: "blockscout", url: "https://base.blockscout.com" },
  42161: { type: "blockscout", url: "https://arbitrum.blockscout.com" },
  // optimism.blockscout.com redirects here, and redirects aren't followed.
  10: { type: "blockscout", url: "https://explorer.optimism.io" },
};
export const ALLOWED_HOSTS = new Set(Object.values(SOURCES).map((s) => new URL(s.url).host));
export const LOOKUP_TIMEOUT_MS = 8000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const CACHE_MS = 60000;
const CACHE_MAX = 500;
const USER_AGENT = "ANONYMA-onchain/1";
const MAX_TRANSFERS = 12;
const MAX_TOKENS = 5;

// Where the facts came from, as the card says it.
export const SOURCE_NOTES = {
  rpc: "Robinhood Chain public node. Explorer names, verification and internal transfers aren't available here.",
  blockscout: "Blockscout explorer API.",
};

// A source that couldn't be read. Never carries the hash or address.
export class UpstreamError extends Error {
  constructor(reason) {
    super("Chain source unavailable: " + reason);
    this.reason = reason;
  }
}

async function readCapped(res, cap) {
  if (!res.body?.getReader) {
    const text = await res.text();
    if (Buffer.byteLength(text) > cap) throw new UpstreamError("size");
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    let step;
    try {
      step = await reader.read();
    } catch {
      throw new UpstreamError("network");
    }
    if (step.done) break;
    size += step.value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      throw new UpstreamError("size");
    }
    chunks.push(step.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// One JSON request to an allowlisted source. 404 is "not found" (null).
export async function fetchJson(fetchImpl, url, { method = "GET", body } = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new UpstreamError("url");
  }
  if (
    target.protocol !== "https:" ||
    !ALLOWED_HOSTS.has(target.host) ||
    target.username ||
    target.password
  )
    throw new UpstreamError("host");
  let res;
  try {
    res = await fetchImpl(target.href, {
      method,
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch {
    throw new UpstreamError("network");
  }
  const discard = () => {
    try {
      res.body?.cancel?.()?.catch?.(() => {});
    } catch {}
  };
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    discard();
    throw new UpstreamError("redirect");
  }
  let finalHost = target.host;
  try {
    if (res.url) finalHost = new URL(res.url).host;
  } catch {}
  if (finalHost !== target.host) {
    discard();
    throw new UpstreamError("redirect");
  }
  if (res.status === 404) {
    discard();
    return null;
  }
  if (!res.ok) {
    discard();
    throw new UpstreamError("status");
  }
  if (!/\bjson\b/i.test(res.headers?.get?.("content-type") || "")) {
    discard();
    throw new UpstreamError("type");
  }
  if (Number(res.headers?.get?.("content-length")) > MAX_RESPONSE_BYTES) {
    discard();
    throw new UpstreamError("size");
  }
  const text = await readCapped(res, MAX_RESPONSE_BYTES);
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError("json");
  }
}

// --- Shared formatting -----------------------------------------------------
// Text from the chain or an explorer is chosen by whoever deployed a contract
// or tagged an address: control, invisible and bidi characters are removed
// and it is cut short. React escapes it on screen; the facts block escapes
// it for the model.
export const clip = (v, n = 80) =>
  typeof v === "string"
    ? v
        .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]|[\u{e0000}-\u{e007f}]/gu, "")
        .trim()
        .slice(0, n) || undefined
    : undefined;
const checksum = (a) => {
  if (typeof a !== "string" || !ADDRESS.test(a)) return null;
  try {
    return getAddress(a.toLowerCase());
  } catch {
    return null;
  }
};
const big = (v) => {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
    if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
  } catch {}
  return null;
};
// An exact amount as text: "1,297,816.709653835840". Grouped, with at most
// 12 decimals (dropping less than a trillionth), so Veil's card-number rule
// can never match a run of digits inside it.
export function units(value, decimals) {
  const v = big(value);
  const d = Number(decimals);
  if (v === null || !Number.isInteger(d) || d < 0 || d > 36) return undefined;
  const [whole, frac = ""] = formatUnits(v, d).split(".");
  const neg = whole.startsWith("-");
  const digits = neg ? whole.slice(1) : whole;
  const cut = frac.slice(0, 12).replace(/0+$/, "");
  return (neg ? "-" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (cut ? "." + cut : "");
}
const ZERO = "0x0000000000000000000000000000000000000000";
// A "maximum" allowance: at least 2^255, or every bit set in 64 bits or
// more (uint256, uint160 and uint96 maxima are what "unlimited" buttons send).
export function isUnlimited(amount) {
  const v = big(amount);
  if (v === null || v <= 0n) return false;
  if (v >= 2n ** 255n) return true;
  return v >= 2n ** 64n - 1n && (v & (v + 1n)) === 0n;
}
const isoTime = (t) => {
  const d = typeof t === "number" ? new Date(t * 1000) : new Date(t);
  return Number.isFinite(d.getTime()) ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : undefined;
};
const num = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};
const compact = (o) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
const chainOf = (id) => {
  const c = chainById(id);
  return { id: c.id, name: c.name };
};
// A few hints at most, each party once.
function addHint(hints, hint) {
  const key = hint.code + ":" + (hint.party?.address || hint.spender?.address || "");
  if (hints.length < 4 && !hints.some((h) => h.key === key)) hints.push({ key, ...hint });
}
const finishHints = (hints) => hints.map(({ key, ...h }) => h);
const personOf = (p) => (p ? compact({ address: p.address, name: p.name }) : undefined);
// Who an approval is given to: a wallet rather than a contract is unusual,
// and so is a contract whose code the explorer can't show.
function approvalHints(hints, spender) {
  if (spender?.type === "wallet") addHint(hints, { code: "approval_to_wallet", party: personOf(spender) });
  if (spender?.type === "contract" && spender.verified === false)
    addHint(hints, { code: "unverified_contract", party: personOf(spender) });
  if (spender?.flagged) addHint(hints, { code: "flagged", party: personOf(spender) });
}

// Common selectors, for chains read over JSON-RPC (Blockscout decodes calls
// itself). Checked against keccak256 of each signature in the tests.
export const SELECTORS = {
  "0xa9059cbb": ["transfer", "transfer(address,uint256)"],
  "0x23b872dd": ["transferFrom", "transferFrom(address,address,uint256)"],
  "0x095ea7b3": ["approve", "approve(address,uint256)"],
  "0x39509351": ["increaseAllowance", "increaseAllowance(address,uint256)"],
  "0xa22cb465": ["setApprovalForAll", "setApprovalForAll(address,bool)"],
  "0x42842e0e": ["safeTransferFrom", "safeTransferFrom(address,address,uint256)"],
  "0xb88d4fde": ["safeTransferFrom", "safeTransferFrom(address,address,uint256,bytes)"],
  "0xf242432a": ["safeTransferFrom", "safeTransferFrom(address,address,uint256,uint256,bytes)"],
  "0x2eb2c2d6": ["safeBatchTransferFrom", "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)"],
  "0x3593564c": ["execute", "execute(bytes,bytes[],uint256)"],
  "0x24856bc3": ["execute", "execute(bytes,bytes[])"],
  "0x765e827f": ["handleOps", "handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)"],
  "0x1fad948c": ["handleOps", "handleOps((address,uint256,bytes,bytes,uint256,uint256,uint256,uint256,uint256,bytes,bytes)[],address)"],
  "0xac9650d8": ["multicall", "multicall(bytes[])"],
  "0x5ae401dc": ["multicall", "multicall(uint256,bytes[])"],
  "0x82ad56cb": ["aggregate3", "aggregate3((address,bool,bytes)[])"],
  "0x174dea71": ["aggregate3Value", "aggregate3Value((address,bool,uint256,bytes)[])"],
  "0xd0e30db0": ["deposit", "deposit()"],
  "0x2e1a7d4d": ["withdraw", "withdraw(uint256)"],
  "0x38ed1739": ["swapExactTokensForTokens", "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"],
  "0x7ff36ab5": ["swapExactETHForTokens", "swapExactETHForTokens(uint256,address[],address,uint256)"],
  "0x18cbafe5": ["swapExactTokensForETH", "swapExactTokensForETH(uint256,uint256,address[],address,uint256)"],
  "0x8803dbee": ["swapTokensForExactTokens", "swapTokensForExactTokens(uint256,uint256,address[],address,uint256)"],
  "0xfb3bdb41": ["swapETHForExactTokens", "swapETHForExactTokens(uint256,address[],address,uint256)"],
  "0x414bf389": ["exactInputSingle", "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))"],
  "0x04e45aaf": ["exactInputSingle", "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"],
  "0xc04b8d59": ["exactInput", "exactInput((bytes,address,uint256,uint256,uint256))"],
  "0xb858183f": ["exactInput", "exactInput((bytes,address,uint256,uint256))"],
  "0x40c10f19": ["mint", "mint(address,uint256)"],
  "0x42966c68": ["burn", "burn(uint256)"],
  "0xd505accf": ["permit", "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)"],
  "0x4e71d92d": ["claim", "claim()"],
  "0x5c19a95c": ["delegate", "delegate(address)"],
  "0xf2fde38b": ["transferOwnership", "transferOwnership(address)"],
  "0x715018a6": ["renounceOwnership", "renounceOwnership()"],
  "0x6a761202": ["execTransaction", "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)"],
};
// An EIP-7702 account: a wallet whose code is a delegation marker.
const DELEGATED = /^0xef0100[0-9a-fA-F]{40}$/;
const codeType = (code) => (typeof code === "string" && code !== "0x" && !DELEGATED.test(code) ? "contract" : "wallet");
// Calls whose meaning the facts already spell out (transfers, approvals).
const STRUCTURED = ["0xa9059cbb", "0x23b872dd", "0x095ea7b3", "0x39509351", "0xa22cb465"];
const APPROVE = "0x095ea7b3",
  INCREASE = "0x39509351",
  APPROVE_ALL = "0xa22cb465",
  TRANSFER = "0xa9059cbb";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const word = (data, i) => (typeof data === "string" ? data.slice(10 + i * 64, 10 + (i + 1) * 64) : "");
const wordAddress = (w) => (/^[0-9a-fA-F]{64}$/.test(w) && /^0{24}/.test(w) ? checksum("0x" + w.slice(24)) : null);
const wordUint = (w) => (/^[0-9a-fA-F]{64}$/.test(w) ? BigInt("0x" + w) : null);
const topicAddress = (t) => (typeof t === "string" && /^0x0{24}[0-9a-fA-F]{40}$/i.test(t) ? checksum("0x" + t.slice(26)) : null);

// Contracts ANONYMA already names in its own code (Pay with NYMA), plus the
// operator's payment address. Used only for chains read over JSON-RPC.
export function knownNames(cfg = {}) {
  const names = {
    [NYMA_CONTRACT.toLowerCase()]: "NYMA token",
    [USDG_CONTRACT.toLowerCase()]: "USDG token",
    [POOL_MANAGER.toLowerCase()]: "Uniswap v4 PoolManager",
    [NYMA_ETH_POOL.hooks.toLowerCase()]: "NYMA/ETH pool hook",
  };
  if (cfg.walletPaymentChain === 4663 && ADDRESS.test(cfg.walletPaymentAddress || ""))
    names[cfg.walletPaymentAddress.toLowerCase()] = "ANONYMA payment address";
  return { 4663: names };
}

// --- Blockscout (REST API v2) -------------------------------------------------
export function blockscoutParty(p) {
  const address = checksum(p?.hash);
  if (!address) return null;
  const tags = Array.isArray(p.metadata?.tags) ? p.metadata.tags : [];
  const name = clip(p.name) || clip(tags.find((t) => t?.tagType === "name")?.name) || clip(p.ens_domain_name);
  const labels = [
    ...(Array.isArray(p.public_tags) ? p.public_tags.map((t) => t?.display_name || t?.label) : []),
    ...tags.filter((t) => t?.tagType === "generic").map((t) => t?.name),
  ]
    .map((l) => clip(l, 40))
    .filter((l) => l && l !== name)
    .filter((l, i, all) => all.indexOf(l) === i)
    .slice(0, 3);
  return compact({
    address,
    name,
    labels: labels.length ? labels : undefined,
    type: p.is_contract ? "contract" : "wallet",
    verified: p.is_contract ? p.is_verified === true : undefined,
    flagged: p.is_scam === true || p.reputation === "scam" ? true : undefined,
  });
}
function blockscoutToken(t) {
  if (!t) return null;
  return compact({
    symbol: clip(t.symbol, 24),
    name: clip(t.name, 60),
    address: checksum(t.address_hash || t.address),
    type: clip(t.type, 16),
    flagged: t.is_scam === true || t.reputation === "scam" ? true : undefined,
  });
}
// The facts of one transaction from /api/v2/transactions/{hash}, plus what
// was fetched with it: `internal` (/internal-transactions), `approvalToken`
// (/tokens/{address}) and `recipient` (/addresses/{a}/counters).
export function blockscoutTxFacts(tx, chainId, { internal = null, approvalToken = null, spender: spenderInfo = null, recipient = null } = {}) {
  const chain = chainById(chainId);
  const hints = [];
  const from = blockscoutParty(tx.from);
  const to = blockscoutParty(tx.to);
  const status = tx.status === "ok" ? "success" : tx.status === "error" ? "failed" : "pending";
  const decoded = tx.decoded_input && typeof tx.decoded_input === "object" ? tx.decoded_input : null;
  const methodId = decoded?.method_id ? "0x" + String(decoded.method_id).replace(/^0x/, "").toLowerCase() : null;
  const params = Array.isArray(decoded?.parameters) ? decoded.parameters : [];
  const transfers = (Array.isArray(tx.token_transfers) ? tx.token_transfers : [])
    .slice(0, MAX_TRANSFERS)
    .map((t) => {
      const token = blockscoutToken(t.token);
      const total = t.total || {};
      const f = blockscoutParty(t.from);
      const r = blockscoutParty(t.to);
      if (token?.flagged) addHint(hints, { code: "flagged", party: { address: token.address, name: token.symbol || token.name } });
      return compact({
        token,
        amount: total.value != null && total.decimals != null ? units(total.value, total.decimals) : undefined,
        token_id: total.token_id != null ? clip(String(total.token_id), 40) : undefined,
        from: f,
        to: r,
        mint: f?.address === ZERO ? true : undefined,
        burn: r?.address === ZERO ? true : undefined,
      });
    });
  const more = Math.max(0, (tx.token_transfers?.length || 0) - transfers.length);
  // A call's small, readable parameters (addresses, numbers, flags).
  const shown = (STRUCTURED.includes(methodId) ? [] : params)
    .filter((p) => /^(address|uint\d*|int\d*|bool)$/.test(p?.type) && String(p.value).length <= 80)
    .slice(0, 6)
    .map((p) => compact({ name: clip(p.name, 32), type: p.type, value: clip(String(p.value), 80) }));
  const approvals = [];
  if ([APPROVE, INCREASE, APPROVE_ALL].includes(methodId) && to) {
    const spender = checksum(params.find((p) => p?.type === "address")?.value);
    const token = blockscoutToken(approvalToken) || compact({ name: to.name, address: to.address });
    const known = blockscoutParty(spenderInfo);
    const spenderParty = spender ? (known?.address === spender ? known : compact({ address: spender })) : undefined;
    approvalHints(hints, spenderParty);
    if (methodId === APPROVE_ALL) {
      const on = params.find((p) => p?.type === "bool")?.value;
      approvals.push(compact({ token, spender: spenderParty, all: on === true || on === "true" ? true : undefined, revoke: on === false || on === "false" ? true : undefined }));
      if ((on === true || on === "true") && spenderParty)
        addHint(hints, { code: "approval_for_all", spender: personOf(spenderParty), token: token.symbol || token.name });
    } else {
      const raw = params.find((p) => /^uint/.test(p?.type))?.value;
      const unlimited = isUnlimited(raw);
      approvals.push(compact({
        token,
        spender: spenderParty,
        amount: unlimited ? "unlimited" : approvalToken?.decimals != null ? units(raw, approvalToken.decimals) : undefined,
        raw_amount: !unlimited && approvalToken?.decimals == null ? clip(String(raw ?? ""), 80) : undefined,
        revoke: big(raw) === 0n ? true : undefined,
      }));
      if (unlimited && spenderParty)
        addHint(hints, { code: "unlimited_approval", spender: personOf(spenderParty), token: token.symbol || token.name });
    }
  }
  for (const p of [to, from, ...transfers.flatMap((t) => [t.from, t.to])])
    if (p?.flagged) addHint(hints, { code: "flagged", party: personOf(p) });
  if (to?.type === "contract" && to.verified === false)
    addHint(hints, { code: "unverified_contract", party: personOf(to) });
  if (recipient && recipient.fresh)
    addHint(hints, { code: "new_recipient", party: personOf(recipient.party) });
  const internalTransfers = (Array.isArray(internal?.items) ? internal.items : [])
    .filter((i) => big(i?.value) > 0n && i?.success !== false)
    .slice(0, 8)
    .map((i) => compact({ amount: units(i.value, 18), from: blockscoutParty(i.from), to: blockscoutParty(i.to) }));
  return compact({
    kind: "transaction",
    chain: chainOf(chainId),
    hash: TX_HASH.test(tx.hash || "") ? tx.hash.toLowerCase() : undefined,
    status,
    error: status === "failed" ? clip(typeof tx.result === "string" && tx.result !== "success" ? tx.result : "reverted", 120) : undefined,
    time: tx.timestamp ? isoTime(tx.timestamp) : undefined,
    block: num(tx.block_number ?? tx.block),
    from,
    to,
    method: clip(tx.method, 60),
    call: clip(decoded?.method_call, 160),
    params: shown.length ? shown : undefined,
    value: { amount: units(tx.value || "0", 18), symbol: chain.native },
    fee: tx.fee?.value != null ? { amount: units(tx.fee.value, 18), symbol: chain.native } : undefined,
    transfers: transfers.length ? transfers : undefined,
    more_transfers: more > 0 ? more : tx.token_transfers_overflow === true ? true : undefined,
    internal_transfers: internalTransfers.length ? internalTransfers.map((t) => ({ ...t, symbol: chain.native })) : undefined,
    approvals: approvals.length ? approvals : undefined,
    contract_created: blockscoutParty(tx.created_contract) || undefined,
    source: SOURCE_NOTES.blockscout,
    hints: finishHints(hints),
  });
}
// Whether the transaction's single recipient is worth a history check: a
// plain transfer of the chain's coin or a token's transfer().
export function blockscoutRecipient(tx) {
  const decoded = tx?.decoded_input;
  const methodId = decoded?.method_id ? "0x" + String(decoded.method_id).replace(/^0x/, "").toLowerCase() : null;
  if (methodId === TRANSFER) {
    const a = checksum(decoded.parameters?.find((p) => p?.type === "address")?.value);
    return a && a !== ZERO ? a : null;
  }
  if (!decoded && !tx?.to?.is_contract && big(tx?.value) > 0n) return checksum(tx.to?.hash);
  return null;
}
export const blockscoutFresh = (counters) =>
  !!counters &&
  (num(counters.transactions_count) ?? 99) <= 1 &&
  (num(counters.token_transfers_count) ?? 99) <= 1;

// /api/v2/addresses/{a}, /counters and /tokens?type=ERC-20.
export function blockscoutAddressFacts(a, chainId, { counters = null, tokens = null } = {}) {
  const chain = chainById(chainId);
  const party = blockscoutParty(a) || { address: checksum(a?.hash) };
  const hints = [];
  if (party.flagged) addHint(hints, { code: "flagged", party: personOf(party) });
  if (party.type === "contract" && party.verified === false)
    addHint(hints, { code: "unverified_contract", party: personOf(party) });
  const items = Array.isArray(tokens?.items) ? tokens.items : [];
  const clean = items.filter((t) => t?.token && !(t.token.is_scam === true || t.token.reputation === "scam"));
  const held = clean
    .filter((t) => big(t.value) > 0n)
    .slice(0, MAX_TOKENS)
    .map((t) => compact({ ...blockscoutToken(t.token), type: undefined, amount: units(t.value, t.token.decimals ?? 0) }));
  const token = a?.token
    ? compact({
        name: clip(a.token.name, 60),
        symbol: clip(a.token.symbol, 24),
        type: clip(a.token.type, 16),
        holders: num(a.token.holders_count ?? a.token.holders),
        supply: a.token.total_supply != null && a.token.decimals != null ? units(a.token.total_supply, a.token.decimals) : undefined,
      })
    : undefined;
  const txCount = num(counters?.transactions_count);
  const transferCount = num(counters?.token_transfers_count);
  const activity =
    a?.is_contract === true ||
    big(a?.coin_balance) > 0n ||
    a?.has_token_transfers === true ||
    a?.has_tokens === true ||
    (txCount ?? 0) > 0;
  return compact({
    kind: "address",
    chain: chainOf(chainId),
    ...party,
    balance: { amount: units(a?.coin_balance || "0", 18), symbol: chain.native },
    transactions: txCount,
    token_transfers: transferCount,
    tokens: held.length ? held : undefined,
    more_tokens: clean.length > held.length || tokens?.next_page_params ? true : undefined,
    hidden_tokens: items.length - clean.length || undefined,
    token,
    creator: party.type === "contract" ? checksum(a.creator_address_hash) || undefined : undefined,
    created_in: party.type === "contract" && TX_HASH.test(a.creation_transaction_hash || "") ? a.creation_transaction_hash.toLowerCase() : undefined,
    implementation: party.type === "contract" ? clip(a.implementations?.[0]?.name, 60) : undefined,
    activity,
    source: SOURCE_NOTES.blockscout,
    hints: finishHints(hints),
  });
}

// --- JSON-RPC (Robinhood Chain) ----------------------------------------------
const decodeString = (hex) => {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex) || hex.length < 66) return undefined;
  const b = Buffer.from(hex.slice(2), "hex");
  try {
    if (b.length >= 64) {
      const offset = Number(BigInt("0x" + b.subarray(0, 32).toString("hex")));
      const len = Number(BigInt("0x" + b.subarray(offset, offset + 32).toString("hex")));
      if (offset === 32 && len <= 256 && offset + 32 + len <= b.length)
        return clip(b.subarray(offset + 32, offset + 32 + len).toString("utf8"), 60);
    }
    // bytes32 names (old tokens): up to the first zero byte.
    const end = b.subarray(0, 32).indexOf(0);
    return clip(b.subarray(0, end < 0 ? 32 : end).toString("utf8"), 60);
  } catch {
    return undefined;
  }
};
// eth_call results for symbol(), name(), decimals() -> token metadata.
export function rpcTokenMeta(symbolHex, nameHex, decimalsHex) {
  const decimals = typeof decimalsHex === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(decimalsHex) ? Number(BigInt(decimalsHex)) : null;
  const symbol = decodeString(symbolHex);
  if (decimals === null || decimals > 36 || !symbol) return null;
  return compact({ symbol, name: decodeString(nameHex), decimals });
}
// The facts of one transaction read over JSON-RPC.
//   tx, receipt: eth_getTransactionByHash / eth_getTransactionReceipt
//   time: the block's timestamp (seconds)
//   codes: address (lowercase) -> eth_getCode result
//   tokens: token address (lowercase) -> rpcTokenMeta(...)
//   names: address (lowercase) -> a name ANONYMA knows
//   recipientNonce: eth_getTransactionCount of the transfer's recipient
export function rpcTxFacts({ tx, receipt, time, codes = {}, tokens = {}, names = {}, recipientNonce = null }, chainId) {
  const chain = chainById(chainId);
  const hints = [];
  const party = (address) => {
    const a = checksum(address);
    if (!a) return null;
    const code = codes[a.toLowerCase()];
    const meta = tokens[a.toLowerCase()];
    return compact({
      address: a,
      name: names[a.toLowerCase()] || (meta ? `${meta.name || meta.symbol} (${meta.symbol})` : undefined),
      type: code === undefined ? undefined : codeType(code),
      smart_wallet: DELEGATED.test(code || "") ? true : undefined,
    });
  };
  const input = typeof tx.input === "string" ? tx.input : "0x";
  const selector = /^0x[0-9a-fA-F]{8}/.test(input) ? input.slice(0, 10).toLowerCase() : null;
  const known = selector ? SELECTORS[selector] : null;
  const status = !receipt ? "pending" : receipt.status === "0x1" ? "success" : "failed";
  const from = party(tx.from);
  const to = party(tx.to);
  const logs = Array.isArray(receipt?.logs) ? receipt.logs : [];
  const transferLogs = logs.filter((l) => l?.topics?.[0] === TRANSFER_TOPIC && (l.topics.length === 3 || l.topics.length === 4));
  const transfers = transferLogs.slice(0, MAX_TRANSFERS).map((l) => {
    const meta = tokens[String(l.address).toLowerCase()];
    const token = compact({ symbol: meta?.symbol, name: meta?.name, address: checksum(l.address) });
    const f = party(topicAddress(l.topics[1]));
    const r = party(topicAddress(l.topics[2]));
    const nft = l.topics.length === 4;
    return compact({
      token,
      amount: !nft && meta ? units(l.data, meta.decimals) : undefined,
      raw_amount: !nft && !meta ? String(big(l.data) ?? "") || undefined : undefined,
      token_id: nft ? String(big(l.topics[3]) ?? "") || undefined : undefined,
      from: f,
      to: r,
      mint: f?.address === ZERO ? true : undefined,
      burn: r?.address === ZERO ? true : undefined,
    });
  });
  const approvals = [];
  if ([APPROVE, INCREASE, APPROVE_ALL].includes(selector) && to) {
    const meta = tokens[to.address.toLowerCase()];
    const token = compact({ symbol: meta?.symbol, name: meta?.name || to.name, address: to.address });
    const spender = wordAddress(word(input, 0));
    const spenderParty = spender ? party(spender) : undefined;
    approvalHints(hints, spenderParty);
    const raw = wordUint(word(input, 1));
    if (selector === APPROVE_ALL) {
      approvals.push(compact({ token, spender: spenderParty, all: raw === 1n ? true : undefined, revoke: raw === 0n ? true : undefined }));
      if (raw === 1n && spenderParty)
        addHint(hints, { code: "approval_for_all", spender: personOf(spenderParty), token: token.symbol || token.name });
    } else if (raw !== null) {
      const unlimited = isUnlimited(raw);
      approvals.push(compact({
        token,
        spender: spenderParty,
        amount: unlimited ? "unlimited" : meta ? units(raw, meta.decimals) : undefined,
        raw_amount: !unlimited && !meta ? raw.toString() : undefined,
        revoke: raw === 0n ? true : undefined,
      }));
      if (unlimited && spenderParty)
        addHint(hints, { code: "unlimited_approval", spender: personOf(spenderParty), token: token.symbol || token.name });
    }
  }
  const recipient = rpcRecipient(tx);
  if (recipient && recipientNonce === 0 && codeType(codes[recipient.toLowerCase()] ?? "0x") === "wallet")
    addHint(hints, { code: "never_sent", party: personOf(party(recipient)) });
  const gasUsed = big(receipt?.gasUsed);
  const price = big(receipt?.effectiveGasPrice ?? tx.gasPrice);
  return compact({
    kind: "transaction",
    chain: chainOf(chainId),
    hash: TX_HASH.test(tx.hash || "") ? tx.hash.toLowerCase() : undefined,
    status,
    error: status === "failed" ? "reverted" : undefined,
    time: time != null ? isoTime(Number(time)) : undefined,
    block: tx.blockNumber ? num(Number(BigInt(tx.blockNumber))) : undefined,
    from,
    to,
    method: known?.[0],
    call: known?.[1],
    selector: selector && !known ? selector : undefined,
    value: { amount: units(tx.value || "0x0", 18), symbol: chain.native },
    fee: gasUsed !== null && price !== null ? { amount: units(gasUsed * price, 18), symbol: chain.native } : undefined,
    transfers: transfers.length ? transfers : undefined,
    more_transfers: transferLogs.length > transfers.length ? transferLogs.length - transfers.length : undefined,
    approvals: approvals.length ? approvals : undefined,
    contract_created: receipt?.contractAddress ? party(receipt.contractAddress) : undefined,
    source: SOURCE_NOTES.rpc,
    hints: finishHints(hints),
  });
}
// A plain coin transfer's recipient, or a token transfer()'s.
export function rpcRecipient(tx) {
  const input = typeof tx?.input === "string" ? tx.input : "0x";
  if (input.slice(0, 10).toLowerCase() === TRANSFER) {
    const a = wordAddress(word(input, 0));
    return a && a !== ZERO ? a : null;
  }
  if ((input === "0x" || input === "") && big(tx?.value) > 0n) return checksum(tx.to);
  return null;
}
// The addresses and token contracts a JSON-RPC transaction needs looked up.
export function rpcTxNeeds(tx, receipt) {
  const parties = new Set();
  const tokens = new Set();
  const add = (set, a) => {
    const c = checksum(a);
    if (c && c !== ZERO) set.add(c.toLowerCase());
  };
  add(parties, tx.from);
  add(parties, tx.to);
  add(parties, receipt?.contractAddress);
  const input = typeof tx.input === "string" ? tx.input : "";
  const selector = input.slice(0, 10).toLowerCase();
  if ([APPROVE, INCREASE, APPROVE_ALL].includes(selector)) {
    add(tokens, tx.to);
    add(parties, wordAddress(word(input, 0)));
  }
  const recipient = rpcRecipient(tx);
  if (recipient) add(parties, recipient);
  for (const l of (receipt?.logs || []).filter((l) => l?.topics?.[0] === TRANSFER_TOPIC).slice(0, MAX_TRANSFERS)) {
    add(tokens, l.address);
    add(parties, topicAddress(l.topics[1]));
    add(parties, topicAddress(l.topics[2]));
  }
  // eth_getCode returns a contract's whole bytecode (up to 48 KB of hex), so
  // at most 10 are asked for, keeping the batch well under the 1 MB cap.
  return {
    parties: [...parties].slice(0, 10),
    tokens: [...tokens].slice(0, 8),
    recipient: recipient ? recipient.toLowerCase() : null,
  };
}
// An address read over JSON-RPC: code, balance, nonce, NYMA held, and token
// metadata if the address is a token contract.
export function rpcAddressFacts({ address, code, balance, nonce, nyma, token = null, supply = null, names = {} }, chainId) {
  const chain = chainById(chainId);
  const a = checksum(address);
  const contract = codeType(code) === "contract";
  const nymaHeld = big(nyma);
  const nonceN = big(nonce);
  const balanceN = big(balance);
  return compact({
    kind: "address",
    chain: chainOf(chainId),
    address: a,
    name: names[a.toLowerCase()] || (token ? `${token.name || token.symbol} (${token.symbol})` : undefined),
    type: contract ? "contract" : "wallet",
    smart_wallet: DELEGATED.test(code || "") ? true : undefined,
    balance: { amount: units(balanceN ?? 0n, 18), symbol: chain.native },
    sent_transactions: nonceN !== null ? num(Number(nonceN)) : undefined,
    tokens: nymaHeld > 0n ? [{ symbol: "NYMA", name: "Anonyma", address: NYMA_CONTRACT, amount: units(nymaHeld, 18) }] : undefined,
    tokens_checked: ["NYMA"],
    token: token
      ? compact({ name: token.name, symbol: token.symbol, supply: supply != null ? units(supply, token.decimals) : undefined })
      : undefined,
    activity: contract || (nonceN ?? 0n) > 0n || (balanceN ?? 0n) > 0n || (nymaHeld ?? 0n) > 0n,
    source: SOURCE_NOTES.rpc,
    hints: [],
  });
}

// --- Lookups ------------------------------------------------------------------
async function rpcBatch(fetchImpl, url, calls) {
  if (!calls.length) return [];
  const out = await fetchJson(fetchImpl, url, {
    method: "POST",
    body: calls.map(([method, params], id) => ({ jsonrpc: "2.0", id, method, params })),
  });
  if (!Array.isArray(out)) throw new UpstreamError("rpc");
  const byId = new Map(out.map((r) => [r?.id, r]));
  return calls.map((_, id) => {
    const r = byId.get(id);
    if (!r) throw new UpstreamError("rpc");
    return r.error ? { error: true } : { result: r.result };
  });
}

export function createOnchain({ fetch: fetchImpl = globalThis.fetch, now = Date.now, cfg = {} } = {}) {
  const names = knownNames(cfg);
  const cache = new Map();
  const bs = (chainId, path) => fetchJson(fetchImpl, SOURCES[chainId].url + path);

  async function blockscoutTx(chainId, hash) {
    const tx = await bs(chainId, `/api/v2/transactions/${hash}`);
    if (!tx || typeof tx !== "object" || !tx.hash) return null;
    const methodId = String(tx.decoded_input?.method_id || "").replace(/^0x/, "").toLowerCase();
    const recipient = blockscoutRecipient(tx);
    const approval = ["095ea7b3", "39509351", "a22cb465"].includes(methodId);
    const tokenAddress = approval ? checksum(tx.to?.hash) : null;
    const spender = approval
      ? checksum(tx.decoded_input?.parameters?.find((p) => p?.type === "address")?.value)
      : null;
    // What else is worth one more read each; a failure there only leaves
    // that fact out.
    const optional = (p) => p.catch((e) => {
      if (e instanceof UpstreamError) return null;
      throw e;
    });
    const [internal, approvalToken, spenderInfo, counters] = await Promise.all([
      optional(bs(chainId, `/api/v2/transactions/${hash}/internal-transactions`)),
      tokenAddress ? optional(bs(chainId, `/api/v2/tokens/${tokenAddress}`)) : null,
      spender ? optional(bs(chainId, `/api/v2/addresses/${spender}`)) : null,
      recipient ? optional(bs(chainId, `/api/v2/addresses/${recipient}/counters`)) : null,
    ]);
    return blockscoutTxFacts(tx, chainId, {
      internal,
      approvalToken,
      spender: spenderInfo,
      recipient: recipient && counters ? { party: { address: recipient }, fresh: blockscoutFresh(counters) } : null,
    });
  }
  async function blockscoutAddress(chainId, address) {
    const a = await bs(chainId, `/api/v2/addresses/${address}`);
    if (!a || typeof a !== "object") return null;
    return { a, chainId, address };
  }
  async function blockscoutAddressDetails({ a, chainId, address }) {
    const [counters, tokens] = await Promise.all([
      bs(chainId, `/api/v2/addresses/${address}/counters`),
      bs(chainId, `/api/v2/addresses/${address}/tokens?type=ERC-20`),
    ]);
    return blockscoutAddressFacts(a, chainId, { counters, tokens });
  }
  async function rpcTx(chainId, hash) {
    const url = SOURCES[chainId].url;
    const [txr, rcr] = await rpcBatch(fetchImpl, url, [
      ["eth_getTransactionByHash", [hash]],
      ["eth_getTransactionReceipt", [hash]],
    ]);
    if (txr.error || rcr.error) throw new UpstreamError("rpc");
    const tx = txr.result;
    if (!tx || typeof tx !== "object") return null;
    const receipt = rcr.result && typeof rcr.result === "object" ? rcr.result : null;
    const needs = rpcTxNeeds(tx, receipt);
    const calls = [
      ...needs.parties.map((a) => ["eth_getCode", [a, "latest"]]),
      ...needs.tokens.flatMap((t) => [
        ["eth_call", [{ to: t, data: "0x95d89b41" }, "latest"]],
        ["eth_call", [{ to: t, data: "0x06fdde03" }, "latest"]],
        ["eth_call", [{ to: t, data: "0x313ce567" }, "latest"]],
      ]),
      ...(needs.recipient ? [["eth_getTransactionCount", [needs.recipient, "latest"]]] : []),
      ...(tx.blockTimestamp || !tx.blockNumber ? [] : [["eth_getBlockByNumber", [tx.blockNumber, false]]]),
    ];
    const results = await rpcBatch(fetchImpl, url, calls);
    const codes = {};
    needs.parties.forEach((a, i) => {
      if (!results[i].error) codes[a] = results[i].result;
    });
    const tokens = {};
    needs.tokens.forEach((t, i) => {
      const [s, n, d] = results.slice(needs.parties.length + i * 3, needs.parties.length + i * 3 + 3);
      const meta = rpcTokenMeta(s.result, n.result, d.result);
      if (meta) tokens[t] = meta;
    });
    let at = needs.parties.length + needs.tokens.length * 3;
    let recipientNonce = null;
    if (needs.recipient) {
      const n = results[at++];
      if (!n.error && big(n.result) !== null) recipientNonce = Number(big(n.result));
    }
    const block = results[at]?.error ? null : results[at]?.result;
    const time = tx.blockTimestamp ? Number(big(tx.blockTimestamp)) : block?.timestamp ? Number(big(block.timestamp)) : null;
    return rpcTxFacts({ tx, receipt, time, codes, tokens, names: names[chainId] || {}, recipientNonce }, chainId);
  }
  async function rpcAddress(chainId, address) {
    const url = SOURCES[chainId].url;
    const balanceOf = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
    const r = await rpcBatch(fetchImpl, url, [
      ["eth_getCode", [address, "latest"]],
      ["eth_getBalance", [address, "latest"]],
      ["eth_getTransactionCount", [address, "latest"]],
      ["eth_call", [{ to: NYMA_CONTRACT, data: balanceOf }, "latest"]],
      ["eth_call", [{ to: address, data: "0x95d89b41" }, "latest"]],
      ["eth_call", [{ to: address, data: "0x06fdde03" }, "latest"]],
      ["eth_call", [{ to: address, data: "0x313ce567" }, "latest"]],
      ["eth_call", [{ to: address, data: "0x18160ddd" }, "latest"]],
    ]);
    if (r[0].error || r[1].error || r[2].error) throw new UpstreamError("rpc");
    const contract = codeType(r[0].result) === "contract";
    const token = contract ? rpcTokenMeta(r[4].result, r[5].result, r[6].result) : null;
    return rpcAddressFacts(
      {
        address,
        code: r[0].result,
        balance: r[1].result,
        nonce: r[2].result,
        nyma: r[3].error ? null : r[3].result,
        token,
        supply: token && !r[7].error ? r[7].result : null,
        names: names[chainId] || {},
      },
      chainId,
    );
  }

  // Kept for 60 seconds, "not found" included; a failure isn't kept.
  function cached(key, run) {
    const t = now();
    const hit = cache.get(key);
    if (hit && hit.expires > t) return hit.promise;
    if (cache.size >= CACHE_MAX) {
      for (const [k, v] of cache) if (v.expires <= t) cache.delete(k);
      while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    const entry = { expires: t + CACHE_MS, promise: run() };
    cache.set(key, entry);
    entry.promise.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    return entry.promise;
  }
  // An address exists on every chain, so "any chain" takes the first where
  // it has any activity; the details are read only for that one.
  const probe = (chainId, kind, value) =>
    cached(`${chainId}:${kind}:${value}`, () => {
      const rpc = SOURCES[chainId].type === "rpc";
      if (kind === "transaction") return rpc ? rpcTx(chainId, value) : blockscoutTx(chainId, value);
      return rpc ? rpcAddress(chainId, value) : blockscoutAddress(chainId, value);
    });
  const details = (chainId, value, found) =>
    SOURCES[chainId].type === "rpc"
      ? Promise.resolve(found)
      : cached(`${chainId}:address-details:${value}`, () => blockscoutAddressDetails(found));
  const addressActive = (found) =>
    found?.a
      ? found.a.is_contract === true || big(found.a.coin_balance) > 0n || found.a.has_token_transfers === true || found.a.has_tokens === true || found.a.has_logs === true
      : !!found?.activity;

  // { kind, value, chain: "auto" | chain id } -> facts. Refuses with 404
  // onchain_not_found or 502 onchain_unavailable; never names the value.
  async function lookup({ kind, value, chain }) {
    const ids = chain === "auto" ? CHAIN_IDS : [chain];
    let failed = false;
    let first = null;
    for (const id of ids) {
      let found;
      try {
        found = await probe(id, kind, value);
      } catch (e) {
        if (!(e instanceof UpstreamError)) throw e;
        failed = true;
        continue;
      }
      if (!found) continue;
      if (kind === "transaction") return found;
      if (ids.length === 1 || addressActive(found)) return await details(id, value, found).catch(rethrow);
      first ||= { id, found };
    }
    if (failed)
      fail(
        502,
        ids.length > 1
          ? "One of the chains couldn't be reached, so this lookup is incomplete. Nothing was charged; try again in a minute."
          : `${chainById(ids[0]).name} couldn't be reached. Nothing was charged; try again in a minute.`,
        "onchain_unavailable",
      );
    if (first) {
      const facts = await details(first.id, value, first.found).catch(rethrow);
      return { ...facts, checked: ids.map((id) => chainById(id).name) };
    }
    fail(
      404,
      kind === "transaction"
        ? `This transaction wasn't found on ${chainList(ids)}.`
        : `This address wasn't found on ${chainList(ids)}.`,
      "onchain_not_found",
    );
  }
  const rethrow = (e) => {
    if (e instanceof UpstreamError)
      fail(502, "The chain's data couldn't be read right now. Nothing was charged; try again in a minute.", "onchain_unavailable");
    throw e;
  };
  return { lookup, cache };
}
