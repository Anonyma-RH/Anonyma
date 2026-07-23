import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  existsSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { resolve, join, dirname, basename } from "node:path";

function inventory(root, prefix = "") {
  const files = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(root, relative));
    if (stat.isSymbolicLink())
      throw Error("Backups cannot contain symbolic links.");
    if (stat.isDirectory()) files.push(...inventory(root, relative));
    else if (stat.isFile()) files.push(relative);
    else throw Error("Backups can only contain regular files and directories.");
  }
  return files;
}

function fingerprint(file) {
  const bytes = readFileSync(file);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function copyPrivate(source, destination) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
}

function newDirectory(path) {
  if (existsSync(path))
    throw Error("Destination already exists; choose a new directory.");
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function verifyBackup(directory) {
  const root = resolve(directory);
  const files = inventory(root);
  const manifest = JSON.parse(
    readFileSync(join(root, "manifest.json"), "utf8"),
  );
  if (manifest.format !== "anonyma-backup-v1" || !Array.isArray(manifest.files))
    throw Error("Unsupported backup manifest.");
  const actual = files.filter((name) => name !== "manifest.json");
  const declared = manifest.files.map((f) => f.path);
  if (
    JSON.stringify([...declared].sort()) !== JSON.stringify([...actual].sort())
  )
    throw Error("Backup file list does not match its manifest.");
  for (const file of manifest.files) {
    const current = fingerprint(join(root, file.path));
    if (current.bytes !== file.bytes || current.sha256 !== file.sha256)
      throw Error(`Backup checksum mismatch: ${file.path}`);
  }
  if (!actual.includes("anonyma.sqlite"))
    throw Error("Backup database is missing.");
  const db = new DatabaseSync(join(root, "anonyma.sqlite"), { readOnly: true });
  try {
    const check = db.prepare("PRAGMA integrity_check").all();
    if (check.length !== 1 || check[0].integrity_check !== "ok")
      throw Error("Backup database integrity check failed.");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw Error("Backup database contains broken relationships.");
    const media = db.prepare("SELECT filename FROM media").all();
    for (const { filename } of media) {
      if (
        !filename ||
        filename !== basename(filename) ||
        !actual.includes(`media/${filename}`)
      )
        throw Error("A saved media file is missing from the backup.");
    }
    return {
      files: actual.length,
      users: db.prepare("SELECT COUNT(*) n FROM users").get().n,
      ledgerEntries: db.prepare("SELECT COUNT(*) n FROM ledger").get().n,
      media: media.length,
      createdAt: manifest.createdAt,
    };
  } finally {
    db.close();
  }
}

export function createBackup(db, cfg, destination) {
  const root = resolve(destination);
  // Call with writes paused: SQLite snapshot and media copies span separate operations.
  newDirectory(root);
  db.prepare("VACUUM INTO ?").run(join(root, "anonyma.sqlite"));
  chmodSync(join(root, "anonyma.sqlite"), 0o600);
  if (existsSync(cfg.mediaPath)) {
    for (const file of inventory(cfg.mediaPath))
      copyPrivate(join(cfg.mediaPath, file), join(root, "media", file));
  }
  const manifest = {
    format: "anonyma-backup-v1",
    createdAt: new Date().toISOString(),
    mode: cfg.testMode ? "local-test" : "live",
    requiresExternalAppSecret: !!cfg.secret,
    files: inventory(root).map((path) => ({
      path,
      ...fingerprint(join(root, path)),
    })),
  };
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: 0o600 },
  );
  return verifyBackup(root);
}

export function restoreBackup(source, destination) {
  const verified = verifyBackup(source);
  const root = resolve(destination);
  newDirectory(root);
  for (const file of inventory(source))
    copyPrivate(join(source, file), join(root, file));
  verifyBackup(root);
  return verified;
}
