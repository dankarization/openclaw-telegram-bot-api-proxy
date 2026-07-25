import { createHash } from "node:crypto";

const ADAPTER_METHODS = ["open", "backup"];
const CONNECTION_METHODS = [
  "all",
  "close",
  "exec",
  "get",
  "integrityCheck",
  "run",
  "transaction",
];

export function assertStorageAdapter(adapter) {
  if (adapter == null || typeof adapter !== "object") {
    throw new TypeError("storage adapter must be an object");
  }
  if (typeof adapter.name !== "string" || adapter.name.length === 0) {
    throw new TypeError("storage adapter must have a name");
  }
  for (const method of ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new TypeError(`storage adapter ${adapter.name} is missing ${method}()`);
    }
  }
  return adapter;
}

export function assertStorageConnection(connection, adapterName = "unknown") {
  if (connection == null || typeof connection !== "object") {
    throw new TypeError(`${adapterName} open() must return a connection object`);
  }
  for (const method of CONNECTION_METHODS) {
    if (typeof connection[method] !== "function") {
      throw new TypeError(`${adapterName} connection is missing ${method}()`);
    }
  }
  return connection;
}

export function openStorage(adapter, databasePath) {
  assertStorageAdapter(adapter);
  return assertStorageConnection(adapter.open(databasePath), adapter.name);
}

export function storageCatalogSha256(connection) {
  assertStorageConnection(connection);
  const catalog = connection.all(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name, tbl_name`,
  );
  return createHash("sha256")
    .update(JSON.stringify(catalog), "utf8")
    .digest("hex");
}

export function applyStorageMigration(connection, migration) {
  assertStorageConnection(connection);
  if (!Number.isSafeInteger(migration?.version) || migration.version < 1) {
    throw new TypeError("migration version must be a positive safe integer");
  }
  if (typeof migration.name !== "string" || migration.name.length === 0) {
    throw new TypeError("migration name must be a non-empty string");
  }
  if (!/^[a-f0-9]{64}$/u.test(String(migration.sha256 || ""))) {
    throw new TypeError("migration sha256 must be 64 lowercase hexadecimal characters");
  }
  if (typeof migration.sql !== "string" || migration.sql.length === 0) {
    throw new TypeError("migration sql must be a non-empty string");
  }
  if (!Number.isSafeInteger(migration.appliedAtMs) || migration.appliedAtMs < 0) {
    throw new TypeError("migration appliedAtMs must be a non-negative safe integer");
  }
  const actualSha256 = createHash("sha256")
    .update(migration.sql, "utf8")
    .digest("hex");
  if (migration.sha256 !== actualSha256) {
    throw new Error(
      `migration sha256 mismatch: expected ${migration.sha256}, received ${actualSha256}`,
    );
  }

  return connection.transaction((transaction) => {
    transaction.exec(migration.sql);
    const catalogSha256 = storageCatalogSha256(transaction);
    transaction.run(
      `INSERT INTO schema_meta (
        schema_version,
        migration_name,
        schema_sha256,
        catalog_sha256,
        applied_at_ms
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        migration.version,
        migration.name,
        migration.sha256,
        catalogSha256,
        migration.appliedAtMs,
      ],
    );
  });
}
