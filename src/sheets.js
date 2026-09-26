// Local Sheets (the "sheets" update): a spreadsheet is read, profiled and
// calculated in the browser, usually inside a Web Worker
// (src/sheets.worker.js). A model only ever plans the calculation: it gets
// the sheet's profile (column names, types, the row count and, for text
// columns, how many different values there are) and answers with a small
// JSON query plan, which is checked here against the real columns and then
// run locally. Nothing in this file touches the network or the DOM.
import {
  BUCKETS,
  CHARTS,
  FNS,
  LIMITS,
  MAX_BYTES,
  MAX_COLUMNS,
  MAX_ROWS,
  OPS,
} from "./sheets-spec.js";

export { MAX_BYTES, MAX_COLUMNS, MAX_ROWS };

// ---- Reading a file ----

export const SHEET_EXTENSIONS = [".csv", ".tsv", ".txt", ".json"];
export function sheetKind(name = "") {
  const n = String(name).toLowerCase();
  if (n.endsWith(".json")) return "json";
  if (n.endsWith(".tsv")) return "tsv";
  if (/\.(xlsx|xlsm|xls|ods|numbers)$/.test(n)) return "workbook";
  return "csv";
}
// UTF-8 (with or without a byte-order mark) or UTF-16 with one.
export function decodeBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}

// The delimiter the header row uses most, outside quotes: comma, tab,
// semicolon or pipe. A .tsv file prefers tabs.
export function detectDelimiter(text, kind = "csv") {
  let line = "",
    quoted = false;
  for (
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    i < text.length && i < 65536;
    i++
  ) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted) line += c;
  }
  const count = (d) => line.split(d).length - 1;
  if (kind === "tsv" && count("\t")) return "\t";
  let best = ",",
    most = 0;
  for (const d of [",", "\t", ";", "|"]) {
    const n = count(d);
    if (n > most) {
      best = d;
      most = n;
    }
  }
  return best;
}

// RFC 4180 records: quoted fields may hold delimiters, quotes ("") and line
// breaks; records end at CRLF, LF or CR; a leading byte-order mark is
// skipped. Lenient where files often aren't: text after a closing quote is
// kept, and a file that ends inside quotes ends the value there.
// `onRecord(fields)` is called once per record. Returns { unterminated }.
export function forEachRecord(text, delimiter, onRecord) {
  const n = text.length,
    D = delimiter.charCodeAt(0);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0,
    fields = [],
    unterminated = false;
  while (i < n) {
    let c = text.charCodeAt(i);
    if (c === 34) {
      let value = "",
        start = ++i;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q === -1) {
          value += text.slice(start);
          i = n;
          unterminated = true;
          break;
        }
        if (text.charCodeAt(q + 1) === 34) {
          value += text.slice(start, q + 1);
          i = start = q + 2;
          continue;
        }
        value += text.slice(start, q);
        i = q + 1;
        break;
      }
      const tail = i;
      while (i < n && (c = text.charCodeAt(i)) !== D && c !== 10 && c !== 13)
        i++;
      fields.push(i > tail ? value + text.slice(tail, i) : value);
    } else {
      const start = i;
      while (i < n && (c = text.charCodeAt(i)) !== D && c !== 10 && c !== 13)
        i++;
      fields.push(text.slice(start, i));
    }
    if (i >= n) break;
    c = text.charCodeAt(i);
    if (c === D) {
      i++;
      if (i >= n) fields.push("");
      continue;
    }
    i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
    onRecord(fields);
    fields = [];
  }
  if (fields.length) onRecord(fields);
  return { unterminated };
}
export function parseDelimited(text, delimiter = detectDelimiter(text)) {
  const records = [];
  forEachRecord(text, delimiter, (f) => records.push(f));
  return records;
}

// Column names from the header row: trimmed, control characters removed,
// at most 120 characters, blanks named by position and repeats numbered.
export function headerNames(fields) {
  const seen = new Set();
  return fields.map((raw, i) => {
    let name = String(raw ?? "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, LIMITS.name)
      .trim();
    if (!name) name = `Column ${i + 1}`;
    let unique = name,
      k = 2;
    while (seen.has(unique))
      unique = `${name.slice(0, LIMITS.name - 6)} (${k++})`;
    seen.add(unique);
    return unique;
  });
}

// ---- Values and types ----

const NULLISH = new Set(["na", "n/a", "null", "none", "nan", "-", "—"]);
const BOOLEANS = new Map([
  ["true", true],
  ["false", false],
  ["yes", true],
  ["no", false],
]);
const NUMBER =
  /^([+-])?([$€£¥])?([+-])?(\d{1,3}(?:,\d{3})+|\d+)?(\.\d+)?(?:[eE]([+-]?\d+))?(%)?$/;
// "1,234.50", "-$12", "7.5%" (read as 7.5) and "1e3". A leading zero
// ("00123") means an identifier, so the column stays text.
export function parseNumber(s) {
  const m = NUMBER.exec(String(s).trim());
  if (!m || (!m[4] && !m[5]) || (m[1] && m[3])) return null;
  if (m[4] && /^0\d/.test(m[4])) return null;
  const v = Number(
    (m[4] || "0").replaceAll(",", "") + (m[5] || "") + (m[6] ? "e" + m[6] : ""),
  );
  if (!Number.isFinite(v)) return null;
  return (m[1] || m[3]) === "-" ? -v : v;
}
const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/;
const SLASHED = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;
// ISO dates and times ("2026-03-05", "2026-03-05T14:30:00Z", "2026-03"),
// and "2026/3/5". Times without a zone are read as UTC. Returns
// { t: epoch ms, time: whether it had a time of day } or null.
export function parseDate(s) {
  const v = String(s).trim();
  let m = ISO.exec(v),
    y,
    mo,
    d,
    h = 0,
    mi = 0,
    sec = 0,
    ms = 0,
    zone = null,
    time = false;
  if (m) {
    [y, mo, d] = [m[1], m[2], m[3]].map(Number);
    if (m[4] !== undefined) {
      time = true;
      [h, mi] = [Number(m[4]), Number(m[5])];
      sec = m[6] ? Number(m[6]) : 0;
      ms = m[7] ? Number(m[7].padEnd(3, "0")) : 0;
      zone = m[8] || null;
    }
  } else if ((m = SLASHED.exec(v))) [y, mo, d] = [m[1], m[2], m[3]].map(Number);
  else if ((m = MONTH.exec(v))) [y, mo, d] = [Number(m[1]), Number(m[2]), 1];
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59)
    return null;
  let t = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d
  )
    return null;
  if (zone && zone !== "Z") {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    t -= (z[1] === "-" ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3])) * 60000;
  }
  return { t, time };
}
export function parseBoolean(s) {
  const b = BOOLEANS.get(String(s).trim().toLowerCase());
  return b === undefined ? null : b;
}
const isNullish = (v) => NULLISH.has(v.toLowerCase());

