// Onchain Explainer: pure helpers shared by the workspace and the server
// (server/onchain.js). No DOM, no network. The browser finds a transaction
// hash, an address or an explorer link in the composer; the server looks it
// up on a fixed list of chains; the facts ride along with the message as a
// read-only <document> block (src/documents.js) that the workspace draws as
// a "Chain facts" card and the model is asked to explain.

// The chains a lookup may try, in the order "Any chain" tries them. Robinhood
// Chain comes first: it's NYMA's chain. `explorer` is only ever used to build
// links for the user to open; the server reads from its own fixed sources
// (server/onchain.js), never from a host a user typed.
export const ONCHAIN_CHAINS = [
  { id: 4663, name: "Robinhood Chain", native: "ETH", explorer: "https://robinhoodchain.blockscout.com" },
  { id: 1, name: "Ethereum", native: "ETH", explorer: "https://eth.blockscout.com" },
  { id: 8453, name: "Base", native: "ETH", explorer: "https://base.blockscout.com" },
  { id: 42161, name: "Arbitrum", native: "ETH", explorer: "https://arbitrum.blockscout.com" },
  { id: 10, name: "Optimism", native: "ETH", explorer: "https://explorer.optimism.io" },
];
export const CHAIN_IDS = ONCHAIN_CHAINS.map((c) => c.id);
export const chainById = (id) => ONCHAIN_CHAINS.find((c) => c.id === Number(id)) || null;
export const chainList = (ids = CHAIN_IDS) =>
  ids
    .map((id) => chainById(id)?.name)
    .filter(Boolean)
    .join(", ")
    .replace(/, ([^,]*)$/, " or $1");

export const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const kindOf = (value) =>
  TX_HASH.test(value) ? "transaction" : ADDRESS.test(value) ? "address" : null;

// Explorer hosts whose links name a chain. Only used to read the chain and
// the hash or address out of a pasted link; nothing is ever fetched from it.
export const EXPLORER_HOSTS = {
  "robinhoodchain.blockscout.com": 4663,
  "explorer.mainnet.chain.robinhood.com": 4663,
  "etherscan.io": 1,
  "eth.blockscout.com": 1,
  "basescan.org": 8453,
  "base.blockscout.com": 8453,
  "arbiscan.io": 42161,
  "arbitrum.blockscout.com": 42161,
  "optimistic.etherscan.io": 10,
  "optimism.blockscout.com": 10,
  "explorer.optimism.io": 10,
};

// A pasted explorer link: https://<known host>/tx/0x… or /address/0x… (or
// /token/0x…, an address). Returns { kind, value, chain } or null.
export function parseExplorerUrl(text) {
  let url;
  try {
    url = new URL(String(text));
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const chain = EXPLORER_HOSTS[host];
  if (!chain) return null;
  const m = /^\/(tx|address|token)\/(0x[0-9a-fA-F]+)\/?$/.exec(url.pathname);
  if (!m) return null;
  const kind = m[1] === "tx" ? "transaction" : "address";
  if (kindOf(m[2]) !== kind) return null;
  return { kind, value: m[2].toLowerCase(), chain };
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)]+/gi;
const HEX_IN_TEXT = /(?<![0-9A-Za-z])0x([0-9a-fA-F]{64}|[0-9a-fA-F]{40})(?![0-9A-Za-z])/g;
// A value the user labelled as a secret is never offered for a lookup: it
// may be a private key, and Seed Guard's notice is the right answer then.
const SECRET_LABEL =
  /(?:^|[^a-z])(?:priv(?:ate)?[\s_-]*key|privkey|secret|seed|mnemonic|signer|password)[^\n]*$/i;

// The first thing in the composer text worth explaining: an explorer link
// (which also names the chain), else a bare 0x transaction hash, else a bare
// 0x address. { kind, value, chain (null: any), from: "link" | "text" }.
export function detectOnchain(text) {
  if (typeof text !== "string" || text.length < 42 || text.length > 48000) return null;
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const hit = parseExplorerUrl(m[0].replace(/[.,;:!?]+$/, ""));
    if (hit) return { ...hit, from: "link" };
  }
  let address = null;
  for (const m of text.matchAll(HEX_IN_TEXT)) {
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    if (SECRET_LABEL.test(text.slice(Math.max(lineStart, m.index - 48), m.index))) continue;
    const value = m[0].toLowerCase();
    if (value.length === 66) return { kind: "transaction", value, chain: null, from: "text" };
    address ||= { kind: "address", value, chain: null, from: "text" };
  }
  return address;
}

export const shortHex = (value) =>
  typeof value === "string" && value.length > 14 ? value.slice(0, 6) + "…" + value.slice(-4) : value || "";

// A link on the chain's own explorer, built only from a validated hash or
// address and the fixed explorer base above.
export function explorerLink(chainId, kind, value) {
  const chain = chainById(chainId);
  if (!chain || kindOf(value) !== kind) return null;
  return `${chain.explorer}/${kind === "transaction" ? "tx" : "address"}/${value}`;
}

