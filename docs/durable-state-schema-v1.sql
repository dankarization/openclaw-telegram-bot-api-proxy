-- Durable reconciliation state schema v1.
-- This is a reviewed design artifact for PR 0, not a production migration.
-- The migration runner must execute this file and its schema_meta INSERT in
-- one BEGIN IMMEDIATE transaction; see applyStorageMigration().

PRAGMA foreign_keys = ON;

CREATE TABLE schema_meta (
  schema_version INTEGER PRIMARY KEY,
  migration_name TEXT NOT NULL UNIQUE,
  schema_sha256 TEXT NOT NULL CHECK (length(schema_sha256) = 64),
  catalog_sha256 TEXT NOT NULL CHECK (length(catalog_sha256) = 64),
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
) STRICT;

CREATE TRIGGER schema_meta_history_immutable
BEFORE UPDATE ON schema_meta
BEGIN
  SELECT RAISE(ABORT, 'schema migration history is immutable');
END;

CREATE TRIGGER schema_meta_history_cannot_be_deleted
BEFORE DELETE ON schema_meta
BEGIN
  SELECT RAISE(ABORT, 'schema migration history cannot be deleted');
END;

CREATE TABLE bot_state (
  bot_key TEXT PRIMARY KEY,
  next_virtual_update_id INTEGER NOT NULL
    CHECK (next_virtual_update_id BETWEEN 0 AND 9007199254740991),
  allocator_anchor_high_water INTEGER NOT NULL DEFAULT -1
    CHECK (allocator_anchor_high_water BETWEEN -1 AND 9007199254740991),
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
  CHECK (next_virtual_update_id > allocator_anchor_high_water),
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
  incarnation_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (incarnation_status IN ('unverified', 'verified', 'retired')),
  incarnation_evidence_hmac BLOB,
  cursor_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (cursor_status IN ('unknown', 'verified', 'observed')),
  last_observed_native_id INTEGER
    CHECK (last_observed_native_id BETWEEN 0 AND 9007199254740991),
  safe_ack_native_id INTEGER
    CHECK (safe_ack_native_id BETWEEN 0 AND 9007199254740991),
  frontier_evidence_hmac BLOB,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  PRIMARY KEY (bot_key, source, generation),
  FOREIGN KEY (bot_key) REFERENCES bot_state (bot_key) ON DELETE RESTRICT,
  UNIQUE (bot_key, source, generation, incarnation_evidence_hmac),
  CHECK (incarnation_status <> 'verified' OR incarnation_evidence_hmac IS NOT NULL),
  CHECK (is_active = 0 OR incarnation_status <> 'retired'),
  CHECK (is_active = 1 OR incarnation_status = 'retired'),
  CHECK (
    cursor_status <> 'unknown'
    OR (safe_ack_native_id IS NULL AND frontier_evidence_hmac IS NULL)
  ),
  CHECK (
    cursor_status <> 'verified'
    OR (safe_ack_native_id IS NOT NULL AND frontier_evidence_hmac IS NOT NULL)
  ),
  CHECK (
    cursor_status <> 'observed'
    OR (last_observed_native_id IS NOT NULL AND frontier_evidence_hmac IS NULL)
  ),
  CHECK (
    safe_ack_native_id IS NULL
    OR (
      last_observed_native_id IS NOT NULL
      AND safe_ack_native_id <= last_observed_native_id
    )
  )
) STRICT;

CREATE TRIGGER bot_state_high_water_monotonic
BEFORE UPDATE OF
  next_virtual_update_id,
  allocator_anchor_high_water,
  acknowledged_virtual_prefix
ON bot_state
WHEN NEW.next_virtual_update_id < OLD.next_virtual_update_id
  OR NEW.allocator_anchor_high_water < OLD.allocator_anchor_high_water
  OR NEW.acknowledged_virtual_prefix < OLD.acknowledged_virtual_prefix
BEGIN
  SELECT RAISE(ABORT, 'bot high-water state cannot move backwards');
END;

CREATE TRIGGER bot_state_identity_immutable
BEFORE UPDATE OF bot_key ON bot_state
BEGIN
  SELECT RAISE(ABORT, 'bot state identity is immutable');
END;

CREATE TRIGGER bot_state_ledger_epoch_monotonic
BEFORE UPDATE OF ledger_epoch ON bot_state
WHEN NEW.ledger_epoch < OLD.ledger_epoch
BEGIN
  SELECT RAISE(ABORT, 'ledger epoch cannot move backwards');
END;

CREATE TRIGGER bot_state_cannot_be_deleted
BEFORE DELETE ON bot_state
BEGIN
  SELECT RAISE(ABORT, 'bot state requires an explicit database retirement');
END;

CREATE UNIQUE INDEX source_state_one_active_generation
  ON source_state (bot_key, source)
  WHERE is_active = 1;

CREATE UNIQUE INDEX source_state_incarnation_evidence_not_reused
  ON source_state (bot_key, source, incarnation_evidence_hmac)
  WHERE incarnation_evidence_hmac IS NOT NULL;

CREATE TRIGGER source_state_generation_monotonic
BEFORE INSERT ON source_state
WHEN EXISTS (
  SELECT 1
  FROM source_state AS existing
  WHERE existing.bot_key = NEW.bot_key
    AND existing.source = NEW.source
    AND existing.generation >= NEW.generation
)
BEGIN
  SELECT RAISE(ABORT, 'source generation must increase monotonically');
END;

CREATE TRIGGER bot_state_active_source_requires_generation_insert
BEFORE INSERT ON bot_state
WHEN NEW.active_source IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'bot must be created before selecting an active source');
END;

