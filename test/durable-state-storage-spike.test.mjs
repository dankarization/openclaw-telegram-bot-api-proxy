import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { nodeSqliteAdapter } from "../spikes/001-durable-state-storage/node-sqlite-adapter.mjs";
import {
  reconcileAllocatorHighWaters,
  sourceManifestKey,
  verifyStorageForRestore,
  verifyUnresolvedIntentIncarnations,
} from "../spikes/001-durable-state-storage/restore-gates.mjs";
import {
  applyStorageMigration,
  openStorage,
} from "../spikes/001-durable-state-storage/storage-adapter-contract.mjs";

const CRASH_WRITER = new URL(
  "../spikes/001-durable-state-storage/crash-writer.mjs",
  import.meta.url,
);
const SCHEMA_SQL = await readFile(
  new URL("../docs/durable-state-schema-v1.sql", import.meta.url),
  "utf8",
);
const SCHEMA_MIGRATION = Object.freeze({
  appliedAtMs: 1_000,
  name: "durable-state-v1",
  sha256: createHash("sha256").update(SCHEMA_SQL, "utf8").digest("hex"),
  sql: SCHEMA_SQL,
  version: 1,
});

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

function applySchema(connection) {
  applyStorageMigration(connection, SCHEMA_MIGRATION);
}

function insertSource(connection, options = {}) {
  connection.run(
    `INSERT INTO source_state (
      bot_key,
      source,
      generation,
      is_active,
      incarnation_status,
      incarnation_evidence_hmac,
      cursor_status,
      last_observed_native_id,
      safe_ack_native_id,
      frontier_evidence_hmac,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      options.botKey,
      options.source || "local",
      options.generation || 1,
      options.isActive ?? 1,
      options.incarnationStatus || "unverified",
      options.incarnationEvidence || null,
      options.cursorStatus || "unknown",
      options.lastObservedNativeId ?? null,
      options.safeAckNativeId ?? null,
      options.frontierEvidence || null,
      options.createdAtMs || 1_000,
      options.updatedAtMs || 1_000,
    ],
  );
}

function insertOfferedEvent(connection, botKey, virtualUpdateId, options = {}) {
  const fingerprint = options.fingerprint ?? null;
  connection.run(
    `INSERT INTO logical_events (
      bot_key,
      virtual_update_id,
      state,
      event_kind,
      canonicalizer_version,
      fingerprint_strength,
      fingerprint_hmac,
      payload_ciphertext,
      payload_nonce,
      payload_key_id,
      created_at_ms,
      offered_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      botKey,
      virtualUpdateId,
      "ready",
      options.eventKind || "message",
      fingerprint == null ? null : (options.canonicalizerVersion || 1),
      fingerprint == null ? null : (options.strength || "strong"),
      fingerprint,
      Buffer.from(`payload:${virtualUpdateId}`),
      Buffer.from(`nonce:${virtualUpdateId}`),
      "test-payload-key",
      1_000,
      null,
    ],
  );
  connection.run(
    `UPDATE logical_events
     SET state = 'offered', offered_at_ms = ?
     WHERE bot_key = ? AND virtual_update_id = ?`,
    [1_001, botKey, virtualUpdateId],
  );
}

function insertCommittedEvent(connection, botKey, virtualUpdateId, options = {}) {
  insertOfferedEvent(connection, botKey, virtualUpdateId, options);
  connection.run(
    `UPDATE logical_events
     SET state = 'committed', committed_at_ms = ?
     WHERE bot_key = ? AND virtual_update_id = ?`,
    [1_002, botKey, virtualUpdateId],
  );
}

function insertSourceUpdate(connection, options = {}) {
  connection.run(
    `INSERT INTO source_updates (
      bot_key,
      source,
      generation,
      native_update_id,
      logical_virtual_update_id,
      disposition,
      terminal,
      observed_at_ms,
      terminal_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      options.botKey,
      options.source || "local",
      options.generation || 1,
      options.nativeUpdateId,
      options.logicalVirtualUpdateId ?? null,
      options.disposition || "event",
      options.terminal ?? 0,
      1_000,
      options.terminal ? 1_001 : null,
    ],
  );
}

function insertFingerprintOccurrence(connection, options = {}) {
  connection.run(
    `INSERT INTO fingerprint_occurrences (
      occurrence_id,
      bot_key,
      source,
      generation,
      native_update_id,
      logical_virtual_update_id,
      event_kind,
      canonicalizer_version,
      hmac_key_id,
      fingerprint_hmac,
      strength,
      committed,
      suppressed,
      matched_occurrence_id,
      first_observed_at_ms,
      last_observed_at_ms,
      expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      options.occurrenceId,
      options.botKey,
      options.source || "local",
      options.generation || 1,
      options.nativeUpdateId,
      options.logicalVirtualUpdateId ?? null,
      options.eventKind || "message",
      options.canonicalizerVersion || 1,
      options.hmacKeyId || "fingerprint-key-v1",
      options.fingerprint || Buffer.from("fingerprint"),
      options.strength || "strong",
      options.committed ?? 0,
      options.suppressed ?? 0,
      options.matchedOccurrenceId ?? null,
      1_000,
      1_000,
      172_801_000,
    ],
  );
}

