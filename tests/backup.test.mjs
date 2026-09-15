import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { database, addCredit, balance } from "../server/core.js";
import { createBackup, restoreBackup, verifyBackup } from "../server/backup.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anonyma-backup-"));
  const cfg = {
    dbPath: join(root, "source.sqlite"),
    mediaPath: join(root, "media"),
    testMode: true,
  };
  const db = database(cfg.dbPath);
  mkdirSync(cfg.mediaPath);
  writeFileSync(join(cfg.mediaPath, ".secret"), "fixture-signing-secret");
  writeFileSync(join(cfg.mediaPath, "image.png"), "fixture-media-bytes");
  db.prepare(
    "INSERT INTO users(id,username,created) VALUES('fixture','restorable',1)",
  ).run();
  addCredit(
    db,
    "fixture",
    100000,
    "test-deposit",
    "test_credit",
    "Isolated fixture",
  );
  db.prepare(
    "INSERT INTO media(id,user_id,kind,filename,created) VALUES('image','fixture','image','image.png',1)",
  ).run();
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, cfg, db, backup: join(root, "backup") };
}

test("backup restores actual balances, media and signing secret into a separate directory", (t) => {
  const f = fixture(t);
  const result = createBackup(f.db, f.cfg, f.backup);
  assert.equal(result.users, 1);
  assert.equal(result.ledgerEntries, 1);
  assert.equal(result.media, 1);
  assert.equal(verifyBackup(f.backup).files, 3);
  const destination = join(f.root, "restore");
  restoreBackup(f.backup, destination);
  assert.equal(
    readFileSync(join(destination, "media/.secret"), "utf8"),
    "fixture-signing-secret",
  );
  assert.equal(
    readFileSync(join(destination, "media/image.png"), "utf8"),
    "fixture-media-bytes",
  );
  const restored = database(join(destination, "anonyma.sqlite"));
  try {
    assert.deepEqual(balance(restored, "fixture"), balance(f.db, "fixture"));
    assert.throws(
      () => restored.exec("UPDATE ledger SET amount=0"),
      /append-only/,
    );
  } finally {
    restored.close();
  }
  assert.throws(() => restoreBackup(f.backup, destination), /already exists/);
});

test("backup verification rejects damaged files and incomplete media snapshots", (t) => {
  const f = fixture(t);
  createBackup(f.db, f.cfg, f.backup);
  writeFileSync(join(f.backup, "media/image.png"), "damaged");
  assert.throws(() => verifyBackup(f.backup), /checksum mismatch/);
  assert.throws(
    () => restoreBackup(f.backup, join(f.root, "bad-restore")),
    /checksum mismatch/,
  );
  unlinkSync(join(f.cfg.mediaPath, "image.png"));
  assert.throws(
    () => createBackup(f.db, f.cfg, join(f.root, "incomplete")),
    /saved media file is missing/,
  );
});
