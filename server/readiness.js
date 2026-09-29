export function configurationStatus(cfg) {
  const groups = {
    generation: [["GATEWAY_API_KEY", cfg.gatewayKey]],
    payments: [
      ["NOWPAYMENTS_API_KEY", cfg.paymentKey],
      ["NOWPAYMENTS_IPN_SECRET", cfg.paymentSecret],
      ["PUBLIC_BASE_URL", /^https:\/\//.test(cfg.publicUrl)],
    ],
    email: [
      ["SMTP_URL", cfg.smtp],
      ["SMTP_FROM", cfg.smtpFrom],
    ],
    walletConnect: [["WALLETCONNECT_PROJECT_ID", cfg.walletProject]],
    token: [
      ["TOKEN_RPC_URL", cfg.rpc],
      ["TOKEN_CONTRACT", cfg.token],
    ],
    backupGateway: [
      ["GATEWAY2_BASE_URL", cfg.gateway2],
      ["GATEWAY2_API_KEY", cfg.gateway2Key],
    ],
    walletPayments: [["WALLET_PAYMENT_ADDRESS", cfg.walletPaymentAddress]],
    // Push Alerts: set means present, not valid (server/web-push.js checks
    // the pair; /api/config's services.push says whether it's usable).
    push: [
      ["VAPID_PUBLIC_KEY", cfg.vapidPublicKey],
      ["VAPID_PRIVATE_KEY", cfg.vapidPrivateKey],
      ["VAPID_SUBJECT", cfg.vapidSubject],
    ],
  };
  const configured = Object.fromEntries(
    Object.entries(groups).map(([service, keys]) => [
      service,
      keys.every(([, value]) => !!value),
    ]),
  );
  return {
    mode: cfg.testMode ? "local-test" : "live",
    configured,
    // Either payment route (processor invoices or direct wallet payments)
    // lets users add credit.
    requiredConfigured:
      !cfg.testMode &&
      configured.generation &&
      (configured.payments || configured.walletPayments) &&
      configured.email,
    missing: Object.fromEntries(
      Object.entries(groups).map(([service, keys]) => [
        service,
        keys.filter(([, value]) => !value).map(([key]) => key),
      ]),
    ),
    verified: false,
  };
}
export function assertNoTestCredits(db, cfg) {
  if (
    !cfg.testMode &&
    db.prepare("SELECT 1 FROM ledger WHERE kind='test_credit' LIMIT 1").get()
  )
    throw Error(
      "Live mode cannot use a database containing test credits. Set DATABASE_PATH and MEDIA_PATH to separate live storage; preserve the existing test data.",
    );
}