test("the node:sqlite adapter applies policy and reopens schema state", async (t) => {
  const directory = await temporaryDirectory(t, "durable-state-reopen-");
  const databasePath = path.join(directory, "state.sqlite3");
  let connection = openStorage(nodeSqliteAdapter, databasePath);

  applySchema(connection);
  connection.transaction((transaction) => {
    insertBot(transaction, "bot:reopen", 1_200);
  });

  assert.equal(connection.get("PRAGMA journal_mode").journal_mode, "wal");
  assert.equal(connection.get("PRAGMA foreign_keys").foreign_keys, 1);
  assert.equal(connection.get("PRAGMA recursive_triggers").recursive_triggers, 1);
  assert.equal(connection.get("PRAGMA synchronous").synchronous, 2);
  assert.equal(connection.get("PRAGMA busy_timeout").timeout, 5_000);
  assert.deepEqual(connection.integrityCheck(), ["ok"]);
  assert.deepEqual(connection.all("PRAGMA foreign_key_check"), []);
  assert.deepEqual(
    connection.get(
      "SELECT schema_version, migration_name, schema_sha256 FROM schema_meta",
    ),
    {
      schema_version: 1,
      migration_name: "durable-state-v1",
      schema_sha256: SCHEMA_MIGRATION.sha256,
    },
  );
  assert.deepEqual(
    verifyStorageForRestore(connection, [SCHEMA_MIGRATION]),
    [{
      schema_version: 1,
      migration_name: "durable-state-v1",
      schema_sha256: SCHEMA_MIGRATION.sha256,
      catalog_sha256: connection.get(
        "SELECT catalog_sha256 FROM schema_meta WHERE schema_version = ?",
        [1],
      ).catalog_sha256,
    }],
  );
  const unexpectedSql = `${SCHEMA_SQL}\n-- unexpected restore input\n`;
  assert.throws(
    () => verifyStorageForRestore(connection, [{
      ...SCHEMA_MIGRATION,
      sha256: createHash("sha256").update(unexpectedSql, "utf8").digest("hex"),
      sql: unexpectedSql,
    }]),
    /recorded schema history does not match/u,
  );
  assert.throws(
    () => connection.run(
      "UPDATE schema_meta SET schema_sha256 = ? WHERE schema_version = ?",
      ["f".repeat(64), 1],
    ),
    /schema migration history is immutable/u,
  );
  assert.throws(
    () => connection.run(
      "DELETE FROM schema_meta WHERE schema_version = ?",
      [1],
    ),
    /schema migration history cannot be deleted/u,
  );
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
  assert.deepEqual(connection.all("PRAGMA foreign_key_check"), []);
  verifyStorageForRestore(connection, [SCHEMA_MIGRATION]);
  connection.exec("DROP TRIGGER source_updates_cannot_be_deleted");
  assert.deepEqual(connection.integrityCheck(), ["ok"]);
  assert.throws(
    () => verifyStorageForRestore(connection, [SCHEMA_MIGRATION]),
    /SQLite catalog does not match/u,
  );
  connection.close();
});

test("schema DDL and migration metadata roll back as one transaction", async (t) => {
  const directory = await temporaryDirectory(t, "durable-state-migration-");
  const connection = openStorage(nodeSqliteAdapter, path.join(directory, "state.sqlite3"));
  t.after(() => connection.close());

  assert.throws(
    () => applyStorageMigration(connection, {
      ...SCHEMA_MIGRATION,
      sha256: "0".repeat(64),
    }),
    /migration sha256 mismatch/u,
  );
  const brokenSql = `
    CREATE TABLE schema_meta (
      schema_version INTEGER PRIMARY KEY,
      migration_name TEXT NOT NULL UNIQUE,
      schema_sha256 TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE migration_probe (id INTEGER PRIMARY KEY) STRICT;
    THIS IS NOT VALID SQL;
  `;
  assert.throws(
    () => applyStorageMigration(connection, {
      appliedAtMs: 1_000,
      name: "broken-migration",
      sha256: createHash("sha256").update(brokenSql, "utf8").digest("hex"),
      sql: brokenSql,
      version: 1,
    }),
    /syntax error/u,
  );
  assert.equal(
    connection.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ["migration_probe"],
    ),
    undefined,
  );
  assert.equal(
    connection.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ["schema_meta"],
    ),
    undefined,
  );
  assert.deepEqual(connection.integrityCheck(), ["ok"]);
});

