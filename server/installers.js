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
export function shellInstaller(cfg) {
  const url = (originFor(cfg) + "/cli.mjs").replaceAll("'", "'\\''");
  return `#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { echo "Install Node.js 18 or newer first." >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<18)process.exit(1)' || { echo "Node.js 18 or newer is required." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
dir="\${ANONYMA_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$dir"
umask 077
tmp=$(mktemp -d "$dir/.anonyma.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl --fail --silent --show-error --location --max-time 60 '${url}' -o "$tmp/cli.mjs"
node --check "$tmp/cli.mjs"
chmod 700 "$tmp/cli.mjs"
mv -f "$tmp/cli.mjs" "$dir/anonyma.mjs"
printf '%s\\n' '#!/bin/sh' 'exec node "$(dirname "$0")/anonyma.mjs" "$@"' > "$tmp/anonyma"
chmod 700 "$tmp/anonyma"
mv -f "$tmp/anonyma" "$dir/anonyma"
echo "Installed to $dir/anonyma. Add $dir to PATH if needed."
echo "Run anonyma config to connect your account."
`;
}
export function powershellInstaller(cfg) {
  const url = (originFor(cfg) + "/cli.mjs").replaceAll("'", "''");
  return `$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 18 or newer first.' }
$major = [int]((& node -p 'process.versions.node').Split('.')[0])
if ($major -lt 18) { throw 'Node.js 18 or newer is required.' }
$dir = Join-Path $env:LOCALAPPDATA 'Anonyma'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$temp = Join-Path $dir ([guid]::NewGuid().ToString() + '.mjs')
try {
  Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile $temp -TimeoutSec 60
  & node --check $temp
  if ($LASTEXITCODE -ne 0) { throw 'Downloaded CLI failed validation; existing installation was preserved.' }
  Move-Item -Force -Path $temp -Destination (Join-Path $dir 'anonyma.mjs')
  Set-Content -Encoding ASCII -Path (Join-Path $dir 'anonyma.cmd') -Value '@node "%~dp0anonyma.mjs" %*'
} finally {
  if (Test-Path $temp) { Remove-Item -Force $temp }
}
Write-Host "Installed to $dir. Add it to PATH if needed, then run anonyma config."
`;
}
