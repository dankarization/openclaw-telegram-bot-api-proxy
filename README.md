# OpenClaw Telegram Bot API Proxy

Local-first Telegram Bot API proxy for OpenClaw.

It is meant for setups that normally use a local `telegram-bot-api` server for
large files, but should keep a stable Telegram control channel through
`api.telegram.org` if the local server is temporarily unavailable.

## Behavior

- Proxies OpenClaw Telegram API calls to a local Bot API server first.
- Falls back to Telegram cloud API when local Bot API is unhealthy or returns
  selected fallback-safe errors.
- Protects `getUpdates` fallback with a local offset floor and a separate cloud
  cursor so old cloud updates do not roll OpenClaw offsets backward.
- Rewrites cloud `update_id` values into a virtual monotonic range when needed.
- Allows `/file/...` cloud fallback only when file size is known from `getFile`
  and is below `CLOUD_FILE_FALLBACK_MAX_BYTES`.
- Keeps large or unknown-size files local-only.

## Requirements

- Node.js 22+
- A local Telegram Bot API server, for example:
  `aiogram/telegram-bot-api:latest`
- OpenClaw configured to use this proxy as Telegram `apiRoot`

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `LISTEN_HOST` | `127.0.0.1` | Proxy bind host. |
| `PORT` | `8082` | Proxy bind port. |
| `LOCAL_API_ROOT` | `http://127.0.0.1:8081` | Local Bot API root. |
| `CLOUD_API_ROOT` | `https://api.telegram.org` | Telegram cloud API root. |
| `ENABLE_CLOUD_FALLBACK` | `false` | Enable cloud fallback. |
| `TELEGRAM_OFFSET_DIR` | `telegram` | Directory containing OpenClaw update-offset files. |
| `CLOUD_FILE_FALLBACK_MAX_BYTES` | `20971520` | Maximum known file size for cloud `/file/...` fallback. |
| `BUFFER_LIMIT_BYTES` | `8388608` | Max buffered API request size. |
| `LOCAL_HEALTH_TTL_MS` | `5000` | Local health success cache TTL. |
| `LOCAL_UNHEALTHY_COOLDOWN_MS` | `5000` | Local unhealthy cooldown. |
| `LOCAL_HEALTH_TIMEOUT_MS` | `2000` | Local `getMe` health-check timeout. |
| `UPSTREAM_TIMEOUT_MS` | `130000` | Upstream request timeout. |

## OpenClaw

Set Telegram account `apiRoot` to the proxy:

```json
{
  "apiRoot": "http://127.0.0.1:8082"
}
```

The proxy expects OpenClaw offset files such as:

```text
telegram/update-offset-default.json
telegram/update-offset-syncopia-guest-bot.json
```

Each file should include `botId` and `lastUpdateId`.

## Local Development

```bash
npm run check
ENABLE_CLOUD_FALLBACK=1 node src/telegram-bot-api-proxy.mjs
```

## systemd

See `systemd/openclaw-telegram-api-proxy.service.example`.