test("schema constraints reject competing generations and offered batches", async (t) => {
  const directory = await temporaryDirectory(t, "durable-state-schema-");
  const connection = openStorage(nodeSqliteAdapter, path.join(directory, "state.sqlite3"));
  t.after(() => connection.close());

  applySchema(connection);
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
  insertSource(connection, {
    botKey: "bot:constraints",
    source: "cloud",
  });

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
    `INSERT INTO logical_events (
      bot_key,
      virtual_update_id,
      state,
      event_kind,
      payload_ciphertext,
      payload_nonce,
      payload_key_id,
      created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "bot:constraints",
      50,
      "ready",
      "message",
      Buffer.from("payload"),
      Buffer.from("nonce"),
      "test-key",
      1_000,
    ],
  );
  assert.throws(
    () => connection.run(
      `UPDATE logical_events
       SET state = 'committed', committed_at_ms = ?
       WHERE bot_key = ? AND virtual_update_id = ?`,
      [1_001, "bot:constraints", 50],
    ),
    /logical event state transition is not allowed/u,
  );
  assert.throws(
    () => connection.run(
      `INSERT INTO logical_events (
        bot_key,
        virtual_update_id,
        state,
        event_kind,
        created_at_ms,
        committed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      ["bot:constraints", 51, "committed", "message", 1_000, 1_001],
    ),
    /must be offered before it is committed/u,
  );

  connection.run(
    "UPDATE bot_state SET active_source = ? WHERE bot_key = ?",
    ["local", "bot:constraints"],
  );
  assert.throws(
    () => connection.run(
      `INSERT INTO poll_batches (
        bot_key,
        request_virtual_offset,
        request_signature_hmac,
        first_virtual_update_id,
        last_virtual_update_id,
        acknowledged_through_virtual_id,
        state,
        created_at_ms,
        updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "bot:constraints",
        100,
        Buffer.from("invalid-committed"),
        98,
        98,
        98,
        "committed",
        1_000,
        1_000,
      ],
    ),
    /poll batch must start as offered or empty/u,
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
      101,
      "offered",
      Buffer.from("ciphertext"),
      Buffer.from("nonce"),
      "test-key",
      1_000,
      1_000,
    ],
  );
  const activeBatchId = connection.get(
    "SELECT batch_id FROM poll_batches WHERE bot_key = ?",
    ["bot:constraints"],
  ).batch_id;
  assert.throws(
    () => connection.run(
      `INSERT OR REPLACE INTO poll_batches (
        batch_id,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        activeBatchId,
        "bot:constraints",
        100,
        Buffer.from("replacement-signature"),
        100,
        101,
        "offered",
        Buffer.from("replacement-ciphertext"),
        Buffer.from("replacement-nonce"),
        "replacement-key",
        1_001,
        1_001,
      ],
    ),
    /active poll batch cannot be deleted/u,
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
        101,
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
  assert.throws(
    () => connection.run(
      "UPDATE bot_state SET active_source = ? WHERE bot_key = ?",
      ["cloud", "bot:constraints"],
    ),
    /cannot change while a poll batch is unacknowledged/u,
  );
  assert.throws(
    () => connection.run(
      `UPDATE source_state
       SET is_active = 0, incarnation_status = 'retired'
       WHERE bot_key = ? AND source = ?`,
      ["bot:constraints", "local"],
    ),
    /commit active poll batch before retiring|clear active source selection/u,
  );
  assert.throws(
    () => connection.run(
      `UPDATE poll_batches
       SET request_signature_hmac = ?
       WHERE bot_key = ?`,
      [Buffer.from("mutated-signature"), "bot:constraints"],
    ),
    /request and virtual range are immutable/u,
  );
  assert.throws(
    () => connection.run(
      `UPDATE poll_batches
       SET response_ciphertext = ?
       WHERE bot_key = ?`,
      [Buffer.from("mutated-response"), "bot:constraints"],
    ),
    /active poll batch response is immutable/u,
  );
  assert.throws(
    () => connection.run(
      "UPDATE poll_batches SET state = 'abandoned' WHERE bot_key = ?",
      ["bot:constraints"],
    ),
    /CHECK constraint failed|state transition is not allowed/u,
  );
  assert.throws(
    () => connection.run(
      "DELETE FROM poll_batches WHERE bot_key = ?",
      ["bot:constraints"],
    ),
    /active poll batch cannot be deleted/u,
  );
  connection.run(
    `UPDATE poll_batches
     SET state = 'partially_acked',
         acknowledged_through_virtual_id = ?,
         updated_at_ms = ?
     WHERE bot_key = ?`,
    [100, 1_002, "bot:constraints"],
  );
  assert.throws(
    () => connection.run(
      "UPDATE bot_state SET active_source = ? WHERE bot_key = ?",
      ["cloud", "bot:constraints"],
    ),
    /cannot change while a poll batch is unacknowledged/u,
  );
  connection.run(
    `UPDATE poll_batches
     SET state = 'committed',
         acknowledged_through_virtual_id = ?,
         updated_at_ms = ?
     WHERE bot_key = ?`,
    [101, 1_003, "bot:constraints"],
  );
  connection.run(
    "UPDATE bot_state SET active_source = ? WHERE bot_key = ?",
    ["cloud", "bot:constraints"],
  );
  assert.equal(
    connection.get(
      "SELECT active_source FROM bot_state WHERE bot_key = ?",
      ["bot:constraints"],
    ).active_source,
    "cloud",
  );
  connection.run(
    `INSERT INTO process_lease (
      singleton,
      owner_id,
      acquired_at_ms,
      heartbeat_at_ms,
      expires_at_ms
    ) VALUES (?, ?, ?, ?, ?)`,
    [1, "owner-a", 1_000, 1_000, 2_000],
  );
  assert.throws(
    () => connection.run(
      `INSERT OR REPLACE INTO process_lease (
        singleton,
        owner_id,
        acquired_at_ms,
        heartbeat_at_ms,
        expires_at_ms
      ) VALUES (?, ?, ?, ?, ?)`,
      [1, "owner-b", 1_500, 1_500, 2_500],
    ),
    /process lease is a permanent singleton/u,
  );
  assert.throws(
    () => connection.run(
      `UPDATE process_lease
       SET owner_id = ?, acquired_at_ms = ?, heartbeat_at_ms = ?, expires_at_ms = ?`,
      ["owner-b", 1_500, 1_500, 2_500],
    ),
    /owner cannot change before expiry/u,
  );
  connection.run(
    `UPDATE process_lease
     SET owner_id = ?, acquired_at_ms = ?, heartbeat_at_ms = ?, expires_at_ms = ?`,
    ["owner-b", 2_000, 2_000, 3_000],
  );
  assert.equal(
    connection.get("SELECT owner_id FROM process_lease WHERE singleton = 1").owner_id,
    "owner-b",
  );
});

