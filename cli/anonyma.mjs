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