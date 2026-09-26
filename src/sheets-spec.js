// Local Sheets: the part the server shares with the browser. A spreadsheet
// is read and calculated in the browser only (src/sheets.js); what a model
// is sent is built here, from a small, strictly checked payload, so the
// server (server/sheets.js) and the page's "What the AI sees" preview
// produce exactly the same text.
//
// The payload never carries cells, except the up to five sample rows the
// user ticks (a query) and the small result table the user chooses to have
// explained (an explanation).

export const SHEET_TYPES = ["number", "date", "text", "boolean"];
export const OPS = [
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "contains",
  "in",
  "between",
];
export const FNS = ["count", "sum", "avg", "min", "max", "median", "distinct"];
export const CHARTS = ["bar", "line", "pie", "table"];
export const BUCKETS = ["day", "month", "quarter", "year"];
export const TASKS = ["query", "repair", "explain"];

export const MAX_BYTES = 50 * 1024 * 1024;
export const MAX_ROWS = 500000;
export const MAX_COLUMNS = 200;
export const LIMITS = {
  name: 120,
  question: 2000,
  samples: 5,
  cell: 100,
  resultLimit: 1000,
  filters: 20,
  groupBy: 3,
  aggregates: 8,
  sort: 3,
  inValues: 100,
  previous: 4000,
  problems: 8,
  problem: 300,
  resultRows: 50,
  resultColumns: 12,
  title: 120,
  alias: 60,
  payload: 120000,
};
// Replies are a small JSON object or one paragraph, but reasoning models
// spend hidden reasoning tokens from the same budget first (a live plan on
// Gemini 2.5 Flash used 1,919 of them), so the budgets leave room for that.
// They only size the hold: billing settles on actual usage. The server
// lowers them to fit the chosen model (server/sheets.js, sheetsBudget).
export const SHEETS_MAX_TOKENS = { query: 8000, repair: 8000, explain: 3000 };

export const QUERY_SYSTEM = [
  "You plan calculations for ANONYMA Sheets. The user's spreadsheet stays on their device: you see only its column names, types, row count, how many different values each text column has and, if the user chose to share them, a few sample rows. Their browser runs your plan on the whole sheet.",
  "",
  "Reply with one JSON object and nothing else: no prose, no code fences. Use this shape and leave out keys you don't need:",
  '{"title": "short title for the result",',
  ' "filters": [{"col": "<column>", "op": "= | != | > | >= | < | <= | contains | in | between", "value": <value>}],',
  ' "groupBy": ["<column>" or {"col": "<date column>", "bucket": "day | month | quarter | year"}],',
  ' "aggregates": [{"fn": "count | sum | avg | min | max | median | distinct", "col": "<column>", "as": "<output name>"}],',
  ' "sort": [{"by": "<output name or column>", "dir": "asc | desc"}],',
  ' "limit": <1 to 1000>,',
  ' "chart": {"type": "bar | line | pie | table", "x": "<output name>", "y": "<output name>"}}',
  "",
  "Rules:",
  '- Use column names exactly as given. The output names are the groupBy columns and each aggregate\'s "as".',
  '- sum, avg and median need a number column; min and max a number or date column. count may leave out "col" to count rows; distinct counts different values.',
  '- >, >=, <, <= and between work on number and date columns, contains on text columns. "in" takes a list, "between" takes [low, high], dates are "YYYY-MM-DD", and null with = or != matches empty cells. Text matching ignores case.',
  '- A date column may show its first and last date: use them to pick the year a question means ("Q2", "last month"). If no range is shown and the question needs a year it doesn\'t name, don\'t guess one: group by that column with bucket "year", "quarter" or "month" instead of filtering on a year.',
  "- With no aggregates and no groupBy, the matching rows are listed.",
  '- Use "line" for values over time, "bar" to compare groups, "pie" for shares of a whole and "table" otherwise.',
  '- If these columns can\'t answer the question, reply {"error": "<one short sentence>"}.',
].join("\n");

export const EXPLAIN_SYSTEM =
  "You explain a small result table from ANONYMA Sheets in one short paragraph of at most four sentences. Use only the numbers in the table: don't guess causes, add facts or assume anything about rows the table leaves out. Reply in the language of the question, as plain text without headings, lists, tables or text drawings: the chart is already drawn for them.";