test("durable identities, high-waters, source retirement, and unresolved intents are one-way", async (t) => {
  const directory = await temporaryDirectory(t, "durable-state-one-way-");
  const connection = openStorage(nodeSqliteAdapter, path.join(directory, "state.sqlite3"));
  t.after(() => connection.close());
  applySchema(connection);

  insertBot(connection, "bot:one-way", 151);
  connection.run(
    `UPDATE bot_state
     SET next_virtual_update_id = ?,
         allocator_anchor_high_water = ?,
         acknowledged_virtual_prefix = ?,
         ledger_epoch = ?,
         updated_at_ms = ?
     WHERE bot_key = ?`,
    [151, 150, 100, 2, 1_001, "bot:one-way"],
  );
  assert.throws(
    () => connection.run(
      `UPDATE bot_state
       SET next_virtual_update_id = ?,
           allocator_anchor_high_water = ?,
           acknowledged_virtual_prefix = ?,
           ledger_epoch = ?
       WHERE bot_key = ?`,
      [150, 149, 99, 1, "bot:one-way"],
    ),
    /cannot move backwards/u,
  );
  assert.throws(
    () => connection.run(
      "UPDATE bot_state SET bot_key = ? WHERE bot_key = ?",
      ["bot:renamed", "bot:one-way"],
    ),
    /bot state identity is immutable/u,
  );

  insertSource(connection, {
    botKey: "bot:one-way",
    incarnationStatus: "verified",
    incarnationEvidence: Buffer.from("source-epoch-1"),
    cursorStatus: "verified",
    lastObservedNativeId: 10,
    safeAckNativeId: 10,
    frontierEvidence: Buffer.from("frontier-proof-1"),
  });
  insertSource(connection, {
    botKey: "bot:one-way",
    source: "cloud",
  });
  connection.run(
    `UPDATE source_state
     SET incarnation_status = 'verified',
         incarnation_evidence_hmac = ?,
         updated_at_ms = ?
     WHERE bot_key = ? AND source = ?`,
    [Buffer.from("cloud-epoch-1"), 1_001, "bot:one-way", "cloud"],
  );
  assert.throws(
    () => connection.run(
      `UPDATE source_state
       SET incarnation_evidence_hmac = ?
       WHERE bot_key = ? AND source = ?`,
      [Buffer.from("cloud-epoch-2"), "bot:one-way", "cloud"],
    ),
    /one-way and immutable once set/u,
  );
  insertCommittedEvent(connection, "bot:one-way", 50);
  insertSourceUpdate(connection, {
    botKey: "bot:one-way",
    source: "cloud",
    nativeUpdateId: 1,
    logicalVirtualUpdateId: 50,
  });
  assert.throws(
    () => connection.run(
      `UPDATE source_state
       SET is_active = 0, incarnation_status = 'retired'
       WHERE bot_key = ? AND source = ?`,
      ["bot:one-way", "cloud"],
    ),
    /resolve source updates before retiring/u,
  );
  connection.run(
    `UPDATE source_updates
     SET terminal = 1, terminal_at_ms = ?
     WHERE bot_key = ? AND source = ? AND native_update_id = ?`,
    [1_002, "bot:one-way", "cloud", 1],
  );
  assert.throws(
    () => connection.run(
      `DELETE FROM logical_events
       WHERE bot_key = ? AND virtual_update_id = ?`,
      ["bot:one-way", 50],
    ),
    /logical event identity is a permanent tombstone/u,
  );
  connection.run(
    `UPDATE source_state
     SET is_active = 0, incarnation_status = 'retired', updated_at_ms = ?
     WHERE bot_key = ? AND source = ?`,
    [1_003, "bot:one-way", "cloud"],
  );
  assert.throws(
    () => insertSourceUpdate(connection, {
      botKey: "bot:one-way",
      source: "cloud",
      nativeUpdateId: 2,
      logicalVirtualUpdateId: 50,
      terminal: 1,
    }),
    /requires an active source generation/u,
  );
  assert.throws(
    () => connection.run(
      `UPDATE source_state
       SET last_observed_native_id = ?,
           safe_ack_native_id = ?
       WHERE bot_key = ?`,
      [11, 11, "bot:one-way"],
    ),
    /frontier and its evidence must rotate together/u,
  );
  connection.run(
    "UPDATE bot_state SET active_source = ? WHERE bot_key = ?",
    ["local", "bot:one-way"],
  );
  connection.run(
    `INSERT INTO poll_intents (
      bot_key,
      source,
      generation,
      incarnation_evidence_hmac,
      native_offset,
      status,
      prepared_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      "bot:one-way",
      "local",
      1,
      Buffer.from("source-epoch-1"),
      11,
      "prepared",
      1_001,
    ],
  );
  const unresolvedIntentId = connection.get(
    "SELECT intent_id FROM poll_intents WHERE bot_key = ?",
    ["bot:one-way"],
  ).intent_id;
  assert.throws(
    () => connection.run(
      `INSERT OR REPLACE INTO poll_intents (
        intent_id,
        bot_key,
        source,
        generation,
        incarnation_evidence_hmac,
        native_offset,
        status,
        prepared_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        unresolvedIntentId,
        "bot:one-way",
        "local",
        1,
        Buffer.from("source-epoch-1"),
        11,
        "prepared",
        1_002,
      ],
    ),
    /unresolved poll intent cannot be deleted/u,
  );
  assert.throws(
    () => connection.run(
      "UPDATE bot_state SET active_source = NULL WHERE bot_key = ?",
      ["bot:one-way"],
    ),
    /cannot change with an unresolved poll intent/u,
  );
  assert.throws(
    () => connection.run(
      "DELETE FROM poll_intents WHERE bot_key = ?",
      ["bot:one-way"],
    ),
    /unresolved poll intent cannot be deleted/u,
  );
  assert.throws(
    () => connection.run(
      `UPDATE source_state
       SET is_active = 0, incarnation_status = 'retired'
       WHERE bot_key = ?`,
      ["bot:one-way"],
    ),
    /resolve poll intent before retiring|clear active source selection/u,
  );
  connection.run(
    `UPDATE poll_intents
     SET status = 'failed', completed_at_ms = ?
     WHERE bot_key = ?`,
    [1_002, "bot:one-way"],
  );
  connection.run(
    "UPDATE bot_state SET active_source = NULL WHERE bot_key = ?",
    ["bot:one-way"],
  );
  connection.run(
    `UPDATE source_state
     SET is_active = 0, incarnation_status = 'retired', updated_at_ms = ?
     WHERE bot_key = ? AND source = ?`,
    [1_003, "bot:one-way", "local"],
  );
  assert.throws(
    () => connection.run(
      `UPDATE source_state
       SET is_active = 1, incarnation_status = 'verified'
       WHERE bot_key = ? AND source = ?`,
      ["bot:one-way", "local"],
    ),
    /inactive source generation is final/u,
  );
  assert.throws(
    () => connection.run(
      "DELETE FROM source_state WHERE bot_key = ?",
      ["bot:one-way"],
    ),
    /explicit database retirement/u,
  );
  assert.throws(
    () => insertSource(connection, {
      botKey: "bot:one-way",
      generation: 2,
      incarnationStatus: "verified",
      incarnationEvidence: Buffer.from("source-epoch-1"),
      cursorStatus: "verified",
      lastObservedNativeId: 10,
      safeAckNativeId: 10,
      frontierEvidence: Buffer.from("frontier-proof-2"),
    }),
    /UNIQUE constraint failed/u,
  );

  insertBot(connection, "bot:generation");
  insertSource(connection, {
    botKey: "bot:generation",
    generation: 2,
    isActive: 0,
    incarnationStatus: "retired",
  });
  assert.throws(
    () => insertSource(connection, {
      botKey: "bot:generation",
      generation: 1,
    }),
    /source generation must increase monotonically/u,
  );
});

