# PR 0: durable reconciliation design and storage decision

Status: design and test infrastructure only

Base: `main` at `c301f55`

Production behavior: unchanged

## Verdict: VALIDATED

Question: can the proxy use a driver-neutral SQLite boundary on the deployed
Node 22 runtime and obtain WAL durability, crash recovery, reopen, and online
backup without adding a native production dependency?

Yes. `node:sqlite` on Node `v22.23.1` passed the repository crash, reopen,
integrity, permissions, and online-backup tests. Its API is still marked
experimental by Node, so all driver-specific behavior stays behind the small
adapter contract in `spikes/001-durable-state-storage/`.

`better-sqlite3` remains a credible fallback. Version `13.0.1` was installed in
an isolated temporary prefix on the same Node runtime and passed the same basic
WAL, reopen, online-backup, and integrity probe. It was not selected because it
would add a native addon and its install/update lifecycle without improving the
required synchronous state-machine operations. No `better-sqlite3` dependency
is added to this repository.

Decision: use `node:sqlite` for the PR 2 StateStore, retain the driver-neutral
contract, and re-run this spike whenever the supported Node runtime changes.
Switch to `better-sqlite3` if a Node upgrade breaks the tested contract or if
the experimental API cannot satisfy a production requirement.

The current package range, Node `>=22`, is broader than the runtime validated by
this spike. PR 2 must either raise the minimum to the first explicitly validated
runtime or fail startup on a capability probe for both `DatabaseSync` and
`backup`; the range alone is not evidence that the API is present.

## Frozen delivery invariants

These are design constraints for later PRs. PR 0 does not enforce them in the
running proxy.

1. A virtual update ID is allocated once, is never reused, and remains within
   JavaScript's safe-integer range.
2. A `(bot_key, source, generation, native_update_id)` maps to at most one
   logical event and never changes virtual ID.
3. One bot may have at most one active offered batch. Different bots may poll
   concurrently; one bot's polling cycle is serialized.
4. A downstream client offset acknowledges only virtual IDs that were actually
   offered and are strictly below that offset.
5. The proxy does not send an upstream positive offset past an unacknowledged
   source update.
6. A repeated valid client offset replays the stored unacknowledged batch tail
   with byte-equivalent payload and identical virtual IDs.
7. A source switch occurs only after the active batch is fully acknowledged.
   A downstream batch contains updates from one source.
8. Native offsets come only from stored source observations and terminal
   frontiers. Virtual-to-native affine extrapolation is forbidden.
9. Unknown cloud cursors receive neither a high virtual offset nor a negative
   offset. They remain fail closed until a later reconciliation gate.
10. Database corruption or a required-state failure never silently falls back
    to RAM-only enforce behavior.

## ACK-aware state machine

```mermaid
stateDiagram-v2
    [*] --> STORED: persist source update and encrypted payload
    STORED --> OFFERED: persist exact downstream batch
    OFFERED --> OFFERED: replay same unacknowledged tail
    OFFERED --> ACKED: next client offset acknowledges offered prefix
    ACKED --> ACK_INTENT: persist safe native offset
    ACK_INTENT --> UPSTREAM_CONFIRMED: upstream poll completes unambiguously
    STORED --> SUPPRESSED_STRONG_MIRROR: one-to-one committed strong match
    SUPPRESSED_STRONG_MIRROR --> ACK_INTENT
    STORED --> QUARANTINED_AMBIGUOUS: weak or conflicting identity
```

Only `UPSTREAM_CONFIRMED` and a proven `SUPPRESSED_STRONG_MIRROR` are terminal
for a source update. `QUARANTINED_AMBIGUOUS` never advances the source frontier
without an explicit operator decision.

Client offset rules for durable mode:

- negative offset: HTTP 400;
- offset within the active offered batch: acknowledge the offered prefix and
  replay the remaining tail;
- offset below the acknowledged prefix: HTTP 409 `stale-client-offset`;
- offset above `highest_offered + 1`: fail closed as an unknown skip;
- offset zero before any offer: acknowledges nothing.

Crash ordering:

1. A prepared native ACK intent is durable before the upstream request.
2. A crash before an upstream response leaves the intent safe to retry.
3. A crash after the response but before the SQLite transaction gets the native
   updates again because that response did not acknowledge its returned tail.
4. A crash after the SQLite transaction but before the HTTP write replays the
   stored batch.
5. A lost HTTP response does not allocate new virtual IDs for the repeated
   client offset.

## Fake Telegram queue contract

