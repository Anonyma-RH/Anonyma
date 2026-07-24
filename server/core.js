import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { videoPresets } from "../data/video-presets.js";

export const uid = (prefix = "") => prefix + randomBytes(16).toString("hex");