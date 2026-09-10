import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { Wallet } from "ethers";
import { createApp } from "../server/app.js";
import {
  balance,
  credits,
  reserve,
  settle,
  release,
  addCredit,
  now,
  uid,
  usdUnits,
} from "../server/core.js";
import { canonical } from "../server/auth.js";
const chatModel = "google/gemini-2.5-flash",
  imageModel = "google/gemini-2.5-flash-image";
const prompt = {
  model: chatModel,
  messages: [{ role: "user", content: "Hello test" }],
  max_tokens: 50,
};
function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-test-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}