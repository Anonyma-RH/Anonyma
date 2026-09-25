import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// Require Gitleaks: unavailable scanners are a failed check, never a skip.
const flags = [
  "--redact",
  "--no-banner",
  "--ignore-gitleaks-allow",
  "--max-decode-depth",
  "5",
];
execFileSync(
  "gitleaks",
  [
    "git",
    ".",
    "--config",
    "scripts/release-gitleaks.toml",
    "--log-opts=--all",
    ...flags,
  ],
  { stdio: "inherit" },
);
const dir = mkdtempSync(join(tmpdir(), "anonyma-secret-check-"));
try {
  const paths = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  for (const path of paths) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    if (!stat.isFile())
      throw Error("Tracked file is not a regular file: " + path);
    const dest = join(dir, path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(path, dest);
  }
  execFileSync(
    "gitleaks",
    ["dir", dir, "--config", "scripts/release-gitleaks.toml", ...flags],
    { stdio: "inherit" },
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
