import { randomInt, createHmac, timingSafeEqual } from "node:crypto";
import {
  verifyMessage,
  JsonRpcProvider,
  Contract,
  getAddress,
  FetchRequest,
} from "ethers";