CREATE TRIGGER bot_state_active_source_requires_generation_update
BEFORE UPDATE OF active_source ON bot_state
WHEN NEW.active_source IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM source_state AS source
    WHERE source.bot_key = NEW.bot_key
      AND source.source = NEW.active_source
      AND source.is_active = 1
      AND source.incarnation_status <> 'retired'
  )
BEGIN
  SELECT RAISE(ABORT, 'active source requires an active source generation');
END;

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
    OR (
      disposition = 'quarantined'
      AND logical_virtual_update_id IS NULL
    )
  ),
  CHECK (
    (terminal = 0 AND terminal_at_ms IS NULL)
    OR (terminal = 1 AND terminal_at_ms IS NOT NULL)
  ),
  CHECK (disposition <> 'quarantined' OR terminal = 0)
) STRICT;

CREATE TRIGGER logical_events_no_direct_committed_insert
BEFORE INSERT ON logical_events
WHEN NEW.state = 'committed'
BEGIN
  SELECT RAISE(ABORT, 'logical event must be offered before it is committed');
END;

CREATE TRIGGER logical_events_state_is_one_way
BEFORE UPDATE OF state ON logical_events
WHEN NOT (
  NEW.state = OLD.state
  OR (OLD.state = 'ready' AND NEW.state IN ('offered', 'quarantined'))
  OR (OLD.state = 'offered' AND NEW.state = 'committed')
  OR (OLD.state = 'quarantined' AND NEW.state = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'logical event state transition is not allowed');
END;

CREATE TRIGGER logical_events_committed_state_is_final
BEFORE UPDATE OF
  state,
  event_kind,
  canonicalizer_version,
  fingerprint_strength,
  fingerprint_hmac,
  committed_at_ms
ON logical_events
WHEN OLD.state = 'committed'
BEGIN
  SELECT RAISE(ABORT, 'committed logical event is immutable');
END;

CREATE TRIGGER logical_events_identity_immutable
BEFORE UPDATE OF bot_key, virtual_update_id ON logical_events
BEGIN
  SELECT RAISE(ABORT, 'logical event identity is immutable');
END;

CREATE TRIGGER logical_events_cannot_be_deleted
BEFORE DELETE ON logical_events
BEGIN
  SELECT RAISE(ABORT, 'logical event identity is a permanent tombstone');
END;

CREATE INDEX source_updates_safe_frontier
  ON source_updates (bot_key, source, generation, terminal, native_update_id);

CREATE TRIGGER source_updates_identity_immutable
BEFORE UPDATE OF bot_key, source, generation, native_update_id
ON source_updates
BEGIN
  SELECT RAISE(ABORT, 'source update identity is immutable');
END;

CREATE TRIGGER source_updates_mapping_is_one_way
BEFORE UPDATE OF logical_virtual_update_id, disposition ON source_updates
WHEN (
  NEW.logical_virtual_update_id IS NOT OLD.logical_virtual_update_id
  OR NEW.disposition IS NOT OLD.disposition
)
AND NOT (
  OLD.disposition = 'quarantined'
  AND OLD.logical_virtual_update_id IS NULL
  AND NEW.disposition IN ('event', 'mirror')
  AND NEW.logical_virtual_update_id IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'source update mapping is immutable once assigned');
END;

CREATE TRIGGER source_updates_require_active_generation
BEFORE INSERT ON source_updates
WHEN NOT EXISTS (
  SELECT 1
  FROM source_state AS source
  WHERE source.bot_key = NEW.bot_key
    AND source.source = NEW.source
    AND source.generation = NEW.generation
    AND source.is_active = 1
    AND source.incarnation_status <> 'retired'
)
BEGIN
  SELECT RAISE(ABORT, 'source update requires an active source generation');
END;

CREATE TRIGGER source_updates_reject_late_observation
BEFORE INSERT ON source_updates
WHEN EXISTS (
  SELECT 1
  FROM source_state AS source
  WHERE source.bot_key = NEW.bot_key
    AND source.source = NEW.source
    AND source.generation = NEW.generation
    AND source.safe_ack_native_id IS NOT NULL
    AND NEW.native_update_id <= source.safe_ack_native_id
)
BEGIN
  SELECT RAISE(ABORT, 'source update is at or below the safe ACK frontier');
END;

CREATE TRIGGER source_updates_cannot_be_deleted
BEFORE DELETE ON source_updates
BEGIN
  SELECT RAISE(ABORT, 'source update mapping is a permanent tombstone');
END;

CREATE TRIGGER bot_state_no_source_switch_with_nonterminal_updates
BEFORE UPDATE OF active_source ON bot_state
WHEN NEW.active_source IS NOT OLD.active_source
  AND OLD.active_source IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM source_state AS source
    JOIN source_updates AS source_update
      ON source_update.bot_key = source.bot_key
     AND source_update.source = source.source
     AND source_update.generation = source.generation
    WHERE source.bot_key = OLD.bot_key
      AND source.source = OLD.active_source
      AND source.is_active = 1
      AND source_update.terminal = 0
  )
BEGIN
  SELECT RAISE(ABORT, 'active source has non-terminal source updates');
END;

CREATE TRIGGER source_state_observed_frontier_starts_empty
BEFORE INSERT ON source_state
WHEN NEW.cursor_status = 'observed'
  AND NEW.safe_ack_native_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'observed frontier must be derived after source updates exist');
END;

