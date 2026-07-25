-- Durable reconciliation state schema v1.
-- This is a reviewed design artifact for PR 0, not a production migration.

PRAGMA foreign_keys = ON;

CREATE TABLE schema_meta (
  schema_version INTEGER PRIMARY KEY,
  migration_name TEXT NOT NULL UNIQUE,
  schema_sha256 TEXT NOT NULL CHECK (length(schema_sha256) = 64),
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
) STRICT;

CREATE TABLE bot_state (
  bot_key TEXT PRIMARY KEY,
  next_virtual_update_id INTEGER NOT NULL
    CHECK (next_virtual_update_id BETWEEN 0 AND 9007199254740991),
  acknowledged_virtual_prefix INTEGER NOT NULL DEFAULT -1
    CHECK (acknowledged_virtual_prefix BETWEEN -1 AND 9007199254740991),
  active_source TEXT CHECK (active_source IS NULL OR active_source IN ('local', 'cloud')),
  reconciliation_mode TEXT NOT NULL DEFAULT 'legacy'
    CHECK (reconciliation_mode IN (
      'legacy',
      'shadow',
      'enforce-local',
      'enforce-known-cloud',
      'reconcile-cloud'
    )),
  ledger_epoch INTEGER NOT NULL DEFAULT 1 CHECK (ledger_epoch > 0),
  ledger_coverage_started_at_ms INTEGER CHECK (ledger_coverage_started_at_ms >= 0),
  ledger_ready_after_ms INTEGER CHECK (ledger_ready_after_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (next_virtual_update_id > acknowledged_virtual_prefix),
  CHECK (
    ledger_ready_after_ms IS NULL
    OR (
      ledger_coverage_started_at_ms IS NOT NULL
      AND ledger_ready_after_ms >= ledger_coverage_started_at_ms + 93600000
    )
  )
) STRICT;

CREATE TABLE source_state (
  bot_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local', 'cloud')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  cursor_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (cursor_status IN ('unknown', 'verified', 'observed')),
  last_observed_native_id INTEGER
    CHECK (last_observed_native_id BETWEEN 0 AND 9007199254740991),
  safe_ack_native_id INTEGER
    CHECK (safe_ack_native_id BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  PRIMARY KEY (bot_key, source, generation),
  FOREIGN KEY (bot_key) REFERENCES bot_state (bot_key) ON DELETE RESTRICT,
  CHECK (cursor_status <> 'unknown' OR safe_ack_native_id IS NULL),
  CHECK (cursor_status <> 'observed' OR last_observed_native_id IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX source_state_one_active_generation
  ON source_state (bot_key, source)
  WHERE is_active = 1;

CREATE TABLE logical_events (
  bot_key TEXT NOT NULL,
  virtual_update_id INTEGER NOT NULL
    CHECK (virtual_update_id BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL
    CHECK (state IN ('ready', 'offered', 'committed', 'quarantined')),
  event_kind TEXT NOT NULL,
  canonicalizer_version INTEGER CHECK (canonicalizer_version > 0),
  fingerprint_strength TEXT
    CHECK (fingerprint_strength IS NULL OR fingerprint_strength IN ('strong', 'weak', 'ambiguous')),
  fingerprint_hmac BLOB,
  payload_ciphertext BLOB,
  payload_nonce BLOB,
  payload_key_id TEXT,
  payload_expires_at_ms INTEGER CHECK (payload_expires_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  offered_at_ms INTEGER CHECK (offered_at_ms >= created_at_ms),
  committed_at_ms INTEGER CHECK (committed_at_ms >= created_at_ms),
  PRIMARY KEY (bot_key, virtual_update_id),
  FOREIGN KEY (bot_key) REFERENCES bot_state (bot_key) ON DELETE RESTRICT,
  CHECK (
    (canonicalizer_version IS NULL AND fingerprint_strength IS NULL AND fingerprint_hmac IS NULL)
    OR
    (canonicalizer_version IS NOT NULL AND fingerprint_strength IS NOT NULL AND fingerprint_hmac IS NOT NULL)
  ),
  CHECK (
    (payload_ciphertext IS NULL AND payload_nonce IS NULL AND payload_key_id IS NULL)
    OR
    (payload_ciphertext IS NOT NULL AND payload_nonce IS NOT NULL AND payload_key_id IS NOT NULL)
  ),
  CHECK (
    state NOT IN ('ready', 'offered')
    OR payload_ciphertext IS NOT NULL
  ),
  CHECK (state <> 'offered' OR offered_at_ms IS NOT NULL),
  CHECK (state <> 'committed' OR committed_at_ms IS NOT NULL)
) STRICT;

CREATE TABLE source_updates (
  bot_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local', 'cloud')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  native_update_id INTEGER NOT NULL
    CHECK (native_update_id BETWEEN 0 AND 9007199254740991),
  logical_virtual_update_id INTEGER,
  disposition TEXT NOT NULL CHECK (disposition IN ('event', 'mirror', 'quarantined')),
  terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  terminal_at_ms INTEGER CHECK (terminal_at_ms >= observed_at_ms),
  PRIMARY KEY (bot_key, source, generation, native_update_id),
  FOREIGN KEY (bot_key, source, generation)
    REFERENCES source_state (bot_key, source, generation)
    ON DELETE RESTRICT,
  FOREIGN KEY (bot_key, logical_virtual_update_id)
    REFERENCES logical_events (bot_key, virtual_update_id)
    ON DELETE RESTRICT,
  CHECK (
    (disposition IN ('event', 'mirror') AND logical_virtual_update_id IS NOT NULL)
    OR disposition = 'quarantined'
  ),
  CHECK (terminal = 0 OR terminal_at_ms IS NOT NULL)
) STRICT;

CREATE INDEX source_updates_safe_frontier
  ON source_updates (bot_key, source, generation, terminal, native_update_id);

CREATE TABLE poll_batches (
  batch_id INTEGER PRIMARY KEY,
  bot_key TEXT NOT NULL,
  request_virtual_offset INTEGER NOT NULL
    CHECK (request_virtual_offset BETWEEN 0 AND 9007199254740991),
  request_signature_hmac BLOB NOT NULL,
  first_virtual_update_id INTEGER
    CHECK (first_virtual_update_id BETWEEN 0 AND 9007199254740991),
  last_virtual_update_id INTEGER
    CHECK (last_virtual_update_id BETWEEN 0 AND 9007199254740991),
  acknowledged_through_virtual_id INTEGER
    CHECK (acknowledged_through_virtual_id BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL
    CHECK (state IN ('offered', 'partially_acked', 'committed', 'empty', 'abandoned')),
  response_ciphertext BLOB,
  response_nonce BLOB,
  response_key_id TEXT,
  response_expires_at_ms INTEGER CHECK (response_expires_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (bot_key) REFERENCES bot_state (bot_key) ON DELETE RESTRICT,
  CHECK (
    (first_virtual_update_id IS NULL AND last_virtual_update_id IS NULL)
    OR
    (
      first_virtual_update_id IS NOT NULL
      AND last_virtual_update_id IS NOT NULL
      AND first_virtual_update_id <= last_virtual_update_id
    )
  ),
  CHECK (
    (response_ciphertext IS NULL AND response_nonce IS NULL AND response_key_id IS NULL)
    OR
    (response_ciphertext IS NOT NULL AND response_nonce IS NOT NULL AND response_key_id IS NOT NULL)
  ),
  CHECK (
    state NOT IN ('offered', 'partially_acked')
    OR response_ciphertext IS NOT NULL
  ),
  CHECK (
    state NOT IN ('offered', 'partially_acked')
    OR first_virtual_update_id IS NOT NULL
  ),
  CHECK (
    acknowledged_through_virtual_id IS NULL
    OR (
      first_virtual_update_id IS NOT NULL
      AND acknowledged_through_virtual_id BETWEEN first_virtual_update_id AND last_virtual_update_id
    )
  ),
  CHECK (state <> 'empty' OR first_virtual_update_id IS NULL)
) STRICT;

CREATE UNIQUE INDEX poll_batches_one_active_offered
  ON poll_batches (bot_key)
  WHERE state IN ('offered', 'partially_acked');

CREATE TABLE poll_intents (
  intent_id INTEGER PRIMARY KEY,
  bot_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local', 'cloud')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  native_offset INTEGER NOT NULL
    CHECK (native_offset BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'completed', 'ambiguous', 'failed')),
  prepared_at_ms INTEGER NOT NULL CHECK (prepared_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms >= prepared_at_ms),
  failure_code TEXT,
  FOREIGN KEY (bot_key, source, generation)
    REFERENCES source_state (bot_key, source, generation)
    ON DELETE RESTRICT,
  CHECK (status = 'prepared' OR completed_at_ms IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX poll_intents_one_prepared_per_bot
  ON poll_intents (bot_key)
  WHERE status = 'prepared';

CREATE TABLE fingerprint_occurrences (
  occurrence_id INTEGER PRIMARY KEY,
  bot_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local', 'cloud')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  native_update_id INTEGER NOT NULL,
  logical_virtual_update_id INTEGER,
  event_kind TEXT NOT NULL,
  canonicalizer_version INTEGER NOT NULL CHECK (canonicalizer_version > 0),
  hmac_key_id TEXT NOT NULL,
  fingerprint_hmac BLOB NOT NULL,
  strength TEXT NOT NULL CHECK (strength IN ('strong', 'weak', 'ambiguous')),
  committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1)),
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0, 1)),
  matched_occurrence_id INTEGER,
  first_observed_at_ms INTEGER NOT NULL CHECK (first_observed_at_ms >= 0),
  last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= first_observed_at_ms),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= last_observed_at_ms),
  FOREIGN KEY (bot_key, source, generation, native_update_id)
    REFERENCES source_updates (bot_key, source, generation, native_update_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (bot_key, logical_virtual_update_id)
    REFERENCES logical_events (bot_key, virtual_update_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (matched_occurrence_id)
    REFERENCES fingerprint_occurrences (occurrence_id)
    ON DELETE RESTRICT,
  UNIQUE (
    bot_key,
    source,
    generation,
    native_update_id,
    canonicalizer_version,
    hmac_key_id
  ),
  CHECK (matched_occurrence_id IS NULL OR matched_occurrence_id <> occurrence_id),
  CHECK (
    suppressed = 0
    OR (strength = 'strong' AND matched_occurrence_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX fingerprint_occurrences_lookup
  ON fingerprint_occurrences (
    bot_key,
    canonicalizer_version,
    hmac_key_id,
    fingerprint_hmac,
    source,
    last_observed_at_ms
  );

CREATE UNIQUE INDEX fingerprint_occurrences_one_to_one_match
  ON fingerprint_occurrences (matched_occurrence_id)
  WHERE matched_occurrence_id IS NOT NULL;

CREATE INDEX fingerprint_occurrences_gc
  ON fingerprint_occurrences (expires_at_ms);

CREATE TABLE media_aliases (
  media_alias_id INTEGER PRIMARY KEY,
  bot_key TEXT NOT NULL,
  logical_virtual_update_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local', 'cloud')),
  source_generation INTEGER NOT NULL CHECK (source_generation > 0),
  media_role TEXT NOT NULL,
  file_unique_id TEXT NOT NULL,
  file_id_ciphertext BLOB NOT NULL,
  file_id_nonce BLOB NOT NULL,
  file_id_key_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= created_at_ms),
  FOREIGN KEY (bot_key, logical_virtual_update_id)
    REFERENCES logical_events (bot_key, virtual_update_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (bot_key, source, source_generation)
    REFERENCES source_state (bot_key, source, generation)
    ON DELETE RESTRICT,
  UNIQUE (
    bot_key,
    logical_virtual_update_id,
    source,
    source_generation,
    media_role,
    file_unique_id
  )
) STRICT;

CREATE INDEX media_aliases_gc ON media_aliases (expires_at_ms);

CREATE TABLE process_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_id TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
  heartbeat_at_ms INTEGER NOT NULL CHECK (heartbeat_at_ms >= acquired_at_ms),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > heartbeat_at_ms)
) STRICT;

CREATE TABLE state_events (
  state_event_id INTEGER PRIMARY KEY,
  bot_key TEXT,
  event_type TEXT NOT NULL,
  reason_code TEXT,
  source TEXT CHECK (source IS NULL OR source IN ('local', 'cloud')),
  virtual_update_id INTEGER
    CHECK (virtual_update_id BETWEEN 0 AND 9007199254740991),
  native_update_id INTEGER
    CHECK (native_update_id BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  FOREIGN KEY (bot_key) REFERENCES bot_state (bot_key) ON DELETE RESTRICT
) STRICT;

CREATE INDEX state_events_by_bot_time
  ON state_events (bot_key, created_at_ms);
