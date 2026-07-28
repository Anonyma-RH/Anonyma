import { addCredit, fail, now, transaction } from "./core.js";

const statuses = new Set([
  "waiting",
  "confirming",
  "confirmed",
  "sending",
  "partially_paid",
  "finished",
  "failed",
  "expired",
  "refunded",
]);