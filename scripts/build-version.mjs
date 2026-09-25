import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
let commit =
  process.env.BUILD_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || null;
let dirty = null;
try {
  if (!commit)
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  dirty = !!execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
} catch {
  /* Images without Git must receive BUILD_COMMIT_SHA. */
}
if (commit && !/^[a-f0-9]{40}$/.test(commit))
  throw Error("BUILD_COMMIT_SHA must be a full Git commit SHA.");
mkdirSync("dist/client", { recursive: true });
writeFileSync(
  "dist/client/version.json",
  JSON.stringify({ commit, dirty, builtAt: new Date().toISOString() }) + "\n",
);
console.log(
  `Build revision: ${commit || "unknown"}${dirty ? " (uncommitted changes)" : ""}`,
);
