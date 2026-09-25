import test from "node:test";
import assert from "node:assert/strict";
import {
  featureEnabled,
  featureLabel,
  guideReleaseLabel,
  releaseCopy,
  modelAvailability,
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


test("model labels separate available chat from unreleased developer API access", () => {
  const model = { type: "chat", callable: true, apiCallable: false };
  const catalog = { connected: true };
  assert.deepEqual(modelAvailability(model, config, catalog), {
    workspace: "Available in chat", api: "Developer API · Coming soon",
    workspaceReady: true, apiReady: false,
  });
  const apiConfig = { ...config, releases: { features: { api: true } } };
  assert.equal(modelAvailability(model, apiConfig, catalog).api, "Developer API · Unavailable");
  const callable = { ...model, apiCallable: true };
  assert.equal(modelAvailability(callable, apiConfig, catalog).api, "Developer API · Available");
  assert.equal(modelAvailability(callable, config, catalog).apiReady, false, "release gate wins over conflicting model metadata");
  const test = modelAvailability(callable, { ...apiConfig, testMode: true }, catalog);
  assert.equal(test.workspace, "Chat · Test model");
  assert.equal(test.api, "Developer API · Test model");
  assert.equal(modelAvailability({ ...callable, type: "video" }, apiConfig, catalog).api, "Developer API · Unsupported model");
  assert.equal(modelAvailability({ ...model, callable: false }, config, catalog).workspace, "Unavailable in chat");
});

test("missing or stale catalog data never advertises model availability", () => {
  const model = { type: "chat", callable: true, apiCallable: true };
  for (const catalog of [{}, { connected: false }, { connected: true, refreshError: "offline" }]) {
    const label = modelAvailability(model, config, catalog);
    assert.equal(label.workspace, "Chat availability unknown");
    assert.equal(label.workspaceReady, false);
    assert.equal(label.apiReady, false);
  }
  assert.equal(modelAvailability(model, null, { connected: true }).api, "Developer API · Availability unknown");
});
