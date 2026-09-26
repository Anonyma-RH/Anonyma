import { UNITS, fail, hasDisputedCredit, now, transaction, uid } from "../core.js";
import { isReleased } from "../releases.js";
import { recordNymaPayment } from "../payments.js";
import { depositJSON } from "./payments.js";
import {
  TX_HASH,
  formatTokenAmount,
  verifyWalletPayment,
  walletPaymentInfo,
  walletPaymentsEnabled,
} from "../wallet-payments.js";
import {
  NYMA_CONTRACT,
  creditsAt,
  nymaFor,
  nymaRate,
} from "../nyma-price.js";

// Pay with NYMA: top up credits by sending NYMA from the linked wallet to
// the wallet-payment address, with a bonus share of credits on top.
// 1. The account asks for a quote: send X NYMA for Y credits, valid for 20
//    minutes, at the rate server/nyma-price.js measures (the lower of spot
//    and a 30-minute on-chain average). The quote is stored here.
// 2. The account sends the NYMA itself. The server never sends anything.
// 3. It submits the transaction hash. The server reads the transaction from
//    chain 4663 (verifyWalletPayment): NYMA Transfer logs from the linked
//    wallet to the payment address, enough confirmations, at most 7 days
//    old. Each log is creditable once (nyma_claims).
// 4. The transfer is matched to the quote made before it: inside its window
//    it gets the quoted rate; after it, the lower of the quoted and current
//    rates. Whatever arrived is credited at that rate, so less NYMA gets
//    proportionally fewer credits and more NYMA all of them, within the
//    per-payment and 24-hour limits. The bonus is the quote's share of that.
export const NYMA_CHAIN = 4663;
export const NYMA_QUOTE_MINUTES = 10;
const QUOTE_MS = NYMA_QUOTE_MINUTES * 60000;
// A transfer may land a little before its quote: the chain's clock and this
// server's can differ.
const CLOCK_SKEW_MS = 120000;
const NYMA = { token: NYMA_CONTRACT, symbol: "NYMA", decimals: 18 };
const WHOLE = 10n ** 18n;

export const nymaPaymentsEnabled = (cfg) =>
  walletPaymentsEnabled(cfg) && cfg.walletPaymentChain === NYMA_CHAIN;

// Public settings the Credits page needs, once the update is released. The
// address and chain are /api/config walletPayments'.
export function nymaPaymentInfo(cfg) {
  if (!isReleased(cfg, "paynyma") || !nymaPaymentsEnabled(cfg)) return null;
  return {
    ...NYMA,
    bonus: cfg.nymaTopupBonus,
    quoteMinutes: NYMA_QUOTE_MINUTES,
    averageMinutes: cfg.nymaTwapMinutes,
    minUsd: cfg.nymaMinUsd,
    maxUsd: cfg.nymaMaxUsd,
    dailyMaxUsd: cfg.nymaDailyMaxUsd,
  };
}

const credits = (units) => Number((units / 10000).toFixed(4));
export function quoteJSON(q, at = now()) {
  return {
    id: q.id,
    wallet: q.wallet,
    nyma: formatTokenAmount(BigInt(q.nyma), 18),
    credits: credits(q.value),
    bonusCredits: credits(q.bonus),
    usd: q.value / UNITS,
    bonusPercent: q.bonus_bps / 100,
    usdPerNyma: q.usd_per_nyma,
    created: q.created,
    expires: q.expires,
    open: q.expires > at,
  };
}

