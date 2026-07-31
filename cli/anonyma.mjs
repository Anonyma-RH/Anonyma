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