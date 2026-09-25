import { readdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { transform } from "esbuild";
let count = 0;
async function check(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (/\.(jsx|mjs|js)$/.test(path)) {
      if (path.endsWith(".jsx"))
        await transform(readFileSync(path, "utf8"), {
          loader: "jsx",
          sourcefile: path,
          logLevel: "error",
        });
      else {
        const result = spawnSync(process.execPath, ["--check", path], {
          stdio: "inherit",
        });
        if (result.status !== 0) throw Error("Static check failed: " + path);
      }
      count++;
    }
  }
}
for (const dir of ["src", "server", "scripts", "cli", "worker", "tests"])
  await check(dir);
for (const name of ["package.json", "package-lock.json"])
  JSON.parse(readFileSync(name, "utf8"));
console.log(
  `Static syntax checks passed for ${count} JavaScript and JSX files.`,
);