test("destructive ACK intents require a verified incarnation and one safe frontier", async (t) => {
  const directory = await temporaryDirectory(t, "durable-state-intents-");
  const connection = openStorage(nodeSqliteAdapter, path.join(directory, "state.sqlite3"));
  t.after(() => connection.close());
  applySchema(connection);

  insertBot(connection, "bot:intents");
  assert.throws(
    () => insertSource(connection, {
      botKey: "bot:intents",
      incarnationStatus: "verified",
      incarnationEvidence: Buffer.from("local-volume-epoch-1"),
      cursorStatus: "verified",
      lastObservedNativeId: 10,
      safeAckNativeId: 500,
      frontierEvidence: Buffer.from("operator-import"),
    }),
    /CHECK constraint failed/u,
  );

  insertSource(connection, {
    botKey: "bot:intents",
    incarnationStatus: "verified",
    incarnationEvidence: Buffer.from("local-volume-epoch-1"),
    cursorStatus: "verified",
    lastObservedNativeId: 10,
    safeAckNativeId: 10,
    frontierEvidence: Buffer.from("operator-import"),
  });
  connection.run(
    `INSERT INTO poll_intents (
      bot_key,
      source,
      generation,
      incarnation_evidence_hmac,
      native_offset,
      status,
      prepared_at_ms,
      completed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "bot:intents",
      "local",
      1,
      Buffer.from("local-volume-epoch-1"),
      11,
      "ambiguous",
      1_000,
      1_001,
    ],
  );

  assert.throws(
    () => connection.run(
      `INSERT INTO poll_intents (
        bot_key,
        source,
        generation,
        incarnation_evidence_hmac,
        native_offset,
        status,
        prepared_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "bot:intents",
        "local",
        1,
        Buffer.from("local-volume-epoch-1"),
        11,
        "prepared",
        1_002,
      ],
    ),
    /UNIQUE constraint failed/u,
  );

  connection.run(
    `UPDATE poll_intents
     SET status = ?, completed_at_ms = ?
     WHERE bot_key = ? AND status = ?`,
    ["failed", 1_003, "bot:intents", "ambiguous"],
  );
  assert.throws(
    () => connection.run(
      `INSERT INTO poll_intents (
        bot_key,
        source,
        generation,
        incarnation_evidence_hmac,
        native_offset,
        status,
        prepared_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "bot:intents",
        "local",
        1,
        Buffer.from("local-volume-epoch-1"),
        12,
        "prepared",
        1_004,
      ],
    ),
    /unsafe prepared poll intent/u,
  );
  assert.throws(
    () => connection.run(
      `INSERT INTO poll_intents (
        bot_key,
        source,
        generation,
        incarnation_evidence_hmac,
        native_offset,
        status,
        prepared_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "bot:intents",
        "local",
        1,
        Buffer.from("replacement-volume-epoch"),
        11,
        "prepared",
        1_005,
      ],
    ),
    /FOREIGN KEY constraint failed|unsafe prepared poll intent/u,
  );
  connection.run(
    `INSERT INTO poll_intents (
      bot_key,
      source,
      generation,
      incarnation_evidence_hmac,
      native_offset,
      status,
      prepared_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      "bot:intents",
      "local",
      1,
      Buffer.from("local-volume-epoch-1"),
      11,
      "prepared",
      1_006,
    ],
  );
  const localManifestKey = sourceManifestKey("bot:intents", "local", 1);
  assert.throws(
    () => verifyUnresolvedIntentIncarnations(connection, new Map()),
    /source incarnation mismatch/u,
  );
  assert.throws(
    () => verifyUnresolvedIntentIncarnations(
      connection,
      new Map([[localManifestKey, Buffer.from("replacement-volume-epoch")]]),
    ),
    /source incarnation mismatch/u,
  );
  assert.equal(
    verifyUnresolvedIntentIncarnations(
      connection,
      new Map([[localManifestKey, Buffer.from("local-volume-epoch-1")]]),
    ).length,
    1,
  );
});

test("observed ACK frontiers stop at quarantined or non-terminal updates", async (t) => {
  const directory = await temporaryDirectory(t, "durable-state-frontier-");
  const connection = openStorage(nodeSqliteAdapter, path.join(directory, "state.sqlite3"));
  t.after(() => connection.close());
  applySchema(connection);

  insertBot(connection, "bot:frontier");
  insertSource(connection, {
    botKey: "bot:frontier",
    cursorStatus: "observed",
    lastObservedNativeId: 12,
  });
  for (const updateId of [10, 11, 12]) {
    insertCommittedEvent(connection, "bot:frontier", updateId);
  }
  assert.throws(
    () => insertSourceUpdate(connection, {
      botKey: "bot:frontier",
      nativeUpdateId: 9,
      logicalVirtualUpdateId: 10,
      disposition: "quarantined",
    }),
    /CHECK constraint failed/u,
  );
  insertSourceUpdate(connection, {
    botKey: "bot:frontier",
    nativeUpdateId: 10,
    logicalVirtualUpdateId: 10,
    terminal: 1,
  });
  insertSourceUpdate(connection, {
    botKey: "bot:frontier",
    nativeUpdateId: 11,
    disposition: "quarantined",
  });
  insertSourceUpdate(connection, {
    botKey: "bot:frontier",
    nativeUpdateId: 12,
    logicalVirtualUpdateId: 12,
    terminal: 1,
  });

  assert.throws(
    () => connection.run(
      `UPDATE source_state SET safe_ack_native_id = ? WHERE bot_key = ?`,
      [12, "bot:frontier"],
    ),
    /safe ACK frontier is not a terminal prefix/u,
  );
  assert.throws(
    () => connection.run(
      `UPDATE source_updates
       SET terminal = 1, terminal_at_ms = ?
       WHERE bot_key = ? AND native_update_id = ?`,
      [1_002, "bot:frontier", 11],
    ),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => connection.run(
      `DELETE FROM source_updates
       WHERE bot_key = ? AND native_update_id = ?`,
      ["bot:frontier", 11],
    ),
    /permanent tombstone/u,
  );
  assert.throws(
    () => connection.run(
      `INSERT OR REPLACE INTO source_updates (
        bot_key,
        source,
        generation,
        native_update_id,
        logical_virtual_update_id,
        disposition,
        terminal,
        observed_at_ms,
        terminal_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "bot:frontier",
        "local",
        1,
        10,
        12,
        "event",
        1,
        2_000,
        2_001,
      ],
    ),
    /permanent tombstone/u,
  );

  connection.run(
    `UPDATE source_updates
     SET disposition = ?, logical_virtual_update_id = ?
     WHERE bot_key = ? AND native_update_id = ?`,
    ["event", 11, "bot:frontier", 11],
  );
  connection.run(
    `UPDATE source_updates
     SET terminal = 1, terminal_at_ms = ?
     WHERE bot_key = ? AND native_update_id = ?`,
    [1_002, "bot:frontier", 11],
  );
  connection.run(
    `UPDATE source_state SET safe_ack_native_id = ? WHERE bot_key = ?`,
    [12, "bot:frontier"],
  );
  assert.equal(
    connection.get(
      "SELECT safe_ack_native_id FROM source_state WHERE bot_key = ?",
      ["bot:frontier"],
    ).safe_ack_native_id,
    12,
  );
  assert.throws(
    () => insertSourceUpdate(connection, {
      botKey: "bot:frontier",
      nativeUpdateId: 9,
      disposition: "quarantined",
    }),
    /at or below the safe ACK frontier/u,
  );
  assert.throws(
    () => connection.run(
      `DELETE FROM source_updates
       WHERE bot_key = ? AND native_update_id = ?`,
      ["bot:frontier", 10],
    ),
    /permanent tombstone/u,
  );
});

