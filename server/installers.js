import { readFileSync } from "node:fs";

function originFor(cfg) {
  const url = new URL(cfg.publicUrl || cfg.origin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("Installer requires an HTTP(S) application origin.");
  return url.origin;
}
export function cliDownload(cfg) {
  return readFileSync(
    new URL("../cli/anonyma.mjs", import.meta.url),
    "utf8",
  ).replace(
    '/* INSTALLATION_BASE */ "http://localhost:3001/v1"',
    JSON.stringify(originFor(cfg) + "/v1"),
  );
}