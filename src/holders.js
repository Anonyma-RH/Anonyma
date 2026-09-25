// Holder Early Access in the browser. The server decides who gets in (see
// server/holders.js); this only mirrors it so the right things show.

// NYMA as read on-chain. The contract address itself is CONTRACT_ADDRESS in
// Home.jsx, the one shown in the homepage hero.
export const NYMA = {
  name: "Anonyma",
  symbol: "NYMA",
  network: "Robinhood Chain",
  chainId: 4663,
  decimals: 18,
  totalSupply: 1_000_000_000,
  explorer: "https://robinhoodchain.blockscout.com",
};
export const tokenExplorerUrl = (address) =>
  `${NYMA.explorer}/token/${address}`;

export const holdersReleased = (config) =>
  config?.releases?.features?.holders === true;

// Updates open to holders before their public release, from /api/config.
// The same list for everyone.
export const earlyUpdates = (config) =>
  holdersReleased(config)
    ? (config?.releases?.updates || []).filter(
        (u) => u.early === true && !u.released,
      )
    : [];

export const earlyAccessThreshold = (config, user) =>
  Number(
    config?.releases?.earlyAccess?.threshold ?? user?.holder?.threshold ?? 5_000_000,
  );

// The config the app runs on for a signed-in holder: the early updates in
// the account's own session (user.earlyAccess) count as released, so every
// isReleased(config, id) gate opens without touching its call site. Only
// updates /api/config itself marks early and unreleased can open this way.
export function withEarlyAccess(config, user) {
  const own = Array.isArray(user?.earlyAccess) ? user.earlyAccess : [];
  const ids = earlyUpdates(config)
    .map((u) => u.id)
    .filter((id) => own.includes(id));
  if (!ids.length) return config;
  return {
    ...config,
    releases: {
      ...config.releases,
      features: {
        ...config.releases.features,
        ...Object.fromEntries(ids.map((id) => [id, true])),
      },
      earlyAccess: { ...config.releases.earlyAccess, open: ids },
    },
  };
}

// Whether `id` is open to this viewer through early access: the "Early
// access" tag goes wherever that's true.
export const isEarlyAccess = (config, id) =>
  (config?.releases?.earlyAccess?.open || []).includes(id);