// A column's type from its distinct non-empty values: boolean, number or
// date when every value (ignoring "NA", "null" and the like) reads as one,
// otherwise text. Returns { type, time }.
export function inferType(values) {
  let seen = 0,
    bool = true,
    num = true,
    date = true,
    time = false;
  for (const v of values) {
    if (isNullish(v)) continue;
    seen++;
    if (bool && parseBoolean(v) === null) bool = false;
    if (num && parseNumber(v) === null) num = false;
    if (date) {
      const d = parseDate(v);
      if (!d) date = false;
      else if (d.time) time = true;
    }
    if (!bool && !num && !date) break;
  }
  if (!seen) return { type: "text", time: false };
  if (bool) return { type: "boolean", time: false };
  if (num) return { type: "number", time: false };
  if (date) return { type: "date", time };
  return { type: "text", time: false };
}

// ---- Loading a sheet ----

const clip = (s) =>
  s.length > LIMITS.cell ? s.slice(0, LIMITS.cell - 1) + "…" : s;
const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, " ");
const cellText = (v) =>
  v === null || v === undefined
    ? ""
    : typeof v === "string"
      ? v
      : typeof v === "number" || typeof v === "boolean"
        ? String(v)
        : JSON.stringify(v);

class SheetError extends Error {}
export const tooManyRows = () =>
  new SheetError(
    `This sheet has more than ${MAX_ROWS.toLocaleString("en-US")} rows. Split it into smaller files and open one at a time.`,
  );

// Rows are dictionary-encoded as they're read (each distinct value kept
// once), so types are inferred from the distinct values only, and a large
// sheet needs little more memory than its codes.
function createBuilder(header) {
  const names = headerNames(header);
  if (names.length > MAX_COLUMNS)
    throw new SheetError(
      `This sheet has more than ${MAX_COLUMNS} columns. Remove some and try again.`,
    );
  let capacity = 1024,
    rows = 0,
    extra = 0;
  const cols = names.map((name) => ({
    name,
    index: new Map(),
    values: [],
    codes: new Int32Array(capacity),
  }));
  const samples = [];
  return {
    add(fields) {
      if (fields.length === 1 && !String(fields[0]).trim()) return;
      if (rows >= MAX_ROWS) throw tooManyRows();
      if (rows === capacity) {
        capacity *= 2;
        for (const c of cols) {
          const next = new Int32Array(capacity);
          next.set(c.codes);
          c.codes = next;
        }
      }
      if (fields.length > cols.length) extra++;
      for (let j = 0; j < cols.length; j++) {
        const c = cols[j];
        const v = fields[j] === undefined ? "" : String(fields[j]).trim();
        let code = -1;
        if (v !== "") {
          code = c.index.get(v);
          if (code === undefined) {
            code = c.values.length;
            c.values.push(v);
            c.index.set(v, code);
          }
        }
        c.codes[rows] = code;
      }
      if (samples.length < LIMITS.samples)
        samples.push(
          cols.map((_, j) =>
            clip(
              clean(fields[j] === undefined ? "" : String(fields[j]).trim()),
            ),
          ),
        );
      rows++;
    },
    finish(name, warnings) {
      if (!rows)
        throw new SheetError("This sheet has column names but no rows.");
      if (extra) warnings.push({ key: "extra", count: extra });
      const columns = cols.map((c) => {
        const { type, time } = inferType(c.values);
        const codes = c.codes.subarray(0, rows);
        if (type === "text")
          return {
            name: c.name,
            type,
            distinct: c.values.length,
            codes,
            dict: c.values,
          };
        const parse =
          type === "number"
            ? (v) => parseNumber(v) ?? NaN
            : type === "date"
              ? (v) => parseDate(v)?.t ?? NaN
              : (v) => {
                  const b = parseBoolean(v);
                  return b === null ? -1 : b ? 1 : 0;
                };
        const parsed = c.values.map((v) =>
          isNullish(v) ? (type === "boolean" ? -1 : NaN) : parse(v),
        );
        const data =
          type === "boolean" ? new Int8Array(rows) : new Float64Array(rows);
        for (let i = 0; i < rows; i++) {
          const code = codes[i];
          data[i] = code < 0 ? (type === "boolean" ? -1 : NaN) : parsed[code];
        }
        return {
          name: c.name,
          type,
          ...(type === "date" ? { time } : {}),
          data,
        };
      });
      return { name, rows, columns, samples, warnings };
    },
  };
}
function jsonRecords(text) {
  let data;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new SheetError(
      "This JSON file couldn't be read. Check that it's valid JSON.",
    );
  }
  if (!Array.isArray(data) || !data.length)
    throw new SheetError("A JSON sheet must be a list of rows.");
  if (data.every(Array.isArray))
    return {
      header: data[0].map(cellText),
      rows: data.slice(1).map((r) => r.map(cellText)),
    };
  if (data.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
    const keys = [],
      seen = new Set();
    for (const r of data)
      for (const k of Object.keys(r))
        if (!seen.has(k)) {
          seen.add(k);
          keys.push(k);
          if (keys.length > MAX_COLUMNS)
            throw new SheetError(
              `This sheet has more than ${MAX_COLUMNS} columns. Remove some and try again.`,
            );
        }
    return {
      header: keys,
      rows: data.map((r) => keys.map((k) => cellText(r[k]))),
    };
  }
  throw new SheetError(
    "A JSON sheet must be a list of objects or a list of arrays.",
  );
}
// A whole file's text becomes a sheet: { name, rows, columns, samples,
// warnings }. The first row (or the JSON keys) names the columns.
export function loadSheet(
  text,
  { name = "sheet.csv", kind = sheetKind(name) } = {},
) {
  if (kind === "workbook")
    throw new SheetError(
      "Sheets reads CSV, TSV and JSON files. Save the workbook as CSV first.",
    );
  const warnings = [];
  if (kind === "json") {
    const { header, rows } = jsonRecords(text);
    if (rows.length > MAX_ROWS) throw tooManyRows();
    const b = createBuilder(header);
    for (const r of rows) b.add(r);
    return b.finish(name, warnings);
  }
  const delimiter = detectDelimiter(text, kind);
  let builder = null;
  const { unterminated } = forEachRecord(text, delimiter, (fields) => {
    if (builder) builder.add(fields);
    else if (fields.length > 1 || String(fields[0]).trim())
      builder = createBuilder(fields);
  });
  if (!builder) throw new SheetError("This file is empty.");
  if (unterminated) warnings.push({ key: "unterminated" });
  const sheet = builder.finish(name, warnings);
  sheet.delimiter = delimiter;
  return sheet;
}
// What a model may learn about the sheet: its size, column names and types,
// and for text columns how many different values each has. No cells.
export function sheetProfile(sheet) {
  return {
    rows: sheet.rows,
    columns: sheet.columns.map((c) =>
      c.type === "text"
        ? { name: c.name, type: c.type, distinct: c.distinct }
        : { name: c.name, type: c.type },
    ),
  };
}

