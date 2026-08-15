# Changelog

## 1.0.0 — 2026-08-14

- Modular Node.js proxy with independently tested request parsing, fallback
  policy, file routing, update bridge, upstream transport and per-bot polling
  coordinator.
- Local-first Telegram routing with an explicit, method-aware cloud fallback
  policy.
- One FIFO `getUpdates` lane per public bot ID, bounded admission, HTTP 429 on
  queue overflow and HTTP 408 for incomplete request bodies.
- Bounded local `getUpdates` retry, fail-closed unknown cloud cursors and
  opt-in-only empty-local cloud rescue.
- Bot-scoped native-to-virtual update ID bridge with operator-provided restart
  anchors and stale local update acknowledgement.
- Business/guest message normalization without logging message text.
- Local-first `getFile` retry independent of the short health probe.
- Bot-scoped file source/size affinity, safe local path rewriting and a strict
  cloud download size gate.
- Local-only multipart uploads and owner-changing Bot API methods.
- Token-safe structured operational logs and active streaming counters.
- Production-focused documentation; development roadmaps and unused durable
  state experiments remain available in Git history rather than the release
  tree.