export function nymaRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const enabled = () => {
    if (!nymaPaymentsEnabled(cfg))
      fail(
        503,
        "NYMA top-ups aren't set up on this service yet.",
        "nyma_payments_unconfigured",
      );
  };
  // NYMA value credited in the last 24 hours, in subcredits.
  const usedToday = (user) =>
    db
      .prepare(
        "SELECT COALESCE(SUM(amount),0) n FROM deposits WHERE user_id=? AND currency='nyma' AND credited=1 AND created>?",
      )
      .get(user, now() - 86400000).n;
  const limits = (user) => {
    const used = usedToday(user);
    return {
      usedTodayUsd: used / UNITS,
      remainingTodayUsd: Math.max(0, cfg.nymaDailyMaxUsd * UNITS - used) / UNITS,
    };
  };

  app.get(
    "/api/nyma/rate",
    requireUser,
    limit("nyma_rate", 240, 3600000),
    async (req, res) => {
      enabled();
      const r = await nymaRate(cfg);
      res.json({
        usdPerNyma: r.usdPerNyma,
        // Credits one million NYMA are worth now, before the bonus.
        creditsPerMillion: credits(Number(creditsAt(1_000_000n * WHOLE, r.rate))),
        bonus: cfg.nymaTopupBonus,
        averageMinutes: Math.floor(r.windowSeconds / 60),
        measuredAt: r.time,
      });
    },
  );

  app.get("/api/nyma/quote", requireUser, (req, res) => {
    enabled();
    const q = db
      .prepare(
        "SELECT * FROM nyma_quotes WHERE user_id=? AND expires>? ORDER BY created DESC LIMIT 1",
      )
      .get(req.user.id, now());
    res.json({ quote: q ? quoteJSON(q) : null, ...limits(req.user.id) });
  });

  app.post(
    "/api/nyma/quote",
    requireUser,
    limit("nyma_quotes", 30, 3600000),
    async (req, res) => {
      enabled();
      const usd = Number(req.body.usd);
      if (
        !Number.isFinite(usd) ||
        usd < cfg.nymaMinUsd ||
        usd > cfg.nymaMaxUsd
      )
        fail(
          400,
          `Choose an amount from $${cfg.nymaMinUsd} to $${cfg.nymaMaxUsd}.`,
          "invalid_amount",
        );
      if (!req.user.wallet)
        fail(
          400,
          "Link the wallet you pay from in Settings first. Payments are matched to your linked wallet.",
          "wallet_not_linked",
        );
      if (hasDisputedCredit(db, req.user.id))
        fail(
          409,
          "A credited payment is under reconciliation. New top-ups are paused until it's resolved.",
          "payment_reconciliation_pending",
        );
      const target = Math.round(usd * 100) * (UNITS / 100);
      const { remainingTodayUsd } = limits(req.user.id);
      if (target > remainingTodayUsd * UNITS)
        fail(
          409,
          `NYMA top-ups are limited to $${cfg.nymaDailyMaxUsd} in 24 hours. You can top up $${Math.floor(remainingTodayUsd * 100) / 100} more now.`,
          "nyma_daily_limit",
        );
      const rate = await nymaRate(cfg);
      // Whole NYMA, rounded up, so the quote is worth at least the amount.
      const nyma = nymaFor(target, rate.rate);
      const value = Number(creditsAt(nyma, rate.rate));
      const bonusBps = Math.round(cfg.nymaTopupBonus * 10000);
      const created = now();
      const q = {
        id: uid("nq_"),
        user_id: req.user.id,
        wallet: req.user.wallet,
        nyma: nyma.toString(),
        value,
        bonus: Math.floor((value * bonusBps) / 10000),
        bonus_bps: bonusBps,
        rate: rate.rate.toString(),
        usd_per_nyma: rate.usdPerNyma,
        spot: rate.spotUsdPerNyma,
        average: rate.averageUsdPerNyma,
        block: rate.block,
        created,
        expires: created + QUOTE_MS,
      };
      transaction(db, () => {
        // A new quote ends the open one, so windows never overlap.
        db.prepare(
          "UPDATE nyma_quotes SET expires=? WHERE user_id=? AND expires>?",
        ).run(created, req.user.id, created);
        db.prepare(
          `INSERT INTO nyma_quotes(${Object.keys(q).join(",")}) VALUES(${Object.keys(q).map(() => "?").join(",")})`,
        ).run(...Object.values(q));
      });
      res.status(201).json({ quote: quoteJSON(q), ...limits(req.user.id) });
    },
  );

  // Credit a NYMA transfer. 202 means it isn't confirmed yet: post the same
  // hash again. Repeats return 200 and the same deposit.
  app.post(
    "/api/nyma/claim",
    requireUser,
    limit("nyma_claims", 240, 3600000),
    async (req, res) => {
      enabled();
      const txHash = String(req.body.txHash || "")
        .trim()
        .toLowerCase();
      if (!TX_HASH.test(txHash))
        fail(
          400,
          "Enter a valid transaction hash (0x and 64 hex characters).",
          "invalid_transaction",
        );
      const chain = cfg.walletPaymentChain;
      const providerId = `nyma:${chain}:${txHash}`;
      const known = db
        .prepare("SELECT * FROM deposits WHERE provider_id=?")
        .get(providerId);
      if (known) {
        if (known.user_id !== req.user.id)
          fail(
            409,
            "This transaction was already credited to another account.",
            "payment_already_claimed",
          );
        return res.json(depositJSON(known));
      }
      if (!req.user.wallet)
        fail(
          400,
          "Link the wallet you pay from in Settings first. Payments are matched to your linked wallet.",
          "wallet_not_linked",
        );
      const info = walletPaymentInfo(cfg);
      const result = await verifyWalletPayment(
        cfg,
        txHash,
        req.user.wallet,
        NYMA,
      );
      if (result.pending)
        return res.status(202).json({
          status: result.reason,
          confirmations: result.confirmations,
          required: info.confirmations,
          txHash,
        });
      if (result.logs.some((i) => i === null))
        fail(
          503,
          "The payment network returned an incomplete transaction. Try checking again in a minute.",
          "chain_unavailable",
        );
      // The quote made before the transfer. If that one had ended, a quote
      // made just after the transfer (within the clock allowance) is its own.
      const quotes = db.prepare(
        "SELECT * FROM nyma_quotes WHERE user_id=? AND created<=? ORDER BY created DESC LIMIT 1",
      );
      let quote = quotes.get(req.user.id, result.time);
      if (!quote || result.time > quote.expires) {
        const next = db
          .prepare(
            "SELECT * FROM nyma_quotes WHERE user_id=? AND created>? AND created<=? ORDER BY created LIMIT 1",
          )
          .get(req.user.id, result.time, result.time + CLOCK_SKEW_MS);
        if (next) quote = next;
      }
      if (!quote)
        fail(
          409,
          "This transfer was sent before any NYMA quote on this account, so it can't be credited automatically. Contact support with the transaction hash.",
          "wallet_payment_review",
        );
      let rate = BigInt(quote.rate),
        basis = "quote";
      if (result.time > quote.expires) {
        // Late: the lower of the quoted and current rates.
        const current = await nymaRate(cfg);
        basis = "late";
        if (current.rate < rate) rate = current.rate;
      }
      const value = creditsAt(result.value, rate);
      if (value > BigInt(Number.MAX_SAFE_INTEGER))
        fail(
          409,
          "This payment is too large to credit automatically. Contact support with the transaction hash.",
          "wallet_payment_review",
        );
      const units = Number(value);
      // Rounding to whole NYMA may put a quote a hair over a limit.
      const slack = Number(creditsAt(WHOLE, rate));
      const stored = recordNymaPayment(
        db,
        {
          user: req.user.id,
          providerId,
          chain,
          txHash,
          logs: result.logs,
          value: units,
          bonus: Math.floor((units * quote.bonus_bps) / 10000),
          maxUsd: cfg.nymaMaxUsd,
          dailyMaxUsd: cfg.nymaDailyMaxUsd,
          slack,
          payload: {
            price_currency: "usd",
            pay_currency: `NYMA on ${info.chainName}`,
            pay_amount: formatTokenAmount(result.value, 18),
            pay_address: info.address,
            from_address: result.from,
            tx_hash: txHash,
            block: result.block,
            block_time: result.time,
            explorer_url: info.explorer
              ? `${info.explorer}/tx/${txHash}`
              : null,
            quote_id: quote.id,
            quote_nyma: formatTokenAmount(BigInt(quote.nyma), 18),
            rate_basis: basis,
            usd_per_nyma: Number(rate) / 1e19,
            bonus_percent: quote.bonus_bps / 100,
            bonus_credits: credits(Math.floor((units * quote.bonus_bps) / 10000)),
          },
        },
        { referralPercent: cfg.referralPercent },
      );
      res.status(201).json(depositJSON(stored));
    },
  );
}
