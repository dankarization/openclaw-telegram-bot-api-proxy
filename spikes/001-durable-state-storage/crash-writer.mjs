import { nodeSqliteAdapter } from "./node-sqlite-adapter.mjs";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("database path argument is required");

const connection = nodeSqliteAdapter.open(databasePath);
connection.exec(`
  CREATE TABLE IF NOT EXISTS crash_probe (
    id INTEGER PRIMARY KEY,
    phase TEXT NOT NULL
  ) STRICT;
`);
connection.run("INSERT INTO crash_probe (id, phase) VALUES (?, ?)", [1, "committed"]);
connection.exec("BEGIN IMMEDIATE");
connection.run("INSERT INTO crash_probe (id, phase) VALUES (?, ?)", [2, "uncommitted"]);

process.stdout.write("READY\n");
setInterval(() => {}, 1_000);