// ---- The query plan: checked strictly against the real columns ----

const plainObject = (v) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const TOP_KEYS = [
  "title",
  "filters",
  "groupBy",
  "aggregates",
  "sort",
  "limit",
  "chart",
];
const ORDERED = new Set([">", ">=", "<", "<=", "between"]);
export const DEFAULT_LIST_LIMIT = 100;
const q = (s) => JSON.stringify(s);

// Validates a model's plan against `columns` (as the model saw them).
// Returns { spec } with columns referenced by position, or { problems }:
// short English sentences, sent back to the model for its one retry.
export function validateSpec(raw, columns) {
  const problems = [];
  const bad = (m) => {
    if (problems.length < LIMITS.problems)
      problems.push(m.slice(0, LIMITS.problem));
  };
  if (!plainObject(raw))
    return { problems: ["The reply must be one JSON object."] };
  for (const k of Object.keys(raw))
    if (!TOP_KEYS.includes(k))
      bad(`Unknown field ${q(k)}. Use only ${TOP_KEYS.join(", ")}.`);
  const byName = new Map(columns.map((c, i) => [c.name, i]));
  const column = (name, where) => {
    if (typeof name !== "string" || !byName.has(name)) {
      bad(`${where}: ${q(name)} isn't a column.`);
      return -1;
    }
    return byName.get(name);
  };
  const list = (v, key, max) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      bad(`${q(key)} must be a list.`);
      return [];
    }
    if (v.length > max) bad(`${q(key)} can have at most ${max} entries.`);
    return v.slice(0, max);
  };
  const spec = {
    title: null,
    filters: [],
    groupBy: [],
    aggregates: [],
    sort: [],
    limit: null,
    chart: { type: "table" },
  };
  if (raw.title !== undefined) {
    if (
      typeof raw.title !== "string" ||
      !raw.title.trim() ||
      raw.title.length > LIMITS.title
    )
      bad(`"title" must be text of at most ${LIMITS.title} characters.`);
    else spec.title = clean(raw.title).trim();
  }
  // A filter value, normalised for its column's type.
  const valueFor = (col, v, where) => {
    const type = columns[col].type;
    if (type === "number") {
      const n =
        typeof v === "number"
          ? Number.isFinite(v)
            ? v
            : null
          : typeof v === "string"
            ? parseNumber(v)
            : null;
      if (n === null)
        bad(
          `${where}: ${q(columns[col].name)} is a number column, so the value must be a number.`,
        );
      return n;
    }
    if (type === "date") {
      const d = typeof v === "string" ? parseDate(v) : null;
      if (!d)
        bad(
          `${where}: ${q(columns[col].name)} is a date column, so the value must be a date like "2026-01-31".`,
        );
      return d ? { t: d.t, day: !d.time, text: v.trim() } : null;
    }
    if (type === "boolean") {
      const b =
        typeof v === "boolean"
          ? v
          : typeof v === "string"
            ? parseBoolean(v)
            : null;
      if (b === null)
        bad(
          `${where}: ${q(columns[col].name)} is a true/false column, so the value must be true or false.`,
        );
      return b;
    }
    if (
      (typeof v !== "string" && typeof v !== "number") ||
      String(v).length > 200
    ) {
      bad(`${where}: the value for ${q(columns[col].name)} must be text.`);
      return null;
    }
    return String(v);
  };
  for (const [i, f] of list(raw.filters, "filters", LIMITS.filters).entries()) {
    const where = `filters[${i}]`;
    if (
      !plainObject(f) ||
      Object.keys(f).some((k) => !["col", "op", "value"].includes(k))
    ) {
      bad(`${where} must be {"col", "op", "value"}.`);
      continue;
    }
    const col = column(f.col, where);
    if (!OPS.includes(f.op)) {
      bad(`${where}: unknown op ${q(f.op)}. Use one of ${OPS.join(" ")}.`);
      continue;
    }
    if (col < 0) continue;
    const type = columns[col].type;
    if (f.value === null) {
      if (f.op !== "=" && f.op !== "!=")
        bad(`${where}: null works only with = and !=.`);
      else spec.filters.push({ col, op: f.op, value: null });
      continue;
    }
    if (ORDERED.has(f.op) && type !== "number" && type !== "date") {
      bad(
        `${where}: ${f.op} needs a number or date column; ${q(columns[col].name)} is ${type}.`,
      );
      continue;
    }
    if (f.op === "contains") {
      if (type !== "text")
        bad(
          `${where}: contains needs a text column; ${q(columns[col].name)} is ${type}.`,
        );
      else if (typeof f.value !== "string" || !f.value || f.value.length > 200)
        bad(`${where}: contains needs text to look for.`);
      else spec.filters.push({ col, op: "contains", value: f.value });
      continue;
    }
    if (f.op === "in") {
      if (
        !Array.isArray(f.value) ||
        !f.value.length ||
        f.value.length > LIMITS.inValues
      ) {
        bad(`${where}: "in" needs a list of 1 to ${LIMITS.inValues} values.`);
        continue;
      }
      const values = f.value.map((v) => valueFor(col, v, where));
      if (!values.includes(null))
        spec.filters.push({ col, op: "in", value: values });
      continue;
    }
    if (f.op === "between") {
      if (!Array.isArray(f.value) || f.value.length !== 2) {
        bad(`${where}: "between" needs [low, high].`);
        continue;
      }
      const [lo, hi] = f.value.map((v) => valueFor(col, v, where));
      if (lo === null || hi === null) continue;
      if (type === "date" ? lo.t > hi.t : lo > hi)
        bad(`${where}: the low value is above the high one.`);
      else spec.filters.push({ col, op: "between", value: [lo, hi] });
      continue;
    }
    const value = valueFor(col, f.value, where);
    if (value !== null) spec.filters.push({ col, op: f.op, value });
  }
  const outputs = [];
  const output = (name, type, where) => {
    if (outputs.some((o) => o.name === name))
      bad(`${where}: the output name ${q(name)} is used twice.`);
    outputs.push({ name, type });
  };
  for (const [i, g] of list(raw.groupBy, "groupBy", LIMITS.groupBy).entries()) {
    const where = `groupBy[${i}]`;
    if (typeof g === "string") {
      const col = column(g, where);
      if (col >= 0) {
        spec.groupBy.push({ col, bucket: null });
        output(columns[col].name, columns[col].type, where);
      }
    } else if (
      plainObject(g) &&
      !Object.keys(g).some((k) => !["col", "bucket"].includes(k))
    ) {
      const col = column(g.col, where);
      if (col < 0) continue;
      if (g.bucket === undefined) {
        spec.groupBy.push({ col, bucket: null });
        output(columns[col].name, columns[col].type, where);
      } else if (columns[col].type !== "date")
        bad(`${where}: a bucket needs a date column.`);
      else if (!BUCKETS.includes(g.bucket))
        bad(`${where}: bucket must be one of ${BUCKETS.join(", ")}.`);
      else {
        spec.groupBy.push({ col, bucket: g.bucket });
        output(columns[col].name, "period", where);
      }
    } else bad(`${where} must be a column name or {"col", "bucket"}.`);
  }
  for (const [i, a] of list(
    raw.aggregates,
    "aggregates",
    LIMITS.aggregates,
  ).entries()) {
    const where = `aggregates[${i}]`;
    if (
      !plainObject(a) ||
      Object.keys(a).some((k) => !["fn", "col", "as"].includes(k))
    ) {
      bad(`${where} must be {"fn", "col", "as"}.`);
      continue;
    }
    if (!FNS.includes(a.fn)) {
      bad(`${where}: unknown fn ${q(a.fn)}. Use one of ${FNS.join(", ")}.`);
      continue;
    }
    let col = null;
    if (a.col !== undefined && a.col !== null) {
      col = column(a.col, where);
      if (col < 0) continue;
    } else if (a.fn !== "count") {
      bad(`${where}: ${a.fn} needs a column.`);
      continue;
    }
    const type = col === null ? null : columns[col].type;
    if (["sum", "avg", "median"].includes(a.fn) && type !== "number") {
      bad(
        `${where}: ${a.fn} needs a number column; ${q(columns[col].name)} is ${type}.`,
      );
      continue;
    }
    if (["min", "max"].includes(a.fn) && type !== "number" && type !== "date") {
      bad(
        `${where}: ${a.fn} needs a number or date column; ${q(columns[col].name)} is ${type}.`,
      );
      continue;
    }
    let as = null;
    if (a.as !== undefined) {
      if (
        typeof a.as !== "string" ||
        !a.as.trim() ||
        a.as.length > LIMITS.alias
      ) {
        bad(
          `${where}: "as" must be a name of at most ${LIMITS.alias} characters.`,
        );
        continue;
      }
      as = clean(a.as).trim();
    }
    spec.aggregates.push({ fn: a.fn, col, as });
    output(
      as ?? defaultAlias(a.fn, col === null ? null : columns[col].name),
      ["min", "max"].includes(a.fn) ? type : "number",
      where,
    );
  }
  const listing = !spec.groupBy.length && !spec.aggregates.length;
  // Grouping with nothing to calculate counts the rows in each group.
  if (spec.groupBy.length && !spec.aggregates.length) {
    spec.aggregates.push({ fn: "count", col: null, as: null });
    output(defaultAlias("count", null), "number", "groupBy");
  }
  const names = listing
    ? columns.map((c) => ({ name: c.name, type: c.type }))
    : outputs;
  const outIndex = (name, where) => {
    const k = names.findIndex((o) => o.name === name);
    if (k < 0)
      bad(
        `${where}: ${q(name)} isn't ${listing ? "a column" : "an output name"}. Use one of: ${names
          .map((o) => q(o.name))
          .join(", ")
          .slice(0, 200)}.`,
      );
    return k;
  };
  for (const [i, s] of list(raw.sort, "sort", LIMITS.sort).entries()) {
    const where = `sort[${i}]`;
    if (
      !plainObject(s) ||
      Object.keys(s).some((k) => !["by", "dir"].includes(k))
    ) {
      bad(`${where} must be {"by", "dir"}.`);
      continue;
    }
    const by = outIndex(s.by, where);
    const dir = s.dir === undefined ? "asc" : s.dir;
    if (dir !== "asc" && dir !== "desc")
      bad(`${where}: dir must be "asc" or "desc".`);
    else if (by >= 0) spec.sort.push({ by, dir });
  }
  if (raw.limit !== undefined) {
    if (
      !Number.isInteger(raw.limit) ||
      raw.limit < 1 ||
      raw.limit > LIMITS.resultLimit
    )
      bad(`"limit" must be a whole number from 1 to ${LIMITS.resultLimit}.`);
    else spec.limit = raw.limit;
  }
  if (raw.chart !== undefined) {
    const c = raw.chart;
    if (
      !plainObject(c) ||
      Object.keys(c).some((k) => !["type", "x", "y"].includes(k))
    )
      bad(`"chart" must be {"type", "x", "y"}.`);
    else if (!CHARTS.includes(c.type))
      bad(`chart type must be one of ${CHARTS.join(", ")}.`);
    else if (c.type !== "table") {
      const x = outIndex(c.x, "chart.x"),
        y = outIndex(c.y, "chart.y");
      if (y >= 0 && names[y].type !== "number")
        bad(`chart.y: ${q(c.y)} must be a number, not ${names[y].type}.`);
      else if (x >= 0 && y >= 0) spec.chart = { type: c.type, x, y };
    }
  }
  if (problems.length) return { problems };
  return { spec: { ...spec, listing } };
}
export const defaultAlias = (fn, colName) =>
  fn === "count" && colName === null ? "count" : `${fn}(${colName})`;

