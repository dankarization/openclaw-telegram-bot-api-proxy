import { chmodSync } from "node:fs";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";

import {
  assertStorageAdapter,
  assertStorageConnection,
} from "./storage-adapter-contract.mjs";

const RAW_DATABASE = Symbol("rawDatabase");
const BUSY_TIMEOUT_MS = 5_000;

function bind(statement, method, parameters) {
  if (!Array.isArray(parameters)) {
    throw new TypeError("SQL parameters must be an array");
  }
  return statement[method](...parameters);
}

function normalizeRow(row) {
  return row == null ? row : { ...row };
}

class NodeSqliteConnection {
  constructor(databasePath) {
    this.databasePath = databasePath;
    this[RAW_DATABASE] = new DatabaseSync(databasePath);
    chmodSync(this.databasePath, 0o600);
    this.#configure();
  }

  #configure() {
    const database = this[RAW_DATABASE];
    const journalMode = database.prepare("PRAGMA journal_mode = WAL").get().journal_mode;
    if (journalMode !== "wal") {
      database.close();
      throw new Error(`node:sqlite did not enable WAL mode (received ${journalMode})`);
    }
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    `);
  }

  all(sql, parameters = []) {
    return bind(this[RAW_DATABASE].prepare(sql), "all", parameters).map(normalizeRow);
  }

  close() {
    if (this[RAW_DATABASE].isOpen) this[RAW_DATABASE].close();
  }

  exec(sql) {
    this[RAW_DATABASE].exec(sql);
  }

  get(sql, parameters = []) {
    return normalizeRow(bind(this[RAW_DATABASE].prepare(sql), "get", parameters));
  }

  integrityCheck() {
    return this.all("PRAGMA integrity_check").map((row) => row.integrity_check);
  }

  run(sql, parameters = []) {
    return normalizeRow(bind(this[RAW_DATABASE].prepare(sql), "run", parameters));
  }

  transaction(work) {
    if (typeof work !== "function") throw new TypeError("transaction work must be a function");
    this.exec("BEGIN IMMEDIATE");
    try {
      const result = work(this);
      if (result != null && typeof result.then === "function") {
        throw new TypeError("storage transactions must be synchronous");
      }
      this.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }
}

export const nodeSqliteAdapter = assertStorageAdapter({
  name: "node:sqlite",

  async backup(connection, destinationPath) {
    assertStorageConnection(connection, "node:sqlite");
    if (!(connection instanceof NodeSqliteConnection)) {
      throw new TypeError("node:sqlite backup requires a node:sqlite connection");
    }
    const copiedPages = await sqliteBackup(connection[RAW_DATABASE], destinationPath);
    chmodSync(destinationPath, 0o600);
    return copiedPages;
  },

  open(databasePath) {
    return new NodeSqliteConnection(databasePath);
  },
});