CREATE TRIGGER source_state_validate_observed_frontier
BEFORE UPDATE OF cursor_status, safe_ack_native_id ON source_state
WHEN NEW.cursor_status = 'observed'
  AND NEW.safe_ack_native_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM source_updates AS frontier
      WHERE frontier.bot_key = NEW.bot_key
        AND frontier.source = NEW.source
        AND frontier.generation = NEW.generation
        AND frontier.native_update_id = NEW.safe_ack_native_id
        AND frontier.terminal = 1
        AND frontier.disposition <> 'quarantined'
    )
    OR EXISTS (
      SELECT 1
      FROM source_updates AS blocked
      WHERE blocked.bot_key = NEW.bot_key
        AND blocked.source = NEW.source
        AND blocked.generation = NEW.generation
        AND blocked.native_update_id <= NEW.safe_ack_native_id
        AND (
          blocked.terminal = 0
          OR blocked.disposition = 'quarantined'
        )
    )
    THEN RAISE(ABORT, 'safe ACK frontier is not a terminal prefix')
  END;
END;

CREATE TRIGGER source_state_safe_frontier_monotonic
BEFORE UPDATE OF safe_ack_native_id ON source_state
WHEN OLD.safe_ack_native_id IS NOT NULL
  AND (
    NEW.safe_ack_native_id IS NULL
    OR NEW.safe_ack_native_id < OLD.safe_ack_native_id
  )
BEGIN
  SELECT RAISE(ABORT, 'safe ACK frontier cannot move backwards');
END;

CREATE TRIGGER source_updates_terminal_state_is_final
BEFORE UPDATE OF
  bot_key,
  source,
  generation,
  native_update_id,
  logical_virtual_update_id,
  disposition,
  terminal,
  terminal_at_ms
ON source_updates
WHEN OLD.terminal = 1
BEGIN
  SELECT RAISE(ABORT, 'terminal source update is immutable');
END;

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
    CHECK (state IN ('offered', 'partially_acked', 'committed', 'empty')),
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
  CHECK (state <> 'empty' OR first_virtual_update_id IS NULL),
  CHECK (state <> 'offered' OR acknowledged_through_virtual_id IS NULL),
  CHECK (
    state <> 'partially_acked'
    OR (
      acknowledged_through_virtual_id IS NOT NULL
      AND acknowledged_through_virtual_id < last_virtual_update_id
    )
  ),
  CHECK (
    state <> 'committed'
    OR (
      first_virtual_update_id IS NOT NULL
      AND last_virtual_update_id IS NOT NULL
      AND acknowledged_through_virtual_id IS NOT NULL
      AND acknowledged_through_virtual_id = last_virtual_update_id
    )
  )
) STRICT;

CREATE UNIQUE INDEX poll_batches_one_active_offered
  ON poll_batches (bot_key)
  WHERE state IN ('offered', 'partially_acked');

CREATE TRIGGER poll_batches_must_start_unacknowledged
BEFORE INSERT ON poll_batches
WHEN NEW.state NOT IN ('offered', 'empty')
BEGIN
  SELECT RAISE(ABORT, 'poll batch must start as offered or empty');
END;

CREATE TRIGGER poll_batches_active_requires_source_insert
BEFORE INSERT ON poll_batches
WHEN NEW.state IN ('offered', 'partially_acked')
  AND NOT EXISTS (
    SELECT 1
    FROM bot_state AS bot
    WHERE bot.bot_key = NEW.bot_key
      AND bot.active_source IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'active poll batch requires one selected source');
END;

CREATE TRIGGER poll_batches_identity_immutable
BEFORE UPDATE OF
  batch_id,
  bot_key,
  request_virtual_offset,
  request_signature_hmac,
  first_virtual_update_id,
  last_virtual_update_id,
  created_at_ms
ON poll_batches
BEGIN
  SELECT RAISE(ABORT, 'poll batch request and virtual range are immutable');
END;

CREATE TRIGGER poll_batches_active_response_immutable
BEFORE UPDATE OF
  response_ciphertext,
  response_nonce,
  response_key_id,
  response_expires_at_ms
ON poll_batches
WHEN OLD.state IN ('offered', 'partially_acked')
  AND (
    NEW.response_ciphertext IS NOT OLD.response_ciphertext
    OR NEW.response_nonce IS NOT OLD.response_nonce
    OR NEW.response_key_id IS NOT OLD.response_key_id
    OR NEW.response_expires_at_ms IS NOT OLD.response_expires_at_ms
  )
BEGIN
  SELECT RAISE(ABORT, 'active poll batch response is immutable');
END;

CREATE TRIGGER poll_batches_ack_progress_monotonic
BEFORE UPDATE OF acknowledged_through_virtual_id ON poll_batches
WHEN OLD.acknowledged_through_virtual_id IS NOT NULL
  AND (
    NEW.acknowledged_through_virtual_id IS NULL
    OR NEW.acknowledged_through_virtual_id < OLD.acknowledged_through_virtual_id
  )
BEGIN
  SELECT RAISE(ABORT, 'poll batch ACK progress cannot move backwards');
END;