// Pulls the JSON object out of a reply (models sometimes wrap it in a code
// fence despite being asked not to). Returns undefined when there's none.
export function extractJSON(text) {
  let t = String(text ?? "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{"),
    end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
// A reply read as a plan: { spec }, { refusal } (the model's own "can't be
// answered from these columns"), or { problems }.
export function interpretReply(text, columns) {
  const obj = extractJSON(text);
  if (obj === undefined)
    return { problems: ["The reply wasn't a single JSON object."] };
  if (
    plainObject(obj) &&
    Object.keys(obj).length === 1 &&
    typeof obj.error === "string"
  )
    return {
      refusal:
        obj.error.trim().slice(0, 300) || "The model couldn't plan this.",
    };
  return validateSpec(obj, columns);
}
// Veil: the model saw masked names and values, so its plan's text is
// unmasked in this browser before it runs. Columns are referenced by
// position, which masking doesn't change.
export function realizeSpec(spec, unmask = (s) => s) {
  const text = (v) => (typeof v === "string" ? unmask(v) : v);
  return {
    ...spec,
    title: text(spec.title),
    aggregates: spec.aggregates.map((a) => ({ ...a, as: text(a.as) })),
    filters: spec.filters.map((f) => ({
      ...f,
      value: Array.isArray(f.value) ? f.value.map(text) : text(f.value),
    })),
  };
}

// ---- Running a plan on the sheet ----

const DAY = 86400000;
const pad = (n, w = 2) => String(n).padStart(w, "0");
export function isoDate(t, withTime = false) {
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  if (withTime) return d.toISOString().replace(".000Z", "Z");
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export function bucketOf(t, bucket) {
  if (!Number.isFinite(t)) return null;
  const d = new Date(t),
    y = pad(d.getUTCFullYear(), 4),
    m = d.getUTCMonth();
  if (bucket === "year") return y;
  if (bucket === "quarter") return `${y}-Q${Math.floor(m / 3) + 1}`;
  if (bucket === "month") return `${y}-${pad(m + 1)}`;
  return isoDate(t);
}
// One cell as shown in a result: a number, text, true/false, an ISO date,
// or null for an empty cell.
function cellValue(col, i) {
  if (col.type === "text") {
    const code = col.codes[i];
    return code < 0 ? null : col.dict[code];
  }
  const v = col.data[i];
  if (col.type === "boolean") return v < 0 ? null : v === 1;
  if (!Number.isFinite(v)) return null;
  return col.type === "date" ? isoDate(v, col.time) : v;
}
// A row test for one filter. Text matches ignore case and surrounding
// spaces; a date given without a time matches that whole (UTC) day.
function filterTest(col, f) {
  if (f.value === null) {
    const empty =
      col.type === "text"
        ? (i) => col.codes[i] < 0
        : col.type === "boolean"
          ? (i) => col.data[i] < 0
          : (i) => !Number.isFinite(col.data[i]);
    return f.op === "=" ? empty : (i) => !empty(i);
  }
  if (col.type === "text") {
    const norm = (s) => String(s).trim().toLowerCase();
    const lower = col.dict.map((s) => s.toLowerCase());
    let match;
    if (f.op === "contains") {
      const needle = norm(f.value);
      match = lower.map((s) => s.includes(needle));
    } else {
      const wanted = new Set((f.op === "in" ? f.value : [f.value]).map(norm));
      match = lower.map((s) => wanted.has(s));
      if (f.op === "!=") match = match.map((m) => !m);
    }
    const hit = Uint8Array.from(match, Number);
    return (i) => {
      const code = col.codes[i];
      return code >= 0 && hit[code] === 1;
    };
  }
  if (col.type === "boolean") {
    const wanted = new Set(
      (f.op === "in" ? f.value : [f.value]).map((b) => (b ? 1 : 0)),
    );
    return f.op === "!="
      ? (i) => col.data[i] >= 0 && !wanted.has(col.data[i])
      : (i) => wanted.has(col.data[i]);
  }
  // Numbers and dates: the values that pass lie in a range. A date given
  // without a time covers its whole (UTC) day.
  const inRange =
    (lo, hi, loOpen = false, hiOpen = false) =>
    (i) => {
      const x = col.data[i];
      return (
        Number.isFinite(x) &&
        (loOpen ? x > lo : x >= lo) &&
        (hiOpen ? x < hi : x <= hi)
      );
    };
  const date = col.type === "date";
  // [start, end, whether end is excluded] of one value.
  const span = (v) =>
    date ? (v.day ? [v.t, v.t + DAY, true] : [v.t, v.t, false]) : [v, v, false];
  const equal = (v) => {
    const [a, b, open] = span(v);
    return inRange(a, b, false, open);
  };
  switch (f.op) {
    case "=":
      return equal(f.value);
    case "!=": {
      const eq = equal(f.value);
      return (i) => Number.isFinite(col.data[i]) && !eq(i);
    }
    case ">": {
      const [, b, open] = span(f.value);
      return inRange(b, Infinity, !open);
    }
    case ">=":
      return inRange(span(f.value)[0], Infinity);
    case "<":
      return inRange(-Infinity, span(f.value)[0], false, true);
    case "<=": {
      const [, b, open] = span(f.value);
      return inRange(-Infinity, b, false, open);
    }
    case "between": {
      const [, b, open] = span(f.value[1]);
      return inRange(span(f.value[0])[0], b, false, open);
    }
    case "in": {
      const tests = f.value.map(equal);
      return (i) => tests.some((t) => t(i));
    }
  }
  return () => false;
}
const collator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});
// Nulls last in either direction.
function compareValues(a, b) {
  if (a === null || a === undefined)
    return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean")
    return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}
