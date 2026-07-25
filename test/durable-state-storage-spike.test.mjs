import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { nodeSqliteAdapter } from "../spikes/001-durable-state-storage/node-sqlite-adapter.mjs";
import { openStorage } from "../spikes/001-durable-state-storage/storage-adapter-contract.mjs";

const CRASH_WRITER = new URL(
  "../spikes/001-durable-state-storage/crash-writer.mjs",
  import.meta.url,
);
const SCHEMA_SQL = await readFile(
  new URL("../docs/durable-state-schema-v1.sql", import.meta.url),
  "utf8",
);

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

async function waitForReady(child) {
  let stdout = "";
  let stderr = "";
  const deadline = Date.now() + 5_000;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  while (!stdout.includes("READY\n")) {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(
        `crash writer exited early (${child.exitCode ?? child.signalCode}): ${stderr}`,
      );
    }
    if (Date.now() >= deadline) {
      child.kill("SIGKILL");
      throw new Error(`crash writer startup timed out: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function insertBot(connection, botKey, nextVirtualUpdateId = 100) {
  connection.run(
    `INSERT INTO bot_state (
      bot_key,
      next_virtual_update_id,
      acknowledged_virtual_prefix,
      reconciliation_mode,
      ledger_epoch,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [botKey, nextVirtualUpdateId, -1, "legacy", 1, 1_000, 1_000],
  );
}

test("the node:sqlite adapter applies policy and reopens schema state", async (t) => {
  const directory = await temporaryDirectory(t, "durable-state-reopen-");
  const databasePath = path.join(directory, "state.sqlite3");
  let connection = openStorage(nodeSqliteAdapter, databasePath);

  connection.exec(SCHEMA_SQL);
  connection.transaction((transaction) => {
    transaction.run(
      `INSERT INTO schema_meta (
        schema_version,
        migration_name,
        schema_sha256,
        applied_at_ms
      ) VALUES (?, ?, ?, ?)`,
      [1, "durable-state-v1", "0".repeat(64), 1_000],
    );
    insertBot(transaction, "bot:reopen", 1_200);
  });

  assert.equal(connection.get("PRAGMA journal_mode").journal_mode, "wal");
  assert.equal(connection.get("PRAGMA foreign_keys").foreign_keys, 1);
  assert.equal(connection.get("PRAGMA synchronous").synchronous, 2);
  assert.equal(connection.get("PRAGMA busy_timeout").timeout, 5_000);
  assert.deepEqual(connection.integrityCheck(), ["ok"]);
  assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  assert.equal((await stat(`${databasePath}-wal`)).mode & 0o777, 0o600);
  assert.equal((await stat(`${databasePath}-shm`)).mode & 0o777, 0o600);
  connection.close();

  connection = openStorage(nodeSqliteAdapter, databasePath);
  assert.deepEqual(
    connection.get(
      "SELECT next_virtual_update_id, acknowledged_virtual_prefix FROM bot_state WHERE bot_key = ?",
      ["bot:reopen"],
    ),
    { next_virtual_update_id: 1_200, acknowledged_virtual_prefix: -1 },
  );
  assert.deepEqual(connection.integrityCheck(), ["ok"]);
  connection.close();
});

test("schema constraints reject competing generations and offered batches", async (t) => {
  const directory = await temporaryDirectory(t, "durable-state-schema-");
  const connection = openStorage(nodeSqliteAdapter, path.join(directory, "state.sqlite3"));
  t.after(() => connection.close());

  connection.exec(SCHEMA_SQL);
  insertBot(connection, "bot:constraints");
  connection.run(
    `INSERT INTO source_state (
      bot_key,
      source,
      generation,
      is_active,
      cursor_status,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["bot:constraints", "local", 1, 1, "unknown", 1_000, 1_000],
  );

  assert.throws(
    () => connection.run(
      `INSERT INTO source_state (
        bot_key,
        source,
        generation,
        is_active,
        cursor_status,
        created_at_ms,
        updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["bot:constraints", "local", 2, 1, "unknown", 1_001, 1_001],
    ),
    /UNIQUE constraint failed/u,
  );

  connection.run(
    `INSERT INTO poll_batches (
      bot_key,
      request_virtual_offset,
      request_signature_hmac,
      first_virtual_update_id,
      last_virtual_update_id,
      state,
      response_ciphertext,
      response_nonce,
      response_key_id,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "bot:constraints",
      100,
      Buffer.from("signature"),
      100,
      100,
      "offered",
      Buffer.from("ciphertext"),
      Buffer.from("nonce"),
      "test-key",
      1_000,
      1_000,
    ],
  );

  assert.throws(
    () => connection.run(
      `INSERT INTO poll_batches (
        bot_key,
        request_virtual_offset,
        request_signature_hmac,
        first_virtual_update_id,
        last_virtual_update_id,
        state,
        response_ciphertext,
        response_nonce,
        response_key_id,
        created_at_ms,
        updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "bot:constraints",
        100,
        Buffer.from("second-signature"),
        100,
        100,
        "offered",
        Buffer.from("second-ciphertext"),
        Buffer.from("second-nonce"),
        "test-key",
        1_001,
        1_001,
      ],
    ),
    /UNIQUE constraint failed/u,
  );
});

test("a hard crash preserves committed rows and rolls back the open transaction", async (t) => {
  const directory = await temporaryDirectory(t, "durable-state-crash-");
  const databasePath = path.join(directory, "state.sqlite3");
  const child = spawn(process.execPath, [CRASH_WRITER.pathname, databasePath], {
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  });

  await waitForReady(child);
  child.kill("SIGKILL");
  const [code, signal] = await once(child, "exit");
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");

  const connection = openStorage(nodeSqliteAdapter, databasePath);
  assert.deepEqual(connection.integrityCheck(), ["ok"]);
  assert.deepEqual(
    connection.all("SELECT id, phase FROM crash_probe ORDER BY id"),
    [{ id: 1, phase: "committed" }],
  );
  connection.close();
});

test("online backup restores a consistent pre-mutation snapshot", async (t) => {
  const directory = await temporaryDirectory(t, "durable-state-backup-");
  const databasePath = path.join(directory, "state.sqlite3");
  const backupPath = path.join(directory, "state.backup.sqlite3");
  const connection = openStorage(nodeSqliteAdapter, databasePath);

  connection.exec(`
    CREATE TABLE backup_probe (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
  `);
  connection.run("INSERT INTO backup_probe (id, value) VALUES (?, ?)", [1, "before-backup"]);

  const copiedPages = await nodeSqliteAdapter.backup(connection, backupPath);
  assert.ok(copiedPages > 0);
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);

  connection.run("INSERT INTO backup_probe (id, value) VALUES (?, ?)", [2, "after-backup"]);
  connection.close();

  const restored = openStorage(nodeSqliteAdapter, backupPath);
  assert.deepEqual(restored.integrityCheck(), ["ok"]);
  assert.deepEqual(
    restored.all("SELECT id, value FROM backup_probe ORDER BY id"),
    [{ id: 1, value: "before-backup" }],
  );
  restored.close();
});
