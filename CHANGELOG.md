# Changelog

## Unreleased

- Fallback `getFile` to cloud when local Bot API returns `400`, covering cloud
  fallback updates whose `file_id` is not known by the local API yet.
- Bridge/virtualize local `update_id` values after cloud `getUpdates` fallback
  when local and cloud update spaces diverge.
- Defer cloud pending fallback for 60 seconds when local `getUpdates` is healthy
  but temporarily empty.
- Log `pendingAgeMs`, `translatedLocal`, and `bridgedLocal` for fallback and
  update-id translation diagnostics.
- Reduce the risk of selecting the wrong voice/media file caused by mixing
  local and cloud update spaces.
