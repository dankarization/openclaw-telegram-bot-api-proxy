# OpenClaw Telegram Bot API Proxy

Локальный proxy для Telegram Bot API в OpenClaw.

Рабочая схема:

```text
OpenClaw
  -> http://127.0.0.1:8082
  -> openclaw-telegram-api-proxy
  -> http://127.0.0.1:8081
  -> Docker aiogram/telegram-bot-api:latest --local
```

Если локальный Bot API недоступен, proxy может отправить безопасные запросы в
`https://api.telegram.org`, чтобы связь с ботом не пропала полностью.

## Поведение

- Локальный Bot API всегда в приоритете.
- Cloud fallback включается только при ошибке local API и только для безопасных
  методов.
- `getUpdates` защищён от старых cloud updates:
  - proxy читает локальный OpenClaw offset;
  - ведёт отдельный cloud cursor;
  - при необходимости поднимает cloud `update_id` выше локального offset.
- `/file/...` уходит в cloud только если размер известен из `getFile` и не
  больше `CLOUD_FILE_FALLBACK_MAX_BYTES`.
- Файлы неизвестного размера и тяжёлые файлы остаются только на local API.

## Требования

- Node.js 22+
- Docker-контейнер `aiogram/telegram-bot-api:latest` на `127.0.0.1:8081`
- OpenClaw Telegram `apiRoot`: `http://127.0.0.1:8082`

## Переменные окружения

| Переменная | Значение по умолчанию | Назначение |
| --- | --- | --- |
| `LISTEN_HOST` | `127.0.0.1` | Хост proxy. |
| `PORT` | `8082` | Порт proxy. |
| `LOCAL_API_ROOT` | `http://127.0.0.1:8081` | Локальный Docker Bot API. |
| `CLOUD_API_ROOT` | `https://api.telegram.org` | Cloud Bot API. |
| `ENABLE_CLOUD_FALLBACK` | `false` | Включить cloud fallback. |
| `TELEGRAM_OFFSET_DIR` | `telegram` | Каталог OpenClaw offset-файлов. |
| `CLOUD_FILE_FALLBACK_MAX_BYTES` | `20971520` | Лимит размера файла для cloud `/file/...`. |
| `BUFFER_LIMIT_BYTES` | `8388608` | Лимит буферизации API-запроса. |
| `LOCAL_HEALTH_TTL_MS` | `5000` | TTL успешной проверки local API. |
| `LOCAL_UNHEALTHY_COOLDOWN_MS` | `5000` | Пауза после ошибки local API. |
| `LOCAL_HEALTH_TIMEOUT_MS` | `2000` | Таймаут health-check через `getMe`. |
| `UPSTREAM_TIMEOUT_MS` | `130000` | Таймаут upstream-запроса. |

## OpenClaw

В `openclaw.json` Telegram-аккаунт должен смотреть на proxy:

```json
{
  "apiRoot": "http://127.0.0.1:8082"
}
```

Proxy использует offset-файлы OpenClaw:

```text
telegram/update-offset-default.json
telegram/update-offset-syncopia-guest-bot.json
```

В файлах нужны `botId` и `lastUpdateId`.

## Запуск

Проверка синтаксиса:

```bash
npm run check
```

Локальный запуск:

```bash
ENABLE_CLOUD_FALLBACK=1 node src/telegram-bot-api-proxy.mjs
```

User systemd unit:

```text
systemd/openclaw-telegram-api-proxy.service.example
```
