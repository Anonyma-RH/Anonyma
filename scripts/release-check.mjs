import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (git("status", "--porcelain"))
  throw Error("Release checks require a clean, committed checkout.");
const commit = git("rev-parse", "HEAD");
execFileSync("npm", ["run", "verify"], {
  stdio: "inherit",
  env: { ...process.env, BUILD_COMMIT_SHA: commit, REQUIRE_REDIS_TEST: "1" },
});
if (git("rev-parse", "HEAD") !== commit || git("status", "--porcelain"))
  throw Error("Checkout changed during release checks.");
const version = JSON.parse(readFileSync("dist/client/version.json", "utf8"));
if (version.commit !== commit || version.dirty)
  throw Error("Build revision does not match the checked commit.");
writeFileSync(
  "dist/release-checks.json",
  JSON.stringify(
    {
      commit,
      checkedAt: new Date().toISOString(),
      lockfileSha256: createHash("sha256")
        .update(readFileSync("package-lock.json"))
        .digest("hex"),
      checks: ["static", "dependencies", "secrets", "build", "tests"],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Release checks passed for ${commit}. Deployment must use this exact revision.`,
);
