import { getAddress, id } from "ethers";
import { UNITS, fail, now } from "./core.js";

// Direct wallet payments. A user sends the configured dollar stablecoin from
// the wallet linked to their account to the operator's public address; the
// server reads the transaction from the chain and credits it once. The server
// only reads the chain and never holds a key.

const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");
// Published details a wallet needs to add a network it doesn't know yet.
const CHAINS = {
  4663: {
    name: "Robinhood Chain",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
  },
};
// Older transfers need an operator, so incoming transfers from before a
// wallet was linked can't be claimed as new credit.
export const WALLET_PAYMENT_MAX_AGE_MS = 7 * 86400000;
export const TX_HASH = /^0x[0-9a-f]{64}$/;

export const walletPaymentsEnabled = (cfg) => !!cfg.walletPaymentAddress;

// What the browser needs to build the transfer. Never includes the server's
// RPC URL, which may carry a provider key.
export function walletPaymentInfo(cfg) {
  if (!walletPaymentsEnabled(cfg)) return null;
  const chain = CHAINS[cfg.walletPaymentChain] || {};
  return {
    address: getAddress(cfg.walletPaymentAddress.toLowerCase()),
    chainId: cfg.walletPaymentChain,
    chainName: chain.name || `Chain ${cfg.walletPaymentChain}`,
    publicRpc: chain.rpc || null,
    explorer: chain.explorer || null,
    token: getAddress(cfg.walletPaymentContract.toLowerCase()),
    symbol: cfg.walletPaymentSymbol,
    decimals: cfg.walletPaymentDecimals,
    confirmations: cfg.walletPaymentConfirmations,
  };
}

// Subcredits for a token amount, at 1 token = 1 USD, rounded down.
export function tokenCredits(value, decimals) {
  const units = (value * BigInt(UNITS)) / 10n ** BigInt(decimals);
  if (units > BigInt(Number.MAX_SAFE_INTEGER))
    fail(
      409,
      "This payment is too large to credit automatically. Contact support with the transaction hash.",
      "wallet_payment_review",
    );
  return Number(units);
}

// "1234567" base units with 6 decimals -> "1.234567".
export function formatTokenAmount(value, decimals) {
  const s = value.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

async function rpc(cfg, method, params, retry = true) {
  let body, reason, status;
  try {
    const response = await fetch(cfg.walletPaymentRpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(cfg.walletPaymentRpcTimeoutMs || 10000),
    });
    status = response.status;
    reason = `HTTP ${status}`;
    body = await response.json();
  } catch (e) {
    reason ||= e.name;
    body = null;
  }
  // Public nodes rate-limit bursts; one short pause usually clears it.
  if (retry && (status === 429 || !body)) {
    await new Promise((r) => setTimeout(r, cfg.walletPaymentRetryMs ?? 1000));
    return rpc(cfg, method, params, false);
  }
  if (!body || body.error || !("result" in body)) {
    // The RPC URL may carry a provider key, so it is never logged.
    console.error(
      `Wallet payment RPC ${method} failed: ${body?.error?.message || reason || "no result"}`,
    );
    fail(
      503,
      "The payment network couldn't be reached. Your payment is safe on-chain; try checking again in a minute.",
      "chain_unavailable",
    );
  }
  return body.result;
}

const checkedNodes = new Map();

const topicAddress = (topic) =>
  typeof topic === "string" && /^0x[0-9a-fA-F]{64}$/.test(topic)
    ? getAddress("0x" + topic.slice(26))
    : null;

// Reads a transaction and sums the configured token's transfers from `wallet`
// to the payment address. Returns { pending } until it has enough
// confirmations; fails when it can never be credited.
export async function verifyWalletPayment(cfg, txHash, wallet) {
  if (!TX_HASH.test(txHash))
    fail(
      400,
      "Enter a valid transaction hash (0x and 64 hex characters).",
      "invalid_transaction",
    );
  const info = walletPaymentInfo(cfg);
  // The node's network can't change under a URL, so it's checked once.
  if (checkedNodes.get(cfg.walletPaymentRpc) !== info.chainId) {
    const chainId = Number(await rpc(cfg, "eth_chainId", []));
    if (chainId !== info.chainId)
      fail(
        503,
        "The payment network is misconfigured on this service. Your payment is safe on-chain; contact support.",
        "chain_unavailable",
      );
    checkedNodes.set(cfg.walletPaymentRpc, chainId);
  }
  const receipt = await rpc(cfg, "eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { pending: true, reason: "waiting", confirmations: 0 };
  if (receipt.status !== "0x1")
    fail(
      400,
      `This transaction failed on ${info.chainName}, so nothing was sent and nothing was credited.`,
      "transaction_failed",
    );
  const head = Number(await rpc(cfg, "eth_blockNumber", []));
  const confirmations = head - Number(receipt.blockNumber) + 1;
  if (!(confirmations >= info.confirmations))
    return {
      pending: true,
      reason: "confirming",
      confirmations: Math.max(0, confirmations || 0),
    };
  const block = await rpc(cfg, "eth_getBlockByNumber", [
    receipt.blockNumber,
    false,
  ]);
  const time = Number(block?.timestamp) * 1000;
  if (!(time > 0))
    fail(
      503,
      "The payment network returned an incomplete block. Try checking again in a minute.",
      "chain_unavailable",
    );
  const from = getAddress(String(wallet).toLowerCase());
  let value = 0n;
  for (const log of receipt.logs || []) {
    if (log?.removed || typeof log?.address !== "string") continue;
    if (log.address.toLowerCase() !== info.token.toLowerCase()) continue;
    const topics = log.topics || [];
    if (
      topics.length !== 3 ||
      String(topics[0]).toLowerCase() !== TRANSFER_TOPIC
    )
      continue;
    if (
      topicAddress(topics[1]) !== from ||
      topicAddress(topics[2]) !== info.address
    )
      continue;
    if (typeof log.data !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(log.data))
      continue;
    value += BigInt(log.data);
  }
  if (value <= 0n)
    fail(
      400,
      `This transaction didn't send ${info.symbol} from your linked wallet (${from}) to Anonyma's payment address. Only payments from your linked wallet are credited automatically.`,
      "payment_not_matched",
    );
  if (now() - time > WALLET_PAYMENT_MAX_AGE_MS)
    fail(
      409,
      "This payment is more than 7 days old, so it can't be credited automatically. Contact support with the transaction hash.",
      "wallet_payment_review",
    );
  return {
    pending: false,
    value,
    from,
    block: Number(receipt.blockNumber),
    time,
  };
}