`test/support/fake-telegram-queue.mjs` is a deterministic upstream simulator for
PR 0 and PR 1 tests.

- `offset=0` returns pending updates without acknowledging any of them.
- A positive offset first removes every `update_id < offset`, then returns the
  remaining queue in native-ID order.
- Applying a high virtual offset to a lower native queue deliberately empties
  that queue; the negative test documents why virtual offsets must never be
  forwarded upstream.
- A second poll while one poll is held open throws a conflict carrying status
  code `409`. The fake rejects the later request to make overlap deterministic;
  this is test instrumentation, not a claim about which real Telegram request
  wins arbitration.
- Negative offsets are rejected because their destructive tail semantics are
  outside the durable polling loop.

## Storage comparison

| Dimension | Node 22 `node:sqlite` | `better-sqlite3` 13.0.1 |
| --- | --- | --- |
| Runtime/API status | Built into the supported runtime; emits an experimental API warning. | Mature external API; MIT; package declares Node `>=22`. |
| Installation | No repository dependency or native-addon install step. | Native addon and about 27.3 MB unpacked package payload for the evaluated version. |
| State-machine shape | Synchronous connection, prepared statements, explicit transactions. | Equivalent synchronous shape. |
| Required pragmas | WAL, foreign keys, FULL synchronous, and busy timeout verified. | WAL and FULL synchronous verified in the isolated probe. |
| Reopen/backup | Reopen, `integrity_check`, and built-in online backup pass. | Reopen, `integrity_check`, and package online backup pass. |
| Hard-crash test | Committed WAL row survives `SIGKILL`; open transaction rolls back. | Not run because it is not the selected adapter. |
| Operational risk | Coupled to the pinned Node runtime and an experimental API. | Adds native binary/ABI, install, supply-chain, and update responsibilities. |

The adapter contract deliberately exposes only:

- `open(databasePath)`;
- `exec`, `run`, `get`, and `all`;
- synchronous `transaction(work)`;
- `integrityCheck()` and `close()`;
- online `backup(connection, destinationPath)`.

Driver-specific row shapes are normalized at this boundary. Async work inside a
database transaction is rejected so a network request can never hold a SQLite
transaction open.

## Schema v1 responsibilities and constraints

The executable design schema is `docs/durable-state-schema-v1.sql`.

| Table | Frozen responsibility |
| --- | --- |
| `schema_meta` | Applied migration version, name, checksum, and time. |
| `bot_state` | Virtual allocator, acknowledged prefix, behavior mode, active source, and ledger epoch/readiness. |
| `source_state` | Independent local/cloud generation, cursor provenance, last observed native ID, and safe ACK frontier. |
| `logical_events` | Immutable virtual ID, encrypted replay payload, versioned fingerprint, and logical delivery state. |
| `source_updates` | Exact source/generation/native observation, logical-event link, disposition, and terminal state. |
| `poll_batches` | Exact encrypted response, client request signature/offset, virtual range, ACK progress, and batch state. |
| `poll_intents` | Durable upstream native offset and `prepared/completed/ambiguous/failed` result. |
| `fingerprint_occurrences` | Versioned HMAC occurrences and one-to-one strong-mirror pairing; fingerprints are deliberately not globally unique. |
| `media_aliases` | Encrypted source-specific `file_id` keyed by logical event, media role, and `file_unique_id`. |
| `process_lease` | One process owner for the database/upstream queues. |
| `state_events` | Payload-free audit markers for important transitions and recovery actions. |

Frozen constraints:

- unique `(bot_key, source, generation, native_update_id)`;
- unique `(bot_key, virtual_update_id)`;
- one active source generation for each bot/source;
- one active offered batch and one prepared poll intent per bot;
- a committed occurrence may suppress at most one strong mirror occurrence;
- native and virtual IDs must be non-negative safe integers;
- a new native-ID epoch creates a new generation;
- tokens, plaintext payloads, plaintext `file_id` values, and HMAC key material
  are forbidden in the database;
- `safe_ack_native_id` means the greatest observed native ID that a future
  upstream request may safely pass. The request offset is that value plus one;
  an unknown frontier remains `NULL`.

Table and column names are now fixed for schema v1. PR 2 may add indexes or a
new forward migration, but it must not silently change these meanings.

## Retention decisions