CREATE TRIGGER poll_batches_state_is_one_way
BEFORE UPDATE OF state ON poll_batches
WHEN NOT (
  NEW.state = OLD.state
  OR (
    OLD.state = 'offered'
    AND NEW.state IN ('partially_acked', 'committed')
  )
  OR (
    OLD.state = 'partially_acked'
    AND NEW.state = 'committed'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'poll batch state transition is not allowed');
END;

CREATE TRIGGER poll_batches_no_active_delete
BEFORE DELETE ON poll_batches
WHEN OLD.state IN ('offered', 'partially_acked')
BEGIN
  SELECT RAISE(ABORT, 'active poll batch cannot be deleted');
END;

CREATE TRIGGER bot_state_no_source_switch_with_active_batch
BEFORE UPDATE OF active_source ON bot_state
WHEN NEW.active_source IS NOT OLD.active_source
  AND EXISTS (
    SELECT 1
    FROM poll_batches AS batch
    WHERE batch.bot_key = OLD.bot_key
      AND batch.state IN ('offered', 'partially_acked')
  )
BEGIN
  SELECT RAISE(ABORT, 'active source cannot change while a poll batch is unacknowledged');
END;

CREATE TABLE poll_intents (
  intent_id INTEGER PRIMARY KEY,
  bot_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local', 'cloud')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  incarnation_evidence_hmac BLOB,
  native_offset INTEGER NOT NULL
    CHECK (native_offset BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'completed', 'ambiguous', 'failed')),
  prepared_at_ms INTEGER NOT NULL CHECK (prepared_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms >= prepared_at_ms),
  failure_code TEXT,
  FOREIGN KEY (bot_key, source, generation)
    REFERENCES source_state (bot_key, source, generation)
    ON DELETE RESTRICT,
  FOREIGN KEY (bot_key, source, generation, incarnation_evidence_hmac)
    REFERENCES source_state (
      bot_key,
      source,
      generation,
      incarnation_evidence_hmac
    )
    ON DELETE RESTRICT,
  CHECK (native_offset = 0 OR incarnation_evidence_hmac IS NOT NULL),
  CHECK (
    (status = 'prepared' AND completed_at_ms IS NULL)
    OR (status <> 'prepared' AND completed_at_ms IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX poll_intents_one_unresolved_per_bot
  ON poll_intents (bot_key)
  WHERE status IN ('prepared', 'ambiguous');

CREATE TRIGGER poll_intents_validate_prepared_insert
BEFORE INSERT ON poll_intents
WHEN NEW.status IN ('prepared', 'ambiguous')
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM source_state AS source
      WHERE source.bot_key = NEW.bot_key
        AND source.source = NEW.source
        AND source.generation = NEW.generation
        AND source.is_active = 1
        AND (
          NEW.native_offset = 0
          OR (
            source.incarnation_status = 'verified'
            AND source.incarnation_evidence_hmac = NEW.incarnation_evidence_hmac
            AND source.safe_ack_native_id IS NOT NULL
            AND NEW.native_offset = source.safe_ack_native_id + 1
            AND NEW.native_offset <= source.last_observed_native_id + 1
          )
        )
    )
    THEN RAISE(ABORT, 'unsafe prepared poll intent')
  END;
END;

CREATE TRIGGER poll_intents_require_active_generation
BEFORE INSERT ON poll_intents
WHEN NOT EXISTS (
  SELECT 1
  FROM source_state AS source
  WHERE source.bot_key = NEW.bot_key
    AND source.source = NEW.source
    AND source.generation = NEW.generation
    AND source.is_active = 1
    AND source.incarnation_status <> 'retired'
)
BEGIN
  SELECT RAISE(ABORT, 'poll intent requires an active source generation');
END;

CREATE TRIGGER poll_intents_identity_immutable
BEFORE UPDATE OF bot_key, source, generation, incarnation_evidence_hmac, native_offset
ON poll_intents
BEGIN
  SELECT RAISE(ABORT, 'poll intent request identity is immutable');
END;

CREATE TRIGGER poll_intents_status_is_one_way
BEFORE UPDATE OF status ON poll_intents
WHEN NOT (
  (OLD.status = 'prepared' AND NEW.status IN ('completed', 'ambiguous', 'failed'))
  OR (OLD.status = 'ambiguous' AND NEW.status IN ('completed', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'poll intent status transition is not allowed');
END;

CREATE TRIGGER poll_intents_no_unresolved_delete
BEFORE DELETE ON poll_intents
WHEN OLD.status IN ('prepared', 'ambiguous')
BEGIN
  SELECT RAISE(ABORT, 'unresolved poll intent cannot be deleted');
END;

CREATE TRIGGER bot_state_no_source_switch_with_unresolved_intent
BEFORE UPDATE OF active_source ON bot_state
WHEN NEW.active_source IS NOT OLD.active_source
  AND EXISTS (
    SELECT 1
    FROM poll_intents AS intent
    WHERE intent.bot_key = OLD.bot_key
      AND intent.status IN ('prepared', 'ambiguous')
  )
BEGIN
  SELECT RAISE(ABORT, 'active source cannot change with an unresolved poll intent');
END;

CREATE TRIGGER source_state_identity_immutable
BEFORE UPDATE OF bot_key, source, generation ON source_state
BEGIN
  SELECT RAISE(ABORT, 'source generation identity is immutable');
END;

CREATE TRIGGER source_state_incarnation_evidence_immutable
BEFORE UPDATE OF incarnation_evidence_hmac ON source_state
WHEN OLD.incarnation_evidence_hmac IS NOT NEW.incarnation_evidence_hmac
  AND NOT (
    OLD.incarnation_status = 'unverified'
    AND OLD.incarnation_evidence_hmac IS NULL
    AND NEW.incarnation_evidence_hmac IS NOT NULL
    AND NEW.incarnation_status IN ('unverified', 'verified')
  )
BEGIN
  SELECT RAISE(ABORT, 'source incarnation evidence is one-way and immutable once set');
END;

CREATE TRIGGER source_state_incarnation_lifecycle
BEFORE UPDATE OF incarnation_status ON source_state
WHEN NOT (
  NEW.incarnation_status = OLD.incarnation_status
  OR (
    OLD.incarnation_status = 'unverified'
    AND NEW.incarnation_status IN ('verified', 'retired')
  )
  OR (
    OLD.incarnation_status = 'verified'
    AND NEW.incarnation_status = 'retired'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'source incarnation status cannot move backwards');
END;

CREATE TRIGGER source_state_inactive_is_final
BEFORE UPDATE ON source_state
WHEN OLD.is_active = 0
BEGIN
  SELECT RAISE(ABORT, 'inactive source generation is final');
END;

CREATE TRIGGER source_state_last_observed_monotonic
BEFORE UPDATE OF last_observed_native_id ON source_state
WHEN OLD.last_observed_native_id IS NOT NULL
  AND (
    NEW.last_observed_native_id IS NULL
    OR NEW.last_observed_native_id < OLD.last_observed_native_id
  )
BEGIN
  SELECT RAISE(ABORT, 'last observed native ID cannot move backwards');
END;

CREATE TRIGGER source_state_verified_frontier_evidence_rotates
BEFORE UPDATE OF cursor_status, safe_ack_native_id, frontier_evidence_hmac
ON source_state
WHEN OLD.cursor_status = 'verified'
  AND NEW.cursor_status = 'verified'
  AND (
    (
      NEW.safe_ack_native_id IS OLD.safe_ack_native_id
      AND NEW.frontier_evidence_hmac IS NOT OLD.frontier_evidence_hmac
    )
    OR (
      NEW.safe_ack_native_id IS NOT OLD.safe_ack_native_id
      AND NEW.frontier_evidence_hmac IS OLD.frontier_evidence_hmac
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'verified frontier and its evidence must rotate together');
END;

CREATE TRIGGER source_state_no_retire_with_unresolved_intent
BEFORE UPDATE OF is_active, incarnation_status ON source_state
WHEN (
  NEW.is_active = 0
  OR NEW.incarnation_status = 'retired'
)
AND EXISTS (
  SELECT 1
  FROM poll_intents AS intent
  WHERE intent.bot_key = OLD.bot_key
    AND intent.source = OLD.source
    AND intent.generation = OLD.generation
    AND intent.status IN ('prepared', 'ambiguous')
)
BEGIN
  SELECT RAISE(ABORT, 'resolve poll intent before retiring source incarnation');
END;

CREATE TRIGGER source_state_no_retire_with_nonterminal_updates
BEFORE UPDATE OF is_active, incarnation_status ON source_state
WHEN (
  NEW.is_active = 0
  OR NEW.incarnation_status = 'retired'
)
AND EXISTS (
  SELECT 1
  FROM source_updates AS source_update
  WHERE source_update.bot_key = OLD.bot_key
    AND source_update.source = OLD.source
    AND source_update.generation = OLD.generation
    AND source_update.terminal = 0
)
BEGIN
  SELECT RAISE(ABORT, 'resolve source updates before retiring source incarnation');
END;

CREATE TRIGGER source_state_no_retire_with_active_batch
BEFORE UPDATE OF is_active, incarnation_status ON source_state
WHEN (
  NEW.is_active = 0
  OR NEW.incarnation_status = 'retired'
)
AND EXISTS (
  SELECT 1
  FROM bot_state AS bot
  JOIN poll_batches AS batch
    ON batch.bot_key = bot.bot_key
  WHERE bot.bot_key = OLD.bot_key
    AND bot.active_source = OLD.source
    AND batch.state IN ('offered', 'partially_acked')
)
BEGIN
  SELECT RAISE(ABORT, 'commit active poll batch before retiring source incarnation');
END;

CREATE TRIGGER source_state_no_retire_while_selected
BEFORE UPDATE OF is_active, incarnation_status ON source_state
WHEN (
  NEW.is_active = 0
  OR NEW.incarnation_status = 'retired'
)
AND EXISTS (
  SELECT 1
  FROM bot_state AS bot
  WHERE bot.bot_key = OLD.bot_key
    AND bot.active_source = OLD.source
)
BEGIN
  SELECT RAISE(ABORT, 'clear active source selection before retiring its generation');
END;

CREATE TRIGGER source_state_cannot_be_deleted
BEFORE DELETE ON source_state
BEGIN
  SELECT RAISE(ABORT, 'source generation requires an explicit database retirement');
END;

CREATE TABLE fingerprint_occurrences (
  occurrence_id INTEGER PRIMARY KEY,
  bot_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local', 'cloud')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  native_update_id INTEGER NOT NULL
    CHECK (native_update_id BETWEEN 0 AND 9007199254740991),
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
    (suppressed = 0 AND matched_occurrence_id IS NULL)
    OR (
      suppressed = 1
      AND committed = 0
      AND strength = 'strong'
      AND matched_occurrence_id IS NOT NULL
    )
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

CREATE TRIGGER fingerprint_occurrences_validate_match_insert
BEFORE INSERT ON fingerprint_occurrences
WHEN NEW.suppressed = 1
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM fingerprint_occurrences AS target
      JOIN logical_events AS target_event
        ON target_event.bot_key = target.bot_key
       AND target_event.virtual_update_id = target.logical_virtual_update_id
      JOIN source_updates AS mirror
        ON mirror.bot_key = NEW.bot_key
       AND mirror.source = NEW.source
       AND mirror.generation = NEW.generation
       AND mirror.native_update_id = NEW.native_update_id
      WHERE target.occurrence_id = NEW.matched_occurrence_id
        AND target.bot_key = NEW.bot_key
        AND target.source <> NEW.source
        AND target.event_kind = NEW.event_kind
        AND target.canonicalizer_version = NEW.canonicalizer_version
        AND target.hmac_key_id = NEW.hmac_key_id
        AND target.fingerprint_hmac = NEW.fingerprint_hmac
        AND target.strength = 'strong'
        AND target.committed = 1
        AND target.suppressed = 0
        AND target.matched_occurrence_id IS NULL
        AND target_event.state = 'committed'
        AND target_event.event_kind = target.event_kind
        AND target_event.canonicalizer_version = target.canonicalizer_version
        AND target_event.fingerprint_strength = target.strength
        AND target_event.fingerprint_hmac = target.fingerprint_hmac
        AND target.expires_at_ms >= NEW.first_observed_at_ms
        AND NEW.logical_virtual_update_id = target.logical_virtual_update_id
        AND mirror.disposition = 'mirror'
        AND mirror.terminal = 0
    )
    THEN RAISE(ABORT, 'invalid strong mirror match')
  END;
END;

CREATE TRIGGER fingerprint_occurrences_require_active_generation
BEFORE INSERT ON fingerprint_occurrences
WHEN NOT EXISTS (
  SELECT 1
  FROM source_state AS source
  WHERE source.bot_key = NEW.bot_key
    AND source.source = NEW.source
    AND source.generation = NEW.generation
    AND source.is_active = 1
    AND source.incarnation_status <> 'retired'
)
BEGIN
  SELECT RAISE(ABORT, 'fingerprint occurrence requires an active source generation');
END;

CREATE TRIGGER fingerprint_occurrences_status_requires_active_generation
BEFORE UPDATE OF
  logical_virtual_update_id,
  committed,
  suppressed,
  matched_occurrence_id
ON fingerprint_occurrences
WHEN NOT EXISTS (
  SELECT 1
  FROM source_state AS source
  WHERE source.bot_key = OLD.bot_key
    AND source.source = OLD.source
    AND source.generation = OLD.generation
    AND source.is_active = 1
    AND source.incarnation_status <> 'retired'
)
BEGIN
  SELECT RAISE(ABORT, 'fingerprint status requires an active source generation');
END;

CREATE TRIGGER fingerprint_occurrences_validate_match_update
BEFORE UPDATE OF suppressed, matched_occurrence_id, logical_virtual_update_id
ON fingerprint_occurrences
WHEN NEW.suppressed = 1
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM fingerprint_occurrences AS target
      JOIN logical_events AS target_event
        ON target_event.bot_key = target.bot_key
       AND target_event.virtual_update_id = target.logical_virtual_update_id
      JOIN source_updates AS mirror
        ON mirror.bot_key = NEW.bot_key
       AND mirror.source = NEW.source
       AND mirror.generation = NEW.generation
       AND mirror.native_update_id = NEW.native_update_id
      WHERE target.occurrence_id = NEW.matched_occurrence_id
        AND target.bot_key = NEW.bot_key
        AND target.source <> NEW.source
        AND target.event_kind = NEW.event_kind
        AND target.canonicalizer_version = NEW.canonicalizer_version
        AND target.hmac_key_id = NEW.hmac_key_id
        AND target.fingerprint_hmac = NEW.fingerprint_hmac
        AND target.strength = 'strong'
        AND target.committed = 1
        AND target.suppressed = 0
        AND target.matched_occurrence_id IS NULL
        AND target_event.state = 'committed'
        AND target_event.event_kind = target.event_kind
        AND target_event.canonicalizer_version = target.canonicalizer_version
        AND target_event.fingerprint_strength = target.strength
        AND target_event.fingerprint_hmac = target.fingerprint_hmac
        AND target.expires_at_ms >= NEW.first_observed_at_ms
        AND NEW.logical_virtual_update_id = target.logical_virtual_update_id
        AND mirror.disposition = 'mirror'
        AND mirror.terminal = 0
    )
    THEN RAISE(ABORT, 'invalid strong mirror match')
  END;
END;

CREATE TRIGGER fingerprint_occurrences_identity_immutable
BEFORE UPDATE OF
  bot_key,
  source,
  generation,
  native_update_id,
  event_kind,
  canonicalizer_version,
  hmac_key_id,
  fingerprint_hmac,
  strength
ON fingerprint_occurrences
BEGIN
  SELECT RAISE(ABORT, 'fingerprint occurrence identity is immutable');
END;

CREATE TRIGGER fingerprint_occurrences_logical_link_immutable
BEFORE UPDATE OF logical_virtual_update_id ON fingerprint_occurrences
WHEN OLD.logical_virtual_update_id IS NOT NEW.logical_virtual_update_id
  AND (
    OLD.logical_virtual_update_id IS NOT NULL
    OR OLD.committed = 1
    OR OLD.suppressed = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'fingerprint logical event link is immutable once assigned');
END;

CREATE TRIGGER fingerprint_occurrences_status_monotonic
BEFORE UPDATE OF committed, suppressed, matched_occurrence_id
ON fingerprint_occurrences
WHEN NEW.committed < OLD.committed
  OR NEW.suppressed < OLD.suppressed
  OR (
    OLD.matched_occurrence_id IS NOT NULL
    AND NEW.matched_occurrence_id IS NOT OLD.matched_occurrence_id
  )
BEGIN
  SELECT RAISE(ABORT, 'fingerprint occurrence status cannot move backwards');
END;

CREATE TRIGGER fingerprint_occurrences_referenced_target_stays_valid
BEFORE UPDATE OF suppressed ON fingerprint_occurrences
WHEN NEW.suppressed = 1
AND EXISTS (
  SELECT 1
  FROM fingerprint_occurrences AS mirror
  WHERE mirror.matched_occurrence_id = OLD.occurrence_id
)
BEGIN
  SELECT RAISE(ABORT, 'a committed match target cannot become suppressed');
END;

CREATE TRIGGER fingerprint_occurrences_validate_source_link_insert
BEFORE INSERT ON fingerprint_occurrences
WHEN NEW.logical_virtual_update_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM source_updates AS source_update
      WHERE source_update.bot_key = NEW.bot_key
        AND source_update.source = NEW.source
        AND source_update.generation = NEW.generation
        AND source_update.native_update_id = NEW.native_update_id
        AND source_update.logical_virtual_update_id = NEW.logical_virtual_update_id
    )
    THEN RAISE(ABORT, 'fingerprint logical link disagrees with source update')
  END;
END;

CREATE TRIGGER fingerprint_occurrences_validate_source_link_update
BEFORE UPDATE OF logical_virtual_update_id ON fingerprint_occurrences
WHEN NEW.logical_virtual_update_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM source_updates AS source_update
      WHERE source_update.bot_key = NEW.bot_key
        AND source_update.source = NEW.source
        AND source_update.generation = NEW.generation
        AND source_update.native_update_id = NEW.native_update_id
        AND source_update.logical_virtual_update_id = NEW.logical_virtual_update_id
    )
    THEN RAISE(ABORT, 'fingerprint logical link disagrees with source update')
  END;
END;

CREATE TRIGGER fingerprint_occurrences_validate_committed_insert
BEFORE INSERT ON fingerprint_occurrences
WHEN NEW.committed = 1
BEGIN
  SELECT CASE
    WHEN NEW.logical_virtual_update_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM source_updates AS source_update
        JOIN logical_events AS event
          ON event.bot_key = source_update.bot_key
         AND event.virtual_update_id = source_update.logical_virtual_update_id
        WHERE source_update.bot_key = NEW.bot_key
          AND source_update.source = NEW.source
          AND source_update.generation = NEW.generation
          AND source_update.native_update_id = NEW.native_update_id
          AND source_update.disposition = 'event'
          AND source_update.logical_virtual_update_id = NEW.logical_virtual_update_id
          AND event.state = 'committed'
          AND event.event_kind = NEW.event_kind
          AND event.canonicalizer_version = NEW.canonicalizer_version
          AND event.fingerprint_strength = NEW.strength
          AND event.fingerprint_hmac = NEW.fingerprint_hmac
      )
    THEN RAISE(ABORT, 'committed fingerprint is not backed by a committed event')
  END;
END;

CREATE TRIGGER fingerprint_occurrences_validate_committed_update
BEFORE UPDATE OF committed, logical_virtual_update_id ON fingerprint_occurrences
WHEN NEW.committed = 1
BEGIN
  SELECT CASE
    WHEN NEW.logical_virtual_update_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM source_updates AS source_update
        JOIN logical_events AS event
          ON event.bot_key = source_update.bot_key
         AND event.virtual_update_id = source_update.logical_virtual_update_id
        WHERE source_update.bot_key = NEW.bot_key
          AND source_update.source = NEW.source
          AND source_update.generation = NEW.generation
          AND source_update.native_update_id = NEW.native_update_id
          AND source_update.disposition = 'event'
          AND source_update.logical_virtual_update_id = NEW.logical_virtual_update_id
          AND event.state = 'committed'
          AND event.event_kind = NEW.event_kind
          AND event.canonicalizer_version = NEW.canonicalizer_version
          AND event.fingerprint_strength = NEW.strength
          AND event.fingerprint_hmac = NEW.fingerprint_hmac
      )
    THEN RAISE(ABORT, 'committed fingerprint is not backed by a committed event')
  END;
END;

CREATE TRIGGER fingerprint_occurrences_cannot_be_deleted
BEFORE DELETE ON fingerprint_occurrences
BEGIN
  SELECT RAISE(ABORT, 'fingerprint occurrence identity is a permanent tombstone');
END;

CREATE TRIGGER source_updates_mapping_immutable_after_fingerprint
BEFORE UPDATE OF logical_virtual_update_id, disposition ON source_updates
WHEN EXISTS (
  SELECT 1
  FROM fingerprint_occurrences AS occurrence
  WHERE occurrence.bot_key = OLD.bot_key
    AND occurrence.source = OLD.source
    AND occurrence.generation = OLD.generation
    AND occurrence.native_update_id = OLD.native_update_id
)
AND NOT (
  OLD.disposition = 'quarantined'
  AND OLD.logical_virtual_update_id IS NULL
  AND NEW.disposition = 'event'
  AND NEW.logical_virtual_update_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM fingerprint_occurrences AS decided
    WHERE decided.bot_key = OLD.bot_key
      AND decided.source = OLD.source
      AND decided.generation = OLD.generation
      AND decided.native_update_id = OLD.native_update_id
      AND (
        decided.logical_virtual_update_id IS NOT NULL
        OR decided.committed = 1
        OR decided.suppressed = 1
        OR decided.matched_occurrence_id IS NOT NULL
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'fingerprinted source update mapping is immutable');
END;

CREATE TRIGGER source_updates_validate_terminal_insert
BEFORE INSERT ON source_updates
WHEN NEW.terminal = 1
BEGIN
  SELECT CASE
    WHEN NEW.disposition = 'mirror'
      THEN RAISE(ABORT, 'terminal mirror must be staged before fingerprint matching')
    WHEN NEW.disposition = 'event'
      AND NOT EXISTS (
        SELECT 1
        FROM logical_events AS event
        WHERE event.bot_key = NEW.bot_key
          AND event.virtual_update_id = NEW.logical_virtual_update_id
          AND event.state = 'committed'
      )
      THEN RAISE(ABORT, 'terminal event is not backed by a committed logical event')
  END;
END;

CREATE TRIGGER source_updates_validate_terminal_update
BEFORE UPDATE OF terminal ON source_updates
WHEN OLD.terminal = 0
  AND NEW.terminal = 1
BEGIN
  SELECT CASE
    WHEN NEW.disposition = 'event'
      AND NOT EXISTS (
        SELECT 1
        FROM logical_events AS event
        WHERE event.bot_key = NEW.bot_key
          AND event.virtual_update_id = NEW.logical_virtual_update_id
          AND event.state = 'committed'
      )
      THEN RAISE(ABORT, 'terminal event is not backed by a committed logical event')
    WHEN NEW.disposition = 'mirror'
      AND NOT EXISTS (
        SELECT 1
        FROM fingerprint_occurrences AS occurrence
        WHERE occurrence.bot_key = NEW.bot_key
          AND occurrence.source = NEW.source
          AND occurrence.generation = NEW.generation
          AND occurrence.native_update_id = NEW.native_update_id
          AND occurrence.logical_virtual_update_id = NEW.logical_virtual_update_id
          AND occurrence.strength = 'strong'
          AND occurrence.suppressed = 1
          AND occurrence.matched_occurrence_id IS NOT NULL
      )
      THEN RAISE(ABORT, 'mirror is not backed by a committed strong match')
  END;
END;

CREATE INDEX fingerprint_occurrences_expiry
  ON fingerprint_occurrences (expires_at_ms);

CREATE TABLE media_aliases (
  media_alias_id INTEGER PRIMARY KEY,
  bot_key TEXT NOT NULL,
  logical_virtual_update_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local', 'cloud')),
  source_generation INTEGER NOT NULL CHECK (source_generation > 0),
  media_role TEXT NOT NULL,
  file_unique_id TEXT NOT NULL,
  file_id_ciphertext BLOB,
  file_id_nonce BLOB,
  file_id_key_id TEXT,
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
  ),
  CHECK (
    (
      file_id_ciphertext IS NOT NULL
      AND file_id_nonce IS NOT NULL
      AND file_id_key_id IS NOT NULL
    )
    OR (
      file_id_ciphertext IS NULL
      AND file_id_nonce IS NULL
      AND file_id_key_id IS NULL
    )
  )
) STRICT;

CREATE TRIGGER media_aliases_require_active_generation
BEFORE INSERT ON media_aliases
WHEN NOT EXISTS (
  SELECT 1
  FROM source_state AS source
  WHERE source.bot_key = NEW.bot_key
    AND source.source = NEW.source
    AND source.generation = NEW.source_generation
    AND source.is_active = 1
    AND source.incarnation_status <> 'retired'
)
BEGIN
  SELECT RAISE(ABORT, 'media alias requires an active source generation');
END;

CREATE TRIGGER media_aliases_insert_requires_ciphertext
BEFORE INSERT ON media_aliases
WHEN NEW.file_id_ciphertext IS NULL
BEGIN
  SELECT RAISE(ABORT, 'new media alias requires encrypted file ID content');
END;

CREATE TRIGGER media_aliases_identity_immutable
BEFORE UPDATE OF
  media_alias_id,
  bot_key,
  logical_virtual_update_id,
  source,
  source_generation,
  media_role,
  file_unique_id,
  created_at_ms
ON media_aliases
BEGIN
  SELECT RAISE(ABORT, 'media alias identity is immutable');
END;

CREATE TRIGGER media_aliases_content_requires_active_generation
BEFORE UPDATE OF
  file_id_ciphertext,
  file_id_nonce,
  file_id_key_id
ON media_aliases
WHEN NOT EXISTS (
  SELECT 1
  FROM source_state AS source
  WHERE source.bot_key = OLD.bot_key
    AND source.source = OLD.source
    AND source.generation = OLD.source_generation
    AND source.is_active = 1
    AND source.incarnation_status <> 'retired'
)
AND (
  NEW.file_id_ciphertext IS NOT NULL
  OR NEW.file_id_nonce IS NOT NULL
  OR NEW.file_id_key_id IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'media alias content requires an active source generation');
END;

CREATE TRIGGER media_aliases_cannot_be_deleted
BEFORE DELETE ON media_aliases
BEGIN
  SELECT RAISE(ABORT, 'media alias identity is a permanent tombstone');
END;

CREATE INDEX media_aliases_gc ON media_aliases (expires_at_ms);

CREATE TABLE process_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_id TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
  heartbeat_at_ms INTEGER NOT NULL CHECK (heartbeat_at_ms >= acquired_at_ms),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > heartbeat_at_ms)
) STRICT;

