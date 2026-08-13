# Changelog

## Unreleased

- Add the production-neutral durable-reconciliation foundation: a Telegram
  queue simulator, executable SQLite schema, driver-neutral storage/restore
  spike, crash/backup probes, and frozen ACK/replay invariants.
- Declare Node `>=22.16.0 <23`, matching the releases that expose the selected
  built-in `node:sqlite.backup` API throughout the supported range.
- Serialize the complete `getUpdates` cycle in a FIFO lane per bot ID while
  preserving cross-bot concurrency. Queued client cancellations are removed;
  an already-started ambiguous upstream cycle keeps its lane until completion.
- Bound each bot's retained polling queue and return HTTP 429 at the configured
  limit before body buffering instead of retaining unbounded concurrent request
  bodies.
- Canonicalize Telegram's case-insensitive method names before routing, so
  variants such as `GETUPDATES`, `GETFILE`, and `SETWEBHOOK` cannot bypass
  cursor guards, coordination, or local-only policy.
- Buffer bounded `getUpdates` request bodies before lane acquisition, preventing
  incomplete unauthenticated bodies from starving a bot lane; keep the legacy
  health decision at response headers without buffering a `getMe` body.
- Extract request parsing, fallback policy, file routing, legacy update
  bridging, and upstream transport into independently tested modules with an
  injectable clock and fault points.
- Record bot-scoped `file_id` source and optional size from successful
  `getUpdates`, including nested standard media fields and media groups.
- Record media provenance only from the post-guard response, so filtered local
  mirrors cannot overwrite previously delivered cloud provenance; prune the
  metadata TTL cache once per batch.
- Make `getFile` local-first independently of the short health probe, add
  bounded retry for explicit transient network failures, and fail fast instead
  of starting a long cloud request when update source/size policy blocks it.
- Add frozen sequential routing traces and concurrency regressions covering
  same-bot overlap, cross-bot parallelism, cancellation, shutdown, and
  multipart local-only behavior.
- Permit restore of non-destructive offset-zero poll intents without source
  incarnation evidence, consistent with the durable schema.
- Fsync the completed SQLite backup and its parent directory before reporting a
  published backup, and preserve local `getFile` 401/404 responses when policy
  blocks cloud fallback.
- Fallback `getFile` to cloud when local Bot API returns `400`, covering cloud
  fallback updates whose `file_id` is not known by the local API yet.
- Bridge/virtualize local `update_id` values after cloud `getUpdates` fallback
  when local and cloud update spaces diverge.
- Keep successful empty local `getUpdates` local by default; cloud pending rescue
  is now an explicit opt-in.
- Restrict automatic cloud `getUpdates` fallback to network/timeout and HTTP 5xx
  failures after local retry, excluding local 401/404 responses.
- Fail closed when a real local failure occurs before a native cloud cursor is
  known; forwarding the higher virtual local offset would acknowledge the lower
  cloud queue, while an automatic offset-zero bootstrap cannot distinguish
  mirrored local duplicates from unseen cloud updates.
- Keep offset-zero cloud bootstrap behind the explicit empty-local rescue opt-in
  and handle current edits/callbacks without using the original message date.
- Keep stale filtering attached to an opt-in bootstrap cursor across later real
  local failures, and force every `getUpdates` request through the buffered
  retry/cursor policy instead of the streaming fallback path.
- Allow operator-supplied bot-scoped local bridge anchors to preserve an already
  verified local-to-virtual cursor mapping across a proxy restart.
- Document the operator invariant that newly created/re-anchored local bridge
  seeds use the bot/account-scoped durable event-ID high-water rather than a
  potentially lagging downstream ACK cursor; otherwise the ingress spool can
  silently deduplicate new payloads by event ID.
- Log `pendingAgeMs`, `translatedLocal`, and `bridgedLocal` for fallback and
  update-id translation diagnostics.
- Reduce the risk of selecting the wrong voice/media file caused by mixing
  local and cloud update spaces.