test("strong mirror suppression validates identity, commit state, and source", async (t) => {
  const directory = await temporaryDirectory(t, "durable-state-fingerprints-");
  const connection = openStorage(nodeSqliteAdapter, path.join(directory, "state.sqlite3"));
  t.after(() => connection.close());
  applySchema(connection);

  for (const botKey of ["bot:match", "bot:other"]) {
    insertBot(connection, botKey);
    insertCommittedEvent(
      connection,
      botKey,
      botKey === "bot:match" ? 100 : 200,
      {
        fingerprint: Buffer.from(
          botKey === "bot:match" ? "same-event" : "other-event",
        ),
      },
    );
  }
  insertCommittedEvent(connection, "bot:match", 101, {
    fingerprint: Buffer.from("ambiguous-event"),
    strength: "ambiguous",
  });
  insertSource(connection, { botKey: "bot:match", source: "local" });
  insertSource(connection, { botKey: "bot:match", source: "cloud" });
  insertSource(connection, { botKey: "bot:other", source: "local" });
  connection.run(
    "UPDATE bot_state SET active_source = ? WHERE bot_key = ?",
    ["local", "bot:match"],
  );
  connection.run(
    `INSERT INTO media_aliases (
      bot_key,
      logical_virtual_update_id,
      source,
      source_generation,
      media_role,
      file_unique_id,
      file_id_ciphertext,
      file_id_nonce,
      file_id_key_id,
      created_at_ms,
      expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "bot:match",
      100,
      "cloud",
      1,
      "photo",
      "unique-photo",
      Buffer.from("encrypted-file-id"),
      Buffer.from("file-id-nonce"),
      "file-id-key",
      1_000,
      172_801_000,
    ],
  );
  assert.throws(
    () => connection.run(
      `UPDATE media_aliases
       SET logical_virtual_update_id = ?
       WHERE bot_key = ? AND file_unique_id = ?`,
      [101, "bot:match", "unique-photo"],
    ),
    /media alias identity is immutable/u,
  );
  assert.throws(
    () => connection.run(
      `DELETE FROM media_aliases
       WHERE bot_key = ? AND file_unique_id = ?`,
      ["bot:match", "unique-photo"],
    ),
    /media alias identity is a permanent tombstone/u,
  );

  insertSourceUpdate(connection, {
    botKey: "bot:match",
    source: "local",
    nativeUpdateId: 10,
    logicalVirtualUpdateId: 100,
    terminal: 1,
  });
  insertSourceUpdate(connection, {
    botKey: "bot:match",
    source: "local",
    nativeUpdateId: 11,
    logicalVirtualUpdateId: 100,
  });
  assert.throws(
    () => connection.run(
      `UPDATE source_updates
       SET logical_virtual_update_id = ?
       WHERE bot_key = ? AND source = ? AND native_update_id = ?`,
      [101, "bot:match", "local", 11],
    ),
    /source update mapping is immutable once assigned/u,
  );
  assert.throws(
    () => connection.run(
      "UPDATE bot_state SET active_source = ? WHERE bot_key = ?",
      ["cloud", "bot:match"],
    ),
    /active source has non-terminal source updates/u,
  );
  insertSourceUpdate(connection, {
    botKey: "bot:match",
    source: "cloud",
    nativeUpdateId: 20,
    logicalVirtualUpdateId: 100,
    disposition: "mirror",
  });
  insertSourceUpdate(connection, {
    botKey: "bot:match",
    source: "cloud",
    nativeUpdateId: 22,
    disposition: "quarantined",
  });
  insertFingerprintOccurrence(connection, {
    occurrenceId: 5,
    botKey: "bot:match",
    source: "cloud",
    nativeUpdateId: 22,
    fingerprint: Buffer.from("ambiguous-event"),
    strength: "ambiguous",
  });
  connection.run(
    `UPDATE source_updates
     SET disposition = 'event', logical_virtual_update_id = ?
     WHERE bot_key = ? AND source = ? AND native_update_id = ?`,
    [101, "bot:match", "cloud", 22],
  );
  connection.run(
    `UPDATE fingerprint_occurrences
     SET logical_virtual_update_id = ?, committed = 1
     WHERE occurrence_id = ?`,
    [101, 5],
  );
  connection.run(
    `UPDATE source_updates
     SET terminal = 1, terminal_at_ms = ?
     WHERE bot_key = ? AND source = ? AND native_update_id = ?`,
    [1_002, "bot:match", "cloud", 22],
  );
  assert.throws(
    () => insertSourceUpdate(connection, {
      botKey: "bot:match",
      source: "cloud",
      nativeUpdateId: 21,
      logicalVirtualUpdateId: 100,
      disposition: "mirror",
      terminal: 1,
    }),
    /terminal mirror must be staged/u,
  );
  insertSourceUpdate(connection, {
    botKey: "bot:other",
    source: "local",
    nativeUpdateId: 30,
    logicalVirtualUpdateId: 200,
    terminal: 1,
  });

  assert.throws(
    () => insertFingerprintOccurrence(connection, {
      occurrenceId: 6,
      botKey: "bot:match",
      source: "local",
      nativeUpdateId: 10,
      logicalVirtualUpdateId: 100,
      fingerprint: Buffer.from("wrong-logical-identity"),
      committed: 1,
    }),
    /committed fingerprint is not backed by a committed event/u,
  );
  insertFingerprintOccurrence(connection, {
    occurrenceId: 1,
    botKey: "bot:match",
    source: "local",
    nativeUpdateId: 10,
    logicalVirtualUpdateId: 100,
    fingerprint: Buffer.from("same-event"),
    committed: 1,
  });
  insertFingerprintOccurrence(connection, {
    occurrenceId: 2,
    botKey: "bot:other",
    source: "local",
    nativeUpdateId: 30,
    logicalVirtualUpdateId: 200,
    fingerprint: Buffer.from("other-event"),
    committed: 1,
  });
  insertFingerprintOccurrence(connection, {
    occurrenceId: 3,
    botKey: "bot:match",
    source: "local",
    nativeUpdateId: 11,
    logicalVirtualUpdateId: 100,
    fingerprint: Buffer.from("same-event"),
    committed: 0,
  });

  const mirror = {
    occurrenceId: 4,
    botKey: "bot:match",
    source: "cloud",
    nativeUpdateId: 20,
    logicalVirtualUpdateId: 100,
    fingerprint: Buffer.from("same-event"),
    suppressed: 1,
  };
  assert.throws(
    () => insertFingerprintOccurrence(connection, {
      ...mirror,
      matchedOccurrenceId: 2,
    }),
    /invalid strong mirror match/u,
  );
  assert.throws(
    () => insertFingerprintOccurrence(connection, {
      ...mirror,
      matchedOccurrenceId: 3,
    }),
    /invalid strong mirror match/u,
  );
  assert.throws(
    () => insertFingerprintOccurrence(connection, {
      ...mirror,
      fingerprint: Buffer.from("wrong-fingerprint"),
      matchedOccurrenceId: 1,
    }),
    /invalid strong mirror match/u,
  );

  insertFingerprintOccurrence(connection, {
    ...mirror,
    matchedOccurrenceId: 1,
  });
  assert.throws(
    () => connection.run(
      `UPDATE fingerprint_occurrences
       SET logical_virtual_update_id = ?
       WHERE occurrence_id = ?`,
      [101, 1],
    ),
    /logical event link is immutable|committed fingerprint is not backed/u,
  );
  assert.throws(
    () => connection.run(
      `UPDATE source_updates
       SET disposition = 'event'
       WHERE bot_key = ? AND source = ? AND native_update_id = ?`,
      ["bot:match", "cloud", 20],
    ),
    /fingerprinted source update mapping is immutable/u,
  );
  assert.throws(
    () => connection.run(
      "DELETE FROM fingerprint_occurrences WHERE occurrence_id = ?",
      [4],
    ),
    /fingerprint occurrence identity is a permanent tombstone/u,
  );
  connection.run(
    `UPDATE source_updates
     SET terminal = 1, terminal_at_ms = ?
     WHERE bot_key = ? AND source = ? AND native_update_id = ?`,
    [1_002, "bot:match", "cloud", 20],
  );
  assert.equal(
    connection.get(
      `SELECT terminal
       FROM source_updates
       WHERE bot_key = ? AND source = ? AND native_update_id = ?`,
      ["bot:match", "cloud", 20],
    ).terminal,
    1,
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

  applySchema(connection);
  insertBot(connection, "bot:backup", 1_201);
  connection.run(
    `INSERT INTO state_events (
      state_event_id,
      bot_key,
      event_type,
      created_at_ms
    ) VALUES (?, ?, ?, ?)`,
    [1, "bot:backup", "before-backup", 1_000],
  );

  const copiedPages = await nodeSqliteAdapter.backup(connection, backupPath);
  assert.ok(copiedPages > 0);
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);

  connection.run(
    `INSERT INTO state_events (
      state_event_id,
      bot_key,
      event_type,
      created_at_ms
    ) VALUES (?, ?, ?, ?)`,
    [2, "bot:backup", "after-backup", 2_000],
  );
  connection.run(
    `UPDATE bot_state
     SET allocator_anchor_high_water = ?, next_virtual_update_id = ?, updated_at_ms = ?
     WHERE bot_key = ?`,
    [1_300, 1_301, 2_000, "bot:backup"],
  );
  connection.close();

  const restored = openStorage(nodeSqliteAdapter, backupPath);
  assert.deepEqual(restored.integrityCheck(), ["ok"]);
  assert.deepEqual(restored.all("PRAGMA foreign_key_check"), []);
  verifyStorageForRestore(restored, [SCHEMA_MIGRATION]);
  assert.deepEqual(
    restored.all(
      `SELECT state_event_id, event_type
       FROM state_events
       ORDER BY state_event_id`,
    ),
    [{ state_event_id: 1, event_type: "before-backup" }],
  );
  assert.deepEqual(
    restored.get(
      `SELECT next_virtual_update_id, allocator_anchor_high_water
       FROM bot_state
       WHERE bot_key = ?`,
      ["bot:backup"],
    ),
    {
      next_virtual_update_id: 1_201,
      allocator_anchor_high_water: -1,
    },
  );
  assert.throws(
    () => reconcileAllocatorHighWaters(restored, {}, 2_001),
    /missing external allocator high-water/u,
  );
  assert.throws(
    () => reconcileAllocatorHighWaters(
      restored,
      {
        "bot:backup": 1_300,
        "bot:created-after-backup": 8_000,
      },
      2_001,
    ),
    /has no restored bot state/u,
  );
  reconcileAllocatorHighWaters(
    restored,
    { "bot:backup": 1_300 },
    2_001,
  );
  assert.deepEqual(
    restored.get(
      `SELECT next_virtual_update_id, allocator_anchor_high_water
       FROM bot_state
       WHERE bot_key = ?`,
      ["bot:backup"],
    ),
    {
      next_virtual_update_id: 1_301,
      allocator_anchor_high_water: 1_300,
    },
  );
  assert.throws(
    () => reconcileAllocatorHighWaters(
      restored,
      { "bot:backup": 1_299 },
      2_002,
    ),
    /stale external allocator high-water/u,
  );
  restored.close();

  const occupiedPath = path.join(directory, "occupied.sqlite3");
  await writeFile(occupiedPath, "do-not-overwrite", { mode: 0o600 });
  const backupSource = openStorage(nodeSqliteAdapter, databasePath);
  t.after(() => backupSource.close());
  await assert.rejects(
    nodeSqliteAdapter.backup(backupSource, occupiedPath),
    /EEXIST/u,
  );
  await chmod(directory, 0o755);
  await assert.rejects(
    nodeSqliteAdapter.backup(
      backupSource,
      path.join(directory, "insecure-parent.sqlite3"),
    ),
    /backup directory must be private/u,
  );
  await chmod(directory, 0o700);
  backupSource.close();
  assert.equal(await readFile(occupiedPath, "utf8"), "do-not-overwrite");
});

test("online backup stays consistent while the source connection mutates", async (t) => {
  const directory = await temporaryDirectory(t, "durable-state-online-backup-");
  const databasePath = path.join(directory, "state.sqlite3");
  const backupPath = path.join(directory, "state.concurrent.sqlite3");
  const connection = openStorage(nodeSqliteAdapter, databasePath);
  t.after(() => connection.close());

  applySchema(connection);
  insertBot(connection, "bot:concurrent-backup", 1_000);
  connection.exec(`
    CREATE TABLE concurrent_backup_probe (
      id INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    ) STRICT;
  `);
  connection.transaction((transaction) => {
    for (let id = 1; id <= 256; id += 1) {
      transaction.run(
        "INSERT INTO concurrent_backup_probe (id, payload) VALUES (?, ?)",
        [id, Buffer.alloc(8_192, id % 251)],
      );
    }
  });

  let mutationApplied = false;
  const copiedPages = await nodeSqliteAdapter.backup(
    connection,
    backupPath,
    {
      rate: 1,
      progress() {
        if (mutationApplied) return;
        connection.transaction((transaction) => {
          transaction.run(
            "INSERT INTO concurrent_backup_probe (id, payload) VALUES (?, ?)",
            [257, Buffer.from("committed-during-backup")],
          );
          transaction.run(
            `UPDATE bot_state
             SET allocator_anchor_high_water = ?,
                 next_virtual_update_id = ?,
                 updated_at_ms = ?
             WHERE bot_key = ?`,
            [1_100, 1_101, 2_000, "bot:concurrent-backup"],
          );
        });
        mutationApplied = true;
      },
    },
  );
  assert.ok(copiedPages > 1);
  assert.equal(mutationApplied, true);

  const restored = openStorage(nodeSqliteAdapter, backupPath);
  assert.deepEqual(restored.integrityCheck(), ["ok"]);
  assert.deepEqual(restored.all("PRAGMA foreign_key_check"), []);
  assert.equal(
    restored.get("SELECT COUNT(*) AS count FROM concurrent_backup_probe").count,
    257,
  );
  assert.deepEqual(
    restored.get(
      `SELECT next_virtual_update_id, allocator_anchor_high_water
       FROM bot_state
       WHERE bot_key = ?`,
      ["bot:concurrent-backup"],
    ),
    {
      next_virtual_update_id: 1_101,
      allocator_anchor_high_water: 1_100,
    },
  );
  restored.close();
});