function sortRows(rows, sort) {
  if (!sort.length) return rows;
  return rows.sort((r1, r2) => {
    for (const { by, dir } of sort) {
      const a = r1[by],
        b = r2[by];
      if (a === null || b === null) {
        const c = compareValues(a, b);
        if (c) return c;
        continue;
      }
      const c = compareValues(a, b);
      if (c) return dir === "desc" ? -c : c;
    }
    return 0;
  });
}
// Drops floating-point noise from sums (0.1 + 0.2 → 0.3).
const tidy = (v) =>
  typeof v === "number" && Number.isFinite(v) ? Number(v.toPrecision(15)) : v;
function median(values) {
  if (!values.length) return null;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// An aggregate's running state for one group.
function accumulator(fn, col) {
  let n = 0,
    sum = 0,
    min = Infinity,
    max = -Infinity;
  const values = fn === "median" ? [] : null;
  const seen = fn === "distinct" ? new Set() : null;
  const present =
    col === null
      ? () => true
      : col.type === "text"
        ? (i) => col.codes[i] >= 0
        : col.type === "boolean"
          ? (i) => col.data[i] >= 0
          : (i) => Number.isFinite(col.data[i]);
  return {
    add(i) {
      if (!present(i)) return;
      n++;
      if (seen) seen.add(col.type === "text" ? col.codes[i] : col.data[i]);
      else if (col && col.type !== "text" && col.type !== "boolean") {
        const v = col.data[i];
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
        values?.push(v);
      }
    },
    value() {
      switch (fn) {
        case "count":
          return n;
        case "distinct":
          return seen.size;
        case "sum":
          return tidy(sum);
        case "avg":
          return n ? tidy(sum / n) : null;
        case "median":
          return tidy(median(values));
        case "min":
        case "max": {
          const v = fn === "min" ? min : max;
          if (!n) return null;
          return col.type === "date" ? isoDate(v, col.time) : v;
        }
      }
      return null;
    },
  };
}
function groupKey(col, bucket, i) {
  if (col.type === "text") return col.codes[i];
  const v = col.data[i];
  if (col.type === "boolean") return v;
  if (!Number.isFinite(v)) return null;
  if (col.type === "date") return bucket ? bucketOf(v, bucket) : v;
  return v;
}
function groupLabel(col, bucket, key) {
  if (key === null) return null;
  if (col.type === "text") return key < 0 ? null : col.dict[key];
  if (col.type === "boolean") return key < 0 ? null : key === 1;
  if (col.type === "date") return bucket ? key : isoDate(key, col.time);
  return key;
}
// The names of a plan's output columns, in order, with their types.
export function outputColumns(spec, columns) {
  if (spec.listing) return columns.map((c) => ({ name: c.name, type: c.type }));
  return [
    ...spec.groupBy.map((g) => ({
      name: columns[g.col].name,
      type: g.bucket ? "period" : columns[g.col].type,
    })),
    ...spec.aggregates.map((a) => ({
      name:
        a.as ?? defaultAlias(a.fn, a.col === null ? null : columns[a.col].name),
      type: ["min", "max"].includes(a.fn) ? columns[a.col].type : "number",
    })),
  ];
}
// Runs a checked (and realized) plan. Returns { columns, rows, stats }.
export function runSpec(sheet, spec) {
  const cols = sheet.columns,
    n = sheet.rows;
  const tests = spec.filters.map((f) => filterTest(cols[f.col], f));
  let kept = new Int32Array(n),
    matched = 0;
  for (let i = 0; i < n; i++) {
    let ok = true;
    for (const t of tests)
      if (!t(i)) {
        ok = false;
        break;
      }
    if (ok) kept[matched++] = i;
  }
  kept = kept.subarray(0, matched);
  const columns = outputColumns(spec, cols);
  let rows, groups;
  if (spec.listing) {
    const limit = spec.limit ?? DEFAULT_LIST_LIMIT;
    let order = kept;
    if (spec.sort.length) {
      // Text columns compare by the rank of each distinct value.
      const ranks = spec.sort.map(({ by }) => {
        const c = cols[by];
        if (c.type !== "text") return null;
        const order = c.dict
          .map((_, k) => k)
          .sort((a, b) => collator.compare(c.dict[a], c.dict[b]));
        const rank = new Int32Array(c.dict.length);
        order.forEach((k, r) => (rank[k] = r));
        return rank;
      });
      const key = (s, i) => {
        const c = cols[spec.sort[s].by];
        if (c.type === "text")
          return c.codes[i] < 0 ? null : ranks[s][c.codes[i]];
        if (c.type === "boolean") return c.data[i] < 0 ? null : c.data[i];
        return Number.isFinite(c.data[i]) ? c.data[i] : null;
      };
      order = Array.from(kept).sort((i, j) => {
        for (let s = 0; s < spec.sort.length; s++) {
          const a = key(s, i),
            b = key(s, j);
          if (a === null || b === null) {
            if (a === b) continue;
            return a === null ? 1 : -1;
          }
          if (a !== b) return spec.sort[s].dir === "desc" ? b - a : a - b;
        }
        return i - j;
      });
    }
    groups = matched;
    rows = [];
    for (let k = 0; k < order.length && rows.length < limit; k++)
      rows.push(cols.map((c) => cellValue(c, order[k])));
  } else {
    const make = () =>
      spec.aggregates.map((a) =>
        accumulator(a.fn, a.col === null ? null : cols[a.col]),
      );
    const map = new Map();
    if (!spec.groupBy.length) map.set("", { keys: [], acc: make() });
    const single = spec.groupBy.length === 1 ? spec.groupBy[0] : null;
    for (let k = 0; k < kept.length; k++) {
      const i = kept[k];
      let key, keys;
      if (!spec.groupBy.length) key = "";
      else if (single) key = groupKey(cols[single.col], single.bucket, i);
      else {
        keys = spec.groupBy.map((g) => groupKey(cols[g.col], g.bucket, i));
        key = JSON.stringify(keys);
      }
      let g = map.get(key);
      if (!g) {
        g = { keys: keys ?? [key], acc: make() };
        map.set(key, g);
      }
      for (const a of g.acc) a.add(i);
    }
    groups = map.size;
    rows = [...map.values()].map((g) => [
      ...spec.groupBy.map((gb, j) =>
        groupLabel(cols[gb.col], gb.bucket, g.keys[j]),
      ),
      ...g.acc.map((a) => a.value()),
    ]);
    // Groups in their natural order, then the plan's own sort.
    if (spec.groupBy.length)
      rows.sort((a, b) => {
        for (let j = 0; j < spec.groupBy.length; j++) {
          const c = compareValues(a[j], b[j]);
          if (c) return c;
        }
        return 0;
      });
    sortRows(rows, spec.sort);
    rows = rows.slice(0, spec.limit ?? LIMITS.resultLimit);
  }
  return {
    columns,
    rows,
    stats: {
      total: n,
      matched,
      groups,
      shown: rows.length,
      truncated: groups > rows.length,
    },
  };
}

// ---- Plain words: "How this was calculated" ----

const fmt = (v) =>
  typeof v === "number"
    ? formatNumber(v)
    : v && typeof v === "object" && "t" in v
      ? v.text
      : String(v);
const OP_WORDS = {
  en: {
    "=": "is",
    "!=": "isn't",
    ">": "is more than",
    ">=": "is at least",
    "<": "is less than",
    "<=": "is at most",
    contains: "contains",
    in: "is",
    between: "is between",
    empty: "is empty",
    filled: "isn't empty",
    after: "is after",
    onOrAfter: "is on or after",
    before: "is before",
    onOrBefore: "is on or before",
  },
  zh: {
    "=": "为",
    "!=": "不为",
    ">": "大于",
    ">=": "不小于",
    "<": "小于",
    "<=": "不大于",
    contains: "包含",
    in: "为",
    between: "介于",
    empty: "为空",
    filled: "不为空",
    after: "晚于",
    onOrAfter: "不早于",
    before: "早于",
    onOrBefore: "不晚于",
  },
};
const FN_WORDS = {
  en: {
    count: (c) =>
      c === null
        ? ["the number of rows"]
        : ["the number of filled ", { v: c }, " cells"],
    sum: (c) => ["the sum of ", { v: c }],
    avg: (c) => ["the average of ", { v: c }],
    min: (c) => ["the smallest ", { v: c }],
    max: (c) => ["the largest ", { v: c }],
    median: (c) => ["the median of ", { v: c }],
    distinct: (c) => ["the number of different ", { v: c }, " values"],
  },
  zh: {
    count: (c) => (c === null ? ["行数"] : [{ v: c }, " 的非空单元格数"]),
    sum: (c) => [{ v: c }, " 的总和"],
    avg: (c) => [{ v: c }, " 的平均值"],
    min: (c) => [{ v: c }, " 的最小值"],
    max: (c) => [{ v: c }, " 的最大值"],
    median: (c) => [{ v: c }, " 的中位数"],
    distinct: (c) => [{ v: c }, " 的不同值数量"],
  },
};
const BUCKET_WORDS = {
  en: {
    day: " (by day)",
    month: " (by month)",
    quarter: " (by quarter)",
    year: " (by year)",
  },
  zh: {
    day: "（按日）",
    month: "（按月）",
    quarter: "（按季度）",
    year: "（按年）",
  },
};
const joinParts = (items, sep, last = sep) =>
  items.flatMap((x, i) =>
    !i ? x : [i === items.length - 1 ? last : sep, ...x],
  );
const count = (n) => n.toLocaleString("en-US");
// Each line is a list of parts: plain strings (already in `lang`), and
// { v } for a column name or value, which is shown as written.
export function describeSpec(spec, columns, stats, lang = "en") {
  const zh = lang === "zh";
  const ops = OP_WORDS[zh ? "zh" : "en"];
  const lines = [];
  const cond = (f) => {
    const col = columns[f.col],
      name = { v: col.name };
    if (f.value === null)
      return [name, " ", f.op === "=" ? ops.empty : ops.filled];
    let op = ops[f.op];
    if (col.type === "date")
      op =
        {
          ">": ops.after,
          ">=": ops.onOrAfter,
          "<": ops.before,
          "<=": ops.onOrBefore,
        }[f.op] ?? op;
    if (f.op === "between")
      return zh
        ? [
            name,
            " 介于 ",
            { v: fmt(f.value[0]) },
            " 和 ",
            { v: fmt(f.value[1]) },
            " 之间",
          ]
        : [
            name,
            " is between ",
            { v: fmt(f.value[0]) },
            " and ",
            { v: fmt(f.value[1]) },
          ];
    if (f.op === "in")
      return [
        name,
        ` ${op} `,
        ...joinParts(
          f.value.map((v) => [{ v: fmt(v) }]),
          zh ? " 或 " : " or ",
        ),
      ];
    return [name, ` ${op} `, { v: fmt(f.value) }];
  };
  if (!spec.filters.length)
    lines.push(
      zh
        ? [`使用了全部 ${count(stats.total)} 行。`]
        : [`Used all ${count(stats.total)} rows.`],
    );
  else {
    const conds = joinParts(spec.filters.map(cond), zh ? "，且 " : " and ");
    lines.push(
      zh
        ? [
            `在 ${count(stats.total)} 行中保留了 `,
            ...conds,
            ` 的 ${count(stats.matched)} 行。`,
          ]
        : [
            `Kept the ${count(stats.matched)} of ${count(stats.total)} rows where `,
            ...conds,
            ".",
          ],
    );
  }
  if (spec.listing) lines.push([zh ? "列出了这些行。" : "Listed those rows."]);
  else {
    if (spec.groupBy.length) {
      const by = joinParts(
        spec.groupBy.map((g) => [
          { v: columns[g.col].name },
          ...(g.bucket ? [BUCKET_WORDS[zh ? "zh" : "en"][g.bucket]] : []),
        ]),
        zh ? "、" : ", ",
      );
      lines.push(
        zh
          ? ["按 ", ...by, ` 分组，共 ${count(stats.groups)} 组。`]
          : [
              "Grouped them by ",
              ...by,
              `: ${count(stats.groups)} ${stats.groups === 1 ? "group" : "groups"}.`,
            ],
      );
    }
    const calc = joinParts(
      spec.aggregates.map((a) => {
        const words = FN_WORDS[zh ? "zh" : "en"][a.fn](
          a.col === null ? null : columns[a.col].name,
        );
        return a.as
          ? [
              ...words,
              zh ? "（显示为 " : " (shown as ",
              { v: a.as },
              zh ? "）" : ")",
            ]
          : words;
      }),
      zh ? "、" : ", ",
      zh ? "和" : " and ",
    );
    lines.push(
      zh
        ? [spec.groupBy.length ? "为每组计算了 " : "计算了 ", ...calc, "。"]
        : [
            "Calculated ",
            ...calc,
            spec.groupBy.length ? " for each group." : ".",
          ],
    );
  }
  if (spec.sort.length) {
    const names = outputColumns(spec, columns);
    const by = joinParts(
      spec.sort.map((s) => [
        { v: names[s.by].name },
        zh
          ? s.dir === "desc"
            ? " 降序排列"
            : " 升序排列"
          : s.dir === "desc"
            ? ", largest first"
            : ", smallest first",
      ]),
      zh ? "，然后按 " : ", then by ",
    );
    lines.push(zh ? ["按 ", ...by, "。"] : ["Sorted by ", ...by, "."]);
  }
  if (stats.truncated)
    lines.push([
      zh
        ? `显示了 ${count(stats.groups)} 行中的前 ${count(stats.shown)} 行。`
        : `Showing the first ${count(stats.shown)} of ${count(stats.groups)} rows.`,
    ]);
  lines.push([
    zh
      ? "全部在本设备上计算：AI 只规划了步骤，没有看到这些行。"
      : "All calculated on this device: the AI only planned the steps and never saw the rows.",
  ]);
  return lines;
}

// ---- Output ----

export function formatNumber(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  const abs = Math.abs(v);
  return v.toLocaleString("en-US", {
    maximumFractionDigits: abs >= 100 ? 2 : abs >= 1 ? 3 : 4,
  });
}
export function formatCompact(v) {
  const abs = Math.abs(v);
  const unit =
    abs >= 1e12
      ? [1e12, "T"]
      : abs >= 1e9
        ? [1e9, "B"]
        : abs >= 1e6
          ? [1e6, "M"]
          : abs >= 1e4
            ? [1e3, "k"]
            : null;
  if (!unit) return formatNumber(v);
  return (
    (v / unit[0]).toLocaleString("en-US", { maximumFractionDigits: 1 }) +
    unit[1]
  );
}
export const displayCell = (v) =>
  v === null || v === undefined
    ? ""
    : typeof v === "number"
      ? formatNumber(v)
      : typeof v === "boolean"
        ? v
          ? "true"
          : "false"
        : String(v);

// RFC 4180 CSV of a result. Text that a spreadsheet app would run as a
// formula (=, +, -, @ at the start) gets a leading apostrophe.
export function toCSV(result) {
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [
    result.columns.map((c) => cell(c.name)),
    ...result.rows.map((r) => r.map(cell)),
  ];
  return "﻿" + lines.map((l) => l.join(",")).join("\r\n") + "\r\n";
}
// "Nice" axis ticks from 0 (or the minimum, when it's negative) to max.
export function niceTicks(min, max, count = 5) {
  const lo = Math.min(0, min),
    hi = Math.max(0, max);
  if (lo === hi) return [0, 1];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(lo / step) * step,
    end = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step)
    ticks.push(Number(v.toPrecision(12)));
  return ticks;
}
// The points a chart draws: rows with a number in y, labelled by x.
export function chartSeries(result, chart, max = 40) {
  if (!chart || chart.type === "table") return null;
  const points = [];
  for (const r of result.rows) {
    const y = r[chart.y];
    if (typeof y !== "number" || !Number.isFinite(y)) continue;
    points.push({ label: displayCell(r[chart.x]) || "(blank)", value: y });
  }
  const cap = chart.type === "pie" ? 12 : max;
  return {
    type:
      chart.type === "pie" && points.some((p) => p.value < 0)
        ? "bar"
        : chart.type,
    x: result.columns[chart.x].name,
    y: result.columns[chart.y].name,
    points: points.slice(0, cap),
    hidden: Math.max(0, points.length - cap),
  };
}

