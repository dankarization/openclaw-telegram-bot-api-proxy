# OpenClaw Telegram Bot API Proxy

Proxy для OpenClaw: локальный Telegram Bot API в приоритете, cloud Bot API только как аварийный fallback.

## Схема

```text
OpenClaw Gateway
  -> http://127.0.0.1:8082
  -> openclaw-telegram-bot-api-proxy
      primary  -> http://127.0.0.1:8081
                  Docker aiogram/telegram-bot-api:latest --local
      fallback -> https://api.telegram.org
```

## Поведение

- Локальный Bot API всегда в приоритете.
- Cloud fallback включается при ошибке local API или когда local `getUpdates`
  пустой, но в cloud есть свежие pending updates.
- `getUpdates` защищён от старых cloud updates:
  - proxy читает локальный OpenClaw offset;
  - ведёт отдельный cloud cursor;
  - при необходимости поднимает cloud `update_id` выше локального offset.
- Старые local updates ниже OpenClaw offset отбрасываются и подтверждаются в
  local Bot API, чтобы они не возвращались снова.
- `/file/...` уходит в cloud только если размер известен из `getFile` и не
  больше `CLOUD_FILE_FALLBACK_MAX_BYTES`.
- Файлы неизвестного размера и тяжёлые файлы остаются только на local API.
- Отправка файлов через `multipart/form-data`, где в HTTP-запросе идут сами
  байты файла, не fallback-ится в cloud: такой stream нельзя безопасно
  повторить, а cloud Bot API не рассчитан на наши большие local-файлы.

## Требования

- Node.js 22+
- Docker-контейнер `aiogram/telegram-bot-api:latest` на `127.0.0.1:8081`
- Docker Compose v2 для `docker-compose.example.yml`
- OpenClaw Telegram `apiRoot`: `http://127.0.0.1:8082`

## Быстрый старт

```bash
cp .env.example .env
docker compose -f docker-compose.example.yml --env-file .env up -d telegram-bot-api
npm run check
ENABLE_CLOUD_FALLBACK=1 node src/telegram-bot-api-proxy.mjs
```

Для постоянного запуска proxy используется user systemd unit:

```text
systemd/openclaw-telegram-api-proxy.service.example
```

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
| `LOCAL_FILE_PATH_REWRITE_FROM` | пусто | Контейнерный префикс file_path из local Bot API. |
| `LOCAL_FILE_PATH_REWRITE_TO` | пусто | Host-префикс того же Docker volume для OpenClaw. |
| `BUFFER_LIMIT_BYTES` | `8388608` | Лимит буферизации API-запроса. |
| `LOCAL_HEALTH_TTL_MS` | `5000` | TTL успешной проверки local API. |
| `LOCAL_UNHEALTHY_COOLDOWN_MS` | `5000` | Пауза после ошибки local API. |
| `LOCAL_HEALTH_TIMEOUT_MS` | `2000` | Таймаут health-check через `getMe`. |
| `UPSTREAM_TIMEOUT_MS` | `130000` | Таймаут upstream-запроса. |
| `CLOUD_PENDING_PROBE_TTL_MS` | `5000` | TTL проверки cloud pending updates. |
| `CLOUD_FRESH_UPDATE_MAX_AGE_MS` | `21600000` | Максимальный возраст cloud update для виртуального подъёма id. |

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

## Документация

- [ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md) - архитектурный план.
- [docs/token-migration.md](docs/token-migration.md) - переезд token между cloud/local/local.
- [docs/operations.md](docs/operations.md) - проверки сервисов, очереди, offset-файлов и логов.
