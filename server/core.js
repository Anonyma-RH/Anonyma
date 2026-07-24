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
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const now = () => Date.now();
export const UNITS = 10_000_000; // integer subcredits per USD
export const credits = (n) => Number((n / 10000).toFixed(4));
export const usdUnits = (dollars) => {
  const scaled = Number(dollars) * UNITS;
  const rounded = Math.round(scaled);
  // Remove binary floating-point noise at an exact subcredit boundary.
  // Real fractional subcredits still round up for prepaid reservations.
  return Math.abs(scaled - rounded) <= Math.abs(scaled) * Number.EPSILON
    ? rounded
    : Math.ceil(scaled);
};