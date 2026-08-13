import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import path from "node:path";

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

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function fsyncDirectory(directoryPath) {
  const descriptor = openSync(directoryPath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
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
      PRAGMA recursive_triggers = ON;
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

  async backup(connection, destinationPath, options = {}) {
    assertStorageConnection(connection, "node:sqlite");
    if (!(connection instanceof NodeSqliteConnection)) {
      throw new TypeError("node:sqlite backup requires a node:sqlite connection");
    }
    if (typeof destinationPath !== "string" || !path.isAbsolute(destinationPath)) {
      throw new TypeError("node:sqlite backup destination must be an absolute path");
    }
    const absoluteDestination = path.resolve(destinationPath);
    const parentDirectory = realpathSync(path.dirname(absoluteDestination));
    const parentStat = statSync(parentDirectory);
    const parentMode = parentStat.mode & 0o777;
    if (
      typeof process.geteuid === "function"
      && parentStat.uid !== process.geteuid()
    ) {
      throw new Error("node:sqlite backup directory must be owned by the process user");
    }
    if ((parentMode & 0o077) !== 0) {
      throw new Error(
        `node:sqlite backup directory must be private (received mode ${parentMode.toString(8)})`,
      );
    }
    const finalPath = path.join(parentDirectory, path.basename(absoluteDestination));
    const stagingPath = path.join(
      parentDirectory,
      `.${path.basename(absoluteDestination)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let descriptor = openSync(stagingPath, "wx", 0o600);
    let finalLinked = false;
    try {
      const openedIdentity = fstatSync(descriptor);
      const copiedPages = await sqliteBackup(
        connection[RAW_DATABASE],
        `/proc/self/fd/${descriptor}`,
        options,
      );
      fchmodSync(descriptor, 0o600);
      fsyncSync(descriptor);
      const stagedIdentity = lstatSync(stagingPath);
      if (!sameFileIdentity(openedIdentity, stagedIdentity)) {
        throw new Error("node:sqlite backup staging identity changed");
      }
      linkSync(stagingPath, finalPath);
      finalLinked = true;
      const finalIdentity = lstatSync(finalPath);
      if (!sameFileIdentity(openedIdentity, finalIdentity)) {
        throw new Error("node:sqlite backup publication identity changed");
      }
      closeSync(descriptor);
      descriptor = null;
      unlinkSync(stagingPath);
      fsyncDirectory(parentDirectory);
      return copiedPages;
    } catch (error) {
      if (descriptor != null) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the original backup error.
        }
      }
      if (finalLinked) {
        try {
          unlinkSync(finalPath);
        } catch {
          // Preserve the original backup error.
        }
      }
      try {
        unlinkSync(stagingPath);
      } catch {
        // Preserve the original backup error.
      }
      throw error;
    }
  },

  open(databasePath) {
    return new NodeSqliteConnection(databasePath);
  },
});
