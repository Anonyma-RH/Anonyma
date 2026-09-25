import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { database, MIGRATIONS } from "../server/core.js";

function tempPath(t) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "db.sqlite");
}
const version = (db) => db.prepare("PRAGMA user_version").get().user_version;
const columns = (db, table) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);

test("a new database is created at the latest schema version", (t) => {
  const db = database(tempPath(t));
  assert.equal(version(db), MIGRATIONS.length);
  assert.ok(columns(db, "holds").includes("uncovered"));
  db.close();
});

test("an unversioned database from before migrations upgrades without losing data", (t) => {
  const path = tempPath(t);
  // The shape of a database created by the earliest released schema.
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, email TEXT UNIQUE, wallet TEXT UNIQUE, created INTEGER NOT NULL, deleted INTEGER, token_balance TEXT DEFAULT '0', token_since INTEGER);
    CREATE TABLE ledger(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),amount INTEGER NOT NULL,kind TEXT NOT NULL,ref TEXT UNIQUE NOT NULL,key_id TEXT,description TEXT,created INTEGER NOT NULL);
    CREATE TABLE holds(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),amount INTEGER NOT NULL,key_id TEXT,kind TEXT,status TEXT DEFAULT 'held',created INTEGER,expires INTEGER,result TEXT);
    INSERT INTO users(id,username,created) VALUES('u1','legacy',1);
    INSERT INTO ledger VALUES('l1','u1',500,'deposit','r1',NULL,'Old credit',1);
    INSERT INTO holds(id,user_id,amount,status) VALUES('h1','u1',100,'settled');
  `);
  legacy.close();
  const db = database(path);
  assert.equal(version(db), MIGRATIONS.length);
  assert.ok(columns(db, "users").includes("token_checked"));
  assert.equal(db.prepare("SELECT uncovered FROM holds").get().uncovered, 0);
  assert.equal(db.prepare("SELECT amount FROM ledger").get().amount, 500);
  // The append-only protection is installed on the existing ledger.
  assert.throws(() => db.exec("DELETE FROM ledger"), /append-only/);
  db.close();
});

test("reopening is a no-op and a newer database is refused", (t) => {
  const path = tempPath(t);
  database(path).close();
  const again = database(path);
  assert.equal(version(again), MIGRATIONS.length);
  again.exec(`PRAGMA user_version=${MIGRATIONS.length + 1}`);
  again.close();
  assert.throws(() => database(path), /newer version/);
});

test("previously versioned databases receive durable quotas without changing balances", t => {
  const path = tempPath(t), old = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, -1)) migration(old);
  old.exec(`PRAGMA user_version=${MIGRATIONS.length - 1}`);
  old.prepare("INSERT INTO users(id,username,created) VALUES('existing','existing',1)").run();
  old.prepare("INSERT INTO ledger(id,user_id,amount,kind,ref,created) VALUES('saved','existing',12345,'deposit','saved',1)").run();
  old.close();
  const upgraded = database(path);
  assert.equal(upgraded.prepare("SELECT amount FROM ledger WHERE id='saved'").get().amount, 12345);
  assert.equal(upgraded.prepare("SELECT count(*) n FROM rate_limits").get().n, 0);
  upgraded.close();
});