CREATE TRIGGER process_lease_identity_immutable
BEFORE UPDATE OF singleton ON process_lease
BEGIN
  SELECT RAISE(ABORT, 'process lease singleton identity is immutable');
END;

CREATE TRIGGER process_lease_owner_handoff_after_expiry
BEFORE UPDATE OF owner_id, acquired_at_ms ON process_lease
WHEN NEW.owner_id IS NOT OLD.owner_id
  AND NEW.acquired_at_ms < OLD.expires_at_ms
BEGIN
  SELECT RAISE(ABORT, 'process lease owner cannot change before expiry');
END;

CREATE TRIGGER process_lease_same_owner_acquisition_immutable
BEFORE UPDATE OF acquired_at_ms ON process_lease
WHEN NEW.owner_id = OLD.owner_id
  AND NEW.acquired_at_ms IS NOT OLD.acquired_at_ms
BEGIN
  SELECT RAISE(ABORT, 'process lease acquisition time is immutable for one owner');
END;

CREATE TRIGGER process_lease_heartbeat_monotonic
BEFORE UPDATE OF heartbeat_at_ms, expires_at_ms ON process_lease
WHEN NEW.owner_id = OLD.owner_id
  AND (
    NEW.heartbeat_at_ms < OLD.heartbeat_at_ms
    OR NEW.expires_at_ms < OLD.expires_at_ms
  )
BEGIN
  SELECT RAISE(ABORT, 'process lease heartbeat cannot move backwards');
END;

CREATE TRIGGER process_lease_cannot_be_deleted
BEFORE DELETE ON process_lease
BEGIN
  SELECT RAISE(ABORT, 'process lease is a permanent singleton');
END;

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