| Data | Retention |
| --- | --- |
| Unacknowledged event payload and active batch response | No automatic expiry. Retain until committed, upstream-confirmed, or explicitly quarantined/exported by an operator. |
| Committed and upstream-confirmed ciphertext | Eligible for purge after 6 hours. Never purge while any source update or poll intent is non-terminal. |
| Fingerprint occurrences, terminal source observations, and media aliases | 48 hours after the last source observation. Pairing extends both occurrences to the later expiry. |
| Continuous ledger warm-up before unknown-cloud reconciliation | At least 26 hours in one compatible epoch with full proxy coverage. |
| Payload-free `state_events` | 30 days. |
| `bot_state`, active `source_state`, schema history, and current lease | Retain while the bot/database exists. |

Garbage collection is a later PR. It must run in bounded transactions and may
delete old logical rows only after preserving `next_virtual_update_id`,
acknowledged prefix, and safe source frontiers. Backup retention is an
operations decision because it depends on the deployment location; it is
explicitly deferred below.

## Runtime flags

| Flag | Accepted values | Default and validation |
| --- | --- | --- |
| `RECONCILIATION_MODE` | `legacy`, `shadow`, `enforce-local`, `enforce-known-cloud`, `reconcile-cloud` | `legacy`. Applies only to allowlisted bots. |
| `RECONCILIATION_BOT_ALLOWLIST` | Comma-separated unique decimal bot IDs | Empty. Empty means every bot stays on `legacy`. |
| `CLOUD_BOOTSTRAP_MODE` | `disabled`, `manual`, `automatic` | `disabled`. `automatic` is reserved and must fail configuration validation until a later design approval. |
| `STATE_DB_PATH` | Absolute path on a local filesystem | No implicit production path. Required when selected mode is not `legacy` or `STATE_REQUIRED=1`. Network shares are rejected. |
| `STATE_REQUIRED` | `0`, `1` | `0`. Value `1` makes integrity/open/lease failure a startup failure. Every enforce mode behaves as required state even if this flag is mistakenly `0`. |

`shadow` with `STATE_REQUIRED=0` may stop shadow recording and alert while the
legacy decision path continues. `shadow` with `STATE_REQUIRED=1`, and every
enforce mode, must not open the polling listener without a healthy database and
lease. No mode creates extra cloud polls merely to populate state.

## Explicitly deferred decisions

1. Deployment-specific absolute database path, systemd ownership, backup
   destination, and backup retention.
2. Exact AEAD algorithm, secret-storage integration, and encryption/HMAC key
   rotation procedure. Encryption of replay payload and `file_id` values is
   mandatory before any production state write.
3. Final canonicalizer registry and strong/weak policy by Telegram update kind.
4. Initial OpenClaw durable high-water import format. A one-time operator import
   remains preferred over coupling to OpenClaw's internal schema.
5. Process-lease TTL, heartbeat cadence, and stale-owner recovery runbook.
6. Automatic unknown-cloud bootstrap. The first rollout permits only a manual
   coordinator-owned operation after ledger readiness.
7. Distributed/high-availability StateStore. Schema v1 intentionally supports
   one proxy process per database.

## PR 0 non-goals

- No production proxy import from `spikes/`, `test/`, or the schema.
- No listener, routing, fallback, cursor, file, or multipart behavior change.
- No production database creation or migration.
- No ACK-aware replay, durable source switching, fingerprint suppression, or
  cloud reconciliation implementation.
- No end-to-end exactly-once claim; Telegram, SQLite, OpenClaw, and agent side
  effects do not share one transaction.
- No deployment, service restart, cloud queue access, push, or pull request.

## Verification evidence

- The four fake-queue tests pass: greater-offset ACK, zero-offset replay,
  destructive high-offset negative case, and overlap detection.
- The four selected-adapter tests pass: schema/reopen and required pragmas,
  critical schema constraints, hard-crash recovery, and online backup.
- The first focused storage run exposed `node:sqlite`'s null-prototype result
  rows. The adapter now normalizes `get`, `all`, and `run` results so this driver
  detail cannot leak into the future state machine.
- The complete suite passes: 18 unchanged proxy regressions plus 8 PR 0 tests,
  26/26 total.
- `git diff --check` is clean, and `src/telegram-bot-api-proxy.mjs` is untouched.

## Reproducible acceptance commands

```bash
node --test test/fake-telegram-queue.test.mjs
node --test test/durable-state-storage-spike.test.mjs
npm run check
git diff --check
```

Next engineering step: review and merge this design/test foundation, then build
PR 1's per-bot coordinator against the fake queue without importing any storage
spike into the production path. PR 2 may adopt the schema and adapter only after
its separate shadow-mode review.
