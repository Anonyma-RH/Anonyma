import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openapi } from "../server/openapi.js";
test("frontend API contract covers all concrete backend routes and resolves its schema references", async () => {
  const { readdirSync } = await import("node:fs");
  const routeFiles = readdirSync(new URL("../server/routes/", import.meta.url)).map((f) => "routes/" + f);
  assert.ok(routeFiles.length > 5, "route modules were found");
  for (const file of ["app.js", "auth.js", ...routeFiles]) {
    const code = readFileSync(
      new URL("../server/" + file, import.meta.url),
      "utf8",
    );
    for (const [, method, path] of code.matchAll(
      /app\.(get|post|patch|delete|put)\(\s*"([^"*]+)"/g,
    )) {
      const specPath = path.replace(/:([\w]+)/g, "{$1}");
      assert.ok(
        openapi.paths[specPath]?.[method],
        `${method} ${path} missing from contract`,
      );
    }
  }
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      const resolved = value.$ref
        .slice(2)
        .split("/")
        .reduce((v, k) => v?.[k], openapi);
      assert.ok(resolved, `unresolved ${value.$ref}`);
    }
    for (const item of Object.values(value)) walk(item);
  };
  walk(openapi);
  const ids = Object.values(openapi.paths).flatMap((p) =>
    Object.values(p).map((o) => o.operationId),
  );
  assert.equal(ids.length, new Set(ids).size);
});