// ---- What the model is sent ----

// A query's payload (see src/sheets-spec.js): the question and the profile,
// plus the first rows only when the user ticked "Also share 5 sample rows".
// `mask` is Veil (masking in this browser) or identity. Returns the payload
// and the columns as the model will see them, for checking its plan.
export function queryPayload(
  profile,
  question,
  { samples = null, mask = (s) => s } = {},
) {
  const columns = profile.columns.map((c) => ({ ...c, name: mask(c.name) }));
  const payload = {
    task: "query",
    question: mask(question.trim()),
    rows: profile.rows,
    columns,
  };
  if (samples?.length)
    payload.samples = samples
      .slice(0, LIMITS.samples)
      .map((row) => row.map((cell) => clip(mask(cell))));
  return { payload, columns };
}
// An explanation's payload: the question, the result's title and the result
// table (at most 50 rows and 12 columns), nothing else.
export function explainPayload(
  result,
  question,
  title,
  { mask = (s) => s } = {},
) {
  const width = Math.min(result.columns.length, LIMITS.resultColumns);
  const cell = (v) =>
    typeof v === "string"
      ? clip(clean(mask(v)))
      : typeof v === "number" && !Number.isFinite(v)
        ? null
        : v;
  const payload = {
    task: "explain",
    question: mask(question.trim()),
    result: {
      columns: result.columns
        .slice(0, width)
        .map((c) => clip(clean(mask(c.name)).trim()) || "(blank)"),
      rows: result.rows
        .slice(0, LIMITS.resultRows)
        .map((r) => r.slice(0, width).map(cell)),
      total: result.rows.length,
    },
  };
  if (title && clean(title).trim())
    payload.title = clip(clean(mask(title)).trim());
  return payload;
}
// Asks for a plan and checks it, with one repair attempt. `send(payload)`
// makes the model call and resolves to { text, receipt }. Resolves to
// { spec } | { refusal } | { problems }, plus `calls` (each call's receipt)
// and `text` (the last reply, as the model wrote it).
export async function planQuery({ send, payload, columns }) {
  const calls = [];
  const first = await send(payload);
  calls.push(first.receipt);
  let text = first.text,
    reply = interpretReply(text, columns);
  if (reply.problems) {
    const second = await send({
      ...payload,
      task: "repair",
      previous:
        String(first.text || "")
          .trim()
          .slice(0, LIMITS.previous) || "(an empty reply)",
      problems: reply.problems.slice(0, LIMITS.problems),
    });
    calls.push(second.receipt);
    text = second.text;
    reply = interpretReply(text, columns);
  }
  return { ...reply, calls, text };
}

