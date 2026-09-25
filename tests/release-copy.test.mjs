import test from "node:test";
import assert from "node:assert/strict";
import {
  featureEnabled,
  featureLabel,
  guideReleaseLabel,
  releaseCopy,
} from "../src/release-copy.js";

const config = {
  testMode: false,
  services: { generation: true, walletPayments: true, payments: false },
  walletPayments: { symbol: "USDG", chainName: "Robinhood Chain" },
  releases: {
    features: { code: true, images: false, api: false },
    updates: [
      { title: "Code & Build", released: true },
      { title: "Image Studio", released: false },
    ],
  },
};

test("guides distinguish fully unreleased, partly released and available workflows", () => {
  assert.equal(guideReleaseLabel(config, ["images", "video"]), "Coming soon");
  const imagesLive = {
    ...config,
    releases: { ...config.releases, features: { images: true, video: false } },
  };
  assert.equal(
    guideReleaseLabel(imagesLive, ["images", "video"]),
    "Some features coming soon",
  );
  assert.equal(guideReleaseLabel(imagesLive, ["images"]), "");
  assert.equal(guideReleaseLabel(null, ["api"]), "Availability unavailable");
  assert.equal(guideReleaseLabel(config), "");
});

test("MVP messaging distinguishes enabled workflows, gated features and wallet funding", () => {
  const copy = releaseCopy(config);
  assert.match(
    copy.summary,
    /Enabled: Chat, Code & Build, Dashboard, Account, Prepaid credits/,
  );
  assert.doesNotMatch(copy.summary, /Enabled:.*Image Studio/);
  assert.match(copy.payment, /USDG on Robinhood Chain/);
  assert.doesNotMatch(copy.payment, /seconds|unavailable/);
  assert.equal(
    featureLabel(config, "images", "Image Studio"),
    "Image Studio — coming soon",
  );
  assert.equal(featureEnabled(config, "api"), false);
});

test("unknown configuration and local tests never claim live access or real funding", () => {
  assert.equal(featureEnabled(null, "api"), false);
  assert.match(featureLabel(null, "api", "API"), /availability unavailable/);
  assert.match(releaseCopy(null).summary, /could not be loaded/);
  assert.match(
    releaseCopy({ ...config, testMode: true }).payment,
    /does not accept real payments/,
  );
  assert.match(
    releaseCopy({ ...config, services: {} }).payment,
    /Funding is currently unavailable/,
  );
});

test("copy follows subsequent releases without keeping stale coming-soon claims", () => {
  const next = {
    ...config,
    releases: {
      features: { api: true },
      updates: [{ title: "Developer API & CLI", released: true }],
    },
  };
  assert.equal(featureLabel(next, "api", "Developer API"), "Developer API");
  assert.match(releaseCopy(next).summary, /Developer API & CLI/);
  assert.doesNotMatch(releaseCopy(next).summary, /coming soon/);
});
