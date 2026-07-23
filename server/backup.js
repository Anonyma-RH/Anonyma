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