const CONTROL = /[\u0000-\u001f\u007f]/;
// A real calendar day written YYYY-MM-DD, and nothing else.
export function isoDay(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const plain = (v) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const fault = (message) => {
  throw Error(message);
};
function onlyKeys(object, allowed, what) {
  for (const key of Object.keys(object))
    if (!allowed.includes(key)) fault(`${what} has an unexpected field.`);
}
function text(value, max, what, { control = false } = {}) {
  if (typeof value !== "string") fault(`${what} must be text.`);
  const v = value.trim();
  if (!v) fault(`${what} is empty.`);
  if (v.length > max) fault(`${what} is too long.`);
  if (!control && CONTROL.test(v)) fault(`${what} has control characters.`);
  return v;
}

// The payload the browser sends as `sheets` on /api/chat, checked strictly:
// returns a normalised copy, or throws an Error whose message says what's
// wrong. Fields that don't belong to the task are refused, so a request can
// never carry more than its task needs.
export function checkSheetsPayload(raw) {
  if (!plain(raw)) fault("The sheets request is malformed.");
  if (!TASKS.includes(raw.task)) fault("Choose a supported sheets task.");
  let size;
  try {
    size = JSON.stringify(raw).length;
  } catch {
    fault("The sheets request is malformed.");
  }
  if (size > LIMITS.payload) fault("The sheets request is too large.");
  const task = raw.task;
  const out = {
    task,
    question: text(raw.question, LIMITS.question, "The question", {
      control: true,
    }),
  };
  if (task === "explain") {
    onlyKeys(
      raw,
      ["task", "question", "title", "result"],
      "The explanation request",
    );
    if (raw.title !== undefined)
      out.title = text(raw.title, LIMITS.title, "The result title");
    const r = raw.result;
    if (!plain(r)) fault("The result table is missing.");
    onlyKeys(r, ["columns", "rows", "total"], "The result table");
    if (
      !Array.isArray(r.columns) ||
      !r.columns.length ||
      r.columns.length > LIMITS.resultColumns
    )
      fault(`The result table needs 1 to ${LIMITS.resultColumns} columns.`);
    const columns = r.columns.map((c) =>
      text(c, LIMITS.name, "A result column name"),
    );
    if (!Array.isArray(r.rows) || r.rows.length > LIMITS.resultRows)
      fault(`The result table can have at most ${LIMITS.resultRows} rows.`);
    const rows = r.rows.map((row) => {
      if (!Array.isArray(row) || row.length !== columns.length)
        fault("Each result row needs one cell per column.");
      return row.map((cell) => {
        if (cell === null || typeof cell === "boolean") return cell;
        if (typeof cell === "number") {
          if (!Number.isFinite(cell))
            fault("A result cell isn't a finite number.");
          return cell;
        }
        if (
          typeof cell === "string" &&
          cell.length <= LIMITS.cell &&
          !CONTROL.test(cell)
        )
          return cell;
        fault("A result cell is too long or isn't a value.");
      });
    });
    const total = r.total ?? rows.length;
    if (!Number.isSafeInteger(total) || total < rows.length)
      fault("The result's row count is wrong.");
    out.result = { columns, rows, total };
    return out;
  }
  onlyKeys(
    raw,
    task === "repair"
      ? [
          "task",
          "question",
          "rows",
          "columns",
          "samples",
          "previous",
          "problems",
        ]
      : ["task", "question", "rows", "columns", "samples"],
    "The query request",
  );
  if (!Number.isSafeInteger(raw.rows) || raw.rows < 0 || raw.rows > MAX_ROWS)
    fault("The row count is wrong.");
  out.rows = raw.rows;
  if (
    !Array.isArray(raw.columns) ||
    !raw.columns.length ||
    raw.columns.length > MAX_COLUMNS
  )
    fault(`A sheet needs 1 to ${MAX_COLUMNS} columns.`);
  const seen = new Set();
  out.columns = raw.columns.map((c) => {
    if (!plain(c)) fault("A column is malformed.");
    onlyKeys(c, ["name", "type", "distinct", "from", "to"], "A column");
    const name = text(c.name, LIMITS.name, "A column name");
    if (seen.has(name)) fault("Column names must be different.");
    seen.add(name);
    if (!SHEET_TYPES.includes(c.type)) fault("A column has an unknown type.");
    const col = { name, type: c.type };
    if (c.distinct !== undefined) {
      if (c.type !== "text")
        fault("Only text columns report a count of different values.");
      if (
        !Number.isSafeInteger(c.distinct) ||
        c.distinct < 0 ||
        c.distinct > MAX_ROWS
      )
        fault("A count of different values is wrong.");
      col.distinct = c.distinct;
    }
    // "Share date ranges": a date column's first and last day, both or
    // neither, as strict YYYY-MM-DD dates.
    if (c.from !== undefined || c.to !== undefined) {
      if (c.type !== "date") fault("Only date columns report a date range.");
      if (!isoDay(c.from) || !isoDay(c.to) || c.from > c.to)
        fault("A date range is wrong.");
      col.from = c.from;
      col.to = c.to;
    }
    return col;
  });
  if (raw.samples !== undefined) {
    if (
      !Array.isArray(raw.samples) ||
      !raw.samples.length ||
      raw.samples.length > LIMITS.samples
    )
      fault(`Share 1 to ${LIMITS.samples} sample rows.`);
    out.samples = raw.samples.map((row) => {
      if (!Array.isArray(row) || row.length !== out.columns.length)
        fault("Each sample row needs one cell per column.");
      return row.map((cell) => {
        if (
          typeof cell !== "string" ||
          cell.length > LIMITS.cell ||
          CONTROL.test(cell)
        )
          fault("A sample cell is too long or isn't text.");
        return cell;
      });
    });
  }
  if (task === "repair") {
    out.previous = text(raw.previous, LIMITS.previous, "The previous reply", {
      control: true,
    });
    if (
      !Array.isArray(raw.problems) ||
      !raw.problems.length ||
      raw.problems.length > LIMITS.problems
    )
      fault("A repair needs the problems found.");
    out.problems = raw.problems.map((p) =>
      text(p, LIMITS.problem, "A problem"),
    );
  }
  return out;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The user message of a query: the question, then the sheet's profile, then
// any sample rows the user chose to share. Nothing else about the file.
export function queryText(p) {
  const lines = [
    `Question: ${p.question}`,
    "",
    `The sheet has ${plural(p.rows, "row", "rows")} and ${plural(p.columns.length, "column", "columns")}:`,
    ...p.columns.map(
      (c, i) =>
        `${i + 1}. ${JSON.stringify(c.name)} (${c.type}${
          c.distinct !== undefined
            ? `, ${plural(c.distinct, "different value", "different values")}`
            : ""
        }${c.from !== undefined ? `, ${c.from} to ${c.to}` : ""})`,
    ),
  ];
  if (p.samples?.length)
    lines.push(
      "",
      `${plural(p.samples.length, "sample row", "sample rows")} the user chose to share, as JSON arrays in column order:`,
      ...p.samples.map((row) => JSON.stringify(row)),
    );
  return lines.join("\n");
}
export const repairText = (problems) =>
  [
    "That reply isn't a query plan I can run:",
    ...problems.map((x) => `- ${x}`),
    "Reply with the corrected JSON object only.",
  ].join("\n");
export function explainText(p) {
  const r = p.result;
  const lines = [
    `Question: ${p.question}`,
    ...(p.title ? [`Result: ${p.title}`] : []),
    "",
    "The result table, as JSON arrays with the header row first:",
    JSON.stringify(r.columns),
    ...r.rows.map((row) => JSON.stringify(row)),
  ];
  if (r.total > r.rows.length)
    lines.push(
      "",
      `(These are the first ${r.rows.length} of ${r.total} result rows.)`,
    );
  return lines.join("\n");
}

// The exact messages a checked payload becomes.
export function sheetsMessages(p) {
  if (p.task === "explain")
    return [
      { role: "system", content: EXPLAIN_SYSTEM },
      { role: "user", content: explainText(p) },
    ];
  const messages = [
    { role: "system", content: QUERY_SYSTEM },
    { role: "user", content: queryText(p) },
  ];
  if (p.task === "repair")
    messages.push(
      { role: "assistant", content: p.previous },
      { role: "user", content: repairText(p.problems) },
    );
  return messages;
}
