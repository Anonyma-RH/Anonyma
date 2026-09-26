import { fail, wantsWebSearch } from "./core.js";
import {
  QUERY_SYSTEM,
  EXPLAIN_SYSTEM,
  SHEETS_MAX_TOKENS,
  checkSheetsPayload,
  sheetsMessages,
} from "../src/sheets-spec.js";

// Local Sheets ("sheets"): a sheets question is an ordinary /api/chat
// request whose messages the server builds itself from the `sheets` payload
// (src/sheets-spec.js), so it runs through chat's own reserve → settle
// billing, Spending Limits, Allowances, Seed Guard, Private Mode and Privacy
// Trail. It's always off the record: nothing about it is saved. The
// spreadsheet itself never reaches the server; the payload carries only its
// profile, plus the sample rows or the result table the user chose to send.
//
// Runs before anything else in runChat (Seed Guard then reads the built
// messages). Requests without `sheets` are untouched.
const REFUSED = [
  "conversationId",
  "project",
  "taskTool",
  "double_check",
  "treasury",
  "messages",
];
export function prepareSheetsRequest(body) {
  if (!body || body.sheets === undefined) return;
  const refuse = (message) => fail(400, message, "invalid_sheets");
  if (body.ephemeral !== true)
    refuse("Sheets questions are never saved: send them off the record.");
  for (const key of REFUSED)
    if (body[key] !== undefined && body[key] !== null)
      refuse("A sheets question can't be combined with other chat options.");
  if (body.memory != null || wantsWebSearch(body))
    refuse("A sheets question can't be combined with other chat options.");
  if (body.mode !== undefined && body.mode !== "chat")
    refuse("A sheets question can't be combined with other chat options.");
  let payload;
  try {
    payload = checkSheetsPayload(body.sheets);
  } catch (e) {
    refuse(e.message);
  }
  body.messages = sheetsMessages(payload);
  body.max_tokens = SHEETS_MAX_TOKENS[payload.task];
  body.mode = "chat";
}

// LOCAL_TEST_MODE only (server/provider.js): a deterministic stand-in for a
// model, so the whole flow can be driven without a provider. It reads the
// profile back out of the prompt and plans "total <number column> by <text
// column>", preferring the columns the question names. Never used live.
export function sheetsTestReply(messages) {
  const system = messages?.[0]?.content;
  // The first user message holds the profile (a repair adds a second).
  const user = messages?.find((m) => m.role === "user")?.content;
  if (typeof user !== "string") return null;
  if (system === EXPLAIN_SYSTEM) {
    const rows = user
      .split("\n")
      .filter((l) => l.startsWith("["))
      .map((l) => JSON.parse(l));
    const [header, ...body] = rows;
    const numeric = header?.findIndex((_, i) =>
      body.some((r) => typeof r[i] === "number"),
    );
    if (!body.length || numeric < 0)
      return "Local test provider: the table is empty, so there's nothing to explain.";
    const top = [...body].sort(
      (a, b) => (b[numeric] ?? -Infinity) - (a[numeric] ?? -Infinity),
    );
    const label = (r) =>
      String(r.find((v, i) => i !== numeric && v !== null) ?? "(blank)");
    const n = (v) =>
      Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
    return `Local test provider (a fixture, not a model): ${label(top[0])} is highest with ${n(top[0][numeric])} in ${header[numeric]}${
      top.length > 1
        ? `, ahead of ${label(top[1])} at ${n(top[1][numeric])}`
        : ""
    }${top.length > 2 ? `, and ${label(top.at(-1))} is lowest at ${n(top.at(-1)[numeric])}` : ""}.`;
  }
  if (system !== QUERY_SYSTEM) return null;
  const question = (/^Question: (.*)$/m.exec(user)?.[1] || "").toLowerCase();
  const columns = [
    ...user.matchAll(
      /^\d+\. ("(?:[^"\\]|\\.)*") \((number|date|text|boolean)/gm,
    ),
  ].map((m) => ({ name: JSON.parse(m[1]), type: m[2] }));
  const named = (type) =>
    columns.find(
      (c) => c.type === type && question.includes(c.name.toLowerCase()),
    ) || columns.find((c) => c.type === type);
  const measure = named("number");
  const byMonth =
    /month|over time|trend/.test(question) &&
    columns.find((c) => c.type === "date");
  const group = byMonth ? null : named("text");
  if (!measure || (!group && !byMonth))
    return JSON.stringify({
      error: "These columns don't have a number to total by a category.",
    });
  const alias = `Total ${measure.name}`.slice(0, 60);
  return JSON.stringify(
    byMonth
      ? {
          title: `${alias} by month`.slice(0, 120),
          groupBy: [{ col: byMonth.name, bucket: "month" }],
          aggregates: [{ fn: "sum", col: measure.name, as: alias }],
          sort: [{ by: byMonth.name, dir: "asc" }],
          chart: { type: "line", x: byMonth.name, y: alias },
        }
      : {
          title: `${alias} by ${group.name}`.slice(0, 120),
          groupBy: [group.name],
          aggregates: [{ fn: "sum", col: measure.name, as: alias }],
          sort: [{ by: alias, dir: "desc" }],
          limit: 20,
          chart: { type: "bar", x: group.name, y: alias },
        },
  );
}