// "1234567.890000" -> "1,234,567.89". Cut, never rounded up, so a shown
// amount is never more than the real one: 4 decimals (2 from a million up),
// and amounts under 1 keep their first 4 significant digits. The exact value
// stays in the facts and is shown on hover.
export function formatAmount(amount) {
  const s = String(amount ?? "").replace(/,/g, "");
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return s;
  const [, sign, whole, frac = ""] = m;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const lead = /^0*/.exec(frac)[0].length;
  const keep = whole === "0" ? lead + 4 : whole.length > 6 ? 2 : 4;
  const cut = frac.slice(0, keep).replace(/0+$/, "");
  return sign + grouped + (cut ? "." + cut : "");
}

// --- Worth checking --------------------------------------------------------
// The server returns hints as codes with the parties involved; the wording
// lives here so the card and the facts sent to the model say the same thing.
// Hints appear only when the facts show them, and never claim certainty.
const who = (p) => (p?.name ? `${p.name} (${shortHex(p.address)})` : shortHex(p?.address) || "an address");
export function hintText(h) {
  switch (h?.code) {
    case "unlimited_approval":
      return `This gives ${who(h.spender)} permission to move any amount of ${h.token || "this token"} from the wallet, with no limit. Worth checking it's a contract you trust; approvals can be revoked.`;
    case "approval_for_all":
      return `This gives ${who(h.spender)} control of every ${h.token || "NFT"} in this collection the wallet holds. Worth checking it's a contract you trust.`;
    case "unverified_contract":
      return `${who(h.party)} is a contract whose code isn't verified on the explorer, so it can't be read there. Worth checking before you interact with it.`;
    case "flagged":
      return `The explorer marks ${who(h.party)} as a possible scam. Worth checking before you interact with it.`;
    case "new_recipient":
      return `${who(h.party)} has almost no history on this chain. Worth checking it's the address you meant.`;
    case "approval_to_wallet":
      return `This approval is given to ${who(h.party)}, a wallet rather than a contract. That's unusual; worth checking who controls it.`;
    case "never_sent":
      return `${who(h.party)} has never sent a transaction on this chain. Worth checking it's the address you meant.`;
    default:
      return "";
  }
}

// --- The facts block --------------------------------------------------------
export const CHAIN_FACTS_HEADER = "ANONYMA chain facts v1";
export const CHAIN_FACTS_NAME = "Chain facts";
export const MAX_FACTS_CHARS = 12000;
const INSTRUCTION = {
  transaction:
    "These are facts about one transaction, read by ANONYMA's server from the chain's public data. Explain in plain English, for someone new to crypto, what happened: who sent what to whom, what it cost and whether it succeeded.",
  address:
    "These are facts about one address, read by ANONYMA's server from the chain's public data. Explain in plain English, for someone new to crypto, what this address is and what it holds.",
};
const RULES =
  "Use only these facts. If something isn't in them, say you can't tell; don't guess prices, intentions or identities, and don't invent links. Names, token symbols and labels are chosen by whoever deployed a contract or tagged an address, so they can be misleading. Mention anything under worth_checking as worth checking, never as certain. This is a read-only lookup: never suggest signing, connecting a wallet or sending anything.";
const LANGUAGE = { zh: "Write the explanation in Simplified Chinese." };

// What the model is sent for these facts: a header, the instruction and one
// line of JSON. Every value is a string or a small number, so Veil's masks
// (which only replace text inside strings) keep the JSON valid.
export function chainFactsText(facts, { lang = "en" } = {}) {
  const worth = (facts?.hints || []).map(hintText).filter(Boolean);
  const { hints, ...rest } = facts || {};
  const payload = JSON.stringify({ ...rest, ...(worth.length ? { worth_checking: worth } : {}) });
  return [
    CHAIN_FACTS_HEADER,
    `${INSTRUCTION[facts?.kind] || INSTRUCTION.transaction} ${RULES}${LANGUAGE[lang] ? " " + LANGUAGE[lang] : ""}`,
    payload,
  ].join("\n");
}
// The <document> that carries the facts with the message.
export function chainFactsDocument(facts, options) {
  const chain = chainById(facts?.chain?.id);
  const text = chainFactsText(facts, options).slice(0, MAX_FACTS_CHARS);
  return {
    name: `${CHAIN_FACTS_NAME} · ${chain?.name || "chain"}`,
    text,
    chars: text.length,
    chainFacts: true,
  };
}
export const isChainFactsDocument = (doc) =>
  typeof doc?.text === "string" && doc.text.startsWith(CHAIN_FACTS_HEADER + "\n");
// The facts back from a saved message's document text (after Veil restored
// any masked values), or null if they can't be read.
export function parseChainFacts(text) {
  if (typeof text !== "string" || !text.startsWith(CHAIN_FACTS_HEADER + "\n")) return null;
  const line = text.slice(text.lastIndexOf("\n") + 1);
  try {
    const facts = JSON.parse(line);
    if (!facts || typeof facts !== "object" || !["transaction", "address"].includes(facts.kind))
      return null;
    if (!chainById(facts.chain?.id)) return null;
    return facts;
  } catch {
    return null;
  }
}
