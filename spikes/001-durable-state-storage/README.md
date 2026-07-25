# Durable state storage spike

This non-production spike answers whether the supported Node 22 runtime can
provide the SQLite durability primitives required by the later ACK-aware
StateStore.

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
database reopens with `integrity_check=ok`. The backup test proves that the
restored file is a consistent snapshot rather than a copy of later mutations.

`better-sqlite3` 13.0.1 also passed an isolated WAL/reopen/backup smoke probe on
Node v22.23.1. It remains the fallback, but it is not added to the repository
because the built-in driver meets the requirements without a native dependency.

Recommendation: use the adapter contract in PR 2 and re-run this spike on every
supported Node runtime upgrade. Do not import this spike from the production
proxy.

The complete comparison, invariants, schema, retention policy, runtime flags,
and deferred decisions are in `docs/durable-reconciliation-pr0.md`.
