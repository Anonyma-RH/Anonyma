import express from "express";
import { openapi } from "./openapi.js";
import { publicDocumentation } from "./public-documentation.js";
import { recordPayment } from "./payments.js";
import {
  cliDownload,
  shellInstaller,
  powershellInstaller,
} from "./installers.js";
import cookieParser from "cookie-parser";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { loadCatalog, syncCatalog } from "./catalog.js";
import { createRatesFeed } from "./rates.js";
import { createMarketFeed } from "./market.js";