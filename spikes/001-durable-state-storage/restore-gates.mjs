import { createHash, timingSafeEqual } from "node:crypto";

import { storageCatalogSha256 } from "./storage-adapter-contract.mjs";

function migrationSha256(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function assertExpectedMigration(migration) {
  if (!Number.isSafeInteger(migration?.version) || migration.version < 1) {
    throw new TypeError("expected migration version must be a positive safe integer");
  }
  if (typeof migration.name !== "string" || migration.name.length === 0) {
    throw new TypeError("expected migration name must be a non-empty string");
  }
  if (typeof migration.sql !== "string" || migration.sql.length === 0) {
    throw new TypeError("expected migration sql must be a non-empty string");
  }
  if (!/^[a-f0-9]{64}$/u.test(String(migration.sha256 || ""))) {
    throw new TypeError(
      "expected migration sha256 must be 64 lowercase hexadecimal characters",
    );
  }
  if (migrationSha256(migration.sql) !== migration.sha256) {
    throw new Error(`expected migration ${migration.version} sha256 is invalid`);
  }
}

export function verifyStorageForRestore(connection, expectedMigrations) {
  if (!Array.isArray(expectedMigrations) || expectedMigrations.length === 0) {
    throw new TypeError("expected migrations must be a non-empty array");
  }
  for (const migration of expectedMigrations) assertExpectedMigration(migration);

  const integrity = connection.integrityCheck();
  if (integrity.length !== 1 || integrity[0] !== "ok") {
    throw new Error(`storage integrity check failed: ${integrity.join(", ")}`);
  }
  const foreignKeyFailures = connection.all("PRAGMA foreign_key_check");
  if (foreignKeyFailures.length !== 0) {
    throw new Error("storage foreign-key check failed");
  }

  const recorded = connection.all(
    `SELECT
       schema_version,
       migration_name,
       schema_sha256,
       catalog_sha256
     FROM schema_meta
     ORDER BY schema_version`,
  );
  const expected = [...expectedMigrations]
    .sort((left, right) => left.version - right.version)
    .map((migration) => ({
      migration_name: migration.name,
      schema_sha256: migration.sha256,
      schema_version: migration.version,
    }));
  if (
    recorded.length !== expected.length
    || recorded.some((row, index) => (
      row.schema_version !== expected[index].schema_version
      || row.migration_name !== expected[index].migration_name
      || row.schema_sha256 !== expected[index].schema_sha256
    ))
  ) {
    throw new Error("recorded schema history does not match expected migrations");
  }
  const currentCatalogSha256 = storageCatalogSha256(connection);
  if (recorded.at(-1).catalog_sha256 !== currentCatalogSha256) {
    throw new Error("current SQLite catalog does not match the recorded schema digest");
  }
  return recorded;
}

export function reconcileAllocatorHighWaters(
  connection,
  externalHighWaters,
  updatedAtMs = Date.now(),
) {
  if (
    externalHighWaters == null
    || typeof externalHighWaters !== "object"
    || Array.isArray(externalHighWaters)
  ) {
    throw new TypeError("external allocator high-waters must be an object");
  }
  if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
    throw new TypeError("allocator reconciliation time must be a safe integer");
  }
  const botRows = connection.all(
    `SELECT bot_key, next_virtual_update_id, allocator_anchor_high_water
     FROM bot_state
     ORDER BY bot_key`,
  );
  const restoredBotKeys = new Set(botRows.map((row) => row.bot_key));
  for (const externalBotKey of Object.keys(externalHighWaters)) {
    if (!restoredBotKeys.has(externalBotKey)) {
      throw new Error(
        `external allocator high-water has no restored bot state for ${externalBotKey}`,
      );
    }
  }
  const reconciled = [];
  for (const row of botRows) {
    if (!Object.hasOwn(externalHighWaters, row.bot_key)) {
      throw new Error(`missing external allocator high-water for ${row.bot_key}`);
    }
    const externalHighWater = externalHighWaters[row.bot_key];
    if (
      !Number.isSafeInteger(externalHighWater)
      || externalHighWater < -1
      || externalHighWater >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(`invalid external allocator high-water for ${row.bot_key}`);
    }
    if (externalHighWater < row.allocator_anchor_high_water) {
      throw new Error(`stale external allocator high-water for ${row.bot_key}`);
    }
    reconciled.push({
      botKey: row.bot_key,
      externalHighWater,
      nextVirtualUpdateId: Math.max(
        row.next_virtual_update_id,
        externalHighWater + 1,
      ),
    });
  }

  connection.transaction((transaction) => {
    for (const row of reconciled) {
      transaction.run(
        `UPDATE bot_state
         SET allocator_anchor_high_water = ?,
             next_virtual_update_id = ?,
             updated_at_ms = MAX(updated_at_ms, ?)
         WHERE bot_key = ?`,
        [
          row.externalHighWater,
          row.nextVirtualUpdateId,
          updatedAtMs,
          row.botKey,
        ],
      );
    }
  });
  return reconciled;
}

export function sourceManifestKey(botKey, source, generation) {
  return `${botKey}\u0000${source}\u0000${generation}`;
}

function asByteBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

export function verifyUnresolvedIntentIncarnations(
  connection,
  externalIncarnations,
) {
  if (!(externalIncarnations instanceof Map)) {
    throw new TypeError("external source incarnations must be a Map");
  }
  const unresolved = connection.all(
    `SELECT
       bot_key,
       source,
       generation,
       incarnation_evidence_hmac
     FROM poll_intents
     WHERE status IN ('prepared', 'ambiguous')
     ORDER BY intent_id`,
  );
  for (const intent of unresolved) {
    const key = sourceManifestKey(
      intent.bot_key,
      intent.source,
      intent.generation,
    );
    const externalEvidence = asByteBuffer(externalIncarnations.get(key));
    const storedEvidence = asByteBuffer(intent.incarnation_evidence_hmac);
    if (
      externalEvidence == null
      || storedEvidence == null
      || externalEvidence.length !== storedEvidence.length
      || !timingSafeEqual(externalEvidence, storedEvidence)
    ) {
      throw new Error(`source incarnation mismatch for ${key}`);
    }
  }
  return unresolved;
}
