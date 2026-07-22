import { randomInt, createHmac, timingSafeEqual } from "node:crypto";
import {
  verifyMessage,
  JsonRpcProvider,
  Contract,
  getAddress,
  FetchRequest,
} from "ethers";
import nodemailer from "nodemailer";
import {
  uid,
  hash,
  now,
  fail,
  passwordHash,
  passwordMatches,
  addCredit,
  balance,
  credits,
  discount,
} from "./core.js";