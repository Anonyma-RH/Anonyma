import { fail, now } from "../core.js";
import {
  usageRange,
  usageSummary,
  countRows,
  exportRows,
  money,
  csvLine,
  EXPORT_COLUMNS,
  MAX_EXPORT_ROWS,
} from "../usage-insights.js";

// Usage Insights & Export (update "insights"; server/usage-insights.js).
// Signed-in accounts only, and only their own ledger. releaseGuard refuses
// both routes while the update is unreleased (featuresFor in releases.js).
export function usageInsightRoutes(ctx) {
  const { app, db, limit, requireUser } = ctx;
  const modelName = (id) => ctx.models.find(id)?.name ?? null;

  app.get(
    "/api/account/usage",
    requireUser,
    limit("usage", 60, 60000),
    (req, res) => {
      const range = usageRange(req.query, now());
      res.json(usageSummary(db, req.user.id, range, { modelName }));
    },
  );

  app.get(
    "/api/account/usage/export",
    requireUser,
    limit("usage_export", 20, 600000),
    async (req, res) => {
      const format = req.query.format ?? "csv";
      if (format !== "csv" && format !== "json")
        fail(400, "format must be csv or json.", "invalid_format");
      const started = now();
      const range = usageRange(req.query, started);
      // A fixed snapshot: the ledger is append-only and rows are written at
      // the time they happen, so nothing written after `started` can join
      // the rows below and the file matches the ledger it was read from.
      const end = Math.min(range.end, started + 1);
      const user = req.user.id;
      const rows = countRows(db, user, range.start, end);
      if (rows > MAX_EXPORT_ROWS)
        fail(
          400,
          `This range has ${rows.toLocaleString("en-US")} ledger entries; one export holds at most ${MAX_EXPORT_ROWS.toLocaleString("en-US")}. Choose a shorter range.`,
          "export_too_large",
        );
      const name = `anonyma-usage-${range.from}-to-${range.to}.${format}`;
      res.set({
        "Content-Type":
          format === "csv"
            ? "text/csv; charset=utf-8"
            : "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "X-Export-Rows": String(rows),
      });
      // Written a page at a time, waiting whenever the client is slower.
      let buffer = "";
      const flush = async (force = false) => {
        if (!buffer || (!force && buffer.length < 65536)) return;
        const ok = res.write(buffer);
        buffer = "";
        if (!ok && !res.destroyed)
          await new Promise((resolve) => {
            res.once("drain", resolve);
            res.once("close", resolve);
          });
      };
      let written = 0,
        total = 0;
      if (format === "csv") {
        // A byte-order mark so spreadsheet apps read UTF-8 (中文 labels).
        buffer += "﻿" + csvLine(EXPORT_COLUMNS);
        for (const row of exportRows(db, user, range.start, end)) {
          if (res.destroyed) return;
          buffer += csvLine(EXPORT_COLUMNS.map((c) => row[c]));
          written++;
          total += row.subcredits;
          await flush();
        }
      } else {
        buffer +=
          "{" +
          [
            `"schema":"anonyma.usage-export.v1"`,
            `"generated_at":${JSON.stringify(new Date(started).toISOString())}`,
            `"range":${JSON.stringify({
              from: range.from,
              to: range.to,
              timezone: "UTC",
              start: new Date(range.start).toISOString(),
              end: new Date(end).toISOString(),
            })}`,
            `"units":${JSON.stringify({
              credits:
                "decimal string, 4 places (1 credit = 10,000 subcredits)",
              usd: "decimal string, 7 places (1 USD = 1,000 credits)",
              subcredits: "integer ledger amount; positive adds to the balance",
            })}`,
            `"scope":${JSON.stringify("This account's own ledger entries. Team Treasury (\"Team pays\") charges are on the treasury's ledger and are not included. No prompts, replies or media.")}`,
            `"columns":${JSON.stringify(EXPORT_COLUMNS)}`,
          ].join(",") +
          `,"entries":[`;
        for (const row of exportRows(db, user, range.start, end)) {
          if (res.destroyed) return;
          buffer += (written ? "," : "") + JSON.stringify(row);
          written++;
          total += row.subcredits;
          await flush();
        }
        buffer += `],"summary":${JSON.stringify({ entries: written, net: money(total) })}}`;
      }
      await flush(true);
      res.end();
    },
  );
}
