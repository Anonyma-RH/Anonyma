import { hash, now, fail, usdUnits } from "../core.js";
import { payment } from "../provider.js";
import { validIPN } from "../auth.js";
import { configurationStatus } from "../readiness.js";
import {
  recordPayment,
  recordWalletPayment,
  FINAL_PAYMENT_STATUSES,
} from "../payments.js";
import { requestIdentifier } from "../middleware.js";
import { referralOptions } from "../referral-boost.js";
import {
  TX_HASH,
  formatTokenAmount,
  tokenCredits,
  verifyWalletPayment,
  walletPaymentInfo,
  walletPaymentsEnabled,
} from "../wallet-payments.js";

// A deposit as the API returns it: USD amount, parsed payload, and credited
// only while its credit stands.
export const depositJSON = (d) => {
  const payload = JSON.parse(d.payload);
  return {
    ...d,
    amount: d.amount / 1e7,
    payload,
    credited:
      d.credited &&
      d.status === "finished" &&
      payload.creditState !== "reversed"
        ? 1
        : 0,
  };
};

// Crypto deposit invoices and processor callbacks.
export function paymentRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  app.get("/api/payments/currencies", requireUser, async (req, res) => {
    if (!cfg.paymentKey || cfg.testMode)
      return res.json({
        data: ["btc", "eth", "sol", "usdttrc20", "usdtbsc", "usdc", "ltc"],
        live: false,
      });
    const result = await payment(cfg, "/currencies");
    res.json({ data: result.currencies || [], live: true });
  });
  app.get("/api/deposits", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT * FROM deposits WHERE user_id=? ORDER BY created DESC LIMIT 50",
        )
        .all(req.user.id)
        .map(depositJSON),
    }),
  );
  app.post(
    "/api/deposits",
    requireUser,
    limit("deposits", 10, 3600000),
    async (req, res) => {
      if (cfg.testMode || !configurationStatus(cfg).configured.payments)
        fail(
          503,
          "Configure a public HTTPS callback URL and IPN secret before accepting deposits.",
        );
      const dollars = Number(req.body.amount);
      if (!Number.isFinite(dollars) || dollars < 5 || dollars > 10000)
        fail(400, "Deposit must be $5–$10,000.");
      const currency = String(req.body.currency || "");
      if (!/^[a-z0-9]{2,30}$/.test(currency))
        fail(400, "Invalid payment currency.");
      const requestId = requestIdentifier(req);
      const id = "deposit_" + hash(req.user.id + ":" + requestId).slice(0, 32);
      const existing = db.prepare("SELECT * FROM deposits WHERE id=?").get(id);
      if (existing) {
        if (
          existing.amount !== usdUnits(dollars) ||
          existing.currency !== currency
        )
          fail(
            409,
            "Idempotency key was already used for a different invoice.",
          );
        if (existing.provider_id)
          return res.status(200).json({ id, ...JSON.parse(existing.payload) });
        fail(409, "Invoice creation is pending or requires reconciliation.");
      }
      const created = now();
      db.prepare(
        "INSERT INTO deposits(id,user_id,provider_id,amount,currency,status,payload,credited,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        req.user.id,
        null,
        usdUnits(dollars),
        currency,
        "creating",
        "{}",
        0,
        created,
        created,
      );
      try {
        const invoice = await payment(cfg, "/payment", {
          price_amount: dollars,
          price_currency: "usd",
          pay_currency: currency,
          order_id: id,
          order_description: "Anonyma prepaid AI credits",
          ipn_callback_url: cfg.publicUrl + "/api/payments/ipn",
          is_fee_paid_by_user: false,
        });
        if (!invoice.payment_id)
          throw Error("Processor did not return a payment ID.");
        // The create response may arrive after a newer signed callback. It is
        // authenticated, but it is not a current status poll for corrections.
        const stored = recordPayment(
          db,
          {
            ...invoice,
            payment_status: invoice.payment_status || "waiting",
            order_id: invoice.order_id ?? id,
            price_amount: invoice.price_amount ?? dollars,
            price_currency: invoice.price_currency ?? "usd",
          },
          { current: false, ...referralOptions(cfg) },
        );
        res.status(201).json({ id, ...JSON.parse(stored.payload) });
      } catch (e) {
        db.prepare(
          "UPDATE deposits SET status=?,updated=? WHERE id=? AND provider_id IS NULL",
        ).run(
          e.code === "payment_rejected" ? "failed" : "reconciliation",
          now(),
          id,
        );
        if (!e.status)
          fail(
            502,
            "Invoice creation could not be confirmed. Check deposit status before retrying; the order is held for reconciliation.",
            "payment_uncertain",
          );
        throw e;
      }
    },
  );
  // Credit a stablecoin transfer the user sent from their linked wallet. The
  // browser posts the transaction hash right after sending (or the user pastes
  // it); 202 means it isn't confirmed yet and the client checks again.
  app.post(
    "/api/deposits/wallet",
    requireUser,
    limit("wallet_deposits", 240, 3600000),
    async (req, res) => {
      if (!walletPaymentsEnabled(cfg))
        fail(
          503,
          "Wallet payments are not configured on this service yet.",
          "wallet_payments_unconfigured",
        );
      const txHash = String(req.body.txHash || "")
        .trim()
        .toLowerCase();
      if (!TX_HASH.test(txHash))
        fail(
          400,
          "Enter a valid transaction hash (0x and 64 hex characters).",
          "invalid_transaction",
        );
      const providerId = `wallet:${cfg.walletPaymentChain}:${txHash}`;
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
      const result = await verifyWalletPayment(cfg, txHash, req.user.wallet);
      if (result.pending)
        return res.status(202).json({
          status: result.reason,
          confirmations: result.confirmations,
          required: info.confirmations,
          txHash,
        });
      const stored = recordWalletPayment(
        db,
        {
          user: req.user.id,
          providerId,
          amount: tokenCredits(result.value, info.decimals),
          currency: info.symbol.toLowerCase(),
          payload: {
            price_currency: "usd",
            pay_currency: `${info.symbol} on ${info.chainName}`,
            pay_amount: formatTokenAmount(result.value, info.decimals),
            pay_address: info.address,
            from_address: result.from,
            tx_hash: txHash,
            block: result.block,
            explorer_url: info.explorer
              ? `${info.explorer}/tx/${txHash}`
              : null,
          },
        },
        referralOptions(cfg),
      );
      res.status(201).json(depositJSON(stored));
    },
  );
  const applyPayment = (body, current = false) =>
    recordPayment(db, body, {
      current,
      ...referralOptions(cfg),
    });
  app.post("/api/payments/ipn", (req, res) => {
    if (
      !validIPN(req.body, req.headers["x-nowpayments-sig"], cfg.paymentSecret)
    )
      fail(401, "Invalid payment signature.");
    applyPayment(req.body);
    res.json({ ok: true });
  });
  app.get("/api/deposits/:id", requireUser, async (req, res) => {
    const d = db
      .prepare("SELECT * FROM deposits WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!d) fail(404, "Invoice not found.");
    let refreshError = null;
    if (d.provider_id && !FINAL_PAYMENT_STATUSES.includes(d.status)) {
      let result;
      try {
        result = await payment(
          cfg,
          "/payment/" + encodeURIComponent(d.provider_id),
        );
      } catch {
        refreshError =
          "Processor status is temporarily unavailable. Showing the last verified invoice details.";
      }
      if (result == null || typeof result !== "object" || Array.isArray(result))
        refreshError =
          "Processor status is temporarily unavailable. Showing the last verified invoice details.";
      else {
        if (String(result.payment_id) !== d.provider_id)
          fail(
            502,
            "Processor returned a different invoice.",
            "payment_identity_mismatch",
          );
        applyPayment(result, true);
      }
    }
    const updated = db.prepare("SELECT * FROM deposits WHERE id=?").get(d.id);
    res.json({
      ...depositJSON(updated),
      ...(refreshError ? { refreshError } : {}),
    });
  });
}
