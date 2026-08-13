# Durable state storage spike

This non-production spike answers whether the supported Node 22 runtime can
provide the SQLite durability primitives required by the later ACK-aware
StateStore.

Supported runtime for this spike is Node `>=22.16.0 <23`, where
`node:sqlite.backup` is available throughout the declared range. Node 23 is
excluded because releases before 23.8.0 lack that API. The complete evidence
below was run on Node `22.23.1`; PR 2 must also perform a startup capability
probe.

## Verdict: VALIDATED

Question: can a driver-neutral adapter provide WAL, FULL synchronous commits,
foreign keys, a busy timeout, crash/reopen recovery, integrity checks, online
backup, and `0600` database files?

Evidence:

```bash
node --test test/durable-state-storage-spike.test.mjs
```

The selected `node:sqlite` adapter passes. The process-kill test proves that a
committed row survives `SIGKILL`, an open transaction rolls back, and the
database reopens with `integrity_check=ok`. Backup tests cover a stale snapshot
and a same-connection transaction committed while an incremental backup is in
progress. Migration SQL is SHA-256 checked before its DDL and `schema_meta` row
commit atomically. Backup creation requires a private parent directory, writes
an exclusive hidden `0600` staging file, then publishes it with a no-overwrite
hard link; existing paths and symlinks are never replaced. Publication fsyncs
the completed file and parent directory before reporting success.
The restore-gate probe additionally rejects unexpected migration history,
missing/stale virtual-ID anchors, and unresolved poll intents whose normalized
external source-incarnation evidence does not match. Offset-zero intents are
non-destructive and may restore without incarnation evidence, matching the
schema contract.

`better-sqlite3` 13.0.1 also passed a one-time isolated WAL/reopen/backup smoke
probe on Node v22.23.1. That external observation is not part of repository
acceptance evidence. It remains the fallback, but it is not added because the
built-in driver meets the requirements without a native dependency.

Recommendation: use the adapter contract in PR 2 and re-run this spike on every
supported Node runtime upgrade. Do not import this spike from the production
proxy.

The complete comparison, invariants, schema, retention policy, runtime flags,
and deferred decisions are in `docs/durable-reconciliation-pr0.md`.