// ---- A made-up sample sheet ----

// Six months of invented shop sales, the same every time. No real data.
export function sampleSheetCSV() {
  let seed = 20260926;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const regions = [
    ["North", 1.35],
    ["South", 0.95],
    ["East", 1.15],
    ["West", 0.7],
  ];
  const products = [
    ["Desk lamp", 39],
    ["Notebook set", 12.5],
    ["Backpack", 64],
    ["Water bottle", 18],
    ["Headphones", 119],
    ["Phone stand", 22],
  ];
  const lines = ["Order date,Region,Product,Channel,Units,Revenue,Returned"];
  const start = Date.UTC(2026, 0, 1);
  for (let k = 0; k < 1200; k++) {
    const day = Math.floor(rand() * 181);
    const [region, weight] = regions[Math.floor(rand() * regions.length)];
    const [product, price] = products[Math.floor(rand() * products.length)];
    const units =
      1 + Math.floor(rand() * 8 * weight + rand() * 2 * (day / 181));
    const revenue = (units * price * (0.9 + rand() * 0.2)).toFixed(2);
    lines.push(
      [
        isoDate(start + day * DAY),
        region,
        product,
        rand() < 0.62 ? "Online" : "Store",
        units,
        revenue,
        rand() < 0.05 ? "yes" : "no",
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
export const SAMPLE_NAME = "sample-sales.csv";
