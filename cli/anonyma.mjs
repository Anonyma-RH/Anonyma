#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
const dir = process.env.ANONYMA_CONFIG_DIR || join(homedir(), ".config", "anonyma"),
  file = join(dir, "config.json");
let saved = {};
try {
  saved = JSON.parse(readFileSync(file, "utf8"));
} catch {}
const args = process.argv.slice(2);
let base = (
  process.env.ANONYMA_BASE_URL ||
  saved.base ||
  /* INSTALLATION_BASE */ "http://localhost:3001/v1"
).replace(/\/$/, "");
let key = process.env.ANONYMA_API_KEY || saved.key || "";
let model =
  process.env.ANONYMA_MODEL || saved.model || "google/gemini-2.5-flash";
let messages = [];
let controller;
if (args[0] === "--help" || args[0] === "help") {
  console.log(
    'Anonyma CLI (Node 18+)\nUsage: anonyma ["prompt"]\n       anonyma config\n\nEnvironment: ANONYMA_API_KEY, ANONYMA_BASE_URL, ANONYMA_MODEL\nInteractive: /models, /model ID, /new, /balance, /exit\nNo tools or shell commands are executed from model output.',
  );
  process.exit(0);
}
async function request(path, body) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json();
  if (!r.ok) throw Error(j.error?.message || `HTTP ${r.status}`);
  return j;
}
function promptSecret(label) {
  return new Promise((resolve) => {
    if (!stdin.isTTY) {
      const rl = createInterface({ input: stdin, output: stdout });
      rl.question(label).then((v) => {
        rl.close();
        resolve(v);
      });
      return;
    }
    stdout.write(label);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const handler = (chunk) => {
      for (const c of chunk) {
        if (c === "\u0003") {
          cleanup();
          process.exit(130);
        }
        if (c === "\r" || c === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else if (c >= " ") value += c;
      }
    };
    function cleanup() {
      stdin.removeListener("data", handler);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    }
    stdin.on("data", handler);
  });
}